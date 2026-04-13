// NOS Town — Historian Agent (Memory Miner)

import { Ledger } from '../ledger/index.js';
import { KnowledgeGraph } from '../kg/index.js';
import { GroqProvider } from '../groq/provider.js';
import { detectStackFamily } from '../swarm/tools.js';
import type { Bead, InferenceParams, PlaybookEntry } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export interface HistorianConfig {
  agentId: string;
  groqApiKey?: string;
  kgPath?: string;
}

export class Historian {
  private agentId: string;
  private ledger: Ledger;
  private kg: KnowledgeGraph;
  private provider: GroqProvider;

  constructor(config: HistorianConfig) {
    this.agentId = config.agentId;
    this.ledger = new Ledger();
    this.kg = new KnowledgeGraph(config.kgPath);
    this.provider = new GroqProvider(config.groqApiKey);
  }

  /**
   * Nightly Historian pipeline:
   * 1. Read beads from Ledger
   * 2. Mine patterns (minePatterns)
   * 3. Generate playbooks via Groq inference
   * 4. Write routing KG triples (updateRoutingKG)
   * 5. Record rig wing in KG (detectAndRegisterTunnels simplified)
   */
  async runNightly(rigName: string): Promise<void> {
    console.log(`[Historian:${this.agentId}] Starting nightly run for rig: ${rigName}`);

    const beads = this.ledger.readBeads(rigName);
    if (beads.length === 0) {
      console.log(`[Historian:${this.agentId}] No beads found for ${rigName}`);
      return;
    }

    // 1. Mine patterns
    const patterns = this.minePatterns(beads);

    // 2. Generate playbooks for high-success task types
    await this.generatePlaybooks(rigName, patterns, beads);

    // 3. Update KG routing based on model performance
    await this.updateRoutingKG(patterns);

    // 4. Record rig wing in KG for future cross-rig discovery
    await this.recordRigWing(rigName);

    console.log(`[Historian:${this.agentId}] Nightly run complete`);
  }

  /**
   * PII stripping: removes tokens that look like secrets, emails, or API keys
   * before writing bead content to the KG or other stores.
   * Per HISTORIAN.md: PII-stripping MUST run before any mining write.
   */
  private stripPii(text: string): string {
    return text
      // API keys / bearer tokens (common formats)
      .replace(/\b(sk-|gsk_|Bearer\s+)[A-Za-z0-9._-]{10,}/g, '[REDACTED_KEY]')
      // Email addresses
      .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
      // Generic long hex / base64 tokens (32+ chars)
      .replace(/[A-Za-z0-9+/=]{32,}/g, '[REDACTED_TOKEN]');
  }

  private minePatterns(beads: Bead[]): Map<string, { success: number; fail: number; models: Map<string, number>; totalMs: number }> {
    const patterns = new Map<string, { success: number; fail: number; models: Map<string, number>; totalMs: number }>();

    for (const bead of beads) {
      const key = bead.task_type;
      const existing = patterns.get(key) ?? { success: 0, fail: 0, models: new Map(), totalMs: 0 };

      if (bead.outcome === 'SUCCESS') {
        existing.success++;
      } else if (bead.outcome === 'FAILURE') {
        existing.fail++;
      }

      existing.totalMs += bead.metrics?.duration_ms ?? 0;
      const modelCount = existing.models.get(bead.model) ?? 0;
      existing.models.set(bead.model, modelCount + 1);

      patterns.set(key, existing);
    }

    return patterns;
  }

  private async generatePlaybooks(
    rigName: string,
    patterns: Map<string, { success: number; fail: number; models: Map<string, number> }>,
    beads: Bead[],
  ): Promise<void> {
    // Collect eligible task types
    type TaskContext = { taskType: string; stats: { success: number; fail: number; models: Map<string, number> }; successRate: number; bestModel: string; samples: (string | undefined)[] };
    const eligible: TaskContext[] = [];

    for (const [taskType, stats] of patterns.entries()) {
      if (stats.success < 3) continue;
      const successRate = stats.success / (stats.success + stats.fail);
      if (successRate < 0.7) continue;

      let bestModel = '';
      let bestCount = 0;
      for (const [model, count] of stats.models.entries()) {
        if (count > bestCount) { bestModel = model; bestCount = count; }
      }

      const samples = beads
        .filter((b) => b.task_type === taskType && b.outcome === 'SUCCESS')
        .slice(-3)
        .map((b) => b.task_description)
        .filter(Boolean);

      eligible.push({ taskType, stats, successRate, bestModel, samples });
    }

    if (eligible.length === 0) return;

    const playbookResults = await this.generatePlaybooksSequential(eligible);

    // Detect dominant stack family for this rig
    const rigStack = detectStackFamily(beads);

    for (const { ctx, playbook } of playbookResults) {
      if (!playbook) continue;
      const { taskType, stats, successRate } = ctx;

      const today = new Date().toISOString().slice(0, 10);
      this.kg.addTriple({
        subject: `rig_${rigName}`,
        relation: 'has_playbook',
        object: `playbook_${taskType}_${playbook.id}`,
        valid_from: today,
        agent_id: this.agentId,
        metadata: { class: 'advisory', task_type: taskType, success_rate: successRate, stack: rigStack },
        created_at: new Date().toISOString(),
      });

      void stats; // used above for successRate computation
    }
  }

