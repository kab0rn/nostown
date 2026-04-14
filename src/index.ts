// NOS Town — Main Entry Point

import { Mayor } from './roles/mayor.js';
import { WorkerRuntime } from './runtime/worker-loop.js';
import { HeartbeatMonitor } from './monitor/heartbeat.js';
import { Historian } from './roles/historian.js';
import { Refinery } from './roles/refinery.js';
import { runFromStdin } from './swarm/bridge.js';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import cron from 'node-cron';
import type { HeartbeatEvent } from './types/index.js';
import type { DispatchPlan } from './roles/mayor.js';
import {
  bold, cyan, green, red, yellow, gray, dim, ansi,
  divider, col, durationMs, relativeTime, progressBar,
  ROLE_ICON, STATUS_ICON, Spinner,
} from './cli/ui.js';
import { renderStatus, renderQueue } from './cli/status.js';
import {
  renderTrail, renderBeadHistory, renderMilestones,
  recordHeartbeat, recordPlanStart, recordBeadComplete,
} from './cli/trail.js';
import { Dashboard } from './cli/dashboard.js';

const AGENT_ID     = process.env.NOS_AGENT_ID ?? 'mayor_01';
const RIG_NAME     = process.env.NOS_RIG ?? 'default';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Process start time for uptime display
const PROCESS_START = new Date();

// ── Startup checks ─────────────────────────────────────────────────────────────

function checkDir(envVar: string, fallback: string, label: string): void {
  const dir = path.resolve(process.env[envVar] ?? fallback);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    process.stderr.write(`${red('[NOS Town]')} ERROR: ${label} directory not writable: ${dir}\n`);
    process.stderr.write(`  Set ${envVar} to a writable path or fix permissions.\n`);
    process.exit(1);
  }
}

function checkEnv(): void {
  if (!GROQ_API_KEY) {
    process.stderr.write(`${red('[NOS Town]')} ERROR: GROQ_API_KEY environment variable is required\n`);
    process.stderr.write(`  Set it in .env or export GROQ_API_KEY=gsk_...\n`);
    process.exit(1);
  }

  // HARDENING.md §3.1: fail fast if sender key is missing
  const keyDir  = process.env.NOS_ROLE_KEY_DIR ?? 'keys';
  const keyFile = path.resolve(keyDir, `${AGENT_ID}.key`);
  if (!fs.existsSync(keyFile)) {
    process.stderr.write(`${red('[NOS Town]')} ERROR: No sender key found at ${keyFile}\n`);
    process.stderr.write(`  Run: npx tsx scripts/gen-keys.ts --agent ${AGENT_ID}\n`);
    process.exit(1);
  }

  // Validate writable data directories at startup so failures surface immediately
  checkDir('NOS_RIGS_ROOT', 'rigs', 'NOS_RIGS_ROOT (ledger)');
  checkDir('NOS_AUDIT_DIR', 'nos/audit', 'NOS_AUDIT_DIR (audit log)');
  const kgDir = path.dirname(path.resolve(process.env.NOS_KG_PATH ?? 'kg/knowledge_graph.sqlite'));
  try {
    fs.mkdirSync(kgDir, { recursive: true });
    fs.accessSync(kgDir, fs.constants.W_OK);
  } catch {
    process.stderr.write(`${red('[NOS Town]')} ERROR: KG directory not writable: ${kgDir}\n`);
    process.stderr.write('  Set NOS_KG_PATH to a writable path.\n');
    process.exit(1);
  }
}

// ── Heartbeat handler ──────────────────────────────────────────────────────────
// Late-binding ref so heartbeatHandler can forward POLECAT_STALLED to WorkerRuntime
// without a circular dependency (runtime is created after this function is defined)
let runtimeRef: WorkerRuntime | null = null;

