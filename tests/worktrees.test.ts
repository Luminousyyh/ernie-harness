import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChildWorktree, removeChildWorktree } from '../src/supervisor/worktrees.js';

const exec = promisify(execFile);
let root: string;
let repo: string;
let state: string;
const git = async (...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], { cwd: repo, windowsHide: true })).stdout.trim();
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ernie-worktrees-'));
  repo = path.join(root, 'repo');
  state = path.join(root, 'state');
  await mkdir(repo);
  await git('init', '-q');
  await git('config', '--local', 'core.autocrlf', 'false');
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n');
  await writeFile(path.join(repo, '.gitignore'), 'ignored/\n');
  await git('add', '.');
  await git('-c', 'user.name=Worktree Test', '-c', 'user.email=worktree@example.invalid', 'commit', '-qm', 'base');
});
afterEach(async () => {
  const actual = await realpath(root);
  if (!actual.startsWith(await realpath(tmpdir())) || !path.basename(actual).startsWith('ernie-worktrees-')) throw new Error('Unsafe test cleanup');
  await rm(actual, { recursive: true, force: true });
});

describe('isolated child worktrees', () => {
  it('creates a detached checkout at the parent commit and explicitly removes it', async () => {
    const id = randomUUID();
    const base = await git('rev-parse', 'HEAD');
    const child = await createChildWorktree(repo, state, id);
    expect(child.path).toBe(path.join(await realpath(state), 'worktrees', id));
    expect(child.baseCommit).toBe(base);
    expect(await readFile(path.join(child.path, 'tracked.txt'), 'utf8')).toBe('base\n');
    expect((await exec('git', ['rev-parse', 'HEAD'], { cwd: child.path })).stdout.trim()).toBe(base);
    await expect(exec('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: child.path })).rejects.toThrow();
    await removeChildWorktree(repo, state, id);
    expect(await git('worktree', 'list', '--porcelain')).not.toContain(id);
    await expect(realpath(child.path)).rejects.toThrow();
  });

  it.each(['tracked', 'staged', 'untracked'])('refuses a %s parent without copying changes', async dirty => {
    if (dirty === 'untracked') await writeFile(path.join(repo, 'untracked.txt'), 'do not copy');
    else await writeFile(path.join(repo, 'tracked.txt'), 'changed');
    if (dirty === 'staged') await git('add', 'tracked.txt');
    await expect(createChildWorktree(repo, state, randomUUID())).rejects.toThrow(/clean|dirty/i);
    expect((await git('worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1);
  });

  it.each(['../escape', '..\\escape', 'not-a-uuid', '11111111-1111-1111-1111-111111111111/escape'])('rejects unsafe child ID %s', async id => {
    await expect(createChildWorktree(repo, state, id)).rejects.toThrow(/UUID/i);
    await expect(removeChildWorktree(repo, state, id)).rejects.toThrow(/UUID/i);
  });

  it('refuses non-repositories and nested subdirectories as parent workspaces', async () => {
    const notRepo = path.join(root, 'not-repo');
    await mkdir(notRepo);
    await expect(createChildWorktree(notRepo, state, randomUUID())).rejects.toThrow();
    await mkdir(path.join(repo, 'sub'));
    await expect(createChildWorktree(path.join(repo, 'sub'), state, randomUUID())).rejects.toThrow(/root/i);
  });

  it('rejects escaping worktrees symlinks before creation or removal', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await mkdir(state);
    await symlink(outside, path.join(state, 'worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createChildWorktree(repo, state, randomUUID())).rejects.toThrow(/symlink|escape/i);
    await expect(removeChildWorktree(repo, state, randomUUID())).rejects.toThrow(/symlink|escape/i);
  });

  it('never overwrites an occupied destination or follows a child symlink', async () => {
    const id = randomUUID();
    const occupied = path.join(state, 'worktrees', id);
    await mkdir(occupied, { recursive: true });
    await writeFile(path.join(occupied, 'keep.txt'), 'keep');
    await expect(createChildWorktree(repo, state, id)).rejects.toThrow(/exist|occupied/i);
    await expect(removeChildWorktree(repo, state, id)).rejects.toThrow(/registered|managed/i);
    expect(await readFile(path.join(occupied, 'keep.txt'), 'utf8')).toBe('keep');
    const linkId = randomUUID();
    await symlink(repo, path.join(state, 'worktrees', linkId), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createChildWorktree(repo, state, linkId)).rejects.toThrow();
    await expect(removeChildWorktree(repo, state, linkId)).rejects.toThrow();
  });

  it('allows at most two children under concurrent creation and frees capacity only on removal', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const results = await Promise.allSettled(ids.map(id => createChildWorktree(repo, state, id)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.findIndex(result => result.status === 'rejected');
    expect(String((results[rejected] as PromiseRejectedResult).reason)).toMatch(/two|2|limit/i);
    const first = results.findIndex(result => result.status === 'fulfilled');
    await removeChildWorktree(repo, state, ids[first]);
    expect((await createChildWorktree(repo, state, ids[rejected])).baseCommit).toBe(await git('rev-parse', 'HEAD'));
  });

  it.each(['tracked', 'untracked', 'ignored'])('preserves a child with %s changes on removal', async dirty => {
    const id = randomUUID();
    const child = await createChildWorktree(repo, state, id);
    let file = path.join(child.path, dirty === 'tracked' ? 'tracked.txt' : 'new.txt');
    if (dirty === 'ignored') {
      await mkdir(path.join(child.path, 'ignored'));
      file = path.join(child.path, 'ignored', 'data.txt');
    }
    await writeFile(file, 'keep local work');
    await expect(removeChildWorktree(repo, state, id)).rejects.toThrow(/dirty|clean|untracked/i);
    expect(await readFile(file, 'utf8')).toBe('keep local work');
    expect(await git('worktree', 'list', '--porcelain')).toContain(id);
  });
});
