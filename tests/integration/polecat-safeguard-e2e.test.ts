// Integration: Polecat + Safeguard pre-write scan pipeline (HARDENING.md §4.1)
// Validates that when Polecat is wired with a SafeguardPool:
//   - Malicious diffs are blocked → bead status 'failed', outcome FAILURE
//   - Clean diffs pass through → bead status 'done', outcome SUCCESS
//   - Safeguard scan receives correct priority (10 for critical_path, 0 otherwise)

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Polecat } from '../../src/roles/polecat';
import type { ExecutionContext } from '../../src/roles/polecat';
import { SafeguardPool } from '../../src/roles/safeguard';
import type { ScanResult } from '../../src/types/index';
import { Ledger } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('groq-sdk', () => {
  const mockCreate = jest.fn();
  (globalThis as Record<string, unknown>).__sgE2eMock = mockCreate;
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    })),
  };
});

function getMock(): jest.Mock {
  return (globalThis as Record<string, unknown>).__sgE2eMock as jest.Mock;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_RIGS = path.join(os.tmpdir(), `sg-e2e-rigs-${Date.now()}`);

function makeBead(rig = 'sg-e2e-rig', criticalPath = false): Bead {
  return Ledger.createBead({
    role: 'polecat',
    task_type: 'implement',
    task_description: 'Write auth module',
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    rig,
    status: 'pending',
    critical_path: criticalPath,
    plan_checkpoint_id: 'ckpt-sg-001',
  });
}

const CLEAN_DIFF = '--- a/auth.ts\n+++ b/auth.ts\n@@ -0,0 +1,3 @@\n+export function login(user: string) {\n+  return { token: "safe_token" };\n+}\n';
const MALICIOUS_DIFF = '--- a/auth.ts\n+++ b/auth.ts\n@@ -0,0 +1 @@\n+const secret = process.env.AWS_SECRET_ACCESS_KEY;\n';

beforeAll(() => {
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
});

afterAll(() => {
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  delete process.env.NOS_RIGS_ROOT;
});

beforeEach(() => {
  getMock().mockReset();
  getMock().mockResolvedValue({ choices: [{ message: { content: CLEAN_DIFF } }] });
});

function makeMockPool(scanResult: ScanResult): SafeguardPool {
  return { scan: jest.fn().mockResolvedValue(scanResult) } as unknown as SafeguardPool;
}

// ── Safeguard BLOCKS malicious diff ───────────────────────────────────────────

describe('Polecat + Safeguard: blocking path (HARDENING.md §4.1)', () => {
  it('marks bead failed/FAILURE when Safeguard rejects diff', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: MALICIOUS_DIFF } }] });

    const pool = makeMockPool({
      approved: false,
      violations: [{
        rule: 'credential-exposure',
        severity: 'critical',
        detail: 'AWS_SECRET_ACCESS_KEY exposed',
      }],
    });

    const polecat = new Polecat({
      agentId: 'polecat_sg_test',
      rigName: 'sg-e2e-rig',
      groqApiKey: 'test-key',
      safeguard: pool,
    });

    const result = await polecat.execute(makeBead(), { task_description: 'Write auth module' });

    expect(result.status).toBe('failed');
    expect(result.outcome).toBe('FAILURE');
  });

  it('Safeguard.scan() is called with the diff returned by Groq', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: MALICIOUS_DIFF } }] });

    const scanSpy = jest.fn<Promise<ScanResult>, [string, number]>().mockResolvedValue({
      approved: false,
      violations: [{ rule: 'credential-exposure', severity: 'critical', detail: 'exposed key' }],
    });
    const pool = { scan: scanSpy } as unknown as SafeguardPool;

    const polecat = new Polecat({
      agentId: 'polecat_sg_spy',
      rigName: 'sg-e2e-rig',
      groqApiKey: 'test-key',
      safeguard: pool,
    });

    await polecat.execute(makeBead(), { task_description: 'Write auth module' });

    expect(scanSpy).toHaveBeenCalledTimes(1);
    const [diffArg] = scanSpy.mock.calls[0];
    expect(diffArg).toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('critical_path bead scanned at priority 10; non-critical at priority 0', async () => {
    const scanSpy = jest.fn<Promise<ScanResult>, [string, number]>().mockResolvedValue({
      approved: true,
      violations: [],
    });
    const pool = { scan: scanSpy } as unknown as SafeguardPool;

    const polecat = new Polecat({
      agentId: 'polecat_sg_priority',
      rigName: 'sg-e2e-rig',
      groqApiKey: 'test-key',
      safeguard: pool,
    });

    const critBead = makeBead('sg-e2e-rig', true);   // critical_path = true
    const lowBead = makeBead('sg-e2e-rig', false);   // critical_path = false

    await polecat.execute(critBead, { task_description: 'Critical' });
    await polecat.execute(lowBead, { task_description: 'Low priority' });

    expect(scanSpy).toHaveBeenNthCalledWith(1, expect.any(String), 10);
    expect(scanSpy).toHaveBeenNthCalledWith(2, expect.any(String), 0);
  });

  it('safeguard-blocked bead is written to ledger with failed/FAILURE', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: MALICIOUS_DIFF } }] });
    const pool = makeMockPool({
      approved: false,
      violations: [{ rule: 'injection', severity: 'high', detail: 'SQL injection' }],
    });

    const polecat = new Polecat({
      agentId: 'polecat_sg_ledger',
      rigName: 'sg-e2e-rig',
      groqApiKey: 'test-key',
      safeguard: pool,
    });
    const bead = makeBead();
    await polecat.execute(bead, { task_description: 'Write auth' });

    const ledger = new Ledger();
    const beads = ledger.readBeads('sg-e2e-rig');
    const found = beads.find((b) => b.bead_id === bead.bead_id && b.status === 'failed');
    expect(found).toBeDefined();
  });
});

