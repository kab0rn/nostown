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
   * Per ROLES.md: reads own diary before reviewing a room seen before.
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

    // ROLES.md: read witness diary before reviewing — provides memory of past rejections
    let diaryContext = '';
    try {
      const diary = await this.palace.diaryRead('wing_witness', 10);
      const relevant = diary.filter((e) => e.content.includes(prId));
      if (relevant.length > 0) {
        diaryContext = `\nPrevious reviews for this PR:\n${relevant.map((e) => e.content.slice(0, 200)).join('\n')}`;
      }
    } catch {
      // non-fatal — diary unavailable
    }

    // Critical PRs: load partial votes from MemPalace before running judges
    // (RESILIENCE.md §Witness Council Recovery — re-run only missing votes)
    const partialVotes: JudgeVote[] = [];
    if (critical) {
      partialVotes.push(...await this.loadPartialVotes(prId, councilId));
    }

    // Determine which judge indices still need to run
    const completedIndices = new Set(
      partialVotes.map((v) => parseInt(v.judge_id.split('_judge_')[1] ?? '-1', 10)),
    );
    const missingIndices = Array.from({ length: judgeCount }, (_, i) => i)
      .filter((i) => !completedIndices.has(i));

    // Critical PRs run missing judges in parallel (ROLES.md: 3 Witnesses parallel, 2/3 majority)
    // Non-critical: single judge, sequential
    const judgePromises = missingIndices.map((i) => {
      const judgeId = `${this.agentId}_judge_${i}`;
      const judgePromise = this.runJudge(judgeId, diff, requirement + diaryContext, prId);
      if (critical) {
        // Checkpoint each judge's vote to MemPalace as it completes (HARDENING.md §Witness)
        return judgePromise.then(async (vote) => {
          await this.checkpointVote(prId, councilId, vote).catch(() => { /* non-fatal */ });
          return vote;
        });
      }
      return judgePromise;
    });

    const newVotes = critical
      ? await Promise.all(judgePromises)
      : [await judgePromises[0]];
    votes.push(...partialVotes, ...newVotes);

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

    // Write verdict drawer to MemPalace
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

    // Write diary entry so future reviews of this room have context (ROLES.md §Witness)
    try {
      const diaryEntry = `PR ${prId}: ${approved ? 'APPROVED' : 'REJECTED'} (${score}) — ${(verdict.reason ?? '').slice(0, 300)}`;
      await this.palace.diaryWrite('wing_witness', diaryEntry);
    } catch {
      // non-fatal
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

  /**
   * Load partial votes from MemPalace for interrupted council recovery.
   * (RESILIENCE.md §Witness Council Recovery)
   * Discards votes older than 24 hours (stale context → full re-run).
   */
  private async loadPartialVotes(prId: string, councilId: string): Promise<JudgeVote[]> {
    try {
      const search = await this.palace.search(
        `${prId}-vote`,
        'wing_witness',
        'hall_events',
      );
      const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
      const votes: JudgeVote[] = [];
      for (const entry of search.results) {
        try {
          const partial = JSON.parse(entry.content) as {
            council_id?: string;
            judge_id?: string;
            approved?: boolean;
            score?: number;
            comment?: string;
            ts?: string;
          };
          // Only recover votes from the same council session
          if (partial.council_id !== councilId) continue;
          if (partial.ts && new Date(partial.ts).getTime() < cutoffMs) continue;
          if (partial.judge_id) {
            votes.push({
              judge_id: partial.judge_id,
              approved: Boolean(partial.approved),
              score: Number(partial.score ?? 5),
              comment: String(partial.comment ?? 'Recovered vote'),
            });
          }
        } catch {
          // malformed entry — skip
        }
      }
      return votes;
    } catch {
      return [];
    }
  }

  /**
   * Checkpoint a single judge's vote to MemPalace.
   * (HARDENING.md §Witness: write council vote progress before final verdict)
   */
  private async checkpointVote(prId: string, councilId: string, vote: JudgeVote): Promise<void> {
    await this.palace.addDrawer(
      'wing_witness',
      'hall_events',
      `${prId}-vote`,
      JSON.stringify({
        council_id: councilId,
        judge_id: vote.judge_id,
        approved: vote.approved,
        score: vote.score,
        comment: vote.comment,
        ts: new Date().toISOString(),
      }),
      `partial vote: ${vote.judge_id} for ${prId}`,
    );
  }

  close(): void {
    this.kg.close();
  }
}
