// NOS Town — Mayor Agent (Orchestrator)

import { GroqProvider } from '../groq/provider.js';
import { Ledger } from '../ledger/index.js';
import { KnowledgeGraph } from '../kg/index.js';
import { ConvoyBus } from '../convoys/bus.js';
import { buildSignedConvoy } from '../convoys/sign.js';
import { loadPrivateKey } from '../convoys/sign.js';
import { RoutingDispatcher } from '../routing/dispatch.js';
import { Refinery } from './refinery.js';
import type { Bead, InferenceParams, HeartbeatEvent, PlaybookEntry, ReviewVerdict } from '../types/index.js';
import type { RefineryAnalysis } from './refinery.js';
import { Ledger as LedgerClass } from '../ledger/index.js';
import { DEFAULT_IN_FLIGHT_LIMITS, isRendezvousNode, detectCycles, swarmRebalanceLimits } from '../swarm/tools.js';
import { auditLog } from '../hardening/audit.js';
import { newTraceContext } from '../telemetry/tracer.js';
import { v4 as uuidv4 } from 'uuid';

export type HeartbeatEmitter = (event: HeartbeatEvent) => void;

/**
 * Task types that always require Refinery pre-processing before Witness review.
 * Configurable via NOS_REFINERY_TASK_TYPES env var (comma-separated). (GAP M4)
 * Read lazily so tests can set the env var before creating a Mayor instance.
 */
function getRefineryTaskTypes(): Set<string> {
  return new Set((process.env.NOS_REFINERY_TASK_TYPES ?? '').split(',').filter(Boolean));
}

