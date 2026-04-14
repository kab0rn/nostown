// Tests: Three polish gaps from gap analysis
//
// Gap 1: conv_seq crash-safety — getNextSeq() persists to KG without mutating seqCounters
// Gap 2: LOCKDOWN_LATE audit event for post-500ms background scan rejections
// Gap 3: hasActiveLockdown() task-class scoping + isPlaybookFresh() uses it

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content: '{"violations":[]}' } }] }) } },
  })),
}));

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { KnowledgeGraph } from '../../src/kg/index';
import { RoutingDispatcher } from '../../src/routing/dispatch';
import { SafeguardPool } from '../../src/roles/safeguard';
import { ConvoyBus } from '../../src/convoys/bus';

const TMP = path.join(os.tmpdir(), `nos-gap-fixes-${Date.now()}`);
const TEST_KG = path.join(TMP, 'gap-fixes.sqlite');
const TEST_AUDIT = path.join(TMP, 'audit', 'audit.jsonl');
const TEST_RIGS = path.join(TMP, 'rigs');

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  process.env.NOS_KG_PATH = TEST_KG;
  process.env.NOS_AUDIT_DIR = path.join(TMP, 'audit');
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── Gap 1: conv_seq crash-safety ─────────────────────────────────────────────

describe('Gap 1 — getNextSeq() crash-safety KG write', () => {
  it('getNextSeq does NOT mutate the in-memory seqCounter', () => {
    const kg = new KnowledgeGraph(TEST_KG);
    const bus = ConvoyBus.withKg('gap1-rig', kg);

    const seq1 = bus.getNextSeq('gap1-sender');
    const seq2 = bus.getNextSeq('gap1-sender');

    // Without in-memory mutation both calls see the same base (0) and return 1
    // This is intentional: send() is the commit point that increments the counter
    expect(seq1).toBe(1);
    expect(seq2).toBe(1);

    kg.close();
  });

  it('getNextSeq persists the allocated seq to KG', () => {
    const kg = new KnowledgeGraph(TEST_KG);
    const bus = ConvoyBus.withKg('gap1-persist-rig', kg);

    const senderId = 'gap1-persist-sender';
    bus.getNextSeq(senderId);

    const today = new Date().toISOString().slice(0, 10);
    const triples = kg.queryTriples('convoy_seq', today, 'last_seq')
      .filter((t) => t.object.startsWith(`${senderId}:`));

    expect(triples.length).toBeGreaterThan(0);
    expect(triples[0].object).toBe(`${senderId}:1`);

    kg.close();
  });

  it('after crash-recovery, seqCounters restore from KG to the allocated value', () => {
    const kg = new KnowledgeGraph(TEST_KG);
    const senderId = 'gap1-recovery-sender';

    // Simulate: getNextSeq allocated seq=5 before crash (KG write happened)
    const today = new Date().toISOString().slice(0, 10);
    kg.addTriple({
      subject: 'convoy_seq',
      relation: 'last_seq',
      object: `${senderId}:5`,
      valid_from: today,
      agent_id: senderId,
      metadata: { class: 'advisory' },
      created_at: new Date().toISOString(),
    });

    // New bus instance (simulates restart) — restoreSeqCounters reads from KG
    const bus2 = ConvoyBus.withKg('gap1-recovery-rig', kg);
    const nextSeq = bus2.getNextSeq(senderId);

    // Counter was restored to 5 from KG, so next allocation is 6 — no seq reuse
    expect(nextSeq).toBe(6);

    kg.close();
  });
});

// ── Gap 2: LOCKDOWN_LATE audit event ─────────────────────────────────────────

