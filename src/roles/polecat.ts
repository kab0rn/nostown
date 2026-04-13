// NOS Town — Polecat Agent (Executor)

import { GroqProvider } from '../groq/provider.js';
import { Ledger } from '../ledger/index.js';
import type { SafeguardPool } from './safeguard.js';
import type { Bead, InferenceParams, HeartbeatEvent } from '../types/index.js';
import { beadThroughput } from '../telemetry/metrics.js';

export type HeartbeatEmitter = (event: HeartbeatEvent) => void;

export interface PolecatConfig {
  agentId: string;
  rigName: string;
  groqApiKey?: string;
  emitHeartbeat?: HeartbeatEmitter;
  /**
   * Optional Safeguard pool for pre-write diff scanning.
   * Per HARDENING.md §4.1: Safeguard scans result diff before FILE_WRITE.
   * If provided and scan rejects, the bead is marked FAILURE with violation detail.
   */
  safeguard?: SafeguardPool;
}

export interface ExecutionContext {
  task_description: string;
  system_prompt?: string;
  context_snippets?: string[];
  pr_id?: string;
}

export class Polecat {
  private agentId: string;
  private rigName: string;
  private provider: GroqProvider;
  private ledger: Ledger;
  private safeguard: SafeguardPool | null;
  private emitHeartbeat: HeartbeatEmitter | null;

  // Track last activity time for heartbeat stall detection
  private lastActivityAt: Date = new Date();
  private activeBead: string | null = null;

  constructor(config: PolecatConfig) {
    this.agentId = config.agentId;
    this.rigName = config.rigName;
    this.provider = new GroqProvider(config.groqApiKey, config.emitHeartbeat);
    this.ledger = new Ledger();
    this.safeguard = config.safeguard ?? null;
    this.emitHeartbeat = config.emitHeartbeat ?? null;
  }

  get lastActivity(): Date {
    return this.lastActivityAt;
  }

  get currentBeadId(): string | null {
    return this.activeBead;
  }

  /**
   * Execute a bead task.
   * Calls Groq, writes result to ledger.
   */
  async execute(bead: Bead, context: ExecutionContext): Promise<Bead> {
    this.activeBead = bead.bead_id;
    this.lastActivityAt = new Date();

    // Check prerequisites are satisfied
    const prereqs = this.ledger.getPrerequisites(bead.bead_id, this.rigName);
    for (const prereq of prereqs) {
      if (prereq.outcome !== 'SUCCESS') {
        const blocked: Bead = {
          ...bead,
          status: 'blocked',
          updated_at: new Date().toISOString(),
        };
        await this.ledger.appendBead(this.rigName, blocked);
        this.emitHeartbeat?.({ type: 'BEAD_BLOCKED', bead_id: bead.bead_id, retry_count: 0 });
        this.activeBead = null;
        return blocked;
      }
    }

    // Mark in-progress
    const inProgress: Bead = {
      ...bead,
      status: 'in_progress',
      updated_at: new Date().toISOString(),
    };
    await this.ledger.appendBead(this.rigName, inProgress);

    const startMs = Date.now();

    try {
      // Build system prompt with context
      const systemParts = [
        context.system_prompt ?? `You are a Polecat executor agent (${this.agentId}). Complete the given task precisely and output your result as structured text.`,
        context.context_snippets?.length
          ? `Context:\n${context.context_snippets.join('\n---\n')}`
          : '',
      ].filter(Boolean);

      const inferenceParams: InferenceParams = {
        role: 'polecat',
        model: bead.model,
        task_type: bead.task_type,
        messages: [
          { role: 'system', content: systemParts.join('\n\n') },
          { role: 'user', content: context.task_description },
        ],
        temperature: 0.3,
      };

      this.lastActivityAt = new Date();
      const result = await this.provider.executeInference(inferenceParams);
      this.lastActivityAt = new Date();

      const durationMs = Date.now() - startMs;

      // Safeguard pre-write scan (HARDENING.md §4.1)
      // If a SafeguardPool is wired in, scan the result diff before writing.
      if (this.safeguard) {
        const scanPriority = bead.critical_path ? 10 : 0;
        const scanResult = await this.safeguard.scan(result, scanPriority);
        if (!scanResult.approved) {
          const topViolation = scanResult.violations[0];
          const violationDetail = topViolation
            ? `${topViolation.severity}: ${topViolation.rule} — ${topViolation.detail}`
            : 'safeguard rejected result';

          const blocked: Bead = {
            ...inProgress,
            status: 'failed',
            outcome: 'FAILURE',
            metrics: { ...bead.metrics, duration_ms: durationMs },
            updated_at: new Date().toISOString(),
          };
          await this.ledger.appendBead(this.rigName, blocked);
          console.error(`[Polecat:${this.agentId}] Safeguard blocked bead ${bead.bead_id}: ${violationDetail}`);
          this.emitHeartbeat?.({
            type: 'BEAD_BLOCKED',
            bead_id: bead.bead_id,
            retry_count: 0,
          });
          this.activeBead = null;
          return blocked;
        }
      }

      // Write success to ledger
      const done: Bead = {
        ...inProgress,
        status: 'done',
        outcome: 'SUCCESS',
        metrics: {
          ...bead.metrics,
          duration_ms: durationMs,
        },
        updated_at: new Date().toISOString(),
      };
      await this.ledger.appendBead(this.rigName, done);

      beadThroughput.add(1, { role: bead.role, task_type: bead.task_type });
      this.activeBead = null;
      return done;
    } catch (err) {
      const error = err as Error;
      const durationMs = Date.now() - startMs;

      // Write failure to ledger
      const failed: Bead = {
        ...inProgress,
        status: 'failed',
        outcome: 'FAILURE',
        metrics: { ...bead.metrics, duration_ms: durationMs },
        updated_at: new Date().toISOString(),
      };
      await this.ledger.appendBead(this.rigName, failed);

      console.error(`[Polecat:${this.agentId}] Execution failed for ${bead.bead_id}: ${error.message}`);
      this.activeBead = null;
      return failed;
    }
  }
}
