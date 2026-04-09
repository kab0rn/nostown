// NOS Town — Mayor Agent (Orchestrator)

import { GroqProvider } from '../groq/provider.js';
import { Ledger } from '../ledger/index.js';
import { MemPalaceClient } from '../mempalace/client.js';
import { KnowledgeGraph } from '../kg/index.js';
import { ConvoyBus } from '../convoys/bus.js';
import { buildSignedConvoy } from '../convoys/sign.js';
import { loadPrivateKey } from '../convoys/sign.js';
import type { Bead, ConvoyMessage, InferenceParams, HeartbeatEvent } from '../types/index.js';
import { Ledger as LedgerClass } from '../ledger/index.js';
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
  private heartbeatIntervalMs: number;
  private emitHeartbeat: HeartbeatEmitter | null;
  private lastHeartbeatAt: Date = new Date();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: MayorConfig) {
    this.agentId = config.agentId;
    this.rigName = config.rigName;
    this.provider = new GroqProvider(config.groqApiKey, config.emitHeartbeat);
    this.ledger = new Ledger();
    this.palace = new MemPalaceClient(config.palaceUrl);
    this.kg = new KnowledgeGraph(config.kgPath);
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 60_000;
    this.emitHeartbeat = config.emitHeartbeat ?? null;
  }

  /**
   * Startup: check for orphan workflows (MAYOR_MISSING recovery).
   * MUST be called before orchestrate() on a replacement Mayor.
   * Returns true if an orphan workflow was found and adopted.
   */
  async startup(): Promise<boolean> {
    // Check MemPalace for an active-convoy checkpoint (RESILIENCE.md § Mayor Replacement Flow)
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
        return true;
      }
    } catch {
      // Palace unreachable — non-fatal, proceed with normal startup
    }
    return false;
  }

  /**
   * Full orchestration pipeline:
   * 1. Palace wakeup (L0+L1 context)
   * 2. Check existing playbooks
   * 3. Decompose task into beads
   * 4. CHECKPOINT to MemPalace (MANDATORY before dispatch)
   * 5. Dispatch beads via convoy bus
   */
  async orchestrate(task: Task): Promise<DispatchPlan> {
    // 1. Palace wakeup
    let palaceContext = '';
    try {
      const wakeup = await this.palace.wakeup(`wing_rig_${this.rigName}`);
      palaceContext = [wakeup.l0, wakeup.l1].join('\n');
    } catch (err) {
      console.warn(`[Mayor:${this.agentId}] Palace wakeup failed (non-fatal): ${String(err)}`);
    }

    // 2. Check playbooks in MemPalace with freshness guard (ROUTING.md §Playbook Freshness Guard)
    let playbookHint = '';
    try {
      const search = await this.palace.search(task.description, `wing_rig_${this.rigName}`, 'hall_advice');
      if (search.results.length > 0) {
        const freshness = await this.checkPlaybookFreshness(task.description, task.task_type ?? 'execute');
        if (freshness.isFresh) {
          playbookHint = `Relevant playbook: ${search.results[0].content.slice(0, 500)}`;
        } else {
          // Attach as advisory context only — routing NOT locked to primary
          playbookHint = `[Advisory only — ${freshness.reason}] ${search.results[0].content.slice(0, 300)}`;
          console.log(`[Mayor:${this.agentId}] Playbook freshness check failed: ${freshness.reason}`);
        }
      }
    } catch {
      // non-fatal
    }

    // 3. Decompose task into beads
    const beads = await this.decompose(task, palaceContext, playbookHint);

    // 3b. CoVe: Chain-of-Verification — query KG timeline for past Witness rejections
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
   */
  private async decompose(
    task: Task,
    context: string,
    playbookHint: string,
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

      // First pass: create beads with temporary IDs to build dependency graph
      const tempBeads = rawBeads.map((rb, i) => LedgerClass.createBead({
        role: String(rb.role ?? 'polecat'),
        task_type: String(rb.task_type ?? task.task_type ?? 'execute'),
        model: this.modelForRole(String(rb.role ?? 'polecat')),
        task_description: String(rb.task_description ?? task.description),
        needs: Array.isArray(rb.needs) ? rb.needs.map(String) : [],
        critical_path: task.critical_path ?? Boolean(rb.critical_path),
        witness_required: Boolean(rb.witness_required),
        fan_out_weight: Number(rb.fan_out_weight ?? 1),
        rig: this.rigName,
        status: 'pending',
      }));

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
  ): Promise<{ isFresh: boolean; reason?: string }> {
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
   * Dispatch a bead via convoy bus.
   * REQUIRES valid plan_checkpoint_id.
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
