// Tests: Historian nightly pipeline — historian_run triple label (GAP A2) and playbook_match (GAP M1)

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                title: 'Test Playbook',
                steps: ['step 1'],
                tips: ['tip 1'],
              }),
            },
          }],
          usage: { total_tokens: 100 },
        }),
      },
    },
  })),
}));

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Historian } from '../../src/roles/historian';
import { KnowledgeGraph } from '../../src/kg/index';
import { Ledger } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

const TMP = path.join(os.tmpdir(), `nos-historian-nightly-${Date.now()}`);

function freshSetup(label: string): { kgPath: string; rigsRoot: string; rigName: string } {
  const dir = path.join(TMP, label);
  fs.mkdirSync(dir, { recursive: true });
  return {
    kgPath: path.join(dir, 'kg.sqlite'),
    rigsRoot: path.join(dir, 'rigs'),
    rigName: `rig-${label}`,
  };
}

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    bead_id: `bead-${Math.random().toString(36).slice(2)}`,
    role: 'polecat',
    task_type: 'execute',
    model: 'llama-3.1-8b-instant',
    rig: 'test-rig',
    status: 'done',
    outcome: 'SUCCESS',
    needs: [],
    critical_path: false,
    witness_required: false,
    fan_out_weight: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metrics: { duration_ms: 1200 },
    ...overrides,
  };
}

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('historian_run triple label (GAP A2)', () => {
  it('writes subject=rigName, relation=historian_run, object=completed', async () => {
    const { kgPath, rigsRoot, rigName } = freshSetup('historian-run');
    process.env.NOS_RIGS_ROOT = rigsRoot;

    const ledger = new Ledger(rigsRoot);
    // Write enough beads for historian to run
    for (let i = 0; i < 5; i++) {
      await ledger.appendBead(rigName, makeBead({
        rig: rigName,
        outcome: i < 4 ? 'SUCCESS' : 'FAILURE',
      }));
    }

    const historian = new Historian({ agentId: 'historian_01', kgPath });
    await historian.runNightly(rigName);
    historian.close();

    const kg = new KnowledgeGraph(kgPath);
    const today = new Date().toISOString().slice(0, 10);
    const triples = kg.queryTriples(rigName, today, 'historian_run');
    kg.close();

    expect(triples.length).toBeGreaterThan(0);
    expect(triples[0].subject).toBe(rigName);
    expect(triples[0].relation).toBe('historian_run');
    expect(triples[0].object).toBe('completed');

    delete process.env.NOS_RIGS_ROOT;
  });

  it('does NOT write the old historian_wings/registered triple', async () => {
    const { kgPath, rigsRoot, rigName } = freshSetup('no-historian-wings');
    process.env.NOS_RIGS_ROOT = rigsRoot;

    const ledger = new Ledger(rigsRoot);
    await ledger.appendBead(rigName, makeBead({ rig: rigName }));

    const historian = new Historian({ agentId: 'historian_01', kgPath });
    await historian.runNightly(rigName);
    historian.close();

    const kg = new KnowledgeGraph(kgPath);
    const today = new Date().toISOString().slice(0, 10);
    const wingTriples = kg.queryTriples('historian_wings', today, 'registered');
    kg.close();

    expect(wingTriples).toHaveLength(0);

    delete process.env.NOS_RIGS_ROOT;
  });
});

describe('playbook_match stamping (GAP M1)', () => {
  it('beads with playbook_match get grouped in regression detection', async () => {
    const { kgPath, rigsRoot, rigName } = freshSetup('playbook-match');
    process.env.NOS_RIGS_ROOT = rigsRoot;

    const today = new Date().toISOString().slice(0, 10);

    // Pre-seed KG with a playbook triple at a high success rate
    const kg = new KnowledgeGraph(kgPath);
    kg.addTriple({
      subject: `rig_${rigName}`,
      relation: 'has_playbook',
      object: 'playbook_execute_pb-regression-01',
      valid_from: today,
      agent_id: 'historian_01',
      metadata: { class: 'advisory', success_rate: 0.95, sample_size: 30 },
      created_at: new Date().toISOString(),
    });
    kg.close();

    const ledger = new Ledger(rigsRoot);
    // Write beads with playbook_match pointing to the playbook — mostly failures = regression
    for (let i = 0; i < 5; i++) {
      await ledger.appendBead(rigName, makeBead({
        rig: rigName,
        task_type: 'execute',
        playbook_match: 'playbook_execute_pb-regression-01',
        outcome: 'FAILURE', // 100% fail → regression vs 95% stored
      }));
    }

    const historian = new Historian({ agentId: 'historian_01', kgPath });
    await historian.runNightly(rigName);
    historian.close();

    const kg2 = new KnowledgeGraph(kgPath);
    const regressionTriples = kg2.queryByRelation('playbook_regression', today);
    kg2.close();

    expect(regressionTriples.length).toBeGreaterThan(0);
    const regression = regressionTriples[0];
    expect(regression.subject).toBe('playbook_execute_pb-regression-01');
    expect(regression.object).toBe(rigName);
    const meta = regression.metadata as Record<string, unknown>;
    expect(typeof meta?.stored_rate).toBe('number');
    expect(typeof meta?.current_rate).toBe('number');
    expect(Number(meta.drop)).toBeGreaterThan(0.1);

    delete process.env.NOS_RIGS_ROOT;
  });

  it('does not write playbook_regression when success rate drop is ≤10%', async () => {
    const { kgPath, rigsRoot, rigName } = freshSetup('no-regression');
    process.env.NOS_RIGS_ROOT = rigsRoot;

    const today = new Date().toISOString().slice(0, 10);

    const kg = new KnowledgeGraph(kgPath);
    kg.addTriple({
      subject: `rig_${rigName}`,
      relation: 'has_playbook',
      object: 'playbook_execute_pb-stable-01',
      valid_from: today,
      agent_id: 'historian_01',
      metadata: { class: 'advisory', success_rate: 0.90, sample_size: 30 },
      created_at: new Date().toISOString(),
    });
    kg.close();

    const ledger = new Ledger(rigsRoot);
    // 85% success → drop of only 5% (≤10%) — should NOT trigger regression
    for (let i = 0; i < 7; i++) {
      await ledger.appendBead(rigName, makeBead({
        rig: rigName,
        task_type: 'execute',
        playbook_match: 'playbook_execute_pb-stable-01',
        outcome: i < 6 ? 'SUCCESS' : 'FAILURE',  // 6/7 ≈ 85.7%
      }));
    }

    const historian = new Historian({ agentId: 'historian_01', kgPath });
    await historian.runNightly(rigName);
    historian.close();

    const kg2 = new KnowledgeGraph(kgPath);
    const regressionTriples = kg2.queryByRelation('playbook_regression', today);
    kg2.close();

    expect(regressionTriples).toHaveLength(0);

    delete process.env.NOS_RIGS_ROOT;
  });
});
