export interface AgentResponse {
  agentIndex: number;
  raw: string;
  parsed: Record<string, unknown> | null;
  parseError: string | null;
  latencyMs: number;
}

export interface ConsensusResult {
  winner: Record<string, unknown>;
  strategy: Strategy;
  agreement: number;        // 0.0 - 1.0 fraction of agents that agreed
  responses: AgentResponse[];
  discarded: AgentResponse[];
}

export type Strategy = 'majority' | 'unanimous' | 'first_quorum';

export interface SwarmConfig {
  n: number;
  strategy: Strategy;
  quorumRatio?: number;     // used by first_quorum, default 0.6
}

// SlingParams mirrors gastownhall/gastown SlingParams (JSON-compatible subset).
export interface SlingParams {
  bead_id: string;
  agent: string;
  swarm_config: SwarmConfig;
  [key: string]: unknown;   // pass-through for fields nostown doesn't need to inspect
}

// SlingResult mirrors gastownhall/gastown SlingResult.
export interface SlingResult {
  polecat_name?: string;
  consensus_result?: ConsensusResult;
  error?: string;
}
