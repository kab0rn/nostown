import * as readline from 'readline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runGasCityBridge } from '../gascity/bridge.js';
import { getGasCityDoctorResult } from '../gascity/cli.js';
import { renderCombTrail, renderHiveStatus } from './hive.js';
import { bold, cyan, dim, gray, green, red, yellow } from './ui.js';
import type { JsonCliResult } from '../gascity/types.js';

const execFileAsync = promisify(execFile);
type WriteFn = (text: string) => void;
interface QueenInputOptions {
  signal?: AbortSignal;
}

export async function runQueenShell(): Promise<void> {
  process.stdout.write(renderBanner());
  let activeAbort: AbortController | null = null;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${cyan('queen')}${gray('>')} `,
    historySize: 1000,
  });

  rl.on('SIGINT', () => {
    if (activeAbort) {
      activeAbort.abort();
      process.stdout.write(`\n${yellow('interrupted')}\n`);
      return;
    }
    process.stdout.write('\n');
    rl.prompt();
  });

  rl.prompt();
  for await (const line of rl) {
    const input = String(line).trim();
    if (!input) {
      rl.prompt();
      continue;
    }
    try {
      activeAbort = new AbortController();
      const keepGoing = await handleQueenInput(input, (text) => process.stdout.write(text), { signal: activeAbort.signal });
      if (!keepGoing) break;
    } catch (err) {
      process.stdout.write(`${red('error')} ${String(err)}\n`);
    } finally {
      activeAbort = null;
    }
    rl.prompt();
  }
  rl.close();
}

export async function handleQueenInput(
  input: string,
  write: WriteFn = (text) => process.stdout.write(text),
  options: QueenInputOptions = {},
): Promise<boolean> {
  const [cmd, ...rest] = input.split(/\s+/);
  switch (cmd) {
    case '/exit':
    case '/quit':
      return false;
    case '/help':
      write(helpText());
      return true;
    case '/status':
      write(renderHiveStatus());
      return true;
    case '/trail':
      write(renderCombTrail());
      return true;
    case '/show':
      await showBead(rest[0], write);
      return true;
    case '/swarm':
      await swarmBead(rest[0], write, options.signal);
      return true;
    case '/doctor':
      write(renderDoctor(await getGasCityDoctorResult(['--json'])));
      return true;
    case '/gas':
      write(gasCityConfigSnippet());
      return true;
    default:
      await handlePlainText(input, write, options.signal);
      return true;
  }
}

async function showBead(beadId: string | undefined, write: WriteFn): Promise<void> {
  if (!beadId) {
    write(`${yellow('usage')} /show <bead>\n`);
    return;
  }
  try {
    const { stdout } = await execFileAsync('bd', ['show', '--id', beadId], { maxBuffer: 10 * 1024 * 1024 });
    write(stdout.endsWith('\n') ? stdout : stdout + '\n');
  } catch (err) {
    write(`${red('bd show failed')} ${String(err)}\n`);
  }
}

async function swarmBead(beadId: string | undefined, write: WriteFn, signal?: AbortSignal): Promise<void> {
  if (!beadId) {
    write(`${yellow('usage')} /swarm <bead>\n`);
    return;
  }
  if (signal?.aborted) {
    write(`${yellow('interrupted')} ${beadId}\n`);
    return;
  }
  const bridgeRun = runGasCityBridge(
    { schema: 'gascity.swarm.v1', bead_id: beadId, mode: 'pure' },
    { signal },
  );
  bridgeRun.catch(() => undefined);
  const result = await abortable(bridgeRun, signal);
  if (!result) {
    write(`${yellow('interrupted')} ${beadId}\n`);
    return;
  }
  if (result.ok && result.consensus) {
    const label = result.status === 'adjudicated' ? yellow('adjudicated') : green(result.status);
    write(`${label} ${beadId} agreement=${result.consensus.agreement.toFixed(2)} run=${result.run_id}\n`);
    write(JSON.stringify(result.consensus.winner, null, 2) + '\n');
  } else {
    const label = result.timeout_count ? red('timeout') : red(result.status);
    write(`${label} ${result.error ?? 'unknown error'} run=${result.run_id}\n`);
  }
}

async function handlePlainText(input: string, write: WriteFn, signal?: AbortSignal): Promise<void> {
  const swarm = input.match(/^swarm\s+([A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9][A-Za-z0-9_-]*)$/i);
  if (swarm) {
    await swarmBead(swarm[1], write, signal);
    return;
  }
  const show = input.match(/^show\s+([A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9][A-Za-z0-9_-]*)$/i);
  if (show) {
    await showBead(show[1], write);
    return;
  }
  write(
    `${dim('Queen is bridge-first. Use')} ${cyan('/swarm <bead>')} ${dim('to run consensus,')} ` +
    `${cyan('/show <bead>')} ${dim('to inspect, or')} ${cyan('/gas')} ${dim('for Gas City wiring.')}\n`,
  );
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function renderDoctor(result: JsonCliResult): string {
  const payload = result.payload as { checks?: Record<string, { ok: boolean; detail: string }> };
  const checks = payload.checks ?? {};
  const lines = [`\n${bold('Gas City Bridge Doctor')}`];
  for (const [name, check] of Object.entries(checks)) {
    lines.push(`  ${gray(name.padEnd(10))} ${check.ok ? green('ok') : red('fail')}  ${check.detail}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderBanner(): string {
  return [
    '',
    `${bold(cyan('NOSTown Queen'))}  ${gray('swarm consensus operator shell')}`,
    `${gray('Type')} ${cyan('/help')} ${gray('for commands. Gas City bridge commands stay JSON-safe outside this shell.')}`,
    '',
  ].join('\n');
}

function helpText(): string {
  return `
${bold('Queen commands')}
  ${cyan('/status')}        Hive status
  ${cyan('/trail')}         Recent comb records
  ${cyan('/show <bead>')}   Show bead through bd
  ${cyan('/swarm <bead>')}  Run pure swarm consensus
  ${cyan('/doctor')}        Validate Gas City bridge prerequisites
  ${cyan('/gas')}           Print city.toml sling_query snippet
  ${cyan('/exit')}          Leave the Queen shell
  ${cyan('/quit')}          Leave the Queen shell

`;
}

function gasCityConfigSnippet(): string {
  return `
${bold('Gas City city.toml')}
[[agent]]
name = "nostown"
scope = "city"
min_active_sessions = 0
max_active_sessions = 1
work_query = "printf ''"
sling_query = "nt gascity swarm --bead {} --mode apply --json"

`;
}
