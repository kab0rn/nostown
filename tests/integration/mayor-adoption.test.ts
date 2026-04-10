// Integration: Mayor orphan workflow adoption is idempotent (RISKS.md R-002)
// Validates: replacement Mayor adopts orphan without re-decomposing,
// no duplicate beads created, MAYOR_ADOPTION audit event emitted.

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })),
}));

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Mayor } from '../../src/roles/mayor';
import { Ledger } from '../../src/ledger/index';
import { MemPalaceClient } from '../../src/mempalace/client';
import { generateKeyPair } from '../../src/convoys/sign';
import type { Bead } from '../../src/types/index';

const TEST_KEY_DIR = path.join(os.tmpdir(), `adopt-keys-${Date.now()}`);
const TEST_RIGS = path.join(os.tmpdir(), `adopt-rigs-${Date.now()}`);
const TEST_DB = path.join(os.tmpdir(), `adopt-kg-${Date.now()}.sqlite`);
const TEST_AUDIT = path.join(os.tmpdir(), `adopt-audit-${Date.now()}`);

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  process.env.NOS_AUDIT_DIR = TEST_AUDIT;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  fs.mkdirSync(TEST_AUDIT, { recursive: true });
  await generateKeyPair('mayor_adopt');
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  fs.rmSync(TEST_DB, { force: true });
  fs.rmSync(TEST_AUDIT, { recursive: true, force: true });
  delete process.env.NOS_ROLE_KEY_DIR;
  delete process.env.NOS_RIGS_ROOT;
  delete process.env.NOS_AUDIT_DIR;
  jest.restoreAllMocks();
});