function heartbeatHandler(event: HeartbeatEvent): void {
  // Record every event to the in-process trail log
  recordHeartbeat(event);

  if (event.type === 'MAYOR_MISSING') {
    process.stderr.write(
      `${yellow('⚠')} ${gray('[Heartbeat]')} ${yellow('MAYOR_MISSING')} — last seen ${event.last_seen_at}\n`,
    );
  }
  if (event.type === 'POLECAT_STALLED') {
    process.stderr.write(
      `${yellow('⚠')} ${gray('[Heartbeat]')} ${yellow('STALL')} ${event.agent_id} bead=${event.bead_id.slice(0, 8)} ` +
      `(${Math.round(event.stall_duration_ms / 1000)}s)\n`,
    );
    void runtimeRef?.handleStall(event);
  }
  if (event.type === 'BEAD_BLOCKED') {
    process.stderr.write(
      `${STATUS_ICON.blocked} ${gray('[Heartbeat]')} ${yellow('BLOCKED')} bead=${event.bead_id.slice(0, 8)} ` +
      `retry=${event.retry_count}\n`,
    );
  }
  if (event.type === 'POTENTIAL_DEADLOCK') {
    process.stderr.write(
      `${red('⚠')} ${gray('[Heartbeat]')} ${red('POTENTIAL_DEADLOCK')} bead=${event.bead_id.slice(0, 8)} ` +
      `reason=${event.reason} (${Math.round(event.stall_duration_ms / 1000)}s)\n`,
    );
    if (event.reason !== 'HIGH_FAN_OUT') {
      void runtimeRef?.handleStall({ bead_id: event.bead_id, agent_id: 'runtime', stall_duration_ms: event.stall_duration_ms });
    }
  }
  if (event.type === 'PROVIDER_EXHAUSTED') {
    process.stderr.write(
      `${red('✗')} ${gray('[Heartbeat]')} ${red('PROVIDER_EXHAUSTED')} model=${event.model}\n`,
    );
  }
  if (event.type === 'PROVIDER_RECOVERED') {
    process.stderr.write(
      `${green('✓')} ${gray('[Heartbeat]')} ${green('PROVIDER_RECOVERED')}\n`,
    );
  }
}

// ── Orchestration with rich output ─────────────────────────────────────────────

async function orchestrateTask(description: string, mayor: Mayor): Promise<void> {
  const spinner = new Spinner(`${dim('Mayor')} decomposing task…`);
  spinner.start();

  let plan: DispatchPlan;
  try {
    plan = await mayor.orchestrate({ description });
    spinner.stop();
  } catch (err) {
    spinner.stop(`${STATUS_ICON.failed} Orchestration failed: ${red(String(err))}`);
    return;
  }

  // Record plan start in trail
  recordPlanStart(plan.plan_id, plan.beads.length, description);

  // Print plan summary
  process.stdout.write(`\n${green('✓')} ${bold('Plan')} ${gray(plan.plan_id.slice(0, 12))}  ${gray(plan.beads.length + ' beads')}\n`);
  process.stdout.write(divider('', 54) + '\n');

  // Group by critical vs. non-critical
  const critical = plan.beads.filter((b) => b.critical_path);
  const normal   = plan.beads.filter((b) => !b.critical_path);

  function printBead(b: typeof plan.beads[0], prefix = '  '): void {
    const icon    = b.critical_path ? cyan('★') : gray('·');
    const role    = ROLE_ICON[b.role] ?? '  ';
    const type    = col(bold(b.task_type ?? '—'), 28);
    const model   = dim((b.model ?? '').replace(/.*\//, '').slice(0, 22));
    const needStr = b.needs.length > 0 ? gray('  ← ' + b.needs.slice(0, 2).map((id) => id.slice(0, 8)).join(', ')) : '';
    process.stdout.write(`${prefix}${icon} ${role}  ${type}  ${model}${needStr}\n`);
  }

  if (critical.length > 0) {
    process.stdout.write(`\n  ${cyan('★')} ${bold('Critical path')} ${gray('(' + critical.length + ')')}\n`);
    for (const b of critical) printBead(b, '    ');
  }
  if (normal.length > 0) {
    process.stdout.write(`\n  ${gray('·')} ${bold('Non-critical')} ${gray('(' + normal.length + ')')}\n`);
    for (const b of normal) printBead(b, '    ');
  }

  process.stdout.write('\n' + gray('  Beads dispatched to runtime. Use `trail` or `status` to monitor.') + '\n\n');
}

// ── Help ───────────────────────────────────────────────────────────────────────

function showHelp(): void {
  const h = (cmd: string, desc: string): string =>
    `  ${col(cyan(cmd), 22)}  ${gray(desc)}`;

  process.stdout.write(`
${bold(cyan('NOS Town'))}  ${gray('— Groq-native multi-agent orchestration')}

${bold('Usage:')}
  ${cyan('nt')}                      Interactive session (REPL)
  ${cyan('nt')} ${gray('<task>')}               Orchestrate any task — plain text
  ${cyan('nt')} ${gray('<command>')}            Run a sub-command

${bold('Commands:')}
${h('status', 'System status: agents, ledger, bead queue')}
${h('trail [--beads] [--plans]', 'Recent activity and heartbeat events')}
${h('dash [--refresh <ms>]', 'Live-refreshing dashboard')}
${h('historian [rig]', 'Run Historian nightly pipeline now')}
${h('swarm --stdin-params', 'Multi-agent swarm consensus (stdin JSON)')}
${h('help', 'Show this help')}

${bold('Examples:')}
  ${gray('nt add rate limiting to the polecat dispatch loop')}
  ${gray('nt fix the convoy signature verification')}
  ${gray('nt status')}
  ${gray('nt trail --beads')}
  ${gray('nt dash')}

${bold('Environment:')}
  ${gray('GROQ_API_KEY, NOS_RIG, NOS_AGENT_ID, NOS_POLECAT_COUNT')}
  ${gray('NOS_MAX_INFLIGHT_BEADS, HISTORIAN_CRON, NOS_LOG_LEVEL')}
`);
}

// ── REPL ───────────────────────────────────────────────────────────────────────

function nextLine(rl: readline.Interface, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const onClose = (): void => resolve(null);
    rl.once('close', onClose);
    rl.question(prompt, (answer) => {
      rl.removeListener('close', onClose);
      resolve(answer);
    });
  });
}

