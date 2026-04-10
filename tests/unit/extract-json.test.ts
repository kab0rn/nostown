// Tests: extractJson — strips markdown fences and leading prose from LLM output

import { extractJson } from '../../src/groq/provider';

describe('extractJson', () => {
  it('returns bare JSON object unchanged', () => {
    const input = '{"beads": []}';
    expect(extractJson(input)).toBe('{"beads": []}');
  });

  it('returns bare JSON array unchanged', () => {
    const input = '[{"a": 1}]';
    expect(extractJson(input)).toBe('[{"a": 1}]');
  });

  it('strips markdown json code fence', () => {
    const input = '```json\n{"beads": []}\n```';
    expect(extractJson(input)).toBe('{"beads": []}');
  });

  it('strips plain code fence with no language tag', () => {
    const input = '```\n{"beads": []}\n```';
    expect(extractJson(input)).toBe('{"beads": []}');
  });

  it('extracts JSON from leading prose', () => {
    const input = 'Here is the decomposition:\n{"beads": [{"role": "polecat"}]}';
    const result = extractJson(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toEqual({ beads: [{ role: 'polecat' }] });
  });

  it('extracts JSON from trailing prose', () => {
    const input = '{"beads": []} Let me know if you need changes.';
    const result = extractJson(input);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('handles whitespace around fence', () => {
    const input = '  ```json\n  {"beads": []}  \n```  ';
    const result = extractJson(input);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('returns raw string when no JSON found (caller will retry)', () => {
    const input = 'I cannot decompose this task.';
    expect(extractJson(input)).toBe('I cannot decompose this task.');
  });

  it('returns raw string when input is empty', () => {
    expect(extractJson('')).toBe('');
  });

  it('preserves nested JSON structure', () => {
    const obj = { beads: [{ role: 'polecat', needs: ['a', 'b'], fan_out_weight: 2 }] };
    const input = '```json\n' + JSON.stringify(obj) + '\n```';
    const result = extractJson(input);
    expect(JSON.parse(result)).toEqual(obj);
  });
});
