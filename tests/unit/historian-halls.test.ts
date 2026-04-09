// Tests: Historian hall classification and PII stripping (HISTORIAN.md)

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Historian } from '../../src/roles/historian';
import { Ledger } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

const TEST_RIGS = path.join(os.tmpdir(), `nos-historian-halls-${Date.now()}`);
const TEST_KG = path.join(os.tmpdir(), `nos-historian-halls-${Date.now()}.sqlite`);

// Track all addDrawer calls so we can assert hall routing
const drawerCalls: Array<{ wing: string; hall: string; roomId: string; content: string }> = [];
const mockAddDrawer = jest.fn().mockImplementation(
  async (wing: string, hall: string, roomId: string, content: string) => {
    drawerCalls.push({ wing, hall, roomId, content });
    return { id: `drawer_${Date.now()}` };
  },
);

jest.mock('../../src/mempalace/client', () => ({
  MemPalaceClient: jest.fn().mockImplementation(() => ({
    addDrawer: mockAddDrawer,
    search: jest.fn().mockResolvedValue({ results: [] }),
    diaryWrite: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify({ title: 'Test Playbook', steps: ['Step 1'] }) } }],
          usage: { prompt_tokens: 20, completion_tokens: 30 },
        }),
      },
    },
  })),
}));

let historian: Historian;
let ledger: Ledger;

const RIG = `halls-rig-${Date.now()}`;

beforeAll(() => {
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  process.env.NOS_RIGS_ROOT = TEST_RIGS;

  ledger = new Ledger(TEST_RIGS);
  historian = new Historian({
    agentId: 'historian_halls',
    kgPath: TEST_KG,
  });
});

afterAll(() => {
  historian.close();
  fs.rmSync(TEST_KG, { force: true });
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  delete process.env.NOS_RIGS_ROOT;
  jest.restoreAllMocks();
});

beforeEach(() => {
  drawerCalls.length = 0;
  mockAddDrawer.mockClear();
});

async function seedBeads(beads: Partial<Bead>[]): Promise<void> {
  for (const partial of beads) {
    const bead = Ledger.createBead({
      role: partial.role ?? 'polecat',
      task_type: partial.task_type ?? 'implement',
      task_description: partial.task_description ?? 'do something',
      model: partial.model ?? 'llama-3.1-8b-instant',
      needs: partial.needs ?? [],
      critical_path: partial.critical_path ?? false,
      witness_required: partial.witness_required ?? false,
      fan_out_weight: partial.fan_out_weight ?? 1,
      rig: RIG,
      status: partial.status ?? 'done',
    });
    const done = { ...bead, status: 'done' as const, outcome: 'SUCCESS' as const, ...partial };
    await ledger.appendBead(RIG, done);
  }
}

describe('Historian hall classification', () => {
  it('writes all resolved beads to hall_events', async () => {
    await seedBeads([
      { task_type: 'implement', task_description: 'Write auth module' },
      { task_type: 'test', task_description: 'Run unit tests' },
    ]);

    await historian.runNightly(RIG);

    const eventCalls = drawerCalls.filter((c) => c.hall === 'hall_events');
    expect(eventCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('writes beads with prerequisites to hall_discoveries', async () => {
    const prerequisiteBead = Ledger.createBead({
      role: 'polecat', task_type: 'research', model: 'llama-3.1-8b-instant',
      needs: [], critical_path: false, witness_required: false, fan_out_weight: 1,
      rig: RIG, status: 'done',
    });
    await ledger.appendBead(RIG, { ...prerequisiteBead, status: 'done', outcome: 'SUCCESS' });

    const dependentBead = Ledger.createBead({
      role: 'polecat', task_type: 'implement',
      model: 'llama-3.1-8b-instant',
      needs: [prerequisiteBead.bead_id],  // has a prerequisite
      critical_path: false, witness_required: false, fan_out_weight: 1,
      rig: RIG, status: 'done',
    });
    await ledger.appendBead(RIG, { ...dependentBead, status: 'done', outcome: 'SUCCESS' });

    drawerCalls.length = 0;
    await historian.runNightly(RIG);

    const discoveryCalls = drawerCalls.filter((c) => c.hall === 'hall_discoveries');
    expect(discoveryCalls.length).toBeGreaterThan(0);
  });

  it('writes successful beads to hall_preferences', async () => {
    await seedBeads([{ task_type: 'unit_test', model: 'llama-3.1-8b-instant', outcome: 'SUCCESS' as const }]);

    drawerCalls.length = 0;
    await historian.runNightly(RIG);

    const prefCalls = drawerCalls.filter((c) => c.hall === 'hall_preferences');
    expect(prefCalls.length).toBeGreaterThan(0);
    const content = JSON.parse(prefCalls[0].content);
    expect(content.outcome).toBe('SUCCESS');
  });
});

describe('Historian PII stripping', () => {
  it('strips API keys from bead content before writing to palace', async () => {
    await seedBeads([{
      task_type: 'implement',
      task_description: 'Fetch from https://api.example.com with key gsk_abcdefghijklmnopqrstuvwxyz0123456789',
    }]);

    drawerCalls.length = 0;
    await historian.runNightly(RIG);

    const eventCalls = drawerCalls.filter((c) => c.hall === 'hall_events');
    for (const call of eventCalls) {
      expect(call.content).not.toMatch(/gsk_/);
      expect(call.content).not.toMatch(/abcdefghijklmnopqrstuvwxyz/);
    }
  });

  it('strips email addresses from bead content', async () => {
    await seedBeads([{
      task_type: 'notify',
      task_description: 'Send report to admin@example.com and devops@company.org',
    }]);

    drawerCalls.length = 0;
    await historian.runNightly(RIG);

    const eventCalls = drawerCalls.filter((c) => c.hall === 'hall_events');
    for (const call of eventCalls) {
      expect(call.content).not.toMatch(/admin@example\.com/);
      expect(call.content).not.toMatch(/devops@company\.org/);
    }
  });
});
