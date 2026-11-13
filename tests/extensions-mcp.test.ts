import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ExtensionHost, scrubMcpEnvironment } from '../src/extensions/index.js';

let workspace: string;
const hosts: ExtensionHost[] = [];
const servers: Array<{ http: HttpServer; transport: StreamableHTTPServerTransport; sdk: Server }> = [];
const oldSecret = process.env.OPENROUTER_API_KEY;
const oldAuth = process.env.ERNIE_FIXTURE_AUTH;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'ernie-mcp-'));
  process.env.OPENROUTER_API_KEY = 'test-only-never-inherit-credential';
  process.env.ERNIE_FIXTURE_AUTH = 'test-only-runtime-auth-value';
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.dispose()));
  for (const server of servers.splice(0)) {
    await server.sdk.close(); await server.transport.close();
    server.http.closeAllConnections(); await new Promise<void>(resolve => server.http.close(() => resolve()));
  }
  if (oldSecret === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldSecret;
  if (oldAuth === undefined) delete process.env.ERNIE_FIXTURE_AUTH; else process.env.ERNIE_FIXTURE_AUTH = oldAuth;
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});
function context(signal?: AbortSignal) { return { workspace, runId: 'mcp', signal }; }
function stdio(timeoutMs = 5000) {
  const instance = new ExtensionHost({ enabled: true, timeoutMs, mcpServers: [{ id: 'local', transport: 'stdio', command: process.execPath, args: [path.resolve('examples/extensions/mcp-fixture.mjs')], envFrom: { FIXTURE_AUTH: 'ERNIE_FIXTURE_AUTH' }, timeoutMs: 5000 }] });
  hosts.push(instance); return instance;
}
async function httpFixture(duplicate = false) {
  let authorization: string | undefined;
  let calls = 0;
  const sdk = new Server({ name: 'local-http-fixture', version: '1' }, { capabilities: { tools: {} } });
  const tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
  sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: duplicate ? [tool, tool] : [tool] }));
  sdk.setRequestHandler(CallToolRequestSchema, async request => { calls++; return { content: [{ type: 'text', text: String(request.params.arguments!.text) }] }; });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  await sdk.connect(transport);
  const http = createServer(async (req, res) => {
    authorization = req.headers.authorization;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    try { await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined); }
    catch { if (!res.headersSent) res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  servers.push({ http, sdk, transport });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error();
  return { url: `http://127.0.0.1:${address.port}/mcp`, authorization: () => authorization, calls: () => calls };
}

it('scrubs all implicit secret/loader environment and only passes explicit runtime mappings', () => {
  const env = scrubMcpEnvironment({ FIXTURE_AUTH: 'AUTH_SOURCE' }, { PATH: 'safe-path', OPENROUTER_API_KEY: 'never', NODE_OPTIONS: '--require bad', LD_PRELOAD: 'bad', AUTH_SOURCE: 'runtime-only', RANDOM: 'not inherited' });
  expect(env).toEqual({ PATH: 'safe-path', FIXTURE_AUTH: 'runtime-only' });
  expect(() => scrubMcpEnvironment({ NODE_OPTIONS: 'AUTH_SOURCE' }, { AUTH_SOURCE: 'bad' })).toThrow();
});

describe('official SDK local stdio lifecycle', () => {
  it('connects, lists/translates schema, validates, calls, redacts and disposes', async () => {
    const instance = stdio(); await instance.start(workspace);
    expect(instance.inspect().mcpServers[0].state).toBe('connected');
    const definition = instance.registry.definitions().find(value => value.function.name === 'mcp_local__echo');
    expect(definition?.function.parameters.required).toEqual(['text']);
    expect((await instance.registry.execute('mcp_local__echo', { text: 'hello local SDK' }, context())).output).toContain('hello local SDK');
    expect((await instance.registry.execute('mcp_local__echo', { text: 2 }, context())).ok).toBe(false);
    const result = await instance.registry.execute('mcp_local__environment', {}, context());
    expect(result.ok).toBe(true);
    expect(result.output).toContain('"inheritedSecret":null'); expect(result.output).toContain('"nodeOptions":null');
    expect(result.output).toContain('[REDACTED]');
    expect(result.output).not.toContain(process.env.ERNIE_FIXTURE_AUTH);
    expect(JSON.stringify(instance.inspect())).not.toContain(process.env.ERNIE_FIXTURE_AUTH);
    await instance.dispose();
    expect(instance.registry.definitions()).toEqual([]);
    expect(instance.inspect().mcpServers[0].state).toBe('disposed');
    await instance.dispose();
  });

  it('cancels and times out SDK requests exactly once without replaying tools', async () => {
    const instance = stdio(150); await instance.start(workspace);
    const timed = await instance.registry.execute('mcp_local__slow', {}, context());
    expect(timed.ok).toBe(false); expect(timed.output).toMatch(/timed out/i);
    const controller = new AbortController();
    const pending = instance.registry.execute('mcp_local__slow', {}, context(controller.signal));
    await new Promise(resolve => setTimeout(resolve, 30)); controller.abort();
    expect((await pending).ok).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 60));
    const stats = await instance.registry.execute('mcp_local__stats', {}, context());
    expect(stats.ok).toBe(true);
    expect(JSON.parse(stats.output)).toEqual({ calls: 2, cancellations: 2 });
  });
});

