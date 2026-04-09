// Tests: Groq provider failover — 429 backoff (#1) and model_not_found hot-swap (#2)

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
});
