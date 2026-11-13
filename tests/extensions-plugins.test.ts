import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExtensionHost, definePlugin } from '../src/extensions/index.js';
import type { PluginAPI } from '../src/extensions/index.js';

let workspace: string;
let instance: ExtensionHost;
beforeEach(async () => { workspace = await mkdtemp(path.join(tmpdir(), 'ernie-plugin-')); instance = new ExtensionHost({ enabled: true, timeoutMs: 100 }); await instance.start(workspace); });
afterEach(async () => { await instance.dispose(); await rm(workspace, { recursive: true, force: true }); });
const context = () => ({ workspace, runId: 'plugins' });
const tool = { name: 'hello', description: 'Hello', inputSchema: { type: 'object', additionalProperties: false }, execute: async () => ({ ok: true, output: 'hello' }) };

it('supports versioned tool/context/validator/event contributions and unload cleanup', async () => {
  const events: string[] = []; let disposed = 0;
  await instance.loadPlugin(definePlugin({ apiVersion: 1, id: 'demo', register(api) {
    api.registerTool(tool);
    api.addContext('guide', async () => 'guide content');
    api.addValidator('quality', async () => ({ ok: false, messages: ['quality failed'] }));
    api.onEvent(event => { events.push(event.type); });
    return () => { disposed++; };
  }, dispose() { disposed++; } }));
  expect((await instance.registry.execute('plugin_demo__hello', {}, context())).output).toBe('hello');
  expect((await instance.collectContext(context())).some(item => item.content === 'guide content' && item.source.kind === 'plugin')).toBe(true);
  expect((await instance.validate(context())).some(item => !item.ok && item.messages.includes('quality failed'))).toBe(true);
  await instance.emitEvent({ type: 'run.started', data: {}, ...context() }); expect(events).toEqual(['run.started']);
  await instance.unloadPlugin('demo');
  expect(disposed).toBe(2);
  expect(instance.registry.definitions().some(definition => definition.function.name.startsWith('plugin_'))).toBe(false);
  expect(await instance.validate(context())).toEqual([]);
  await instance.emitEvent({ type: 'run.ended', data: {}, ...context() }); expect(events).toHaveLength(1);
});

it('rolls back partial contributions, closes registration handles and calls dispose on failure', async () => {
  let apiHandle: PluginAPI | undefined; let disposed = false;
  await expect(instance.loadPlugin({ apiVersion: 1, id: 'broken', register(api) {
    apiHandle = api; api.registerTool(tool); api.addContext('partial', () => 'partial'); throw new Error('secret runtime failure');
  }, dispose() { disposed = true; } })).rejects.toThrow(/registration failed/i);
  expect(disposed).toBe(true);
  expect(instance.registry.definitions().map(value => value.function.name)).toEqual(['invoke_skill']);
  expect(() => apiHandle!.registerTool(tool)).toThrow(/closed/i);
  expect((await instance.collectContext(context())).some(item => item.content === 'partial')).toBe(false);
  expect(JSON.stringify(instance.inspect())).not.toContain('secret runtime failure');
});

it('rejects version mismatch, duplicate tools and duplicate plugin IDs atomically', async () => {
  await expect(instance.loadPlugin({ apiVersion: 2, id: 'v2', register() {} } as never)).rejects.toThrow(/version/i);
  await expect(instance.loadPlugin({ apiVersion: 1, id: 'dup', register(api) { api.registerTool(tool); api.registerTool(tool); } })).rejects.toThrow();
  expect(instance.registry.definitions()).toHaveLength(1);
  const plugin = definePlugin({ apiVersion: 1, id: 'good', register(api) { api.registerTool(tool); } });
  await instance.loadPlugin(plugin);
  await expect(instance.loadPlugin(plugin)).rejects.toThrow(/duplicate/i);
  expect(instance.registry.definitions().filter(definition => definition.function.name === 'plugin_good__hello')).toHaveLength(1);
});

