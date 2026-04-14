// NOS Town — Beads Ledger with per-rig partitioning

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import lockfile from 'proper-lockfile';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { Bead, BeadOutcome } from '../types/index.js';
import { ledgerLockWaitMs } from '../telemetry/metrics.js';

// ── Bead schema (HARDENING.md §2.1) ──────────────────────────────────────────
// Validates required fields before any ledger write.
// Optional fields are allowed through without constraint.
const BeadWriteSchema = z.object({
  bead_id: z.string().min(1),
  role: z.enum(['polecat', 'witness', 'safeguard', 'mayor', 'historian', 'refinery']),
  task_type: z.string().min(1),
  model: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done', 'failed', 'blocked']),
  needs: z.array(z.string()),
  critical_path: z.boolean(),
  witness_required: z.boolean(),
  fan_out_weight: z.number().nonnegative(),
  created_at: z.string().min(1),
});

const RIGS_ROOT = process.env.NOS_RIGS_ROOT ?? 'rigs';

function beadsPath(rigName: string): string {
  return path.resolve(RIGS_ROOT, rigName, 'beads', 'current.jsonl');
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function ensureFile(filePath: string): void {
  ensureDir(filePath);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf8');
  }
}

/**
 * Compute sha256 checksum over the bead JSON (without the checksum field itself)
 */
