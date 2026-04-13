// Unit tests for the Witness agent — isolated (no real Groq calls)
// Covers: single-judge review, 3-judge council (critical), majority logic,
// KG triple write, judge failure fallback.

import { jest } from '@jest/globals';
import path from 'path';
import os from 'os';
import fs from 'fs';

// --- mock GroqProvider ---
const mockExecuteInference = jest.fn<(params: unknown) => Promise<string>>();
jest.mock('../../src/groq/provider.js', () => ({
  __esModule: true,
  GroqProvider: jest.fn().mockImplementation(() => ({
    executeInference: mockExecuteInference,
  })),
}));

import { Witness } from '../../src/roles/witness.js';
import { KnowledgeGraph } from '../../src/kg/index.js';

let kgPath: string;

beforeEach(() => {
  kgPath = path.join(os.tmpdir(), `witness_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`);
  mockExecuteInference.mockReset();
});

afterEach(() => {
  try { fs.unlinkSync(kgPath); } catch { /* ignore */ }
});

function makeWitness(agentId = 'witness_01') {
  return new Witness({ agentId, rigName: 'test-rig', kgPath });
}

function approveResponse(comment = 'LGTM') {
  return JSON.stringify({ approved: true, score: 9, comment });
}

function rejectResponse(comment = 'Has bugs') {
  return JSON.stringify({ approved: false, score: 3, comment });
}

describe('Witness.review() — single judge (non-critical)', () => {
  test('returns approved verdict when judge approves', async () => {
    mockExecuteInference.mockResolvedValue(approveResponse('Looks correct'));

    const w = makeWitness();
    const verdict = await w.review('diff content', 'requirement text', 'pr-001');
    w.close();

    expect(verdict.approved).toBe(true);
    expect(verdict.score).toBe('1/1');
    expect(verdict.votes).toHaveLength(1);
    expect(verdict.votes[0].approved).toBe(true);
  });

  test('returns rejected verdict when judge rejects', async () => {
    mockExecuteInference.mockResolvedValue(rejectResponse('Missing error handling'));

    const w = makeWitness();
    const verdict = await w.review('diff content', 'requirement text', 'pr-002');
    w.close();

    expect(verdict.approved).toBe(false);
    expect(verdict.score).toBe('0/1');
    expect(verdict.reason).toContain('Missing error handling');
  });

  test('uses 1 judge for non-critical reviews', async () => {
    mockExecuteInference.mockResolvedValue(approveResponse());

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-003', false);
    w.close();

    expect(mockExecuteInference).toHaveBeenCalledTimes(1);
  });
});

describe('Witness.review() — 3-judge council (critical)', () => {
  test('uses 3 judges for critical reviews', async () => {
    mockExecuteInference.mockResolvedValue(approveResponse());

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-004', true);
    w.close();

    expect(mockExecuteInference).toHaveBeenCalledTimes(3);
  });

  test('majority 2/3 approves', async () => {
    mockExecuteInference
      .mockResolvedValueOnce(approveResponse('Good'))
      .mockResolvedValueOnce(approveResponse('Fine'))
      .mockResolvedValueOnce(rejectResponse('Risky'));

    const w = makeWitness();
    const verdict = await w.review('diff', 'req', 'pr-005', true);
    w.close();

    expect(verdict.approved).toBe(true);
    expect(verdict.score).toBe('2/3');
    expect(verdict.votes).toHaveLength(3);
  });

  test('minority 1/3 rejects', async () => {
    mockExecuteInference
      .mockResolvedValueOnce(approveResponse('OK'))
      .mockResolvedValueOnce(rejectResponse('Injection risk'))
      .mockResolvedValueOnce(rejectResponse('Hardcoded secret'));

    const w = makeWitness();
    const verdict = await w.review('diff', 'req', 'pr-006', true);
    w.close();

    expect(verdict.approved).toBe(false);
    expect(verdict.score).toBe('1/3');
  });

  test('unanimous 0/3 rejects', async () => {
    mockExecuteInference.mockResolvedValue(rejectResponse('Bad'));

    const w = makeWitness();
    const verdict = await w.review('diff', 'req', 'pr-007', true);
    w.close();

    expect(verdict.approved).toBe(false);
    expect(verdict.score).toBe('0/3');
  });
});

