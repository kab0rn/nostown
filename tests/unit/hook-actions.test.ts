// Tests: Hook action handlers — MCP_TOOL, CONVOY, KG_QUERY, CUSTOM (Gate 5)

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { buildActionExecutor } from '../../src/hooks/actions';
import { runMatchingHooks } from '../../src/hooks/executor';
import { KnowledgeGraph } from '../../src/kg/index';
import { kgQuery } from '../../src/kg/tools';
import type { Hook, BeadEvent } from '../../src/types/index';

const TEST_KG = path.join(os.tmpdir(), `nos-hook-actions-${Date.now()}.sqlite`);

const SAMPLE_EVENT: BeadEvent = {
  type: 'BEAD_RESOLVED',
  beadId: 'bead-hook-test-1',
  outcome: 'SUCCESS',
  timestamp: '2026-04-09T12:00:00Z',
  role: 'polecat',
  modelId: 'llama-3.1-8b-instant',
};

let kg: KnowledgeGraph;

beforeAll(() => {
  kg = new KnowledgeGraph(TEST_KG);
});

afterAll(() => {
  kg.close();
  fs.rmSync(TEST_KG, { force: true });
  jest.restoreAllMocks();
});

describe('buildActionExecutor — MCP_TOOL handler', () => {
  it('historian_append writes to KG when kg is configured', async () => {
    const executor = buildActionExecutor({ kg });

    await executor(
      {
        type: 'MCP_TOOL',
        payload: {
          tool: 'historian_append',
          args: {
            beadId: SAMPLE_EVENT.beadId,
            outcome: SAMPLE_EVENT.outcome,
            timestamp: SAMPLE_EVENT.timestamp,
          },
        },
      },
      SAMPLE_EVENT,
    );

    const triples = kgQuery(kg, {
      subject: SAMPLE_EVENT.beadId,
      relation: 'historian_append',
    });
    expect(triples.some((t) => t.object === SAMPLE_EVENT.outcome)).toBe(true);
  });

  it('kg_add inserts a triple into the KG', async () => {
    const executor = buildActionExecutor({ kg });

    await executor(
      {
        type: 'MCP_TOOL',
        payload: {
          tool: 'kg_add',
          args: {
            subject: 'hook-model',
            relation: 'completed',
            object: SAMPLE_EVENT.beadId,
            agent_id: 'hook_test',
          },
        },
      },
      SAMPLE_EVENT,
    );

    const triples = kgQuery(kg, { subject: 'hook-model', relation: 'completed' });
    expect(triples.some((t) => t.object === SAMPLE_EVENT.beadId)).toBe(true);
  });

  it('CUSTOM handler with no registered handler logs a warning (no throw)', async () => {
    const executor = buildActionExecutor({});
    // Should not throw even though no custom handler is registered
    await expect(
      executor({ type: 'CUSTOM', payload: { handler: 'nonexistent_handler' } }, SAMPLE_EVENT),
    ).resolves.not.toThrow();
  });

  it('CUSTOM handler calls registered custom function', async () => {
    const calls: string[] = [];
    const customHandlers = new Map([
      ['my_custom_tool', async (name: string) => { calls.push(name); }],
    ]);

    const executor = buildActionExecutor({ customHandlers });
    await executor(
      { type: 'CUSTOM', payload: { handler: 'my_custom_tool' } },
      SAMPLE_EVENT,
    );

    expect(calls).toEqual(['my_custom_tool']);
  });
});

describe('buildActionExecutor — KG_QUERY handler', () => {
  it('runs without throwing when kg is provided', async () => {
    const executor = buildActionExecutor({ kg });
    await expect(
      executor(
        {
          type: 'KG_QUERY',
          payload: { query: 'model_performance', args: { subject: SAMPLE_EVENT.beadId } },
        },
        SAMPLE_EVENT,
      ),
    ).resolves.not.toThrow();
  });

  it('runs without throwing when kg is not provided', async () => {
    const executor = buildActionExecutor({});
    await expect(
      executor({ type: 'KG_QUERY', payload: { query: 'test', args: {} } }, SAMPLE_EVENT),
    ).resolves.not.toThrow();
  });
});

describe('runMatchingHooks with real action executor', () => {
  it('executes kg_add hook via real executor, triple visible in KG', async () => {
    const hooks: Hook[] = [
      {
        id: 'hook_kg_add_on_resolve',
        role: 'Historian',
        trigger: { event: 'BEAD_RESOLVED' },
        action: {
          type: 'MCP_TOOL',
          payload: {
            tool: 'kg_add',
            args: {
              subject: '{{event.modelId}}',
              relation: 'resolved',
              object: '{{event.beadId}}',
              agent_id: 'hook_integration',
            },
          },
        },
        enabled: true,
        priority: 10,
      },
    ];

    const executor = buildActionExecutor({ kg });
    await runMatchingHooks(hooks, SAMPLE_EVENT, executor);

    const triples = kgQuery(kg, {
      subject: SAMPLE_EVENT.modelId ?? SAMPLE_EVENT.beadId,
      relation: 'resolved',
    });
    expect(triples.some((t) => t.object === SAMPLE_EVENT.beadId)).toBe(true);
  });
});
