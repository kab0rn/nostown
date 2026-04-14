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

const AGENT_ID = process.env.NOS_AGENT_ID ?? 'mayor_01';
const RIG_NAME = process.env.NOS_RIG ?? 'default';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

function checkDir(envVar: string, fallback: string, label: string): void {
  const dir = path.resolve(process.env[envVar] ?? fallback);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    console.error(`[NOS Town] ERROR: ${label} directory not writable: ${dir}`);
    console.error(`  Set ${envVar} to a writable path or fix permissions.`);
    process.exit(1);
  }
}

function checkEnv(): void {
  if (!GROQ_API_KEY) {
    console.error('[NOS Town] ERROR: GROQ_API_KEY environment variable is required');
    console.error('  Set it in .env or export GROQ_API_KEY=gsk_...');
    process.exit(1);
  }

  // HARDENING.md §3.1: fail fast if sender key is missing
  const keyDir = process.env.NOS_ROLE_KEY_DIR ?? 'keys';
  const keyFile = path.resolve(keyDir, `${AGENT_ID}.key`);
  if (!fs.existsSync(keyFile)) {
    console.error(`[NOS Town] ERROR: No sender key found at ${keyFile}`);
    console.error(`  Run: npx tsx scripts/gen-keys.ts --agent ${AGENT_ID}`);
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
    console.error(`[NOS Town] ERROR: KG directory not writable: ${kgDir}`);
    console.error('  Set NOS_KG_PATH to a writable path.');
    process.exit(1);
  }
}

// Late-binding ref so heartbeatHandler can forward POLECAT_STALLED to WorkerRuntime
// without a circular dependency (runtime is created after this function is defined)
let runtimeRef: WorkerRuntime | null = null;

function heartbeatHandler(event: HeartbeatEvent): void {
  if (event.type === 'MAYOR_MISSING') {
    console.warn(`[Heartbeat] ${event.type}:`, JSON.stringify(event));
  }
  if (event.type === 'POLECAT_STALLED') {
    // HARDENING.md §1.3: re-queue or BLOCKED escalation handled in WorkerRuntime
    void runtimeRef?.handleStall(event);
  }
  if (event.type === 'BEAD_BLOCKED') {
    console.warn(`[Heartbeat] BEAD_BLOCKED bead_id=${event.bead_id} retries=${event.retry_count}`);
  }
}

async function orchestrateTask(description: string, mayor: Mayor): Promise<void> {
  console.log(`[NOS Town] Orchestrating: ${description}`);
  try {
    const plan = await mayor.orchestrate({ description });
    console.log(`[NOS Town] Plan: ${plan.plan_id}  (${plan.beads.length} beads)`);
    for (const bead of plan.beads) {
      console.log(`  - ${bead.bead_id} (${bead.task_type}, role=${bead.role})`);
    }
  } catch (err) {
    console.error(`[NOS Town] Orchestration failed: ${String(err)}`);
  }
}

function showStatus(): void {
  console.log(`Mayor: ${AGENT_ID}   Rig: ${RIG_NAME}`);
}

function showHelp(): void {
  console.log(
    `NOS Town — Groq-native multi-agent orchestration\n` +
    `\n` +
    `Usage:\n` +
    `  nt                  Interactive session\n` +
    `  nt <task>           Orchestrate any task — plain text, no syntax\n` +
    `  nt status           Show system status\n` +
    `\n` +
    `Examples:\n` +
    `  nt add rate limiting to the polecat dispatch loop\n` +
    `  nt fix the convoy signature verification\n` +
    `  nt what models are in the routing table?`,
  );
}

// nextLine wraps rl.question in a promise and resolves null on EOF/close.
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

async function runRepl(mayor: Mayor): Promise<void> {
  console.log(`NOS Town  ${AGENT_ID} / ${RIG_NAME}`);
  console.log(`Type a task, 'status', or 'exit'.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = await nextLine(rl, '> ');
    if (line === null) break; // EOF (Ctrl+D)

    const input = line.trim();
    if (!input) continue;
    if (input === 'exit' || input === 'quit') break;

    if (input === 'status') {
      showStatus();
    } else if (input === 'help') {
      showHelp();
    } else {
      await orchestrateTask(input, mayor);
    }
  }

  rl.close();
  console.log('');
}

async function main(): Promise<void> {
  // The nt binary passes the entire task as a single arg, or --interactive for REPL.
  // Legacy: 'task <description>' still works for backward compatibility.
  const raw = process.argv.slice(2);
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

  // Configurable rate limits (Gap 2.2): NOS_MAX_INFLIGHT_BEADS, NOS_MIN_SAFEGUARD_POOL_SIZE
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
  const historian = new Historian({
    agentId: 'historian_01',
    groqApiKey: GROQ_API_KEY,
  });
  let historianTask: cron.ScheduledTask | null = null;
  if (cron.validate(historianCron)) {
    historianTask = cron.schedule(historianCron, () => {
      void historian.runNightly(RIG_NAME);
    });
  } else {
    console.warn(`[NOS Town] Invalid HISTORIAN_CRON schedule: "${historianCron}" — historian disabled`);
  }

  // Graceful shutdown on SIGINT/SIGTERM: drain in-flight beads before exit (Gap 2.3)
  let shuttingDown = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[NOS Town] ${signal} received — draining in-flight beads (30s max)...`);
    historianTask?.stop();
    await runtime.drain(30_000);
    mayor.stopHeartbeat();
    monitor.stop();
    mayor.close();
    process.exit(0);
  }
  process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));

  try {
    if (first === '--interactive' || first === '-i') {
      // Launched by `nt` (no args) via the nt binary
      await runRepl(mayor);
    } else if (first === 'status') {
      showStatus();
    } else if (first === 'help' || first === '--help' || first === '-h') {
      showHelp();
    } else if (first === 'swarm') {
      // Multi-agent swarm consensus (GasTown integration)
      const swarmArgs = args.slice(1);
      if (swarmArgs.includes('--stdin-params')) {
        await runFromStdin();
      } else {
        console.error('Direct swarm mode not yet implemented. Use --stdin-params.');
        process.exit(1);
      }
    } else if (first === 'historian') {
      // One-shot Historian run: `nt historian` or `nos historian`
      const rigArg = args[1] ?? RIG_NAME;
      console.log(`[NOS Town] Running Historian nightly pipeline for rig: ${rigArg}`);
      await historian.runNightly(rigArg);
    } else if (first === 'task') {
      // Legacy compatibility: `nos task <description>`
      const description = args.slice(1).join(' ');
      if (!description) {
        console.error('Usage: nos task <description>');
        process.exit(1);
      }
      await orchestrateTask(description, mayor);
    } else if (first !== undefined) {
      // Plain text task — no prefix required
      await orchestrateTask(args.join(' '), mayor);
    } else if (process.stdin.isTTY) {
      // `nos` with no args in a terminal → REPL
      await runRepl(mayor);
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
  console.error('[NOS Town] Fatal error:', err);
  process.exit(1);
});