it('uses Streamable HTTP on explicitly configured loopback and keeps authorization runtime-only', async () => {
  const fixture = await httpFixture();
  const instance = new ExtensionHost({ enabled: true, mcpServers: [{ id: 'http', transport: 'http', url: fixture.url, bearerTokenEnv: 'ERNIE_FIXTURE_AUTH' }] });
  hosts.push(instance); await instance.start(workspace);
  expect(instance.inspect().mcpServers[0].state).toBe('connected');
  const result = await instance.registry.execute('mcp_http__echo', { text: 'http fixture' }, context());
  expect(result.ok).toBe(true); expect(result.output).toBe('http fixture');
  expect(fixture.authorization()).toBe(`Bearer ${process.env.ERNIE_FIXTURE_AUTH}`);
  expect(fixture.calls()).toBe(1);
  expect(JSON.stringify(instance.inspect())).not.toMatch(/Bearer|ERNIE_FIXTURE_AUTH|runtime-auth/);
  await instance.disconnectMcp('http');
  expect(instance.registry.definitions().some(def => def.function.name.startsWith('mcp_'))).toBe(false);
});

it('rejects namespace collisions and cleans an SDK connection after failed discovery', async () => {
  const fixture = await httpFixture(true);
  const instance = new ExtensionHost({ enabled: true, mcpServers: [{ id: 'dup', transport: 'http', url: fixture.url }] });
  hosts.push(instance); await instance.start(workspace);
  expect(instance.inspect().mcpServers[0].state).toBe('failed');
  expect(instance.registry.definitions().map(value => value.function.name)).toEqual(['invoke_skill']);
});

it('never follows HTTP redirects with a runtime authorization credential', async () => {
  let sinkHits = 0;
  const sink = createServer((_req, res) => { sinkHits++; res.writeHead(500).end(); });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
  const sinkAddress = sink.address(); if (!sinkAddress || typeof sinkAddress === 'string') throw new Error();
  const redirect = createServer((_req, res) => res.writeHead(302, { Location: `http://127.0.0.1:${sinkAddress.port}/stolen` }).end());
  await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve));
  const redirectAddress = redirect.address(); if (!redirectAddress || typeof redirectAddress === 'string') throw new Error();
  const instance = new ExtensionHost({ enabled: true, mcpServers: [{ id: 'redirect', transport: 'http', url: `http://127.0.0.1:${redirectAddress.port}/mcp`, bearerTokenEnv: 'ERNIE_FIXTURE_AUTH', timeoutMs: 1000 }] });
  hosts.push(instance);
  try {
    await instance.start(workspace);
    expect(instance.inspect().mcpServers[0].state).toBe('failed'); expect(sinkHits).toBe(0);
    expect(JSON.stringify(instance.inspect())).not.toContain(process.env.ERNIE_FIXTURE_AUTH);
  } finally {
    for (const http of [sink, redirect]) { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
  }
});

it('keeps disabled servers inert, and supports explicit reconnect after disposal of a connection', async () => {
  const disabled = new ExtensionHost({ mcpServers: [{ id: 'off', transport: 'stdio', command: 'does-not-exist' }] });
  hosts.push(disabled); await disabled.start(workspace);
  expect(disabled.inspect().mcpServers[0].state).toBe('disabled'); expect(disabled.registry.definitions()).toEqual([]);
  const instance = stdio(); await instance.start(workspace);
  expect(await instance.listMcpTools('local')).toHaveLength(4);
  await instance.disconnectMcp('local'); await instance.connectMcp('local');
  expect(instance.inspect().mcpServers[0].state).toBe('connected');
  expect((await instance.registry.execute('mcp_local__echo', { text: 'reconnected' }, context())).ok).toBe(true);
});

it('classifies the SDK request timeout and aborts an in-progress startup on host disposal', async () => {
  const instance = new ExtensionHost({ enabled: true, timeoutMs: 10000, mcpServers: [{ id: 'deadline', transport: 'stdio', command: process.execPath, args: [path.resolve('examples/extensions/mcp-fixture.mjs')], timeoutMs: 5000 }] });
  hosts.push(instance); await instance.start(workspace);
  expect(instance.inspect().mcpServers[0].state).toBe('connected');
  const result = await instance.registry.execute('mcp_deadline__slow', {}, context());
  expect(result.ok).toBe(false); expect(result.output).toMatch(/timed out/i);
  const http = createServer((_req, _res) => { /* Deliberately never complete initialization. */ });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error();
  const hanging = new ExtensionHost({ enabled: true, mcpServers: [{ id: 'pending', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, timeoutMs: 10000 }] });
  hosts.push(hanging);
  try {
    const starting = hanging.start(workspace);
    await new Promise(resolve => setTimeout(resolve, 50));
    await hanging.dispose(); await starting;
    expect(hanging.registry.definitions()).toEqual([]);
    expect(hanging.inspect().mcpServers[0].state).toBe('disposed');
  } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
});
