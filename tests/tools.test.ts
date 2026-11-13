import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRegistry } from '../src/tools/index.js';
import type { ToolContext, ToolRegistry } from '../src/contracts/index.js';

let root: string;
let workspace: string;
let registry: ToolRegistry;
let context: ToolContext;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ernie-tools-'));
  workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  registry = createToolRegistry();
  context = { workspace, runId: 'files-run' };
});
afterEach(async () => {
  await registry?.cancelAll?.(context.runId);
  await rm(root, { recursive: true, force: true });
});
const call = (name: string, args: Record<string, unknown>) => registry.execute(name, args, context);

describe('project file tools', () => {
  it('publishes callable tools with explicit closed JSON object schemas', () => {
    const defs = registry.definitions();
    for (const name of ['list_files', 'read_file', 'search', 'write_file', 'edit_file', 'shell', 'process_status', 'process_cancel', 'git_diff', 'run_tests']) {
      const def = defs.find(d => d.function.name === name);
      expect(def?.function.parameters.type).toBe('object');
      expect(def?.function.parameters.additionalProperties).toBe(false);
    }
  });

  it('creates parent directories, lists files and reads requested one-based lines', async () => {
    expect((await call('write_file', { path: 'src/example.txt', content: 'alpha\nbeta\ngamma\n' })).ok).toBe(true);
    expect(await readFile(path.join(workspace, 'src/example.txt'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
    expect((await call('list_files', {})).output).toContain('src/');
    const result = await call('read_file', { path: 'src/example.txt', startLine: 2, lineCount: 1 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('beta');
    expect(result.output).not.toContain('alpha');
    expect(result.output).not.toContain('gamma');
  });

  it('replaces only a unique exact occurrence and leaves ambiguous or missing edits intact', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'same same');
    expect((await call('edit_file', { path: 'a.txt', oldText: 'same', newText: 'new' })).ok).toBe(false);
    expect((await call('edit_file', { path: 'a.txt', oldText: 'missing', newText: 'new' })).ok).toBe(false);
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('same same');
    expect((await call('edit_file', { path: 'a.txt', oldText: 'same same', newText: 'unique' })).ok).toBe(true);
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('unique');
    await writeFile(path.join(workspace, 'a.txt'), 'aaa');
    expect((await call('edit_file', { path: 'a.txt', oldText: 'aa', newText: 'X' })).ok).toBe(false);
  });

  it.each(['../outside.txt', '..\\outside.txt', 'new/../../outside.txt'])('refuses traversal for %s', async destination => {
    expect((await call('write_file', { path: destination, content: 'escape' })).ok).toBe(false);
    expect((await call('read_file', { path: destination })).ok).toBe(false);
  });

  it('rejects absolute outside paths and nonexistent destinations beneath escaping symlinks', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'private.txt'), 'private');
    await symlink(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await call('read_file', { path: path.join(outside, 'private.txt') })).ok).toBe(false);
    expect((await call('read_file', { path: 'escape/private.txt' })).ok).toBe(false);
    expect((await call('write_file', { path: 'escape/new/deep.txt', content: 'no' })).ok).toBe(false);
    expect((await call('search', { pattern: 'private', path: 'escape' })).ok).toBe(false);
  });

  it('permits safe internal symlinks but rejects symlinks to repository internals', async () => {
    await mkdir(path.join(workspace, 'src'));
    await mkdir(path.join(workspace, '.git'));
    await writeFile(path.join(workspace, 'src', 'ok.txt'), 'allowed');
    await symlink(path.join(workspace, 'src'), path.join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(path.join(workspace, '.git'), path.join(workspace, 'metadata'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await call('read_file', { path: 'alias/ok.txt' })).ok).toBe(true);
    expect((await call('write_file', { path: 'metadata/config', content: 'bad' })).ok).toBe(false);
  });

  it('protects secrets and .git paths, and omits them from search results', async () => {
    await mkdir(path.join(workspace, '.git'));
    await writeFile(path.join(workspace, '.env'), 'needle-secret');
    await writeFile(path.join(workspace, '.env.local'), 'needle-local');
    await writeFile(path.join(workspace, '.git', 'config'), 'needle-git');
    await writeFile(path.join(workspace, 'ok.txt'), 'needle-public');
    for (const candidate of ['.env', '.env.local', '.git/config']) {
      expect((await call('read_file', { path: candidate })).ok).toBe(false);
      expect((await call('write_file', { path: candidate, content: 'overwrite' })).ok).toBe(false);
    }
    const result = await call('search', { pattern: 'needle' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('needle-public');
    expect(result.output).not.toContain('needle-secret');
    expect(result.output).not.toContain('needle-local');
    expect(result.output).not.toContain('needle-git');
  });

  it('searches literal text with a glob and skips symlinked outside directories', async () => {
    await writeFile(path.join(workspace, 'a.ts'), 'const a = "a.b";\n');
    await writeFile(path.join(workspace, 'b.txt'), 'a.b');
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.ts'), 'a.b outside');
    await symlink(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await call('search', { pattern: 'a.b', glob: '*.ts' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('a.ts:1:');
    expect(result.output).not.toContain('b.txt');
    expect(result.output).not.toContain('outside');
  });

  it.each([
    ['read_file', { path: 7 }], ['read_file', { path: 'a', startLine: 0 }],
    ['read_file', { path: 'a', lineCount: 1.2 }], ['write_file', { path: 'a' }],
    ['edit_file', { path: 'a', oldText: '', newText: 'x' }], ['search', { pattern: '' }],
    ['shell', { command: 'echo hi', timeoutMs: -1 }], ['shell', { command: 'x', background: 'yes' }],
    ['run_tests', { command: '' }], ['process_status', { id: 2 }], ['git_diff', { unexpected: true }],
    ['list_files', { path: '../..' }], ['missing_tool', {}],
  ])('returns a ToolResult error for invalid %s arguments', async (name, args) => {
    expect((await call(name as string, args as Record<string, unknown>)).ok).toBe(false);
  });

  it('contains malformed argument objects instead of throwing', async () => {
    for (const args of [null, undefined, [], 'bad']) {
      expect((await registry.execute('read_file', args as never, context)).ok).toBe(false);
    }
  });

  it('bounds UTF-8 file output to 32 KiB and identifies truncation', async () => {
    await writeFile(path.join(workspace, 'large.txt'), '中'.repeat(40_000));
    const result = await call('read_file', { path: 'large.txt' });
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32768);
    expect(result.truncated).toBe(true);
  });

  it('rejects already-aborted operations before performing writes', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await registry.execute('write_file', { path: 'abort.txt', content: 'no' }, { ...context, signal: controller.signal });
    expect(result.ok).toBe(false);
    await expect(readFile(path.join(workspace, 'abort.txt'))).rejects.toThrow();
  });
  it('serializes concurrent edits so each edit sees the previous committed content', async () => {
    await writeFile(path.join(workspace, 'sequence.txt'), 'first');
    const results = await Promise.all([
      call('edit_file', { path: 'sequence.txt', oldText: 'first', newText: 'second' }),
      call('edit_file', { path: 'sequence.txt', oldText: 'second', newText: 'third' }),
    ]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(await readFile(path.join(workspace, 'sequence.txt'), 'utf8')).toBe('third');
  });

  it('falls back to local search when rg is absent', async () => {
    await writeFile(path.join(workspace, 'fallback.ts'), 'literal.[text]');
    const original = process.env.PATH;
    process.env.PATH = workspace;
    try {
      const result = await call('search', { pattern: 'literal.[text]', glob: '**/*.ts' });
      expect(result.ok).toBe(true);
      expect(result.output).toContain('fallback.ts:1:literal.[text]');
    } finally { process.env.PATH = original; }
  });

});
