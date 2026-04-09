// NOS Town — Mayor Agent (Orchestrator)

import { GroqProvider } from '../groq/provider.js';
import { Ledger } from '../ledger/index.js';
import { MemPalaceClient } from '../mempalace/client.js';
import { KnowledgeGraph } from '../kg/index.js';
import { ConvoyBus } from '../convoys/bus.js';
import { buildSignedConvoy } from '../convoys/sign.js';
import { loadPrivateKey } from '../convoys/sign.js';
import { RoutingDispatcher } from '../routing/dispatch.js';
import type { Bead, ConvoyMessage, InferenceParams, HeartbeatEvent, PlaybookEntry } from '../types/index.js';
import { Ledger as LedgerClass } from '../ledger/index.js';
import { DEFAULT_IN_FLIGHT_LIMITS, isRendezvousNode, detectCycles } from '../swarm/tools.js';
import { v4 as uuidv4 } from 'uuid';

export type HeartbeatEmitter = (event: HeartbeatEvent) => void;

export interface MayorConfig {
  agentId: string;
  rigName: string;
  groqApiKey?: string;
  palaceUrl?: string;
  kgPath?: string;
  heartbeatIntervalMs?: number;
  emitHeartbeat?: HeartbeatEmitter;
}

export interface Task {
  description: string;
  task_type?: string;
  critical_path?: boolean;
  requires_witness?: boolean;
}

export interface DispatchPlan {
  beads: Bead[];
  plan_id: string;
  checkpoint_id?: string;
}

export class Mayor {
  private agentId: string;
  private rigName: string;
  private provider: GroqProvider;
  private ledger: Ledger;
  private palace: MemPalaceClient;
  private kg: KnowledgeGraph;
  private router: RoutingDispatcher;
  private heartbeatIntervalMs: number;
  private emitHeartbeat: HeartbeatEmitter | null;
  private lastHeartbeatAt: Date = new Date();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Outage queue: beads awaiting dispatch during PROVIDER_EXHAUSTED (RESILIENCE.md §Convoy Queueing) */
  private outageQueue: Bead[] = [];
  private outageActive = false;

  constructor(config: MayorConfig) {
    this.agentId = config.agentId;
    this.rigName = config.rigName;
    this.provider = new GroqProvider(config.groqApiKey, config.emitHeartbeat);
    this.ledger = new Ledger();
    this.palace = new MemPalaceClient(config.palaceUrl);
    this.kg = new KnowledgeGraph(config.kgPath);
    this.router = new RoutingDispatcher(this.kg);
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 60_000;
    this.emitHeartbeat = config.emitHeartbeat ?? null;
  }