describe('Mayor orphan adoption idempotency (R-002)', () => {
  let searchSpy: jest.SpyInstance;
  let diaryReadSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    diaryReadSpy = jest.spyOn(MemPalaceClient.prototype, 'diaryRead').mockResolvedValue([]);
    searchSpy = jest.spyOn(MemPalaceClient.prototype, 'search').mockResolvedValue({ results: [], total: 0 });
    jest.spyOn(MemPalaceClient.prototype, 'addDrawer').mockResolvedValue({ id: 'ok' });
  });

  it('startup() returns true and emits MAYOR_ADOPTION when orphan checkpoint found', async () => {
    const auditModule = require('../../src/hardening/audit') as typeof import('../../src/hardening/audit');
    const auditSpy = jest.spyOn(auditModule, 'auditLog');

    searchSpy.mockImplementation((query: string, _wing: string, hall: string) => {
      if (query === 'active-convoy' && hall === 'hall_facts') {
        return Promise.resolve({
          results: [{ id: 'ckpt-orphan-001', content: '{"checkpoint_id":"ckpt-orphan-001"}' }],
          total: 1,
        });
      }
      return Promise.resolve({ results: [], total: 0 });
    });

    const mayor = new Mayor({ agentId: 'mayor_adopt', rigName: 'adopt-rig', kgPath: TEST_DB });
    const orphanFound = await mayor.startup();
    mayor.close();

    expect(orphanFound).toBe(true);
    const adoptionCall = auditSpy.mock.calls.find((args) => args[0] === 'MAYOR_ADOPTION');
    expect(adoptionCall).toBeDefined();
    expect(adoptionCall?.[1]).toBe('mayor_adopt');
    auditSpy.mockRestore();
  });

  it('startup() returns false when no orphan checkpoint — no MAYOR_ADOPTION emitted', async () => {
    const auditModule = require('../../src/hardening/audit') as typeof import('../../src/hardening/audit');
    const auditSpy = jest.spyOn(auditModule, 'auditLog');

    // searchSpy already returns empty results
    const mayor = new Mayor({ agentId: 'mayor_adopt', rigName: 'adopt-rig-2', kgPath: TEST_DB });
    const orphanFound = await mayor.startup();
    mayor.close();

    expect(orphanFound).toBe(false);
    const adoptionCall = auditSpy.mock.calls.find((args) => args[0] === 'MAYOR_ADOPTION');
    expect(adoptionCall).toBeUndefined();
    auditSpy.mockRestore();
  });

  it('orphan adoption: existing ledger beads are NOT re-written (no duplicate bead IDs)', async () => {
    // Write 3 in-progress beads to the ledger simulating a prior Mayor's work
    const ledger = new Ledger(TEST_RIGS);
    const existingBeads: Bead[] = [
      Ledger.createBead({ role: 'polecat', task_type: 'execute', model: 'test', rig: 'adopt-rig-dup',
        status: 'in_progress', plan_checkpoint_id: 'ckpt-orphan-001', bead_id: 'prior-bead-001' }),
      Ledger.createBead({ role: 'polecat', task_type: 'execute', model: 'test', rig: 'adopt-rig-dup',
        status: 'in_progress', plan_checkpoint_id: 'ckpt-orphan-001', bead_id: 'prior-bead-002' }),
      Ledger.createBead({ role: 'polecat', task_type: 'execute', model: 'test', rig: 'adopt-rig-dup',
        status: 'in_progress', plan_checkpoint_id: 'ckpt-orphan-001', bead_id: 'prior-bead-003' }),
    ];
    for (const b of existingBeads) {
      await ledger.appendBead('adopt-rig-dup', b);
    }

    searchSpy.mockImplementation((query: string, _wing: string, hall: string) => {
      if (query === 'active-convoy' && hall === 'hall_facts') {
        return Promise.resolve({
          results: [{ id: 'ckpt-orphan-001', content: '{"checkpoint_id":"ckpt-orphan-001"}' }],
          total: 1,
        });
      }
      return Promise.resolve({ results: [], total: 0 });
    });

    const mayor = new Mayor({ agentId: 'mayor_adopt', rigName: 'adopt-rig-dup', kgPath: TEST_DB });
    await mayor.startup();
    mayor.close();

    // Read ledger after startup — must still have exactly the same 3 beads (no duplicates)
    const afterBeads = ledger.readBeads('adopt-rig-dup');
    const ids = afterBeads.map((b) => b.bead_id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length); // no duplicate IDs
    expect(ids).toContain('prior-bead-001');
    expect(ids).toContain('prior-bead-002');
    expect(ids).toContain('prior-bead-003');
  });

  it('replacement Mayor can still orchestrate NEW goals after adoption', async () => {
    const mockDecompose = JSON.stringify({
      beads: [{
        task_type: 'execute',
        task_description: 'New task',
        role: 'polecat',
        needs: [],
        critical_path: false,
        witness_required: false,
        fan_out_weight: 1,
      }],
    });

    const { GroqProvider } = await import('../../src/groq/provider');
    jest.spyOn(GroqProvider.prototype, 'executeInference').mockResolvedValue(mockDecompose);
    jest.spyOn(MemPalaceClient.prototype, 'saveCheckpoint').mockResolvedValue('ckpt-new-task');
    jest.spyOn(MemPalaceClient.prototype, 'wakeup').mockResolvedValue({ l0: '', l1: '' } as never);

    searchSpy.mockImplementation((query: string, _wing: string, hall: string) => {
      if (query === 'active-convoy' && hall === 'hall_facts') {
        return Promise.resolve({
          results: [{ id: 'ckpt-prior-orphan', content: '{}' }],
          total: 1,
        });
      }
      return Promise.resolve({ results: [], total: 0 });
    });

    const mayor = new Mayor({ agentId: 'mayor_adopt', rigName: 'adopt-new-rig', kgPath: TEST_DB });
    await mayor.startup(); // adopts orphan

    // Should NOT throw — new orchestration is allowed even after orphan adoption
    const plan = await mayor.orchestrate({ description: 'New goal after adoption' });
    expect(plan.beads.length).toBeGreaterThan(0);
    expect(plan.checkpoint_id).toBe('ckpt-new-task');
    mayor.close();
  });

  it('two consecutive startup() calls are idempotent (safe to call twice)', async () => {
    searchSpy.mockImplementation((query: string, _wing: string, hall: string) => {
      if (query === 'active-convoy' && hall === 'hall_facts') {
        return Promise.resolve({
          results: [{ id: 'ckpt-idem-001', content: '{}' }],
          total: 1,
        });
      }
      return Promise.resolve({ results: [], total: 0 });
    });

    const mayor = new Mayor({ agentId: 'mayor_adopt', rigName: 'adopt-idem-rig', kgPath: TEST_DB });
    const first = await mayor.startup();
    const second = await mayor.startup();
    mayor.close();

    // Both calls should find the orphan — idempotent reads
    expect(first).toBe(true);
    expect(second).toBe(true);
  });
});
