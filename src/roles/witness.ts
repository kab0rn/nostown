// NOS Town — Witness Agent (Reviewer)

import { GroqProvider } from '../groq/provider.js';
import { KnowledgeGraph } from '../kg/index.js';
import { MemPalaceClient } from '../mempalace/client.js';
import type { ReviewVerdict, InferenceParams } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export interface WitnessConfig {
  agentId: string;
  rigName: string;
  groqApiKey?: string;
  palaceUrl?: string;
  kgPath?: string;
}

interface JudgeVote {
  judge_id: string;
  approved: boolean;
  comment: string;
  score: number;
}

export class Witness {
  private agentId: string;
  private rigName: string;
  private provider: GroqProvider;
  private kg: KnowledgeGraph;
  private palace: MemPalaceClient;

  constructor(config: WitnessConfig) {
    this.agentId = config.agentId;
    this.rigName = config.rigName;
    this.provider = new GroqProvider(config.groqApiKey);
    this.kg = new KnowledgeGraph(config.kgPath);
    this.palace = new MemPalaceClient(config.palaceUrl);
  }

  /**
   * Review a diff/patch against requirements.
   * Uses 1 judge for non-critical, 3 for critical PRs.
   */
  async review(
    diff: string,
    requirement: string,
    prId: string,
    critical = false,
  ): Promise<ReviewVerdict> {
    const judgeCount = critical ? 3 : 1;
    const votes: JudgeVote[] = [];
    const councilId = uuidv4().slice(0, 8);

    for (let i = 0; i < judgeCount; i++) {
      const judgeId = `${this.agentId}_judge_${i}`;
      const vote = await this.runJudge(judgeId, diff, requirement, prId);
      votes.push(vote);
    }

    const approvedCount = votes.filter((v) => v.approved).length;
    const approved = approvedCount > judgeCount / 2; // majority
    const score = `${approvedCount}/${judgeCount}`;

    const verdict: ReviewVerdict = {
      approved,
      score,
      reason: votes.map((v) => v.comment).join(' | '),
      votes: votes.map((v) => ({
        judge_id: v.judge_id,
        approved: v.approved,
        comment: v.comment,
      })),
    };

    // Write verdict to KG
    const today = new Date().toISOString().slice(0, 10);
    this.kg.addTriple({
      subject: `witness_council_${councilId}`,
      relation: approved ? 'approved' : 'rejected',
      object: `${this.rigName}-${prId}`,
      valid_from: today,
      agent_id: this.agentId,
      metadata: {
        class: 'critical',
        score,
        reason: verdict.reason,
      },
      created_at: new Date().toISOString(),
    });

    // Write to MemPalace
    try {
      await this.palace.addDrawer(
        `wing_rig_${this.rigName}`,
        'hall_events',
        `witness_${prId}`,
        JSON.stringify({ council_id: councilId, verdict, pr_id: prId }),
        `witness review ${prId} ${approved ? 'approved' : 'rejected'}`,
      );
    } catch (err) {
      console.warn(`[Witness] MemPalace write failed: ${String(err)}`);
    }

    return verdict;
  }

  private async runJudge(
    judgeId: string,
    diff: string,
    requirement: string,
    prId: string,
  ): Promise<JudgeVote> {
    const prompt = `You are a code reviewer. Review this diff against the requirement.

REQUIREMENT:
${requirement}

DIFF:
${diff}

Respond in JSON with exactly:
{
  "approved": <boolean>,
  "score": <number 0-10>,
  "comment": "<brief reason>"
}`;

    const params: InferenceParams = {
      role: 'witness',
      task_type: 'code_review',
      messages: [
        { role: 'system', content: 'You are a rigorous code reviewer. Output valid JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    };

    try {
      const raw = await this.provider.executeInference(params);
      const parsed = JSON.parse(raw) as { approved?: boolean; score?: number; comment?: string };
      return {
        judge_id: judgeId,
        approved: Boolean(parsed.approved),
        score: Number(parsed.score ?? 5),
        comment: String(parsed.comment ?? 'No comment'),
      };
    } catch (err) {
      console.error(`[Witness] Judge ${judgeId} failed: ${String(err)}`);
      return {
        judge_id: judgeId,
        approved: false,
        score: 0,
        comment: `Judge failed: ${String(err)}`,
      };
    }
  }

  close(): void {
    this.kg.close();
  }
}
