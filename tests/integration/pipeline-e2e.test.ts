// Gate 8: Full pipeline integration — Mayor → Polecat → Witness (all mocked Groq)
// Verifies that the three core roles compose correctly without a real LLM.

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Mayor } from '../../src/roles/mayor';
import { Polecat } from '../../src/roles/polecat';
import type { ExecutionContext } from '../../src/roles/polecat';
import { Witness } from '../../src/roles/witness';
import { KnowledgeGraph } from '../../src/kg/index';
import { kgInsert, kgQuery } from '../../src/kg/tools';
import type { Bead } from '../../src/types/index';
import { Ledger } from '../../src/ledger/index';

// ---------- Shared mock state ----------
const diaryWriteCalls: string[] = [];
let checkpointIdCounter = 0;

jest.mock('../../src/mempalace/client', () => ({
  MemPalaceClient: jest.fn().mockImplementation(() => ({
    wakeup: jest.fn().mockResolvedValue({ l0: '', l1: '' }),
    search: jest.fn().mockResolvedValue({ results: [] }),
    saveCheckpoint: jest.fn().mockImplementation(async () => `checkpoint_${++checkpointIdCounter}`),
    addDrawer: jest.fn().mockResolvedValue({ id: 'drawer_mock' }),
    diaryRead: jest.fn().mockResolvedValue([]),
    diaryWrite: jest.fn().mockImplementation(async (_wing: string, content: string) => {
      diaryWriteCalls.push(content);
    }),
  })),
}));

// Groq mock — dispatches by system prompt keyword
jest.mock('groq-sdk', () => {
  const mockCreate = jest.fn().mockImplementation(
    async (params: { messages: Array<{ role: string; content: string }> }) => {
      const sysMsg = params.messages[0]?.content ?? '';

      if (sysMsg.includes('Mayor orchestrator')) {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                beads: [
                  {
                    task_type: 'implement',
                    task_description: 'Write the feature',
                    role: 'polecat',
                    needs: [],
                    critical_path: true,
                    witness_required: true,
                    fan_out_weight: 1,
                    priority: 'high',
                  },
                  {
                    task_type: 'review',
                    task_description: 'Review the implementation',
                    role: 'witness',
                    needs: [],
                    critical_path: true,
                    witness_required: false,
                    fan_out_weight: 1,
                    priority: 'medium',
                  },
                ],
              }),
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 200 },
        };
      }

      if (sysMsg.includes('polecat') || sysMsg.includes('Polecat') || sysMsg.includes('execute')) {
        return {
          choices: [{
            message: {
              content: '--- a/feature.ts\n+++ b/feature.ts\n@@ -0,0 +1,3 @@\n+export function hello() {\n+  return "world";\n+}\n',
            },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 100 },
        };
      }

      // Witness judge
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              approved: true,
              comment: 'Implementation looks correct and meets requirements.',
              score: 0.9,
            }),
          },
        }],
        usage: { prompt_tokens: 80, completion_tokens: 60 },
      };
    },
  );

  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    })),
  };
});

// ---------- Test fixtures ----------
const TEST_KG = path.join(os.tmpdir(), `nos-e2e-${Date.now()}.sqlite`);
const TEST_RIGS = path.join(os.tmpdir(), `nos-e2e-rigs-${Date.now()}`);

let kg: KnowledgeGraph;
let ledger: Ledger;
let mayor: Mayor;
let polecat: Polecat;
let witness: Witness;

beforeAll(() => {
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  process.env.NOS_RIGS_ROOT = TEST_RIGS;

  kg = new KnowledgeGraph(TEST_KG);
  ledger = new Ledger(TEST_RIGS);

  mayor = new Mayor({
    agentId: 'mayor_e2e',
    rigName: 'e2e-rig',
    groqApiKey: 'test-key',
    kgPath: TEST_KG,
  });

  polecat = new Polecat({
    agentId: 'polecat_e2e',
    rigName: 'e2e-rig',
    groqApiKey: 'test-key',
  });

  witness = new Witness({
    agentId: 'witness_e2e',
    rigName: 'e2e-rig',
    groqApiKey: 'test-key',
    kgPath: TEST_KG,
  });
});

