// NOS Town — Worker Runtime (Agent Execution Loop)
//
// Glue layer that wires Mayor convoy output to Polecat/Witness/Safeguard workers.
// Mayor.orchestrate() writes BEAD_DISPATCH convoys to mailboxes; WorkerRuntime
// drains those mailboxes and routes each convoy to the appropriate handler.
//
// Architecture:
//   Mayor (planners) → ConvoyBus mailboxes → WorkerRuntime → Polecat/Witness/Safeguard
//
// P1 per IMPLEMENTATION_PLAN.md §P1
// P9 (500ms Safeguard window before Polecat dispatch) per HARDENING.md §3.3

import { Polecat } from '../roles/polecat.js';
import { Witness } from '../roles/witness.js';
import { SafeguardPool } from '../roles/safeguard.js';
import { Ledger } from '../ledger/index.js';
import { ConvoyBus } from '../convoys/bus.js';
import type { Bead, ConvoyMessage, HeartbeatEvent } from '../types/index.js';
import { auditLog } from '../hardening/audit.js';

export interface WorkerRuntimeConfig {
  rigName: string;
  groqApiKey?: string;
  kgPath?: string;
  polecatCount?: number;       // default: 4
  safeguardPoolSize?: number;  // default: 2
  pollIntervalMs?: number;     // default: 500
  onEvent?: (event: HeartbeatEvent) => void;
}

interface PolecatSlot {
  worker: Polecat;
  busy: boolean;
}

export class WorkerRuntime {
  private rigName: string;
  private groqApiKey?: string;
  private kgPath?: string;
  private pollIntervalMs: number;
  private onEvent?: (event: HeartbeatEvent) => void;

