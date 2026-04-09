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
   * 1. Export beads from ledger
   * 2. Mine patterns into palace halls
   * 3. Generate playbooks for repeated task types
   * 4. Update KG routing triples
   */
  async runNightly(rigName: string): Promise<void> {
    console.log(`[Historian:${this.agentId}] Starting nightly run for rig: ${rigName}`);

    const beads = this.ledger.readBeads(rigName);
    if (beads.length === 0) {
      console.log(`[Historian:${this.agentId}] No beads found for ${rigName}`);
      return;
    }

    // 1. Export beads to MemPalace drawers
    await this.exportBeads(rigName, beads);

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

      // Store playbook in MemPalace hall_advice
      try {
        await this.palace.addDrawer(
          `wing_rig_${rigName}`,
          'hall_advice',
          `playbook_${taskType}`,
          JSON.stringify(playbook),
          `playbook ${taskType} ${bestModel}`,
        );
      } catch (err) {
        console.warn(`[Historian] Playbook write failed: ${String(err)}`);
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
