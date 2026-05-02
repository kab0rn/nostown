export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderRequest {
  messages: ProviderMessage[];
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  provider: string;
  model: string;
  content: string;
  latencyMs: number;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly model: string;
  generateJson(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface ProviderSpec {
  provider: 'groq' | 'deepseek' | 'mock';
  model?: string;
}
