// Tests: Deacon context pruner

jest.mock('groq-sdk', () => {
  const mockCreate = jest.fn();
  (globalThis as Record<string, unknown>).__deaconMockCreate = mockCreate;
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    })),
  };
});

import { Deacon } from '../../src/roles/deacon';
import type { InferenceParams } from '../../src/types/index';

function getMock(): jest.Mock {
  return (globalThis as Record<string, unknown>).__deaconMockCreate as jest.Mock;
}

const SAMPLE_MESSAGES: InferenceParams['messages'] = [
  { role: 'system', content: 'You are a code assistant.' },
  { role: 'user', content: 'Refactor the auth module' },
  { role: 'assistant', content: 'I will refactor the module...' },
  { role: 'user', content: 'Also add JWT validation' },
];

describe('Deacon', () => {
  beforeEach(() => {
    getMock().mockReset();
  });

  it('calls the LLM and returns pruned messages', async () => {
    getMock().mockResolvedValueOnce({
      choices: [{ message: { content: 'Summarized: refactor auth with JWT validation' } }],
    });

    const deacon = new Deacon('test-key');
    const pruned = await deacon.prune(SAMPLE_MESSAGES, 'polecat', 'refactor');

    expect(pruned.length).toBeGreaterThan(0);
    // Should preserve system messages
    const system = pruned.filter((m) => m.role === 'system');
    expect(system.length).toBe(1);
    // Should have a user message with the summary
    const user = pruned.find((m) => m.role === 'user');
    expect(user?.content).toContain('CONTEXT PRUNED BY DEACON');
    expect(user?.content).toContain('Summarized');
  });

  it('returns empty array for empty messages', async () => {
    const deacon = new Deacon('test-key');
    const pruned = await deacon.prune([], 'polecat', 'execute');
    expect(pruned).toEqual([]);
    expect(getMock()).not.toHaveBeenCalled();
  });

  it('falls back to truncation when LLM call fails', async () => {
    getMock().mockRejectedValue(new Error('LLM error'));
    jest.useFakeTimers();

    const deacon = new Deacon('test-key');
    const promise = deacon.prune(SAMPLE_MESSAGES, 'polecat', 'refactor');
    await jest.runAllTimersAsync();
    const pruned = await promise;

    jest.useRealTimers();

    // Should not throw — graceful fallback
    expect(pruned.length).toBeGreaterThan(0);
    // Fallback: system messages + last user message
    expect(pruned.some((m) => m.role === 'system')).toBe(true);
    expect(pruned.some((m) => m.role === 'user')).toBe(true);
  });

  it('handles messages with only a system message', async () => {
    getMock().mockResolvedValueOnce({
      choices: [{ message: { content: 'Summary of system context' } }],
    });

    const singleSystem: InferenceParams['messages'] = [
      { role: 'system', content: 'You are helpful.' },
    ];
    const deacon = new Deacon('test-key');
    const pruned = await deacon.prune(singleSystem, 'polecat', 'execute');
    expect(pruned.length).toBeGreaterThan(0);
  });

  it('preserves all system messages in output', async () => {
    getMock().mockResolvedValueOnce({
      choices: [{ message: { content: 'pruned context' } }],
    });

    const multiSystem: InferenceParams['messages'] = [
      { role: 'system', content: 'First system message.' },
      { role: 'system', content: 'Second system message.' },
      { role: 'user', content: 'Do the task.' },
    ];
    const deacon = new Deacon('test-key');
    const pruned = await deacon.prune(multiSystem, 'polecat', 'execute');

    const systems = pruned.filter((m) => m.role === 'system');
    expect(systems.length).toBe(2);
  });
});