  /** Sequential (real-time) playbook generation */
  private async generatePlaybooksSequential(
    eligible: Array<{ taskType: string; stats: { success: number; fail: number; models: Map<string, number> }; successRate: number; bestModel: string; samples: (string | undefined)[] }>,
  ): Promise<Array<{ ctx: (typeof eligible)[number]; playbook: PlaybookEntry | null }>> {
    const results: Array<{ ctx: (typeof eligible)[number]; playbook: PlaybookEntry | null }> = [];
    for (const ctx of eligible) {
      const playbook = await this.generatePlaybook(ctx.taskType, ctx.samples, ctx.bestModel);
      results.push({ ctx, playbook });
    }
    return results;
  }

  private async generatePlaybook(
    taskType: string,
    samples: (string | undefined)[],
    bestModel: string,
  ): Promise<PlaybookEntry | null> {
    try {
      const params: InferenceParams = {
        role: 'historian',
        task_type: 'generate_playbook',
        messages: [
          {
            role: 'system',
            content: 'Generate a concise playbook for a task type. Output JSON: { "title": string, "steps": [string], "tips": [string] }',
          },
          {
            role: 'user',
            content: `Task type: ${taskType}\nBest model: ${bestModel}\nExample tasks:\n${samples.join('\n')}`,
          },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      };

      const raw = await this.provider.executeInference(params);
      const parsed = JSON.parse(raw) as { title?: string; steps?: string[] };

      return {
        id: uuidv4().slice(0, 8),
        title: String(parsed.title ?? taskType),
        task_type: taskType,
        steps: Array.isArray(parsed.steps) ? parsed.steps.map(String) : [],
        model_hint: bestModel,
        created_at: new Date().toISOString(),
      };
    } catch (err) {
      console.warn(`[Historian] Playbook generation failed for ${taskType}: ${String(err)}`);
      return null;
    }
  }

  private async updateRoutingKG(
    patterns: Map<string, { success: number; fail: number; models: Map<string, number> }>,
  ): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);

