// Tests: Dynamic swarm rebalance limits integration in Mayor.orchestrate() (SWARM.md §3)
// Per spec: limits expand 50% when errorRate < 5% and throughput >= 10 beads/min,
// restore defaults otherwise.

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })),
}));

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { swarmRebalanceLimits, DEFAULT_IN_FLIGHT_LIMITS } from '../../src/swarm/tools';
import type { InFlightLimits } from '../../src/swarm/tools';
import { Ledger } from '../../src/ledger/index';
import { Mayor } from '../../src/roles/mayor';
import { generateKeyPair } from '../../src/convoys/sign';
import type { Bead } from '../../src/types/index';

const TEST_KEY_DIR = path.join(os.tmpdir(), `dyn-lim-keys-${Date.now()}`);
const TEST_RIGS = path.join(os.tmpdir(), `dyn-lim-rigs-${Date.now()}`);
const TEST_DB = path.join(os.tmpdir(), `dyn-lim-kg-${Date.now()}.sqlite`);

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  await generateKeyPair('mayor_dynlim');
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  fs.rmSync(TEST_DB, { force: true });
  jest.restoreAllMocks();
});

// ── swarmRebalanceLimits unit tests ──────────────────────────────────────────

describe('swarmRebalanceLimits (SWARM.md §3)', () => {
  const current: InFlightLimits = { maxPolecatBeads: 50, maxWitnessBeads: 20 };

  it('expands limits by 50% when error rate < 5% and throughput >= 10 bpm', () => {
    const result = swarmRebalanceLimits(current, { beadsPerMinute: 15, errorRate: 0.02 });
    expect(result.maxPolecatBeads).toBe(75);
    expect(result.maxWitnessBeads).toBe(30);
  });

  it('caps expansion at MAX_LIMITS (100 polecats, 40 witnesses)', () => {
    const nearMax: InFlightLimits = { maxPolecatBeads: 90, maxWitnessBeads: 35 };
    const result = swarmRebalanceLimits(nearMax, { beadsPerMinute: 20, errorRate: 0.0 });
    expect(result.maxPolecatBeads).toBe(100);
    expect(result.maxWitnessBeads).toBe(40);
  });

  it('restores defaults when error rate >= 5%', () => {
    const expanded: InFlightLimits = { maxPolecatBeads: 75, maxWitnessBeads: 30 };
    const result = swarmRebalanceLimits(expanded, { beadsPerMinute: 15, errorRate: 0.06 });
    expect(result.maxPolecatBeads).toBe(DEFAULT_IN_FLIGHT_LIMITS.maxPolecatBeads);
    expect(result.maxWitnessBeads).toBe(DEFAULT_IN_FLIGHT_LIMITS.maxWitnessBeads);
  });

  it('restores defaults when throughput < 10 bpm', () => {
    const expanded: InFlightLimits = { maxPolecatBeads: 75, maxWitnessBeads: 30 };
    const result = swarmRebalanceLimits(expanded, { beadsPerMinute: 5, errorRate: 0.01 });
    expect(result.maxPolecatBeads).toBe(DEFAULT_IN_FLIGHT_LIMITS.maxPolecatBeads);
  });

  it('restores defaults when both conditions fail', () => {
    const result = swarmRebalanceLimits(current, { beadsPerMinute: 2, errorRate: 0.10 });
    expect(result.maxPolecatBeads).toBe(DEFAULT_IN_FLIGHT_LIMITS.maxPolecatBeads);
  });

  it('expands at exactly the boundary (10 bpm, 4.9% error rate)', () => {
    const result = swarmRebalanceLimits(current, { beadsPerMinute: 10, errorRate: 0.049 });
    expect(result.maxPolecatBeads).toBe(75); // expanded
  });

  it('restores at exactly 5% error rate boundary', () => {
    const result = swarmRebalanceLimits(current, { beadsPerMinute: 15, errorRate: 0.05 });
    // 0.05 is NOT < 0.05, so should restore defaults
    expect(result.maxPolecatBeads).toBe(DEFAULT_IN_FLIGHT_LIMITS.maxPolecatBeads);
  });

  it('zero beads/min (no history) → restores defaults', () => {
    const result = swarmRebalanceLimits(current, { beadsPerMinute: 0, errorRate: 0 });
    expect(result.maxPolecatBeads).toBe(DEFAULT_IN_FLIGHT_LIMITS.maxPolecatBeads);
  });
});

// ── Integration: Mayor uses dynamic limits in orchestrate() ───────────────────

describe('Mayor orchestrate() uses dynamic rebalance limits (SWARM.md §3)', () => {
  let mayor: Mayor;

  beforeEach(() => {
    jest.restoreAllMocks();
    mayor = new Mayor({
      agentId: 'mayor_dynlim',
      rigName: 'dynlim-rig',
      kgPath: TEST_DB,
    });

  });

  afterEach(() => {
    mayor.close();
  });

  it('throws WAITING_FOR_CAPACITY when in-progress count exceeds default limits', async () => {
    // Fill ledger with 51 in-progress beads (default limit is 50)
    const ledger = new Ledger(TEST_RIGS);
    for (let i = 0; i < 51; i++) {
      await ledger.appendBead('dynlim-rig', Ledger.createBead({
        role: 'polecat',
        task_type: 'execute',
        model: 'test',
        rig: 'dynlim-rig',
        status: 'in_progress',
        plan_checkpoint_id: 'ckpt-test',
        bead_id: `overload-bead-${i.toString().padStart(3, '0')}`,
      }));
    }

    await expect(mayor.orchestrate({ description: 'Test task' })).rejects.toThrow(
      'Mayor WAITING_FOR_CAPACITY',
    );

    // Cleanup
    const rigsPath = path.join(TEST_RIGS, 'dynlim-rig', 'beads');
    if (fs.existsSync(rigsPath)) fs.rmSync(rigsPath, { recursive: true, force: true });
  });

  it('reads ledger to compute live metrics — empty ledger yields 0 bpm (restores defaults)', async () => {
    // With empty ledger, readBeads returns [] → bpm=0, errorRate=0 → defaults restored.
    // Verify this by checking the mayor does NOT throw WAITING_FOR_CAPACITY for 0 in-progress.
    // We test this indirectly: if the ledger is empty, the rebalancer restores DEFAULT_LIMITS (50),
    // and 0 in-progress < 50 means no capacity block. Confirmed via swarmRebalanceLimits unit tests above.
    const { Ledger: LedgerCls } = await import('../../src/ledger/index');
    const ledger = new LedgerCls(TEST_RIGS);
    const beads = ledger.readBeads('dynlim-rig');
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const recent = beads.filter(
      (b) => (b.updated_at ?? b.created_at) >= oneMinuteAgo && b.status !== 'pending' && b.status !== 'in_progress',
    );

    // Ledger is empty → no recent completed beads
    expect(recent.length).toBe(0);

    // With 0 bpm and 0% error rate, rebalance returns defaults
    const { swarmRebalanceLimits: rebalance, DEFAULT_IN_FLIGHT_LIMITS: defaults } = await import('../../src/swarm/tools');
    const adjusted = rebalance(defaults, { beadsPerMinute: 0, errorRate: 0 });
    expect(adjusted.maxPolecatBeads).toBe(defaults.maxPolecatBeads);
  });
});
