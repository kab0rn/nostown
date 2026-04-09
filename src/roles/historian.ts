// NOS Town — Historian Agent (Memory Miner)

import { Ledger } from '../ledger/index.js';
import { KnowledgeGraph } from '../kg/index.js';
import { MemPalaceClient } from '../mempalace/client.js';
import { GroqProvider } from '../groq/provider.js';
import type { Bead, InferenceParams, PlaybookEntry } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export interface HistorianConfig {
  agentId: string;
  groqApiKey?: string;
  palaceUrl?: string;
  kgPath?: string;
}

export class Historian {
  private agentId: string;
  private ledger: Ledger;
  private kg: KnowledgeGraph;
  private palace: MemPalaceClient;
  private provider: GroqProvider;

  constructor(config: HistorianConfig) {
    this.agentId = config.agentId;
    this.ledger = new Ledger();
    this.kg = new KnowledgeGraph(config.kgPath);
    this.palace = new MemPalaceClient(config.palaceUrl);
    this.provider = new GroqProvider(config.groqApiKey);
  }

  /**
   * Nightly Historian pipeline:
   * 1. Export beads from ledger into classified MemPalace halls
   * 2. Mine patterns
   * 3. Generate playbooks for high-success task types
   * 4. Update KG routing triples
   *
   * HISTORIAN.md §Implementation Detail: auto-classify beads into:
   *   hall_facts        — permanent config/team truths
   *   hall_events       — session milestones (all resolved beads)
   *   hall_discoveries  — BLOCKED resolutions and novel findings
   *   hall_preferences  — model routing preferences
   *   hall_advice       — Playbooks (validated strategies)
   */
  async runNightly(rigName: string): Promise<void> {
    console.log(`[Historian:${this.agentId}] Starting nightly run for rig: ${rigName}`);

    const beads = this.ledger.readBeads(rigName);
    if (beads.length === 0) {
      console.log(`[Historian:${this.agentId}] No beads found for ${rigName}`);
      return;
    }

    // 1. Export beads to classified MemPalace halls (with PII stripping)
    await this.classifyBeadsToHalls(rigName, beads);

    // 2. Mine patterns
    const patterns = this.minePatterns(beads);

    // 3. Generate playbooks for high-success task types
    await this.generatePlaybooks(rigName, patterns, beads);

    // 4. Update KG routing based on model performance
    await this.updateRoutingKG(patterns);

    // 5. Write diary entry
    try {
      await this.palace.diaryWrite(
        'wing_historian',
        `Nightly run complete for ${rigName}: ${beads.length} beads processed, ${patterns.size} task types found`,
      );
    } catch (err) {
      console.warn(`[Historian] Diary write failed: ${String(err)}`);
    }

    console.log(`[Historian:${this.agentId}] Nightly run complete`);
  }

  /**
   * PII stripping: removes tokens that look like secrets, emails, or API keys
   * before writing bead content to MemPalace or the KG.
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

  /**
   * Classify beads into the correct MemPalace halls.
   * Per HISTORIAN.md §Implementation Detail — hall mapping:
   *   hall_events       → all resolved beads (session milestones)
   *   hall_discoveries  → beads that were BLOCKED before resolving (novel unblocking)
   *   hall_preferences  → beads that inform model routing (SUCCESS + high-success model)
   *   hall_facts        → task types with a very high win rate (team truths)
   */
  private async classifyBeadsToHalls(rigName: string, beads: Bead[]): Promise<void> {
    const wing = `wing_rig_${rigName}`;
    const done = beads.filter((b) => b.status === 'done' || b.outcome === 'SUCCESS');

    // Limit to most recent 100 to avoid palace saturation
    for (const bead of done.slice(-100)) {
      const rawContent = JSON.stringify({
        bead_id: bead.bead_id,
        task_type: bead.task_type,
        model: bead.model,
        outcome: bead.outcome,
        duration_ms: bead.metrics?.duration_ms,
        task_description: bead.task_description?.slice(0, 200),
      });
      const content = this.stripPii(rawContent);
      const embedding = `${bead.task_type} ${bead.outcome ?? ''} ${bead.model}`;

      try {
        // Always write to hall_events (session milestone)
        await this.palace.addDrawer(wing, 'hall_events', bead.bead_id, content, embedding);

        // hall_discoveries: beads that had a blocked predecessor before resolving
        if (bead.needs && bead.needs.length > 0 && bead.outcome === 'SUCCESS') {
          await this.palace.addDrawer(
            wing, 'hall_discoveries',
            `discovery_${bead.bead_id}`,
            content,
            `unblocked ${bead.task_type}`,
          );
        }

        // hall_preferences: successful beads inform model preference
        if (bead.outcome === 'SUCCESS' && bead.model) {
          await this.palace.addDrawer(
            wing, 'hall_preferences',
            `pref_${bead.model}_${bead.task_type}`,
            JSON.stringify({ model: bead.model, task_type: bead.task_type, outcome: 'SUCCESS' }),
            `preference ${bead.model} ${bead.task_type}`,
          );
        }
      } catch {
        // non-fatal — individual classification failure should not abort the pipeline
      }
    }
  }

