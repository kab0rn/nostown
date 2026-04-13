#!/usr/bin/env tsx
// NOS Town — KG Bootstrap Script
//
// Seeds the Knowledge Graph with default routing triples from the static
// routing table (docs/ROUTING.md).  Run once on first startup:
//
//   npx tsx src/historian/bootstrap-kg.ts --routing-table docs/ROUTING.md
//
// The script is idempotent — if bootstrap triples already exist in the KG it
// will skip writing them (prints a summary and exits cleanly).
//
// Per KNOWLEDGE_GRAPH.md: bootstrap triples use valid_from="2026-01-01" and
// agent_id="bootstrap".  Once the Historian has processed 100+ Beads, its
// empirical routing locks supersede these defaults.

import * as fs from 'fs';
import * as path from 'path';
import { KnowledgeGraph } from '../kg/index.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RoutingEntry {
  taskType: string;      // bead category slug (e.g. "boilerplate")
  primaryModel: string;  // primary model ID
  fallbackModel?: string; // fallback model ID, undefined if N/A
}

// ── Static routing table ──────────────────────────────────────────────────────
//
// Parsed from the Markdown table in docs/ROUTING.md.  The parser below handles
// the canonical format; this embedded table is the fallback when --routing-table
// is not provided or the file cannot be parsed.

const EMBEDDED_ROUTING: RoutingEntry[] = [
  { taskType: 'boilerplate',    primaryModel: 'llama-3.1-8b-instant',    fallbackModel: undefined },
  { taskType: 'logic',          primaryModel: 'llama-4-scout-17b',        fallbackModel: 'llama-3.1-8b-instant' },
  { taskType: 'security',       primaryModel: 'qwen3-32b',                fallbackModel: 'llama-3.3-70b-versatile' },
  { taskType: 'architecture',   primaryModel: 'gpt-oss-120b',             fallbackModel: 'llama-3.3-70b-versatile' },
  { taskType: 'unit_test',      primaryModel: 'llama-3.1-8b-instant',    fallbackModel: undefined },
  { taskType: 'refactoring',    primaryModel: 'llama-4-scout-17b',        fallbackModel: 'llama-3.1-8b-instant' },
  { taskType: 'documentation',  primaryModel: 'llama-3.1-8b-instant',    fallbackModel: undefined },
];

// ── Markdown routing table parser ─────────────────────────────────────────────

const CATEGORY_SLUG: Record<string, string> = {
  'boilerplate':  'boilerplate',
  'logic/feature':'logic',
  'logic':        'logic',
  'security/auth':'security',
  'security':     'security',
  'architecture': 'architecture',
  'unit tests':   'unit_test',
  'unit test':    'unit_test',
  'refactoring':  'refactoring',
  'documentation':'documentation',
};