    for (const [taskType, stats] of patterns.entries()) {
      const total = stats.success + stats.fail;
      if (total < 5) continue; // Not enough data

      const successRate = stats.success / total;

      // Find best model
      let bestModel = '';
      let bestCount = 0;
      for (const [model, count] of stats.models.entries()) {
        if (count > bestCount) {
          bestModel = model;
          bestCount = count;
        }
      }

      if (!bestModel) continue;

      if (successRate >= 0.9) {
        // Write routing lock
        this.kg.addTriple({
          subject: bestModel,
          relation: 'locked_to',
          object: taskType,
          valid_from: today,
          agent_id: this.agentId,
          metadata: {
            class: 'critical',
            success_rate: successRate,
            sample_size: total,
          },
          created_at: new Date().toISOString(),
        });
      } else if (successRate < 0.5 && total >= 10) {
        // Demote model from task type
        this.kg.addTriple({
          subject: bestModel,
          relation: 'demoted_from',
          object: taskType,
          valid_from: today,
          agent_id: this.agentId,
          metadata: {
            class: 'critical',
            success_rate: successRate,
            sample_size: total,
            reason: 'low_success_rate',
          },
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Record this rig's wing in the KG for future cross-rig discovery.
   * Simplified from the palace-backed version: no tunnel registration,
   * just records the current rig wing as a KG triple.
   */
  private async recordRigWing(rigName: string): Promise<void> {
    const myWing = `wing_rig_${rigName}`;
    const today = new Date().toISOString().slice(0, 10);

    this.kg.addTriple({
      subject: 'historian_wings',
      relation: 'registered',
      object: myWing,
      valid_from: today,
      agent_id: this.agentId,
      metadata: { class: 'advisory' },
      created_at: new Date().toISOString(),
    });
  }

  /**
   * Generate an AAAK-compressed bead manifest for Mayor context loading.
   * Per HISTORIAN.md §AAAK Bead Manifest Compression.
   *
   * Format:
   *   # Header: entity code definitions
   *   POL=polecat | WIT=witness | ...
   *
   *   # One line per bead:
   *   {id4}|{roleCode}|{taskCode}|{modelCode}|{outcome}|{witness}|{durationMs}ms|{tag}
   *
   * Returns the compressed manifest string.
   */
  generateAaakManifest(beads: Bead[]): string {
    // Role code table
    const ROLE_CODES: Record<string, string> = {
      polecat: 'POL',
      witness: 'WIT',
      historian: 'HIS',
      mayor: 'MAY',
      safeguard: 'SAF',
      refinery: 'REF',
    };

    // Model code table (longest prefix match wins)
    const MODEL_CODES: [string, string][] = [
      ['llama-3.1-8b', 'L8B'],
      ['llama-3.3-70b', 'L70'],
      ['llama-4-scout', 'L4S'],
      ['meta-llama/llama-4-scout', 'L4S'],
      ['qwen/qwen3-32b', 'QW32'],
      ['groq/compound-mini', 'GCM'],
      ['groq/compound', 'GCP'],
      ['llama-3.3', 'L33'],
      ['gpt-oss-120b', 'G120'],
      ['gpt-oss-20b', 'G20'],
    ];

    // Task code table: shorten task_type to a compact dot-notation code
    const TASK_CODES: Record<string, string> = {
      execute: 'exec',
      unit_test: 'unit.tst',
      documentation: 'docs',
      boilerplate: 'bplr',
      refactor: 'rfct.gen',
      logic: 'logic',
      feature: 'feat',
      security: 'sec',
      auth: 'auth.jwt',
      architecture: 'arch',
      review: 'review',
      scan: 'scan',
      generate_playbook: 'plybk',
      orchestrate: 'orch',
    };

    const encodeRole = (role: string): string => ROLE_CODES[role.toLowerCase()] ?? role.slice(0, 3).toUpperCase();

    const encodeModel = (model: string): string => {
      const lower = model.toLowerCase();
      for (const [prefix, code] of MODEL_CODES) {
        if (lower.startsWith(prefix.toLowerCase())) return code;
      }
      return model.slice(0, 4).toUpperCase();
    };

    const encodeTask = (taskType: string): string => TASK_CODES[taskType] ?? taskType.slice(0, 8);

    const encodeOutcome = (outcome?: string, status?: string): string => {
      if (outcome === 'SUCCESS' || status === 'done') return 'pass';
      if (outcome === 'FAILURE' || status === 'failed') return 'fail';
      if (status === 'blocked') return 'blk';
      return '?';
    };

    // Collect unique codes used for the header
    const usedRoles = new Set<string>();
    const usedModels = new Set<string>();
    const usedTasks = new Set<string>();

    const lines: string[] = [];
    for (const bead of beads) {
      const roleCode = encodeRole(bead.role ?? '');
      const modelCode = encodeModel(bead.model ?? '');
      const taskCode = encodeTask(bead.task_type ?? '');
      const outcomeCode = encodeOutcome(bead.outcome, bead.status);
      const idSlice = (bead.bead_id ?? '').slice(0, 4);
      const durationMs = bead.metrics?.duration_ms ?? 0;

      // Witness score — if bead has witness metadata
      const witnessField =
        bead.metrics?.witness_score !== undefined
          ? `W${Math.round((bead.metrics.witness_score as number) * 100)}`
          : 'null';

      // Tag slug: first 14 chars of task description or bead_id suffix
      const tagSlug = (bead.task_description ?? bead.bead_id ?? '')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .slice(0, 14);

      usedRoles.add(roleCode);
      usedModels.add(modelCode);
      usedTasks.add(taskCode);

      lines.push(`${idSlice}|${roleCode}|${taskCode}|${modelCode}|${outcomeCode}|${witnessField}|${durationMs}ms|${tagSlug}`);
    }

    // Build header: entity code definitions
    const roleHeader = [...usedRoles]
      .map((code) => {
        const name = Object.entries(ROLE_CODES).find(([, c]) => c === code)?.[0] ?? code;
        return `${code}=${name}`;
      })
      .join(' | ');

    const modelHeader = [...usedModels]
      .map((code) => {
        const entry = MODEL_CODES.find(([, c]) => c === code);
        return entry ? `${code}=${entry[0]}` : code;
      })
      .join(' | ');

    void usedTasks; // built up for potential future use

    const header = [
      '# AAAK entity codes:',
      `# roles: ${roleHeader}`,
      `# models: ${modelHeader}`,
      '',
    ].join('\n');

    return header + lines.join('\n');
  }

  close(): void {
    this.kg.close();
  }
}
