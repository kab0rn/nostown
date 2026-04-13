// Integration: Mayor → Refinery escalation path (ROLES.md §Refinery)
// Validates that Mayor.escalateToRefinery() fires under the correct conditions:
//   - Witness unanimous rejection + attempts >= 2 (any task type)
//   - Witness rejection on architecture/security task (immediate escalation)
// Also verifies REFINERY_ESCALATION audit event and KG triple write.

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Mayor } from '../../src/roles/mayor';
import { Refinery } from '../../src/roles/refinery';
import { KnowledgeGraph } from '../../src/kg/index';
import type { Bead, ReviewVerdict } from '../../src/types/index';
import { Ledger } from '../../src/ledger/index';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('groq-sdk', () => {
  const mockCreate = jest.fn();
  (globalThis as Record<string, unknown>).__refineryEscMock = mockCreate;
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    })),
  };
});

function getMock(): jest.Mock {
  return (globalThis as Record<string, unknown>).__refineryEscMock as jest.Mock;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_KG = path.join(os.tmpdir(), `refinery-esc-${Date.now()}.sqlite`);
const TEST_RIGS = path.join(os.tmpdir(), `refinery-esc-rigs-${Date.now()}`);

function makeRejectedVerdict(score = '0/3'): ReviewVerdict {
  return {
    approved: false,
    score,
    reason: 'Circular dependency unresolved',
    votes: [
      { judge_id: 'j1', approved: false, comment: 'Still broken' },
      { judge_id: 'j2', approved: false, comment: 'Same issue' },
      { judge_id: 'j3', approved: false, comment: 'No improvement' },
    ],
  };
}

function makeApprovedVerdict(): ReviewVerdict {
  return {
    approved: true,
    score: '3/3',
    reason: 'All good',
    votes: [{ judge_id: 'j1', approved: true }],
  };
}

function makeBead(taskType: string): Bead {
  return Ledger.createBead({
    role: 'polecat',
    task_type: taskType,
    task_description: `Fix ${taskType} problem`,
    model: 'test-model',
    rig: 'test-rig',
    status: 'done',
    outcome: 'FAILURE',
    plan_checkpoint_id: 'ckpt-ref-001',
  });
}

const REFINERY_RESPONSE = JSON.stringify({
  root_cause: 'Circular import between auth and session modules',
  recommended_approach: 'Extract shared types to a neutral module',
  confidence_level: 'high',
  follow_up_beads: ['Create types.ts', 'Update auth.ts imports'],
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Mayor.escalateToRefinery() — escalation conditions (ROLES.md §Refinery)', () => {
  let kg: KnowledgeGraph;
  let mayor: Mayor;
  let refinery: Refinery;

  beforeEach(() => {
    fs.mkdirSync(TEST_RIGS, { recursive: true });
    process.env.NOS_RIGS_ROOT = TEST_RIGS;
    getMock().mockReset();

    kg = new KnowledgeGraph(TEST_KG);
    refinery = new Refinery({ agentId: 'refinery_01', rigName: 'test-rig', kgPath: TEST_KG });
    mayor = new Mayor({
      agentId: 'mayor_ref_test',
      rigName: 'test-rig',
      groqApiKey: 'test-key',
      kgPath: TEST_KG,
      refinery,
    });
  });

  afterEach(() => {
    mayor.close();
    kg.close();
    fs.rmSync(TEST_KG, { force: true });
    fs.rmSync(TEST_RIGS, { recursive: true, force: true });
    delete process.env.NOS_RIGS_ROOT;
  });

  it('returns null when no Refinery is configured', async () => {
    const mayorNoRef = new Mayor({ agentId: 'mayor_bare', rigName: 'test-rig', kgPath: TEST_KG });
    const result = await mayorNoRef.escalateToRefinery(makeBead('implement'), makeRejectedVerdict(), 3);
    mayorNoRef.close();
    expect(result).toBeNull();
  });

  it('returns null when verdict is approved (no escalation on success)', async () => {
    const result = await mayor.escalateToRefinery(makeBead('implement'), makeApprovedVerdict(), 5);
    expect(result).toBeNull();
    expect(getMock()).not.toHaveBeenCalled();
  });

  it('returns null when attempts < 2 and task_type is not architecture/security', async () => {
    const result = await mayor.escalateToRefinery(makeBead('implement'), makeRejectedVerdict(), 1);
    expect(result).toBeNull();
    expect(getMock()).not.toHaveBeenCalled();
  });

  it('escalates immediately (attempts=1) for architecture task type', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: REFINERY_RESPONSE } }] });
    // Also mock the palace search inside Refinery (second Groq call is for Refinery itself)
    getMock()
      .mockResolvedValueOnce({ choices: [{ message: { content: REFINERY_RESPONSE } }] });

    const result = await mayor.escalateToRefinery(makeBead('architecture'), makeRejectedVerdict(), 1);
    expect(result).not.toBeNull();
    expect(result?.rootCause).toBe('Circular import between auth and session modules');
  });

  it('escalates immediately (attempts=1) for security task type', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: REFINERY_RESPONSE } }] });

    const result = await mayor.escalateToRefinery(makeBead('security'), makeRejectedVerdict(), 1);
    expect(result).not.toBeNull();
    expect(result?.recommendedApproach).toContain('Extract shared types');
  });

  it('escalates after 2 attempts for any task type (implement)', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: REFINERY_RESPONSE } }] });

    const result = await mayor.escalateToRefinery(makeBead('implement'), makeRejectedVerdict(), 2);
    expect(result).not.toBeNull();
    expect(result?.confidenceLevel).toBe('high');
  });

  it('escalates after 5 attempts for a low-risk task type (documentation)', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: REFINERY_RESPONSE } }] });

    const result = await mayor.escalateToRefinery(makeBead('documentation'), makeRejectedVerdict(), 5);
    expect(result).not.toBeNull();
    expect(result?.followUpBeads).toContain('Create types.ts');
  });

  it('stores architectural_decision KG triple on escalation', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: REFINERY_RESPONSE } }] });

    const bead = makeBead('architecture');
    const result = await mayor.escalateToRefinery(bead, makeRejectedVerdict(), 1);
    expect(result).not.toBeNull();

    // Verify KG triple written by Refinery.persistAnalysis()
    const kg2 = new KnowledgeGraph(TEST_KG);
    const triples = kg2.queryTriples('architecture', undefined, 'architectural_decision');
    kg2.close();

    expect(triples.length).toBeGreaterThanOrEqual(1);
    expect(triples[0].object).toBe(`refinery_${result!.id}`);
    expect(triples[0].metadata?.class).toBe('advisory');
  });

  it('emits REFINERY_ESCALATION audit log on escalation', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: REFINERY_RESPONSE } }] });

    const auditModule = require('../../src/hardening/audit') as typeof import('../../src/hardening/audit');
    const auditSpy = jest.spyOn(auditModule, 'auditLog');

    await mayor.escalateToRefinery(makeBead('architecture'), makeRejectedVerdict(), 1);

    const call = auditSpy.mock.calls.find((args) => args[0] === 'REFINERY_ESCALATION');
    expect(call).toBeDefined();
    expect(call?.[1]).toBe('mayor_ref_test');
    // subject is bead_id; detail contains task_type and attempts
    expect(call?.[3]).toContain('task_type=architecture');
    expect(call?.[3]).toContain('attempts=1');

    auditSpy.mockRestore();
  });

  it('passes diff to Refinery analysis when provided', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: REFINERY_RESPONSE } }] });

    const diff = '--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n+import { Session } from "./session"';
    await mayor.escalateToRefinery(makeBead('architecture'), makeRejectedVerdict(), 2, diff);

    // Refinery passes diff in user prompt — verify it reached Groq
    const callArgs = getMock().mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const userMsg = callArgs.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('Rejected diff');
  });

  it('verdict rejection reason is included in Refinery failure context', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: REFINERY_RESPONSE } }] });

    const verdict = makeRejectedVerdict();
    verdict.reason = 'Specific failure: SQL injection vulnerability detected';
    await mayor.escalateToRefinery(makeBead('security'), verdict, 1);

    const callArgs = getMock().mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const userMsg = callArgs.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('SQL injection vulnerability detected');
  });
});