export interface MayorConfig {
  agentId: string;
  rigName: string;
  groqApiKey?: string;
  kgPath?: string;
  heartbeatIntervalMs?: number;
  emitHeartbeat?: HeartbeatEmitter;
  /** Optional Refinery instance for Witness-rejection escalation (ROLES.md §Refinery) */
  refinery?: Refinery;
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
  private kg: KnowledgeGraph;
  private router: RoutingDispatcher;
  private refinery: Refinery | null;
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
    this.kg = new KnowledgeGraph(config.kgPath);
    this.router = new RoutingDispatcher(this.kg);
    this.refinery = config.refinery ?? null;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 60_000;
    this.emitHeartbeat = config.emitHeartbeat ?? null;
  }

  /**
   * Startup: check for orphan workflows (MAYOR_MISSING recovery).
   * MUST be called before orchestrate() on a replacement Mayor.
   * Returns true if an orphan workflow was found and adopted.
   *
   * Reads the Ledger directly for in-progress/pending beads.
   * Orphan detection is ledger-only; no external memory server required.
   */
  async startup(): Promise<boolean> {
    let orphanFound = false;

    const beads = this.ledger.readBeads(this.rigName);
    const inProgress = beads.filter(
      (b) => b.status === 'in_progress' || b.status === 'pending',
    );
    if (inProgress.length > 0) {
      console.log(
        `[Mayor:${this.agentId}] Adopting ${inProgress.length} orphan beads — NOT re-decomposing`,
      );
      auditLog(
        'MAYOR_ADOPTION',
        this.agentId,
        'ledger-recovery',
        `Adopted ${inProgress.length} orphan bead(s) from ledger; ledger-only recovery`,
      );
      this.lastHeartbeatAt = new Date();
      orphanFound = true;
    }

    return orphanFound;
  }

  /**
   * Full orchestration pipeline:
   * 1. Adaptive backpressure
   * 2. Inbox backpressure
   * 3. Decompose task into beads
   * 4. DEPENDENCY_CYCLE guard
   * 5. Generate ephemeral checkpoint UUID
   * 6. Write beads to ledger
   * 7. Dispatch via ConvoyBus
   */
  async orchestrate(task: Task, inFlightLimits = DEFAULT_IN_FLIGHT_LIMITS): Promise<DispatchPlan> {
    // 0. Adaptive backpressure: dynamically rebalance limits using live metrics (SWARM.md §3)
    const currentBeads = this.ledger.readBeads(this.rigName);

    // Compute throughput and error rate from the last 60 s of completed beads
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const recentBeads = currentBeads.filter(
      (b) => (b.updated_at ?? b.created_at) >= oneMinuteAgo && b.status !== 'pending' && b.status !== 'in_progress',
    );
    const recentFailed = recentBeads.filter((b) => b.outcome === 'FAILURE').length;
    const beadsPerMinute = recentBeads.length;
    const errorRate = recentBeads.length > 0 ? recentFailed / recentBeads.length : 0;

    const adjustedLimits = swarmRebalanceLimits(inFlightLimits, { beadsPerMinute, errorRate });
    if (adjustedLimits.maxPolecatBeads !== inFlightLimits.maxPolecatBeads) {
      console.log(
        `[Mayor:${this.agentId}] Swarm limits adjusted: maxPolecats ${inFlightLimits.maxPolecatBeads}→${adjustedLimits.maxPolecatBeads} (${beadsPerMinute} bpm, ${(errorRate * 100).toFixed(1)}% err)`,
      );
    }

    const inProgressCount = currentBeads.filter((b) => b.status === 'in_progress').length;
    if (inProgressCount >= adjustedLimits.maxPolecatBeads) {
      throw new Error(
        `Mayor WAITING_FOR_CAPACITY: ${inProgressCount} beads in-flight (limit: ${adjustedLimits.maxPolecatBeads})`,
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

    // 1. Query KG for playbook (ROUTING.md §Playbook Freshness Guard)
    const taskType = task.task_type ?? 'execute';
    const playbookMeta = this.kg.queryPlaybook(taskType, this.rigName);
    let activePlaybook: PlaybookEntry | undefined;
    let playbookHint = '';

    if (playbookMeta && this.router.isPlaybookFresh(playbookMeta.successRate, playbookMeta.sampleSize, taskType)) {
      activePlaybook = {
        id: playbookMeta.playbookId,
        title: playbookMeta.playbookId,
        task_type: taskType,
        steps: [],
        model_hint: playbookMeta.modelHint ?? '',
        created_at: new Date().toISOString(),
      };
      playbookHint = `Use playbook ${playbookMeta.playbookId} (success rate: ${(playbookMeta.successRate * 100).toFixed(0)}%)`;
    }

    // 2. Decompose task into beads
    const beads = await this.decompose(task, '', playbookHint, activePlaybook);

    // 3. DEPENDENCY_CYCLE guard — topological sort (SWARM.md §1: MUST reject cycles)
    const cycleNodes = detectCycles(beads);
    if (cycleNodes.length > 0) {
      throw new Error(`DEPENDENCY_CYCLE detected in bead plan: ${cycleNodes.join(' → ')}`);
    }

    // 4. Generate ephemeral checkpoint UUID (local only, not persisted to KG)
    const checkpointId = `ckpt_${uuidv4().slice(0, 12)}`;

    // Generate OTel trace context for this plan (OBSERVABILITY.md §2 — distributed tracing)
    const traceCtx = newTraceContext();

    // 5. Attach checkpoint ID, trace_id, and playbook_match to all beads
    const planId = `plan_${uuidv4().slice(0, 8)}`;
    const beadsWithCheckpoint = beads.map((b) => ({
      ...b,
      plan_checkpoint_id: checkpointId,
      trace_id: traceCtx.trace_id,
      ...(activePlaybook ? { playbook_match: activePlaybook.id } : {}),
    }));

    // 6. Write beads to ledger
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
      let finalBeads = tempBeads.map((bead) => {
        const fanOut = Math.max(bead.fan_out_weight, dependentCount.get(bead.bead_id) ?? 0);
        const refineryRequired = fanOut >= 5 || getRefineryTaskTypes().has(bead.task_type);
        return {
          ...bead,
          fan_out_weight: fanOut,
          ...(refineryRequired ? { refinery_required: true } : {}),
        };
      });

      // P8: CoVe self-critique — only for multi-bead plans (no deps to check in single-bead)
      if (finalBeads.length > 1) {
        finalBeads = await this.covePass(finalBeads, task);
      }

      return finalBeads;
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
   * P8: Chain-of-Verification (CoVe) self-critique pass.
   * Makes a focused second Groq call to check for missing dependency edges only.
   * Failures are non-fatal — returns the original plan on any error.
   * CoVe corrections that introduce cycles are silently discarded.
   */
  private async covePass(beads: Bead[], task: Task): Promise<Bead[]> {
    const plan = beads.map((b) => ({
      id: b.bead_id,
      type: b.task_type,
      desc: b.task_description,
      needs: b.needs,
    }));

    const params: InferenceParams = {
      role: 'mayor',
      task_type: 'cove_review',
      messages: [
        {
          role: 'system',
          content: `You are reviewing a bead plan for missing dependency edges.
Output JSON: { "corrections": [ { "bead_id": string, "add_needs": [string] } ] }
Only add missing edges — do NOT change descriptions or remove beads.
Output empty corrections array if the plan is correct.`,
        },
        {
          role: 'user',
          content: `Original goal: ${task.description}\n\nPlan:\n${JSON.stringify(plan, null, 2)}`,
        },
      ],
      temperature: 0.0,
      response_format: { type: 'json_object' },
    };

    try {
      const raw = await this.provider.executeInference(params);
      const parsed = JSON.parse(raw) as { corrections?: Array<{ bead_id: string; add_needs: string[] }> };
      const corrections = parsed.corrections ?? [];

      if (corrections.length === 0) return beads;

      // Apply corrections — only add needs that reference valid bead IDs
      const beadMap = new Map(beads.map((b) => [b.bead_id, { ...b }]));
      for (const c of corrections) {
        const bead = beadMap.get(c.bead_id);
        if (bead && Array.isArray(c.add_needs)) {
          bead.needs = [...new Set([...bead.needs, ...c.add_needs.filter((id) => beadMap.has(id))])];
          beadMap.set(bead.bead_id, bead);
        }
      }

      // Re-run cycle detection after CoVe corrections
      const updated = [...beadMap.values()];
      const cycleNodes = detectCycles(updated);
      if (cycleNodes.length > 0) {
        console.warn(`[Mayor:${this.agentId}] CoVe introduced a cycle (${cycleNodes.join(' → ')}) — discarding corrections`);
        return beads;
      }

      return updated;
    } catch (err) {
      // CoVe is best-effort — don't block dispatch on failure
      console.warn(`[Mayor:${this.agentId}] CoVe pass failed: ${String(err)} — proceeding with original plan`);
      return beads;
    }
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
      // Outage queue is in-memory for the session; beads are not persisted across Mayor restarts.
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
      trace_id: bead.trace_id ?? bead.plan_checkpoint_id,
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
      witness: 'qwen/qwen3-32b',
      safeguard: 'llama-3.3-70b-versatile',
      mayor: 'groq/compound',
      historian: 'llama-3.1-8b-instant',
    };
    return models[role] ?? 'llama-3.3-70b-versatile';
  }

  /**
   * Escalate a Witness-rejected bead to the Refinery for deep root-cause analysis.
   * Per ROLES.md §Refinery: triggered when Witness council unanimously rejects AND:
   *   - attempts >= 2 (any task type), OR
   *   - task_type is 'architecture' or 'security' (escalate immediately on first rejection)
   *
   * Returns null if escalation conditions are not met or Refinery is not configured.
   * Emits REFINERY_ESCALATION audit event on escalation.
   */
  async escalateToRefinery(
    bead: Bead,
    verdict: ReviewVerdict,
    attempts: number,
    diff?: string,
  ): Promise<RefineryAnalysis | null> {
    if (!this.refinery) return null;
    if (verdict.approved) return null;

    const archOrSecurity = ['architecture', 'security'].includes(bead.task_type);
    const thresholdMet = attempts >= 2 || archOrSecurity;
    if (!thresholdMet) return null;

    auditLog(
      'REFINERY_ESCALATION',
      this.agentId,
      bead.bead_id ?? 'unknown',
      `task_type=${bead.task_type} attempts=${attempts} score=${verdict.score}`,
    );

    const analysis = await this.refinery.analyze(
      bead.task_description ?? '',
      bead.task_type,
      {
        witnessReason: verdict.reason ?? `Score ${verdict.score} — all judges rejected`,
        attempts,
        diff,
      },
    );

    return analysis;
  }

  close(): void {
    this.stopHeartbeat();
    this.kg.close();
  }
}
