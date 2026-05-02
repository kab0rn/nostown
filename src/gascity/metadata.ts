import type { GasCityBridgeResult } from './types.js';

export const CONSENSUS_METADATA_KEYS = [
  'nos.consensus.status',
  'nos.consensus.run_id',
  'nos.consensus.strategy',
  'nos.consensus.agreement',
  'nos.consensus.adjudicated',
  'nos.consensus.summary',
] as const;

export type ConsensusMetadataKey = typeof CONSENSUS_METADATA_KEYS[number];

export const CONSENSUS_METADATA_KEY_SET = new Set<string>(CONSENSUS_METADATA_KEYS);

export function metadataForResult(result: GasCityBridgeResult): Record<ConsensusMetadataKey, string> {
  return {
    'nos.consensus.status': result.status,
    'nos.consensus.run_id': result.run_id,
    'nos.consensus.strategy': result.consensus?.strategy ?? 'none',
    'nos.consensus.agreement': result.consensus ? result.consensus.agreement.toFixed(4) : '0',
    'nos.consensus.adjudicated': String(result.consensus?.adjudicated ?? false),
    'nos.consensus.summary': summarize(result),
  };
}

function summarize(result: GasCityBridgeResult): string {
  if (!result.consensus) return (result.error ?? result.status).slice(0, 500);
  const winner = result.consensus.winner;
  const summary = typeof winner.summary === 'string'
    ? winner.summary
    : JSON.stringify(winner);
  return summary.slice(0, 500);
}