async function runRepl(
  mayor: Mayor,
  runtime: WorkerRuntime,
  historianCron: string,
): Promise<void> {
  // Banner
  process.stdout.write(
    renderStatus({ agentId: AGENT_ID, rigName: RIG_NAME, runtime, historianCron, uptime: PROCESS_START }),
  );
  process.stdout.write(
    gray('  Type a task description, a command (status / trail / dash / help), or exit.\n\n'),
  );

  const prompt = `${cyan('nos')}${gray('>')} `;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = await nextLine(rl, prompt);
    if (line === null) break; // EOF / Ctrl+D

    const input = line.trim();
    if (!input) continue;

    const words = input.split(/\s+/);
    const cmd   = words[0];

    if (cmd === 'exit' || cmd === 'quit') {
      break;
    } else if (cmd === 'status') {
      process.stdout.write(
        renderStatus({ agentId: AGENT_ID, rigName: RIG_NAME, runtime, historianCron, uptime: PROCESS_START }) +
        renderQueue(RIG_NAME),
      );
    } else if (cmd === 'trail') {
      const beadsFlag = words.includes('--beads');
      const plansFlag = words.includes('--plans');
      if (beadsFlag) {
        process.stdout.write(renderBeadHistory(RIG_NAME));
      } else if (plansFlag) {
        process.stdout.write(renderMilestones(RIG_NAME));
      } else {
        process.stdout.write(renderTrail());
        process.stdout.write(renderBeadHistory(RIG_NAME, 10));
      }
    } else if (cmd === 'dash') {
      // Brief inline snapshot — full live dash exits REPL
      process.stdout.write(
        renderStatus({ agentId: AGENT_ID, rigName: RIG_NAME, runtime, historianCron, uptime: PROCESS_START }) +
        renderQueue(RIG_NAME) +
        renderTrail(10),
      );
    } else if (cmd === 'help') {
      showHelp();
    } else {
      await orchestrateTask(input, mayor);
    }
  }

  rl.close();
  process.stdout.write('\n');
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // The nt binary passes the entire task as a single arg, or --interactive for REPL.
  // Legacy: 'task <description>' still works for backward compatibility.
  const raw  = process.argv.slice(2);
  const args = raw[0] === '--' ? raw.slice(1) : raw;
  const first = args[0];

  checkEnv();

  const refinery = new Refinery({
    agentId: 'refinery_01',
    rigName: RIG_NAME,
    groqApiKey: GROQ_API_KEY,
  });

  const mayor = new Mayor({
    agentId: AGENT_ID,
    rigName: RIG_NAME,
    groqApiKey: GROQ_API_KEY,
    emitHeartbeat: heartbeatHandler,
    refinery,
  });

  const safeguardPoolSize = Math.max(
    Number(process.env.NOS_MIN_SAFEGUARD_POOL_SIZE ?? 2),
    Number(process.env.SAFEGUARD_POOL_SIZE ?? 2),
  );

  const runtime = new WorkerRuntime({
    rigName: RIG_NAME,
    groqApiKey: GROQ_API_KEY,
    polecatCount: Number(process.env.NOS_POLECAT_COUNT ?? 4),
    safeguardPoolSize,
    pollIntervalMs: Number(process.env.NOS_POLL_INTERVAL_MS ?? 500),
    maxInflightBeads: process.env.NOS_MAX_INFLIGHT_BEADS
      ? Number(process.env.NOS_MAX_INFLIGHT_BEADS)
      : undefined,
    onEvent: heartbeatHandler,
    mayor,
  });
  runtimeRef = runtime;

  const monitor = new HeartbeatMonitor({
    onEvent: heartbeatHandler,
    polecatStallThresholdMs: 10 * 60 * 1000,
    pollIntervalMs: 30_000,
  });

  monitor.registerMayor(mayor);
  monitor.start();
  mayor.startHeartbeat();
  await runtime.start();

  // Wire Historian cron job (HISTORIAN_CRON env var, default: 2am nightly)
  const historianCron = process.env.HISTORIAN_CRON ?? '0 2 * * *';
  const historian = new Historian({ agentId: 'historian_01', groqApiKey: GROQ_API_KEY });
  let historianTask: cron.ScheduledTask | null = null;
  if (cron.validate(historianCron)) {
    historianTask = cron.schedule(historianCron, () => {
      void historian.runNightly(RIG_NAME);
    });
  } else {
    process.stderr.write(`${yellow('⚠')} Invalid HISTORIAN_CRON: "${historianCron}" — historian disabled\n`);
  }

  // Graceful shutdown on SIGINT/SIGTERM
  let shuttingDown = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(
      `\n${yellow('⏸')} ${gray(signal)} received — draining in-flight beads ${gray('(30s max)')}\n`,
    );
    historianTask?.stop();
    await runtime.drain(30_000);
    mayor.stopHeartbeat();
    monitor.stop();
    mayor.close();
    process.exit(0);
  }
  process.once('SIGINT',  () => void gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));

  try {
    if (first === '--interactive' || first === '-i') {
      await runRepl(mayor, runtime, historianCron);

    } else if (first === 'status') {
      process.stdout.write(
        renderStatus({ agentId: AGENT_ID, rigName: RIG_NAME, runtime, historianCron, uptime: PROCESS_START }) +
        renderQueue(RIG_NAME),
      );

    } else if (first === 'trail') {
      const beadsFlag = args.includes('--beads');
      const plansFlag = args.includes('--plans');
      const limitArg  = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 20;
      if (beadsFlag) {
        process.stdout.write(renderBeadHistory(RIG_NAME, limitArg));
      } else if (plansFlag) {
        process.stdout.write(renderMilestones(RIG_NAME));
      } else {
        process.stdout.write(renderBeadHistory(RIG_NAME, limitArg));
      }

    } else if (first === 'dash') {
      const refreshMs = args.includes('--refresh')
        ? Number(args[args.indexOf('--refresh') + 1]) * 1000
        : 2000;
      const dash = new Dashboard({
        agentId: AGENT_ID,
        rigName: RIG_NAME,
        runtime,
        historianCron,
        uptime: PROCESS_START,
        refreshMs,
      });
      dash.start();

    } else if (first === 'help' || first === '--help' || first === '-h') {
      showHelp();

    } else if (first === 'swarm') {
      const swarmArgs = args.slice(1);
      if (swarmArgs.includes('--stdin-params')) {
        await runFromStdin();
      } else {
        process.stderr.write('Direct swarm mode not yet implemented. Use --stdin-params.\n');
        process.exit(1);
      }

    } else if (first === 'historian') {
      const rigArg = args[1] ?? RIG_NAME;
      const spinner = new Spinner(`${ROLE_ICON.historian} Historian nightly pipeline — rig ${bold(rigArg)}`);
      spinner.start();
      try {
        await historian.runNightly(rigArg);
        spinner.stop(`${STATUS_ICON.done} Historian run complete`);
      } catch (err) {
        spinner.stop(`${STATUS_ICON.failed} Historian run failed: ${red(String(err))}`);
      }

    } else if (first === 'task') {
      // Legacy: `nos task <description>`
      const description = args.slice(1).join(' ');
      if (!description) {
        process.stderr.write('Usage: nos task <description>\n');
        process.exit(1);
      }
      await orchestrateTask(description, mayor);

    } else if (first !== undefined) {
      // Plain text task — no prefix required
      await orchestrateTask(args.join(' '), mayor);

    } else if (process.stdin.isTTY) {
      // `nt` with no args in a terminal → REPL
      await runRepl(mayor, runtime, historianCron);

    } else {
      showHelp();
    }
  } finally {
    historianTask?.stop();
    await runtime.stop();
    mayor.stopHeartbeat();
    monitor.stop();
    mayor.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${red('[NOS Town]')} Fatal error: ${String(err)}\n`);
  process.exit(1);
});
