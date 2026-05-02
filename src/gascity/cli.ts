import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { BdClient } from './bd.js';
import { runGasCityBridge } from './bridge.js';
import type { BridgeMode, GasCityBridgeRequest, JsonCliResult } from './types.js';
import type { Strategy } from '../swarm/types.js';
import {
  normalizeBridgeMode,
  normalizeStrategy,
  parsePositiveInteger,
  parseQuorumRatio,
  parseWorkers,
} from './options.js';

type FlagKind = 'boolean' | 'value';
interface FlagConfig {
  kind: FlagKind;
  allowLeadingDashValue?: boolean;
}
type FlagSpec = Record<string, FlagKind | FlagConfig>;

interface ParsedArgs {
  flags: Map<string, string | true>;
  positionals: string[];
  has(flag: string): boolean;
  value(flag: string): string | undefined;
}

const SWARM_FLAGS: FlagSpec = {
  '--bead': 'value',
  '--stdin': 'boolean',
  '--mode': 'value',
  '--strategy': 'value',
  '--workers': 'value',
  '--quorum': 'value',
  '--timeout-ms': 'value',
  '--instructions': { kind: 'value', allowLeadingDashValue: true },
  '--json': 'boolean',
};

const WATCH_FLAGS: FlagSpec = {
  '--mode': 'value',
  '--strategy': 'value',
  '--workers': 'value',
  '--quorum': 'value',
  '--timeout-ms': 'value',
  '--interval-ms': 'value',
  '--once': 'boolean',
  '--json': 'boolean',
};

const DOCTOR_FLAGS: FlagSpec = {
  '--json': 'boolean',
};

export async function runGasCityCli(args: string[]): Promise<number> {
  const command = args[0] ?? 'help';
  try {
    if (command === 'doctor') return writeJson(await doctorResult(args.slice(1)));
    if (command === 'swarm') return writeJson(await swarmResult(args.slice(1)));
    if (command === 'watch') return await watch(args.slice(1));
    throw new Error(`unknown gascity command: ${command}`);
  } catch (err) {
    return writeJson(errorResult(err, command));
  }
}

async function swarmResult(args: string[]): Promise<JsonCliResult> {
  const parsed = parseArgs(args, SWARM_FLAGS);
  if (parsed.has('--stdin')) {
    if (parsed.value('--bead') || parsed.positionals.length > 0) {
      throw new Error('gascity swarm --stdin cannot be combined with --bead or positional bead IDs');
    }
    const request = parseStdinRequest(await readStdin());
    const mode = parsed.value('--mode') ? normalizeBridgeMode(parsed.value('--mode')) : modeFromRequest(request.mode);
    const result = await runGasCityBridge({
      ...request,
      schema: 'gascity.swarm.v1',
      mode,
      strategy: parsed.value('--strategy') ? normalizeStrategy(parsed.value('--strategy')) : strategyFromRequest(request.strategy),
      quorumRatio: parseQuorumRatio(parsed.value('--quorum')) ?? request.quorumRatio,
      workers: parseWorkers(parsed.value('--workers')) ?? request.workers,
      timeoutMs: parsePositiveInteger(parsed.value('--timeout-ms'), '--timeout-ms') ?? request.timeoutMs,
      instructions: parsed.value('--instructions') ?? request.instructions,
    });
    return { code: result.ok ? 0 : 1, payload: result as unknown as Record<string, unknown> };
  }

  if (parsed.positionals.length > 1) {
    throw new Error(`gascity swarm accepts at most one positional bead ID, got ${parsed.positionals.length}`);
  }
  const bead = parsed.value('--bead') ?? parsed.positionals[0];
  if (!bead) throw new Error('gascity swarm requires --bead <id>, a positional bead ID, or --stdin');

  const result = await runGasCityBridge({
    schema: 'gascity.swarm.v1',
    bead_id: bead,
    mode: normalizeBridgeMode(parsed.value('--mode'), 'pure'),
    strategy: normalizeStrategy(parsed.value('--strategy')),
    quorumRatio: parseQuorumRatio(parsed.value('--quorum')),
    workers: parseWorkers(parsed.value('--workers')),
    timeoutMs: parsePositiveInteger(parsed.value('--timeout-ms'), '--timeout-ms'),
    instructions: parsed.value('--instructions'),
  });
  return { code: result.ok ? 0 : 1, payload: result as unknown as Record<string, unknown> };
}

async function watch(args: string[]): Promise<number> {
  const parsed = parseArgs(args, WATCH_FLAGS);
  if (parsed.positionals.length > 0) {
    throw new Error(`gascity watch does not accept positional arguments: ${parsed.positionals.join(' ')}`);
  }
  const mode = normalizeBridgeMode(parsed.value('--mode'), 'apply');
  const strategy = normalizeStrategy(parsed.value('--strategy'));
  const quorumRatio = parseQuorumRatio(parsed.value('--quorum'));
  const workers = parseWorkers(parsed.value('--workers'));
  const timeoutMs = parsePositiveInteger(parsed.value('--timeout-ms'), '--timeout-ms');
  const intervalMs = parsePositiveInteger(parsed.value('--interval-ms'), '--interval-ms') ?? 5000;
  const once = parsed.has('--once');
  const bd = new BdClient();

  do {
    try {
      const ready = await bd.ready();
      for (const bead of ready) {
        const result = await runGasCityBridge({
          schema: 'gascity.swarm.v1',
          bead_id: bead.id,
          bead,
          mode,
          strategy,
          quorumRatio,
          workers,
          timeoutMs,
        }, { bd });
        process.stdout.write(JSON.stringify(result) + '\n');
      }
    } catch (err) {
      process.stderr.write(`[nt gascity watch] ${String(err)}\n`);
      process.stdout.write(JSON.stringify(errorResult(err, 'watch', false).payload) + '\n');
      if (once) return 1;
    }
    if (once) return 0;
    await sleep(intervalMs);
  } while (true);
}

