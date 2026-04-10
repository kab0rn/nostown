// NOS Town — KG State Hash Exchange Monitor
// Per MEMPALACE.md §Consistency & Conflict Resolution:
// Every 500ms, compare local KG state hash against MemPalace server hash.
// On mismatch: pause writes, fetch missing triples via kgTimeline, apply DCR, resume.

import type { KGTriple } from '../types/index.js';
import type { KnowledgeGraph } from './index.js';
import type { MemPalaceClient } from '../mempalace/client.js';

export interface SyncMonitorConfig {
  /** Poll interval in ms (default: 500) */
  intervalMs?: number;
  /** Max reconcile attempts per cycle before giving up (default: 3) */
  maxReconcileAttempts?: number;
  /** Subjects to watch for hash divergence (empty = all) */
  watchedSubjects?: string[];
}

export interface SyncStatus {
  lastLocalHash: string;
  lastRemoteHash: string;
  inSync: boolean;
  reconcileCount: number;
  lastReconcileAt: string | null;
  writePaused: boolean;
}

export class KGSyncMonitor {
  private kg: KnowledgeGraph;
  private palace: MemPalaceClient;
  private intervalMs: number;
  private maxReconcileAttempts: number;
  private watchedSubjects: string[];

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLocalHash = '';
  private lastRemoteHash = '';
  /** True while a reconcile pass is in progress — callers should not write */
  writePaused = false;
  private reconcileCount = 0;
  private lastReconcileAt: string | null = null;

  constructor(kg: KnowledgeGraph, palace: MemPalaceClient, config: SyncMonitorConfig = {}) {
    this.kg = kg;
    this.palace = palace;
    this.intervalMs = config.intervalMs ?? 500;
    this.maxReconcileAttempts = config.maxReconcileAttempts ?? 3;
    this.watchedSubjects = config.watchedSubjects ?? [];
  }

  /**
   * Start the 500ms polling loop.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkHash();
    }, this.intervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get status(): SyncStatus {
    return {
      lastLocalHash: this.lastLocalHash,
      lastRemoteHash: this.lastRemoteHash,
      inSync: this.lastLocalHash === this.lastRemoteHash,
      reconcileCount: this.reconcileCount,
      lastReconcileAt: this.lastReconcileAt,
      writePaused: this.writePaused,
    };
  }

  /**
   * Compute current local hash and compare against server.
   * Called every intervalMs.
   */
  async checkHash(): Promise<void> {
    if (this.writePaused) return; // already reconciling

    const localHash = this.kg.computeStateHash();

    try {
      const serverStatus = await this.palace.getStatus();
      const remoteHash = serverStatus.state_hash;

      this.lastLocalHash = localHash;
      this.lastRemoteHash = remoteHash;

      if (localHash !== remoteHash) {
        console.warn(`[KGSyncMonitor] Hash divergence detected — local: ${localHash.slice(0, 8)}, remote: ${remoteHash.slice(0, 8)}`);
        await this.reconcile();
      }
    } catch {
      // Palace offline — non-fatal, no local action needed
    }
  }

  /**
   * Reconcile local KG against remote.
   * Pauses writes, fetches triples via kgTimeline, applies DCR, resumes.
   */
  private async reconcile(): Promise<void> {
    this.writePaused = true;
    this.reconcileCount++;
    this.lastReconcileAt = new Date().toISOString();

    try {
      const subjects = this.watchedSubjects.length > 0
        ? this.watchedSubjects
        : this.getRecentSubjects();

      let merged = 0;
      for (const subject of subjects) {
        try {
          const remoteTriples = await this.palace.kgTimeline(subject);
          for (const remote of remoteTriples) {
            merged += this.mergeTriple(remote) ? 1 : 0;
          }
        } catch {
          // Subject fetch failed — skip, continue with others
        }
      }

      if (merged > 0) {
        console.log(`[KGSyncMonitor] Reconcile complete: ${merged} triples merged for ${subjects.length} subjects`);
      }

      // Refresh hash after merge
      this.lastLocalHash = this.kg.computeStateHash();
    } finally {
      this.writePaused = false;
    }
  }

  /**
   * Get recently-written subjects from the local KG (for broad reconciliation).
   * Falls back to empty list if the KG has no triples.
   */
  private getRecentSubjects(): string[] {
    try {
      // queryEntity with empty string and today's date returns recent triples
      const today = new Date().toISOString().slice(0, 10);
      const recent = this.kg.queryEntity('', today);
      const subjects = [...new Set(recent.map((t) => t.subject))];
      return subjects.slice(0, 50); // cap to avoid runaway reconcile
    } catch {
      return [];
    }
  }

  /**
   * Merge a single remote triple into the local KG using DCR rules.
   * Returns true if a change was applied.
   */
  private mergeTriple(remote: KGTriple): boolean {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const existing = this.kg.queryEntity(remote.subject, today)
        .find((t) => t.relation === remote.relation && t.object === remote.object);

      if (!existing) {
        // New triple — insert it
        this.kg.addTriple({
          subject: remote.subject,
          relation: remote.relation,
          object: remote.object,
          valid_from: remote.valid_from,
          valid_to: remote.valid_to,
          agent_id: remote.agent_id,
          metadata: remote.metadata,
          created_at: remote.created_at,
        });
        return true;
      }

      // Conflict — delegate to KnowledgeGraph.resolveConflict() for class-aware DCR.
      // Per KNOWLEDGE_GRAPH.md §Consistency: critical triples use role precedence (not MIM);
      // advisory triples use MIM. BUILDING.md §Correction 6 requires class-aware resolution.
      const winner = this.kg.resolveConflict(existing, remote);
      if (winner === remote) {
        // Remote wins — add it; KG's addTriple auto-invalidates lower-precedence conflicts
        // for critical relations. For advisory, we just add the richer triple.
        this.kg.addTriple({
          subject: remote.subject,
          relation: remote.relation,
          object: remote.object,
          valid_from: remote.valid_from,
          valid_to: remote.valid_to,
          agent_id: remote.agent_id,
          metadata: remote.metadata,
          created_at: remote.created_at,
        });
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }
}
