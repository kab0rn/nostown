// NOS Town — Hook Action Handlers
// Concrete implementations for all hook action types:
// MCP_TOOL, CONVOY, KG_QUERY, CUSTOM

import type { Hook, BeadEvent } from '../types/index.js';
import { KnowledgeGraph } from '../kg/index.js';
import { kgQuery, kgInsert } from '../kg/tools.js';
import { ConvoyBus } from '../convoys/bus.js';
import { buildSignedConvoy, loadPrivateKey } from '../convoys/sign.js';

export type CustomHandler = (toolName: string, args: Record<string, unknown>, event: BeadEvent) => Promise<void>;

export interface ActionHandlerContext {
  kg?: KnowledgeGraph;
  bus?: ConvoyBus;
  senderId?: string;
  nextSeq?: () => number;
  customHandlers?: Map<string, CustomHandler>;
}

/**
 * Execute a MCP_TOOL action.
 * Dispatches to built-in tools (historian_append, kg_add, etc.)
 * and then to custom handlers for extension tools.
 */
async function handleMcpTool(
  payload: Record<string, unknown>,
  event: BeadEvent,
  ctx: ActionHandlerContext,
): Promise<void> {
  const tool = String(payload['tool'] ?? '');
  const args = (payload['args'] ?? {}) as Record<string, unknown>;

  switch (tool) {
    case 'historian_append':
      // historian_append: write outcome to KG for Historian mining
      if (ctx.kg) {
        kgInsert(ctx.kg, {
          subject: String(args['beadId'] ?? event.beadId),
          relation: 'historian_append',
          object: String(args['outcome'] ?? event.outcome ?? 'unknown'),
          agent_id: 'hook',
          metadata: { timestamp: String(args['timestamp'] ?? event.timestamp) },
        });
      }
      break;

    case 'kg_add':
      if (ctx.kg) {
        kgInsert(ctx.kg, {
          subject: String(args['subject'] ?? event.beadId),
          relation: String(args['relation'] ?? 'event'),
          object: String(args['object'] ?? event.outcome ?? 'unknown'),
          agent_id: String(args['agent_id'] ?? 'hook'),
          metadata: (args['metadata'] ?? {}) as Record<string, unknown>,
        });
      }
      break;

    case 'kg_query':
      if (ctx.kg) {
        const results = kgQuery(ctx.kg, {
          subject: String(args['subject'] ?? event.beadId),
          relation: args['relation'] ? String(args['relation']) : undefined,
        });
        // Results available for inspection; in production would be returned to caller
        console.log(`[HookAction:kg_query] ${results.length} triples for ${String(args['subject'])}`);
      }
      break;

    default:
      // Delegate to custom handlers
      const customFn = ctx.customHandlers?.get(tool);
      if (customFn) {
        await customFn(tool, args, event);
      } else {
        console.warn(`[HookAction] Unknown MCP tool: ${tool}`);
      }
  }
}

/**
 * Execute a CONVOY action — sends a signed convoy to a recipient.
 */
async function handleConvoy(
  payload: Record<string, unknown>,
  event: BeadEvent,
  ctx: ActionHandlerContext,
): Promise<void> {
  if (!ctx.bus || !ctx.senderId) {
    console.warn('[HookAction:CONVOY] No bus or senderId — skipping');
    return;
  }

  let privateKey: string;
  try {
    privateKey = loadPrivateKey(ctx.senderId);
  } catch {
    console.warn(`[HookAction:CONVOY] No key for ${ctx.senderId}`);
    return;
  }

  const recipient = String(payload['recipient'] ?? 'mayor');
  const seq = ctx.nextSeq ? ctx.nextSeq() : ctx.bus.getNextSeq(ctx.senderId);

  const header = {
    sender_id: ctx.senderId,
    recipient,
    timestamp: new Date().toISOString(),
    seq,
  };
  const convoyPayload = {
    type: 'BEAD_DISPATCH' as const,
    data: {
      message: String(payload['message'] ?? ''),
      bead_id: event.beadId,
      plan_checkpoint_id: `hook_${event.beadId}`,
    },
  };

  const convoy = await buildSignedConvoy(header, convoyPayload, privateKey);
  await ctx.bus.send(convoy);
}

/**
 * Execute a KG_QUERY action — queries and logs KG results.
 */
async function handleKgQuery(
  payload: Record<string, unknown>,
  event: BeadEvent,
  ctx: ActionHandlerContext,
): Promise<void> {
  if (!ctx.kg) return;
  const args = (payload['args'] ?? {}) as Record<string, unknown>;
  const results = kgQuery(ctx.kg, {
    subject: String(args['subject'] ?? event.beadId),
    relation: args['relation'] ? String(args['relation']) : undefined,
  });
  console.log(`[HookAction:KG_QUERY] query=${String(payload['query'])} results=${results.length}`);
}

/**
 * Execute a CUSTOM action.
 */
async function handleCustom(
  payload: Record<string, unknown>,
  event: BeadEvent,
  ctx: ActionHandlerContext,
): Promise<void> {
  const handlerName = String(payload['handler'] ?? '');
  const customFn = ctx.customHandlers?.get(handlerName);
  if (customFn) {
    await customFn(handlerName, payload, event);
  } else {
    console.warn(`[HookAction:CUSTOM] No handler registered for: ${handlerName}`);
  }
}

/**
 * Build a concrete ActionExecutor for use with executeHook / runMatchingHooks.
 * This wires all action types to real implementations.
 */
export function buildActionExecutor(ctx: ActionHandlerContext) {
  return async (action: Hook['action'], event: BeadEvent): Promise<void> => {
    switch (action.type) {
      case 'MCP_TOOL':
        await handleMcpTool(action.payload, event, ctx);
        break;
      case 'CONVOY':
        await handleConvoy(action.payload, event, ctx);
        break;
      case 'KG_QUERY':
        await handleKgQuery(action.payload, event, ctx);
        break;
      case 'CUSTOM':
        await handleCustom(action.payload, event, ctx);
        break;
      default:
        console.warn(`[HookAction] Unknown action type: ${String((action as { type: unknown }).type)}`);
    }
  };
}
