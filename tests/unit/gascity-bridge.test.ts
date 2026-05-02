import { BdClient, type CommandRunner } from '../../src/gascity/bd';
import { runGasCityBridge } from '../../src/gascity/bridge';
import { CONSENSUS_METADATA_KEYS } from '../../src/gascity/metadata';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '../../src/providers/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

class FixedProvider implements ProviderAdapter {
  readonly model = 'fixed';

  constructor(readonly name: string, private readonly payload: Record<string, unknown>) {}

  async generateJson(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      provider: this.name,
      model: this.model,
      content: JSON.stringify(this.payload),
      latencyMs: 0,
    };
  }
}

class QueueProvider implements ProviderAdapter {
  readonly model = 'queue';
  private calls = 0;

  constructor(readonly name: string, private readonly payloads: Array<Record<string, unknown> | Error>) {}

  async generateJson(_request: ProviderRequest): Promise<ProviderResponse> {
    const payload = this.payloads[Math.min(this.calls, this.payloads.length - 1)];
    this.calls++;
    if (payload instanceof Error) throw payload;
    return {
      provider: this.name,
      model: this.model,
      content: JSON.stringify(payload),
      latencyMs: 0,
    };
  }
}

class SlowProvider implements ProviderAdapter {
  readonly name = 'slow';
  readonly model = 'slow-model';

  async generateJson(_request: ProviderRequest): Promise<ProviderResponse> {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      provider: this.name,
      model: this.model,
      content: JSON.stringify({ summary: 'too late' }),
      latencyMs: 100,
    };
  }
}

class HangingProvider implements ProviderAdapter {
  readonly name = 'hanging';
  readonly model = 'hanging-model';
  signalSeen: AbortSignal | undefined;

  async generateJson(request: ProviderRequest): Promise<ProviderResponse> {
    this.signalSeen = request.signal;
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
    });
  }
}