afterAll(() => {
  mayor.close();
  kg.close();
  fs.rmSync(TEST_KG, { force: true });
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  delete process.env.NOS_RIGS_ROOT;
});

describe('Gate 8: Full pipeline integration', () => {
  it('Mayor decomposes task into beads with checkpoint', async () => {
    const plan = await mayor.orchestrate({
      description: 'Add hello() feature to feature.ts',
      task_type: 'implement',
      critical_path: true,
    });

    expect(plan.checkpoint_id).toMatch(/^checkpoint_/);
    expect(plan.beads.length).toBeGreaterThanOrEqual(1);

    // All beads must carry the checkpoint ID (MAYOR_CHECKPOINT_MISSING guard)
    for (const bead of plan.beads) {
      expect(bead.plan_checkpoint_id).toBe(plan.checkpoint_id);
    }
  });

  it('Polecat executes a bead and marks it completed', async () => {
    const bead: Bead = Ledger.createBead({
      role: 'polecat',
      task_type: 'implement',
      task_description: 'Write hello() function',
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      needs: [],
      critical_path: true,
      witness_required: false,
      fan_out_weight: 1,
      rig: 'e2e-rig',
      status: 'pending',
      plan_checkpoint_id: 'checkpoint_e2e_001',
    });

    // Write bead to ledger so prereq check has something to find
    await ledger.appendBead('e2e-rig', bead);

    const ctx: ExecutionContext = {
      task_description: 'Write hello() function in feature.ts',
    };
    const result = await polecat.execute(bead, ctx);

    expect(['done', 'blocked']).toContain(result.status);
    // Without prerequisite failures, should be done
    expect(result.status).toBe('done');
    expect(result.outcome).toBe('SUCCESS');
  });

  it('Witness reviews output and returns approval verdict', async () => {
    const diff = '--- a/feature.ts\n+++ b/feature.ts\n@@ -0,0 +1 @@\n+export function hello() { return "world"; }';
    const verdict = await witness.review(
      diff,
      'Function hello() must return "world"',
      'pr-e2e-001',
    );

    expect(verdict.approved).toBe(true);
    expect(typeof verdict.score).toBe('string');
    expect(typeof verdict.reason).toBe('string');
    expect(verdict.votes.length).toBeGreaterThanOrEqual(1);
  });

  it('Witness writes diary entry after verdict', () => {
    // diaryWriteCalls is populated by the mock when diaryWrite is called
    const prEntry = diaryWriteCalls.find((c) => c.includes('pr-e2e-001'));
    expect(prEntry).toBeDefined();
    expect(prEntry).toMatch(/APPROVED|REJECTED/);
  });

  it('KG can track pipeline execution triple', () => {
    kgInsert(kg, {
      subject: 'polecat_e2e',
      relation: 'executed',
      object: 'e2e-bead-001',
      agent_id: 'pipeline_test',
    });

    const triples = kgQuery(kg, { subject: 'polecat_e2e', relation: 'executed' });
    expect(triples.some((t) => t.object === 'e2e-bead-001')).toBe(true);
  });

  it('Mayor CoVe escalates witness_required when past rejections exist', async () => {
    const { MemPalaceClient } = await import('../../src/mempalace/client');
    // Mayor's palace instance is the first one created
    const mayorPalace = (MemPalaceClient as jest.Mock).mock.results[0]?.value;
    if (mayorPalace) {
      // Step 1b (AAAK manifest): no manifest stored yet
      mayorPalace.search
        .mockResolvedValueOnce({ results: [] })
        // Step 3 (playbooks): empty
        .mockResolvedValueOnce({ results: [] })
        // Step 3c (CoVe): contains a rejection event
        .mockResolvedValueOnce({
          results: [{ id: 'evt_1', content: 'BEAD_RESOLVED: rejected — quality below threshold' }],
        });
    }

    const plan = await mayor.orchestrate({
      description: 'risky task with past rejections',
      task_type: 'implement',
      critical_path: true,
    });

    // All critical_path beads must have witness_required = true after CoVe escalation
    const criticalBeads = plan.beads.filter((b) => b.critical_path);
    expect(criticalBeads.length).toBeGreaterThan(0);
    for (const bead of criticalBeads) {
      expect((bead as { witness_required?: boolean }).witness_required).toBe(true);
    }
  });
});
