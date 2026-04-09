// Tests: KG programmatic tools — kg_query, kg_insert, kg_traverse, kg_invalidate (Gate 4)

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { KnowledgeGraph } from '../../src/kg/index';
import { kgQuery, kgInsert, kgTraverse, kgInvalidate, kgTimeline } from '../../src/kg/tools';

const TEST_KG = path.join(os.tmpdir(), `nos-kg-tools-${Date.now()}.sqlite`);

let kg: KnowledgeGraph;

const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(() => {
  kg = new KnowledgeGraph(TEST_KG);

  // Seed some triples (critical relations require metadata.class per KNOWLEDGE_GRAPH.md §Consistency)
  kgInsert(kg, { subject: 'llama-3.1-8b', relation: 'locked_to', object: 'unit_test', agent_id: 'historian', metadata: { class: 'critical' } });
  kgInsert(kg, { subject: 'llama-3.1-8b', relation: 'succeeds_at', object: 'documentation', agent_id: 'historian' });
  kgInsert(kg, { subject: 'unit_test', relation: 'part_of', object: 'ci_pipeline', agent_id: 'witness' });
  kgInsert(kg, { subject: 'ci_pipeline', relation: 'blocks', object: 'deploy', agent_id: 'mayor' });
});

afterAll(() => {
  kg.close();
  fs.rmSync(TEST_KG, { force: true });
});

describe('kgQuery', () => {
  it('returns all triples for a subject', () => {
    const triples = kgQuery(kg, { subject: 'llama-3.1-8b' });
    expect(triples.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by relation', () => {
    const triples = kgQuery(kg, { subject: 'llama-3.1-8b', relation: 'locked_to' });
    expect(triples.length).toBe(1);
    expect(triples[0].object).toBe('unit_test');
  });

  it('returns empty for unknown subject', () => {
    const triples = kgQuery(kg, { subject: 'nonexistent-model-xyz' });
    expect(triples).toEqual([]);
  });

  it('respects as_of date filter', () => {
    // Insert a future triple
    kgInsert(kg, {
      subject: 'future-model',
      relation: 'locked_to',
      object: 'future_task',
      agent_id: 'historian',
      valid_from: '2099-01-01',
      metadata: { class: 'critical' },
    });

    const pastTriples = kgQuery(kg, { subject: 'future-model', as_of: TODAY });
    expect(pastTriples).toEqual([]); // not active today
  });
});

describe('kgInsert', () => {
  it('adds a triple that can be queried back', () => {
    kgInsert(kg, {
      subject: 'test-model-insert',
      relation: 'demoted_from',
      object: 'security_scan',
      agent_id: 'historian',
      metadata: { class: 'critical', success_rate: 0.3 },
    });

    const triples = kgQuery(kg, { subject: 'test-model-insert', relation: 'demoted_from' });
    expect(triples.length).toBe(1);
    expect(triples[0].object).toBe('security_scan');
    expect(triples[0].metadata?.['success_rate']).toBe(0.3);
  });

  it('defaults valid_from to today', () => {
    kgInsert(kg, { subject: 'today-test', relation: 'active', object: 'yes', agent_id: 'test' });
    const triples = kgQuery(kg, { subject: 'today-test' });
    expect(triples[0].valid_from).toBe(TODAY);
  });
});

describe('kgTraverse', () => {
  it('traverses from root following object edges', () => {
    // llama-3.1-8b → locked_to → unit_test → part_of → ci_pipeline → blocks → deploy
    const result = kgTraverse(kg, 'llama-3.1-8b', 3);

    const nodes = result.map((r) => r.node);
    expect(nodes).toContain('llama-3.1-8b');
    // Should reach unit_test (depth 1) via locked_to
    expect(nodes).toContain('unit_test');
  });

  it('respects maxDepth limit', () => {
    const result = kgTraverse(kg, 'llama-3.1-8b', 1);
    const depths = result.map((r) => r.depth);
    expect(Math.max(...depths)).toBeLessThanOrEqual(1);
  });

  it('does not visit same node twice', () => {
    const result = kgTraverse(kg, 'llama-3.1-8b', 5);
    const nodes = result.map((r) => r.node);
    const unique = new Set(nodes);
    expect(unique.size).toBe(nodes.length); // no duplicates
  });
});

describe('kgInvalidate', () => {
  it('invalidates a triple so it does not appear in future queries', () => {
    kgInsert(kg, {
      subject: 'to-invalidate',
      relation: 'locked_to',
      object: 'old_task',
      agent_id: 'historian',
      metadata: { class: 'critical' },
    });

    const before = kgQuery(kg, { subject: 'to-invalidate', relation: 'locked_to' });
    expect(before.length).toBe(1);

    const tripleId = before[0].id;
    if (tripleId !== undefined) {
      kgInvalidate(kg, tripleId, TODAY, 'test invalidation');
    }

    const after = kgQuery(kg, { subject: 'to-invalidate', relation: 'locked_to' });
    expect(after.length).toBe(0); // no longer active
  });
});

describe('kgTimeline', () => {
  it('returns full history including invalidated triples', () => {
    kgInsert(kg, { subject: 'history-subject', relation: 'state', object: 'v1', agent_id: 'test' });
    kgInsert(kg, { subject: 'history-subject', relation: 'state', object: 'v2', agent_id: 'test' });

    const timeline = kgTimeline(kg, 'history-subject');
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    // All entries have the correct subject
    expect(timeline.every((t) => t.subject === 'history-subject')).toBe(true);
  });
});