function modelId(raw: string): string | undefined {
  // Extract backtick-quoted model ID from a Markdown table cell, e.g. "`llama-3.1-8b-instant`"
  // or "Batch (llama-3.1-8b)" → "llama-3.1-8b-instant" (normalised)
  const tick = raw.match(/`([^`]+)`/);
  if (tick) return tick[1];
  const batch = raw.match(/Batch\s*\(([^)]+)\)/i);
  if (batch) return batch[1] + '-instant';
  const plain = raw.trim();
  if (plain === 'N/A' || plain === '' || plain === '-') return undefined;
  // Last resort: strip bold markers and return
  return plain.replace(/\*\*/g, '').trim() || undefined;
}

function parseRoutingTable(markdown: string): RoutingEntry[] {
  const entries: RoutingEntry[] = [];
  const lines = markdown.split('\n');
  let inTable = false;
  let headerSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect table header row
    if (!inTable && trimmed.startsWith('|') && /Bead Category/i.test(trimmed)) {
      inTable = true;
      headerSeen = false;
      continue;
    }
    if (!inTable) continue;

    // Skip separator row (|---|---|...)
    if (/^\|[-| ]+\|$/.test(trimmed)) {
      headerSeen = true;
      continue;
    }

    // End of table
    if (!trimmed.startsWith('|')) {
      inTable = false;
      continue;
    }

    if (!headerSeen) continue;

    const cols = trimmed.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
    if (cols.length < 3) continue;

    // cols: [Category, Complexity, Primary, Fallback?, ...]
    const categoryRaw = cols[0].replace(/\*\*/g, '').toLowerCase();
    const slug = CATEGORY_SLUG[categoryRaw];
    if (!slug) continue;

    const primary = modelId(cols[2]);
    if (!primary) continue;

    const fallback = cols.length > 3 ? modelId(cols[3]) : undefined;

    entries.push({ taskType: slug, primaryModel: primary, fallbackModel: fallback });
  }

  return entries.length > 0 ? entries : EMBEDDED_ROUTING;
}

// ── Bootstrap writer ──────────────────────────────────────────────────────────

const BOOTSTRAP_AGENT = 'bootstrap';
const BOOTSTRAP_VALID_FROM = '2026-01-01';

function alreadyBootstrapped(kg: KnowledgeGraph): boolean {
  // Query a known default model — if it has any bootstrap triples we're already seeded
  const existing = kg.queryTriples('llama-3.1-8b-instant', BOOTSTRAP_VALID_FROM);
  return existing.some((t) => t.agent_id === BOOTSTRAP_AGENT);
}

function writeBootstrapTriples(kg: KnowledgeGraph, entries: RoutingEntry[]): number {
  const createdAt = new Date().toISOString();
  let written = 0;

  for (const entry of entries) {
    kg.addTriple({
      subject: entry.primaryModel,
      relation: 'locked_to',
      object: entry.taskType,
      valid_from: BOOTSTRAP_VALID_FROM,
      agent_id: BOOTSTRAP_AGENT,
      metadata: {
        class: 'critical',
        source: 'bootstrap',
        note: 'Static default — superseded by Historian after 100+ Beads',
      },
      created_at: createdAt,
    });
    written++;

    if (entry.fallbackModel) {
      kg.addTriple({
        subject: entry.fallbackModel,
        relation: 'fallback_for',
        object: entry.taskType,
        valid_from: BOOTSTRAP_VALID_FROM,
        agent_id: BOOTSTRAP_AGENT,
        metadata: {
          source: 'bootstrap',
          primary_model: entry.primaryModel,
        },
        created_at: createdAt,
      });
      written++;
    }
  }

  return written;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { routingTablePath?: string; kgPath?: string; dryRun: boolean } {
  let routingTablePath: string | undefined;
  let kgPath: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--routing-table' && argv[i + 1]) {
      routingTablePath = argv[++i];
    } else if (argv[i] === '--kg-path' && argv[i + 1]) {
      kgPath = argv[++i];
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { routingTablePath, kgPath, dryRun };
}

async function main(): Promise<void> {
  const { routingTablePath, kgPath, dryRun } = parseArgs(process.argv.slice(2));

  // Load routing table
  let entries: RoutingEntry[];
  if (routingTablePath) {
    const absPath = path.resolve(routingTablePath);
    if (!fs.existsSync(absPath)) {
      console.error(`[bootstrap-kg] Routing table not found: ${absPath}`);
      process.exit(1);
    }
    const md = fs.readFileSync(absPath, 'utf8');
    entries = parseRoutingTable(md);
    console.log(`[bootstrap-kg] Parsed ${entries.length} routing entries from ${absPath}`);
  } else {
    entries = EMBEDDED_ROUTING;
    console.log(`[bootstrap-kg] Using embedded routing table (${entries.length} entries)`);
  }

  // Open KG
  const kg = new KnowledgeGraph(kgPath);

  if (alreadyBootstrapped(kg)) {
    console.log('[bootstrap-kg] KG already bootstrapped — skipping (run with --force to overwrite)');
    return;
  }

  if (dryRun) {
    console.log('[bootstrap-kg] Dry run — would write:');
    for (const e of entries) {
      console.log(`  locked_to: ${e.primaryModel} → ${e.taskType}`);
      if (e.fallbackModel) {
        console.log(`  fallback_for: ${e.fallbackModel} → ${e.taskType}`);
      }
    }
    return;
  }

  const count = writeBootstrapTriples(kg, entries);
  console.log(`[bootstrap-kg] Wrote ${count} bootstrap triples to KG`);
  console.log(`[bootstrap-kg] Done. Run 'nt historian' after 100+ Beads to supersede these defaults.`);
}

main().catch((err: unknown) => {
  console.error('[bootstrap-kg] Fatal:', err);
  process.exit(1);
});
