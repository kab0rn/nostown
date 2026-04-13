// NOS Town — Witness Agent (Reviewer)

import { GroqProvider } from '../groq/provider.js';
import { KnowledgeGraph } from '../kg/index.js';
import type { ReviewVerdict, InferenceParams } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export interface WitnessConfig {
  agentId: string;
  rigName: string;
  groqApiKey?: string;
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

  constructor(config: WitnessConfig) {
    this.agentId = config.agentId;
    this.rigName = config.rigName;
    this.provider = new GroqProvider(config.groqApiKey);
    this.kg = new KnowledgeGraph(config.kgPath);
  }

  /**
   * Review a diff/patch against requirements.
   * Uses 1 judge for non-critical, 3 for critical PRs (2/3 majority).
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

    // Critical PRs run judges in parallel (ROLES.md: 3 Witnesses parallel, 2/3 majority)
    // Non-critical: single judge, sequential
    const judgePromises = Array.from({ length: judgeCount }, (_, i) => {
      const judgeId = `${this.agentId}_judge_${i}`;
      return this.runJudge(judgeId, diff, requirement, prId);
    });

    const newVotes = critical
      ? await Promise.all(judgePromises)
      : [await judgePromises[0]];
    votes.push(...newVotes);

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

    // Per-judge KG vote logging for audit trail (ROLES.md §Quality Tuning)
    const today = new Date().toISOString().slice(0, 10);
    if (critical) {
      for (const vote of votes) {
        this.kg.addTriple({
          subject: `witness_judge_${vote.judge_id}`,
          relation: vote.approved ? 'approved' : 'rejected',
          object: `${this.rigName}-${prId}`,
          valid_from: today,
          agent_id: vote.judge_id,
          metadata: {
            class: 'advisory',
            score: String(vote.score),
            council_id: councilId,
          },
          created_at: new Date().toISOString(),
        });
      }
    }

    // Write verdict to KG
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

  // prId is kept as parameter name for clarity but currently not used beyond judge invocation
  close(): void {
    this.kg.close();
  }
}
