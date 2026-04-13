// NOS Town — Groq Provider with failover and retry logic

import Groq from 'groq-sdk';
import type { ChatCompletionCreateParamsNonStreaming } from 'groq-sdk/resources/chat/completions.js';
import type { InferenceParams, HeartbeatEvent } from '../types/index.js';
import { getModelForRole, getFallbackModel, getTokenLimitForRole, isOllamaEligible, OLLAMA_MODELS } from './models.js';
import { groqApiErrors, beadLatencyMs } from '../telemetry/metrics.js';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { Deacon } from '../roles/deacon.js';

export type HeartbeatEmitter = (event: HeartbeatEvent) => void;

const DEFAULT_MAX_RETRIES = 3;

/**
 * Extract a JSON object or array from model output that may include markdown
 * code fences or leading prose. Returns the raw string unchanged if no JSON
 * structure can be isolated (so the caller's JSON.parse will still throw and
 * trigger a retry).
 */
export function extractJson(raw: string): string {
  const s = raw.trim();
  // Likely a bare JSON value with no leading/trailing prose
  if (
    (s.startsWith('{') && s.endsWith('}')) ||
    (s.startsWith('[') && s.endsWith(']'))
  ) {
    return s;
  }
  // Markdown code fence: ```json\n...\n``` or ```\n...\n```
  const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fence) return fence[1].trim();
  // Scan for the first { or [ and extract to its matching close bracket
  const first = s.search(/[{[]/);
  if (first !== -1) {
    const close = s[first] === '{' ? '}' : ']';
    const last = s.lastIndexOf(close);
    if (last > first) return s.slice(first, last + 1);
  }
  return raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per GROQ_INTEGRATION.md: attempt 1=5s, 2=15s, 3=30s
function backoffMs(attempt: number): number {
  const delays = [5_000, 15_000, 30_000];
  return delays[Math.min(attempt, delays.length - 1)] ?? 30_000;
}

/** Duration all Groq endpoints must fail before Ollama activates (RESILIENCE.md) */
const OLLAMA_ACTIVATION_THRESHOLD_MS = 60_000;

export class GroqProvider {
  private client: Groq;
  readonly apiKey: string;
  private emitHeartbeat: HeartbeatEmitter | null;
  private readonly circuitBreaker: CircuitBreaker;
  /** Timestamp when the current Groq outage started (null = no outage) */
  private groqOutageStartAt: number | null = null;

  constructor(apiKey?: string, emitHeartbeat?: HeartbeatEmitter) {
    // Allow a dummy key for tests (will fail on actual API calls, not on construction)
    this.apiKey = apiKey ?? process.env.GROQ_API_KEY ?? 'test-key-placeholder';
    this.client = new Groq({ apiKey: this.apiKey });
    this.emitHeartbeat = emitHeartbeat ?? null;
    this.circuitBreaker = new CircuitBreaker({
      name: 'groq-api',
      failureThreshold: 5,
      recoveryTimeoutMs: 60_000,
    });
    // Startup health check for Ollama fallback (RESILIENCE.md)
    // Deferred to next tick so callers can set up before the check fires.
    // Non-blocking: warns if OLLAMA_URL is set but unreachable at startup.
    if (process.env.OLLAMA_URL) {
      setImmediate(() => void this.checkOllamaHealth());
    }
  }

  /**
   * Startup health check for Ollama fallback.
   * Per RESILIENCE.md: warns if Ollama is configured but unreachable.
   * Non-fatal — Groq is the primary provider.
   */
  async checkOllamaHealth(): Promise<boolean> {
    const ollamaUrl = process.env.OLLAMA_URL;
    if (!ollamaUrl) return true; // Not configured — nothing to check

    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3_000), // 3s timeout
      });
      if (!res.ok) {
        console.warn(`[GroqProvider] Ollama health check failed: HTTP ${res.status}. Fallback unavailable.`);
        return false;
      }
      console.log(`[GroqProvider] Ollama health check OK at ${ollamaUrl}`);
      return true;
    } catch (err) {
      console.warn(`[GroqProvider] Ollama at ${ollamaUrl} unreachable at startup: ${String(err)}. Fallback unavailable until Ollama starts.`);
      return false;
    }
  }

  /** Expose circuit state for monitoring / tests */
  get circuitState() {
    return this.circuitBreaker.currentState;
  }

  /**
   * Call Ollama HTTP API for Tier B fallback.
   * Per RESILIENCE.md: only activates when OLLAMA_URL is set and outage > 60s.
   */
  private async callOllama(
    params: InferenceParams,
    ollamaUrl: string,
  ): Promise<string> {
    const model = OLLAMA_MODELS[params.role] ?? 'llama3.2';
    const messages = params.messages;

    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
    });

    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
    }

    const body = await response.json() as { message?: { content?: string } };
    return body.message?.content ?? '';
  }

  async executeInference(params: InferenceParams, _pruneAttempt = 0): Promise<string> {
    const primaryModel = getModelForRole(params.role, params.task_type, params.model);
    const fallbackModel = getFallbackModel(params.role);
    const maxTokens = params.max_tokens ?? getTokenLimitForRole(params.role);

    // Check if Ollama fallback should activate (Tier B only, outage > 60s, OLLAMA_URL set)
    const ollamaUrl = process.env.OLLAMA_URL;
    if (
      ollamaUrl &&
      isOllamaEligible(params.role) &&
      this.groqOutageStartAt !== null &&
      Date.now() - this.groqOutageStartAt > OLLAMA_ACTIVATION_THRESHOLD_MS
    ) {
      console.warn(`[GroqProvider] Groq outage > 60s — routing ${params.role} to Ollama at ${ollamaUrl}`);
      try {
        const result = await this.callOllama(params, ollamaUrl);
        this.groqOutageStartAt = null;  // Clear outage timer on successful Ollama response
        this.emitHeartbeat?.({ type: 'PROVIDER_RECOVERED', recovered_at: new Date().toISOString() });
        return result;
      } catch (ollamaErr) {
        console.error(`[GroqProvider] Ollama fallback failed: ${String(ollamaErr)}`);
        throw new Error(`All providers exhausted (Groq + Ollama): ${String(ollamaErr)}`);
      }
    }

    try {
      const result = await this.runWithRetry(primaryModel, params, maxTokens);
      // Success: clear any outage timer
      this.groqOutageStartAt = null;
      return result;
    } catch (err: unknown) {
      const error = err as Error & { status?: number; code?: string };

      // context_length_exceeded → Deacon prune + single retry (RESILIENCE.md)
      if (
        error.message?.includes('context_length_exceeded') &&
        _pruneAttempt === 0
      ) {
        console.warn(`[GroqProvider] context_length_exceeded — triggering Deacon prune for ${params.role}/${params.task_type}`);
        try {
          const deacon = new Deacon(this.apiKey);
          const prunedMessages = await deacon.prune(params.messages, params.role, params.task_type ?? 'execute');
          return await this.executeInference({ ...params, messages: prunedMessages }, 1);
        } catch (pruneErr) {
          console.error(`[GroqProvider] Deacon prune failed: ${String(pruneErr)}`);
          throw error;  // re-throw original
        }
      }

      // Circuit breaker open — fail fast, emit exhaustion
      if (error.message?.startsWith('CIRCUIT_OPEN')) {
        // Start/maintain outage timer
        if (this.groqOutageStartAt === null) this.groqOutageStartAt = Date.now();
        this.emitHeartbeat?.({
          type: 'PROVIDER_EXHAUSTED',
          model: primaryModel,
          error: error.message,
        });
        throw err;
      }

      // model_not_found → hot-swap to fallback
      if (
        error.code === 'model_not_found' ||
        (error.message && error.message.includes('model_not_found'))
      ) {
        console.warn(`[GroqProvider] Model ${primaryModel} not found, hot-swapping to ${fallbackModel}`);
        this.emitHeartbeat?.({ type: 'MODEL_DEPRECATED', model: primaryModel, fallback: fallbackModel });
        try {
          const result = await this.runWithRetry(fallbackModel, params, maxTokens);
          this.groqOutageStartAt = null;
          return result;
        } catch (fallbackErr: unknown) {
          const fe = fallbackErr as Error;
          if (this.groqOutageStartAt === null) this.groqOutageStartAt = Date.now();
          this.emitHeartbeat?.({
            type: 'PROVIDER_EXHAUSTED',
            model: fallbackModel,
            error: fe.message ?? String(fallbackErr),
          });
          throw fallbackErr;
        }
      }

      // After exhausting retries — track outage, emit PROVIDER_EXHAUSTED
      if (this.groqOutageStartAt === null) this.groqOutageStartAt = Date.now();
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
    const inferenceStart = Date.now();

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

        const response = await this.circuitBreaker.execute(() =>
          this.client.chat.completions.create(requestParams),
        );

        const raw = response.choices[0]?.message?.content ?? '';
        // For json_object requests, strip markdown fences / leading prose before
        // parsing. Models like groq/compound sometimes wrap JSON in code blocks.
        let content = raw;
        if (params.response_format?.type === 'json_object') {
          const extracted = extractJson(raw);
          try {
            JSON.parse(extracted);
            content = extracted; // return clean JSON to caller
          } catch {
            console.warn(`[GroqProvider] JSON parse failure on attempt ${attempt + 1}, retrying with temp=0`);
            temperature = 0;
            lastError = new Error('JSON parse failure');
            continue;
          }
        }

        // Success — record latency and emit recovery if we had previous errors
        beadLatencyMs.record(Date.now() - inferenceStart, { model, role: params.role });
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
          groqApiErrors.add(1, { model, type: '429' });
          const delay = backoffMs(attempt);
          console.warn(`[GroqProvider] Rate limited (attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES}), backing off ${delay}ms`);
          await sleep(delay);
          lastError = error;
          continue;
        }

        // Other errors — retry with backoff
        groqApiErrors.add(1, { model, type: 'error' });
        const delay = backoffMs(attempt);
        console.warn(`[GroqProvider] Error on attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES}: ${error.message}, retrying in ${delay}ms`);
        await sleep(delay);
        lastError = error;
      }
    }

    throw lastError ?? new Error('Max retries exceeded');
  }
}
