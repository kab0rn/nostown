// NOS Town — Convoy Bus (file-based mailbox system)

import fs from 'fs';
import path from 'path';
import type { ConvoyMessage } from '../types/index.js';
import { loadPublicKey } from './sign.js';
import { validateConvoy } from './verify.js';

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
   * Send a convoy to the recipient's mailbox after validating seq monotonicity.
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

    const files = fs.readdirSync(inboxDir)
      .filter((f) => f.endsWith('.convoy.json'))
      .sort(); // lexicographic = chronological by timestamp prefix

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
