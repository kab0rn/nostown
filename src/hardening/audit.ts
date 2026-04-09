// NOS Town — Audit Logger
// Records sensitive operations to an append-only audit log.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export type AuditEventType =
  | 'BEAD_DISPATCHED'
  | 'BEAD_APPROVED'
  | 'BEAD_REJECTED'
  | 'CONVOY_SENT'
  | 'CONVOY_QUARANTINED'
  | 'CHECKPOINT_SAVED'
  | 'SCAN_COMPLETED'
  | 'KEY_LOADED'
  | 'AUTH_FAILED'
  | 'AUTHZ_DENIED';

export interface AuditEntry {
  ts: string;
  event: AuditEventType;
  actor: string;
  subject?: string;
  detail?: string;
  hash: string; // sha256 of (ts+event+actor+subject)
}

const AUDIT_DIR = process.env.NOS_AUDIT_DIR ?? 'nos/audit';

function auditFilePath(): string {
  const dir = path.resolve(AUDIT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'audit.jsonl');
}

function entryHash(ts: string, event: string, actor: string, subject: string): string {
  return createHash('sha256')
    .update(`${ts}|${event}|${actor}|${subject}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Write an audit log entry to the append-only audit file.
 * Failures are non-fatal — audit log errors must not block operations.
 */
export function auditLog(
  event: AuditEventType,
  actor: string,
  subject?: string,
  detail?: string,
): void {
  try {
    const ts = new Date().toISOString();
    const entry: AuditEntry = {
      ts,
      event,
      actor,
      subject,
      detail,
      hash: entryHash(ts, event, actor, subject ?? ''),
    };
    fs.appendFileSync(auditFilePath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Non-fatal — never block the caller due to audit log failure
  }
}

/**
 * Read all audit entries (for inspection/testing).
 */
export function readAuditLog(filePath?: string): AuditEntry[] {
  const fp = filePath ?? auditFilePath();
  if (!fs.existsSync(fp)) return [];

  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter((l) => l.trim());
  return lines.map((l) => {
    try {
      return JSON.parse(l) as AuditEntry;
    } catch {
      return null;
    }
  }).filter((e): e is AuditEntry => e !== null);
}
