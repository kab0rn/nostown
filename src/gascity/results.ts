import type { AgentResponse, ConsensusResult } from '../swarm/types.js';
import type { BridgeMode, GasCityBridgeResult } from './types.js';

export function resultFromConsensus(
  runId: string,
  beadId: string,
  mode: BridgeMode,
  consensus: ConsensusResult,
  responseCount: number,
  status: 'consensus' | 'adjudicated',
): GasCityBridgeResult {
  return {
    ok: true,
    schema: 'gascity.swarm.result.v1',
    run_id: runId,
    bead_id: beadId,
    mode,
    status,
    consensus: {
      winner: consensus.winner,
      strategy: consensus.strategy,
      agreement: consensus.agreement,
      agreed_count: consensus.agreedCount ?? 0,
      total_responses: consensus.totalResponses ?? responseCount,
      invalid_count: consensus.invalidCount ?? consensus.responses.filter((r) => r.parseError !== null).length,
      discarded_count: consensus.discarded.length,
      adjudicated: status === 'adjudicated' || (consensus.adjudicated ?? false),
    },
    timeout_count: timeoutCount(consensus.responses),
  };
}

export function timeoutCount(responses: AgentResponse[]): number {
  return responses.filter((response) => response.timedOut).length;
}

export function noConsensusError(err: unknown, responses: AgentResponse[]): string {
  const count = timeoutCount(responses);
  if (count > 0 && count === responses.length) return 'all workers timed out';
  if (count > 0) return `${String(err)} (${count} worker timeout${count === 1 ? '' : 's'})`;
  return String(err);
}
