// NOS Town — Convoy Bus (file-based mailbox system)

import fs from 'fs';
import path from 'path';
import type { ConvoyMessage } from '../types/index.js';
import { loadPublicKey } from './sign.js';
import { validateConvoy } from './verify.js';
import { auditLog } from '../hardening/audit.js';

const QUARANTINE_DIR = process.env.NOS_QUARANTINE_DIR ?? 'nos/quarantine';

function getRigsRoot(): string {
  return process.env.NOS_RIGS_ROOT ?? 'rigs';
}

function mailboxInboxPath(rigName: string, role: string): string {
  return path.resolve(getRigsRoot(), rigName, 'mailboxes', role, 'inbox');
}

function quarantinePath(): string {
  return path.resolve(QUARANTINE_DIR);
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export class ConvoyBus {
  private rigName: string;
  private transportSecret?: string;
  /**
   * In-memory sequence counter per sender to enforce monotonicity.
   * Per-instance to avoid cross-test pollution.
   */
  private seqCounters = new Map<string, number>();

  constructor(rigName: string, transportSecret?: string) {
    this.rigName = rigName;
    this.transportSecret = transportSecret ?? process.env.NOS_CONVOY_SECRET;
  }

  /**
   * Get the next monotonically increasing sequence number for a sender.
   */
  getNextSeq(senderId: string): number {
    const current = this.seqCounters.get(senderId) ?? 0;
    const next = current + 1;
    this.seqCounters.set(senderId, next);
    return next;
  }

  /**
   * Save a signed convoy to the recipient's mailbox.
   */
  saveToMailbox(convoy: ConvoyMessage): void {
    const role = convoy.header.recipient;
    const inboxDir = mailboxInboxPath(this.rigName, role);
    ensureDir(inboxDir);

    const ts = convoy.header.timestamp.replace(/[:.]/g, '-');
    const seq = String(convoy.header.seq).padStart(8, '0');
    const sender = convoy.header.sender_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${ts}_${seq}_${sender}.convoy.json`;
    const filePath = path.join(inboxDir, filename);

    fs.writeFileSync(filePath, JSON.stringify(convoy, null, 2), 'utf8');
  }

  /**
   * Send a convoy to the recipient's mailbox.
   * Enforces: seq monotonicity, BEAD_DISPATCH checkpoint guard.
   */
  async send(convoy: ConvoyMessage): Promise<void> {
    const { sender_id, seq } = convoy.header;

    // Enforce seq monotonicity
    const lastSeq = this.seqCounters.get(sender_id) ?? 0;
    if (seq <= lastSeq) {
      throw new Error(
        `Replay attack detected: ${sender_id} sent seq ${seq} but last was ${lastSeq}`,
      );
    }
    this.seqCounters.set(sender_id, seq);

    // MAYOR_CHECKPOINT_MISSING guard (HARDENING.md §1.2.1, CONVOYS.md §4)
    if (convoy.payload.type === 'BEAD_DISPATCH') {
      const checkpointId = (convoy.payload.data as Record<string, unknown>)?.plan_checkpoint_id;
      if (!checkpointId) {
        throw new Error(
          `MAYOR_CHECKPOINT_MISSING: BEAD_DISPATCH from ${sender_id} missing plan_checkpoint_id`,
        );
      }
    }

    auditLog('CONVOY_SENT', sender_id, convoy.header.recipient, convoy.payload.type);
    this.saveToMailbox(convoy);
  }

  /**
   * Read and validate all convoys in a role's inbox.
   * Valid convoys are returned and passed to handler.
   * Invalid convoys are quarantined.
   */
  async processInbox(
    role: string,
    handler: (convoy: ConvoyMessage) => Promise<void>,
  ): Promise<number> {
    const inboxDir = mailboxInboxPath(this.rigName, role);
    if (!fs.existsSync(inboxDir)) return 0;

    const rawFiles = fs.readdirSync(inboxDir)
      .filter((f) => f.endsWith('.convoy.json'))
      .sort(); // lexicographic = FIFO baseline

    // Priority-aware draining (CONVOYS.md §4):
    // critical_path=true > fan_out_weight DESC > priority > FIFO
    interface PrioritizedEntry { file: string; score: number }
    const entries: PrioritizedEntry[] = rawFiles.map((file) => {
      let score = 0;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(inboxDir, file), 'utf8')) as ConvoyMessage;
        const d = data.payload.data as Record<string, unknown> | undefined;
        if (d?.critical_path === true) score += 100_000;
        if (typeof d?.fan_out_weight === 'number') score += (d.fan_out_weight as number) * 100;
        const prio = d?.priority as string | undefined;
        if (prio === 'high') score += 10;
        else if (prio === 'normal') score += 5;
      } catch {
        // unparseable files get score 0 (FIFO position)
      }
      return { file, score };
    });
    entries.sort((a, b) => b.score - a.score); // descending priority

    const files = entries.map((e) => e.file);
    let processed = 0;

    for (const file of files) {
      const filePath = path.join(inboxDir, file);
      let convoy: ConvoyMessage;

      try {
        convoy = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ConvoyMessage;
      } catch (err) {
        console.error(`[ConvoyBus] Failed to parse convoy file ${file}: ${String(err)}`);
        this.quarantine(filePath, 'parse_failure');
        continue;
      }

      // Validate signature
      let publicKeyHex: string;
      try {
        publicKeyHex = loadPublicKey(convoy.header.sender_id);
      } catch {
        console.error(`[ConvoyBus] No public key for ${convoy.header.sender_id}`);
        this.quarantine(filePath, 'missing_public_key');
        continue;
      }

      const result = await validateConvoy(convoy, publicKeyHex, this.transportSecret);
      if (!result.ok) {
        console.error(`[ConvoyBus] Convoy validation failed for ${file}: ${result.reason}`);
        auditLog('CONVOY_QUARANTINED', convoy.header.sender_id, convoy.header.recipient, result.reason);
        this.quarantine(filePath, result.reason);
        continue;
      }

      try {
        await handler(convoy);
        // Remove processed file
        fs.unlinkSync(filePath);
        processed++;
      } catch (err) {
        console.error(`[ConvoyBus] Handler error for ${file}: ${String(err)}`);
      }
    }

    return processed;
  }

  /**
   * Read inbox convoys without processing/deleting (for inspection)
   */
  readInbox(role: string): ConvoyMessage[] {
    const inboxDir = mailboxInboxPath(this.rigName, role);
    if (!fs.existsSync(inboxDir)) return [];

    const files = fs.readdirSync(inboxDir)
      .filter((f) => f.endsWith('.convoy.json'))
      .sort();

    const convoys: ConvoyMessage[] = [];
    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(inboxDir, file), 'utf8');
        convoys.push(JSON.parse(data) as ConvoyMessage);
      } catch {
        // skip malformed files
      }
    }
    return convoys;
  }

  /**
   * Count unread convoys for backpressure detection.
   */
  inboxCount(role: string): number {
    const inboxDir = mailboxInboxPath(this.rigName, role);
    if (!fs.existsSync(inboxDir)) return 0;
    return fs.readdirSync(inboxDir).filter((f) => f.endsWith('.convoy.json')).length;
  }

  private quarantine(filePath: string, reason: string): void {
    const qDir = quarantinePath();
    ensureDir(qDir);
    const basename = path.basename(filePath);
    const dest = path.join(qDir, `${Date.now()}_${basename}`);

    try {
      fs.renameSync(filePath, dest);
      // Write reason alongside
      fs.writeFileSync(dest + '.reason', reason, 'utf8');
    } catch {
      // If rename fails (cross-device), copy + delete
      try {
        fs.copyFileSync(filePath, dest);
        fs.unlinkSync(filePath);
        fs.writeFileSync(dest + '.reason', reason, 'utf8');
      } catch (err) {
        console.error(`[ConvoyBus] Failed to quarantine ${filePath}: ${String(err)}`);
      }
    }
  }
}
