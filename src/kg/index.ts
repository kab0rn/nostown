// NOS Town — Knowledge Graph (SQLite Triple Store)

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import type { KGTriple, TripleClass } from '../types/index.js';
import { ROLE_PRECEDENCE } from '../types/index.js';

const DB_PATH = path.resolve(process.env.NOS_PALACE_DB ?? 'palace-db/knowledge_graph.sqlite');

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export class KnowledgeGraph {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? DB_PATH;
    ensureDir(resolvedPath);
    this.db = new Database(resolvedPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triples (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        subject     TEXT NOT NULL,
        relation    TEXT NOT NULL,
        object      TEXT NOT NULL,
        valid_from  TEXT NOT NULL,
        valid_to    TEXT,
        agent_id    TEXT NOT NULL,
        metadata    TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subject    ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_relation   ON triples(relation);
      CREATE INDEX IF NOT EXISTS idx_valid_from ON triples(valid_from);
      CREATE INDEX IF NOT EXISTS idx_valid_to   ON triples(valid_to);
    `);
  }

  addTriple(triple: Omit<KGTriple, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO triples (subject, relation, object, valid_from, valid_to, agent_id, metadata, created_at)
      VALUES (@subject, @relation, @object, @valid_from, @valid_to, @agent_id, @metadata, @created_at)
    `);
    const result = stmt.run({
      subject: triple.subject,
      relation: triple.relation,
      object: triple.object,
      valid_from: triple.valid_from,
      valid_to: triple.valid_to ?? null,
      agent_id: triple.agent_id,
      metadata: triple.metadata ? JSON.stringify(triple.metadata) : null,
      created_at: triple.created_at,
    });
    return result.lastInsertRowid as number;
  }

  /**
   * Query active triples for a subject.
   * as_of defaults to today (current active triples have valid_to = NULL or valid_to >= as_of)
   */
  queryTriples(subject: string, asOf?: string, relation?: string): KGTriple[] {
    const date = asOf ?? new Date().toISOString().slice(0, 10);
    let sql = `
      SELECT * FROM triples
      WHERE subject = @subject
        AND valid_from <= @date
        AND (valid_to IS NULL OR valid_to > @date)
    `;
    const params: Record<string, string> = { subject, date };

    if (relation) {
      sql += ' AND relation = @relation';
      params.relation = relation;
    }

    sql += ' ORDER BY valid_from DESC, created_at DESC';

    const rows = this.db.prepare(sql).all(params) as Array<Record<string, unknown>>;
    return rows.map(this.rowToTriple);
  }

  /**
   * Query all active triples by subject or object (entity lookup)
   */
  queryEntity(entity: string, asOf?: string): KGTriple[] {
    const date = asOf ?? new Date().toISOString().slice(0, 10);
    const rows = this.db.prepare(`
      SELECT * FROM triples
      WHERE (subject = @entity OR object = @entity)
        AND valid_from <= @date
        AND (valid_to IS NULL OR valid_to > @date)
      ORDER BY valid_from DESC, created_at DESC
    `).all({ entity, date }) as Array<Record<string, unknown>>;
    return rows.map(this.rowToTriple);
  }

  /**
   * Invalidate a triple by setting valid_to
   */
  invalidateTriple(id: number, validTo: string, reason?: string): boolean {
    const triple = this.db.prepare('SELECT * FROM triples WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!triple) return false;

    const meta = triple.metadata ? JSON.parse(triple.metadata as string) : {};
    if (reason) meta.invalidation_reason = reason;

    this.db.prepare(`
      UPDATE triples SET valid_to = @validTo, metadata = @metadata WHERE id = @id
    `).run({ validTo, metadata: JSON.stringify(meta), id });

    return true;
  }

  /**
   * Full history of all triples touching a subject, ordered by valid_from asc
   */
  getTimeline(subject: string): KGTriple[] {
    const rows = this.db.prepare(`
      SELECT * FROM triples
      WHERE subject = @subject OR object = @subject
      ORDER BY valid_from ASC, created_at ASC
    `).all({ subject }) as Array<Record<string, unknown>>;
    return rows.map(this.rowToTriple);
  }

  /**
   * Resolve conflict between two triples using class-aware rules.
   * Returns the "winning" triple.
   */
  resolveConflict(a: KGTriple, b: KGTriple): KGTriple {
    const classA = (a.metadata?.class ?? 'advisory') as TripleClass;
    const classB = (b.metadata?.class ?? 'advisory') as TripleClass;

    // Both must be same class for a fair comparison; use a's class
    const tripleClass = classA;

    if (tripleClass === 'critical') {
      return this.resolveCritical(a, b);
    } else if (tripleClass === 'historical') {
      // historical triples are append-only; both win (caller should not call resolveConflict)
      return a;
    } else {
      // advisory: Most Informative Merge (MIM)
      return this.resolveAdvisoryMIM(a, b);
    }
  }

  private resolveCritical(a: KGTriple, b: KGTriple): KGTriple {
    // Role precedence: historian > mayor > witness > safeguard > polecat
    const roleA = this.extractRole(a.agent_id);
    const roleB = this.extractRole(b.agent_id);
    const precA = ROLE_PRECEDENCE[roleA] ?? 0;
    const precB = ROLE_PRECEDENCE[roleB] ?? 0;

    if (precA !== precB) return precA > precB ? a : b;

    // Later valid_from wins
    if (a.valid_from > b.valid_from) return a;
    if (b.valid_from > a.valid_from) return b;

    // Contradictory — mark conflict_pending (return a but caller should flag)
    return a;
  }

  private resolveAdvisoryMIM(a: KGTriple, b: KGTriple): KGTriple {
    // Most Informative Merge: more metadata fields wins
    const metaA = Object.keys(a.metadata ?? {}).length;
    const metaB = Object.keys(b.metadata ?? {}).length;

    if (metaA > metaB) return a;
    if (metaB > metaA) return b;

    // Later valid_from wins
    if (a.valid_from > b.valid_from) return a;
    if (b.valid_from > a.valid_from) return b;

    // Lexicographic tiebreaker on object
    return a.object >= b.object ? a : b;
  }

  private extractRole(agentId: string): string {
    // agent_id format: "mayor_01", "historian_01", etc.
    return agentId.split('_')[0] ?? agentId;
  }

  /**
   * Compute state hash of last 100 triple IDs + created_at
   */
  computeStateHash(): string {
    const rows = this.db.prepare(`
      SELECT id, created_at FROM triples ORDER BY id DESC LIMIT 100
    `).all() as Array<{ id: number; created_at: string }>;

    const payload = rows.map((r) => `${r.id}:${r.created_at}`).join(',');
    return createHash('sha256').update(payload).digest('hex');
  }

  close(): void {
    this.db.close();
  }

  private rowToTriple(row: Record<string, unknown>): KGTriple {
    return {
      id: row.id as number,
      subject: row.subject as string,
      relation: row.relation as string,
      object: row.object as string,
      valid_from: row.valid_from as string,
      valid_to: row.valid_to as string | undefined,
      agent_id: row.agent_id as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      created_at: row.created_at as string,
    };
  }
}
