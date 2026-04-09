// NOS Town — Main Entry Point

import { Mayor } from './roles/mayor.js';
import { SwarmCoordinator } from './swarm/coordinator.js';
import { HeartbeatMonitor } from './monitor/heartbeat.js';
import type { HeartbeatEvent } from './types/index.js';

const AGENT_ID = process.env.NOS_AGENT_ID ?? 'mayor_01';
const RIG_NAME = process.env.NOS_RIG ?? 'default';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

function checkEnv(): void {
  if (!GROQ_API_KEY) {
    console.error('[NOS Town] ERROR: GROQ_API_KEY environment variable is required');
    process.exit(1);
  }
}

function heartbeatHandler(event: HeartbeatEvent): void {
  console.warn(`[Heartbeat] ${event.type}:`, JSON.stringify(event));
}

async function main(): Promise<void> {
  checkEnv();

  const args = process.argv.slice(2);
  const command = args[0];

  console.log(`[NOS Town] Starting Mayor ${AGENT_ID} on rig ${RIG_NAME}`);

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

  // Handle CLI commands
  switch (command) {
    case 'task': {
      const taskDescription = args.slice(1).join(' ');
      if (!taskDescription) {
        console.error('Usage: nos task <description>');
        process.exit(1);
      }

      console.log(`[NOS Town] Orchestrating task: ${taskDescription}`);
      try {
        const plan = await mayor.orchestrate({ description: taskDescription });
        console.log(`[NOS Town] Plan created: ${plan.plan_id}`);
        console.log(`[NOS Town] Checkpoint: ${plan.checkpoint_id}`);
        console.log(`[NOS Town] Beads: ${plan.beads.length}`);
        for (const bead of plan.beads) {
          console.log(`  - ${bead.bead_id} (${bead.task_type}, role=${bead.role})`);
        }
      } catch (err) {
        console.error(`[NOS Town] Orchestration failed: ${String(err)}`);
      }
      break;
    }

    case 'status': {
      const coordinator = new SwarmCoordinator();
      console.log(`[NOS Town] Rig: ${RIG_NAME}`);
      console.log(`[NOS Town] Mayor: ${AGENT_ID}`);
      console.log(`[NOS Town] Palace: ${process.env.MEMPALACE_URL ?? 'http://localhost:7474'}`);
      break;
    }

    default: {
      console.log(`
NOS Town — Groq-native multi-agent orchestration

Usage:
  nos task <description>    Orchestrate a task
  nos status                Show system status

Environment:
  GROQ_API_KEY              Groq API key (required)
  NOS_AGENT_ID              Mayor agent ID (default: mayor_01)
  NOS_RIG                   Rig name (default: default)
  MEMPALACE_URL             MemPalace URL (default: http://localhost:7474)
  NOS_ROLE_KEY_DIR          Key directory (default: keys/)
  NOS_RIGS_ROOT             Rigs root directory (default: rigs/)
      `);
    }
  }

  // Cleanup
  mayor.stopHeartbeat();
  monitor.stop();
  mayor.close();
}

main().catch((err) => {
  console.error('[NOS Town] Fatal error:', err);
  process.exit(1);
});