export async function getGasCityDoctorResult(args: string[] = []): Promise<JsonCliResult> {
  return doctorResult(args);
}

async function doctorResult(args: string[]): Promise<JsonCliResult> {
  const parsed = parseArgs(args, DOCTOR_FLAGS);
  if (parsed.positionals.length > 0) {
    throw new Error(`gascity doctor does not accept positional arguments: ${parsed.positionals.join(' ')}`);
  }
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  const nosHome = findNosHome();
  checks.nos_home = {
    ok: nosHome !== null,
    detail: nosHome ?? 'NOS_HOME, ~/.nostown/home, and package.json discovery all failed',
  };
  checks.nt_path = {
    ok: commandExists('nt'),
    detail: commandExists('nt') ? 'nt found on PATH' : 'nt not found on PATH',
  };
  checks.bd_path = {
    ok: commandExists('bd'),
    detail: commandExists('bd') ? 'bd found on PATH' : 'bd not found on PATH',
  };
  checks.providers = {
    ok: Boolean(process.env.GROQ_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.NOS_MOCK_PROVIDER === '1'),
    detail: providerDetail(),
  };
  return {
    code: Object.values(checks).every((check) => check.ok) ? 0 : 1,
    payload: { ok: Object.values(checks).every((check) => check.ok), checks },
  };
}

function parseArgs(args: string[], spec: FlagSpec): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unknown short flag: ${arg}`);
    }
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const config = flagConfig(spec, flag);
    if (!config) throw new Error(`unknown flag: ${flag}`);
    if (flags.has(flag)) throw new Error(`duplicate flag: ${flag}`);
    if (config.kind === 'boolean') {
      if (inlineValue !== undefined) throw new Error(`${flag} does not take a value`);
      flags.set(flag, true);
      continue;
    }
    const value = inlineValue ?? args[++i];
    if (value === undefined || value === '' || (!config.allowLeadingDashValue && value.startsWith('--'))) {
      throw new Error(`${flag} requires a value`);
    }
    flags.set(flag, value);
  }
  return {
    flags,
    positionals,
    has(flag: string) {
      return flags.has(flag);
    },
    value(flag: string) {
      const value = flags.get(flag);
      return typeof value === 'string' ? value : undefined;
    },
  };
}

function flagConfig(spec: FlagSpec, flag: string): FlagConfig | undefined {
  const config = spec[flag];
  if (!config) return undefined;
  return typeof config === 'string' ? { kind: config } : config;
}

function writeJson(result: JsonCliResult): number {
  process.stdout.write(JSON.stringify(result.payload) + '\n');
  return result.code;
}

function errorResult(err: unknown, command: string, diagnostic = true): JsonCliResult {
  if (diagnostic) process.stderr.write(`[nt gascity] ${String(err)}\n`);
  return {
    code: 1,
    payload: {
      ok: false,
      schema: 'gascity.swarm.result.v1',
      status: 'error',
      command,
      error: String(err),
    },
  };
}

function parseStdinRequest(raw: string): GasCityBridgeRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid stdin JSON: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stdin request must be a JSON object');
  }
  const request = parsed as GasCityBridgeRequest;
  if (!request.bead_id || typeof request.bead_id !== 'string') {
    throw new Error('stdin request missing bead_id');
  }
  return request;
}

function findNosHome(): string | null {
  if (process.env.NOS_HOME) return path.resolve(process.env.NOS_HOME);
  const homeFile = path.join(os.homedir(), '.nostown', 'home');
  if (fs.existsSync(homeFile)) {
    const value = fs.readFileSync(homeFile, 'utf8').trim();
    if (value) return value;
  }
  let dir = process.cwd();
  while (true) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg) && fs.readFileSync(pkg, 'utf8').includes('"nos-town"')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function commandExists(command: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function providerDetail(): string {
  const providers = [];
  if (process.env.GROQ_API_KEY) providers.push('groq/compound');
  if (process.env.DEEPSEEK_API_KEY) providers.push('deepseek-v4-pro');
  if (process.env.NOS_MOCK_PROVIDER === '1') providers.push('mock');
  return providers.length ? providers.join(', ') : 'no bridge provider env configured';
}

function modeFromRequest(value: unknown): BridgeMode {
  return typeof value === 'string' ? normalizeBridgeMode(value) : 'pure';
}

function strategyFromRequest(value: unknown): Strategy {
  return typeof value === 'string' ? normalizeStrategy(value) : 'majority';
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
