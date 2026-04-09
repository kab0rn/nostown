// Tests: Ollama startup health check (RESILIENCE.md)
// GroqProvider warns when OLLAMA_URL is set but Ollama is unreachable at startup.

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { GroqProvider } from '../../src/groq/provider';

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.OLLAMA_URL;
});

afterEach(() => {
  delete process.env.OLLAMA_URL;
  jest.restoreAllMocks();
});

describe('GroqProvider Ollama startup health check (RESILIENCE.md)', () => {
  it('returns true immediately when OLLAMA_URL is not set', async () => {
    const provider = new GroqProvider('test-key');
    const result = await provider.checkOllamaHealth();
    expect(result).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns true and logs OK when Ollama is reachable', async () => {
    process.env.OLLAMA_URL = 'http://localhost:11434';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    } as Response);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const provider = new GroqProvider('test-key');
    const result = await provider.checkOllamaHealth();

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Ollama health check OK'));
    logSpy.mockRestore();
  });

  it('returns false and warns when Ollama returns non-200', async () => {
    process.env.OLLAMA_URL = 'http://localhost:11434';
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new GroqProvider('test-key');
    const result = await provider.checkOllamaHealth();

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('503'));
    warnSpy.mockRestore();
  });

  it('returns false and warns when Ollama is unreachable (network error)', async () => {
    process.env.OLLAMA_URL = 'http://localhost:11434';
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new GroqProvider('test-key');
    const result = await provider.checkOllamaHealth();

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unreachable'));
    warnSpy.mockRestore();
  });

  it('does not throw when health check fails (non-fatal)', async () => {
    process.env.OLLAMA_URL = 'http://localhost:11434';
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // GroqProvider constructor fires health check as void (non-blocking)
    // It should not throw or break construction
    expect(() => new GroqProvider('test-key')).not.toThrow();
  });
});