  /**
   * Startup: check for orphan workflows (MAYOR_MISSING recovery).
   * MUST be called before orchestrate() on a replacement Mayor.
   * Returns true if an orphan workflow was found and adopted.
   *
   * Per RESILIENCE.md §Mayor Session Recovery:
   * 1. diaryRead wing_mayor for prior session summary
   * 2. Query hall_facts active-convoy for in-progress plans
   * 3. Query hall_events outage-queue for beads queued during prior outage
   */
  async startup(): Promise<boolean> {
    // Step 1: Load prior session diary summary (RESILIENCE.md §Mayor Session Recovery step 1)
    try {
      const diary = await this.palace.diaryRead(`wing_mayor`);
      if (diary.length > 0) {
        console.log(`[Mayor:${this.agentId}] Session recovery: loaded ${diary.length} prior diary entries`);
      }
    } catch {
      // Palace unreachable — non-fatal
    }

    // Step 2: Check MemPalace for an active-convoy checkpoint (RESILIENCE.md § Mayor Replacement Flow)
    let orphanFound = false;
    try {
      const search = await this.palace.search(
        'active-convoy',
        'wing_mayor',
        'hall_facts',
      );
      if (search.results.length > 0) {
        const checkpoint = search.results[0];
        console.log(
          `[Mayor:${this.agentId}] MAYOR_MISSING recovery: found active convoy checkpoint ${String(checkpoint.id ?? 'unknown')}`,
        );
        // Read ledger for in-progress beads and re-attach context
        const beads = this.ledger.readBeads(this.rigName);
        const inProgress = beads.filter(
          (b) => b.status === 'in_progress' || b.status === 'pending',
        );
        if (inProgress.length > 0) {
          console.log(
            `[Mayor:${this.agentId}] Adopting ${inProgress.length} orphan beads — NOT re-decomposing`,
          );
        }
        this.lastHeartbeatAt = new Date();
        orphanFound = true;
      }
    } catch {
      // Palace unreachable — non-fatal, proceed with normal startup
    }

    // Step 3: Recover beads persisted to outage-queue during prior session (RESILIENCE.md step 3)
    try {
      const outageSearch = await this.palace.search('outage-queue', 'wing_mayor', 'hall_events');
      for (const result of outageSearch.results) {
        try {
          const bead = JSON.parse(result.content) as Bead;
          this.outageQueue.push(bead);
        } catch {
          // malformed entry — skip
        }
      }
      if (this.outageQueue.length > 0) {
        console.log(`[Mayor:${this.agentId}] Recovered ${this.outageQueue.length} beads from persisted outage queue`);
      }
    } catch {
      // Palace unreachable — non-fatal
    }

    return orphanFound;
  }

