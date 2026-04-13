// Tests for Refinery agent
// Covers: analyze() happy path, hall_facts write, KG triple write, error resilience

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

import { Refinery } from '../../src/roles/refinery.js';
import { KnowledgeGraph } from '../../src/kg/index.js';

let kgPath: string;
let kg: KnowledgeGraph;

beforeEach(() => {
  kgPath = path.join(os.tmpdir(), `refinery_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`);
  kg = new KnowledgeGraph(kgPath);
  mockExecuteInference.mockReset();
});

afterEach(() => {
  kg.close();
  try { fs.unlinkSync(kgPath); } catch { /* ignore */ }
});

function makeRefinery(agentId = 'refinery_01') {
  return new Refinery({
    agentId,
    rigName: 'test_rig',
    kgPath,
  });
}

const GOOD_RESPONSE = JSON.stringify({
  root_cause: 'Circular dependency between modules A and B',
  recommended_approach: 'Extract shared interface into a separate module C',
  confidence_level: 'high',
  follow_up_beads: ['Create module C', 'Update A to import C', 'Update B to import C'],
});

describe('Refinery.analyze()', () => {
  test('returns RefineryAnalysis with parsed fields', async () => {
    mockExecuteInference.mockResolvedValue(GOOD_RESPONSE);

    const refinery = makeRefinery();
    const analysis = await refinery.analyze(
      'Fix circular dependency in auth module',
      'architecture',
      { witnessReason: 'Circular import detected', attempts: 2 },
    );
    refinery.close();

    expect(analysis.taskType).toBe('architecture');
    expect(analysis.rootCause).toBe('Circular dependency between modules A and B');
    expect(analysis.recommendedApproach).toBe('Extract shared interface into a separate module C');
    expect(analysis.confidenceLevel).toBe('high');
    expect(analysis.followUpBeads).toEqual([
      'Create module C',
      'Update A to import C',
      'Update B to import C',
    ]);
    expect(analysis.id).toHaveLength(8);
    expect(analysis.createdAt).toBeTruthy();
  });

  test('writes KG triple with architectural_decision relation', async () => {
    mockExecuteInference.mockResolvedValue(GOOD_RESPONSE);

    const refinery = makeRefinery();
    const analysis = await refinery.analyze(
      'Fix circular dependency in auth module',
      'architecture',
      { witnessReason: 'Circular import detected', attempts: 2 },
    );
    refinery.close();

    // Verify KG triple was written
    const kg2 = new KnowledgeGraph(kgPath);
    const triples = kg2.queryTriples('architecture', undefined, 'architectural_decision');
    kg2.close();

    expect(triples).toHaveLength(1);
    expect(triples[0].object).toBe(`refinery_${analysis.id}`);
    expect(triples[0].metadata?.class).toBe('advisory');
    expect(triples[0].metadata?.confidence).toBe('high');
  });

  test('includes diff and errorDetail in inference prompt when provided', async () => {
    mockExecuteInference.mockResolvedValue(GOOD_RESPONSE);

    const refinery = makeRefinery();
    await refinery.analyze(
      'Fix auth module',
      'security',
      {
        witnessReason: 'Injection vulnerability',
        attempts: 3,
        diff: '-const query = `SELECT * FROM users WHERE id = ${id}`',
        errorDetail: 'SQL injection detected at line 42',
      },
    );
    refinery.close();

    const callArg = mockExecuteInference.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const userMessage = callArg.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('Rejected diff');
    expect(userMessage).toContain('SQL injection detected');
  });

  test('trims diff to 3000 chars in prompt', async () => {
    mockExecuteInference.mockResolvedValue(GOOD_RESPONSE);
    const longDiff = 'x'.repeat(5000);

    const refinery = makeRefinery();
    await refinery.analyze('task', 'architecture', {
      witnessReason: 'too big',
      attempts: 1,
      diff: longDiff,
    });
    refinery.close();

    const callArg = mockExecuteInference.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const userMessage = callArg.messages.find((m) => m.role === 'user')?.content ?? '';
    // diff is sliced at 3000, but the prompt adds "Rejected diff (truncated):\n" prefix
    expect(userMessage).not.toContain('x'.repeat(3001));
  });

  test('defaults confidenceLevel to low for unknown values', async () => {
    mockExecuteInference.mockResolvedValue(JSON.stringify({
      root_cause: 'unknown',
      recommended_approach: 'try harder',
      confidence_level: 'very_sure',  // not a valid enum
      follow_up_beads: [],
    }));

    const refinery = makeRefinery();
    const analysis = await refinery.analyze('task', 'security', { witnessReason: 'fail', attempts: 1 });
    refinery.close();

    expect(analysis.confidenceLevel).toBe('low');
  });

  test('handles missing fields in LLM response gracefully', async () => {
    mockExecuteInference.mockResolvedValue(JSON.stringify({}));

    const refinery = makeRefinery();
    const analysis = await refinery.analyze('task', 'architecture', { witnessReason: 'fail', attempts: 1 });
    refinery.close();

    expect(analysis.rootCause).toBe('unknown');
    expect(analysis.recommendedApproach).toBe('');
    expect(analysis.confidenceLevel).toBe('low');
    expect(analysis.followUpBeads).toEqual([]);
  });

  test('uses groq/compound model for inference', async () => {
    mockExecuteInference.mockResolvedValue(GOOD_RESPONSE);

    const refinery = makeRefinery();
    await refinery.analyze('task', 'architecture', { witnessReason: 'fail', attempts: 1 });
    refinery.close();

    const callArg = mockExecuteInference.mock.calls[0][0] as { model: string };
    expect(callArg.model).toBe('groq/compound');
  });
});
