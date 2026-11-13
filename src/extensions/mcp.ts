import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError, type Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { ExtensionStatus, ExtensionTool, McpServerConfig } from './types.js';
import { ComposableToolRegistry, namespaceToolName } from './registry.js';
import { boundedOperation, boundedPath, ExtensionRedactor, scrubMcpEnvironment } from './security.js';

interface Connection { client: Client; transport: Transport; config: McpServerConfig; controller: AbortController }

/** Official SDK transports only. Configured servers are capabilities, never inferred from skill prose. */
export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private readonly statuses = new Map<string, ExtensionStatus>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly connecting = new Map<string, AbortController>();
  private closed = false;
  constructor(private readonly registry: ComposableToolRegistry, private readonly configs: McpServerConfig[], private readonly redactor: ExtensionRedactor) {
    for (const config of configs) this.statuses.set(config.id, { id: config.id, state: 'disabled', tools: [] });
  }
  inspect(): ExtensionStatus[] { return structuredClone([...this.statuses.values()]); }
  async connect(id: string, workspace: string): Promise<void> {
    if (this.closed) throw new Error('MCP manager is closed');
    const existing = this.pending.get(id);
    if (existing) return existing;
    const config = this.configs.find(value => value.id === id);
    if (!config) throw new Error('Unknown configured MCP server');
    if (config.enabled === false || this.connections.has(id)) return;
    const operation = this.open(config, workspace);
    this.pending.set(id, operation);
    try { await operation; } finally { this.pending.delete(id); }
  }
  private async open(config: McpServerConfig, workspace: string): Promise<void> {
    const id = config.id;
    const controller = new AbortController();
    this.connecting.set(id, controller);
    this.statuses.set(id, { id, state: 'connecting', tools: [] });
    let transport: Transport | undefined;
    let client: Client | undefined;
    try {
      if (config.transport === 'stdio') {
        for (const source of Object.values(config.envFrom ?? {})) this.redactor.add(process.env[source]);
        const env = scrubMcpEnvironment(config.envFrom);
        const cwd = config.cwd ? await boundedPath(workspace, config.cwd) : workspace;
        transport = new StdioClientTransport({ command: config.command, args: config.args ?? [], cwd, env, stderr: 'ignore' });
      } else {
        const token = config.bearerTokenEnv ? process.env[config.bearerTokenEnv] : undefined;
        if (config.bearerTokenEnv && !token) throw new Error('Configured MCP credential is unavailable');
        this.redactor.add(token);
        const url = new URL(config.url);
        transport = new StreamableHTTPClientTransport(url, {
          requestInit: { redirect: 'error', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) },
          fetch: (input, init) => {
            const destination = new URL(input);
            if (destination.origin !== url.origin) return Promise.reject(new Error('MCP HTTP origin change is forbidden'));
            return fetch(input, { ...init, redirect: 'error' });
          },
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        });
      }
      client = new Client({ name: 'ernie-harness-extensions', version: '1.0.0' }, { capabilities: {} });
      const connection: Connection = { config, transport, client, controller };
      client.onerror = () => { /* Never send server-provided errors or headers to logs. */ };
      client.onclose = () => {
        if (this.connections.get(id) === connection) {
          this.connections.delete(id); this.registry.unregisterOwner(`mcp:${id}`);
          this.statuses.set(id, { id, state: 'failed', tools: [], error: 'MCP connection closed; effects of pending calls may be uncertain' });
        }
      };
      const timeout = config.timeoutMs ?? 30_000;
      await boundedOperation(signal => client!.connect(transport!, { signal, timeout, maxTotalTimeout: timeout }), timeout, controller.signal);
      if (this.closed) throw new Error();
      this.connections.set(id, connection);
      await this.listTools(id);
      this.statuses.set(id, { id, state: 'connected', tools: this.statuses.get(id)?.tools ?? [] });
    } catch {
      this.connections.delete(id);
      this.registry.unregisterOwner(`mcp:${id}`);
      controller.abort();
      try { if (client) await boundedOperation(() => client!.close(), 6000); else if (transport) await boundedOperation(() => transport!.close(), 6000); } catch { /* Keep cleanup bounded. */ }
      this.statuses.set(id, { id, state: this.closed ? 'disposed' : 'failed', tools: [], error: 'MCP connection or tool discovery failed' });
    } finally { this.connecting.delete(id); }
  }
  async listTools(id: string): Promise<string[]> {
    const connection = this.connections.get(id);
    if (!connection) throw new Error('MCP server is not connected');
    const timeout = connection.config.timeoutMs ?? 30_000;
    const tools: McpTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 8) throw new Error('MCP tool listing exceeded page limit');
      const result = await boundedOperation(signal => connection.client.listTools(cursor ? { cursor } : undefined, { signal, timeout, maxTotalTimeout: timeout }), timeout, connection.controller.signal);
      tools.push(...result.tools);
      if (tools.length > 128) throw new Error('MCP tool listing exceeded tool limit');
      if (!result.nextCursor) break;
      if (cursors.has(result.nextCursor)) throw new Error('MCP repeated listing cursor');
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    const contributions: ExtensionTool[] = tools.map(tool => ({
      name: namespaceToolName('mcp', id, tool.name),
      description: this.redactor.clean(tool.description ?? `MCP tool ${tool.name}`, 8192),
      inputSchema: structuredClone(tool.inputSchema),
      execute: async (args, context) => {
        const result = await connection.client.callTool({ name: tool.name, arguments: args }, undefined, { signal: context.signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false }).catch(error => {
          if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw new Error('Extension operation timed out; effects may be uncertain');
          throw error;
        });
        const text = Array.isArray(result.content) ? result.content.map(item => {
          if (item.type === 'text' && typeof item.text === 'string') return item.text;
          if (item.type === 'resource_link') return JSON.stringify({ type: item.type, name: item.name, uri: item.uri });
          return `[MCP ${item.type} content omitted]`;
        }).join('\n') : '';
        return { ok: result.isError !== true, output: this.redactor.clean(text || JSON.stringify(result.structuredContent ?? {})) };
      },
    }));
    if (this.closed || connection.controller.signal.aborted || this.connections.get(id) !== connection) throw new Error('MCP connection is no longer active');
    this.registry.replaceOwner(`mcp:${id}`, contributions);
    const names = contributions.map(tool => tool.name);
    const status = this.statuses.get(id);
    if (status) status.tools = names;
    return names;
  }
  async disconnect(id: string): Promise<void> {
    this.connecting.get(id)?.abort();
    const pending = this.pending.get(id);
    if (pending) await pending;
    const connection = this.connections.get(id);
    this.connections.delete(id);
    this.registry.unregisterOwner(`mcp:${id}`);
    if (connection) {
      connection.controller.abort();
      try { await boundedOperation(() => connection.client.close(), 6000); } catch { /* A closed host retains no callable tools. */ }
    }
    if (this.statuses.has(id)) this.statuses.set(id, { id, state: 'disposed', tools: [] });
  }
  async dispose(): Promise<void> {
    this.closed = true;
    for (const controller of this.connecting.values()) controller.abort();
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.statuses.keys()].map(id => this.disconnect(id)));
  }
}
