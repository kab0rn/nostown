// Tests: Polecat safeguard write interception
// Per HARDENING.md §4.1: Safeguard scans diff before FILE_WRITE.
// If not approved, bead is FAILURE; approved → SUCCESS.

jest.mock('groq-sdk', () => {
  const mockCreate = jest.fn();
  (globalThis as Record<string, unknown>).__polecatSgMockCreate = mockCreate;
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    })),
  };
});

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Polecat } from '../../src/roles/polecat';
import { SafeguardPool } from '../../src/roles/safeguard';
import { Ledger } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

function getMock(): jest.Mock {
  return (globalThis as Record<string, unknown>).__polecatSgMockCreate as jest.Mock;
}

const TEST_RIGS = path.join(os.tmpdir(), `polecat-sg-rigs-${Date.now()}`);
const TEST_SG_DB = path.join(os.tmpdir(), `polecat-sg-kg-${Date.now()}.sqlite`);

beforeAll(() => {
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  fs.mkdirSync(TEST_RIGS, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  fs.rmSync(TEST_SG_DB, { force: true });
  jest.restoreAllMocks();
});

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return Ledger.createBead({
    role: 'polecat',
    task_type: 'execute',
    model: 'llama-3.1-8b-instant',
    rig: 'sg-test-rig',
    status: 'pending',
    ...overrides,
  });
}

describe('Polecat safeguard write interception', () => {
  beforeEach(() => {
    getMock().mockReset();
  });

  it('writes SUCCESS when safeguard approves the result', async () => {
    // Groq returns a clean result
    getMock().mockResolvedValue({
      choices: [{ message: { content: 'console.log("hello world");' } }],
    });

    // Safeguard mock: always approves
    const safeguard = new SafeguardPool({ poolSize: 2, kgPath: TEST_SG_DB });
    jest.spyOn(safeguard, 'scan').mockResolvedValue({ approved: true, violations: [] });

    const polecat = new Polecat({
      agentId: 'polecat_sg_test',
      rigName: 'sg-test-rig',
      safeguard,
    });

    const bead = makeBead({ bead_id: 'sg-bead-001' });
    const result = await polecat.execute(bead, { task_description: 'Print hello world' });

    expect(result.status).toBe('done');
    expect(result.outcome).toBe('SUCCESS');
    expect(safeguard.scan).toHaveBeenCalledTimes(1);

    safeguard.close();
  });

  it('returns FAILURE when safeguard rejects with critical violation', async () => {
    // Groq returns a result with a credential leak
    getMock().mockResolvedValue({
      choices: [{ message: { content: `const apiKey = 'sk-1234567890abcdefghij';` } }],
    });

    // Safeguard mock: rejects (simulates credential detection)
    const safeguard = new SafeguardPool({ poolSize: 2, kgPath: TEST_SG_DB });
    jest.spyOn(safeguard, 'scan').mockResolvedValue({
      approved: false,
      violations: [{ rule: 'secret_hardcoded', severity: 'critical', detail: 'Hardcoded API key' }],
    });

    const polecat = new Polecat({
      agentId: 'polecat_sg_test',
      rigName: 'sg-test-rig',
      safeguard,
    });

    const bead = makeBead({ bead_id: 'sg-bead-002' });
    const result = await polecat.execute(bead, { task_description: 'Generate config' });

    expect(result.status).toBe('failed');
    expect(result.outcome).toBe('FAILURE');

    safeguard.close();
  });

  it('scans with higher priority for critical_path beads', async () => {
    getMock().mockResolvedValue({
      choices: [{ message: { content: 'clean result' } }],
    });

    const safeguard = new SafeguardPool({ poolSize: 2, kgPath: TEST_SG_DB });
    const scanSpy = jest.spyOn(safeguard, 'scan').mockResolvedValue({ approved: true, violations: [] });

    const polecat = new Polecat({
      agentId: 'polecat_sg_test',
      rigName: 'sg-test-rig',
      safeguard,
    });

    const criticalBead = makeBead({ bead_id: 'sg-critical-001', critical_path: true });
    await polecat.execute(criticalBead, { task_description: 'Critical task' });

    // Critical path beads get priority=10
    expect(scanSpy).toHaveBeenCalledWith('clean result', 10);

    safeguard.close();
  });

  it('skips scan when no safeguard configured', async () => {
    getMock().mockResolvedValue({
      choices: [{ message: { content: 'any result' } }],
    });

    // No safeguard provided
    const polecat = new Polecat({
      agentId: 'polecat_no_sg',
      rigName: 'sg-test-rig',
    });

    const bead = makeBead({ bead_id: 'sg-bead-noscan' });
    const result = await polecat.execute(bead, { task_description: 'Execute without safeguard' });

    // Should still succeed
    expect(result.status).toBe('done');
    expect(result.outcome).toBe('SUCCESS');
  });

  it('uses scan result violation detail in logged failure', async () => {
    getMock().mockResolvedValue({
      choices: [{ message: { content: 'rm -rf /' } }],
    });

    const safeguard = new SafeguardPool({ poolSize: 2, kgPath: TEST_SG_DB });
    jest.spyOn(safeguard, 'scan').mockResolvedValue({
      approved: false,
      violations: [
        { rule: 'destructive_cmd', severity: 'critical', detail: 'Destructive shell command detected' },
      ],
    });

    const polecat = new Polecat({
      agentId: 'polecat_sg_test',
      rigName: 'sg-test-rig',
      safeguard,
    });

    const bead = makeBead({ bead_id: 'sg-bead-destructive' });
    const result = await polecat.execute(bead, { task_description: 'Dangerous task' });

    expect(result.status).toBe('failed');

    safeguard.close();
  });
});
