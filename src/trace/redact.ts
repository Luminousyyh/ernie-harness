const REDACTED = '[REDACTED]';
const credentialKeys = new Set(['authorization', 'apikey', 'api_key', 'access_token', 'password', 'secret', 'token']);
const credentials = /sk-or-v1-[A-Za-z0-9]{40,}|(\b[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+)[A-Za-z0-9._~+\/-]+=*/g;

function textRedactor(secrets: readonly string[]): (text: string) => string {
  if (!Array.isArray(secrets)) throw new Error();
  const entries = [...secrets];
  if (entries.some(secret => typeof secret !== 'string')) throw new Error();
  const literals = [...new Set(entries)].filter(Boolean).sort((a, b) => b.length - a.length)
    .map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const known = literals.length ? new RegExp(literals.join('|'), 'g') : undefined;
  return text => {
    // Known credentials may contain punctuation outside the generic Bearer token alphabet.
    const sanitized = known ? text.replace(known, () => REDACTED) : text;
    return sanitized.replace(credentials, (_match, bearer: string | undefined) => (bearer ?? '') + REDACTED);
  };
}

/** Redact completed captures together so a credential split across chunks stays detectable. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  try {
    if (typeof text !== 'string') throw new Error();
    return textRedactor(secrets)(text);
  } catch {
    // Do not include rejected values, paths, accessor errors or their causes.
    throw new Error('Unable to sanitize trace text');
  }
}

/** Copy JSON data without executing accessors/toJSON or changing the caller's wire data. */
export function redactTrace(value: unknown, secrets: readonly string[] = []): unknown {
  try {
    const redact = textRedactor(secrets);
    const ancestors = new WeakSet<object>();
    function copy(input: unknown): unknown {
      if (input === null || typeof input === 'boolean') return input;
      if (typeof input === 'string') return redact(input);
      if (typeof input === 'number' && Number.isFinite(input)) return input;
      if (typeof input !== 'object' || input === null || ancestors.has(input)) throw new Error();
      const array = Array.isArray(input);
      const prototype = Object.getPrototypeOf(input);
      if (!array && prototype !== Object.prototype && prototype !== null) throw new Error();
      ancestors.add(input);
      try {
        const output: Record<string, unknown> | unknown[] = array ? [] : Object.create(prototype);
        for (const key of Reflect.ownKeys(input)) {
          if (typeof key !== 'string') throw new Error();
          if (array && key === 'length') continue;
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
          if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error();
          const sanitizedKey = array ? key : redact(key);
          if (Object.hasOwn(output, sanitizedKey)) throw new Error();
          Object.defineProperty(output, sanitizedKey, {
            value: credentialKeys.has(key.toLowerCase()) ? REDACTED : copy(descriptor.value),
            enumerable: true, configurable: true, writable: true,
          });
        }
        // Sparse arrays cannot be represented faithfully by JSON; do not silently insert nulls.
        if (array && Object.keys(output).length !== (input as unknown[]).length) throw new Error();
        return output;
      } finally {
        ancestors.delete(input);
      }
    }
    return copy(value);
  } catch {
    throw new Error('Unable to sanitize trace data');
  }
}
