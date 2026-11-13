import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRegistry, killProcessTree } from '../src/tools/index.js';
import type { ToolContext, ToolRegistry } from '../src/contracts/index.js';

let workspace: string;
let registry: ToolRegistry;
let context: ToolContext;
const exec = promisify(execFile);
const command = (file: string) => `"${process.execPath}" "${file}"`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(40);
  }
  throw new Error('Condition did not become true within 7 seconds');
}
beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'ernie-process-'));
  registry = createToolRegistry();
  context = { workspace, runId: 'process-run' };
});
afterEach(async () => {
  await registry?.cancelAll?.(context.runId);
  await registry?.cancelAll?.('other-run');
  await rm(workspace, { recursive: true, force: true });
});
const call = (name: string, args: Record<string, unknown>) => registry.execute(name, args, context);
const status = async (id: string) => JSON.parse((await call('process_status', { id })).output);

describe('local process tools', () => {
  it('runs commands in the workspace and preserves real test exit codes', async () => {
    await writeFile(path.join(workspace, 'cwd.cjs'), 'console.log(process.cwd()); process.exit(7)');
    const result = await call('run_tests', { command: command('cwd.cjs') });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.output).toContain(workspace);
  });

  it('scrubs provider and other credentials from child environments', async () => {
    const keys = ['OPENROUTER_API_KEY', 'OTHER_API_KEY', 'AWS_SESSION_TOKEN', 'DATABASE_PASSWORD'];
    const previous = keys.map(key => process.env[key]);
    try {
      for (const key of keys) process.env[key] = 'credential-must-not-escape';
      await writeFile(path.join(workspace, 'env.cjs'), `console.log(JSON.stringify(${JSON.stringify(keys)}.map(k => process.env[k] || 'absent')))`);
      const result = await call('shell', { command: command('env.cjs') });
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain('credential-must-not-escape');
      expect(result.output).toContain('absent');
    } finally {
      keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    }
  });

  it('drains both pipes without deadlock and bounds result and output events', async () => {
    const events: Array<{ type: string; data: any }> = [];
    context.emit = (type, data) => events.push({ type, data });
    await writeFile(path.join(workspace, 'flood.cjs'), "process.stdout.write('中'.repeat(200000)); process.stderr.write('err'.repeat(200000));");
    const result = await call('shell', { command: command('flood.cjs'), timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32768);
    const outputEvents = events.filter(event => event.type === 'process.output');
    expect(outputEvents.length).toBeGreaterThan(0);
    expect(outputEvents.reduce((n, event) => n + Buffer.byteLength(event.data.chunk), 0)).toBeLessThanOrEqual(32768);
  });

  it('times out commands and kills their descendant process', async () => {
    await writeFile(path.join(workspace, 'child.cjs'), "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000)");
    await writeFile(path.join(workspace, 'parent.cjs'), "require('child_process').spawn(process.execPath, ['child.cjs'], {stdio:'inherit'}); setInterval(() => {}, 1000)");
    const result = await call('shell', { command: command('parent.cjs'), timeoutMs: 1500 });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/timed out/i);
    const pid = Number(await readFile(path.join(workspace, 'child.pid'), 'utf8'));
    await until(async () => { try { process.kill(pid, 0); return true; } catch { return false; } }, alive => !alive);
  });

  it('tracks background status per run and cancels all descendants', async () => {
    await writeFile(path.join(workspace, 'child.cjs'), "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000)");
    await writeFile(path.join(workspace, 'parent.cjs'), "require('child_process').spawn(process.execPath, ['child.cjs'], {stdio:'inherit'}); console.log('ready'); setInterval(() => {}, 1000)");
    const started = await call('shell', { command: command('parent.cjs'), background: true });
    expect(started.ok).toBe(true);
    expect(started.backgroundId).toBeTruthy();
    const id = started.backgroundId!;
    await until(() => status(id), value => value.output.includes('ready'));
    const wrongRun = await registry.execute('process_status', { id }, { ...context, runId: 'other-run' });
    expect(wrongRun.ok).toBe(false);
    const wrongCancel = await registry.execute('process_cancel', { id }, { ...context, runId: 'other-run' });
    expect(wrongCancel.ok).toBe(false);
    const pid = await until(async () => { try { return Number(await readFile(path.join(workspace, 'child.pid'), 'utf8')); } catch { return 0; } }, value => value > 0);
    expect((await call('process_cancel', { id })).ok).toBe(true);
    expect((await status(id)).status).toBe('cancelled');
    await until(async () => { try { process.kill(pid, 0); return true; } catch { return false; } }, alive => !alive);
  });

  it('cancelAll cancels just the requested run', async () => {
    await writeFile(path.join(workspace, 'wait.cjs'), "console.log('ready'); setInterval(() => {}, 1000)");
    const first = await call('shell', { command: command('wait.cjs'), background: true });
    const second = await registry.execute('shell', { command: command('wait.cjs'), background: true }, { ...context, runId: 'other-run' });
    await registry.cancelAll?.(context.runId);
    expect((await call('process_status', { id: first.backgroundId })).ok).toBe(false);
    const other = await registry.execute('process_status', { id: second.backgroundId }, { ...context, runId: 'other-run' });
    expect(JSON.parse(other.output).status).toBe('running');
  });

  it('honors active and already-aborted signals', async () => {
    await writeFile(path.join(workspace, 'wait.cjs'), "console.log('ready'); setInterval(() => {}, 1000)");
    const controller = new AbortController();
    const started = await registry.execute('shell', { command: command('wait.cjs'), background: true }, { ...context, signal: controller.signal });
    await until(() => status(started.backgroundId!), value => value.output.includes('ready'));
    controller.abort();
    await until(() => status(started.backgroundId!), value => value.status === 'cancelled');
    const blocked = await registry.execute('shell', { command: command('wait.cjs') }, { ...context, signal: controller.signal });
    expect(blocked.ok).toBe(false);
  });

  it('still cleans up when the event consumer throws', async () => {
    context.emit = () => { throw new Error('consumer gone'); };
    await writeFile(path.join(workspace, 'ok.cjs'), "console.log('done')");
    expect((await call('shell', { command: command('ok.cjs') })).ok).toBe(true);
  });

  it('returns a local tracked git diff including staged and unstaged changes', async () => {
    await exec('git', ['init', '-q', workspace]);
    await writeFile(path.join(workspace, 'a.txt'), 'before\n');
    await exec('git', ['add', 'a.txt'], { cwd: workspace });
    await exec('git', ['-c', 'user.name=Tools Test', '-c', 'user.email=tools@example.invalid', 'commit', '-qm', 'fixture'], { cwd: workspace });
    await writeFile(path.join(workspace, 'a.txt'), 'after\n');
    const diff = await call('git_diff', {});
    expect(diff.ok).toBe(true);
    expect(diff.output).toContain('-before');
    expect(diff.output).toContain('+after');
    await exec('git', ['add', 'a.txt'], { cwd: workspace });
    expect((await call('git_diff', {})).output).toContain('+after');
  });
  it('cleans up descendants when their launching command exits', async () => {
    await writeFile(path.join(workspace, 'orphan.cjs'), "require('fs').writeFileSync('orphan.pid', String(process.pid)); setInterval(() => {}, 1000)");
    await writeFile(path.join(workspace, 'exit.cjs'), "const child=require('child_process').spawn(process.execPath, ['orphan.cjs'], {stdio:'ignore'}); child.unref(); setTimeout(() => process.exit(0), 500)");
    let pid = 0;
    try {
      const result = await call('shell', { command: command('exit.cjs') });
      expect(result.ok).toBe(true);
      pid = Number(await readFile(path.join(workspace, 'orphan.pid'), 'utf8'));
      await until(async () => { try { process.kill(pid, 0); return true; } catch { return false; } }, alive => !alive);
    } finally { if (pid) await killProcessTree(pid); }
  });

  it('redacts credentials split across output chunks while allowing progress updates', async () => {
    const previous = process.env.TOOLS_API_KEY;
    process.env.TOOLS_API_KEY = 'fixture-private-credential-123';
    const events: string[] = [];
    context.emit = (type, data: any) => { if (type === 'process.output') events.push(data.chunk); };
    try {
      await writeFile(path.join(workspace, 'split.cjs'), "process.stdout.write('ready\\nfixture-private-'); setTimeout(() => process.stdout.write('credential-123\\n'), 100)");
      const result = await call('shell', { command: command('split.cjs') });
      expect(result.ok).toBe(true);
      expect(result.output).toContain('ready');
      expect(result.output).toContain('[REDACTED]');
      expect(result.output).not.toContain('fixture-private');
      expect(events.join('')).not.toContain('fixture-private');
    } finally {
      if (previous === undefined) delete process.env.TOOLS_API_KEY;
      else process.env.TOOLS_API_KEY = previous;
    }
  });

  it('excludes tracked secret files from git diffs', async () => {
    await exec('git', ['init', '-q', workspace]);
    await writeFile(path.join(workspace, '.env'), 'PRIVATE_VALUE=never-expose');
    await writeFile(path.join(workspace, 'visible.txt'), 'visible addition');
    await exec('git', ['add', '.env', 'visible.txt'], { cwd: workspace });
    const diff = await call('git_diff', {});
    expect(diff.ok).toBe(true);
    expect(diff.output).toContain('visible addition');
    expect(diff.output).not.toContain('never-expose');
  });

});
