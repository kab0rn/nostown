import { AgentResponse, ConsensusResult, Strategy } from './types.js';

export function resolveConsensus(
  responses: AgentResponse[],
  strategy: Strategy,
  quorumRatio = 0.6
): ConsensusResult {
  const valid = responses.filter(r => r.parsed !== null && r.parseError === null);
  const invalid = responses.filter(r => r.parsed === null || r.parseError !== null);

  if (valid.length === 0) {
    throw new Error(`All ${responses.length} agent responses failed to parse`);
  }

  switch (strategy) {
    case 'majority':
      return majorityVote(valid, invalid, strategy);
    case 'unanimous':
      return unanimousVote(valid, invalid, strategy);
    case 'first_quorum':
      return firstQuorumVote(valid, invalid, strategy, quorumRatio);
    default:
      throw new Error(`Unknown consensus strategy: ${strategy}`);
  }
}

export function canonicalize(obj: unknown): string {
  return JSON.stringify(stableValue(obj));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stableValue(record[key]);
        return acc;
      }, {});
  }
  return value;
}

function majorityVote(
  valid: AgentResponse[],
  invalid: AgentResponse[],
  strategy: Strategy
): ConsensusResult {
  const result = pluralityVote(valid, invalid, strategy);
  if (result.agreement <= 0.5) {
    throw new Error(`majority strategy: no candidate exceeded 50% agreement (${(result.agreement * 100).toFixed(0)}%)`);
  }
  return result;
}

function pluralityVote(
  valid: AgentResponse[],
  invalid: AgentResponse[],
  strategy: Strategy
): ConsensusResult {
  const counts = new Map<string, number>();
  const byKey = new Map<string, Record<string, unknown>>();
  const total = valid.length + invalid.length;

  for (const r of valid) {
    const key = canonicalize(r.parsed!);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    byKey.set(key, r.parsed!);
  }

  let winnerKey = '';
  let maxCount = 0;
  for (const [key, count] of counts) {
    if (count > maxCount) { maxCount = count; winnerKey = key; }
  }

  const agreement = maxCount / total;
  const discarded = [...valid.filter(r => canonicalize(r.parsed!) !== winnerKey), ...invalid];

  return {
    winner: byKey.get(winnerKey)!,
    strategy,
    agreement,
    agreedCount: maxCount,
    totalResponses: total,
    invalidCount: invalid.length,
    adjudicated: false,
    responses: [...valid, ...invalid],
    discarded,
  };
}

function unanimousVote(valid: AgentResponse[], invalid: AgentResponse[], strategy: Strategy): ConsensusResult {
  if (invalid.length > 0) {
    throw new Error('unanimous strategy: one or more agents failed to produce valid JSON');
  }
  const first = canonicalize(valid[0].parsed!);
  if (!valid.every(r => canonicalize(r.parsed!) === first)) {
    throw new Error('unanimous strategy: agents disagreed');
  }
  return {
    winner: valid[0].parsed!,
    strategy,
    agreement: 1.0,
    agreedCount: valid.length,
    totalResponses: valid.length,
    invalidCount: 0,
    adjudicated: false,
    responses: valid,
    discarded: invalid,
  };
}

function firstQuorumVote(valid: AgentResponse[], invalid: AgentResponse[], strategy: Strategy, ratio: number): ConsensusResult {
  const result = pluralityVote(valid, invalid, strategy);
  if (result.agreement < ratio) {
    throw new Error(`first_quorum: ${(result.agreement * 100).toFixed(0)}% agreement below ${(ratio * 100).toFixed(0)}% threshold`);
  }
  return result;
}
