import { DeepSeekBridgeAdapter } from './deepseek.js';
import { GroqBridgeAdapter } from './groq.js';
import { MockProviderAdapter } from './mock.js';
import type { ProviderAdapter, ProviderSpec } from './types.js';

export type { ProviderAdapter, ProviderMessage, ProviderRequest, ProviderResponse, ProviderSpec } from './types.js';

export function createProvider(spec: ProviderSpec): ProviderAdapter {
  switch (spec.provider) {
    case 'groq':
      return new GroqBridgeAdapter(undefined, spec.model);
    case 'deepseek':
      return new DeepSeekBridgeAdapter(undefined, spec.model);
    case 'mock':
      return new MockProviderAdapter(spec.model);
  }
}

export function defaultBridgeProviders(): ProviderAdapter[] {
  const specs = parseProviderEnv();
  if (specs.length > 0) return specs.map(createProvider);

  const providers: ProviderAdapter[] = [];
  if (process.env.GROQ_API_KEY) providers.push(new GroqBridgeAdapter());
  if (process.env.DEEPSEEK_API_KEY) providers.push(new DeepSeekBridgeAdapter());
  if (providers.length === 0 && process.env.NOS_MOCK_PROVIDER === '1') {
    providers.push(new MockProviderAdapter());
  }
  if (providers.length === 0) {
    throw new Error('No bridge providers configured. Set GROQ_API_KEY, DEEPSEEK_API_KEY, or NOS_MOCK_PROVIDER=1 for tests.');
  }
  return providers;
}

function parseProviderEnv(): ProviderSpec[] {
  const raw = process.env.NOS_BRIDGE_PROVIDERS;
  if (!raw) return [];
  return raw.split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [provider, model] = part.split(':', 2);
      if (provider !== 'groq' && provider !== 'deepseek' && provider !== 'mock') {
        throw new Error(`Unsupported NOS_BRIDGE_PROVIDERS entry: ${part}`);
      }
      return { provider, model } as ProviderSpec;
    });
}
