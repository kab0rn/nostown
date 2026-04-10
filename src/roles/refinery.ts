// NOS Town — Refinery Agent (High-Token Reasoning)
// Per ROLES.md §Refinery and ROUTING.md §Escalation Ladder:
// Terminal escalation node for architectural decisions and complex root-cause analysis
// where 17B/32B models lack sufficient depth. Uses groq/compound (high-capability).
//
// Triggered when:
//   - Witness council rejects with score 0/N (unanimous failure)
//   - task_type is 'architecture' or 'security' and 2+ prior attempts failed
//   - Mayor explicitly marks a bead refinery_required: true
//
// Outputs:
//   - RefineryAnalysis with root-cause + recommended approach
//   - Writes architectural decision to hall_facts (permanent team truth)
//   - Writes KG triple (subject=task_type, relation=architectural_decision, object=approach_id)

import { GroqProvider } from '../groq/provider.js';
import { MemPalaceClient } from '../mempalace/client.js';
import { KnowledgeGraph } from '../kg/index.js';
import type { InferenceParams } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export interface RefineryConfig {
  agentId: string;
  rigName: string;
  groqApiKey?: string;
  palaceUrl?: string;
  kgPath?: string;
}

export interface FailureContext {
  /** Witness rejection reason or prior failure message */
  witnessReason: string;
  /** Number of prior attempts before escalating to Refinery */
  attempts: number;
  /** The diff or output that was rejected (optional, trimmed if large) */
  diff?: string;
  /** Structured error or stack trace if available */
  errorDetail?: string;
}

export interface RefineryAnalysis {
  id: string;
  taskType: string;
  rootCause: string;
  recommendedApproach: string;
  confidenceLevel: 'high' | 'medium' | 'low';
  followUpBeads: string[];  // suggested next task descriptions
  createdAt: string;
}

export class Refinery {
  private agentId: string;
  private rigName: string;
  private provider: GroqProvider;
  private palace: MemPalaceClient;
  private kg: KnowledgeGraph;

  constructor(config: RefineryConfig) {
    this.agentId = config.agentId;
    this.rigName = config.rigName;
    this.provider = new GroqProvider(config.groqApiKey);
    this.palace = new MemPalaceClient(config.palaceUrl);
    this.kg = new KnowledgeGraph(config.kgPath);
  }

  /**
   * Deep analysis of a failed task.
   * Per ROLES.md §Refinery: reads hall_facts for prior architectural decisions
   * on this task type before reasoning, then writes findings back.
   */
  async analyze(
    taskDescription: string,
    taskType: string,
    failure: FailureContext,
  ): Promise<RefineryAnalysis> {
    // 1. Read prior architectural decisions from palace for context
    let priorContext = '';
    try {
      const prior = await this.palace.search(
        taskType,
        `wing_rig_${this.rigName}`,
        'hall_facts',
      );
      if (prior.results.length > 0) {
        priorContext = `\nPrior architectural decisions for '${taskType}':\n` +
          prior.results.slice(0, 3).map((r) => r.content.slice(0, 300)).join('\n---\n');
      }
    } catch {
      // non-fatal — proceed without prior context
    }

    // 2. Run high-capability inference
    const params: InferenceParams = {
      role: 'mayor',   // groq/compound is the mayor model
      task_type: 'refinery_analysis',
      model: 'groq/compound',
      messages: [
        {
          role: 'system',
          content: `You are the Refinery — NOS Town's high-capability reasoning agent for complex root-cause analysis.
You are called when simpler models have failed. Perform deep analysis and produce a definitive recommended approach.
Output JSON: {
  "root_cause": string,
  "recommended_approach": string,
  "confidence_level": "high"|"medium"|"low",
  "follow_up_beads": [string]
}
Be concrete and actionable. The recommended_approach must be specific enough to execute.`,
        },
        {
          role: 'user',
          content: [
            `Task: ${taskDescription}`,
            `Task type: ${taskType}`,
            `Failure after ${failure.attempts} attempt(s)`,
            `Rejection reason: ${failure.witnessReason}`,
            failure.diff ? `Rejected diff (truncated):\n${failure.diff.slice(0, 3000)}` : '',
            failure.errorDetail ? `Error detail:\n${failure.errorDetail.slice(0, 1000)}` : '',
            priorContext,
          ].filter(Boolean).join('\n\n'),
        },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    };

    const raw = await this.provider.executeInference(params);
    const parsed = JSON.parse(raw) as {
      root_cause?: string;
      recommended_approach?: string;
      confidence_level?: string;
      follow_up_beads?: unknown[];
    };

    const analysis: RefineryAnalysis = {
      id: uuidv4().slice(0, 8),
      taskType,
      rootCause: String(parsed.root_cause ?? 'unknown'),
      recommendedApproach: String(parsed.recommended_approach ?? ''),
      confidenceLevel: (['high', 'medium', 'low'].includes(parsed.confidence_level ?? '')
        ? parsed.confidence_level as 'high' | 'medium' | 'low'
        : 'low'),
      followUpBeads: Array.isArray(parsed.follow_up_beads)
        ? parsed.follow_up_beads.map(String)
        : [],
      createdAt: new Date().toISOString(),
    };

    // 3. Persist as a permanent hall_facts entry (architectural decision)
    await this.persistAnalysis(analysis, taskDescription);

    return analysis;
  }

  private async persistAnalysis(
    analysis: RefineryAnalysis,
    taskDescription: string,
  ): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);

    // Write to hall_facts — permanent team truth
    try {
      await this.palace.addDrawer(
        `wing_rig_${this.rigName}`,
        'hall_facts',
        `refinery_${analysis.id}`,
        JSON.stringify({
          ...analysis,
          task_description: taskDescription.slice(0, 200),
        }),
        `architectural decision ${analysis.taskType} ${analysis.confidenceLevel}`,
      );
    } catch (err) {
      console.warn(`[Refinery:${this.agentId}] Failed to write hall_facts: ${String(err)}`);
    }

    // Write KG triple for routing decisions to be query-able by Mayor
    try {
      this.kg.addTriple({
        subject: analysis.taskType,
        relation: 'architectural_decision',
        object: `refinery_${analysis.id}`,
        valid_from: today,
        agent_id: this.agentId,
        metadata: {
          class: 'advisory',
          confidence: analysis.confidenceLevel,
          approach: analysis.recommendedApproach.slice(0, 200),
        },
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[Refinery:${this.agentId}] KG write failed: ${String(err)}`);
    }
  }

  close(): void {
    this.kg.close();
  }
}
