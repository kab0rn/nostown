// Tests for Safeguard vulnerability pattern cross-session learning
// Per ROLES.md §Safeguard: workers write detected patterns to wing_safeguard/hall_facts
// and read them back on subsequent scans (diary-based cross-session memory).

import { jest } from '@jest/globals';

// --- mock GroqProvider ---
const mockExecuteInference = jest.fn<(params: unknown) => Promise<string>>();
jest.mock('../../src/groq/provider.js', () => ({
  __esModule: true,
  GroqProvider: jest.fn().mockImplementation(() => ({
    executeInference: mockExecuteInference,
  })),
}));

// --- mock MemPalaceClient ---
const diaryStore: string[] = [];
const drawerStore: Array<{ wing: string; hall: string; room: string; content: string }> = [];

const mockDiaryRead = jest.fn<(wing: string, limit: number) => Promise<Array<{ content: string }>>>();
const mockDiaryWrite = jest.fn<(wing: string, entry: string) => Promise<void>>();
const mockAddDrawer = jest.fn<() => Promise<void>>();

jest.mock('../../src/mempalace/client.js', () => ({
  __esModule: true,
  MemPalaceClient: jest.fn().mockImplementation(() => ({
    diaryRead: mockDiaryRead,
    diaryWrite: mockDiaryWrite,
    addDrawer: mockAddDrawer,
  })),
}));

// Import after mocking — also need to reset the module-level cache
import { SafeguardWorker, _resetPatternCacheForTesting } from '../../src/roles/safeguard.js';

beforeEach(() => {
  mockExecuteInference.mockReset();
  mockDiaryRead.mockReset();
  mockDiaryWrite.mockReset();
  mockAddDrawer.mockReset();
  diaryStore.length = 0;
  drawerStore.length = 0;

  // Reset in-process pattern cache so each test starts fresh
  _resetPatternCacheForTesting();

  // Default: empty diary (no prior patterns)
  mockDiaryRead.mockResolvedValue([]);
  mockDiaryWrite.mockResolvedValue(undefined);
  mockAddDrawer.mockResolvedValue(undefined);
});

const CLEAN_RESPONSE = JSON.stringify({ violations: [] });
const NEW_VULN_RESPONSE = JSON.stringify({
  violations: [{ rule: 'timing_attack', severity: 'high', detail: 'Non-constant-time comparison detected' }],
});

describe('SafeguardWorker — pattern learning', () => {
  test('loads known patterns from diary before LLM scan', async () => {
    mockDiaryRead.mockResolvedValue([
      { content: 'vuln-pattern:prototype_pollution: __proto__ manipulation detected' },
      { content: 'vuln-pattern:timing_attack: Non-constant-time comparison detected' },
    ]);
    mockExecuteInference.mockResolvedValue(CLEAN_RESPONSE);

    const worker = new SafeguardWorker('test_w1');
    await worker.scan('const x = {}');

    // LLM scan prompt should include known patterns
    const callArg = mockExecuteInference.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArg.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemMsg).toContain('Known vulnerability patterns from prior scans');
    expect(systemMsg).toContain('prototype_pollution');
    expect(systemMsg).toContain('timing_attack');
  });

  test('persists newly discovered high/critical patterns to wing_safeguard', async () => {
    mockDiaryRead.mockResolvedValue([]);
    mockExecuteInference.mockResolvedValue(NEW_VULN_RESPONSE);

    const worker = new SafeguardWorker('test_w2');
    await worker.scan('if (userInput === storedHash) { /* timing vulnerable */ }');

    // Should have written to hall_facts drawer
    await new Promise((r) => setTimeout(r, 20)); // allow async persist to complete

    expect(mockAddDrawer).toHaveBeenCalledWith(
      'wing_safeguard',
      'hall_facts',
      expect.stringContaining('vuln-timing_attack'),
      expect.stringContaining('timing_attack'),
      expect.stringContaining('timing_attack'),
    );
  });

  test('persists to diary for fast cross-worker reload', async () => {
    mockDiaryRead.mockResolvedValue([]);
    mockExecuteInference.mockResolvedValue(NEW_VULN_RESPONSE);

    const worker = new SafeguardWorker('test_w3');
    await worker.scan('if (userInput === storedHash) {}');

    await new Promise((r) => setTimeout(r, 20));

    expect(mockDiaryWrite).toHaveBeenCalledWith(
      'wing_safeguard',
      expect.stringContaining('timing_attack'),
    );
  });

  test('does not persist medium-severity patterns (only high/critical)', async () => {
    const mediumResponse = JSON.stringify({
      violations: [{ rule: 'logging_sensitive', severity: 'medium', detail: 'PII may be logged' }],
    });
    mockDiaryRead.mockResolvedValue([]);
    mockExecuteInference.mockResolvedValue(mediumResponse);

    const worker = new SafeguardWorker('test_w4');
    await worker.scan('console.log(user.email)');

    await new Promise((r) => setTimeout(r, 20));

    // medium violations are not persisted
    expect(mockAddDrawer).not.toHaveBeenCalled();
    expect(mockDiaryWrite).not.toHaveBeenCalled();
  });

  test('proceeds without patterns if diary read fails (non-fatal)', async () => {
    mockDiaryRead.mockRejectedValue(new Error('Palace offline'));
    mockExecuteInference.mockResolvedValue(CLEAN_RESPONSE);

    const worker = new SafeguardWorker('test_w5');
    const result = await worker.scan('safe code');

    expect(result.approved).toBe(true);
  });

  test('cross-session simulation: pattern written by session 1 is read by session 2', async () => {
    // Session 1: detect a new vulnerability and write it to palace
    const capturedDiaryEntries: string[] = [];

    mockDiaryRead.mockResolvedValue([]);
    mockDiaryWrite.mockImplementation(async (_wing: string, entry: string) => {
      capturedDiaryEntries.push(entry);
    });
    mockExecuteInference.mockResolvedValue(NEW_VULN_RESPONSE);

    const worker1 = new SafeguardWorker('session1_worker');
    await worker1.scan('timing vulnerable code');

    // Allow async persistPattern to complete
    await new Promise((r) => setTimeout(r, 20));

    // Confirm session 1 wrote the pattern
    expect(capturedDiaryEntries.some((e) => e.includes('timing_attack'))).toBe(true);

    // ── Session 2 starts: reset in-process cache to simulate new process ──
    _resetPatternCacheForTesting();

    // Session 2 reads diary from palace (populated by session 1)
    mockDiaryRead.mockResolvedValue(
      capturedDiaryEntries.map((content) => ({ content })),
    );
    mockExecuteInference.mockReset();
    mockExecuteInference.mockResolvedValue(CLEAN_RESPONSE);

    const worker2 = new SafeguardWorker('session2_worker');
    await worker2.scan('different code');

    // Session 2's LLM scan prompt should include the pattern learned from session 1
    const callArg = mockExecuteInference.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArg.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemMsg).toContain('timing_attack');
  });
});
