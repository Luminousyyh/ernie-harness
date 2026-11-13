import { createHash } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { ToolContext, ToolDefinition, ToolRegistry, ToolResult } from '../contracts/index.js';
import type { ExtensionTool } from './types.js';
import { abortError, boundedOperation, canonicalWorkspace, ExtensionRedactor, MAX_OUTPUT_BYTES } from './security.js';

interface Entry { owner: string; tool: ExtensionTool; definition: ToolDefinition; validate: (value: unknown) => { valid: boolean } }
interface ActiveCall { owner: string; runId: string; controller: AbortController }
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function namespaceToolName(kind: 'mcp' | 'plugin', id: string, localName: string): string {
  if (!/^(?!.*__)[a-z][a-z0-9_-]{0,19}$/.test(id) || !/^[A-Za-z0-9_.-]{1,128}$/.test(localName)) throw new Error('Invalid extension tool namespace');
  const prefix = `${kind}_${id}__`;
  if (TOOL_NAME.test(localName) && prefix.length + localName.length <= 64) return prefix + localName;
  const digest = createHash('sha256').update(localName).digest('hex').slice(0, 12);
  return prefix + localName.replaceAll('.', '_').slice(0, 64 - prefix.length - 13) + '_' + digest;
}
function boundedJson(value: unknown, maxBytes: number, schemaOnly = false): void {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > maxBytes) throw new Error('Extension JSON exceeds its allowed size');
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32 || ++nodes > 10000) throw new Error('Extension JSON exceeds structural limits');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe extension JSON key');
      if (schemaOnly && (key === '$ref' || key === '$dynamicRef') && typeof child === 'string' && !child.startsWith('#')) throw new Error('External JSON schema references are not supported');
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

/** All execution still crosses the caller's normal engine permission/journal boundary. */
export class ComposableToolRegistry implements ToolRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Set<ActiveCall>();
  private workspace?: string;
  private closed = false;
  constructor(private readonly base?: ToolRegistry, private readonly options: { timeoutMs?: number; redactor?: ExtensionRedactor } = {}) {}
  private get redactor(): ExtensionRedactor { return this.options.redactor ?? new ExtensionRedactor(); }
  bindWorkspace(workspace: string): void { this.workspace = workspace; }
  private prepare(owner: string, contribution: ExtensionTool): Entry {
    if (this.closed) throw new Error('Extension registry is closed');
    if (!owner || !TOOL_NAME.test(contribution.name) || typeof contribution.execute !== 'function' || typeof contribution.description !== 'string' || contribution.description.length > 8192) throw new Error('Invalid extension tool');
    const schema = structuredClone(contribution.inputSchema);
    boundedJson(schema, MAX_OUTPUT_BYTES, true);
    if (schema.type !== 'object') throw new Error('Extension tools require object input schemas');
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    return { owner, tool: { ...contribution, inputSchema: schema }, validate, definition: { type: 'function', function: { name: contribution.name, description: this.redactor.clean(contribution.description, 8192), parameters: schema } } };
  }
  register(owner: string, tool: ExtensionTool): () => void {
    const entry = this.prepare(owner, tool);
    if (this.entries.has(tool.name) || this.base?.definitions().some(definition => definition.function.name === tool.name)) throw new Error('Duplicate extension tool name');
    this.entries.set(tool.name, entry);
    return () => { if (this.entries.get(tool.name) === entry) { this.entries.delete(tool.name); this.cancelOwner(owner); } };
  }
  /** Validates the entire batch before replacing any live contribution. */
  replaceOwner(owner: string, tools: ExtensionTool[]): void {
    const entries = tools.map(tool => this.prepare(owner, tool));
    const names = new Set<string>();
    for (const entry of entries) {
      const name = entry.tool.name;
      if (names.has(name) || (this.entries.has(name) && this.entries.get(name)!.owner !== owner) || this.base?.definitions().some(definition => definition.function.name === name)) throw new Error('Duplicate extension tool name');
      names.add(name);
    }
    this.unregisterOwner(owner);
    for (const entry of entries) this.entries.set(entry.tool.name, entry);
  }
  unregisterOwner(owner: string): void {
    this.cancelOwner(owner);
    for (const [name, entry] of this.entries) if (entry.owner === owner) this.entries.delete(name);
  }
  private cancelOwner(owner: string): void { for (const call of this.active) if (call.owner === owner) call.controller.abort(); }
  definitions(): ToolDefinition[] {
    const base = this.base?.definitions() ?? [];
    const names = new Set<string>();
    for (const definition of [...base, ...[...this.entries.values()].map(entry => entry.definition)]) {
      if (names.has(definition.function.name)) throw new Error('Duplicate registry tool name');
      names.add(definition.function.name);
    }
    return structuredClone([...base, ...[...this.entries.values()].map(entry => entry.definition)]);
  }
  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const entry = this.entries.get(name);
    if (!entry) {
      if (this.base?.definitions().some(definition => definition.function.name === name)) return this.base.execute(name, args, context);
      return { ok: false, output: 'Unknown extension tool' };
    }
    const controller = new AbortController();
    const active: ActiveCall = { owner: entry.owner, runId: context.runId, controller };
    this.active.add(active);
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (this.closed) throw new Error('Extension registry is closed');
      abortError(context.signal);
      if (typeof context.runId !== 'string' || !context.runId || this.active.size > 64) throw new Error('Invalid extension execution context or concurrency limit');
      if (this.workspace && await canonicalWorkspace(context.workspace) !== this.workspace) throw new Error('Extension tool workspace mismatch');
      if (this.base?.definitions().some(definition => definition.function.name === name)) throw new Error('Duplicate registry tool name');
      boundedJson(args, MAX_OUTPUT_BYTES);
      if (!entry.validate(args).valid) throw new Error('Invalid extension tool arguments');
      const emit = context.emit ? (type: string, data: unknown) => {
        try { context.emit!(this.redactor.clean(type, 128), JSON.parse(this.redactor.clean(JSON.stringify(data)))); } catch { /* Consumer or serialization failure cannot take ownership away. */ }
      } : undefined;
      const result = await boundedOperation(signal => entry.tool.execute(structuredClone(args), { ...context, signal, emit }), this.options.timeoutMs ?? 30000, controller.signal);
      if (typeof result?.ok !== 'boolean' || typeof result.output !== 'string') throw new Error('Invalid extension tool result');
      const output = this.redactor.clean(result.output);
      return { ok: result.ok, output, ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts.slice(0, 64).map(value => this.redactor.clean(value, 4096)) } : {}),
        ...(result.backgroundId ? { backgroundId: this.redactor.clean(result.backgroundId, 256) } : {}),
        ...(result.truncated || Buffer.byteLength(result.output) > MAX_OUTPUT_BYTES ? { truncated: true } : {}) };
    } catch (error) {
      // Errors from arbitrary extension code may contain request headers or credentials.
      const message = error instanceof Error && /^(?:Extension operation (?:cancelled|timed out)|Invalid extension |Extension tool workspace mismatch|Duplicate registry|Extension registry)/.test(error.message) ? error.message : 'Extension tool failed; effects may be uncertain';
      return { ok: false, output: this.redactor.clean(message) };
    } finally { this.active.delete(active); context.signal?.removeEventListener('abort', abort); }
  }
  async cancelAll(runId: string): Promise<void> {
    for (const call of this.active) if (call.runId === runId) call.controller.abort();
    await this.base?.cancelAll?.(runId);
  }
  dispose(): void { this.closed = true; for (const call of this.active) call.controller.abort(); this.entries.clear(); }
}
