// NOS Town — KG-Backed Model Routing Dispatcher
// Implements the routing rules from ROUTING.md:
// Playbook check → KG routing locks/demotions → role defaults

import { KnowledgeGraph } from '../kg/index.js';
import { getModelForRole, getFallbackModel } from '../groq/models.js';
import type { PlaybookEntry } from '../types/index.js';

export interface RoutingContext {
  role: string;
  taskType: string;
  rigName: string;
  complexity?: 'low' | 'medium' | 'high' | 'critical';
  playbookHit?: PlaybookEntry;
}

export interface RoutingDecision {
  model: string;
  fallback: string;
  locked: boolean;         // true if KG lock was found
  playbookUsed: boolean;   // true if playbook shortcut was taken
  reason: string;
}

/**
 * Routing complexity map for task types.
 * Mirrors ROUTING.md table.
 */
const TASK_COMPLEXITY: Record<string, 'low' | 'medium' | 'high' | 'critical'> = {
  unit_test: 'low',
  documentation: 'low',
  boilerplate: 'low',
  execute: 'medium',
  refactor: 'medium',
  logic: 'medium',
  feature: 'medium',
  security: 'high',
  auth: 'high',
  architecture: 'critical',
  review: 'medium',
  scan: 'high',
};

/**
 * Complexity → primary model mapping (preview-first escalation, ROUTING.md).
 */
const COMPLEXITY_MODELS: Record<string, string> = {
  low: 'llama-3.1-8b-instant',
  medium: 'meta-llama/llama-4-scout-17b-16e-instruct',
  high: 'qwen/qwen3-32b',
  critical: 'llama-3.3-70b-versatile',
};

export class RoutingDispatcher {
  private kg: KnowledgeGraph;

  constructor(kg: KnowledgeGraph) {
    this.kg = kg;
  }

  /**
   * Determine the model to use for a task.
   * Priority: KG lock > Playbook shortcut > Complexity table > Role default.
   */
  dispatch(ctx: RoutingContext): RoutingDecision {
    const fallback = getFallbackModel(ctx.role);

    // 1. Check KG for active routing lock
    const kgLock = this.queryKgLock(ctx.taskType);
    if (kgLock) {
      return {
        model: kgLock,
        fallback,
        locked: true,
        playbookUsed: false,
        reason: `KG routing lock: ${kgLock} locked_to ${ctx.taskType}`,
      };
    }

    // 2. Check for KG demotion (blocked model)
    const demoted = this.queryKgDemotion(ctx.taskType);

    // 3. Playbook shortcut — if hit with >90% success, lock to model_hint
    if (ctx.playbookHit?.model_hint) {
      const model = ctx.playbookHit.model_hint;
      return {
        model,
        fallback,
        locked: true,
        playbookUsed: true,
        reason: `Playbook shortcut: ${model} for ${ctx.taskType}`,
      };
    }

    // 4. Complexity-based routing
    const complexity = ctx.complexity ?? TASK_COMPLEXITY[ctx.taskType] ?? 'medium';
    const complexityModel = COMPLEXITY_MODELS[complexity] ?? getModelForRole(ctx.role, ctx.taskType);
    const model = demoted === complexityModel ? fallback : complexityModel;

    return {
      model,
      fallback,
      locked: false,
      playbookUsed: false,
      reason: `Complexity routing: ${complexity} → ${model}`,
    };
  }

  /**
   * Check if there is an active KG routing lock for this task type.
   * Returns the locked model name, or null if no lock.
   */
  private queryKgLock(taskType: string): string | null {
    const today = new Date().toISOString().slice(0, 10);

    // Find all models with a locked_to triple for this task type
    // (locked_to relation is stored as model → locked_to → taskType)
    // We query for the task type as object by searching all subjects
    // In practice, the Historian writes: subject=model, relation=locked_to, object=taskType
    // The KG doesn't currently support reverse lookups, so we rely on the model names
    // from ROLE_MODELS list and check each for locks.
    // For efficiency, we check common models in priority order.
    const modelsToCheck = Object.values(COMPLEXITY_MODELS);

    for (const model of modelsToCheck) {
      const triples = this.kg.queryEntity(model, today).filter((t) => t.relation === 'locked_to');
      if (triples.some((t) => t.object === taskType)) {
        return model;
      }
    }
    return null;
  }

  /**
   * Check if there is a KG demotion for this task type.
   * Returns the demoted model name, or null if no demotion.
   */
  private queryKgDemotion(taskType: string): string | null {
    const today = new Date().toISOString().slice(0, 10);
    const modelsToCheck = Object.values(COMPLEXITY_MODELS);

    for (const model of modelsToCheck) {
      const triples = this.kg.queryEntity(model, today).filter((t) => t.relation === 'demoted_from');
      if (triples.some((t) => t.object === taskType)) {
        return model;
      }
    }
    return null;
  }
}

/**
 * Get the complexity level for a task type.
 */
export function getTaskComplexity(taskType: string): 'low' | 'medium' | 'high' | 'critical' {
  return TASK_COMPLEXITY[taskType] ?? 'medium';
}

// ── Tunnel Safety Guard ───────────────────────────────────────────────────────

export interface TunnelResult {
  tunnel: string;
  sourceWing: string;
  targetWing: string;
  stackFamily?: string;      // e.g. 'node', 'python', 'go'
  isolationFlag?: boolean;   // if true, cross-rig use is explicitly prohibited
  resultAge?: number;        // age of the result in days
}

export interface TunnelSafetyCheck {
  safe: boolean;
  reason: string;
  advisory: boolean;  // true = attach as advisory only, not auto-applied
}

const DEFAULT_LOOKBACK_DAYS = 14;

/**
 * Validate a cross-rig tunnel result before applying it.
 * Per ROUTING.md §Tunnel Safety Guard: checks room name match, stack compatibility,
 * isolation flags, and freshness. Failures → advisory-only, not auto-applied.
 */
export function checkTunnelSafety(
  taskRoom: string,
  result: TunnelResult,
  opts: {
    expectedStackFamily?: string;
    lookbackDays?: number;
  } = {},
): TunnelSafetyCheck {
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  // 1. Same task room name
  if (result.tunnel !== taskRoom) {
    return {
      safe: false,
      advisory: true,
      reason: `Tunnel room mismatch: expected '${taskRoom}', got '${result.tunnel}'`,
    };
  }

  // 2. Isolation flag — if set, cross-rig use is explicitly prohibited
  if (result.isolationFlag === true) {
    return {
      safe: false,
      advisory: false,  // hard block, not even advisory
      reason: `Tunnel '${result.tunnel}' has isolation flag set — cross-rig use prohibited`,
    };
  }

  // 3. Compatible stack/framework family
  if (opts.expectedStackFamily && result.stackFamily) {
    if (result.stackFamily !== opts.expectedStackFamily) {
      return {
        safe: false,
        advisory: true,
        reason: `Stack family mismatch: expected '${opts.expectedStackFamily}', got '${result.stackFamily}'`,
      };
    }
  }

  // 4. Freshness within lookback window
  if (result.resultAge !== undefined && result.resultAge > lookbackDays) {
    return {
      safe: false,
      advisory: true,
      reason: `Tunnel result is ${result.resultAge} days old (lookback window: ${lookbackDays} days)`,
    };
  }

  return { safe: true, advisory: false, reason: 'All tunnel safety checks passed' };
}
