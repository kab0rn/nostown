// NOS Town — Natural-language query engine
//
// When a user types something into `nt`, this module decides whether it is:
//   'query'     — a question/inquiry about the system → answer directly
//   'task'      — something to orchestrate via Mayor → existing flow
//   'ambiguous' — could be either → prompt user to confirm
//
// Classification is heuristic-first (no API call for obvious cases).
// Answering uses Groq with a live system snapshot as RAG context.

import { Ledger } from '../ledger/index.js';
import { KnowledgeGraph } from '../kg/index.js';
import { GroqProvider } from '../groq/provider.js';
import type { WorkerRuntime } from '../runtime/worker-loop.js';
import type { InferenceParams } from '../types/index.js';

// ── Classification ─────────────────────────────────────────────────────────────

export type InputClass = 'query' | 'task' | 'ambiguous';

// Patterns that strongly indicate a query/inquiry
const QUERY_PATTERNS: RegExp[] = [
  /^what\b/i,
  /^how\b/i,
  /^which\b/i,
  /^who\b/i,
  /^where\b/i,
  /^when\b/i,
  /^why\b/i,
  /^is\b/i,
  /^are\b/i,
  /^can\b/i,
  /^does\b/i,
  /^do\b/i,
  /^has\b/i,
  /^have\b/i,
  /^show\s+(me\s+)?(the\s+|all\s+|recent\s+|current\s+)?/i,
  /^list\b/i,
  /^tell\s+me\b/i,
  /^give\s+me\b/i,
  /^find\b/i,
  /^look\s+up\b/i,
  /^count\b/i,
  /^describe\b/i,
  /^explain\b/i,
  /^summarize\b/i,
  /^summary\b/i,
  /^status\s+of\b/i,
  /^check\b/i,
  /\?$/,                      // ends with question mark
];

// Patterns that strongly indicate an executable task
const TASK_PATTERNS: RegExp[] = [
  /^add\b/i,
  /^fix\b/i,
  /^refactor\b/i,
  /^implement\b/i,
  /^create\b/i,
  /^update\b/i,
  /^change\b/i,
  /^remove\b/i,
  /^delete\b/i,
  /^write\b/i,
  /^move\b/i,
  /^rename\b/i,
  /^migrate\b/i,
  /^build\b/i,
  /^deploy\b/i,
  /^run\s+tests?\b/i,
  /^test\b/i,
  /^generate\b/i,
  /^extract\b/i,
  /^convert\b/i,
  /^optimize\b/i,
  /^improve\b/i,
  /^clean\s+up\b/i,
  /^refine\b/i,
  /^port\b/i,
  /^extend\b/i,
  /^wire\b/i,
  /^make\b/i,
];

export function classifyInput(input: string): InputClass {
  const trimmed = input.trim();

  if (QUERY_PATTERNS.some((p) => p.test(trimmed))) return 'query';
  if (TASK_PATTERNS.some((p) => p.test(trimmed)))  return 'task';

  return 'ambiguous';
}

// ── System snapshot ────────────────────────────────────────────────────────────

export interface SystemSnapshot {
  rig: string;
  agentId: string;
  timestamp: string;
  runtime: {
    running: boolean;
    polecats: { agentId: string; busy: boolean; currentBeadId: string | null }[];
    activePolecat: number;
    maxInflightBeads: number;
    safeguardPoolSize: number;
  };
  ledger: {
    totalBeads: number;
    byStatus: Record<string, number>;
    byOutcome: Record<string, number>;
    successRate: number;
    recentBeads: Array<{
      bead_id: string;
      task_type: string;
      model: string;
      status: string;
      outcome?: string;
      duration_ms?: number;
      updated_at?: string;
      needs: string[];
      plan_checkpoint_id?: string;
      critical_path: boolean;
      playbook_match?: string;
    }>;
    activePlans: Array<{
      plan_id: string;
      total: number;
      done: number;
      failed: number;
      blocked: number;
      in_progress: number;
    }>;
  };
  kg: {
    routingLocks: Array<{ model: string; task_type: string; success_rate?: number }>;
    demotions: Array<{ model: string; task_type: string; reason?: string }>;
    playbooks: Array<{ task_type: string; playbook_id: string; success_rate?: number }>;
    recentTriples: Array<{ subject: string; relation: string; object: string; valid_from: string }>;
  };
}

