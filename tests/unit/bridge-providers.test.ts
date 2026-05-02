import { defaultBridgeProviders } from '../../src/providers';
import { DeepSeekBridgeAdapter } from '../../src/providers/deepseek';
import { GroqBridgeAdapter } from '../../src/providers/groq';

describe('bridge providers', () => {
  const oldGroq = process.env.GROQ_API_KEY;
  const oldDeepSeek = process.env.DEEPSEEK_API_KEY;
  const oldMock = process.env.NOS_MOCK_PROVIDER;
  const oldProviders = process.env.NOS_BRIDGE_PROVIDERS;
  const oldFetch = global.fetch;

  afterEach(() => {
    restoreEnv('GROQ_API_KEY', oldGroq);
    restoreEnv('DEEPSEEK_API_KEY', oldDeepSeek);
    restoreEnv('NOS_MOCK_PROVIDER', oldMock);
    restoreEnv('NOS_BRIDGE_PROVIDERS', oldProviders);
    global.fetch = oldFetch;
  });

  it('preserves default provider order as Groq then DeepSeek', () => {
    process.env.GROQ_API_KEY = 'gsk_test';
    process.env.DEEPSEEK_API_KEY = 'deepseek_test';
    delete process.env.NOS_MOCK_PROVIDER;
    delete process.env.NOS_BRIDGE_PROVIDERS;

    expect(defaultBridgeProviders().map((provider) => provider.name)).toEqual(['groq', 'deepseek']);
  });

  it('uses mock only when no real provider keys are configured', () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.NOS_BRIDGE_PROVIDERS;
    process.env.NOS_MOCK_PROVIDER = '1';

    expect(defaultBridgeProviders().map((provider) => provider.name)).toEqual(['mock']);
  });

  it('rejects unsupported explicit provider entries', () => {
    process.env.NOS_BRIDGE_PROVIDERS = 'bogus:model';

    expect(() => defaultBridgeProviders()).toThrow(/Unsupported/);
  });

  it('sends Groq JSON-object chat requests with the configured model', async () => {
    const adapter = new GroqBridgeAdapter('gsk_test', 'groq/compound');
    const create = jest.fn(async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
    (adapter as unknown as { client: { chat: { completions: { create: typeof create } } } }).client.chat.completions.create = create;

    const controller = new AbortController();
    await adapter.generateJson({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'groq/compound',
      response_format: { type: 'json_object' },
      stream: false,
    }), expect.objectContaining({ signal: controller.signal }));
  });

  it('surfaces DeepSeek API errors', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'rate limited' } }),
    })) as unknown as typeof fetch;

    const adapter = new DeepSeekBridgeAdapter('deepseek_test');
    await expect(adapter.generateJson({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/rate limited/);
  });

  it('passes timeout cancellation signals to DeepSeek requests', async () => {
    let signalSeen = false;
    global.fetch = jest.fn(async (_url, init) => {
      signalSeen = Boolean((init as RequestInit).signal);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      };
    }) as unknown as typeof fetch;

    const adapter = new DeepSeekBridgeAdapter('deepseek_test');
    await adapter.generateJson({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 1234 });

    expect(signalSeen).toBe(true);
  });

  it('composes caller cancellation into DeepSeek requests', async () => {
    let signal: AbortSignal | undefined;
    global.fetch = jest.fn((_url, init) => {
      signal = (init as RequestInit).signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
      });
    }) as unknown as typeof fetch;

    const adapter = new DeepSeekBridgeAdapter('deepseek_test');
    const controller = new AbortController();
    const pending = adapter.generateJson({
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
