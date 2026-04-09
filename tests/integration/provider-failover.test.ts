// Tests: Groq provider failover — 429 backoff (#1), model_not_found hot-swap (#2),
// and Ollama local fallback for Tier B roles after 60s Groq outage (RESILIENCE.md)

// jest.mock is hoisted before imports; use globalThis to share mock fn
jest.mock('groq-sdk', () => {
  const mockCreate = jest.fn();
  (globalThis as Record<string, unknown>).__groqMockCreate = mockCreate;
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
  };
});

import { GroqProvider } from '../../src/groq/provider';
import type { HeartbeatEvent } from '../../src/types/index';

function getMockCreate(): jest.Mock {
  return (globalThis as Record<string, unknown>).__groqMockCreate as jest.Mock;
}

function makeSuccessResponse(content = 'ok') {
  return { choices: [{ message: { content } }] };
}

const BASE_PARAMS = {
  role: 'polecat' as const,
  task_type: 'execute',
  messages: [{ role: 'user' as const, content: 'test' }],
};

describe('GroqProvider failover', () => {
  beforeEach(() => {
    getMockCreate().mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('#1: retries after 429 and returns content without data loss', async () => {
    const rateLimitError = Object.assign(new Error('rate_limit_exceeded'), { status: 429 });

    getMockCreate()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(makeSuccessResponse('result after backoff'));

    const provider = new GroqProvider('test-key');
    const promise = provider.executeInference(BASE_PARAMS);

    // Let the code reach sleep(), then fire all timers
    await jest.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe('result after backoff');
    expect(getMockCreate()).toHaveBeenCalledTimes(2);
  });

  it('#1b: emits PROVIDER_EXHAUSTED after all 429 retries fail', async () => {
    const rateLimitError = Object.assign(new Error('rate_limit'), { status: 429 });
    getMockCreate().mockRejectedValue(rateLimitError);

    const events: HeartbeatEvent[] = [];
    const provider = new GroqProvider('test-key', (e) => events.push(e));

    const promise = provider.executeInference(BASE_PARAMS);
    // Attach catch BEFORE running timers to prevent unhandled rejection
    const handled = promise.catch(() => null);

    await jest.runAllTimersAsync();
    await handled;

    await expect(promise).rejects.toThrow();
    expect(events.some((e) => e.type === 'PROVIDER_EXHAUSTED')).toBe(true);
    expect(getMockCreate()).toHaveBeenCalledTimes(3); // DEFAULT_MAX_RETRIES
  });

  it('#2: hot-swaps to fallback model on model_not_found', async () => {
    const notFoundError = Object.assign(new Error('model_not_found'), { code: 'model_not_found' });

    getMockCreate()
      .mockRejectedValueOnce(notFoundError)             // primary model fails
      .mockResolvedValueOnce(makeSuccessResponse('fallback result')); // fallback succeeds

    const events: HeartbeatEvent[] = [];
    const provider = new GroqProvider('test-key', (e) => events.push(e));

    const result = await provider.executeInference(BASE_PARAMS);

    expect(result).toBe('fallback result');
    expect(getMockCreate()).toHaveBeenCalledTimes(2);

    const deprecated = events.find((e) => e.type === 'MODEL_DEPRECATED') as Extract<HeartbeatEvent, { type: 'MODEL_DEPRECATED' }> | undefined;
    expect(deprecated).toBeDefined();
    expect(deprecated?.fallback).toBeDefined();
  });

  it('#3: retries with temperature=0 after JSON parse failure', async () => {
    // First response: invalid JSON → triggers temp=0 retry
    // Second response: valid JSON
    getMockCreate()
      .mockResolvedValueOnce({ choices: [{ message: { content: 'not valid json {{{' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"result":"ok"}' } }] });

    const provider = new GroqProvider('test-key');
    const result = await provider.executeInference({
      ...BASE_PARAMS,
      response_format: { type: 'json_object' },
    });

    expect(JSON.parse(result)).toEqual({ result: 'ok' });
    expect(getMockCreate()).toHaveBeenCalledTimes(2);

    // Second call should have temperature=0
    const secondCallArgs = getMockCreate().mock.calls[1][0] as { temperature: number };
    expect(secondCallArgs.temperature).toBe(0);
  });

  it('#3b: escalates to next-tier model after two JSON parse failures', async () => {
    // All responses are invalid JSON → exhausts retries
    getMockCreate().mockResolvedValue({ choices: [{ message: { content: '{bad json' } }] });

    const provider = new GroqProvider('test-key');
    const promise = provider.executeInference({
      ...BASE_PARAMS,
      response_format: { type: 'json_object' },
    });
    const handled = promise.catch(() => null);
    await jest.runAllTimersAsync();
    await handled;

    await expect(promise).rejects.toThrow();
    expect(getMockCreate()).toHaveBeenCalledTimes(3); // 3 = DEFAULT_MAX_RETRIES
  });

  it('#2b: throws PROVIDER_EXHAUSTED if fallback also fails', async () => {
    const notFoundError = Object.assign(new Error('model_not_found'), { code: 'model_not_found' });
    const otherError = new Error('server error');

    getMockCreate()
      .mockRejectedValueOnce(notFoundError)  // primary: model_not_found
      .mockRejectedValue(otherError);         // fallback: keeps failing

    const events: HeartbeatEvent[] = [];
    const provider = new GroqProvider('test-key', (e) => events.push(e));

    const promise = provider.executeInference(BASE_PARAMS);
    // Attach catch BEFORE running timers to prevent unhandled rejection
    const handled = promise.catch(() => null);

    await jest.runAllTimersAsync();
    await handled;

    await expect(promise).rejects.toThrow();
    expect(events.some((e) => e.type === 'PROVIDER_EXHAUSTED')).toBe(true);
  });

  it('#4: triggers Deacon prune on context_length_exceeded, retries with pruned context', async () => {
    const contextError = Object.assign(new Error('context_length_exceeded: too many tokens'), {
      code: 'context_length_exceeded',
    });

    // First call: context_length_exceeded → triggers Deacon
    // Deacon's internal prune call: succeeds
    // Retry with pruned context: succeeds
    getMockCreate()
      .mockRejectedValueOnce(contextError)                   // original call fails
      .mockResolvedValueOnce({                                // Deacon's prune call succeeds
        choices: [{ message: { content: 'pruned summary' } }],
      })
      .mockResolvedValueOnce({                                // retry with pruned context succeeds
        choices: [{ message: { content: 'final result after deacon prune' } }],
      });

    const provider = new GroqProvider('test-key');
    const result = await provider.executeInference(BASE_PARAMS);

    expect(result).toBe('final result after deacon prune');
    expect(getMockCreate()).toHaveBeenCalledTimes(3);
  });

  it('#4b: re-throws context_length_exceeded if Deacon prune also fails', async () => {
    const contextError = Object.assign(new Error('context_length_exceeded: too many tokens'), {
      code: 'context_length_exceeded',
    });

    // All Groq calls fail → Deacon cannot prune → original error re-thrown
    getMockCreate().mockRejectedValue(contextError);

    const provider = new GroqProvider('test-key');
    const promise = provider.executeInference(BASE_PARAMS);
    const handled = promise.catch(() => null);
    await jest.runAllTimersAsync();
    await handled;

    await expect(promise).rejects.toThrow(/context_length_exceeded/);
  });
});

describe('GroqProvider Ollama fallback (RESILIENCE.md §Local Ollama)', () => {
  const originalOllamaUrl = process.env.OLLAMA_URL;

  beforeEach(() => {
    getMockCreate().mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalOllamaUrl === undefined) {
      delete process.env.OLLAMA_URL;
    } else {
      process.env.OLLAMA_URL = originalOllamaUrl;
    }
    jest.restoreAllMocks();
  });

  it('does NOT activate Ollama for Tier A roles (mayor, witness)', async () => {
    process.env.OLLAMA_URL = 'http://localhost:11434';

    // Groq fails repeatedly
    const networkError = new Error('503 Service Unavailable');
    getMockCreate().mockRejectedValue(networkError);

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ollama says hello' } }),
    } as Response);

    const mayorProvider = new GroqProvider('test-key');
    // Simulate > 60s outage already tracked
    (mayorProvider as unknown as Record<string, unknown>).groqOutageStartAt = Date.now() - 70_000;

    const promise = mayorProvider.executeInference({
      role: 'mayor',
      task_type: 'orchestrate',
      messages: [{ role: 'user', content: 'test' }],
    });
    const handled = promise.catch(() => null);
    await jest.runAllTimersAsync();
    await handled;

    // Mayor should NOT route to Ollama — should throw
    await expect(promise).rejects.toThrow();
    // Ollama inference (/api/chat) must not be called; /api/tags may fire from health check
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/chat'),
      expect.anything(),
    );
  });

  it('activates Ollama for Tier B role after 60s outage when OLLAMA_URL is set', async () => {
    process.env.OLLAMA_URL = 'http://localhost:11434';

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ollama fallback response' } }),
    } as Response);

    const provider = new GroqProvider('test-key');
    // Pre-set outage start > 60s ago to trigger Ollama activation
    (provider as unknown as Record<string, unknown>).groqOutageStartAt = Date.now() - 70_000;

    const result = await provider.executeInference({
      role: 'polecat',
      task_type: 'execute',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result).toBe('ollama fallback response');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does NOT activate Ollama if outage < 60s', async () => {
    process.env.OLLAMA_URL = 'http://localhost:11434';
    const networkError = Object.assign(new Error('503'), { status: 503 });
    getMockCreate().mockRejectedValue(networkError);

    const fetchSpy = jest.spyOn(global, 'fetch');

    const provider = new GroqProvider('test-key');
    // Outage started only 10s ago — not yet threshold
    (provider as unknown as Record<string, unknown>).groqOutageStartAt = Date.now() - 10_000;

    const promise = provider.executeInference({
      role: 'polecat',
      task_type: 'execute',
      messages: [{ role: 'user', content: 'test' }],
    });
    const handled = promise.catch(() => null);
    await jest.runAllTimersAsync();
    await handled;

    // Should NOT have called Ollama inference — still within 60s window
    // (/api/tags may fire from health check; only /api/chat is the fallback endpoint)
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/chat'),
      expect.anything(),
    );
  });

  it('does NOT activate Ollama when OLLAMA_URL is not set', async () => {
    delete process.env.OLLAMA_URL;
    const networkError = Object.assign(new Error('503'), { status: 503 });
    getMockCreate().mockRejectedValue(networkError);

    const fetchSpy = jest.spyOn(global, 'fetch');

    const provider = new GroqProvider('test-key');
    (provider as unknown as Record<string, unknown>).groqOutageStartAt = Date.now() - 70_000;

    const promise = provider.executeInference({
      role: 'polecat',
      task_type: 'execute',
      messages: [{ role: 'user', content: 'test' }],
    });
    const handled = promise.catch(() => null);
    await jest.runAllTimersAsync();
    await handled;

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws if Ollama also fails', async () => {
    process.env.OLLAMA_URL = 'http://localhost:11434';

    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Connection refused'));

    const provider = new GroqProvider('test-key');
    (provider as unknown as Record<string, unknown>).groqOutageStartAt = Date.now() - 70_000;

    await expect(
      provider.executeInference({
        role: 'historian',
        task_type: 'generate_playbook',
        messages: [{ role: 'user', content: 'test' }],
      }),
    ).rejects.toThrow(/All providers exhausted/);
  });
});
