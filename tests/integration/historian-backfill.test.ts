// Tests: MemPalace backfill catches missing Drawers (#9)

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Historian } from '../../src/roles/historian';
import { Ledger } from '../../src/ledger/index';
import { MemPalaceClient } from '../../src/mempalace/client';

const TEST_RIGS_ROOT = path.join(os.tmpdir(), `nos-hist-rigs-${Date.now()}`);
const TEST_KG = path.join(os.tmpdir(), `nos-hist-kg-${Date.now()}.sqlite`);

beforeAll(() => {
  process.env.NOS_RIGS_ROOT = TEST_RIGS_ROOT;
  fs.mkdirSync(TEST_RIGS_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_RIGS_ROOT, { recursive: true, force: true });
  fs.rmSync(TEST_KG, { force: true });
  jest.restoreAllMocks();
});

describe('Historian.backfillMissingDrawers (#9)', () => {
  let historian: Historian;
  let ledger: Ledger;
  let searchSpy: jest.SpyInstance;
  let addDrawerSpy: jest.SpyInstance;
  // Unique rig name per test to avoid cross-test state leaking
  let testRig: string;

  beforeEach(() => {
    testRig = `backfill-rig-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    historian = new Historian({
      agentId: 'historian_test',
      kgPath: TEST_KG,
    });
    ledger = new Ledger(TEST_RIGS_ROOT);

    // Default: search finds nothing → all beads are "missing"
    searchSpy = jest.spyOn(MemPalaceClient.prototype, 'search').mockResolvedValue({
      results: [],
      total: 0,
    });

    addDrawerSpy = jest.spyOn(MemPalaceClient.prototype, 'addDrawer').mockResolvedValue({
      id: 'drawer-mock-id',
    });
  });

  afterEach(() => {
    historian.close();
    jest.restoreAllMocks();
  });

  it('backfills all done beads when none exist in palace', async () => {
    for (let i = 0; i < 3; i++) {
      const bead = Ledger.createBead({
        role: 'polecat',
        task_type: 'execute',
        model: 'llama-3.1-8b-instant',
        rig: testRig,
        status: 'done',
        outcome: 'SUCCESS',
      });
      await ledger.appendBead(testRig, bead);
    }

    const count = await historian.backfillMissingDrawers(testRig);

    expect(count).toBe(3);
    expect(addDrawerSpy).toHaveBeenCalledTimes(3);
  });

  it('skips beads that already exist in palace', async () => {
    const bead1 = Ledger.createBead({
      role: 'polecat',
      task_type: 'execute',
      model: 'llama-3.1-8b-instant',
      rig: testRig,
      status: 'done',
      outcome: 'SUCCESS',
    });
    const bead2 = Ledger.createBead({
      role: 'polecat',
      task_type: 'execute',
      model: 'llama-3.1-8b-instant',
      rig: testRig,
      status: 'done',
      outcome: 'SUCCESS',
    });

    await ledger.appendBead(testRig, bead1);
    await ledger.appendBead(testRig, bead2);

    // bead1 is already in palace, bead2 is missing
    searchSpy.mockImplementation(async (query: string) => {
      if (query === bead1.bead_id) {
        return {
          results: [
            {
              id: 'existing-drawer',
              wing_id: `wing_rig_${testRig}`,
              hall_type: 'hall_events',
              room_id: bead1.bead_id,
              content: '{}',
              created_at: new Date().toISOString(),
            },
          ],
          total: 1,
        };
      }
      return { results: [], total: 0 };
    });

    const count = await historian.backfillMissingDrawers(testRig);

    expect(count).toBe(1); // only bead2 was backfilled
    expect(addDrawerSpy).toHaveBeenCalledTimes(1);
    expect(addDrawerSpy.mock.calls[0][2]).toBe(bead2.bead_id);
  });

  it('returns 0 when no done beads exist in ledger', async () => {
    const bead = Ledger.createBead({
      role: 'polecat',
      task_type: 'execute',
      model: 'llama-3.1-8b-instant',
      rig: testRig,
      status: 'pending',
    });
    await ledger.appendBead(testRig, bead);

    const count = await historian.backfillMissingDrawers(testRig);

    expect(count).toBe(0);
    expect(addDrawerSpy).not.toHaveBeenCalled();
  });

  it('handles palace search error gracefully (non-fatal)', async () => {
    searchSpy.mockRejectedValue(new Error('palace unreachable'));

    const bead = Ledger.createBead({
      role: 'polecat',
      task_type: 'execute',
      model: 'llama-3.1-8b-instant',
      rig: testRig,
      status: 'done',
      outcome: 'SUCCESS',
    });
    await ledger.appendBead(testRig, bead);

    // Should not throw — palace errors are non-fatal
    await expect(historian.backfillMissingDrawers(testRig)).resolves.toBe(0);
  });
});