  /**
   * Full orchestration pipeline:
   * 1. Palace wakeup (L0+L1 context)
   * 2. Check existing playbooks
   * 3. Decompose task into beads
   * 4. CHECKPOINT to MemPalace (MANDATORY before dispatch)
   * 5. Dispatch beads via convoy bus
   */
  async orchestrate(task: Task, inFlightLimits = DEFAULT_IN_FLIGHT_LIMITS): Promise<DispatchPlan> {
    // 0. Adaptive backpressure: check in-flight limits before decomposing (SWARM.md §3)
    const currentBeads = this.ledger.readBeads(this.rigName);
    const inProgressCount = currentBeads.filter((b) => b.status === 'in_progress').length;
    if (inProgressCount >= inFlightLimits.maxPolecatBeads) {
      throw new Error(
        `Mayor WAITING_FOR_CAPACITY: ${inProgressCount} beads in-flight (limit: ${inFlightLimits.maxPolecatBeads})`,
      );
    }

    // 0b. Inbox backpressure: if a role's inbox exceeds 50 unread convoys, pause (CONVOYS.md §Backpressure)
    const INBOX_BACKPRESSURE_LIMIT = 50;
    const bus = new ConvoyBus(this.rigName);
    for (const role of ['polecat', 'witness', 'safeguard']) {
      const depth = bus.inboxCount(role);
      if (depth >= INBOX_BACKPRESSURE_LIMIT) {
        throw new Error(
          `Mayor WAITING_FOR_CAPACITY: ${role} inbox depth ${depth} >= ${INBOX_BACKPRESSURE_LIMIT}`,
        );
      }
    }

    // 1. Palace status check then wakeup (ROLES.md §Mayor Quality Tuning step 1-2)
    // getStatus() loads AAAK spec + memory protocol headers before full context load
    let palaceContext = '';
    try {
      await this.palace.getStatus(); // non-fatal — wakeup provides actual context
    } catch {
      // palace offline or unreachable — proceed to wakeup attempt
    }
    try {
      const wakeup = await this.palace.wakeup(`wing_rig_${this.rigName}`);
      palaceContext = [wakeup.l0, wakeup.l1].join('\n');
    } catch (err) {
      console.warn(`[Mayor:${this.agentId}] Palace wakeup failed (non-fatal): ${String(err)}`);
    }

    // 1b. Load AAAK bead manifest for token-efficient context (HISTORIAN.md §AAAK Bead Manifest)
    // Prepended to palace context if available — compressed token representation of past beads.
    try {
      const aaakSearch = await this.palace.search(
        'aaak manifest bead summary',
        `wing_rig_${this.rigName}`,
        'hall_facts',
      );
      const manifestEntry = aaakSearch.results.find((r) => r.content.includes('# AAAK'));
      if (manifestEntry) {
        palaceContext = `${manifestEntry.content}\n\n${palaceContext}`;
      }
    } catch {
      // non-fatal — AAAK manifest may not exist on first run
    }

    // 2. Query cross-rig tunnels for enriched playbook search (ROUTING.md §Cross-Rig Routing)
    const tunnelWings: string[] = [`wing_rig_${this.rigName}`];
    try {
      const tunnels = await this.palace.getTunnels();
      const myWing = `wing_rig_${this.rigName}`;
      for (const t of tunnels) {
        if (t.wing_a === myWing && !tunnelWings.includes(t.wing_b)) tunnelWings.push(t.wing_b);
        if (t.wing_b === myWing && !tunnelWings.includes(t.wing_a)) tunnelWings.push(t.wing_a);
      }
    } catch {
      // palace unavailable — use local wing only
    }

    // 3. Check playbooks in MemPalace with freshness guard (ROUTING.md §Playbook Freshness Guard)
    // Search all tunnel-connected wings for cross-rig playbooks
    let playbookHint = '';
    let activePlaybook: PlaybookEntry | undefined;
    try {
      // Search primary wing first, then tunnel wings if no fresh result found
      let searchResult = await this.palace.search(task.description, tunnelWings[0], 'hall_advice');
      if (searchResult.results.length === 0 && tunnelWings.length > 1) {
        for (const wing of tunnelWings.slice(1)) {
          searchResult = await this.palace.search(task.description, wing, 'hall_advice');
          if (searchResult.results.length > 0) break;
        }
      }
      const search = searchResult;
      if (search.results.length > 0) {
        const playbookContent = search.results[0].content;
        const freshness = await this.checkPlaybookFreshness(
          task.description,
          task.task_type ?? 'execute',
          playbookContent,
        );
        if (freshness.isFresh) {
          playbookHint = `Relevant playbook: ${playbookContent.slice(0, 500)}`;
          // Parse into PlaybookEntry for routing lock (ROUTING.md §Playbook Shortcut)
          try {
            const pb = JSON.parse(playbookContent) as Partial<PlaybookEntry>;
            if (pb.task_type && pb.model_hint) {
              activePlaybook = {
                id: pb.id ?? 'unknown',
                title: pb.title ?? pb.task_type,
                task_type: pb.task_type,
                steps: Array.isArray(pb.steps) ? pb.steps : [],
                model_hint: pb.model_hint,
                created_at: pb.created_at ?? new Date().toISOString(),
              };
              console.log(`[Mayor:${this.agentId}] Playbook lock active: ${activePlaybook.model_hint} for ${activePlaybook.task_type}`);
            }
          } catch {
            // content is not JSON — use as text hint only
          }
        } else {
          // Attach as advisory context only — routing NOT locked to primary
          playbookHint = `[Advisory only — ${freshness.reason}] ${playbookContent.slice(0, 300)}`;
          console.log(`[Mayor:${this.agentId}] Playbook freshness check failed: ${freshness.reason}`);
        }
      }
    } catch {
      // non-fatal
    }

    // 3. Decompose task into beads (pass activePlaybook for routing lock)
    const beads = await this.decompose(task, palaceContext, playbookHint, activePlaybook);

    // 3b. DEPENDENCY_CYCLE guard — topological sort (SWARM.md §1: MUST reject cycles)
    const cycleNodes = detectCycles(beads);
    if (cycleNodes.length > 0) {
      throw new Error(`DEPENDENCY_CYCLE detected in bead plan: ${cycleNodes.join(' → ')}`);
    }

    // 3c. CoVe: Chain-of-Verification — query KG timeline for past Witness rejections
    // on rooms matching this task before finalising the plan (ROLES.md §Mayor step 9)
    let coveWarnings = '';
    try {
      const rejectionSearch = await this.palace.search(
        task.description,
        `wing_rig_${this.rigName}`,
        'hall_events',
      );
      const rejections = rejectionSearch.results.filter((r) =>
        r.content.toLowerCase().includes('rejected') ||
        r.content.toLowerCase().includes('rejection'),
      );
      if (rejections.length > 0) {
        coveWarnings = `⚠ CoVe: ${rejections.length} past rejection(s) found for similar work — flagging witness_required on high-risk beads`;
        console.log(`[Mayor:${this.agentId}] ${coveWarnings}`);
        // Escalate witness_required for all beads when past rejections exist
        for (const bead of beads) {
          if (bead.critical_path) {
            (bead as { witness_required: boolean }).witness_required = true;
          }
        }
      }
    } catch {
      // non-fatal
    }

    // 4. MANDATORY CHECKPOINT before dispatch
    let checkpointId: string;
    try {
      checkpointId = await this.palace.saveCheckpoint(
        this.agentId,
        { task, beads: beads.map((b) => ({ bead_id: b.bead_id, task_type: b.task_type })) },
        beads.map((b) => b.bead_id),
      );
    } catch (err) {
      throw new Error(`Mayor dispatch blocked: MemPalace checkpoint failed: ${String(err)}`);
    }

    // Attach checkpoint ID to all beads
    const planId = `plan_${uuidv4().slice(0, 8)}`;
    const beadsWithCheckpoint = beads.map((b) => ({
      ...b,
      plan_checkpoint_id: checkpointId,
    }));

    // 5. Write beads to ledger
    for (const bead of beadsWithCheckpoint) {
      await this.ledger.appendBead(this.rigName, bead);
    }

    return {
      beads: beadsWithCheckpoint,
      plan_id: planId,
      checkpoint_id: checkpointId,
    };
  }

