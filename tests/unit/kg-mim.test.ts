// Tests: Advisory conflict uses Most Informative Merge (MIM)

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { KnowledgeGraph } from '../../src/kg/index';
import type { KGTriple } from '../../src/types/index';

const TEST_DB = path.join(os.tmpdir(), `nos-kg-mim-${Date.now()}.sqlite`);

let kg: KnowledgeGraph;

beforeAll(() => {
  kg = new KnowledgeGraph(TEST_DB);
});

afterAll(() => {
  kg.close();
  fs.rmSync(TEST_DB, { force: true });
});

function makeAdvisoryTriple(overrides: Partial<KGTriple>): KGTriple {
  return {
    subject: 'test_model',
    relation: 'preferred_for',
    object: 'task_type_A',
    valid_from: '2026-04-09',
    agent_id: 'polecat_01',
    metadata: { class: 'advisory' },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('KG addTriple and query', () => {
  it('adds a triple and queries it back', () => {
    const id = kg.addTriple(makeAdvisoryTriple({ subject: 'mim_model_1' }));
    expect(id).toBeGreaterThan(0);

    const results = kg.queryTriples('mim_model_1');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].relation).toBe('preferred_for');
  });

  it('invalidateTriple sets valid_to', () => {
    const id = kg.addTriple(makeAdvisoryTriple({ subject: 'inval_model' }));
    const ok = kg.invalidateTriple(id, '2026-04-10', 'test reason');
    expect(ok).toBe(true);

    // Should not appear in current queries (as_of today)
    const results = kg.queryTriples('inval_model', '2026-04-11');
    expect(results.length).toBe(0);
  });
});

describe('MIM conflict resolution for advisory triples', () => {
  it('prefers triple with more metadata fields', () => {
    const sparse: KGTriple = makeAdvisoryTriple({
      subject: 'llama-3.1-8b',
      valid_from: '2026-04-09',
      metadata: { class: 'advisory' },
      agent_id: 'polecat_01',
    });

    const rich: KGTriple = makeAdvisoryTriple({
      subject: 'llama-3.1-8b',
      valid_from: '2026-04-09',
      metadata: { class: 'advisory', note: 'fast', success_rate: 0.85, sample_size: 50 },
      agent_id: 'polecat_02',
    });

    const winner = kg.resolveConflict(sparse, rich);
    expect(winner.agent_id).toBe('polecat_02'); // rich has more metadata
  });

  it('prefers later valid_from when metadata counts equal', () => {
    const older: KGTriple = makeAdvisoryTriple({
      valid_from: '2026-04-01',
      metadata: { class: 'advisory', note: 'old' },
      agent_id: 'polecat_01',
    });
    const newer: KGTriple = makeAdvisoryTriple({
      valid_from: '2026-04-09',
      metadata: { class: 'advisory', note: 'new' },
      agent_id: 'polecat_02',
    });

    const winner = kg.resolveConflict(older, newer);
    expect(winner.valid_from).toBe('2026-04-09');
  });

  it('uses lexicographic object tiebreaker as last resort', () => {
    const base = {
      subject: 'llama-x',
      relation: 'preferred_for',
      valid_from: '2026-04-09',
      metadata: { class: 'advisory' as const },
      agent_id: 'polecat_01',
      created_at: new Date().toISOString(),
    };

    const tripleA: KGTriple = { ...base, object: 'task_alpha' };
    const tripleB: KGTriple = { ...base, object: 'task_zebra' };

    // Both have same metadata count, same valid_from
    const winner = kg.resolveConflict(tripleA, tripleB);
    // Lexicographically 'task_zebra' > 'task_alpha'
    expect(winner.object).toBe('task_zebra');
  });
});

describe('KG timeline', () => {
  it('returns full history including invalidated triples', () => {
    const id = kg.addTriple(makeAdvisoryTriple({ subject: 'timeline_model', valid_from: '2026-01-01' }));
    kg.invalidateTriple(id, '2026-02-01');
    kg.addTriple(makeAdvisoryTriple({ subject: 'timeline_model', valid_from: '2026-02-01', object: 'task_type_B' }));

    const timeline = kg.getTimeline('timeline_model');
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    // First entry should be the earliest
    expect(timeline[0].valid_from <= timeline[timeline.length - 1].valid_from).toBe(true);
  });
});

describe('KG state hash', () => {
  it('computes a state hash string', () => {
    const hash = kg.computeStateHash();
    expect(hash).toHaveLength(64); // sha256 hex
  });

  it('hash changes after adding a triple', () => {
    const hash1 = kg.computeStateHash();
    kg.addTriple(makeAdvisoryTriple({ subject: `new_model_${Date.now()}` }));
    const hash2 = kg.computeStateHash();
    expect(hash1).not.toBe(hash2);
  });
});
