import type { ProviderAdapter, ProviderRequest, ProviderResponse } from './types.js';

interface DeepSeekResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export class DeepSeekBridgeAdapter implements ProviderAdapter {
  readonly name = 'deepseek';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    apiKey = process.env.DEEPSEEK_API_KEY,
    model = process.env.NOS_DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
    baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/chat/completions',
  ) {
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for DeepSeek bridge provider');
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async generateJson(request: ProviderRequest): Promise<ProviderResponse> {
    const start = Date.now();
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (request.signal?.aborted) controller.abort();
    else request.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 90_000);
    try {
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model ?? this.model,
          messages: request.messages,
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      const body = await res.json() as DeepSeekResponse;
      if (!res.ok) {
        throw new Error(body.error?.message ?? `DeepSeek HTTP ${res.status}`);
      }
      return {
        provider: this.name,
        model: request.model ?? this.model,
        content: body.choices?.[0]?.message?.content ?? '{}',
        latencyMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}