  /**
   * Decompose a task into beads using Groq.
   * If activePlaybook is provided (fresh, >90% success), the RoutingDispatcher
   * locks model selection to the playbook's model_hint (ROUTING.md §Playbook Shortcut).
   */
  private async decompose(
    task: Task,
    context: string,
    playbookHint: string,
    activePlaybook?: PlaybookEntry,
  ): Promise<Bead[]> {
    const systemPrompt = `You are the Mayor orchestrator of NOS Town. Decompose tasks into atomic beads.
Output JSON: { "beads": [ { "task_type": string, "task_description": string, "role": "polecat"|"witness"|"safeguard", "needs": [], "critical_path": boolean, "witness_required": boolean, "fan_out_weight": number, "priority": "high"|"medium"|"low" } ] }
Keep beads atomic and parallelizable where possible. Mark dependencies via needs[].`;

    const userPrompt = [
      context ? `Context:\n${context}` : '',
      playbookHint ? `Playbook hint:\n${playbookHint}` : '',
      `Task: ${task.description}`,
    ].filter(Boolean).join('\n\n');

    const params: InferenceParams = {
      role: 'mayor',
      task_type: 'decompose',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    };

    try {
      const raw = await this.provider.executeInference(params);
      const parsed = JSON.parse(raw) as { beads?: Array<Record<string, unknown>> };
      const rawBeads = Array.isArray(parsed.beads) ? parsed.beads : [];

      // First pass: create beads using RoutingDispatcher for model selection
      // (ROUTING.md: KG lock > Playbook shortcut > Complexity table > Role default)
      const tempBeads = rawBeads.map((rb) => {
        const role = String(rb.role ?? 'polecat');
        const taskType = String(rb.task_type ?? task.task_type ?? 'execute');
        const decision = this.router.dispatch({
          role,
          taskType,
          rigName: this.rigName,
          playbookHit: activePlaybook?.task_type === taskType ? activePlaybook : undefined,
        });
        return LedgerClass.createBead({
          role,
          task_type: taskType,
          model: decision.model,
          task_description: String(rb.task_description ?? task.description),
          needs: Array.isArray(rb.needs) ? rb.needs.map(String) : [],
          critical_path: task.critical_path ?? Boolean(rb.critical_path),
          witness_required: Boolean(rb.witness_required),
          fan_out_weight: Number(rb.fan_out_weight ?? 1),
          rig: this.rigName,
          status: 'pending',
        });
      });

      // Second pass: compute fan_out_weight = number of beads that depend on each bead
      // (ROLES.md: Mayor MUST annotate critical_path and fan_out_weight)
      const dependentCount = new Map<string, number>();
      for (const bead of tempBeads) {
        for (const dep of bead.needs) {
          dependentCount.set(dep, (dependentCount.get(dep) ?? 0) + 1);
        }
      }
      return tempBeads.map((bead) => ({
        ...bead,
        fan_out_weight: Math.max(
          bead.fan_out_weight,
          dependentCount.get(bead.bead_id) ?? 0,
        ),
      }));
    } catch (err) {
      console.error(`[Mayor:${this.agentId}] Decomposition failed: ${String(err)}`);
      // Fallback: single bead
      return [LedgerClass.createBead({
        role: 'polecat',
        task_type: task.task_type ?? 'execute',
        model: this.modelForRole('polecat'),
        task_description: task.description,
        needs: [],
        critical_path: task.critical_path ?? false,
        witness_required: task.requires_witness ?? false,
        fan_out_weight: 1,
        rig: this.rigName,
        status: 'pending',
      })];
    }
  }