export function computeChecksum(bead: Bead): string {
  const { checksum: _, ...rest } = bead;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

export function validateChecksum(bead: Bead): boolean {
  if (!bead.checksum) return false;
  const expected = computeChecksum(bead);
  return bead.checksum === expected;
}

/** Default max ledger file size before rollover: 100MB */
const DEFAULT_LEDGER_MAX_BYTES = 100 * 1024 * 1024;

export class Ledger {
  private rigsRoot: string;
  private maxBytes: number;

  constructor(rigsRoot?: string) {
    // Read env var lazily (at construction time, not module load time) so tests can
    // set process.env.NOS_RIGS_ROOT in beforeAll before creating a Ledger instance.
    this.rigsRoot = path.resolve(rigsRoot ?? process.env.NOS_RIGS_ROOT ?? RIGS_ROOT);
    this.maxBytes = Number(process.env.NOS_LEDGER_MAX_BYTES ?? DEFAULT_LEDGER_MAX_BYTES);
  }

  private beadsPath(rigName: string): string {
    return path.join(this.rigsRoot, rigName, 'beads', 'current.jsonl');
  }

  private archivePath(rigName: string): string {
    return path.join(this.rigsRoot, rigName, 'beads', 'archive');
  }

  private manifestPath(rigName: string): string {
    return path.join(this.rigsRoot, rigName, 'beads', 'manifest.json');
  }

  /**
   * Archive the current ledger file when it exceeds NOS_LEDGER_MAX_BYTES.
   * Moves current.jsonl → beads/archive/YYYY-MM-DD-{timestamp}.jsonl
   * Updates beads/manifest.json with the archived segment entry.
   */
  private archiveCurrentFile(rigName: string, filePath: string): void {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const ts = now.getTime();
    const archiveDir = this.archivePath(rigName);
    fs.mkdirSync(archiveDir, { recursive: true });

    const archiveFile = path.join(archiveDir, `${dateStr}-${ts}.jsonl`);
    fs.renameSync(filePath, archiveFile);

    // Update manifest
    const manifestFile = this.manifestPath(rigName);
    let manifest: { segments: string[] } = { segments: [] };
    if (fs.existsSync(manifestFile)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { segments: string[] };
      } catch {
        manifest = { segments: [] };
      }
    }
    manifest.segments.push(archiveFile);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');

    // Re-create empty current.jsonl
    fs.writeFileSync(filePath, '', 'utf8');
    console.log(`[Ledger] Archived ${filePath} → ${archiveFile} (${manifest.segments.length} total segments)`);
  }

  /**
   * Append a bead to the rig's ledger file with per-rig file locking.
   */
  async appendBead(rigName: string, bead: Bead): Promise<void> {
    const filePath = this.beadsPath(rigName);
    ensureFile(filePath);

    // Compute checksum before writing (exclude existing checksum field)
    const beadWithChecksum: Bead = {
      ...bead,
      checksum: undefined,
    };
    beadWithChecksum.checksum = computeChecksum(beadWithChecksum);

    // Validate required fields
    if (!bead.bead_id) {
      throw new Error('Bead must have a bead_id');
    }
    if (!bead.role || !bead.task_type || !bead.model) {
      throw new Error('Bead must have role, task_type, and model');
    }

    let release: (() => Promise<void>) | null = null;
    const lockStart = Date.now();
    try {
      release = await lockfile.lock(filePath, {
        retries: { retries: 20, minTimeout: 20, maxTimeout: 200, factor: 1.5, randomize: true },
        stale: 15000,
        realpath: false,
      });
      ledgerLockWaitMs.record(Date.now() - lockStart, { rig: rigName });

      // Rollover check (HARDENING.md — NOS_LEDGER_MAX_BYTES)
      const stat = fs.statSync(filePath);
      if (stat.size >= this.maxBytes) {
        this.archiveCurrentFile(rigName, filePath);
      }

      fs.appendFileSync(filePath, JSON.stringify(beadWithChecksum) + '\n', 'utf8');
    } finally {
      await release?.();
    }
  }

  /**
   * Read lines from a single JSONL file and parse them into Beads (validates checksums).
   */
  private readBeadsFromFile(filePath: string): Bead[] {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
    const beads: Bead[] = [];
    for (const line of lines) {
      try {
        const bead = JSON.parse(line) as Bead;
        if (!validateChecksum(bead)) {
          console.error(`[Ledger] Corrupt bead detected: ${bead.bead_id} — checksum mismatch`);
          continue;
        }
        beads.push(bead);
      } catch {
        console.error(`[Ledger] Failed to parse bead line: ${line.slice(0, 80)}`);
      }
    }
    return beads;
  }

  /**
   * Read all beads from a rig's ledger (validates checksums on read).
   * Also scans archive segments listed in beads/manifest.json.
   */
  readBeads(rigName: string): Bead[] {
    const beads: Bead[] = [];

    // Read archive segments first (chronological order)
    const manifestFile = this.manifestPath(rigName);
    if (fs.existsSync(manifestFile)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { segments?: string[] };
        for (const segment of (manifest.segments ?? [])) {
          beads.push(...this.readBeadsFromFile(segment));
        }
      } catch {
        console.error(`[Ledger] Failed to read manifest for rig ${rigName}`);
      }
    }

    // Read current file last (most recent entries)
    const filePath = this.beadsPath(rigName);
    if (!fs.existsSync(filePath)) return beads;

    const lines = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());

    for (const line of lines) {
      try {
        const bead = JSON.parse(line) as Bead;
        if (!validateChecksum(bead)) {
          console.error(`[Ledger] Corrupt bead detected: ${bead.bead_id} — checksum mismatch`);
          continue;
        }
        beads.push(bead);
      } catch {
        console.error(`[Ledger] Failed to parse bead line: ${line.slice(0, 80)}`);
      }
    }
    return beads;
  }

  /**
   * Get the most recent record for a bead by ID (last write wins in append-only log).
   */
  getBead(beadId: string, rigName?: string): Bead | null {
    const rigs = rigName ? [rigName] : this.listRigs();
    for (const rig of rigs) {
      const beads = this.readBeads(rig);
      // Filter all records for this bead, return the last one (most recent state)
      const allRecords = beads.filter((b) => b.bead_id === beadId);
      if (allRecords.length > 0) {
        return allRecords[allRecords.length - 1];
      }
    }
    return null;
  }

  /**
   * Get the outcome of a bead by ID
   */
  getOutcome(beadId: string, rigName?: string): BeadOutcome | null {
    const bead = this.getBead(beadId, rigName);
    return bead?.outcome ?? null;
  }

  /**
   * Get prerequisite bead objects for a given bead
   */
  getPrerequisites(beadId: string, rigName?: string): Bead[] {
    const bead = this.getBead(beadId, rigName);
    if (!bead || bead.needs.length === 0) return [];

    const rigs = rigName ? [rigName] : this.listRigs();
    const prereqs: Bead[] = [];

    for (const needId of bead.needs) {
      for (const rig of rigs) {
        const found = this.getBead(needId, rig);
        if (found) {
          prereqs.push(found);
          break;
        }
      }
    }
    return prereqs;
  }

  /**
   * Update a bead's status/outcome (appends an updated record)
   */
  async updateBead(rigName: string, beadId: string, updates: Partial<Bead>): Promise<void> {
    const existing = this.getBead(beadId, rigName);
    if (!existing) {
      throw new Error(`Bead not found: ${beadId}`);
    }
    const updated: Bead = {
      ...existing,
      ...updates,
      bead_id: beadId,
      updated_at: new Date().toISOString(),
    };
    await this.appendBead(rigName, updated);
  }

  /**
   * Check if a successful bead with identical task_description + needs exists within the
   * last cacheTtlMs milliseconds (default: 7 days). Used for bead result caching (Enh 3.2).
   * Returns the most recent matching bead, or null if none found.
   */
  findCachedBead(
    taskDescription: string,
    needs: string[],
    rigName: string,
    cacheTtlMs = 7 * 24 * 60 * 60 * 1000,
  ): Bead | null {
    const beads = this.readBeads(rigName);
    const cutoff = new Date(Date.now() - cacheTtlMs).toISOString();
    // Group by bead_id and keep last record (most recent state)
    const latestByBead = new Map<string, Bead>();
    for (const b of beads) {
      latestByBead.set(b.bead_id, b);
    }
    const needsKey = [...needs].sort().join(',');
    for (const bead of latestByBead.values()) {
      if (
        bead.outcome === 'SUCCESS' &&
        bead.task_description === taskDescription &&
        [...(bead.needs ?? [])].sort().join(',') === needsKey &&
        (bead.updated_at ?? bead.created_at) >= cutoff
      ) {
        return bead;
      }
    }
    return null;
  }

  /**
   * List all rig names (directories in rigs/)
   */
  listRigs(): string[] {
    if (!fs.existsSync(this.rigsRoot)) return [];
    return fs.readdirSync(this.rigsRoot).filter((name) => {
      const beadsDir = path.join(this.rigsRoot, name, 'beads');
      return fs.existsSync(beadsDir);
    });
  }

  /**
   * Create a new bead with defaults
   */
  static createBead(partial: Partial<Bead> & { role: string; task_type: string; model: string }): Bead {
    return {
      bead_id: partial.bead_id ?? uuidv4(),
      role: partial.role,
      task_type: partial.task_type,
      model: partial.model,
      status: partial.status ?? 'pending',
      needs: partial.needs ?? [],
      witness_required: partial.witness_required ?? false,
      critical_path: partial.critical_path ?? false,
      fan_out_weight: partial.fan_out_weight ?? 1,
      plan_checkpoint_id: partial.plan_checkpoint_id,
      outcome: partial.outcome,
      metrics: partial.metrics,
      created_at: new Date().toISOString(),
      rig: partial.rig,
      task_description: partial.task_description,
    };
  }
}
