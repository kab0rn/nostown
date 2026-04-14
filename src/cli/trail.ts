// NOS Town — `nt trail` activity feed
// Shows recent bead executions, heartbeat events, and milestone completions.

import { Ledger } from '../ledger/index.js';
import type { Bead, HeartbeatEvent } from '../types/index.js';
import {
  bold, dim, green, red, yellow, cyan, gray, magenta,
  divider, col, hhmm, relativeTime, durationMs, padEnd,
  ROLE_ICON, STATUS_ICON,
} from './ui.js';

// In-process event log for heartbeat events (cleared on `nt trail --clear`)
const MAX_EVENTS = 200;
const eventLog: TrailEvent[] = [];

export type TrailEventType =
  | 'bead_complete'
  | 'bead_failed'
  | 'bead_blocked'
  | 'plan_start'
  | 'plan_complete'
  | 'heartbeat'
  | 'stall'
  | 'lockdown'
  | 'historian_run';

export interface TrailEvent {
  ts: Date;
  type: TrailEventType;
  message: string;
  detail?: string;
  beadId?: string;
  role?: string;
}

export function appendEvent(event: TrailEvent): void {
  eventLog.push(event);
  if (eventLog.length > MAX_EVENTS) eventLog.shift();
}

/** Translate HeartbeatEvent into a TrailEvent and record it. */
export function recordHeartbeat(event: HeartbeatEvent): void {
  switch (event.type) {
    case 'POLECAT_STALLED':
      appendEvent({
        ts: new Date(),
        type: 'stall',
        message: `${event.agent_id} stalled on ${event.bead_id.slice(0, 8)}`,
        detail: `${Math.round(event.stall_duration_ms / 1000)}s stall`,
        beadId: event.bead_id,
        role: 'polecat',
      });
      break;

    case 'BEAD_BLOCKED':
      appendEvent({
        ts: new Date(),
        type: 'bead_blocked',
        message: `bead ${event.bead_id.slice(0, 8)} blocked`,
        detail: `retry #${event.retry_count}`,
        beadId: event.bead_id,
      });
      break;

    case 'PROVIDER_EXHAUSTED':
      appendEvent({
        ts: new Date(),
        type: 'heartbeat',
        message: `provider exhausted — ${event.model}`,
        detail: event.error.slice(0, 60),
      });
      break;

    case 'PROVIDER_RECOVERED':
      appendEvent({
        ts: new Date(),
        type: 'heartbeat',
        message: 'provider recovered',
        detail: event.recovered_at,
      });
      break;

    case 'POTENTIAL_DEADLOCK':
      appendEvent({
        ts: new Date(),
        type: 'stall',
        message: `potential deadlock on ${event.bead_id.slice(0, 8)}`,
        detail: `${event.reason}  ${Math.round(event.stall_duration_ms / 1000)}s`,
        beadId: event.bead_id,
      });
      break;

    case 'CONVOY_BLOCKED':
      appendEvent({
        ts: new Date(),
        type: 'bead_blocked',
        message: `convoy blocked — ${event.bead_id.slice(0, 8)}`,
        detail: event.reason.slice(0, 60),
        beadId: event.bead_id,
      });
      break;

    case 'MODEL_DEPRECATED':
      appendEvent({
        ts: new Date(),
        type: 'heartbeat',
        message: `model deprecated: ${event.model}`,
        detail: `→ ${event.fallback}`,
      });
      break;

    case 'MAYOR_MISSING':
      appendEvent({
        ts: new Date(),
        type: 'heartbeat',
        message: 'mayor missing',
        detail: `last seen ${event.last_seen_at}`,
      });
      break;
  }
}

/** Record a plan start event. */
export function recordPlanStart(planId: string, beadCount: number, description: string): void {
  appendEvent({
    ts: new Date(),
    type: 'plan_start',
    message: `plan ${planId.slice(0, 8)} — ${description.slice(0, 50)}`,
    detail: `${beadCount} beads`,
  });
}

/** Record a bead completion from the ledger (call after appendBead). */
export function recordBeadComplete(bead: Bead): void {
  const success = bead.outcome === 'SUCCESS' || bead.status === 'done';
  appendEvent({
    ts: new Date(),
    type: success ? 'bead_complete' : 'bead_failed',
    message: `${bead.task_type ?? 'unknown'}`,
    detail: bead.metrics?.duration_ms ? durationMs(bead.metrics.duration_ms) : undefined,
    beadId: bead.bead_id,
    role: bead.role,
  });
}

// ── Render functions ──────────────────────────────────────────────────────────

function eventIcon(type: TrailEventType): string {
  switch (type) {
    case 'bead_complete': return STATUS_ICON.done;
    case 'bead_failed':  return STATUS_ICON.failed;
    case 'bead_blocked': return STATUS_ICON.blocked;
    case 'plan_start':   return cyan('▶');
    case 'plan_complete':return green('▶');
    case 'stall':        return yellow('⚠');
    case 'lockdown':     return red('🔒');
    case 'historian_run':return ROLE_ICON.historian;
    case 'heartbeat':    return gray('·');
  }
}

