import type { Strategy } from '../swarm/types.js';
import type { ProviderSpec } from '../providers/index.js';

export type BridgeMode = 'pure' | 'apply';
export type BridgeStatus = 'consensus' | 'adjudicated' | 'no_consensus' | 'error';

export interface GasCityBead {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  type?: string;
  labels?: string[];
  metadata?: Record<string, string>;
  raw?: unknown;
}

export interface GasCityBridgeRequest {
  schema?: 'gascity.swarm.v1';
  bead_id: string;
  bead?: GasCityBead;
  mode?: BridgeMode;
  strategy?: Strategy;
  quorumRatio?: number;
  workers?: number;
  timeoutMs?: number;
  providers?: ProviderSpec[];
  instructions?: string;
}

export interface GasCityBridgeResult {
  ok: boolean;
  schema: 'gascity.swarm.result.v1';
  run_id: string;
  bead_id: string;
  mode: BridgeMode;
  status: BridgeStatus;
  consensus?: {
    winner: Record<string, unknown>;
    strategy: Strategy;
    agreement: number;
    agreed_count: number;
    total_responses: number;
    invalid_count: number;
    discarded_count: number;
    adjudicated: boolean;
  };
  metadata_written?: Record<string, string>;
  comb_path?: string;
  error?: string;
  timeout_count?: number;
}

export interface JsonCliResult {
  code: number;
  payload: Record<string, unknown>;
}
