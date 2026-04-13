// Tests for Safeguard vulnerability pattern in-process cache learning
// Per ROLES.md §Safeguard: workers cache detected patterns in-process
// (session-local only — no cross-session persistence after MemPalace removal).

import { jest } from '@jest/globals';

// --- mock GroqProvider ---
const mockExecuteInference = jest.fn<(params: unknown) => Promise<string>>();
jest.mock('../../src/groq/provider.js', () => ({
  __esModule: true,
  GroqProvider: jest.fn().mockImplementation(() => ({
    executeInference: mockExecuteInference,
  })),
}));

// Import after mocking — also need to reset the module-level cache
import { SafeguardWorker, _resetPatternCacheForTesting } from '../../src/roles/safeguard.js';

beforeEach(() => {
  mockExecuteInference.mockReset();

  // Reset in-process pattern cache so each test starts fresh
  _resetPatternCacheForTesting();
});

const CLEAN_RESPONSE = JSON.stringify({ violations: [] });
const NEW_VULN_RESPONSE = JSON.stringify({
  violations: [{ rule: 'timing_attack', severity: 'high', detail: 'Non-constant-time comparison detected' }],
});

describe('SafeguardWorker — pattern learning', () => {
  test('in-process cache is empty initially', async () => {
    mockExecuteInference.mockResolvedValue(CLEAN_RESPONSE);

    const worker = new SafeguardWorker('test_w1');
    await worker.scan('const x = {}');

    // System prompt should not contain any known patterns when cache is empty
    const callArg = mockExecuteInference.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArg.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemMsg).not.toContain('Known vulnerability patterns from prior scans');
  });

  test('newly discovered high/critical patterns are added to in-process cache', async () => {
    mockExecuteInference.mockResolvedValue(NEW_VULN_RESPONSE);

    const worker = new SafeguardWorker('test_w2');
    await worker.scan('if (userInput === storedHash) { /* timing vulnerable */ }');

    // Now scan again — second scan should include the cached pattern
    mockExecuteInference.mockReset();
    mockExecuteInference.mockResolvedValue(CLEAN_RESPONSE);

    await worker.scan('other code');

    const callArg = mockExecuteInference.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArg.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemMsg).toContain('Known vulnerability patterns from prior scans');
    expect(systemMsg).toContain('timing_attack');
  });

  test('cached patterns are shared across workers in the same process', async () => {
    // Worker 1 discovers a pattern
    mockExecuteInference.mockResolvedValue(NEW_VULN_RESPONSE);
    const worker1 = new SafeguardWorker('test_w3a');
    await worker1.scan('timing vulnerable code');

    // Worker 2 (different instance) sees the pattern
    mockExecuteInference.mockReset();
    mockExecuteInference.mockResolvedValue(CLEAN_RESPONSE);

    const worker2 = new SafeguardWorker('test_w3b');
    await worker2.scan('different code');

    const callArg = mockExecuteInference.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArg.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemMsg).toContain('timing_attack');
  });

  test('does not cache medium-severity patterns (only high/critical)', async () => {
    const mediumResponse = JSON.stringify({
      violations: [{ rule: 'logging_sensitive', severity: 'medium', detail: 'PII may be logged' }],
    });
    mockExecuteInference.mockResolvedValue(mediumResponse);

    const worker = new SafeguardWorker('test_w4');
    await worker.scan('console.log(user.email)');

    // Scan again — medium patterns should not be in cache
    mockExecuteInference.mockReset();
    mockExecuteInference.mockResolvedValue(CLEAN_RESPONSE);

    await worker.scan('safe code');

    const callArg = mockExecuteInference.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArg.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemMsg).not.toContain('Known vulnerability patterns from prior scans');
  });

  test('proceeds normally when LLM scan fails (non-fatal)', async () => {
    mockExecuteInference.mockRejectedValue(new Error('LLM offline'));

    const worker = new SafeguardWorker('test_w5');
    const result = await worker.scan('safe code');

    // Static rules still apply; LLM failure is non-fatal
    expect(result.approved).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test('_resetPatternCacheForTesting clears the cache between tests', async () => {
    // First scan adds a pattern
    mockExecuteInference.mockResolvedValue(NEW_VULN_RESPONSE);
    const w1 = new SafeguardWorker('test_w6a');
    await w1.scan('vulnerable code');

    // Reset
    _resetPatternCacheForTesting();

    // Second scan should not see the pattern
    mockExecuteInference.mockReset();
    mockExecuteInference.mockResolvedValue(CLEAN_RESPONSE);
    const w2 = new SafeguardWorker('test_w6b');
    await w2.scan('other code');

    const callArg = mockExecuteInference.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArg.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemMsg).not.toContain('Known vulnerability patterns from prior scans');
  });
});
