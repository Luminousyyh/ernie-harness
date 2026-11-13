import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets, scrubEnvironment } from '../tools/processes.js';

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHILDREN = 2;
// One shared mutation queue prevents concurrent calls from reserving the same
// capacity. The supervisor remains responsible for one writer per workspace.
let mutationTail: Promise<void> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const pending = mutationTail.then(action);
  mutationTail = pending.then(() => undefined, () => undefined);
  return pending;
}
function childName(id: string): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('childId must be a safe UUID');
  return id.toLowerCase();
}
function canonicalKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute('git', [
      '--no-pager', '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      ...args,
    ], { cwd, env: { ...scrubEnvironment(), GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return stdout;
  } catch (error) {
    const details = error as Error & { stderr?: string };
    throw new Error(redactSecrets(`Git worktree operation failed: ${(details.stderr || details.message).slice(0, 4096)}`));
  }
}
async function repositoryRoot(parentWorkspace: string): Promise<string> {
  const root = await realpath(parentWorkspace);
  const top = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim());
  if (canonicalKey(root) !== canonicalKey(top)) throw new Error('Parent workspace must be the Git repository root');
  return root;
}
async function assertClean(root: string, includeIgnored = false): Promise<void> {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'];
  if (includeIgnored) args.push('--ignored=matching');
  if ((await git(root, args)).length) throw new Error('Workspace is dirty; a clean tracked and untracked state is required');
}
async function worktreePaths(root: string): Promise<string[]> {
  // Git 2.34 (Ubuntu LTS) predates worktree list -z. Disable quoting and reject
  // newline paths so the portable porcelain framing remains unambiguous.
  const listing=await git(root, ['-c','core.quotePath=false','worktree','list','--porcelain']);
  return listing.split(/\r?\n/).filter(line=>line.startsWith('worktree ')).map(line=>{
    const value=line.slice(9);if(!value||value.startsWith('"')||/[\r\n\0]/.test(value))throw new Error('Unsupported quoted worktree path');return path.resolve(value);
  });
}

/** Reject symlinks in the entire state path, including any existing ancestor of a new directory. */
async function safeDirectory(directory: string, create: boolean): Promise<string> {
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) throw new Error('A state directory is required');
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error('State directory symlinks are not allowed');
      if (!entry.isDirectory()) throw new Error('State path must be a directory');
    } catch (error) {
      if (!missing(error) || !create) throw error;
      await mkdir(current);
    }
  }
  const resolved = await realpath(absolute);
  if (canonicalKey(resolved) !== canonicalKey(absolute)) throw new Error('State directory escapes its authorized path');
  return resolved;
}
async function destination(stateDir: string, id: string, create: boolean): Promise<{ root: string; child: string }> {
  const state = await safeDirectory(stateDir, create);
  const root = await safeDirectory(path.join(state, 'worktrees'), create);
  const child = path.join(root, id);
  if (path.dirname(child) !== root) throw new Error('Child destination escapes the worktrees directory');
  return { root, child };
}

export interface ChildWorktree { path: string; baseCommit: string }

/** Create only from committed, clean parent state; never copies local edits or invokes a model. */
export function createChildWorktree(parentWorkspace: string, stateDir: string, childId: string): Promise<ChildWorktree> {
  return serialized(async () => {
    const id = childName(childId);
    const parent = await repositoryRoot(parentWorkspace);
    await assertClean(parent);
    const baseCommit = (await git(parent, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    const { root, child } = await destination(stateDir, id, true);
    try {
      await lstat(child);
      throw new Error('Child destination already exists; occupied paths are never overwritten');
    } catch (error) { if (!missing(error)) throw error; }
    const registered = await worktreePaths(parent);
    const occupied = new Set(registered.filter(file => path.basename(path.dirname(file)) === 'worktrees' && UUID.test(path.basename(file))).map(canonicalKey));
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (UUID.test(entry.name)) occupied.add(canonicalKey(path.join(root, entry.name)));
    }
    if (registered.some(file => canonicalKey(file) === canonicalKey(child))) throw new Error('Child worktree is already registered');
    if (occupied.size >= MAX_CHILDREN) throw new Error('At most two (2) active child worktrees are allowed');
    // Recheck after resolving destinations. The supervisor must hold its writer
    // ownership through this operation so external edits cannot race checkout.
    await assertClean(parent);
    await git(parent, ['worktree', 'add', '--detach', '--', child, baseCommit]);
    // A failed checkout is left for explicit inspection; never force-delete it.
    if (canonicalKey(await realpath(child)) !== canonicalKey(child)) throw new Error('Created worktree path escaped its destination');
    return { path: child, baseCommit };
  });
}

/** Explicit removal only. Dirty, ignored, unregistered, or linked destinations are preserved. */
export function removeChildWorktree(parentWorkspace: string, stateDir: string, childId: string): Promise<void> {
  return serialized(async () => {
    const id = childName(childId);
    const parent = await repositoryRoot(parentWorkspace);
    const { child } = await destination(stateDir, id, false);
    const entry = await lstat(child);
    if (entry.isSymbolicLink() || !entry.isDirectory() || canonicalKey(await realpath(child)) !== canonicalKey(child)) throw new Error('Child worktree must be a confined directory, not a symlink');
    const registered = await worktreePaths(parent);
    if (!registered.some(file => canonicalKey(file) === canonicalKey(child))) throw new Error('Destination is not a registered managed child worktree');
    await assertClean(child, true);
    await git(parent, ['worktree', 'remove', '--', child]);
  });
}
