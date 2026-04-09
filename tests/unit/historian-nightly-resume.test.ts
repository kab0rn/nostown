// Tests: Historian nightly pipeline step tracking and resume (HARDENING.md §Historian)
// Per spec: interrupted nightly runs can resume from the last completed step.

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })),
}));

// Mock GroqProvider.executeInference to avoid retry backoff in playbook generation
jest.mock('../../src/groq/provider', () => ({
  GroqProvider: jest.fn().mockImplementation(() => ({
    executeInference: jest.fn().mockResolvedValue(
      JSON.stringify({ title: 'Test Playbook', steps: ['Step 1', 'Step 2'] }),
    ),
  })),
}));

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Historian } from '../../src/roles/historian';
import { MemPalaceClient } from '../../src/mempalace/client';
import { Ledger } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

const TEST_RIGS = path.join(os.tmpdir(), `hist-resume-rigs-${Date.now()}`);
const TEST_DB = path.join(os.tmpdir(), `hist-resume-kg-${Date.now()}.sqlite`);

function makeBead(id: string): Bead {
  return Ledger.createBead({
    bead_id: id,
    role: 'polecat',
    task_type: 'execute',
    model: 'llama-3.1-8b-instant',
    rig: 'resume-rig',
    status: 'done',
    outcome: 'SUCCESS',
    needs: [],
    plan_checkpoint_id: 'ckpt-resume-test',
  });
}

beforeAll(() => {
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  fs.mkdirSync(TEST_RIGS, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  fs.rmSync(TEST_DB, { force: true });
  delete process.env.NOS_RIGS_ROOT;
  jest.restoreAllMocks();
});

describe('Historian nightly run step progress tracking (HARDENING.md)', () => {
  let historian: Historian;
  let ledger: Ledger;
  let addDrawerSpy: jest.SpyInstance;
  let searchSpy: jest.SpyInstance;
  let classifyBeadsCalls = 0;

  beforeEach(async () => {
    jest.restoreAllMocks();
    classifyBeadsCalls = 0;

    historian = new Historian({ agentId: 'hist-resume', kgPath: TEST_DB });
    ledger = new Ledger();

    // Write some beads to the ledger for the historian to process
    const bead = makeBead('bead-resume-001');
    await ledger.appendBead('resume-rig', bead);

    // Track addDrawer calls to verify step markers are written
    addDrawerSpy = jest.spyOn(MemPalaceClient.prototype, 'addDrawer').mockResolvedValue({ id: 'ok' });

    jest.spyOn(MemPalaceClient.prototype, 'diaryWrite').mockResolvedValue({ id: 1 });
    jest.spyOn(MemPalaceClient.prototype, 'diaryRead').mockResolvedValue([]);
    jest.spyOn(MemPalaceClient.prototype, 'getTunnels').mockResolvedValue([]);
    jest.spyOn(MemPalaceClient.prototype, 'listRooms').mockResolvedValue([]);

    // Default search: no prior progress markers
    searchSpy = jest.spyOn(MemPalaceClient.prototype, 'search').mockResolvedValue({ results: [], total: 0 });
  });

  afterEach(() => {
    historian.close();
  });

  it('writes progress markers after each completed step', async () => {
    await historian.runNightly('resume-rig');

    // Should have written addDrawer calls for: aaak_manifest + step markers
    // Step markers: classify_beads, aaak_manifest, mine_patterns, generate_playbooks, update_routing_kg, detect_tunnels
    const stepMarkerCalls = addDrawerSpy.mock.calls.filter(
      (args) => (args[0] as string) === 'wing_historian' && (args[1] as string) === 'hall_events',
    );
    expect(stepMarkerCalls.length).toBeGreaterThan(0);
  });

  it('step markers contain step name, rig, and date', async () => {
    await historian.runNightly('resume-rig');

    const stepMarkerCalls = addDrawerSpy.mock.calls.filter(
      (args) => (args[0] as string) === 'wing_historian' && (args[1] as string) === 'hall_events',
    );

    const today = new Date().toISOString().slice(0, 10);
    for (const args of stepMarkerCalls) {
      const content = JSON.parse(args[3] as string) as { step: string; rig: string; date: string };
      expect(content.step).toBeTruthy();
      expect(content.rig).toBe('resume-rig');
      expect(content.date).toBe(today);
    }
  });

  it('skips already-completed steps when progress markers exist', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // Simulate prior run that completed classify_beads, aaak_manifest, mine_patterns
    const completedSteps = ['classify_beads', 'aaak_manifest', 'mine_patterns', 'generate_playbooks', 'update_routing_kg', 'detect_tunnels'];
    searchSpy.mockResolvedValue({
      results: completedSteps.map((step) => ({
        id: `marker-${step}`,
        content: JSON.stringify({ step, rig: 'resume-rig', date: today, count: 1, completed_at: new Date().toISOString() }),
      })),
      total: completedSteps.length,
    });

    await historian.runNightly('resume-rig');

    // All steps were already completed — no new addDrawer step markers written
    const stepMarkerCalls = addDrawerSpy.mock.calls.filter(
      (args) => (args[0] as string) === 'wing_historian' && (args[1] as string) === 'hall_events',
    );
    // Only mine_patterns is always re-computed (it's not skipped — it's cheap)
    // but classify_beads, aaak_manifest, generate_playbooks, etc. should be skipped
    const skippedStepMakers = stepMarkerCalls.filter((args) => {
      const roomId = args[2] as string;
      return roomId.includes('classify_beads') || roomId.includes('generate_playbooks');
    });
    expect(skippedStepMakers.length).toBe(0);
  });

  it('runs all steps when no prior progress markers exist', async () => {
    // Default: search returns no results (no prior markers)
    await historian.runNightly('resume-rig');

    // At least classify_beads step marker should be written
    const stepMarkerCalls = addDrawerSpy.mock.calls.filter(
      (args) =>
        (args[0] as string) === 'wing_historian' &&
        (args[1] as string) === 'hall_events' &&
        ((args[2] as string) as string).includes('classify_beads'),
    );
    expect(stepMarkerCalls.length).toBeGreaterThan(0);
  });
});
