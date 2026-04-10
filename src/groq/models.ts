// NOS Town — Groq Model Configuration

export interface ModelConfig {
  primary: string;
  fallback: string;
}

export const ROLE_MODELS: Record<string, ModelConfig> = {
  mayor: { primary: 'groq/compound', fallback: 'llama-3.3-70b-versatile' },
  polecat: { primary: 'meta-llama/llama-4-scout-17b-16e-instruct', fallback: 'llama-3.1-8b-instant' },
  witness: { primary: 'qwen/qwen3-32b', fallback: 'llama-3.3-70b-versatile' },
  refinery: { primary: 'llama-3.3-70b-versatile', fallback: 'llama-3.3-70b-versatile' },
  safeguard: { primary: 'llama-3.3-70b-versatile', fallback: 'llama-3.1-8b-instant' },
  historian: { primary: 'llama-3.1-8b-instant', fallback: 'llama-3.1-8b-instant' },
};

// Hard caps per HARDENING.md §1.1 — prevent runaway cost
export const ROLE_TOKEN_LIMITS: Record<string, number> = {
  mayor: 4096,
  polecat: 2000,     // hard cap — see GROQ_INTEGRATION.md
  witness: 2048,
  refinery: 8192,
  safeguard: 1024,
  historian: 4096,   // batch mode, cost controlled separately
};

export function getModelForRole(
  role: string,
  taskType?: string,
  forceModel?: string,
): string {
  if (forceModel) return forceModel;

  // Task-type specific overrides
  if (taskType === 'decompose') {
    // groq/compound wraps JSON in markdown fences; use a model with reliable
    // json_object output for the structured decomposition step.
    return 'llama-3.3-70b-versatile';
  }
  if (taskType === 'typescript_generics' || taskType === 'code_review') {
    return ROLE_MODELS[role]?.primary ?? 'llama-3.3-70b-versatile';
  }

  return ROLE_MODELS[role]?.primary ?? 'llama-3.3-70b-versatile';
}

export function getFallbackModel(role: string): string {
  return ROLE_MODELS[role]?.fallback ?? 'llama-3.1-8b-instant';
}

export function getTokenLimitForRole(role: string): number {
  return ROLE_TOKEN_LIMITS[role] ?? 4096;
}

/**
 * Tier B roles can fall back to local Ollama when all Groq endpoints fail.
 * Per RESILIENCE.md: only polecat and historian; Tier A/S roles queue instead.
 */
export const TIER_B_ROLES = new Set(['polecat', 'historian']);

export function isOllamaEligible(role: string): boolean {
  return TIER_B_ROLES.has(role);
}

/** Ollama model names for Tier B roles */
export const OLLAMA_MODELS: Record<string, string> = {
  polecat: 'llama3.2',
  historian: 'llama3.2',
};