  /**
   * Playbook Freshness Guard (ROUTING.md §Playbook Freshness Guard).
   * A playbook may only lock routing to Primary when ALL are true:
   *   1. success_rate > 90%  (checked by caller via palace search result metadata)
   *   2. No Witness rejections in last 14 days for same task type
   *   3. No active Safeguard lockdown pattern for same task class
   */
  private async checkPlaybookFreshness(
    description: string,
    taskType: string,
    playbookContent?: string,
  ): Promise<{ isFresh: boolean; reason?: string }> {
    // 0. Check success_rate >= 90% and sample_size >= 20 from Drawer metadata
    // Per ROUTING.md §Playbook Freshness Guard — both conditions are required
    if (playbookContent) {
      try {
        const pb = JSON.parse(playbookContent) as Record<string, unknown>;
        if (typeof pb.success_rate === 'number' && pb.success_rate < 0.9) {
          return {
            isFresh: false,
            reason: `success_rate ${(pb.success_rate * 100).toFixed(0)}% is below 90% threshold`,
          };
        }
        if (typeof pb.sample_size === 'number' && pb.sample_size < 20) {
          return {
            isFresh: false,
            reason: `sample_size ${pb.sample_size} is below minimum of 20`,
          };
        }
      } catch {
        // Content isn't JSON or missing metadata — proceed to other checks
      }
    }
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 1. Search hall_events for Witness rejections in last 14 days
    try {
      const rejectSearch = await this.palace.search(
        taskType,
        `wing_rig_${this.rigName}`,
        'hall_events',
      );
      const recentRejections = rejectSearch.results.filter((r) => {
        const isRejection = r.content.toLowerCase().includes('rejected') ||
          r.content.toLowerCase().includes('rejection');
        // Check if within 14 days — results don't always have timestamps,
        // so we rely on palace returning recent results first
        return isRejection;
      });

      if (recentRejections.length > 0) {
        return {
          isFresh: false,
          reason: `${recentRejections.length} Witness rejection(s) in recent history for task type '${taskType}'`,
        };
      }
    } catch {
      // non-fatal — palace unavailable means we can't confirm freshness
      return { isFresh: false, reason: 'palace unavailable for freshness check' };
    }

    // 2. Check KG for active Safeguard lockdown on this task class
    const today = new Date().toISOString().slice(0, 10);
    const lockdownTriples = this.kg.queryTriples(taskType, today, 'safeguard_lockdown');
    if (lockdownTriples.length > 0) {
      return {
        isFresh: false,
        reason: `active Safeguard lockdown pattern on task class '${taskType}'`,
      };
    }

    void description; // used by caller for palace.search, available for future content match
    return { isFresh: true };
  }

