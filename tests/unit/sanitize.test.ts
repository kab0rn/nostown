// Tests: Input sanitization guards — Gate 6

import {
  sanitizeHookValue,
  sanitizeRigName,
  sanitizeAgentId,
  sanitizeTaskDescription,
  sanitizeDiff,
  MAX_LENGTHS,
} from '../../src/hardening/sanitize';

describe('sanitizeHookValue', () => {
  it('passes clean values through', () => {
    expect(sanitizeHookValue('bead-abc123')).toBe('bead-abc123');
    expect(sanitizeHookValue('SUCCESS')).toBe('SUCCESS');
    expect(sanitizeHookValue('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00Z');
  });

  it('truncates values exceeding max length', () => {
    const long = 'a'.repeat(1000);
    const result = sanitizeHookValue(long);
    expect(result?.length).toBe(MAX_LENGTHS.hookPayloadValue);
  });

  it('blocks template literal injection', () => {
    expect(sanitizeHookValue('${process.env.SECRET}')).toBeNull();
  });

  it('blocks backtick execution', () => {
    expect(sanitizeHookValue('value`rm -rf /`rest')).toBeNull();
  });

  it('blocks command chaining', () => {
    expect(sanitizeHookValue('ok; rm -rf /')).toBeNull();
  });

  it('blocks XSS patterns', () => {
    expect(sanitizeHookValue('<script>alert(1)</script>')).toBeNull();
  });

  it('blocks path traversal', () => {
    expect(sanitizeHookValue('../../etc/passwd')).toBeNull();
  });
});

describe('sanitizeRigName', () => {
  it('allows alphanumeric, hyphens, underscores', () => {
    expect(sanitizeRigName('my-rig')).toBe('my-rig');
    expect(sanitizeRigName('rig_123')).toBe('rig_123');
    expect(sanitizeRigName('RIG')).toBe('RIG');
  });

  it('rejects spaces and special chars', () => {
    expect(sanitizeRigName('my rig')).toBeNull();
    expect(sanitizeRigName('rig/path')).toBeNull();
    expect(sanitizeRigName('rig;echo')).toBeNull();
  });

  it('truncates long names', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeRigName(long)?.length).toBe(MAX_LENGTHS.rigName);
  });
});

describe('sanitizeAgentId', () => {
  it('allows valid agent IDs', () => {
    expect(sanitizeAgentId('mayor_01')).toBe('mayor_01');
    expect(sanitizeAgentId('polecat-worker')).toBe('polecat-worker');
  });

  it('rejects invalid characters', () => {
    expect(sanitizeAgentId('agent@host')).toBeNull();
    expect(sanitizeAgentId('agent id')).toBeNull();
  });
});

describe('sanitizeTaskDescription', () => {
  it('passes through normal descriptions', () => {
    expect(sanitizeTaskDescription('Build feature X')).toBe('Build feature X');
  });

  it('truncates to max length', () => {
    const long = 'x'.repeat(5000);
    expect(sanitizeTaskDescription(long).length).toBe(MAX_LENGTHS.taskDescription);
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeTaskDescription(null as unknown as string)).toBe('');
  });
});

describe('sanitizeDiff', () => {
  it('truncates oversized diffs', () => {
    const large = 'x'.repeat(100_000);
    expect(sanitizeDiff(large).length).toBe(MAX_LENGTHS.diff);
  });

  it('passes small diffs through unchanged', () => {
    const diff = '+++ file.ts\n- old\n+ new';
    expect(sanitizeDiff(diff)).toBe(diff);
  });
});
