import Groq from 'groq-sdk';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from './types.js';

export class GroqBridgeAdapter implements ProviderAdapter {
  readonly name = 'groq';
  readonly model: string;
  private readonly client: Groq;

  constructor(apiKey = process.env.GROQ_API_KEY, model = process.env.NOS_GROQ_MODEL ?? 'groq/compound') {
    if (!apiKey) throw new Error('GROQ_API_KEY is required for Groq bridge provider');
    this.model = model;
    this.client = new Groq({ apiKey });
  }

  async generateJson(request: ProviderRequest): Promise<ProviderResponse> {
    const start = Date.now();
    const completion = await this.client.chat.completions.create({
      model: request.model ?? this.model,
      messages: request.messages,
      temperature: 0,
      stream: false,
      response_format: { type: 'json_object' },
    } as Parameters<typeof this.client.chat.completions.create>[0], {
      signal: request.signal,
    });
    const message = completion as { choices?: Array<{ message?: { content?: string } }> };

    return {
      provider: this.name,
      model: request.model ?? this.model,
      content: message.choices?.[0]?.message?.content ?? '{}',
      latencyMs: Date.now() - start,
    };
  }
}
