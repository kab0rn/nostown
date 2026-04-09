// NOS Town — Hook Validator

import { z } from 'zod';
import type { Hook } from '../types/index.js';

const TriggerFilterSchema = z.object({
  beadId: z.string().optional(),
  role: z.string().optional(),
  outcomeType: z.enum(['SUCCESS', 'FAILURE']).optional(),
});

const TriggerPatternSchema = z.object({
  event: z.string().min(1),
  filter: TriggerFilterSchema.optional(),
});

const ActionDefinitionSchema = z.object({
  type: z.enum(['MCP_TOOL', 'CONVOY', 'KG_QUERY', 'CUSTOM']),
  payload: z.record(z.unknown()),
});

const HookSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  trigger: TriggerPatternSchema,
  action: ActionDefinitionSchema,
  context: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional().default(true),
  priority: z.number().optional().default(0),
});

export function validateHook(raw: unknown): Hook {
  const result = HookSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid hook schema: ${result.error.message}`);
  }
  return result.data as Hook;
}

export function isValidHook(raw: unknown): raw is Hook {
  return HookSchema.safeParse(raw).success;
}
