// Tests: Mayor playbook → routing lock
// With MemPalace removed, playbook routing requires explicit PlaybookEntry injection.
// These tests verify: KG routing lock, complexity-based fallback (no playbook).

jest.mock('groq-sdk', () => {
  const mockCreate = jest.fn();
  (globalThis as Record<string, unknown>).__mayorRlMockCreate = mockCreate;
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
import { Mayor } from '../../src/roles/mayor';
import { generateKeyPair } from '../../src/convoys/sign';

const TEST_KEY_DIR = path.join(os.tmpdir(), `nos-rl-keys-${Date.now()}`);
const TEST_RIGS_ROOT = path.join(os.tmpdir(), `nos-rl-rigs-${Date.now()}`);
const TEST_DB = path.join(os.tmpdir(), `nos-rl-kg-${Date.now()}.sqlite`);

function getMock(): jest.Mock {
  return (globalThis as Record<string, unknown>).__mayorRlMockCreate as jest.Mock;
}

function makeDecomposeResult(taskType = 'execute', role = 'polecat') {
  return JSON.stringify({
    beads: [{
      task_type: taskType,
      task_description: 'A task',
      role,
      needs: [],
      critical_path: false,
      witness_required: false,
      fan_out_weight: 1,
    }],
  });
}

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  process.env.NOS_RIGS_ROOT = TEST_RIGS_ROOT;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  fs.mkdirSync(TEST_RIGS_ROOT, { recursive: true });
  await generateKeyPair('mayor_rl_test');
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_RIGS_ROOT, { recursive: true, force: true });
  fs.rmSync(TEST_DB, { force: true });
  jest.restoreAllMocks();
});

describe('Mayor routing lock via RoutingDispatcher', () => {
  let mayor: Mayor;

  beforeEach(() => {
    getMock().mockReset();
    mayor = new Mayor({
      agentId: 'mayor_rl_test',
      rigName: 'rl-test-rig',
      kgPath: TEST_DB,
    });
  });

  afterEach(() => {
    mayor.close();
    jest.restoreAllMocks();
  });

  it('uses complexity routing when no KG lock or playbook is present', async () => {
    getMock().mockResolvedValue({
      choices: [{ message: { content: makeDecomposeResult('execute', 'polecat') } }],
    });

    const plan = await mayor.orchestrate({ description: 'Execute something' });

    // Without a playbook or KG lock, complexity routing applies
    expect(plan.beads[0].model).toBeTruthy();
    expect(plan.beads.length).toBeGreaterThan(0);
  });

  it('RoutingDispatcher uses KG lock when present', async () => {
    const { KnowledgeGraph } = await import('../../src/kg/index');
    const kg = new KnowledgeGraph(TEST_DB);
    const today = new Date().toISOString().slice(0, 10);

    // Write a KG routing lock: llama-3.3-70b → locked_to → security
    kg.addTriple({
      subject: 'llama-3.3-70b-versatile',
      relation: 'locked_to',
      object: 'security',
      valid_from: today,
      agent_id: 'historian',
      metadata: { class: 'critical', success_rate: 0.97, sample_size: 100 },
      created_at: new Date().toISOString(),
    });
    kg.close();

    getMock().mockResolvedValue({
      choices: [{ message: { content: makeDecomposeResult('security', 'polecat') } }],
    });

    const plan = await mayor.orchestrate({ description: 'Security scan', task_type: 'security' });

    const secBead = plan.beads.find((b) => b.task_type === 'security');
    expect(secBead?.model).toBe('llama-3.3-70b-versatile');
  });
});
