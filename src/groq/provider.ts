// NOS Town — Groq Provider with failover and retry logic

import Groq from 'groq-sdk';
import type { ChatCompletionCreateParamsNonStreaming } from 'groq-sdk/resources/chat/completions.js';
import type { InferenceParams, HeartbeatEvent } from '../types/index.js';
import { getModelForRole, getFallbackModel, getTokenLimitForRole } from './models.js';

export type HeartbeatEmitter = (event: HeartbeatEvent) => void;

const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

export class GroqProvider {
  private client: Groq;
  private emitHeartbeat: HeartbeatEmitter | null;

  constructor(apiKey?: string, emitHeartbeat?: HeartbeatEmitter) {
    // Allow a dummy key for tests (will fail on actual API calls, not on construction)
    const key = apiKey ?? process.env.GROQ_API_KEY ?? 'test-key-placeholder';
    this.client = new Groq({ apiKey: key });
    this.emitHeartbeat = emitHeartbeat ?? null;
  }

  async executeInference(params: InferenceParams): Promise<string> {
    const primaryModel = getModelForRole(params.role, params.task_type, params.model);
    const fallbackModel = getFallbackModel(params.role);
    const maxTokens = params.max_tokens ?? getTokenLimitForRole(params.role);

    try {
      return await this.runWithRetry(primaryModel, params, maxTokens);
    } catch (err: unknown) {
      const error = err as Error & { status?: number; code?: string };

      // model_not_found → hot-swap to fallback
      if (
        error.code === 'model_not_found' ||
        (error.message && error.message.includes('model_not_found'))
      ) {
        console.warn(`[GroqProvider] Model ${primaryModel} not found, hot-swapping to ${fallbackModel}`);
        this.emitHeartbeat?.({ type: 'MODEL_DEPRECATED', model: primaryModel, fallback: fallbackModel });
        return await this.runWithRetry(fallbackModel, params, maxTokens);
      }

      // After exhausting retries — emit PROVIDER_EXHAUSTED
      this.emitHeartbeat?.({
        type: 'PROVIDER_EXHAUSTED',
        model: primaryModel,
        error: error.message ?? String(err),
      });
      throw err;
    }
  }

  private async runWithRetry(
    model: string,
    params: InferenceParams,
    maxTokens: number,
  ): Promise<string> {
    let lastError: Error | null = null;
    let temperature = params.temperature ?? 0.7;

    for (let attempt = 0; attempt < DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const requestParams: ChatCompletionCreateParamsNonStreaming = {
          model,
          messages: params.messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        };

        if (params.response_format) {
          requestParams.response_format = params.response_format;
        }

        const response = await this.client.chat.completions.create(requestParams);

        const content = response.choices[0]?.message?.content ?? '';

        // JSON parse failure → retry with temp 0
        if (params.response_format?.type === 'json_object') {
          try {
            JSON.parse(content);
          } catch {
            console.warn(`[GroqProvider] JSON parse failure on attempt ${attempt + 1}, retrying with temp=0`);
            temperature = 0;
            lastError = new Error('JSON parse failure');
            continue;
          }
        }

        // Success — emit recovery if we had previous errors
        if (lastError !== null) {
          this.emitHeartbeat?.({
            type: 'PROVIDER_RECOVERED',
            recovered_at: new Date().toISOString(),
          });
        }

        return content;
      } catch (err: unknown) {
        const error = err as Error & { status?: number; code?: string; error?: { code?: string } };

        // context_length_exceeded — throw immediately (caller decides)
        if (
          error.code === 'context_length_exceeded' ||
          error.error?.code === 'context_length_exceeded' ||
          (error.message && error.message.includes('context_length_exceeded'))
        ) {
          throw new Error(`context_length_exceeded: ${error.message}`);
        }

        // model_not_found — bubble up for hot-swap
        if (
          error.code === 'model_not_found' ||
          (error.message && error.message.includes('model_not_found'))
        ) {
          throw error;
        }

        // 429 → exponential backoff
        if (error.status === 429 || (error.message && error.message.includes('rate_limit'))) {
          const delay = backoffMs(attempt);
          console.warn(`[GroqProvider] Rate limited (attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES}), backing off ${delay}ms`);
          await sleep(delay);
          lastError = error;
          continue;
        }

        // Other errors — retry with backoff
        const delay = backoffMs(attempt);
        console.warn(`[GroqProvider] Error on attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES}: ${error.message}, retrying in ${delay}ms`);
        await sleep(delay);
        lastError = error;
      }
    }

    throw lastError ?? new Error('Max retries exceeded');
  }
}
