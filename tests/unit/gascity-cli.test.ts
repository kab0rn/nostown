import { runGasCityCli } from '../../src/gascity/cli';
import { Readable } from 'stream';
import * as os from 'os';

describe('Gas City CLI', () => {
  const oldStdout = process.stdout.write;
  const oldStderr = process.stderr.write;
  const oldStdin = process.stdin;
  const oldMock = process.env.NOS_MOCK_PROVIDER;
  const oldComb = process.env.NOS_COMB_DIR;
  const oldMaxWorkers = process.env.NOS_MAX_BRIDGE_WORKERS;
  const oldGroq = process.env.GROQ_API_KEY;
  const oldDeepSeek = process.env.DEEPSEEK_API_KEY;

  let stdout = '';
  let stderr = '';

  beforeEach(() => {
    stdout = '';
    stderr = '';
    process.env.NOS_MOCK_PROVIDER = '1';
    process.env.NOS_COMB_DIR = os.tmpdir();
    delete process.env.NOS_MAX_BRIDGE_WORKERS;
    process.stdout.write = jest.fn((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = jest.fn((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = oldStdout;
    process.stderr.write = oldStderr;
    Object.defineProperty(process, 'stdin', { value: oldStdin, configurable: true });
    if (oldMock === undefined) delete process.env.NOS_MOCK_PROVIDER;
    else process.env.NOS_MOCK_PROVIDER = oldMock;
    if (oldComb === undefined) delete process.env.NOS_COMB_DIR;
    else process.env.NOS_COMB_DIR = oldComb;
    if (oldMaxWorkers === undefined) delete process.env.NOS_MAX_BRIDGE_WORKERS;
    else process.env.NOS_MAX_BRIDGE_WORKERS = oldMaxWorkers;
    if (oldGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = oldGroq;
    if (oldDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldDeepSeek;
  });

  it('emits JSON on stdout for malformed swarm args', async () => {
    const code = await runGasCityCli(['swarm', '--json']);
    expect(code).toBe(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(JSON.parse(stdout).ok).toBe(false);
    expect(stderr).toContain('[nt gascity]');
  });

  it.each([
    ['unknown flag', ['swarm', '--bogus']],
    ['missing flag value', ['swarm', '--bead']],
    ['invalid mode', ['swarm', '--bead', 'gc-1', '--mode', 'bad']],
    ['invalid workers', ['swarm', '--bead', 'gc-1', '--workers', '0']],
    ['too many workers', ['swarm', '--bead', 'gc-1', '--workers', '10']],
    ['too many positional beads', ['swarm', 'gc-1', 'gc-2']],
    ['watch unknown flag', ['watch', '--bogus']],
    ['doctor positional arg', ['doctor', 'extra']],
  ])('emits JSON-only stdout for %s', async (_name, args) => {
    const code = await runGasCityCli(args);
    const parsed = JSON.parse(stdout);

    expect(code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('error');
    expect(stderr).toContain('[nt gascity]');
  });

  it('emits JSON-only stdout for malformed stdin JSON', async () => {
    setStdin('{not json');

    const code = await runGasCityCli(['swarm', '--stdin', '--json']);
    const parsed = JSON.parse(stdout);

    expect(code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('invalid stdin JSON');
  });

  it('runs stdin requests without bd when a bead payload is provided', async () => {
    setStdin(JSON.stringify({
      bead_id: 'gc-stdin',
      bead: { id: 'gc-stdin', title: 'From stdin' },
      mode: 'pure',
      workers: 1,
    }));

    const code = await runGasCityCli(['swarm', '--stdin', '--json']);
    const parsed = JSON.parse(stdout);

    expect(code).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.bead_id).toBe('gc-stdin');
    expect(parsed.mode).toBe('pure');
  });

  it('lets stdin CLI flags override request strategy controls', async () => {
    setStdin(JSON.stringify({
      bead_id: 'gc-stdin',
      bead: { id: 'gc-stdin', title: 'From stdin' },
      mode: 'apply',
      strategy: 'unanimous',
      workers: 1,
    }));

    const code = await runGasCityCli([
      'swarm',
      '--stdin',
      '--json',
      '--mode',
      'pure',
      '--strategy',
      'majority',
      '--workers',
      '1',
      '--timeout-ms',
      '1000',
    ]);
    const parsed = JSON.parse(stdout);

    expect(code).toBe(0);
    expect(parsed.mode).toBe('pure');
    expect(parsed.consensus.strategy).toBe('majority');
  });

  it('emits JSON-only stdout when no provider is configured', async () => {
    delete process.env.NOS_MOCK_PROVIDER;
    delete process.env.GROQ_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    setStdin(JSON.stringify({
      bead_id: 'gc-stdin',
      bead: { id: 'gc-stdin', title: 'From stdin' },
      workers: 1,
    }));

    const code = await runGasCityCli(['swarm', '--stdin', '--json']);
    const parsed = JSON.parse(stdout);

    expect(code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('No bridge providers configured');
  });
});

function setStdin(text: string): void {
  Object.defineProperty(process, 'stdin', {
    value: Readable.from([Buffer.from(text)]),
    configurable: true,
  });
}
