import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, link, lstat, mkdir, open, unlink, type FileHandle} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {redactText, redactTrace} from '../trace/redact.js';

type TraceKind = 'request' | 'response' | 'failure';
// Attempts are generated with crypto.randomUUID(); never accept paths or arbitrary IDs.
const attemptPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

async function checkDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe trace directory');
}

/** Check every ancestor before descending; newly created parents are private too. */
async function privateDirectory(directory: string): Promise<void> {
  const paths = [directory];
  while (dirname(paths[0]) !== paths[0]) paths.unshift(dirname(paths[0]));
  for (const path of paths) {
    try {
      await checkDirectory(path);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      try {
        await mkdir(path, {mode: 0o700});
        await syncDirectory(dirname(path));
      }
      catch (creationError) { if (!hasCode(creationError, 'EEXIST')) throw creationError; }
      await checkDirectory(path);
    }
  }
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose directory fsync through Node. File fsync is still required there.
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export class TraceJournal {
  private readonly directory: string;
  private readonly secrets: string[];

  constructor(options: {directory: string; secrets?: string[]}) {
    try {
      if (typeof options.directory !== 'string' || !options.directory.trim() || options.directory.includes('\0')) throw new Error();
      const secrets = options.secrets === undefined ? [] : options.secrets;
      redactText('', secrets);
      this.directory = resolve(options.directory);
      this.secrets = [...secrets];
    } catch {
      throw new Error('Invalid provider trace options');
    }
  }

  async record(attemptId: string, kind: TraceKind, data: unknown,
    context: {trialId: string; secrets?: string[]}): Promise<void> {
    let temporary: string | undefined;
    let handle: FileHandle | undefined;
    try {
      if (typeof attemptId !== 'string' || !attemptPattern.test(attemptId)
        || !['request', 'response', 'failure'].includes(kind) || typeof context.trialId !== 'string') throw new Error();
      const contextSecrets = context.secrets === undefined ? [] : context.secrets;
      // Validate separately: spreading a malformed string would otherwise disguise it as a list.
      redactText('', contextSecrets);
      const secrets = [...this.secrets, ...contextSecrets];
      const record = JSON.stringify({
        schemaVersion: 1, kind, attemptId, trialId: redactText(context.trialId, secrets),
        recordedAt: new Date().toISOString(), data: redactTrace(data, secrets),
      }) + '\n';
      await privateDirectory(this.directory);
      const destination = join(this.directory, `${attemptId}.${kind}.json`);
      try {
        await lstat(destination);
        // Includes regular files, symlinks (even dangling ones), and directories.
        throw new Error('Provider trace record already exists');
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      const candidate = join(this.directory, `.${attemptId}.${kind}.${randomUUID()}.tmp`);
      handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      temporary = candidate; // Only clean up files exclusively created by this call.
      await handle.writeFile(record, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Recheck before publishing. The private directory also limits path replacement races.
      await privateDirectory(this.directory);
      // Hard-link publication is atomic and fails on EEXIST; rename would overwrite on POSIX.
      await link(temporary, destination);
      await unlink(temporary);
      temporary = undefined;
      await syncDirectory(this.directory);
    } catch {
      // Filesystem errors can contain paths and malformed values can contain credentials.
      // A record published before a later fsync failure is retained, never replayed/overwritten.
      throw new Error('Unable to record provider trace');
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }
}
