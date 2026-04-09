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

    // 2. Check playbooks in MemPalace
    let playbookHint = '';
    try {
      const search = await this.palace.search(task.description, `wing_rig_${this.rigName}`, 'hall_advice');
      if (search.results.length > 0) {
        playbookHint = `Relevant playbook: ${search.results[0].content.slice(0, 500)}`;
      }
    } catch {
      // non-fatal
    }

    // 3. Decompose task into beads
    const beads = await this.decompose(task, palaceContext, playbookHint);

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

      return rawBeads.map((rb) => LedgerClass.createBead({
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