describe('Gap 2 — LOCKDOWN_LATE is a valid AuditEventType', () => {
  it('LOCKDOWN_LATE is accepted by auditLog without throwing (type union check)', () => {
    // If LOCKDOWN_LATE were removed from AuditEventType, TypeScript would catch it
    // at compile time (tsc --noEmit). This runtime test confirms no runtime rejection.
    const { auditLog } = require('../../src/hardening/audit');
    expect(() => {
      auditLog('LOCKDOWN_LATE', 'safeguard', 'bead-999', 'Late scan rejected bead after 500ms');
    }).not.toThrow();
  });

  it('LOCKDOWN_LATE entries are written to the audit file', () => {
    // AUDIT_DIR is a module-level const evaluated at import time, so read from the
    // default path the module actually uses (nos/audit/audit.jsonl relative to cwd).
    const { auditLog, readAuditLog: readLog } = require('../../src/hardening/audit');

    auditLog('LOCKDOWN_LATE', 'safeguard', 'bead-late-001', 'Post-500ms scan: lockdown_abc');

    // Read back from the same module's default path; audit log accumulates so check the tail
    const entries = readLog() as Array<{ event: string; actor: string; subject?: string }>;
    const lateEntries = entries.filter((e) => e.event === 'LOCKDOWN_LATE');
    expect(lateEntries.length).toBeGreaterThan(0);
    const last = lateEntries[lateEntries.length - 1];
    expect(last.actor).toBe('safeguard');
    expect(last.subject).toBe('bead-late-001');
  });
});

// ── Gap 3: hasActiveLockdown() task-class scoping ─────────────────────────────

describe('Gap 3 — hasActiveLockdown() task-class scoping', () => {
  let kg: KnowledgeGraph;

  beforeEach(() => {
    kg = new KnowledgeGraph(path.join(TMP, `gap3-${Date.now()}.sqlite`));
  });

  afterEach(() => {
    kg.close();
  });

  function writeLockdown(taskType?: string): void {
    const today = new Date().toISOString().slice(0, 10);
    const id = `lockdown_${Math.random().toString(36).slice(2, 8)}`;
    kg.addTriple({
      subject: id,
      relation: 'triggered_by',
      object: 'secret_hardcoded',
      valid_from: today,
      agent_id: 'safeguard_0',
      metadata: {
        class: 'critical',
        ...(taskType ? { task_type: taskType } : {}),
      },
      created_at: new Date().toISOString(),
    });
  }

  it('returns false when no lockdown exists', () => {
    expect(kg.hasActiveLockdown()).toBe(false);
    expect(kg.hasActiveLockdown('security')).toBe(false);
  });

  it('returns true for any taskType when a global lockdown (no task_type) exists', () => {
    writeLockdown(); // no task_type = global

    expect(kg.hasActiveLockdown('unit_test')).toBe(true);
    expect(kg.hasActiveLockdown('security')).toBe(true);
    expect(kg.hasActiveLockdown('auth')).toBe(true);
    expect(kg.hasActiveLockdown()).toBe(true);
  });

  it('returns true only for matching task class when task-scoped lockdown exists', () => {
    writeLockdown('security'); // scoped to 'security' tasks

    expect(kg.hasActiveLockdown('security')).toBe(true);
    expect(kg.hasActiveLockdown('unit_test')).toBe(false);
    expect(kg.hasActiveLockdown('documentation')).toBe(false);
    expect(kg.hasActiveLockdown('auth')).toBe(false);
  });

  it('unscoped call returns true when any lockdown (even task-scoped) exists', () => {
    writeLockdown('security');

    // Called with no taskType → "any lockdown" → true
    expect(kg.hasActiveLockdown()).toBe(true);
  });

  it('handles multiple lockdowns: matches any relevant one', () => {
    writeLockdown('security');
    writeLockdown('auth');

    expect(kg.hasActiveLockdown('security')).toBe(true);
    expect(kg.hasActiveLockdown('auth')).toBe(true);
    expect(kg.hasActiveLockdown('unit_test')).toBe(false);
  });
});

// ── Gap 3b: isPlaybookFresh() uses task-class scoping ────────────────────────

