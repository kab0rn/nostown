// NOS Town — Groq Model Configuration

export interface ModelConfig {
  primary: string;
  fallback: string;
}

export const ROLE_MODELS: Record<string, ModelConfig> = {
  mayor: { primary: 'compound-beta', fallback: 'llama-3.3-70b-versatile' },
  polecat: { primary: 'meta-llama/llama-4-scout-17b-16e-instruct', fallback: 'llama-3.1-8b-instant' },
  witness: { primary: 'qwen-qwen3-32b', fallback: 'llama-3.3-70b-versatile' },
  refinery: { primary: 'llama-3.3-70b-versatile', fallback: 'llama-3.3-70b-versatile' },
  safeguard: { primary: 'llama-3.3-70b-versatile', fallback: 'llama-3.1-8b-instant' },
  historian: { primary: 'llama-3.1-8b-instant', fallback: 'llama-3.1-8b-instant' },
};

export const ROLE_TOKEN_LIMITS: Record<string, number> = {
  mayor: 8192,
  polecat: 16384,
  witness: 8192,
  refinery: 8192,
  safeguard: 4096,
  historian: 4096,
};

export function getModelForRole(
  role: string,
  taskType?: string,
  forceModel?: string,
): string {
  if (forceModel) return forceModel;

  // Task-type specific overrides
  if (taskType === 'typescript_generics' || taskType === 'code_review') {
    // Use a stronger model for complex code tasks
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
