const SECRET_KEYS = /(token|secret|password|passwd|apikey|api_key|authorization|accessToken|clientSecret)/i;

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redactValue(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return redactText(value);
  return value;
}

export function redactText(text: string): string {
  return text
    .replace(/(--accessToken\s+)(\S+)/gi, '$1[redacted]')
    .replace(/((?:token|secret|password|apikey|api_key)["']?\s*[:=]\s*["']?)([^"'\s,}]{6,})/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1[redacted]');
}
