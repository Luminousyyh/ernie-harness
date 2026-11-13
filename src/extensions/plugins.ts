import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolContext } from '../contracts/index.js';
import type { ContextContribution, Dispose, ExtensionEvent, ExtensionStatus, ExtensionTool, HarnessPlugin, PluginAPI, PluginConfig, ValidationResult } from './types.js';
import { ComposableToolRegistry, namespaceToolName } from './registry.js';
import { boundedOperation, ExtensionRedactor } from './security.js';

type ContextHook = { id: string; provide: (context: ToolContext) => string | Promise<string> };
type ValidatorHook = { id: string; validate: (context: ToolContext) => ValidationResult | Promise<ValidationResult> };
interface Loaded { tools: ExtensionTool[]; plugin: HarnessPlugin; open: boolean; cleanups: Dispose[]; contexts: ContextHook[]; validators: ValidatorHook[]; events: Array<(event: ExtensionEvent) => void | Promise<void>>; controller: AbortController }
let importGeneration = 0;

export { definePlugin } from './sdk.js';

export class PluginManager {
  private readonly loaded = new Map<string, Loaded>();
  private readonly statuses = new Map<string, ExtensionStatus>();
  private closed = false;
  constructor(private readonly registry: ComposableToolRegistry, private readonly redactor: ExtensionRedactor, private readonly timeoutMs: number) {}
  inspect(): ExtensionStatus[] { return structuredClone([...this.statuses.values()]); }
  private safeContext(context: ToolContext, signal: AbortSignal): ToolContext {
    const emit = context.emit ? (type: string, data: unknown) => {
      try { context.emit!(this.redactor.clean(type, 128), JSON.parse(this.redactor.clean(JSON.stringify(data)))); }
      catch { /* Consumer failures and oversized data remain isolated. */ }
    } : undefined;
    return { ...context, signal, emit };
  }
  async loadConfigured(config: PluginConfig, workspace: string): Promise<void> {
    if (config.enabled === false) { this.statuses.set(config.id, { id: config.id, state: 'disabled', tools: [] }); return; }
    if (!config.trusted) { this.statuses.set(config.id, { id: config.id, state: 'blocked', tools: [], error: 'Trusted in-process execution must be explicitly enabled' }); return; }
    try {
      const entry = await realpath(path.resolve(workspace, config.path));
      if (!/\.(?:mjs|cjs|js)$/.test(entry) || !(await stat(entry)).isFile()) throw new Error();
      const url = pathToFileURL(entry); url.searchParams.set('extensionGeneration', String(++importGeneration));
      const module = await boundedOperation(() => import(url.href), this.timeoutMs);
      if (module.default?.id !== config.id) throw new Error();
      await this.load(module.default);
    } catch { if (!this.loaded.has(config.id)) this.statuses.set(config.id, { id: config.id, state: 'failed', tools: [], error: 'Plugin loading failed' }); }
  }
  async load(plugin: HarnessPlugin): Promise<void> {
    if (this.closed) throw new Error('Plugin manager is closed');
    if (plugin?.apiVersion !== 1) throw new Error('Unsupported plugin API version');
    if (!/^(?!.*__)[a-z][a-z0-9_-]{0,19}$/.test(plugin.id) || typeof plugin.register !== 'function') throw new Error('Invalid plugin');
    if (this.loaded.has(plugin.id)) throw new Error('Duplicate plugin ID');
    const owner = `plugin:${plugin.id}`;
    const state: Loaded = { tools: [], plugin, open: true, cleanups: [], contexts: [], validators: [], events: [], controller: new AbortController() };
    this.loaded.set(plugin.id, state);
    this.statuses.set(plugin.id, { id: plugin.id, state: 'connecting', tools: [] });
    const ensureOpen = () => { if (!state.open || this.closed) throw new Error('Plugin registration handle is closed'); };
    const contributionId = (id: string) => { if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid plugin contribution ID'); };
    const api: PluginAPI = Object.freeze({
      apiVersion: 1 as const,
      registerTool: (tool: Parameters<PluginAPI['registerTool']>[0]) => {
        ensureOpen();
        const name = namespaceToolName('plugin', plugin.id, tool.name);
        if (state.tools.length >= 128 || state.tools.some(item => item.name === name)) throw new Error('Duplicate extension tool name or plugin tool limit');
        const contribution = { ...tool, name };
        if (this.statuses.get(plugin.id)?.state === 'loaded') this.registry.register(owner, contribution);
        state.tools.push(contribution);
        if (this.statuses.get(plugin.id)?.state === 'loaded') this.statuses.get(plugin.id)!.tools.push(name);
      },
      addContext: (id: string, provide: ContextHook['provide']) => {
        ensureOpen(); contributionId(id);
        if (typeof provide !== 'function' || state.contexts.some(value => value.id === id) || state.contexts.length >= 64) throw new Error('Duplicate or invalid plugin context contribution');
        state.contexts.push({ id, provide });
      },
      addValidator: (id: string, validate: ValidatorHook['validate']) => {
        ensureOpen(); contributionId(id);
        if (typeof validate !== 'function' || state.validators.some(value => value.id === id) || state.validators.length >= 64) throw new Error('Duplicate or invalid plugin validator contribution');
        state.validators.push({ id, validate });
      },
      onEvent: (handler: Loaded['events'][number]) => { ensureOpen(); if (typeof handler !== 'function' || state.events.length >= 64) throw new Error('Invalid plugin event handler'); state.events.push(handler); },
    });
    try {
      const registration = Promise.resolve().then(() => plugin.register(api));
      registration.then(cleanup => { if (typeof cleanup === 'function') { if (state.open) state.cleanups.push(cleanup); else void this.cleanup(cleanup); } }, () => undefined);
      await boundedOperation(() => registration, this.timeoutMs, state.controller.signal);
      if (!state.open) throw new Error();
      this.registry.replaceOwner(owner, state.tools);
      this.statuses.set(plugin.id, { id: plugin.id, state: 'loaded', tools: state.tools.map(tool => tool.name) });
    } catch {
      await this.remove(plugin.id, 'failed', state);
      throw new Error('Plugin registration failed');
    }
  }
  private async cleanup(dispose: Dispose): Promise<void> { try { await boundedOperation(() => dispose(), this.timeoutMs); } catch { /* Every remaining cleanup still runs. */ } }
  private async remove(id: string, status: 'failed' | 'disposed', expected?: Loaded): Promise<void> {
    const state = this.loaded.get(id);
    if (!state || (expected && state !== expected)) return;
    state.open = false;
    state.controller.abort();
    this.registry.unregisterOwner(`plugin:${id}`);
    this.loaded.delete(id);
    this.statuses.set(id, { id, state: status, tools: [], ...(status === 'failed' ? { error: 'Plugin registration failed' } : {}) });
    for (const dispose of state.cleanups.reverse()) await this.cleanup(dispose);
    if (state.plugin.dispose) await this.cleanup(() => state.plugin.dispose!());
    state.tools = []; state.contexts = []; state.validators = []; state.events = [];
  }
  async unload(id: string): Promise<void> { await this.remove(id, 'disposed'); }
  async collectContext(context: ToolContext): Promise<ContextContribution[]> {
    const output: ContextContribution[] = [];
    for (const [id, state] of this.loaded) for (const hook of state.contexts) {
      if (!state.open || this.statuses.get(id)?.state !== 'loaded') continue;
      try {
        const signal = AbortSignal.any([state.controller.signal, ...(context.signal ? [context.signal] : [])]);
        const content = await boundedOperation(current => hook.provide(this.safeContext(context, current)), this.timeoutMs, signal);
        if (state.open && typeof content === 'string') output.push({ content: this.redactor.clean(content, 16 * 1024), trust: 'untrusted', source: { kind: 'plugin', scope: 'plugin', label: `plugin:${id}:${hook.id}` } });
      } catch { /* A context hook cannot prevent the rest of the run. */ }
    }
    return output;
  }
  async validate(context: ToolContext): Promise<ValidationResult[]> {
    const output: ValidationResult[] = [];
    for (const [id, state] of this.loaded) for (const hook of state.validators) {
      if (!state.open || this.statuses.get(id)?.state !== 'loaded') continue;
      const source = `plugin:${id}:${hook.id}`;
      try {
        const signal = AbortSignal.any([state.controller.signal, ...(context.signal ? [context.signal] : [])]);
        const result = await boundedOperation(current => hook.validate(this.safeContext(context, current)), this.timeoutMs, signal);
        if (typeof result.ok !== 'boolean' || !Array.isArray(result.messages)) throw new Error();
        output.push({ ok: result.ok, messages: result.messages.slice(0, 32).map(message => this.redactor.clean(String(message), 2048)), source });
      } catch { output.push({ ok: false, messages: ['Plugin validator failed'], source }); }
    }
    return output;
  }
  async emitEvent(event: ExtensionEvent): Promise<void> {
    for (const [id, state] of this.loaded) for (const handler of state.events) {
      if (!state.open || this.statuses.get(id)?.state !== 'loaded') continue;
      try {
        const safe = JSON.parse(this.redactor.clean(JSON.stringify(event))) as ExtensionEvent;
        const signal = AbortSignal.any([state.controller.signal, ...(event.signal ? [event.signal] : [])]);
        await boundedOperation(current => handler({ ...safe, signal: current }), this.timeoutMs, signal);
      } catch { /* Extension event observers are isolated. */ }
    }
  }
  async dispose(): Promise<void> { this.closed = true; for (const id of [...this.loaded.keys()].reverse()) await this.unload(id); }
}