  private bus: ConvoyBus;
  private ledger: Ledger;
  private safeguardPool: SafeguardPool;
  private witness: Witness;
  private polecats: PolecatSlot[];

  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: WorkerRuntimeConfig) {
    this.rigName = config.rigName;
    this.groqApiKey = config.groqApiKey;
    this.kgPath = config.kgPath;
    this.pollIntervalMs = config.pollIntervalMs ?? 500;
    this.onEvent = config.onEvent;

    this.bus = new ConvoyBus(config.rigName);
    this.ledger = new Ledger();

    const poolSize = config.safeguardPoolSize ?? 2;
    this.safeguardPool = new SafeguardPool({
      poolSize,
      groqApiKey: config.groqApiKey,
      kgPath: config.kgPath,
    });

    this.witness = new Witness({
      agentId: 'witness_01',
      rigName: config.rigName,
      groqApiKey: config.groqApiKey,
      kgPath: config.kgPath,
    });

    const polecatCount = config.polecatCount ?? 4;
    this.polecats = Array.from({ length: polecatCount }, (_, i) => ({
      worker: new Polecat({
        agentId: `polecat_0${i + 1}`,
        rigName: config.rigName,
        groqApiKey: config.groqApiKey,
        safeguard: this.safeguardPool,
        emitHeartbeat: config.onEvent,
      }),
      busy: false,
    }));
  }

  /** Start the polling loop. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => {
      void this.processOnce();
    }, this.pollIntervalMs);
  }

  /** Stop the polling loop and close workers. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.safeguardPool.close();
    this.witness.close();
    // Polecat has no close() — workers are stateless between beads
  }

  /**
   * Run one poll cycle — drain all inboxes once.
   * Returns counts of processed convoys per role.
   * Exposed for testing.
   */
  async processOnce(): Promise<{ polecatProcessed: number; mayorProcessed: number }> {
    let polecatProcessed = 0;
    let mayorProcessed = 0;

    // Drain polecat inbox (BEAD_DISPATCH from Mayor)
    await this.bus.processInbox('polecat', async (msg) => {
      polecatProcessed++;
      await this.handlePolecatInbox(msg);
    });

    // Drain mayor inbox (status updates, lockdown broadcasts, verdicts)
    await this.bus.processInbox('mayor', async (msg) => {
      mayorProcessed++;
      await this.handleMayorInbox(msg);
    });

    // Drain witness inbox (PATCH_READY from Polecat)
    await this.bus.processInbox('witness', async (msg) => {
      await this.handleWitnessInbox(msg);
    });

    return { polecatProcessed, mayorProcessed };
  }

  // ── Polecat inbox handler ──────────────────────────────────────────────────

  private async handlePolecatInbox(msg: ConvoyMessage): Promise<void> {
    const { type, data } = msg.payload;

    if (type === 'BEAD_DISPATCH') {
      await this.handleBeadDispatch(data as Partial<Bead> & { bead_id?: string });
      return;
    }

    if (type === 'BEAD_STATUS') {
      const beadId = String(data['bead_id'] ?? '');
      const status = String(data['status'] ?? 'failed');
      const outcome = String(data['outcome'] ?? '') as Bead['outcome'];
      if (beadId) {
        const beads = this.ledger.readBeads(this.rigName);
        const bead = beads.find((b) => b.bead_id === beadId);
        if (bead) {
          await this.ledger.appendBead(this.rigName, {
            ...bead,
            status: status as Bead['status'],
            outcome,
            updated_at: new Date().toISOString(),
          });
        }
      }
      return;
    }

    console.warn(`[WorkerRuntime] Unhandled polecat convoy type: ${type}`);
  }

  // ── BEAD_DISPATCH — Safeguard 500ms window + Polecat dispatch (P9) ────────

  private async handleBeadDispatch(partialBead: Partial<Bead> & { bead_id?: string }): Promise<void> {
    // Mayor convoy payload contains only a subset of Bead fields. Hydrate from ledger.
    const beadId = partialBead.bead_id ?? '';
    const ledgerBeads = this.ledger.readBeads(this.rigName);
    const fullBead = ledgerBeads.find((b) => b.bead_id === beadId);
    if (!fullBead) {
      // Mayor's convoy payload is a subset of Bead fields — if not in ledger we can't execute.
      // This indicates a race (convoy arrived before ledger write) or a programming error.
      console.warn(`[WorkerRuntime] BEAD_DISPATCH for unknown bead ${beadId} — skipping`);
      return;
    }
    const bead: Bead = fullBead;
    // P9: Fire Safeguard scan asynchronously before Polecat starts.
    // 500ms window: if scan returns within 500ms and rejects → LOCKDOWN, don't dispatch.
    // If scan takes >500ms → Polecat starts; scan continues in background.
    const scanPromise = this.safeguardPool.scan(JSON.stringify(bead));
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 500),
    );

    const earlyResult = await Promise.race([scanPromise, timeoutPromise]);

    if (earlyResult !== null && !earlyResult.approved) {
      // LOCKDOWN raised within the 500ms window — block dispatch
      auditLog('LOCKDOWN_EARLY', 'safeguard', bead.bead_id,
        `Pre-dispatch scan blocked bead: ${earlyResult.lockdown?.lockdown_id ?? 'unknown'}`);
      await this.emitLockdownBroadcast(bead.bead_id, earlyResult.lockdown?.reason ?? 'security violation');
      return;
    }

    // Claim a free Polecat
    const slot = this.polecats.find((s) => !s.busy);
    if (!slot) {
      // All polecats busy — leave convoy in inbox for next poll
      // (ConvoyBus.processInbox re-queues unprocessed messages)
      console.warn(`[WorkerRuntime] All polecats busy — re-queuing bead ${bead.bead_id}`);
      await this.bus.send({
        header: {
          sender_id: 'runtime',
          recipient: 'polecat',
          timestamp: new Date().toISOString(),
          seq: this.bus.getNextSeq('runtime'),
        },
        payload: { type: 'BEAD_DISPATCH', data: { bead_id: bead.bead_id } },
        signature: 'ed25519:requeued',
      });
      return;
    }

    slot.busy = true;

    // Background scan monitoring: if scan finishes after 500ms window and rejects, broadcast lockdown
    void scanPromise.then((result) => {
      if (result && !result.approved) {
        void this.emitLockdownBroadcast(bead.bead_id, result.lockdown?.reason ?? 'security violation');
      }
    });

    // Dispatch to Polecat
    const context = {
      task_description: bead.task_description ?? bead.task_type,
    };

    slot.worker.execute(bead, context)
      .then(async (completedBead) => {
        slot.busy = false;
        // If witness_required, route to Witness
        if (bead.witness_required && completedBead.outcome !== 'FAILURE') {
          await this.routeToWitness(completedBead);
        }
      })
      .catch(async (err: unknown) => {
        slot.busy = false;
        console.error(`[WorkerRuntime] Polecat execution failed for bead ${bead.bead_id}:`, err);
        // Only update ledger if bead has the required fields (guards against partial-bead races)
        if (bead.role && bead.task_type && bead.model) {
          await this.ledger.appendBead(this.rigName, {
            ...bead,
            status: 'failed',
            outcome: 'FAILURE',
            updated_at: new Date().toISOString(),
          });
        }
      });
  }

  // ── Witness routing ────────────────────────────────────────────────────────

  private async routeToWitness(bead: Bead): Promise<void> {
    // Dispatch PATCH_READY to witness inbox
    await this.bus.send({
      header: {
        sender_id: 'runtime',
        recipient: 'witness',
        timestamp: new Date().toISOString(),
        seq: this.bus.getNextSeq('runtime'),
      },
      payload: {
        type: 'PATCH_READY',
        data: bead as unknown as Record<string, unknown>,
      },
      signature: 'ed25519:internal',
    });
  }

  // ── Witness inbox handler ─────────────────────────────────────────────────

  private async handleWitnessInbox(msg: ConvoyMessage): Promise<void> {
    const { type, data } = msg.payload;

    if (type === 'PATCH_READY') {
      const bead = data as unknown as Bead;
      const diff = String(data['diff'] ?? '');
      const requirement = String(data['task_description'] ?? bead.task_type ?? '');

      try {
        const verdict = await this.witness.review(
          diff,
          requirement,
          bead.bead_id,
          bead.critical_path,
        );

        if (verdict.approved) {
          await this.ledger.appendBead(this.rigName, {
            ...bead,
            status: 'done',
            outcome: 'SUCCESS',
            metrics: { witness_score: parseFloat(verdict.score) || 0 },
            updated_at: new Date().toISOString(),
          });
        } else {
          // Rejected — mark failed; Mayor can escalate to Refinery
          await this.ledger.appendBead(this.rigName, {
            ...bead,
            status: 'failed',
            outcome: 'FAILURE',
            updated_at: new Date().toISOString(),
          });
          // Send REVIEW_VERDICT back to Mayor inbox
          await this.bus.send({
            header: {
              sender_id: 'witness_01',
              recipient: 'mayor',
              timestamp: new Date().toISOString(),
              seq: this.bus.getNextSeq('witness_01'),
            },
            payload: {
              type: 'REVIEW_VERDICT',
              data: { bead_id: bead.bead_id, approved: false, verdict },
            },
            signature: 'ed25519:internal',
          });
        }
      } catch (err) {
        console.error(`[WorkerRuntime] Witness review failed for bead ${bead.bead_id}:`, err);
      }
      return;
    }

    console.warn(`[WorkerRuntime] Unhandled witness convoy type: ${type}`);
  }

  // ── Mayor inbox handler ────────────────────────────────────────────────────

  private async handleMayorInbox(msg: ConvoyMessage): Promise<void> {
    const { type, data } = msg.payload;

    if (type === 'SECURITY_VIOLATION') {
      const beadId = String(data['bead_id'] ?? '');
      const reason = String(data['reason'] ?? 'security violation');
      auditLog('SECURITY_VIOLATION', 'runtime', beadId, reason);
      // Mark bead failed
      const beads = this.ledger.readBeads(this.rigName);
      const bead = beads.find((b) => b.bead_id === beadId);
      if (bead) {
        await this.ledger.appendBead(this.rigName, {
          ...bead,
          status: 'failed',
          outcome: 'FAILURE',
          updated_at: new Date().toISOString(),
        });
      }
      return;
    }

    if (type === 'REVIEW_VERDICT') {
      // Mayor may escalate to Refinery on rejection — logged but not auto-escalated here
      auditLog('REVIEW_VERDICT', 'runtime', String(data['bead_id'] ?? ''),
        `approved=${data['approved']}`);
      return;
    }

    if (type === 'LOCKDOWN_BROADCAST') {
      auditLog('LOCKDOWN_BROADCAST', 'runtime', String(data['bead_id'] ?? ''),
        String(data['reason'] ?? ''));
      return;
    }

    console.warn(`[WorkerRuntime] Unhandled mayor convoy type: ${type}`);
  }

  // ── Lockdown broadcast ─────────────────────────────────────────────────────

  private async emitLockdownBroadcast(beadId: string, reason: string): Promise<void> {
    auditLog('LOCKDOWN_BROADCAST', 'runtime', beadId, reason);
    this.onEvent?.({
      type: 'CONVOY_BLOCKED',
      bead_id: beadId,
      reason: `LOCKDOWN: ${reason}`,
    });
    // Write to Mayor's inbox so it can halt the plan if needed
    try {
      await this.bus.send({
        header: {
          sender_id: 'runtime',
          recipient: 'mayor',
          timestamp: new Date().toISOString(),
          seq: this.bus.getNextSeq('runtime'),
        },
        payload: {
          type: 'LOCKDOWN_BROADCAST',
          data: { bead_id: beadId, reason },
        },
        signature: 'ed25519:internal',
      });
    } catch {
      // Non-fatal — lockdown is already logged
    }
  }
}
