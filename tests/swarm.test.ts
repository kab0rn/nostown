// Tests: swarm consensus resolver

import { resolveConsensus } from '../src/swarm/resolve';
import type { AgentResponse } from '../src/swarm/types';

function makeResponse(
  index: number,
  parsed: Record<string, unknown> | null,
  parseError: string | null = null,
): AgentResponse {
  return {
    agentIndex: index,
    raw: parsed !== null ? JSON.stringify(parsed) : '',
    parsed,
    parseError,
    latencyMs: 100,
  };
}

// ── majority ──────────────────────────────────────────────────────────────────

describe('majority strategy', () => {
  it('2 of 3 agents agree → winner is the majority response', () => {
    const winner = { answer: 42 };
    const responses: AgentResponse[] = [
      makeResponse(0, winner),
      makeResponse(1, winner),
      makeResponse(2, { answer: 99 }),
    ];

    const result = resolveConsensus(responses, 'majority');
    expect(result.winner).toEqual(winner);
    expect(result.agreement).toBeCloseTo(2 / 3);
    expect(result.strategy).toBe('majority');
    expect(result.responses).toHaveLength(3);
    expect(result.discarded).toHaveLength(1);
    expect(result.discarded[0].agentIndex).toBe(2);
  });

  it('all responses fail to parse → throws error', () => {
    const responses: AgentResponse[] = [
      makeResponse(0, null, 'agent[0] JSON parse failed'),
      makeResponse(1, null, 'agent[1] JSON parse failed'),
      makeResponse(2, null, 'agent[2] JSON parse failed'),
    ];

    expect(() => resolveConsensus(responses, 'majority')).toThrow(
      /All 3 agent responses failed to parse/,
    );
  });
});

// ── unanimous ─────────────────────────────────────────────────────────────────

describe('unanimous strategy', () => {
  it('all agents agree → passes with agreement 1.0', () => {
    const answer = { status: 'ok' };
    const responses: AgentResponse[] = [
      makeResponse(0, answer),
      makeResponse(1, answer),
      makeResponse(2, answer),
    ];

    const result = resolveConsensus(responses, 'unanimous');
    expect(result.winner).toEqual(answer);
    expect(result.agreement).toBe(1.0);
    expect(result.strategy).toBe('unanimous');
  });

  it('one agent disagrees → throws', () => {
    const responses: AgentResponse[] = [
      makeResponse(0, { status: 'ok' }),
      makeResponse(1, { status: 'ok' }),
      makeResponse(2, { status: 'error' }),
    ];

    expect(() => resolveConsensus(responses, 'unanimous')).toThrow(
      /unanimous strategy: agents disagreed/,
    );
  });
});

// ── first_quorum ──────────────────────────────────────────────────────────────

describe('first_quorum strategy', () => {
  it('agreement above threshold → passes', () => {
    const answer = { result: 'yes' };
    const responses: AgentResponse[] = [
      makeResponse(0, answer),
      makeResponse(1, answer),
      makeResponse(2, answer),
      makeResponse(3, { result: 'no' }),
      makeResponse(4, { result: 'no' }),
    ];

    // 3/5 = 0.6 — exactly at default threshold
    const result = resolveConsensus(responses, 'first_quorum', 0.6);
    expect(result.winner).toEqual(answer);
    expect(result.agreement).toBeCloseTo(3 / 5);
  });

  it('agreement below threshold → throws', () => {
    const responses: AgentResponse[] = [
      makeResponse(0, { result: 'yes' }),
      makeResponse(1, { result: 'yes' }),
      makeResponse(2, { result: 'no' }),
      makeResponse(3, { result: 'no' }),
      makeResponse(4, { result: 'maybe' }),
    ];

    // 2/5 = 40% — below 60% default threshold
    expect(() => resolveConsensus(responses, 'first_quorum', 0.6)).toThrow(
      /first_quorum:.*below.*threshold/,
    );
  });
});
