import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_OUTPUT_BYTES = 32 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Operation cancelled');
}
export function clip(text: string, max = MAX_OUTPUT_BYTES): { output: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return { output: text, truncated: false };
  let end = Math.max(0, max);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { output: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
export function secretPart(part: string): boolean {
  const name = part.toLowerCase();
  return name === '.git' || name === '.ssh' || name === '.aws' || name === '.azure'
    || name === '.npmrc' || name === '.netrc' || name === '.pypirc'
    || /^\.env(?:\.|$)/i.test(name)
    || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(name)
    || /^(?:credentials|secrets?)(?:\.|$)/.test(name)
    || /\.(?:pem|key|p12|pfx)$/.test(name);
}
export function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
function guard(root: string, target: string): void {
  if (!inside(root, target)) throw new Error('Path escapes the authorized workspace');
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  if (parts.some(secretPart)) throw new Error('Access to repository internals or secret files is denied');
}
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }

/** All existing components are resolved, including parents of a new destination. */
export async function resolvePath(root: string, input: string, signal?: AbortSignal): Promise<string> {
  aborted(signal);
  if (input.includes('\0') || /[\r\n]/.test(input)) throw new Error('Invalid path');
  const normalized = input.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some(part => part !== '.' && part !== '..' && (/[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    throw new Error('Unsafe or reserved path component');
  }
  if (parts.some((part, index) => part.includes(':') && !(process.platform === 'win32' && index === 0 && /^[a-z]:$/i.test(part)))) throw new Error('Invalid path colon');
  const requested = path.resolve(root, normalized);
  guard(root, requested);
  let current = root;
  for (const part of path.relative(root, requested).split(path.sep).filter(Boolean)) {
    aborted(signal);
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) current = await realpath(current);
      guard(root, current);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      // A dangling link is not a safe missing destination.
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Dangling symlink is not allowed'); }
      catch (nested) { if (errorCode(nested) !== 'ENOENT') throw nested; }
    }
  }
  guard(root, current);
  return current;
}
export async function workspaceRoot(workspace: string, signal?: AbortSignal): Promise<string> {
  aborted(signal);
  if (typeof workspace !== 'string' || !workspace) throw new Error('A workspace is required');
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace must be a directory');
  return root;
}
export async function readText(root: string, input: string, signal?: AbortSignal): Promise<string> {
  const target = await resolvePath(root, input, signal);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Path must refer to a regular file');
    if (info.size > MAX_FILE_BYTES) throw new Error('File exceeds the 8 MiB read limit');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      aborted(signal);
      const chunk = Buffer.allocUnsafe(Math.min(65536, MAX_FILE_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) throw new Error('File exceeds the 8 MiB read limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await handle.close(); }
}
export async function writeText(root: string, input: string, text: string, signal?: AbortSignal): Promise<string> {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Content exceeds the 8 MiB write limit');
  let target = await resolvePath(root, input, signal);
  if (target === root) throw new Error('Cannot overwrite the workspace directory');
  await mkdir(path.dirname(target), { recursive: true });
  target = await resolvePath(root, input, signal);
  let mode = 0o600;
  try {
    const info = await lstat(target);
    if (!info.isFile()) throw new Error('Destination must be a regular file');
    mode = info.mode & 0o777;
  } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(target), `.ernie-write-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(text, { encoding: 'utf8', signal });
    await handle.close();
    aborted(signal);
    if (await resolvePath(root, input, signal) !== target) throw new Error('Destination changed during write');
    await rename(temporary, target);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return path.relative(root, target).replaceAll('\\', '/');
}
export async function listFiles(root: string, input: string, signal?: AbortSignal): Promise<string> {
  const target = await resolvePath(root, input, signal);
  const entries = await readdir(target, { withFileTypes: true });
  const results: string[] = [];
  let bytes = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    aborted(signal);
    if (secretPart(entry.name)) continue;
    try { await resolvePath(root, path.join(target, entry.name), signal); } catch { aborted(signal); continue; }
    const line = entry.name + (entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : '');
    results.push(line);
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > MAX_OUTPUT_BYTES) break;
  }
  return results.join('\n');
}
export async function* searchFiles(root: string, input: string, signal?: AbortSignal): AsyncGenerator<string> {
  const start = await resolvePath(root, input, signal);
  const pending = [start];
  let visited = 0;
  while (pending.length) {
    aborted(signal);
    if (++visited > 20_000) throw new Error('Search exceeds 20,000 entries; narrow the path');
    const current = pending.pop()!;
    const info = await lstat(current);
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) { yield current; continue; }
    if (!info.isDirectory()) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (secretPart(entry.name) || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      await resolvePath(root, candidate, signal);
      pending.push(candidate);
    }
  }
}
