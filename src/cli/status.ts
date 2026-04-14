// NOS Town — `nt status` display
// Shows system health, agent roster, ledger stats, and bead queue state.

import * as os from 'os';
import { Ledger } from '../ledger/index.js';
import type { WorkerRuntime } from '../runtime/worker-loop.js';
import type { Bead } from '../types/index.js';
import {
  ansi, bold, dim, green, red, yellow, cyan, gray, magenta,
  divider, col, relativeTime, durationMs, progressBar,
  ROLE_ICON, STATUS_ICON,
} from './ui.js';

interface StatusOptions {
  agentId: string;
  rigName: string;
  runtime: WorkerRuntime;
  historianCron: string;
  uptime: Date;  // process start time
}

// ── Deduplicate bead log → latest record per bead_id ─────────────────────────
function latestBeads(all: Bead[]): Bead[] {
  const map = new Map<string, Bead>();
  for (const b of all) map.set(b.bead_id, b);
  return [...map.values()];
}

function beadStatusIcon(b: Bead): string {
  if (b.status === 'done') return b.outcome === 'SUCCESS' ? STATUS_ICON.done : STATUS_ICON.failed;
  if (b.status === 'failed') return STATUS_ICON.failed;
  if (b.status === 'blocked') return STATUS_ICON.blocked;
  if (b.status === 'in_progress') return STATUS_ICON.in_progress;
  return STATUS_ICON.pending;
}

function beadStatusColor(b: Bead, text: string): string {
  if (b.status === 'done') return b.outcome === 'SUCCESS' ? green(text) : red(text);
  if (b.status === 'failed') return red(text);
  if (b.status === 'blocked') return yellow(text);
  if (b.status === 'in_progress') return cyan(text);
  return gray(text);
}

