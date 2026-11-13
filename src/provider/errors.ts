/** Errors deliberately contain no upstream response body, URL, headers or cause. */
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;
  readonly code: string;
  constructor(message: string, options: {status?: number; retryAfterMs?: number; retryable?: boolean; code?: string} = {}) {
    super(message); this.name = 'ApiError'; this.status = options.status ?? 0;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? (this.status === 429 || this.status === 408 || this.status >= 500);
    this.code = options.code ?? 'PROVIDER_ERROR';
  }
}
export function abortError(): DOMException { return new DOMException('Request aborted', 'AbortError'); }
export function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(Number(value) * 1000, 2147483647);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, Math.min(date - now, 2147483647)) : undefined;
}
export function protocolError(code: string): ApiError { return new ApiError('Provider returned an invalid or incomplete response', {code, retryable:false}); }
export function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