it('aborts extension calls on timeout, cancellation and unload without replay', async () => {
  let calls = 0; let aborted = 0; const beginnings=new Map<number,()=>void>();const started=(n:number)=>new Promise<void>(resolve=>{if(calls>=n)resolve();else beginnings.set(n,resolve);});
  await instance.loadPlugin({ apiVersion: 1, id: 'slow', register(api) {
    api.registerTool({ ...tool, execute: async (_args, ctx) => { calls++; beginnings.get(calls)?.(); return new Promise(resolve => {
      ctx.signal!.addEventListener('abort', () => { aborted++; resolve({ ok: false, output: 'cancelled' }); }, { once: true });
    }); } });
  } });
  const timed = await instance.registry.execute('plugin_slow__hello', {}, context());
  expect(timed.ok).toBe(false); expect(timed.output).toMatch(/timed out/i);
  const pending = instance.registry.execute('plugin_slow__hello', {}, context());
  await started(2); await instance.registry.cancelAll!('plugins');
  expect((await pending).ok).toBe(false);
  const unloading = instance.registry.execute('plugin_slow__hello', {}, context());
  await started(3); await instance.unloadPlugin('slow');
  expect((await unloading).ok).toBe(false); expect(calls).toBe(3); expect(aborted).toBe(3);
});

it('requires explicit trusted configuration before evaluating modules', async () => {
  const entry = path.join(workspace, 'plugin.mjs');
  await writeFile(entry, 'throw new Error("must not evaluate")');
  const untrusted = new ExtensionHost({ enabled: true, plugins: [{ id: 'blocked', path: entry }] });
  try {
    await untrusted.start(workspace);
    expect(untrusted.inspect().plugins[0].state).toBe('blocked');
    expect(JSON.stringify(untrusted.inspect())).not.toContain('must not evaluate');
  } finally { await untrusted.dispose(); }
  await writeFile(entry, 'export default { apiVersion: 1, id: "configured", register(api) { api.registerTool({ name: "example", description: "Example", inputSchema: { type: "object" }, execute: async () => ({ ok: true, output: "loaded" }) }); } };');
  const trusted = new ExtensionHost({ enabled: true, plugins: [{ id: 'configured', path: entry, trusted: true }] });
  try {
    await trusted.start(workspace);
    expect((await trusted.registry.execute('plugin_configured__example', {}, context())).ok).toBe(true);
  } finally { await trusted.dispose(); }
});

it('isolates throwing hooks and prevents cross-workspace use', async () => {
  await instance.loadPlugin({ apiVersion: 1, id: 'hooks', register(api) {
    api.registerTool(tool); api.addContext('bad', () => { throw new Error('sensitive'); });
    api.addValidator('bad', () => { throw new Error('sensitive'); }); api.onEvent(() => { throw new Error('sensitive'); });
  } });
  expect(await instance.collectContext(context())).toEqual([]);
  expect((await instance.validate(context()))[0].ok).toBe(false);
  await expect(instance.emitEvent({ ...context(), type: 'x', data: {} })).resolves.toBeUndefined();
  const outside = path.join(workspace, 'other'); await mkdir(outside);
  expect((await instance.registry.execute('plugin_hooks__hello', {}, { workspace: outside, runId: 'outside' })).ok).toBe(false);
});

it('revokes late registration handles and still disposes cleanup returned after a timeout', async () => {
  let apiHandle: PluginAPI | undefined; let cleanup = 0; let finalDispose = 0;
  await expect(instance.loadPlugin({ apiVersion: 1, id: 'late', async register(api) {
    apiHandle = api; api.registerTool(tool);
    await new Promise(resolve => setTimeout(resolve, 160));
    return () => { cleanup++; };
  }, dispose() { finalDispose++; } })).rejects.toThrow(/registration failed/i);
  expect(() => apiHandle!.addContext('late', () => 'late')).toThrow(/closed/i);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(cleanup).toBe(1); expect(finalDispose).toBe(1);
  expect(instance.registry.definitions()).toHaveLength(1);
});

