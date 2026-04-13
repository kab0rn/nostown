// NOS Town — KG Programmatic Tools
// Wraps KnowledgeGraph for agent use: kg_query, kg_insert, kg_traverse.
// These are the tool interfaces referenced in KNOWLEDGE_GRAPH.md §MCP Tools.

import { KnowledgeGraph } from './index.js';
import type { KGTriple } from '../types/index.js';

export interface KgQueryParams {
  subject: string;
  as_of?: string;      // ISO date — default today
  relation?: string;   // optional filter
}

export interface KgInsertParams {
  subject: string;
  relation: string;
  object: string;
  agent_id: string;
  valid_from?: string;
  metadata?: Record<string, unknown>;
}

export interface KgTraverseResult {
  node: string;
  depth: number;
  triples: KGTriple[];
}

/**
 * kg_query — return active triples for a subject, optionally filtered by relation.
 * Mirrors KNOWLEDGE_GRAPH.md `kg_query`.
 */
export function kgQuery(kg: KnowledgeGraph, params: KgQueryParams): KGTriple[] {
  const today = new Date().toISOString().slice(0, 10);
  const asOf = params.as_of ?? today;
  const all = kg.queryEntity(params.subject, asOf);

  if (params.relation) {
    return all.filter((t) => t.relation === params.relation);
  }
  return all;
}

/**
 * kg_insert — add a triple to the KG.
 * Mirrors KNOWLEDGE_GRAPH.md `kg_add`.
 */
export function kgInsert(kg: KnowledgeGraph, params: KgInsertParams): void {
  const today = new Date().toISOString().slice(0, 10);
  kg.addTriple({
    subject: params.subject,
    relation: params.relation,
    object: params.object,
    valid_from: params.valid_from ?? today,
    agent_id: params.agent_id,
    metadata: params.metadata ?? {},
    created_at: new Date().toISOString(),
  });
}

/**
 * kg_traverse — BFS traversal of the KG graph from a root node.
 * Follows relation edges up to maxDepth hops, collecting all reached nodes.
 * Used for dependency chain analysis and blast-radius estimation.
 */
export function kgTraverse(
  kg: KnowledgeGraph,
  rootSubject: string,
  maxDepth = 3,
  asOf?: string,
): KgTraverseResult[] {
  const today = new Date().toISOString().slice(0, 10);
  const date = asOf ?? today;

  const visited = new Set<string>([rootSubject]);
  const results: KgTraverseResult[] = [];
  const queue: Array<{ node: string; depth: number }> = [{ node: rootSubject, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift()!;
    const { node, depth } = item;

    const triples = kg.queryEntity(node, date);
    results.push({ node, depth, triples });

    if (depth < maxDepth) {
      // Follow object nodes that haven't been visited
      for (const triple of triples) {
        if (!visited.has(triple.object)) {
          visited.add(triple.object);
          queue.push({ node: triple.object, depth: depth + 1 });
        }
      }
    }
  }

  return results;
}

/**
 * kg_invalidate — mark a triple as no longer active.
 * Mirrors KNOWLEDGE_GRAPH.md `kg_invalidate`.
 */
export function kgInvalidate(
  kg: KnowledgeGraph,
  tripleId: number,
  validTo: string,
  reason?: string,
): boolean {
  return kg.invalidateTriple(tripleId, validTo, reason);
}

/**
 * kg_timeline — full history of triples for a subject.
 * Mirrors KNOWLEDGE_GRAPH.md `kg_timeline`.
 */
export function kgTimeline(kg: KnowledgeGraph, subject: string): KGTriple[] {
  return kg.getTimeline(subject);
}