describe('Gap 3b — isPlaybookFresh() passes taskType to hasActiveLockdown()', () => {
  it('does not suppress unrelated playbooks during a task-scoped lockdown', () => {
    const kg = new KnowledgeGraph(path.join(TMP, `gap3b-${Date.now()}.sqlite`));
    const dispatcher = new RoutingDispatcher(kg);
    const today = new Date().toISOString().slice(0, 10);

    // Trigger a 'security' lockdown
    kg.addTriple({
      subject: 'lockdown_gap3b_test',
      relation: 'triggered_by',
      object: 'secret_hardcoded',
      valid_from: today,
      agent_id: 'safeguard_0',
      metadata: { class: 'critical', task_type: 'security' },
      created_at: new Date().toISOString(),
    });

    // 'unit_test' playbook should NOT be suppressed by a 'security' lockdown
    expect(dispatcher.isPlaybookFresh(0.95, 25, 'unit_test')).toBe(true);

    // 'security' playbook SHOULD be suppressed
    expect(dispatcher.isPlaybookFresh(0.95, 25, 'security')).toBe(false);

    kg.close();
  });

  it('suppresses all playbooks when a global lockdown exists', () => {
    const kg = new KnowledgeGraph(path.join(TMP, `gap3b2-${Date.now()}.sqlite`));
    const dispatcher = new RoutingDispatcher(kg);
    const today = new Date().toISOString().slice(0, 10);

    // Global lockdown (no task_type)
    kg.addTriple({
      subject: 'lockdown_gap3b_global',
      relation: 'triggered_by',
      object: 'private_key_pattern',
      valid_from: today,
      agent_id: 'safeguard_0',
      metadata: { class: 'critical' },
      created_at: new Date().toISOString(),
    });

    expect(dispatcher.isPlaybookFresh(0.95, 25, 'unit_test')).toBe(false);
    expect(dispatcher.isPlaybookFresh(0.95, 25, 'security')).toBe(false);
    expect(dispatcher.isPlaybookFresh(0.95, 25, 'documentation')).toBe(false);

    kg.close();
  });
});

// ── Gap 3c: Safeguard stores task_type in lockdown KG triple ─────────────────

describe('Gap 3c — SafeguardPool passes taskType to lockdown KG triple', () => {
  it('lockdown KG triple contains task_type when scan is called with taskType', async () => {
    const kgPath = path.join(TMP, `gap3c-${Date.now()}.sqlite`);
    const pool = new SafeguardPool({ poolSize: 2, kgPath });

    const diff = `+const apiKey = 'sk-1234567890abcdefghij';`;
    const result = await pool.scan(diff, 0, 'security');

    expect(result.lockdown).toBeDefined();
    const lockdownId = result.lockdown!.lockdown_id;

    const kg = new KnowledgeGraph(kgPath);
    const today = new Date().toISOString().slice(0, 10);
    const triples = kg.queryEntity(lockdownId, today);
    const lockdownTriple = triples.find((t) => t.relation === 'triggered_by');

    expect(lockdownTriple).toBeDefined();
    expect((lockdownTriple!.metadata as Record<string, unknown>)?.task_type).toBe('security');

    kg.close();
    pool.close();
  });

  it('lockdown KG triple has no task_type when scan is called without taskType', async () => {
    const kgPath = path.join(TMP, `gap3c2-${Date.now()}.sqlite`);
    const pool = new SafeguardPool({ poolSize: 2, kgPath });

    const diff = `+const apiKey = 'sk-1234567890abcdefghij';`;
    const result = await pool.scan(diff); // no taskType

    expect(result.lockdown).toBeDefined();
    const lockdownId = result.lockdown!.lockdown_id;

    const kg = new KnowledgeGraph(kgPath);
    const today = new Date().toISOString().slice(0, 10);
    const triples = kg.queryEntity(lockdownId, today);
    const lockdownTriple = triples.find((t) => t.relation === 'triggered_by');

    expect(lockdownTriple).toBeDefined();
    expect((lockdownTriple!.metadata as Record<string, unknown>)?.task_type).toBeUndefined();

    kg.close();
    pool.close();
  });
});