it('runs all cleanup despite a throwing disposer and ignores a pre-aborted call', async () => {
  let disposed = false; let calls = 0;
  await instance.loadPlugin({ apiVersion: 1, id: 'cleanup', register(api) {
    api.registerTool({ ...tool, execute: () => { calls++; return { ok: true, output: 'called' }; } });
    return () => { throw new Error('private cleanup error'); };
  }, dispose() { disposed = true; } });
  const controller = new AbortController(); controller.abort();
  expect((await instance.registry.execute('plugin_cleanup__hello', {}, { ...context(), signal: controller.signal })).ok).toBe(false);
  expect(calls).toBe(0); await instance.unloadPlugin('cleanup'); expect(disposed).toBe(true);
});

it('redacts plugin tool output, hook output and emitted data', async () => {
  const name = 'ERNIE_PLUGIN_FIXTURE_SECRET'; const previous = process.env[name];
  process.env[name] = 'test-only-plugin-runtime-secret';
  const secure = new ExtensionHost({ enabled: true });
  try {
    await secure.start(workspace);
    await secure.loadPlugin({ apiVersion: 1, id: 'secrets', register(api) {
      api.registerTool({ ...tool, execute: (_args, ctx) => { ctx.emit?.('plugin.event', { credential: process.env[name] }); return { ok: true, output: process.env[name]! }; } });
      api.addContext('secret', ctx => { ctx.emit?.('context.secret', { credential: process.env[name] }); return process.env[name]!; });
      api.addValidator('secret', ctx => { ctx.emit?.('validator.secret', { credential: process.env[name] }); return { ok: false, messages: [process.env[name]!] }; });
    } });
    const events: unknown[] = [];
    expect((await secure.registry.execute('plugin_secrets__hello', {}, { ...context(), emit: (_type, data) => events.push(data) })).output).toBe('[REDACTED]');
    expect(JSON.stringify(events)).not.toContain(process.env[name]);
    expect(JSON.stringify(await secure.collectContext({ ...context(), emit: (_type, data) => events.push(data) }))).not.toContain(process.env[name]);
    expect(JSON.stringify(await secure.validate({ ...context(), emit: (_type, data) => events.push(data) }))).not.toContain(process.env[name]);
    expect(JSON.stringify(events)).not.toContain(process.env[name]);
  } finally {
    await secure.dispose(); if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
});

it('redacts credentials introduced or rotated after host construction', async () => {
  const key = 'ERNIE_ROTATING_FIXTURE_TOKEN'; const previous = process.env[key];
  try {
    await instance.loadPlugin({ apiVersion: 1, id: 'rotation', register(api) {
      api.registerTool({ ...tool, execute: () => ({ ok: true, output: process.env[key]! }) });
    } });
    process.env[key] = 'test-only-rotated-runtime-token';
    expect((await instance.registry.execute('plugin_rotation__hello', {}, context())).output).toBe('[REDACTED]');
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});


it('does not let a stale failed registration unload a replacement with the same ID', async () => {
  const { PluginManager } = await import('../src/extensions/plugins.js');
  const { ComposableToolRegistry } = await import('../src/extensions/registry.js');
  const { ExtensionRedactor } = await import('../src/extensions/security.js');
  const registry = new ComposableToolRegistry();
  const manager = new PluginManager(registry, new ExtensionRedactor(), 100);
  try {
    const first = manager.load({ apiVersion: 1, id: 'replace', async register(api) { api.registerTool(tool); await new Promise(() => undefined); } }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 10));
    const removing = manager.unload('replace');
    const replacement = manager.load({ apiVersion: 1, id: 'replace', register(api) { api.registerTool({ ...tool, name: 'replacement' }); } });
    await Promise.all([first, removing, replacement]);
    expect(registry.definitions().map(value => value.function.name)).toEqual(['plugin_replace__replacement']);
  } finally { await manager.dispose(); }
});