  /**
   * Signal that the Groq provider is experiencing an outage.
   * When active, dispatchBead() enqueues beads instead of sending them.
   * Per RESILIENCE.md §Convoy Queueing During Outage.
   */
  setOutageActive(active: boolean): void {
    const changed = this.outageActive !== active;
    this.outageActive = active;
    if (changed) {
      console.log(`[Mayor:${this.agentId}] Outage queue ${active ? 'ACTIVE' : 'CLEARED'} (${this.outageQueue.length} beads queued)`);
    }
  }

  /** Number of beads currently waiting in the outage queue */
  get outageQueueDepth(): number {
    return this.outageQueue.length;
  }

  /**
   * Drain the outage queue by dispatching all pending beads.
   * Call when PROVIDER_RECOVERED event fires.
   * Returns count of beads dispatched.
   */
  async drainOutageQueue(bus: ConvoyBus, startSeq: number): Promise<number> {
    if (this.outageQueue.length === 0) return 0;

    const toDispatch = [...this.outageQueue];
    this.outageQueue = [];
    this.outageActive = false;

    console.log(`[Mayor:${this.agentId}] Draining outage queue: ${toDispatch.length} beads`);
    let seq = startSeq;
    let dispatched = 0;

    for (const bead of toDispatch) {
      try {
        await this.dispatchBead(bead, bus, seq++);
        dispatched++;
      } catch (err) {
        console.error(`[Mayor:${this.agentId}] Failed to dispatch queued bead ${bead.bead_id}: ${String(err)}`);
        // Re-queue on failure
        this.outageQueue.push(bead);
      }
    }

    return dispatched;
  }