// ── Safeguard APPROVES clean diff ────────────────────────────────────────────

describe('Polecat + Safeguard: approval path (HARDENING.md §4.1)', () => {
  it('marks bead done/SUCCESS when Safeguard approves clean diff', async () => {
    const pool = makeMockPool({ approved: true, violations: [] });
    const polecat = new Polecat({
      agentId: 'polecat_sg_clean',
      rigName: 'sg-e2e-rig',
      groqApiKey: 'test-key',
      safeguard: pool,
    });

    const result = await polecat.execute(makeBead(), { task_description: 'Write auth' });

    expect(result.status).toBe('done');
    expect(result.outcome).toBe('SUCCESS');
    expect(pool.scan).toHaveBeenCalledTimes(1);
  });

  it('passes the actual LLM diff to Safeguard scanner', async () => {
    const scanSpy = jest.fn<Promise<ScanResult>, [string, number]>().mockResolvedValue({
      approved: true,
      violations: [],
    });
    const pool = { scan: scanSpy } as unknown as SafeguardPool;

    const polecat = new Polecat({
      agentId: 'polecat_sg_passthrough',
      rigName: 'sg-e2e-rig',
      groqApiKey: 'test-key',
      safeguard: pool,
    });

    await polecat.execute(makeBead(), { task_description: 'Write auth' });

    const [diffPassed] = scanSpy.mock.calls[0];
    expect(diffPassed).toContain('+export function login');
  });

  it('executes normally (done/SUCCESS) without Safeguard configured', async () => {
    const polecat = new Polecat({
      agentId: 'polecat_no_sg',
      rigName: 'sg-e2e-rig',
      groqApiKey: 'test-key',
    });

    const result = await polecat.execute(makeBead(), { task_description: 'Write auth' });
    expect(result.status).toBe('done');
    expect(result.outcome).toBe('SUCCESS');
  });
});

// ── LOCKDOWN propagation ─────────────────────────────────────────────────────

describe('Polecat + Safeguard: LOCKDOWN scan result (HARDENING.md §4.2)', () => {
  it('bead is still failed/FAILURE when lockdown scan result returned', async () => {
    getMock().mockResolvedValue({ choices: [{ message: { content: MALICIOUS_DIFF } }] });

    const pool = makeMockPool({
      approved: false,
      violations: [{ rule: 'credential-exposure', severity: 'critical', detail: 'API key leaked' }],
      lockdown: {
        triggered: true,
        reason: 'AWS_SECRET_ACCESS_KEY found',
        lockdown_id: 'lockdown-test-001',
      },
    });

    const polecat = new Polecat({
      agentId: 'polecat_lockdown',
      rigName: 'sg-e2e-rig',
      groqApiKey: 'test-key',
      safeguard: pool,
    });

    const result = await polecat.execute(makeBead(), { task_description: 'Write auth' });

    // Blocked either way — bead is failed regardless of lockdown flag
    expect(result.status).toBe('failed');
    expect(result.outcome).toBe('FAILURE');
  });
});
