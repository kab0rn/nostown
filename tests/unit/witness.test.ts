// Unit tests for the Witness agent — isolated (no real Groq / MemPalace calls)
// Covers: single-judge review, 3-judge council (critical), majority logic,
// diary context injection, KG triple write, judge failure fallback.

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

// --- mock MemPalaceClient ---
const mockDiaryRead = jest.fn<(wing: string, limit: number) => Promise<Array<{ content: string }>>>();
const mockDiaryWrite = jest.fn<(wing: string, entry: string) => Promise<void>>();
const mockAddDrawer = jest.fn<() => Promise<void>>();
jest.mock('../../src/mempalace/client.js', () => ({
  __esModule: true,
  MemPalaceClient: jest.fn().mockImplementation(() => ({
    diaryRead: mockDiaryRead,
    diaryWrite: mockDiaryWrite,
    addDrawer: mockAddDrawer,
  })),
}));

import { Witness } from '../../src/roles/witness.js';
import { KnowledgeGraph } from '../../src/kg/index.js';

let kgPath: string;

beforeEach(() => {
  kgPath = path.join(os.tmpdir(), `witness_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`);
  mockExecuteInference.mockReset();
  mockDiaryRead.mockReset();
  mockDiaryWrite.mockReset();
  mockAddDrawer.mockReset();
  mockDiaryRead.mockResolvedValue([]);
  mockDiaryWrite.mockResolvedValue(undefined);
  mockAddDrawer.mockResolvedValue(undefined);
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

describe('Witness.review() — diary context', () => {
  test('reads diary before reviewing and injects prior context into prompt', async () => {
    mockDiaryRead.mockResolvedValue([
      { content: 'PR pr-008: REJECTED (0/1) — Missing null check' },
    ]);
    mockExecuteInference.mockResolvedValue(approveResponse());

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-008');
    w.close();

    const callArgs = mockExecuteInference.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = callArgs.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('Previous reviews for this PR');
    expect(userMsg).toContain('Missing null check');
  });

  test('proceeds without diary context if palace unavailable (non-fatal)', async () => {
    mockDiaryRead.mockRejectedValue(new Error('Palace offline'));
    mockExecuteInference.mockResolvedValue(approveResponse());

    const w = makeWitness();
    const verdict = await w.review('diff', 'req', 'pr-009');
    w.close();

    expect(verdict.approved).toBe(true);
  });

  test('writes diary entry after review', async () => {
    mockExecuteInference.mockResolvedValue(approveResponse());

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-010');
    w.close();

    expect(mockDiaryWrite).toHaveBeenCalledWith(
      'wing_witness',
      expect.stringContaining('pr-010'),
    );
  });

  test('diary entry includes APPROVED/REJECTED and score', async () => {
    mockExecuteInference.mockResolvedValue(rejectResponse('Security issue'));

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-011');
    w.close();

    const diaryEntry = mockDiaryWrite.mock.calls[0][1];
    expect(diaryEntry).toContain('REJECTED');
    expect(diaryEntry).toContain('0/1');
  });
});

describe('Witness.review() — KG triple and MemPalace write', () => {
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

  test('writes hall_events drawer to MemPalace', async () => {
    mockExecuteInference.mockResolvedValue(approveResponse());

    const w = makeWitness();
    await w.review('diff', 'req', 'pr-014');
    w.close();

    expect(mockAddDrawer).toHaveBeenCalledWith(
      'wing_rig_test-rig',
      'hall_events',
      'witness_pr-014',
      expect.stringContaining('"pr_id":"pr-014"'),
      expect.stringContaining('pr-014'),
    );
  });

  test('continues if MemPalace drawer write fails (non-fatal)', async () => {
    mockExecuteInference.mockResolvedValue(approveResponse());
    mockAddDrawer.mockRejectedValue(new Error('Palace write failed'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const w = makeWitness();
    const verdict = await w.review('diff', 'req', 'pr-015');
    w.close();

    expect(verdict.approved).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MemPalace write failed'));

    warnSpy.mockRestore();
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