export function renderStatus(opts: StatusOptions): string {
  const { agentId, rigName, runtime, historianCron, uptime } = opts;
  const lines: string[] = [];
  const now = new Date();

  // ── Header ─────────────────────────────────────────────────────────────────
  const uptimeMs = now.getTime() - uptime.getTime();
  lines.push('');
  lines.push(
    `${bold(cyan('NOS Town'))}  ${bold(agentId)}  ${gray('@')}  ${bold(rigName)}` +
    `   ${gray('up ' + durationMs(uptimeMs))}`,
  );
  lines.push(divider('', 62));

  // ── Agent roster ───────────────────────────────────────────────────────────
  const rs = runtime.getStatus();

  // Mayor
  lines.push(
    `  ${ROLE_ICON.mayor}  ${col(bold('Mayor'), 14)}${green('● running')}` +
    `   ${gray(agentId)}`,
  );

  // Polecats
  const totalPc = rs.polecats.length;
  const busyPc  = rs.activePolecat;
  const idlePc  = totalPc - busyPc;
  const pcStatus = rs.dispatchPaused
    ? yellow('⏸ draining')
    : busyPc > 0
      ? `${cyan('⚙')} ${busyPc} busy  ${gray(idlePc + ' idle')}`
      : `${STATUS_ICON.idle} ${gray('idle')}`;
  lines.push(
    `  ${ROLE_ICON.polecat}  ${col(bold('Polecats'), 14)}${pcStatus}` +
    `   ${gray(totalPc + ' workers')}`,
  );

  // Per-polecat detail (only show if any are busy)
  for (const pc of rs.polecats) {
    if (!pc.busy) continue;
    const beadStr = pc.currentBeadId
      ? `  bead ${gray(pc.currentBeadId.slice(0, 8))}…`
      : '';
    const staleness = relativeTime(pc.lastActivity);
    lines.push(`      ${gray('└')} ${cyan(pc.agentId)}${beadStr}  ${staleness}`);
  }

  // Witness
  lines.push(
    `  ${ROLE_ICON.witness}  ${col(bold('Witness'), 14)}${STATUS_ICON.running}  ${gray('ready')}`,
  );

  // Safeguard
  lines.push(
    `  ${ROLE_ICON.safeguard}  ${col(bold('Safeguard'), 14)}${STATUS_ICON.running}  ${gray(rs.safeguardPoolSize + ' workers')}`,
  );

  // Historian
  const histNext = gray(`next: ${historianCron === '0 2 * * *' ? '02:00' : historianCron}`);
  lines.push(
    `  ${ROLE_ICON.historian}  ${col(bold('Historian'), 14)}${STATUS_ICON.idle}  ${histNext}`,
  );

  lines.push(divider('', 62));

  // ── Ledger stats ───────────────────────────────────────────────────────────
  const ledger = new Ledger();
  const allBeads = latestBeads(ledger.readBeads(rigName));

  const total       = allBeads.length;
  const done        = allBeads.filter((b) => b.status === 'done').length;
  const failed      = allBeads.filter((b) => b.status === 'failed' || b.outcome === 'FAILURE').length;
  const blocked     = allBeads.filter((b) => b.status === 'blocked').length;
  const inFlight    = allBeads.filter((b) => b.status === 'in_progress').length;
  const pending     = allBeads.filter((b) => b.status === 'pending').length;
  const successRate = total > 0 ? Math.round((done / total) * 100) : 0;

  const lastBead  = [...allBeads].sort((a, b) =>
    (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at)
  )[0];

  lines.push(
    `  📊  ${col(bold('Ledger'), 14)}${col(gray(rigName + '/'), 12)}` +
    `${bold(String(total))} beads  ` +
    `${green(String(done) + ' done')}  ` +
    (inFlight > 0 ? `${cyan(String(inFlight) + ' in-flight')}  ` : '') +
    (pending > 0  ? `${gray(String(pending) + ' pending')}  ` : '') +
    (blocked > 0  ? `${yellow(String(blocked) + ' blocked')}  ` : '') +
    (failed > 0   ? `${red(String(failed) + ' failed')}  ` : ''),
  );

  if (total > 0) {
    const bar = progressBar(done, total, 22);
    lines.push(
      `     ${gray(' '.repeat(14))}${bar}  ${gray(successRate + '% success')}  last: ${relativeTime(lastBead?.updated_at ?? lastBead?.created_at)}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

// ── Bead queue sections ───────────────────────────────────────────────────────

export function renderQueue(rigName: string, limit = 8): string {
  const ledger  = new Ledger();
  const allBeads = latestBeads(ledger.readBeads(rigName));
  const lines: string[] = [];

  const inProgress = allBeads.filter((b) => b.status === 'in_progress');
  const blocked    = allBeads.filter((b) => b.status === 'blocked');
  const pending    = allBeads.filter((b) => b.status === 'pending').slice(0, limit);

  function beadRow(b: Bead, extraRight = ''): string {
    const icon   = beadStatusIcon(b);
    const id     = gray(b.bead_id.slice(0, 8));
    const type   = col(beadStatusColor(b, b.task_type ?? '—'), 30);
    const model  = b.model ? dim(b.model.replace(/.*\//, '').slice(0, 20)) : '';
    const dur    = b.metrics?.duration_ms ? gray(' ' + durationMs(b.metrics.duration_ms)) : '';
    return `  ${icon}  ${id}  ${type}  ${model}${dur}  ${extraRight}`;
  }

  if (inProgress.length > 0) {
    lines.push(divider('In Progress', 62));
    for (const b of inProgress) {
      const age = relativeTime(b.updated_at ?? b.created_at);
      lines.push(beadRow(b, age));
    }
  }

  if (blocked.length > 0) {
    lines.push(divider('Blocked', 62));
    for (const b of blocked) {
      const needs = b.needs.length > 0 ? gray(' ← ' + b.needs.slice(0, 2).map((id) => id.slice(0, 8)).join(', ')) : '';
      lines.push(beadRow(b, needs));
    }
  }

  if (pending.length > 0) {
    lines.push(divider('On Deck', 62));
    for (const b of pending) {
      lines.push(beadRow(b));
    }
    const extra = allBeads.filter((b) => b.status === 'pending').length - pending.length;
    if (extra > 0) lines.push(`  ${gray('  … ' + extra + ' more pending')}`);
  }

  if (inProgress.length + blocked.length + pending.length === 0) {
    lines.push('');
    lines.push(`  ${gray('No active work.')}`);
  }

  lines.push('');
  return lines.join('\n');
}