export function buildSnapshot(
  rigName: string,
  agentId: string,
  runtime: WorkerRuntime,
  kgPath?: string,
): SystemSnapshot {
  const ledger = new Ledger();
  const raw    = ledger.readBeads(rigName);

  // Collapse to latest record per bead_id
  const byId = new Map<string, typeof raw[0]>();
  for (const b of raw) byId.set(b.bead_id, b);
  const latest = [...byId.values()];

  // Status counts
  const byStatus: Record<string, number>  = {};
  const byOutcome: Record<string, number> = {};
  for (const b of latest) {
    byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
    if (b.outcome) byOutcome[b.outcome] = (byOutcome[b.outcome] ?? 0) + 1;
  }
  const total   = latest.length;
  const success = byOutcome['SUCCESS'] ?? 0;

  // Recent 15 beads (sorted newest-first)
  const recentBeads = [...latest]
    .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))
    .slice(0, 15)
    .map((b) => ({
      bead_id:            b.bead_id.slice(0, 12),
      task_type:          b.task_type ?? '—',
      model:              (b.model ?? '').replace(/.*\//, ''),
      status:             b.status,
      outcome:            b.outcome,
      duration_ms:        b.metrics?.duration_ms,
      updated_at:         b.updated_at ?? b.created_at,
      needs:              b.needs,
      plan_checkpoint_id: b.plan_checkpoint_id?.slice(0, 12),
      critical_path:      b.critical_path,
    }));

  // Active plans
  const plans = new Map<string, { done: number; failed: number; blocked: number; in_progress: number; total: number }>();
  for (const b of latest) {
    const pid = b.plan_checkpoint_id ?? 'ad-hoc';
    const p   = plans.get(pid) ?? { done: 0, failed: 0, blocked: 0, in_progress: 0, total: 0 };
    p.total++;
    if (b.status === 'done')        p.done++;
    else if (b.status === 'failed') p.failed++;
    else if (b.status === 'blocked') p.blocked++;
    else if (b.status === 'in_progress') p.in_progress++;
    plans.set(pid, p);
  }
  const activePlans = [...plans.entries()]
    .filter(([, p]) => p.in_progress > 0 || p.blocked > 0)
    .map(([plan_id, p]) => ({ plan_id: plan_id.slice(0, 12), ...p }));

  // KG data
  let routingLocks: SystemSnapshot['kg']['routingLocks'] = [];
  let demotions:    SystemSnapshot['kg']['demotions']    = [];
  let playbooks:    SystemSnapshot['kg']['playbooks']    = [];
  let recentTriples: SystemSnapshot['kg']['recentTriples'] = [];

  try {
    const kg    = new KnowledgeGraph(kgPath);
    const today = new Date().toISOString().slice(0, 10);

    // Routing locks (model → task_type)
    for (const t of kg.queryByRelation('locked_to', today)) {
      const meta = t.metadata as Record<string, unknown> | undefined;
      routingLocks.push({ model: t.subject, task_type: t.object, success_rate: meta?.success_rate as number | undefined });
    }

    // Demotions
    for (const t of kg.queryByRelation('demoted_from', today)) {
      const meta = t.metadata as Record<string, unknown> | undefined;
      demotions.push({ model: t.subject, task_type: t.object, reason: meta?.reason as string | undefined });
    }

    // Playbooks
    for (const t of kg.queryByRelation('has_playbook', today)) {
      const meta = t.metadata as Record<string, unknown> | undefined;
      playbooks.push({ task_type: t.subject, playbook_id: t.object, success_rate: meta?.success_rate as number | undefined });
    }

    // Recent triples for general context
    recentTriples = kg.queryRecent(12, today).map((t) => ({
      subject: t.subject, relation: t.relation, object: t.object, valid_from: t.valid_from,
    }));

    kg.close();
  } catch {
    // KG unavailable — proceed with empty routing data
  }

  const rs = runtime.getStatus();

  return {
    rig: rigName,
    agentId,
    timestamp: new Date().toISOString(),
    runtime: {
      running:          rs.running,
      polecats:         rs.polecats.map((p) => ({ agentId: p.agentId, busy: p.busy, currentBeadId: p.currentBeadId })),
      activePolecat:    rs.activePolecat,
      maxInflightBeads: rs.maxInflightBeads,
      safeguardPoolSize: rs.safeguardPoolSize,
    },
    ledger: {
      totalBeads:  total,
      byStatus,
      byOutcome,
      successRate: total > 0 ? Math.round((success / total) * 100) : 0,
      recentBeads,
      activePlans,
    },
    kg: { routingLocks, demotions, playbooks, recentTriples },
  };
}

// ── Query answering ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a NOS Town system assistant. NOS Town is a Groq-native multi-agent
orchestration system with these roles: Mayor (planner), Polecat (executor), Witness (reviewer),
Safeguard (security scanner), Historian (nightly analytics), Refinery (multi-step improvement).

Work is tracked as Beads in an append-only ledger. Beads have statuses: pending, in_progress,
done, failed, blocked. Outcomes are SUCCESS or FAILURE. Beads are grouped into Plans via
plan_checkpoint_id. Model routing is stored in a Knowledge Graph as temporal triples.

You will be given a live system snapshot (JSON) and a user question. Answer directly and
concisely — 1–5 sentences or a short list. If the data answers the question, use it. If the
question is about NOS Town concepts (not current state), answer from your knowledge of the system.
Do not say you cannot answer if the data is present. Do not pad the response.`;

export async function answerQuery(
  question: string,
  snapshot: SystemSnapshot,
  groqApiKey: string,
): Promise<string> {
  const provider = new GroqProvider(groqApiKey);

  const params: InferenceParams = {
    role: 'mayor',
    task_type: 'system_query',
    model: 'llama-3.1-8b-instant',   // fast, cheap — this is a simple RAG lookup
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Question: ${question}\n\n` +
          `System snapshot (${snapshot.timestamp}):\n` +
          JSON.stringify(snapshot, null, 2),
      },
    ],
    temperature: 0.1,
    max_tokens: 512,
  };

  return provider.executeInference(params);
}
