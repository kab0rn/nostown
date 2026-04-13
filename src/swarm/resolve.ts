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

function canonicalize(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function majorityVote(
  valid: AgentResponse[],
  invalid: AgentResponse[],
  strategy: Strategy
): ConsensusResult {
  const counts = new Map<string, number>();
  const byKey = new Map<string, Record<string, unknown>>();

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

  const agreement = maxCount / valid.length;
  const discarded = [...valid.filter(r => canonicalize(r.parsed!) !== winnerKey), ...invalid];

  return { winner: byKey.get(winnerKey)!, strategy, agreement, responses: valid, discarded };
}

function unanimousVote(valid: AgentResponse[], invalid: AgentResponse[], strategy: Strategy): ConsensusResult {
  const first = canonicalize(valid[0].parsed!);
  if (!valid.every(r => canonicalize(r.parsed!) === first)) {
    throw new Error('unanimous strategy: agents disagreed');
  }
  return { winner: valid[0].parsed!, strategy, agreement: 1.0, responses: valid, discarded: invalid };
}

function firstQuorumVote(valid: AgentResponse[], invalid: AgentResponse[], strategy: Strategy, ratio: number): ConsensusResult {
  const result = majorityVote(valid, invalid, strategy);
  if (result.agreement < ratio) {
    throw new Error(`first_quorum: ${(result.agreement * 100).toFixed(0)}% agreement below ${(ratio * 100).toFixed(0)}% threshold`);
  }
  return result;
}
