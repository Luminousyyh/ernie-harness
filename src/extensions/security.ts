import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const MAX_DOCUMENT_BYTES = 128 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
const SENSITIVE_ENV = /(?:token|secret|password|passwd|credential|authorization|api.?key|private.?key|openrouter)/i;
const SYSTEM_ENV = /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|lang|lc_all|lc_ctype|tz)$/i;
const DANGEROUS_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PYTHON.*|BASH_ENV|ENV|SHELLOPTS|PSMODULEPATH)$/i;

export function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function normalizedRelative(value: string): string {
  return value.replaceAll('\\', path.sep).replaceAll('/', path.sep);
}
function protectedPath(root: string, candidate: string): boolean {
  return path.relative(root, candidate).split(/[\\/]/).some(part => /^(?:\.git|\.ssh|\.aws|\.azure|\.env(?:\..*)?|\.npmrc|\.netrc|credentials.*|id_rsa.*|id_ed25519.*)$/i.test(part));
}
export async function canonicalWorkspace(workspace: string): Promise<string> {
  const canonical = await realpath(workspace);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Workspace must be a directory');
  return canonical;
}
/** Both lexical and canonical scope are checked, including every existing ancestor of a missing target. */
export function scopedPath(root: string, candidate: string): string {
  const absolute = path.resolve(root, normalizedRelative(candidate));
  if (!within(root, absolute) || protectedPath(root, absolute)) throw new Error('Path is outside the allowed scope');
  return absolute;
}
export async function boundedPath(root: string, candidate: string): Promise<string> {
  const absolute = scopedPath(root, candidate);
  const canonical = await realpath(absolute);
  if (!within(root, canonical) || protectedPath(root, canonical)) throw new Error('Symlink is outside the allowed scope');
  return canonical;
}
export async function readBounded(root: string, candidate: string, maxBytes = MAX_DOCUMENT_BYTES): Promise<string> {
  const canonical = await boundedPath(root, candidate);
  const before = await stat(canonical);
  if (!before.isFile() || before.size > maxBytes) throw new Error('Document exceeds the allowed size or is not a regular file');
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('Document exceeds the allowed size or is not a regular file');
    // Read at most limit+1 even if another process grows the file after stat.
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await stat(canonical);
    if (bytesRead > maxBytes || info.ino !== after.ino || info.dev !== after.dev || info.ino !== before.ino || await boundedPath(root, candidate) !== canonical) throw new Error('Document changed or exceeds allowed size');
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    if (content.includes('\0')) throw new Error('Document contains invalid text');
    return content.replace(/^\uFEFF/, '');
  } finally { await handle.close(); }
}
export function scrubMcpEnvironment(mapping: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const output: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(source)) if (value !== undefined && SYSTEM_ENV.test(key) && !SENSITIVE_ENV.test(key) && !DANGEROUS_ENV.test(key)) output[key] = value;
  for (const [target, runtimeName] of Object.entries(mapping)) {
    if (DANGEROUS_ENV.test(target) || ['__proto__', 'constructor', 'prototype'].includes(target)) throw new Error('Unsafe subprocess environment mapping');
    if (source[runtimeName] === undefined) throw new Error('Configured runtime environment variable is unavailable');
    output[target] = source[runtimeName]!;
  }
  return output;
}
export class ExtensionRedactor {
  private readonly values = new Set<string>();
  constructor() { for (const [key, value] of Object.entries(process.env)) if (SENSITIVE_ENV.test(key) && value && value.length >= 4) this.add(value); }
  add(value: string | undefined): void { if (value) { this.values.add(value); this.values.add(JSON.stringify(value).slice(1, -1)); } }
  clean(value: string, maxBytes = MAX_OUTPUT_BYTES): string {
    for (const [key, current] of Object.entries(process.env)) if (SENSITIVE_ENV.test(key) && current && current.length >= 4) this.add(current);
    let output = value;
    for (const secret of [...this.values].sort((a, b) => b.length - a.length)) output = output.split(secret).join('[REDACTED]');
    output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
    const bytes = Buffer.from(output);
    return bytes.length > maxBytes ? bytes.subarray(0, maxBytes).toString('utf8') + '\n[truncated]' : output;
  }
}
export function abortError(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('Extension operation cancelled'); }

/** SDK promises receive the same abort signal; the race bounds uncooperative trusted plugins. */
export async function boundedOperation<T>(operation: (signal: AbortSignal) => Promise<T> | T, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  abortError(signal);
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = (message: string) => { rejectAbort(new Error(message)); controller.abort(); };
  const onAbort = () => cancel('Extension operation cancelled; effects may be uncertain');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => cancel('Extension operation timed out; effects may be uncertain'), timeoutMs);
  try { return await Promise.race([Promise.resolve().then(() => { abortError(controller.signal); return operation(controller.signal); }), cancelled]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