function eventColor(type: TrailEventType, text: string): string {
  switch (type) {
    case 'bead_complete': return green(text);
    case 'bead_failed':   return red(text);
    case 'bead_blocked':  return yellow(text);
    case 'plan_start':
    case 'plan_complete': return cyan(text);
    case 'stall':         return yellow(text);
    case 'lockdown':      return red(text);
    case 'historian_run': return magenta(text);
    case 'heartbeat':     return gray(text);
  }
}

/** Render in-process trail events (heartbeats, stalls, plan starts). */
export function renderTrail(limitEvents = 30): string {
  const lines: string[] = [];
  lines.push(divider('Activity', 62));

  const recent = eventLog.slice(-limitEvents);
  if (recent.length === 0) {
    lines.push(`  ${gray('No activity yet.')}`);
  } else {
    for (const ev of recent.reverse()) {
      const time = gray(hhmm(ev.ts));
      const icon = eventIcon(ev.type);
      const msg  = col(eventColor(ev.type, ev.message), 46);
      const detail = ev.detail ? dim(ev.detail) : '';
      lines.push(`  ${icon}  ${time}  ${msg}  ${detail}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** Render the ledger-backed bead history (recent completed beads). */
export function renderBeadHistory(rigName: string, limit = 20): string {
  const ledger = new Ledger();
  const raw = ledger.readBeads(rigName);

  // Collapse to last record per bead_id
  const byId = new Map<string, Bead>();
  for (const b of raw) byId.set(b.bead_id, b);

  const settled = [...byId.values()]
    .filter((b) => b.status === 'done' || b.status === 'failed' || b.status === 'blocked')
    .sort((a, b) =>
      (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at)
    )
    .slice(0, limit);

  const lines: string[] = [];
  lines.push(divider('Recent Beads', 62));

  if (settled.length === 0) {
    lines.push(`  ${gray('No completed beads.')}`);
  } else {
    for (const b of settled) {
      const icon = b.outcome === 'SUCCESS' || b.status === 'done'
        ? STATUS_ICON.done
        : b.status === 'blocked'
          ? STATUS_ICON.blocked
          : STATUS_ICON.failed;

      const time  = gray(hhmm(b.updated_at ?? b.created_at));
      const idStr = gray(b.bead_id.slice(0, 8));
      const type  = col(
        b.outcome === 'SUCCESS' || b.status === 'done'
          ? green(b.task_type ?? '—')
          : b.status === 'blocked'
            ? yellow(b.task_type ?? '—')
            : red(b.task_type ?? '—'),
        28,
      );
      const model = dim(
        (b.model ?? '').replace(/.*\//, '').slice(0, 22)
      );
      const dur   = b.metrics?.duration_ms
        ? gray(' ' + durationMs(b.metrics.duration_ms))
        : '';

      lines.push(`  ${icon}  ${time}  ${idStr}  ${type}  ${model}${dur}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** Render a milestone summary: plan completion stats from ledger. */
export function renderMilestones(rigName: string): string {
  const ledger = new Ledger();
  const raw = ledger.readBeads(rigName);

  // Group by plan_checkpoint_id
  const byPlan = new Map<string, Bead[]>();
  for (const b of raw) {
    const pid = b.plan_checkpoint_id ?? 'ad-hoc';
    const arr = byPlan.get(pid) ?? [];
    arr.push(b);
    byPlan.set(pid, arr);
  }

  const lines: string[] = [];
  lines.push(divider('Plans', 62));

  if (byPlan.size === 0) {
    lines.push(`  ${gray('No plans recorded.')}`);
    lines.push('');
    return lines.join('\n');
  }

  // Collapse to latest per bead_id within each plan
  for (const [planId, beads] of [...byPlan.entries()].slice(-8)) {
    const latest = new Map<string, Bead>();
    for (const b of beads) latest.set(b.bead_id, b);
    const all   = [...latest.values()];
    const total = all.length;
    const done  = all.filter((b) => b.outcome === 'SUCCESS' || b.status === 'done').length;
    const fail  = all.filter((b) => b.status === 'failed').length;
    const blk   = all.filter((b) => b.status === 'blocked').length;
    const inf   = all.filter((b) => b.status === 'in_progress').length;

    const planStatus =
      inf > 0   ? cyan('● in-progress') :
      fail > 0  ? red('✗ partial') :
      blk > 0   ? yellow('⏸ blocked') :
      done === total ? green('✓ complete') :
      gray('○ pending');

    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const pid  = bold(planId.slice(0, 12));

    lines.push(
      `  ${col(pid, 14)}  ${col(planStatus, 22)}  ${col(gray(done + '/' + total + ' beads'), 12)}  ${gray(pct + '%')}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}
