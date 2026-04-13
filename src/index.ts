// NOS Town — Main Entry Point

import { Mayor } from './roles/mayor.js';
import { HeartbeatMonitor } from './monitor/heartbeat.js';
import { runFromStdin } from './swarm/bridge.js';
import * as readline from 'readline';
import type { HeartbeatEvent } from './types/index.js';

const AGENT_ID = process.env.NOS_AGENT_ID ?? 'mayor_01';
const RIG_NAME = process.env.NOS_RIG ?? 'default';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

function checkEnv(): void {
  if (!GROQ_API_KEY) {
    console.error('[NOS Town] ERROR: GROQ_API_KEY environment variable is required');
    console.error('  Set it in .env or export GROQ_API_KEY=gsk_...');
    process.exit(1);
  }
}

function heartbeatHandler(event: HeartbeatEvent): void {
  if (event.type === 'MAYOR_MISSING') {
    console.warn(`[Heartbeat] ${event.type}:`, JSON.stringify(event));
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

  const mayor = new Mayor({
    agentId: AGENT_ID,
    rigName: RIG_NAME,
    groqApiKey: GROQ_API_KEY,
    emitHeartbeat: heartbeatHandler,
  });

  const monitor = new HeartbeatMonitor({
    onEvent: heartbeatHandler,
    polecatStallThresholdMs: 10 * 60 * 1000,
    pollIntervalMs: 30_000,
  });

  monitor.registerMayor(mayor);
  monitor.start();
  mayor.startHeartbeat();

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
    mayor.stopHeartbeat();
    monitor.stop();
    mayor.close();
  }
}

main().catch((err) => {
  console.error('[NOS Town] Fatal error:', err);
  process.exit(1);
});
