import { canonicalize } from '../swarm/resolve.js';
import type { AgentResponse, ConsensusResult, Strategy } from '../swarm/types.js';
import type { ProviderAdapter } from '../providers/index.js';
import type { BridgeMode, GasCityBead, GasCityBridgeResult } from './types.js';
import { safeJsonParse } from './json.js';
import { isBridgeAbortError, runWithTimeout } from './bridge-errors.js';
import { sanitizeError } from './redaction.js';
import { resultFromConsensus } from './results.js';

export interface ArbiterTrace {
  attempted: boolean;
  provider?: string;
  model?: string;
  raw?: string;
  parsed?: Record<string, unknown>;
  error?: string;
  latency_ms?: number;
  fallback?: 'deterministic_majority' | 'deterministic_plurality';
}

export async function adjudicate(
  runId: string,
  beadId: string,
  mode: BridgeMode,
  requestedStrategy: Strategy,
  responses: AgentResponse[],
  providers: ProviderAdapter[],
  bead: GasCityBead,
  instructions: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ result: GasCityBridgeResult; trace: ArbiterTrace } | null> {
  const fallback = deterministicPlurality(responses, requestedStrategy);
  if (!fallback) return null;

  const provider = providers[0];
  const trace: ArbiterTrace = { attempted: true, provider: provider.name, model: provider.model };
  const started = Date.now();
  try {
    const arbiterResponse = await runWithTimeout((arbiterSignal) => provider.generateJson({
      messages: arbiterMessages(bead, requestedStrategy, responses, instructions),
      timeoutMs,
      signal: arbiterSignal,
    }), timeoutMs, `arbiter ${provider.name}`, signal);
    trace.raw = arbiterResponse.content;
    trace.provider = arbiterResponse.provider;
    trace.model = arbiterResponse.model;
    trace.latency_ms = arbiterResponse.latencyMs;
    const winner = safeJsonParse(arbiterResponse.content);
    trace.parsed = winner;
    return {
      result: resultFromAdjudication(runId, beadId, mode, requestedStrategy, fallback, winner),
      trace,
    };
  } catch (err) {
    if (isBridgeAbortError(err)) throw err;
    trace.error = sanitizeError(err);
    trace.latency_ms = Date.now() - started;
    trace.fallback = fallback.agreement > 0.5 ? 'deterministic_majority' : 'deterministic_plurality';
    return {
      result: resultFromAdjudication(runId, beadId, mode, requestedStrategy, fallback, fallback.winner),
      trace,
    };
  }
}

function resultFromAdjudication(
  runId: string,
  beadId: string,
  mode: BridgeMode,
  requestedStrategy: Strategy,
  fallback: ConsensusResult,
  winner: Record<string, unknown>,
): GasCityBridgeResult {
  return resultFromConsensus(runId, beadId, mode, {
    ...fallback,
    winner,
    strategy: requestedStrategy,
    adjudicated: true,
  }, fallback.totalResponses ?? fallback.responses.length, 'adjudicated');
}

function arbiterMessages(
  bead: GasCityBead,
  strategy: Strategy,
  responses: AgentResponse[],
  instructions?: string,
) {
  return [
    {
      role: 'system' as const,
      content: [
        'You are a role-neutral NOSTown arbiter resolving a failed swarm consensus.',
        'Return exactly one JSON object. No prose, markdown, or code fences.',
        'Use this shape: {"summary": string, "recommendation": string, "confidence": number, "evidence": string[], "adjudication_reason": string}.',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: JSON.stringify({
        bead,
        requested_strategy: strategy,
        instructions: instructions ?? 'Select the best candidate and explain the adjudication briefly.',
        candidates: responses.map((response) => ({
          agent_index: response.agentIndex,
          provider: response.provider,
          model: response.model,
          parsed: response.parsed,
          parse_error: response.parseError,
          latency_ms: response.latencyMs,
        })),
      }, null, 2),
    },
  ];
}

function deterministicPlurality(responses: AgentResponse[], strategy: Strategy): ConsensusResult | null {
  const valid = responses.filter((response) => response.parsed !== null && response.parseError === null);
  const invalid = responses.filter((response) => response.parsed === null || response.parseError !== null);
  if (valid.length === 0) return null;

  const counts = new Map<string, number>();
  const byKey = new Map<string, Record<string, unknown>>();
  for (const response of valid) {
    const key = canonicalize(response.parsed);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    byKey.set(key, response.parsed!);
  }

  let winnerKey = canonicalize(valid[0].parsed);
  let maxCount = 0;
  for (const [key, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      winnerKey = key;
    }
  }

  const total = responses.length;
  return {
    winner: byKey.get(winnerKey)!,
    strategy,
    agreement: maxCount / total,
    agreedCount: maxCount,
    totalResponses: total,
    invalidCount: invalid.length,
    adjudicated: true,
    responses,
    discarded: [...valid.filter((response) => canonicalize(response.parsed) !== winnerKey), ...invalid],
  };
}
