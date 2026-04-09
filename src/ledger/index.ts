// NOS Town — Beads Ledger with per-rig partitioning

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import lockfile from 'proper-lockfile';
import { v4 as uuidv4 } from 'uuid';
import type { Bead, BeadOutcome } from '../types/index.js';

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

export class Ledger {
  private rigsRoot: string;

  constructor(rigsRoot?: string) {
    // Read env var lazily (at construction time, not module load time) so tests can
    // set process.env.NOS_RIGS_ROOT in beforeAll before creating a Ledger instance.
    this.rigsRoot = path.resolve(rigsRoot ?? process.env.NOS_RIGS_ROOT ?? RIGS_ROOT);
  }

  private beadsPath(rigName: string): string {
    return path.join(this.rigsRoot, rigName, 'beads', 'current.jsonl');
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
    try {
      release = await lockfile.lock(filePath, {
        retries: { retries: 20, minTimeout: 20, maxTimeout: 200, factor: 1.5, randomize: true },
        stale: 15000,
        realpath: false,
      });
      fs.appendFileSync(filePath, JSON.stringify(beadWithChecksum) + '\n', 'utf8');
    } finally {
      await release?.();
    }
  }

  /**
   * Read all beads from a rig's ledger (validates checksums on read)
   */
  readBeads(rigName: string): Bead[] {
    const filePath = this.beadsPath(rigName);
    if (!fs.existsSync(filePath)) return [];

    const lines = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());

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