  private async exportBeads(rigName: string, beads: Bead[]): Promise<void> {
    const done = beads.filter((b) => b.status === 'done' || b.outcome === 'SUCCESS');
    for (const bead of done.slice(-100)) { // last 100 to avoid blowing up
      try {
        await this.palace.addDrawer(
          `wing_rig_${rigName}`,
          'hall_events',
          bead.bead_id,
          JSON.stringify({
            bead_id: bead.bead_id,
            task_type: bead.task_type,
            model: bead.model,
            outcome: bead.outcome,
            duration_ms: bead.metrics?.duration_ms,
          }),
          `${bead.task_type} ${bead.outcome ?? ''} ${bead.model}`,
        );
      } catch {
        // non-fatal
      }
    }
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
    // Generate playbooks for task types with >= 3 successes
    for (const [taskType, stats] of patterns.entries()) {
      if (stats.success < 3) continue;

      const successRate = stats.success / (stats.success + stats.fail);
      if (successRate < 0.7) continue;

      // Find the best performing model
      let bestModel = '';
      let bestCount = 0;
      for (const [model, count] of stats.models.entries()) {
        if (count > bestCount) {
          bestModel = model;
          bestCount = count;
        }
      }

      // Sample a few successful beads for this task type
      const samples = beads
        .filter((b) => b.task_type === taskType && b.outcome === 'SUCCESS')
        .slice(-3)
        .map((b) => b.task_description)
        .filter(Boolean);

      const playbook = await this.generatePlaybook(taskType, samples, bestModel);
      if (!playbook) continue;

      // Store playbook in MemPalace hall_advice with freshness metadata
      // (success_rate + sample_size required by ROUTING.md §Playbook Freshness Guard)
      const playbookWithMeta = {
        ...playbook,
        success_rate: successRate,
        sample_size: stats.success + stats.fail,
        last_updated: new Date().toISOString(),
      };

      try {
        await this.palace.addDrawer(
          `wing_rig_${rigName}`,
          'hall_advice',
          `playbook_${taskType}`,
          this.stripPii(JSON.stringify(playbookWithMeta)),
          `playbook ${taskType} ${bestModel}`,
        );
      } catch (err) {
        console.warn(`[Historian] Playbook write failed: ${String(err)}`);
      }

      // hall_facts: task types with >= 95% success rate are team truths
      if (successRate >= 0.95 && (stats.success + stats.fail) >= 20) {
        try {
          await this.palace.addDrawer(
            `wing_rig_${rigName}`,
            'hall_facts',
            `fact_${taskType}`,
            JSON.stringify({ task_type: taskType, best_model: bestModel, success_rate: successRate }),
            `proven pattern ${taskType}`,
          );
        } catch {
          // non-fatal
        }
      }

      // Write KG triple for playbook publication
      const today = new Date().toISOString().slice(0, 10);
      this.kg.addTriple({
        subject: `rig_${rigName}`,
        relation: 'has_playbook',
        object: `playbook_${taskType}_${playbook.id}`,
        valid_from: today,
        agent_id: this.agentId,
        metadata: { class: 'advisory', task_type: taskType, success_rate: successRate },
        created_at: new Date().toISOString(),
      });
    }
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
   * Backfill any beads from the ledger that are missing from MemPalace drawers.
   * Per HARDENING.md §124: compares beads.jsonl against palace Drawers by bead_id.
   * Returns count of beads backfilled.
   */
  async backfillMissingDrawers(rigName: string): Promise<number> {
    const beads = this.ledger.readBeads(rigName);
    const done = beads.filter((b) => b.status === 'done' || b.outcome === 'SUCCESS');
    let backfilled = 0;

    for (const bead of done) {
      try {
        // Search palace for this bead_id in hall_events
        const result = await this.palace.search(bead.bead_id, `wing_rig_${rigName}`, 'hall_events');
        const found = result.results.some((r) => r.room_id === bead.bead_id);

        if (!found) {
          await this.palace.addDrawer(
            `wing_rig_${rigName}`,
            'hall_events',
            bead.bead_id,
            JSON.stringify({
              bead_id: bead.bead_id,
              task_type: bead.task_type,
              model: bead.model,
              outcome: bead.outcome,
              duration_ms: bead.metrics?.duration_ms,
            }),
            `${bead.task_type} ${bead.outcome ?? ''} ${bead.model}`,
          );
          backfilled++;
          console.log(`[Historian:${this.agentId}] Backfilled missing drawer for bead ${bead.bead_id}`);
        }
      } catch (err) {
        console.warn(`[Historian:${this.agentId}] Backfill check failed for ${bead.bead_id}: ${String(err)}`);
      }
    }

    if (backfilled > 0) {
      console.log(`[Historian:${this.agentId}] Backfill complete: ${backfilled}/${done.length} beads re-inserted`);
    }
    return backfilled;
  }

  close(): void {
    this.kg.close();
  }
}