  /**
   * Dispatch a bead via convoy bus.
   * REQUIRES valid plan_checkpoint_id.
   * During provider outage, queues the bead for later dispatch.
   */
  async dispatchBead(
    bead: Bead,
    bus: ConvoyBus,
    seq: number,
  ): Promise<void> {
    // DISPATCH GUARD: must have checkpoint
    if (!bead.plan_checkpoint_id) {
      throw new Error(`MAYOR_CHECKPOINT_MISSING: bead ${bead.bead_id} has no plan_checkpoint_id`);
    }

    // RENDEZVOUS GUARD: rendezvous nodes MUST wait for ALL prerequisites (SWARM.md §Rendezvous)
    if (isRendezvousNode(bead)) {
      const allBeads = this.ledger.readBeads(this.rigName);
      const completedIds = new Set(
        allBeads
          .filter((b) => b.status === 'done' || b.outcome === 'SUCCESS')
          .map((b) => b.bead_id),
      );
      const unmetPrereqs = bead.needs.filter((id) => !completedIds.has(id));
      if (unmetPrereqs.length > 0) {
        // Mark as blocked — caller should retry when prerequisites complete
        const blocked: Bead = {
          ...bead,
          status: 'blocked',
          updated_at: new Date().toISOString(),
        };
        await this.ledger.appendBead(this.rigName, blocked);
        console.log(
          `[Mayor:${this.agentId}] Rendezvous bead ${bead.bead_id} blocked — waiting for: ${unmetPrereqs.join(', ')}`,
        );
        return;
      }
    }

    // CASCADE BLOCKING: if any prerequisite has FAILED, emit CONVOY_BLOCKED and abort dispatch
    // (HARDENING.md §2.3 — failed predecessor blocks the full dependency chain)
    if (bead.needs.length > 0) {
      const allBeads = this.ledger.readBeads(this.rigName);
      const failedIds = new Set(
        allBeads
          .filter((b) => b.status === 'failed' || b.outcome === 'FAILURE')
          .map((b) => b.bead_id),
      );
      const failedDeps = bead.needs.filter((id) => failedIds.has(id));
      if (failedDeps.length > 0) {
        const blocked: Bead = {
          ...bead,
          status: 'blocked',
          updated_at: new Date().toISOString(),
        };
        await this.ledger.appendBead(this.rigName, blocked);
        // Emit CONVOY_BLOCKED to Mayor's own mailbox so the orchestrator can act
        console.warn(
          `[Mayor:${this.agentId}] CONVOY_BLOCKED: bead ${bead.bead_id} has failed prerequisites: ${failedDeps.join(', ')}`,
        );
        this.emitHeartbeat?.({
          type: 'CONVOY_BLOCKED',
          bead_id: bead.bead_id,
          reason: `predecessor_failed:${failedDeps.join(',')}`,
        } as Parameters<HeartbeatEmitter>[0]);
        return;
      }
    }

    // OUTAGE GUARD: during provider outage, queue bead instead of dispatching (RESILIENCE.md)
    if (this.outageActive) {
      console.log(`[Mayor:${this.agentId}] Outage active — queuing bead ${bead.bead_id} (${this.outageQueue.length + 1} in queue)`);
      this.outageQueue.push(bead);
      // Persist to MemPalace so outage queue survives session crashes (RESILIENCE.md §Mayor Session Recovery step 3)
      try {
        await this.palace.addDrawer('wing_mayor', 'hall_events', 'outage-queue', JSON.stringify(bead));
      } catch {
        // non-fatal — in-memory queue still has it for this session
      }
      return;
    }

    let privateKey: string;
    try {
      privateKey = loadPrivateKey(this.agentId);
    } catch {
      throw new Error(`Mayor key not found for ${this.agentId}`);
    }

    const header = {
      sender_id: this.agentId,
      recipient: bead.role,
      timestamp: new Date().toISOString(),
      seq,
      trace_id: bead.plan_checkpoint_id,
    };

    const payload = {
      type: 'BEAD_DISPATCH' as const,
      data: {
        bead_id: bead.bead_id,
        task_type: bead.task_type,
        model: bead.model,
        plan_checkpoint_id: bead.plan_checkpoint_id,
        critical_path: bead.critical_path,
        fan_out_weight: bead.fan_out_weight,
        needs: bead.needs,
      },
    };

    const convoy = await buildSignedConvoy(header, payload, privateKey);
    await bus.send(convoy);
  }

  /**
   * Handle MAYOR_MISSING recovery.
   * Reads active convoys and resumes state from last checkpoint.
   */
  async recoverFromMissing(bus: ConvoyBus): Promise<void> {
    console.log(`[Mayor:${this.agentId}] Recovering from MAYOR_MISSING...`);

    // Re-read mayor's inbox for any pending convoys
    const inbox = bus.readInbox('mayor');
    console.log(`[Mayor:${this.agentId}] Found ${inbox.length} messages in inbox during recovery`);

    // Re-read ledger for in-progress beads
    const beads = this.ledger.readBeads(this.rigName);
    const inProgress = beads.filter((b) => b.status === 'in_progress');

    if (inProgress.length > 0) {
      console.log(`[Mayor:${this.agentId}] Resuming ${inProgress.length} in-progress beads`);
      // In a real system, would re-dispatch or check outcomes
    }

    this.lastHeartbeatAt = new Date();
  }

  /**
   * Start heartbeat emission loop
   */
  startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.lastHeartbeatAt = new Date();
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  get lastHeartbeat(): Date {
    return this.lastHeartbeatAt;
  }

  private modelForRole(role: string): string {
    const models: Record<string, string> = {
      polecat: 'meta-llama/llama-4-scout-17b-16e-instruct',
      witness: 'qwen-qwen3-32b',
      safeguard: 'llama-3.3-70b-versatile',
      mayor: 'compound-beta',
      historian: 'llama-3.1-8b-instant',
    };
    return models[role] ?? 'llama-3.3-70b-versatile';
  }

  close(): void {
    this.stopHeartbeat();
    this.kg.close();
  }
}
