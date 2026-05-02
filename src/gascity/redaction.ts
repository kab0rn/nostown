const MAX_STORED_STRING = 8_000;
const MAX_ERROR_STRING = 1_000;
const SECRET_KEY_RE = /(?:api[_-]?key|token|secret|authorization|password|credential)/i;
const SECRET_VALUE_RE = /\b(?:gsk_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|deepseek_[A-Za-z0-9_-]{8,})\b/g;

export function redactForStorage(value: unknown, key = '', maxStringLength = MAX_STORED_STRING): unknown {
  if (SECRET_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactSecretString(value, maxStringLength);
  if (Array.isArray(value)) return value.map((item) => redactForStorage(item, '', maxStringLength));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([childKey, childValue]) => [childKey, redactForStorage(childValue, childKey, maxStringLength)]));
  }
  return value;
}

export function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactSecretString(message, MAX_ERROR_STRING);
}

function redactSecretString(value: string, maxLength: number): string {
  const redacted = value.replace(SECRET_VALUE_RE, '[redacted]');
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}\n[truncated ${redacted.length - maxLength} chars]`;
}
