import type { ProviderAdapter, ProviderRequest, ProviderResponse } from './types.js';

export class MockProviderAdapter implements ProviderAdapter {
  readonly name = 'mock';
  readonly model: string;
  private readonly response: Record<string, unknown>;

  constructor(model = 'mock-consensus', response: Record<string, unknown> = { summary: 'mock consensus', confidence: 1 }) {
    this.model = model;
    this.response = response;
  }

  async generateJson(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.signal?.aborted) throw new Error('mock provider aborted');
    return {
      provider: this.name,
      model: this.model,
      content: JSON.stringify(this.response),
      latencyMs: 0,
    };
  }
}
