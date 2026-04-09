// NOS Town — Swarm MCP Tools
// Implements swarm_status, swarm_broadcast, swarm_reset_bead, swarm_abort_workflow

import { ConvoyBus } from '../convoys/bus.js';
import { buildSignedConvoy, loadPrivateKey } from '../convoys/sign.js';
import type { Bead } from '../types/index.js';

export interface SwarmStatus {
  total: number;
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  blocked: string[];   // bead IDs blocked by unresolved prerequisites
  cycles: string[];    // bead IDs in detected cycles
}

/**
 * swarm_status — returns aggregate status of a bead collection.
 * Identifies beads blocked by incomplete prerequisites.
 */
export function swarmStatus(beads: Bead[]): SwarmStatus {
  const completedIds = new Set(
    beads
      .filter((b) => b.status === 'done' || b.outcome === 'SUCCESS')
      .map((b) => b.bead_id),
  );

  const failedIds = new Set(
    beads
      .filter((b) => b.status === 'failed' || b.outcome === 'FAILURE')
      .map((b) => b.bead_id),
  );

  const blocked = beads
    .filter((b) => {
      if (b.status === 'done' || b.status === 'failed') return false;
      return b.needs.some((id) => !completedIds.has(id));
    })
    .map((b) => b.bead_id);

  return {
    total: beads.length,
    pending: beads.filter((b) => b.status === 'pending').length,
    in_progress: beads.filter((b) => b.status === 'in_progress').length,
    done: beads.filter((b) => b.status === 'done' || b.outcome === 'SUCCESS').length,
    failed: beads.filter((b) => b.status === 'failed' || b.outcome === 'FAILURE').length,
    blocked,
    cycles: [],  // Populated by SwarmCoordinator.detectCycles if needed
  };
}

/**
 * Broadcast a message to multiple recipients via ConvoyBus.
 * Used for priority overrides or global state changes (e.g., LOCKDOWN).
 */
export async function swarmBroadcast(
  senderId: string,
  recipients: string[],
  message: { type: string; data: Record<string, unknown> },
  bus: ConvoyBus,
): Promise<void> {
  let privateKey: string;
  try {
    privateKey = loadPrivateKey(senderId);
  } catch {
    throw new Error(`swarmBroadcast: no key for sender ${senderId}`);
  }

  await Promise.all(
    recipients.map(async (recipient, i) => {
      const header = {
        sender_id: senderId,
        recipient,
        timestamp: new Date().toISOString(),
        seq: bus.getNextSeq(senderId) + i,
      };
      const payload = {
        type: message.type as 'BEAD_DISPATCH',
        data: message.data,
      };
      const convoy = await buildSignedConvoy(header, payload, privateKey);
      await bus.send(convoy);
    }),
  );
}

/**
 * Reset a bead to PENDING to allow re-execution.
 * Returns the updated bead (caller must persist it to the ledger).
 */
export function swarmResetBead(bead: Bead): Bead {
  return {
    ...bead,
    status: 'pending',
    outcome: undefined,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Abort all beads in a dependency subtree.
 * Returns the list of aborted beads.
 */
export function swarmAbortWorkflow(
  rootBeadId: string,
  allBeads: Bead[],
): Bead[] {
  // Build a set of all beads downstream of rootBeadId (BFS)
  const toAbort = new Set<string>([rootBeadId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const bead of allBeads) {
      if (!toAbort.has(bead.bead_id) && bead.needs.some((id) => toAbort.has(id))) {
        toAbort.add(bead.bead_id);
        changed = true;
      }
    }
  }

  return allBeads
    .filter((b) => toAbort.has(b.bead_id))
    .map((b) => ({
      ...b,
      status: 'failed' as const,
      outcome: 'FAILURE' as const,
      updated_at: new Date().toISOString(),
    }));
}

/**
 * In-flight limits for swarm backpressure (SWARM.md §3 Adaptive Throttling).
 */
export interface InFlightLimits {
  maxPolecatBeads: number;
  maxWitnessBeads: number;
}

const DEFAULT_LIMITS: InFlightLimits = {
  maxPolecatBeads: 50,
  maxWitnessBeads: 20,
};

const MAX_LIMITS: InFlightLimits = {
  maxPolecatBeads: 100,
  maxWitnessBeads: 40,
};

/**
 * Adaptive backpressure: temporarily increase in-flight limits when throughput
 * is high and error rates are low.
 * Per SWARM.md §3 and §swarm_rebalance_limits():
 *   - Increase limits by 50% (up to MAX_LIMITS) when errorRate < 5% and throughput >= 10 beads/min
 *   - Restore defaults when errorRate >= 5% or throughput < 10
 */
export function swarmRebalanceLimits(
  current: InFlightLimits,
  metrics: { beadsPerMinute: number; errorRate: number },
): InFlightLimits {
  const { beadsPerMinute, errorRate } = metrics;

  if (errorRate < 0.05 && beadsPerMinute >= 10) {
    // Expand limits by 50%, capped at MAX_LIMITS
    return {
      maxPolecatBeads: Math.min(
        Math.floor(current.maxPolecatBeads * 1.5),
        MAX_LIMITS.maxPolecatBeads,
      ),
      maxWitnessBeads: Math.min(
        Math.floor(current.maxWitnessBeads * 1.5),
        MAX_LIMITS.maxWitnessBeads,
      ),
    };
  }

  // Revert to defaults when conditions are no longer favorable
  return { ...DEFAULT_LIMITS };
}

export { DEFAULT_LIMITS as DEFAULT_IN_FLIGHT_LIMITS };

/**
 * Check if a bead is a rendezvous node (has multiple prerequisites).
 */
export function isRendezvousNode(bead: Bead): boolean {
  return bead.needs.length > 1;
}

/**
 * Get all beads that are "fork" beads — dispatched in parallel from the same parent.
 * A fork group is a set of beads with identical `needs` arrays.
 */
export function findForkGroups(beads: Bead[]): Map<string, Bead[]> {
  const groups = new Map<string, Bead[]>();

  for (const bead of beads) {
    if (bead.needs.length === 0) continue;
    const key = [...bead.needs].sort().join(',');
    const group = groups.get(key) ?? [];
    group.push(bead);
    groups.set(key, group);
  }

  // Only return groups with 2+ members (actual forks)
  for (const [key, group] of groups.entries()) {
    if (group.length < 2) groups.delete(key);
  }

  return groups;
}
