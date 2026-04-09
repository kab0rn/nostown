// NOS Town — Deacon (Context Pruner)
// Ephemeral 8B role triggered on context_length_exceeded.
// Summarizes & prunes message arrays so the caller can retry with a smaller context.
// Per RESILIENCE.md: max 1 prune attempt per Bead.

import { GroqProvider } from '../groq/provider.js';
import type { InferenceParams } from '../types/index.js';

// _pruneAttempt=1 prevents recursive Deacon activation on the Deacon's own calls
type ExecuteInferenceFn = (params: InferenceParams, _pruneAttempt: number) => Promise<string>;

/** System message used for all Deacon summarize-and-prune calls. */
const DEACON_SYSTEM = `You are a context pruner. Your job is to compress a conversation history into the most important information needed to continue the task. Preserve:
- The original user goal
- Key decisions, findings, and constraints already established
- The last assistant message (most recent context)
Remove:
- Verbose intermediate reasoning
- Repeated or redundant content
- Code that has already been confirmed working
Output a single summarized user message that preserves all essential context.`;

export class Deacon {
  private provider: GroqProvider;

  constructor(groqApiKey?: string) {
    this.provider = new GroqProvider(groqApiKey);
  }

  /**
   * Summarize and prune a message array that exceeded context limits.
   * Returns a new, shortened message array suitable for retry.
   * Per RESILIENCE.md: called at most once per Bead.
   */
  async prune(
    messages: InferenceParams['messages'],
    role: string,
    taskType: string,
  ): Promise<InferenceParams['messages']> {
    if (messages.length === 0) return messages;

    // Build a single-pass summarization request
    const conversationText = messages
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join('\n\n');

    const params: InferenceParams = {
      role: 'historian',   // Deacon uses historian tier (8B)
      task_type: 'execute',
      messages: [
        { role: 'system', content: DEACON_SYSTEM },
        {
          role: 'user',
          content: `Role: ${role}\nTask type: ${taskType}\n\nFull conversation to compress:\n\n${conversationText}`,
        },
      ],
      temperature: 0.0,  // deterministic pruning
    };

    try {
      // Pass _pruneAttempt=1 to prevent recursive Deacon activation if Deacon's own context is too long
      const summary = await (this.provider.executeInference as ExecuteInferenceFn)(params, 1);

      // Reconstruct: keep system message (if any) + summary as user turn
      const systemMessages = messages.filter((m) => m.role === 'system');
      const pruned: InferenceParams['messages'] = [
        ...systemMessages,
        {
          role: 'user',
          content: `[CONTEXT PRUNED BY DEACON]\n${summary}`,
        },
      ];

      console.log(
        `[Deacon] Pruned ${messages.length} messages → ${pruned.length} messages for ${role}/${taskType}`,
      );
      return pruned;
    } catch (err) {
      console.error(`[Deacon] Prune failed: ${String(err)}`);
      // Fallback: truncate to last 2 messages (system + last user)
      const systemMessages = messages.filter((m) => m.role === 'system');
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      return lastUser
        ? [...systemMessages, lastUser]
        : systemMessages;
    }
  }
}
