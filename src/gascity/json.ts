export function extractJson(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    return s;
  }
  const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fence) return fence[1].trim();
  const first = s.search(/[{[]/);
  if (first !== -1) {
    const close = s[first] === '{' ? '}' : ']';
    const last = s.lastIndexOf(close);
    if (last > first) return s.slice(first, last + 1);
  }
  return raw;
}

export function safeJsonParse(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(extractJson(raw)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('model output was not a JSON object');
  }
  return parsed as Record<string, unknown>;
}