describe('Witness.review() — KG triple write', () => {
  test('writes KG triple with approved relation on approval', async () => {
    mockExecuteInference.mockResolvedValue(approveResponse());

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-012');
    w.close();

    const kg = new KnowledgeGraph(kgPath);
    const triples = kg.queryTriples('', undefined, 'approved');
    // Query by relation only — need to scan all
    const all = kg.getTimeline('test-rig-pr-012');
    kg.close();

    const approved = all.filter((t) => t.relation === 'approved');
    expect(approved).toHaveLength(1);
    expect(approved[0].object).toBe('test-rig-pr-012');
  });

  test('writes KG triple with rejected relation on rejection', async () => {
    mockExecuteInference.mockResolvedValue(rejectResponse());

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-013');
    w.close();

    const kg = new KnowledgeGraph(kgPath);
    const all = kg.getTimeline('test-rig-pr-013');
    kg.close();

    const rejected = all.filter((t) => t.relation === 'rejected');
    expect(rejected).toHaveLength(1);
  });

});

describe('Witness.review() — judge failure handling', () => {
  test('judge failure returns rejected vote (non-fatal, false approval)', async () => {
    mockExecuteInference.mockRejectedValue(new Error('Groq timeout'));

    const w = makeWitness();
    const verdict = await w.review('diff', 'req', 'pr-016');
    w.close();

    expect(verdict.approved).toBe(false);
    expect(verdict.votes[0].comment).toContain('Judge failed');
  });

  test('partial judge failure in 3-judge: surviving approvals count', async () => {
    mockExecuteInference
      .mockResolvedValueOnce(approveResponse('Good'))
      .mockRejectedValueOnce(new Error('Judge 2 failed'))
      .mockResolvedValueOnce(approveResponse('Also good'));

    const w = makeWitness();
    const verdict = await w.review('diff', 'req', 'pr-017', true);
    w.close();

    // 2 approved, 1 rejected (due to failure) → majority approves
    expect(verdict.approved).toBe(true);
    expect(verdict.score).toBe('2/3');
  });
});

describe('Witness.review() — parallel execution (ROLES.md §Witness critical PRs)', () => {
  test('critical review fires all 3 judges concurrently via Promise.all', async () => {
    // Verify all 3 inference calls are inflight before any resolves.
    // We use a shared counter incremented on entry and a Promise that waits
    // until all 3 are active before any resolves.
    let inflight = 0;
    let maxInflight = 0;
    let resolveAll: () => void;
    const allStarted = new Promise<void>((r) => { resolveAll = r; });

    mockExecuteInference.mockImplementation(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      if (inflight >= 3) resolveAll();
      await allStarted;
      inflight--;
      return approveResponse('concurrent');
    });

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-parallel-001', true);
    w.close();

    // All 3 judges were inflight simultaneously
    expect(maxInflight).toBe(3);
  });

  test('non-critical review runs judges sequentially (single call)', async () => {
    mockExecuteInference.mockResolvedValue(approveResponse());

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-parallel-002', false);
    w.close();

    expect(mockExecuteInference).toHaveBeenCalledTimes(1);
  });
});

describe('Witness.review() — per-judge KG vote logging (ROLES.md §Quality Tuning)', () => {
  test('writes per-judge KG triples for critical reviews', async () => {
    mockExecuteInference
      .mockResolvedValueOnce(approveResponse('Judge 0 says yes'))
      .mockResolvedValueOnce(approveResponse('Judge 1 says yes'))
      .mockResolvedValueOnce(rejectResponse('Judge 2 says no'));

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-kg-001', true);
    w.close();

    const kg = new KnowledgeGraph(kgPath);
    // Query per-judge triples by checking each expected judge subject
    const witness = makeWitness(); // just to get agentId pattern
    const today = new Date().toISOString().slice(0, 10);
    const judgeTriples = [];
    for (let i = 0; i < 3; i++) {
      const subject = `witness_judge_witness_01_judge_${i}`;
      const triples = kg.queryTriples(subject, today);
      judgeTriples.push(...triples.filter((t) => t.object === 'test-rig-pr-kg-001'));
    }
    witness.close();
    kg.close();

    expect(judgeTriples).toHaveLength(3);
    // 2 approved, 1 rejected per-judge
    const approvedJudges = judgeTriples.filter((t) => t.relation === 'approved');
    const rejectedJudges = judgeTriples.filter((t) => t.relation === 'rejected');
    expect(approvedJudges).toHaveLength(2);
    expect(rejectedJudges).toHaveLength(1);
  });

  test('does NOT write per-judge KG triples for non-critical reviews', async () => {
    mockExecuteInference.mockResolvedValue(approveResponse());

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-kg-002', false);
    w.close();

    const kg = new KnowledgeGraph(kgPath);
    const today = new Date().toISOString().slice(0, 10);
    // Check that no per-judge triple exists for judge_0 (only one judge in non-critical)
    const judgeTriples = kg.queryTriples('witness_judge_witness_01_judge_0', today);
    kg.close();

    expect(judgeTriples).toHaveLength(0);
  });
});

