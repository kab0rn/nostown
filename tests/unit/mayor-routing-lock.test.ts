// Tests: Mayor playbook → routing lock
// When a fresh playbook is found with model_hint, RoutingDispatcher selects
// that model for matching beads (ROUTING.md §Playbook Shortcut).

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
import { MemPalaceClient } from '../../src/mempalace/client';
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

  it('uses RoutingDispatcher model when no playbook (complexity routing)', async () => {
    getMock()
      .mockRejectedValueOnce(new Error('palace offline'))
      .mockResolvedValueOnce({ choices: [{ message: { content: makeDecomposeResult('execute', 'polecat') } }] });

    jest.spyOn(MemPalaceClient.prototype, 'wakeup').mockRejectedValue(new Error('offline'));
    jest.spyOn(MemPalaceClient.prototype, 'search').mockRejectedValue(new Error('offline'));
    jest.spyOn(MemPalaceClient.prototype, 'saveCheckpoint').mockResolvedValue('ckpt-rl-001');

    const plan = await mayor.orchestrate({ description: 'Execute something' });

    // Without a playbook, complexity routing for 'execute' role 'polecat' = medium → L4S
    expect(plan.beads[0].model).toBeTruthy();
    expect(plan.beads.length).toBeGreaterThan(0);
  });

  it('locks model to playbook hint when fresh playbook found', async () => {
    const playbookContent = JSON.stringify({
      id: 'pb-001',
      title: 'Execute Playbook',
      task_type: 'execute',
      steps: ['Step 1', 'Step 2'],
      model_hint: 'llama-3.3-70b-versatile',
      success_rate: 0.95,
      sample_size: 50,
      last_updated: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    getMock().mockResolvedValue({
      choices: [{ message: { content: makeDecomposeResult('execute', 'polecat') } }],
    });

    jest.spyOn(MemPalaceClient.prototype, 'wakeup').mockRejectedValue(new Error('offline'));
    const pbEntry = { id: 'pb-001', content: playbookContent, wing_id: 'wing_rig_rl-test-rig', hall_type: 'hall_advice', room_id: 'playbook_execute', created_at: new Date().toISOString() };
    jest.spyOn(MemPalaceClient.prototype, 'search')
      .mockResolvedValueOnce({ results: [pbEntry], total: 1 })
      .mockResolvedValue({ results: [], total: 0 }); // rejection search returns none
    jest.spyOn(MemPalaceClient.prototype, 'saveCheckpoint').mockResolvedValue('ckpt-rl-002');

    const plan = await mayor.orchestrate({ description: 'Execute task', task_type: 'execute' });

    // RoutingDispatcher with playbookHit for execute → should use model_hint
    const bead = plan.beads[0];
    expect(bead.model).toBe('llama-3.3-70b-versatile');
  });

  it('falls back to complexity routing when playbook is stale (low success_rate)', async () => {
    const stalePlaybook = JSON.stringify({
      id: 'pb-stale',
      title: 'Stale Playbook',
      task_type: 'execute',
      steps: [],
      model_hint: 'llama-3.3-70b-versatile',
      success_rate: 0.60,  // below 90% threshold → stale
      sample_size: 50,
      last_updated: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    getMock().mockResolvedValue({
      choices: [{ message: { content: makeDecomposeResult('execute', 'polecat') } }],
    });

    jest.spyOn(MemPalaceClient.prototype, 'wakeup').mockRejectedValue(new Error('offline'));
    const stalePbEntry = { id: 'pb-stale', content: stalePlaybook, wing_id: 'wing_rig_rl-test-rig', hall_type: 'hall_advice', room_id: 'playbook_execute', created_at: new Date().toISOString() };
    jest.spyOn(MemPalaceClient.prototype, 'search')
      .mockResolvedValueOnce({ results: [stalePbEntry], total: 1 })
      .mockResolvedValue({ results: [], total: 0 });
    jest.spyOn(MemPalaceClient.prototype, 'saveCheckpoint').mockResolvedValue('ckpt-rl-003');

    const plan = await mayor.orchestrate({ description: 'Execute task', task_type: 'execute' });

    // Stale playbook → advisory only → activePlaybook NOT set → complexity routing
    // execute/polecat → medium complexity → meta-llama/llama-4-scout model
    const bead = plan.beads[0];
    // Should NOT be the playbook's locked model (llama-3.3-70b-versatile)
    // Complexity routing for execute → medium → llama-4-scout
    expect(bead.model).not.toBe('llama-3.3-70b-versatile');
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

    jest.spyOn(MemPalaceClient.prototype, 'wakeup').mockRejectedValue(new Error('offline'));
    jest.spyOn(MemPalaceClient.prototype, 'search').mockRejectedValue(new Error('offline'));
    jest.spyOn(MemPalaceClient.prototype, 'saveCheckpoint').mockResolvedValue('ckpt-rl-004');

    const plan = await mayor.orchestrate({ description: 'Security scan', task_type: 'security' });

    const secBead = plan.beads.find((b) => b.task_type === 'security');
    expect(secBead?.model).toBe('llama-3.3-70b-versatile');
  });
});
