// Tests: Mayor playbook freshness guard (ROUTING.md §Playbook Freshness Guard)

import { Mayor } from '../../src/roles/mayor';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const TEST_RIGS = path.join(os.tmpdir(), `nos-freshness-rigs-${Date.now()}`);
const TEST_KG = path.join(os.tmpdir(), `nos-freshness-kg-${Date.now()}.sqlite`);

// ── Palace mock — we'll override search responses per-test ──────────────────
const mockSearch = jest.fn();
const mockSaveCheckpoint = jest.fn().mockResolvedValue('checkpoint_fresh_01');

jest.mock('../../src/mempalace/client', () => ({
  MemPalaceClient: jest.fn().mockImplementation(() => ({
    wakeup: jest.fn().mockResolvedValue({ l0: '', l1: '' }),
    search: mockSearch,
    saveCheckpoint: mockSaveCheckpoint,
    addDrawer: jest.fn().mockResolvedValue({ id: 'drawer_mock' }),
    diaryRead: jest.fn().mockResolvedValue([]),
    diaryWrite: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Groq mock — returns a minimal valid bead plan
jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                beads: [{
                  task_type: 'implement',
                  task_description: 'Do the thing',
                  role: 'polecat',
                  needs: [],
                  critical_path: true,
                  witness_required: false,
                  fan_out_weight: 1,
                }],
              }),
            },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 100 },
        }),
      },
    },
  })),
}));

let mayor: Mayor;

beforeAll(() => {
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  process.env.NOS_RIGS_ROOT = TEST_RIGS;

  mayor = new Mayor({
    agentId: 'mayor_freshness',
    rigName: 'freshness-rig',
    groqApiKey: 'test-key',
    kgPath: TEST_KG,
  });
});

afterAll(() => {
  mayor.close();
  fs.rmSync(TEST_KG, { force: true });
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  delete process.env.NOS_RIGS_ROOT;
  jest.restoreAllMocks();
});

beforeEach(() => {
  mockSearch.mockReset();
  mockSaveCheckpoint.mockResolvedValue('checkpoint_fresh_01');
});

describe('Mayor playbook freshness guard', () => {
  it('uses playbook hint when no recent rejections exist', async () => {
    // AAAK manifest search (hall_facts) → no manifest stored yet
    mockSearch
      .mockResolvedValueOnce({ results: [] })
      // First search: playbook match (hall_advice)
      .mockResolvedValueOnce({ results: [{ id: 'pb_1', content: 'Steps: 1. Foo 2. Bar' }] })
      // Second search: freshness check (hall_events) — no rejections
      .mockResolvedValueOnce({ results: [{ id: 'ev_1', content: 'BEAD_RESOLVED: SUCCESS' }] })
      // Third search: CoVe rejections (hall_events again)
      .mockResolvedValueOnce({ results: [] });

    const plan = await mayor.orchestrate({
      description: 'standard task',
      task_type: 'implement',
    });

    expect(plan.checkpoint_id).toBeDefined();
    // Plan should succeed and include beads
    expect(plan.beads.length).toBeGreaterThan(0);

    // Check that the last decompose call got a NON-advisory playbook hint
    // (we can't directly inspect the prompt, but a plan was created without error)
    expect(plan.checkpoint_id).toMatch(/^checkpoint_/);
  });

  it('marks playbook advisory-only when recent Witness rejection exists', async () => {
    // AAAK manifest search → no manifest
    mockSearch
      .mockResolvedValueOnce({ results: [] })
      // First search: playbook match
      .mockResolvedValueOnce({ results: [{ id: 'pb_1', content: 'Steps: 1. Foo 2. Bar' }] })
      // Second search: freshness check — has a rejection event
      .mockResolvedValueOnce({
        results: [{ id: 'ev_rej', content: 'PR review: REJECTED — quality below threshold' }],
      })
      // Third search: CoVe check
      .mockResolvedValueOnce({ results: [] });

    // Spy on console.log to detect the advisory-only log message
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const plan = await mayor.orchestrate({
      description: 'risky task with recent rejection',
      task_type: 'implement',
    });

    expect(plan.beads.length).toBeGreaterThan(0);
    // Should have logged a freshness failure
    const logged = logSpy.mock.calls.flat().join(' ');
    expect(logged).toMatch(/freshness check failed|Playbook freshness/i);

    logSpy.mockRestore();
  });

  it('proceeds without a playbook when no match found', async () => {
    // AAAK manifest search → no manifest; then playbook search → no match; CoVe → empty
    mockSearch
      .mockResolvedValueOnce({ results: [] }) // AAAK
      .mockResolvedValueOnce({ results: [] }) // no playbook
      // CoVe check
      .mockResolvedValueOnce({ results: [] });

    const plan = await mayor.orchestrate({
      description: 'novel task with no playbook',
      task_type: 'explore',
    });

    expect(plan.beads.length).toBeGreaterThan(0);
    expect(plan.checkpoint_id).toBeDefined();
  });
});

describe('KG safeguard_lockdown blocks playbook freshness', () => {
  it('marks playbook advisory when safeguard_lockdown triple exists', async () => {
    // Insert a lockdown triple for this task type into the KG
    const { KnowledgeGraph } = await import('../../src/kg/index');
    const { kgInsert } = await import('../../src/kg/tools');
    const kg = new KnowledgeGraph(TEST_KG);
    kgInsert(kg, {
      subject: 'security',
      relation: 'safeguard_lockdown',
      object: 'security-rig',
      agent_id: 'safeguard_01',
      metadata: { class: 'critical', pattern: 'sql_injection' },
    });
    kg.close();

    // Playbook found, no rejection events
    mockSearch
      .mockResolvedValueOnce({ results: [] }) // AAAK manifest → no manifest
      .mockResolvedValueOnce({ results: [{ id: 'pb_sec', content: 'Security steps' }] })
      .mockResolvedValueOnce({ results: [] })  // freshness: no rejections
      .mockResolvedValueOnce({ results: [] }); // CoVe

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const secureMayor = new Mayor({
      agentId: 'mayor_sec',
      rigName: 'security',
      groqApiKey: 'test-key',
      kgPath: TEST_KG,
    });

    await secureMayor.orchestrate({ description: 'security task', task_type: 'security' });
    secureMayor.close();

    const logged = logSpy.mock.calls.flat().join(' ');
    expect(logged).toMatch(/freshness check failed|Playbook freshness|lockdown/i);

    logSpy.mockRestore();
  });
});
