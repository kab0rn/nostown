// Tests: Critical conflict uses role precedence

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { KnowledgeGraph } from '../../src/kg/index';
import type { KGTriple } from '../../src/types/index';

const TEST_DB = path.join(os.tmpdir(), `nos-kg-critical-${Date.now()}.sqlite`);

let kg: KnowledgeGraph;

beforeAll(() => {
  kg = new KnowledgeGraph(TEST_DB);
});

afterAll(() => {
  kg.close();
  fs.rmSync(TEST_DB, { force: true });
});

function makeCriticalTriple(
  agentId: string,
  overrides: Partial<KGTriple> = {},
): KGTriple {
  return {
    subject: 'room_auth-migration',
    relation: 'owned_by',
    object: agentId,
    valid_from: '2026-04-09',
    agent_id: agentId,
    metadata: { class: 'critical' as const },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Critical conflict resolution — role precedence', () => {
  // Role precedence: historian(5) > mayor(4) > witness(3) > safeguard(2) > polecat(1)

  it('historian beats mayor', () => {
    const mayor = makeCriticalTriple('mayor_01', { object: 'mayor_01' });
    const historian = makeCriticalTriple('historian_01', { object: 'historian_01' });
    const winner = kg.resolveConflict(mayor, historian);
    expect(winner.agent_id).toBe('historian_01');
  });

  it('mayor beats polecat', () => {
    const mayor = makeCriticalTriple('mayor_01', { object: 'mayor_01' });
    const polecat = makeCriticalTriple('polecat_01', { object: 'polecat_01' });
    const winner = kg.resolveConflict(mayor, polecat);
    expect(winner.agent_id).toBe('mayor_01');
  });

  it('mayor beats witness', () => {
    const mayor = makeCriticalTriple('mayor_01', { object: 'mayor_01' });
    const witness = makeCriticalTriple('witness_01', { object: 'witness_01' });
    const winner = kg.resolveConflict(mayor, witness);
    expect(winner.agent_id).toBe('mayor_01');
  });

  it('historian beats all other roles', () => {
    const roles = ['mayor_01', 'witness_01', 'safeguard_01', 'polecat_01'];
    for (const roleId of roles) {
      const historian = makeCriticalTriple('historian_01', { object: 'historian_01' });
      const other = makeCriticalTriple(roleId, { object: roleId });
      const winner = kg.resolveConflict(historian, other);
      expect(winner.agent_id).toBe('historian_01');
    }
  });

  it('later valid_from wins when roles have same precedence', () => {
    // Two different mayor instances
    const older = makeCriticalTriple('mayor_01', {
      valid_from: '2026-04-01',
      object: 'mayor_01',
    });
    const newer = makeCriticalTriple('mayor_02', {
      valid_from: '2026-04-09',
      object: 'mayor_02',
    });
    const winner = kg.resolveConflict(older, newer);
    expect(winner.valid_from).toBe('2026-04-09');
  });

  it('does NOT use metadata field count to break critical ties', () => {
    // Polecat has MORE metadata but Mayor has higher precedence
    const mayor = makeCriticalTriple('mayor_01', {
      metadata: { class: 'critical' as const }, // sparse
      object: 'mayor_01',
    });
    const polecat = makeCriticalTriple('polecat_01', {
      metadata: {
        class: 'critical' as const,
        note: 'detailed',
        extra1: 'a',
        extra2: 'b',
        extra3: 'c',
      }, // rich
      object: 'polecat_01',
    });
    // Mayor should still win despite having fewer metadata fields
    const winner = kg.resolveConflict(mayor, polecat);
    expect(winner.agent_id).toBe('mayor_01');
  });
});

describe('Historical triples are append-only', () => {
  it('historical triple resolveConflict returns first triple (no overwrite)', () => {
    const t1: KGTriple = {
      subject: 'audit_event_1',
      relation: 'occurred_at',
      object: '2026-04-01',
      valid_from: '2026-04-01',
      agent_id: 'mayor_01',
      metadata: { class: 'historical' as const },
      created_at: new Date().toISOString(),
    };
    const t2: KGTriple = {
      ...t1,
      object: '2026-04-09',
      valid_from: '2026-04-09',
      agent_id: 'historian_01',
    };

    // Historical: both should coexist (resolveConflict returns the first)
    const result = kg.resolveConflict(t1, t2);
    expect(result).toBe(t1); // first triple is returned
  });
});
