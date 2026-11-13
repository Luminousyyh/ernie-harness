import {createHash} from 'node:crypto';
import {closeSync, constants, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join, relative} from 'node:path';
import type {Evidence, Goal} from '../contracts/index.js';
import {redactText} from '../trace/redact.js';
import type {LearningPartition, MemoryEvidence} from './types.js';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function canonicalProject(workspace: string): {workspace: string; projectId: string} {
  if (!isAbsolute(workspace)) throw new Error('Learning workspace must be absolute');
  const canonical = realpathSync(workspace);
  if (!statSync(canonical).isDirectory()) throw new Error('Learning workspace must be a directory');
  return {workspace: canonical, projectId: digest(process.platform === 'win32' ? canonical.toLowerCase() : canonical)};
}
/** Explicit formal always wins, including when migrating the older learningPartition spelling. */
export function partitionFor(goal: Goal): LearningPartition {
  const data = goal as Goal & {partition?: unknown; learningPartition?: unknown};
  if (data.partition === 'formal' || data.learningPartition === 'formal') return 'formal';
  const partition = data.partition ?? data.learningPartition ?? 'production';
  if (partition !== 'production' && partition !== 'development') throw new Error('Invalid learning partition');
  if (data.partition && data.learningPartition && data.partition !== data.learningPartition) throw new Error('Conflicting learning partition');
  return partition;
}
export function sanitize(text: string): string {
  const secrets = Object.entries(process.env).filter(([key, value]) => /(?:key|token|secret|password|credential)/i.test(key) && value && value.length >= 4).map(([, value]) => value!);
  return redactText(text, secrets)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:github_pat_[\w]+|gh[pousr]_[\w]+|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\b\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;"'}\]]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
export function bounded(text: string, bytes: number): string {
  let result = text.slice(0, bytes);
  while (Buffer.byteLength(result, 'utf8') > bytes) result = result.slice(0, -Math.max(1, Math.ceil(result.length / 16)));
  return result;
}
export function memoryText(text: unknown): string {
  if (typeof text !== 'string' || text.length > 6000) throw new Error('Invalid reusable memory text');
  const normalized = text.normalize('NFKC');
  if (/<\s*\/?\s*(?:think|analysis|reasoning)\b[^>]*>|^\s*(?:#{1,6}\s*)?(?:analysis|reasoning|thoughts?)\s*:|chain[ -]of[ -]thought|private reasoning|let me (?:think|reason)|思考过程|推理过程|ignore (?:all |the )?(?:previous|system|developer) instructions/i.test(normalized)) throw new Error('Invalid reusable memory text');
  const clean = sanitize(normalized).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!clean || Buffer.byteLength(clean, 'utf8') > 1600) throw new Error('Memory text must contain at most 1600 bytes');
  return clean;
}
export const fingerprint = (text: string): string => digest(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim());
export function evidenceId(goalId: string, evidence: Evidence): string {
  return digest({goalId, command: sanitize(evidence.command), goalRevision: evidence.goalRevision, workspaceHash: evidence.workspaceHash, exitCode: evidence.exitCode, output: sanitize(evidence.output), createdAt: evidence.createdAt});
}
export function evidenceLink(goalId: string, evidence: Evidence): MemoryEvidence {
  return {id: evidenceId(goalId, evidence), goalId, goalRevision: evidence.goalRevision, command: bounded(sanitize(evidence.command), 1000), workspaceHash: evidence.workspaceHash, createdAt: evidence.createdAt};
}

// Match the engine's verification framing exactly. Read-only, bounded streaming avoids
// loading large sources or persisting their contents, and symlink targets are never read.
const ignored = new Set(['.git','node_modules','.cache','.ernie','dist','build','__pycache__','.pytest_cache','.venv','artifacts','test-results','playwright-report']);
export function sourceHash(workspace: string): string {
  const hash = createHash('sha256'); let count = 0;
  const frame = (value: string): void => {const bytes = Buffer.from(value, 'utf8'); hash.update(String(bytes.length) + ':'); hash.update(bytes);};
  function walk(directory: string): void {
    const entries = readdirSync(directory, {withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.name.endsWith('.log') || entry.name.startsWith('.env')) continue;
      if (++count > 50000) throw new Error('Learning source fingerprint exceeds limit');
      const path = join(directory, entry.name); const stat = lstatSync(path);
      if (stat.isSymbolicLink() || entry.isSymbolicLink()) throw new Error('Learning cannot fingerprint symlink targets');
      frame(stat.isDirectory() ? 'directory' : 'file'); frame(relative(workspace, path));
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const content = createHash('sha256'); const buffer = Buffer.alloc(65536);
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {let bytes: number; while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) content.update(buffer.subarray(0, bytes));}
        finally {closeSync(fd);}
        const after = lstatSync(path);
        if (after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) throw new Error('Source changed while fingerprinting');
        frame(content.digest('hex'));
      } else throw new Error('Learning source contains a special file');
    }
  }
  walk(workspace); return hash.digest('hex');
}
export function safeSourceHash(workspace: string): string | undefined {try {return sourceHash(workspace);} catch {return undefined;}}
export function keywords(text: string): Set<string> {
  const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const stop = new Set(['the','and','for','with','from','that','this','after','before','code','change','use']);
  const tokens = words.filter(word => !stop.has(word));
  for (const word of words) if (/\p{Script=Han}/u.test(word)) for (let index = 0; index < word.length - 1; index++) tokens.push(word.slice(index, index + 2));
  return new Set(tokens);
}