function runnerWithLog(log: Array<{ cmd: string; args: string[] }>): CommandRunner {
  return async (cmd, args) => {
    log.push({ cmd, args });
    if (args[0] === 'show') {
      return {
        stdout: JSON.stringify({
          id: args[2],
          title: 'Bridge bead',
          description: 'Run consensus',
          metadata: { target: 'main' },
        }),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('Gas City bridge', () => {
  const combDir = path.join(os.tmpdir(), `nos-comb-test-${Date.now()}`);
  const oldComb = process.env.NOS_COMB_DIR;

  beforeAll(() => {
    process.env.NOS_COMB_DIR = combDir;
  });

  afterAll(() => {
    if (oldComb === undefined) delete process.env.NOS_COMB_DIR;
    else process.env.NOS_COMB_DIR = oldComb;
    fs.rmSync(combDir, { recursive: true, force: true });
  });

  it('pure mode runs consensus without bd metadata writes', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const bd = new BdClient(runnerWithLog(calls));

    const result = await runGasCityBridge({
      schema: 'gascity.swarm.v1',
      bead_id: 'gc-123',
      mode: 'pure',
      workers: 3,
    }, {
      bd,
      providers: [new MockProviderAdapter('mock', { summary: 'done', recommendation: 'ship', confidence: 1, evidence: [] })],
      now: () => new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.metadata_written).toBeUndefined();
    expect(calls[0].args).toEqual(['show', '--id', 'gc-123', '--json']);
    expect(calls.some((call) => call.args[0] === 'update')).toBe(false);
  });

  it('apply mode writes only nos.consensus metadata', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const bd = new BdClient(runnerWithLog(calls));

    const result = await runGasCityBridge({
      schema: 'gascity.swarm.v1',
      bead_id: 'gc-123',
      mode: 'apply',
      workers: 3,
    }, {
      bd,
      providers: [new MockProviderAdapter('mock', { summary: 'done', recommendation: 'ship', confidence: 1, evidence: [] })],
      now: () => new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    const updates = calls.filter((call) => call.args[0] === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args).toContain('--json');
    expect(updates[0].args).toContain('--quiet');
    const allowedKeys = new Set<string>(CONSENSUS_METADATA_KEYS);
    for (let i = 0; i < updates[0].args.length; i++) {
      if (updates[0].args[i] !== '--set-metadata') continue;
      const keyValue = updates[0].args[i + 1];
      const key = keyValue.split('=', 1)[0];
      expect(allowedKeys.has(key)).toBe(true);
      expect(keyValue.startsWith('nos.consensus.')).toBe(true);
      expect(keyValue.startsWith('gc.')).toBe(false);
    }
  });

  it('rejects non-nos consensus metadata keys before calling bd', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const bd = new BdClient(runnerWithLog(calls));

    await expect(bd.setMetadata('gc-123', { 'gc.routed_to': 'nostown' })).rejects.toThrow(/refusing/);
    expect(calls.some((call) => call.args[0] === 'update')).toBe(false);
  });

  it('rejects unsupported nos consensus metadata keys before calling bd', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const bd = new BdClient(runnerWithLog(calls));

    await expect(bd.setMetadata('gc-123', { 'nos.consensus.extra': 'nope' })).rejects.toThrow(/unsupported/);
    expect(calls.some((call) => call.args[0] === 'update')).toBe(false);
  });

  it('preserves bd show JSON and text fallback failures', async () => {
    const bd = new BdClient(async (_cmd, args) => {
      if (args.includes('--json')) throw new Error('json lookup failed');
      throw new Error('text lookup failed');
    });

    await expect(bd.show('gc-404')).rejects.toThrow(/json=json lookup failed; text=text lookup failed/);
  });

  it('returns a structured error if apply metadata write fails after comb write', async () => {
    const bd = new BdClient(async (_cmd, args) => {
      if (args[0] === 'show') {
        return { stdout: JSON.stringify({ id: args[2], title: 'Bridge bead' }), stderr: '' };
      }
      if (args[0] === 'update') throw new Error('bd update failed');
      return { stdout: '', stderr: '' };
    });

    const result = await runGasCityBridge({
      schema: 'gascity.swarm.v1',
      bead_id: 'gc-123',
      mode: 'apply',
      workers: 3,
    }, {
      bd,
      providers: [new MockProviderAdapter('mock', { summary: 'done', recommendation: 'ship', confidence: 1, evidence: [] })],
      now: () => new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toContain('metadata apply failed');
    expect(result.comb_path && fs.existsSync(result.comb_path)).toBe(true);
  });

  it('marks quorum fallback as adjudicated instead of normal consensus', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const bd = new BdClient(runnerWithLog(calls));

    const result = await runGasCityBridge({
      schema: 'gascity.swarm.v1',
      bead_id: 'gc-123',
      mode: 'pure',
      strategy: 'first_quorum',
      quorumRatio: 0.8,
      workers: 3,
    }, {
      bd,
      providers: [
        new QueueProvider('a', [
          { summary: 'minority', confidence: 0.2 },
          { summary: 'arbiter winner', confidence: 0.95, evidence: [], adjudication_reason: 'best supported' },
        ]),
        new FixedProvider('b', { summary: 'winner', confidence: 0.9 }),
        new FixedProvider('c', { summary: 'winner', confidence: 0.9 }),
      ],
      now: () => new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('adjudicated');
    expect(result.consensus?.adjudicated).toBe(true);
    expect(result.consensus?.strategy).toBe('first_quorum');
    expect(result.consensus?.agreement).toBeCloseTo(2 / 3);
    expect(result.consensus?.winner.summary).toBe('arbiter winner');
    const comb = JSON.parse(fs.readFileSync(result.comb_path!, 'utf8')) as { arbiter?: Record<string, unknown> };
    expect(comb.arbiter?.provider).toBe('a');
    expect(comb.arbiter?.parsed).toBeDefined();
  });

  it('falls back to deterministic majority if arbiter fails', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const bd = new BdClient(runnerWithLog(calls));

    const result = await runGasCityBridge({
      schema: 'gascity.swarm.v1',
      bead_id: 'gc-123',
      mode: 'pure',
      strategy: 'first_quorum',
      quorumRatio: 0.8,
      workers: 3,
    }, {
      bd,
      providers: [
        new QueueProvider('a', [{ summary: 'minority', confidence: 0.2 }, new Error('arbiter offline')]),
        new FixedProvider('b', { summary: 'winner', confidence: 0.9 }),
        new FixedProvider('c', { summary: 'winner', confidence: 0.9 }),
      ],
      now: () => new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(result.status).toBe('adjudicated');
    expect(result.consensus?.winner.summary).toBe('winner');
    const comb = JSON.parse(fs.readFileSync(result.comb_path!, 'utf8')) as { arbiter?: Record<string, unknown> };
    expect(comb.arbiter?.fallback).toBe('deterministic_majority');
  });

  it('adjudicates majority when workers only produce a plurality', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const bd = new BdClient(runnerWithLog(calls));

    const result = await runGasCityBridge({
      schema: 'gascity.swarm.v1',
      bead_id: 'gc-123',
      mode: 'pure',
      strategy: 'majority',
      workers: 3,
    }, {
      bd,
      providers: [
        new QueueProvider('a', [
          { summary: 'candidate a', confidence: 0.3 },
          { summary: 'arbiter chose b', confidence: 0.8, evidence: [], adjudication_reason: 'best evidence' },
        ]),
        new FixedProvider('b', { summary: 'candidate b', confidence: 0.7 }),
        new FixedProvider('c', { summary: 'candidate c', confidence: 0.5 }),
      ],
      now: () => new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(result.status).toBe('adjudicated');
    expect(result.consensus?.adjudicated).toBe(true);
    expect(result.consensus?.winner.summary).toBe('arbiter chose b');
    expect(result.consensus?.agreement).toBeCloseTo(1 / 3);
  });

  it('marks deterministic fallback as plurality when arbiter fails without a majority', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const bd = new BdClient(runnerWithLog(calls));

    const result = await runGasCityBridge({
      schema: 'gascity.swarm.v1',
      bead_id: 'gc-123',
      mode: 'pure',
      strategy: 'majority',
      workers: 3,
    }, {
      bd,
      providers: [
        new QueueProvider('a', [{ summary: 'candidate a', confidence: 0.3 }, new Error('arbiter offline')]),
        new FixedProvider('b', { summary: 'candidate b', confidence: 0.7 }),
        new FixedProvider('c', { summary: 'candidate c', confidence: 0.5 }),
      ],
      now: () => new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(result.status).toBe('adjudicated');
    const comb = JSON.parse(fs.readFileSync(result.comb_path!, 'utf8')) as { arbiter?: Record<string, unknown> };
    expect(comb.arbiter?.fallback).toBe('deterministic_plurality');
  });

  it('records worker timeouts in the comb and returns no consensus when all workers time out', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const bd = new BdClient(runnerWithLog(calls));

    const result = await runGasCityBridge({
      schema: 'gascity.swarm.v1',
      bead_id: 'gc-123',
      mode: 'pure',
      workers: 1,
      timeoutMs: 10,
    }, {
      bd,
      providers: [new SlowProvider()],
      now: () => new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('no_consensus');
    const comb = JSON.parse(fs.readFileSync(result.comb_path!, 'utf8')) as {
      responses: Array<{ provider?: string; model?: string; parseError?: string; error?: string; timedOut?: boolean }>;
    };
    expect(comb.responses[0].provider).toBe('slow');
    expect(comb.responses[0].model).toBe('slow-model');
    expect(comb.responses[0].parseError).toContain('timed out');
    expect(comb.responses[0].error).toContain('timed out');
    expect(comb.responses[0].timedOut).toBe(true);
  });

  it('caps bridge workers to the configured operational maximum', async () => {
    const oldMaxWorkers = process.env.NOS_MAX_BRIDGE_WORKERS;
    delete process.env.NOS_MAX_BRIDGE_WORKERS;
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const bd = new BdClient(runnerWithLog(calls));

    try {
      await expect(runGasCityBridge({
        schema: 'gascity.swarm.v1',
        bead_id: 'gc-123',
        mode: 'pure',
        workers: 10,
      }, {
        bd,
        providers: [new MockProviderAdapter('mock', { summary: 'done' })],
      })).rejects.toThrow(/workers must be <= 9/);
    } finally {
      if (oldMaxWorkers === undefined) delete process.env.NOS_MAX_BRIDGE_WORKERS;
      else process.env.NOS_MAX_BRIDGE_WORKERS = oldMaxWorkers;
    }
  });

  it('threads caller abort signals into provider work', async () => {
    const provider = new HangingProvider();
    const controller = new AbortController();
    const pending = runGasCityBridge({
      schema: 'gascity.swarm.v1',
      bead_id: 'gc-123',
      bead: { id: 'gc-123', title: 'Abort me' },
      mode: 'pure',
      workers: 1,
      timeoutMs: 10_000,
    }, {
      providers: [provider],
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/);
    expect(provider.signalSeen?.aborted).toBe(true);
  });
});
