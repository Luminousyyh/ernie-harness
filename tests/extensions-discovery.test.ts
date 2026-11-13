import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ComposableToolRegistry, ExtensionHost, parseExtensionConfig } from '../src/extensions/index.js';
import type { ToolContext, ToolRegistry } from '../src/contracts/index.js';

let root: string;
let workspace: string;
const hosts: ExtensionHost[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ernie-extensions-'));
  workspace = path.join(root, 'workspace');
  await mkdir(workspace);
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.dispose()));
  await rm(root, { recursive: true, force: true });
});
function host(config: ConstructorParameters<typeof ExtensionHost>[0] = { enabled: true }, base?: ToolRegistry) {
  const value = new ExtensionHost(config, base); hosts.push(value); return value;
}
async function file(relative: string, content: string) {
  const target = path.join(workspace, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
function context(): ToolContext { return { workspace, runId: 'extensions-test' }; }

it('is disabled by default and rejects persisted credentials and unsafe config', async () => {
  const instance = host({});
  expect(parseExtensionConfig().enabled).toBe(false);
  await instance.start(workspace);
  expect(instance.inspect().enabled).toBe(false);
  expect(instance.registry.definitions()).toEqual([]);
  expect(() => parseExtensionConfig({ enabled: true, mcpServers: [{ id: 'x', transport: 'stdio', command: 'node', env: { API_KEY: 'secret' } }] })).toThrow();
  expect(() => parseExtensionConfig({ mcpServers: [{ id: 'x', transport: 'http', url: 'http://example.com/mcp' }] })).toThrow();
  expect(() => parseExtensionConfig({ mcpServers: [{ id: 'x', transport: 'http', url: 'https://example.com/mcp' }] })).toThrow();
  expect(() => parseExtensionConfig({ mcpServers: [{ id: 'x', transport: 'http', url: 'https://user:pass@example.com/mcp', allowRemote: true }] })).toThrow();
});

describe('bounded instruction discovery', () => {
  it('discovers AGENTS root to leaf with workspace scope and source labels', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'outside');
    await file('AGENTS.md', 'root instructions');
    await file('src/AGENTS.md', 'source instructions');
    await file('src/lib/AGENTS.md', 'leaf instructions');
    await file('src/lib/a.ts', '');
    const instance = host();
    const result = await instance.discover(workspace, 'src/lib/a.ts');
    expect(result.agents.map(value => value.content)).toEqual(['root instructions', 'source instructions', 'leaf instructions']);
    expect(result.agents.every(value => value.trust === 'untrusted' && value.source.kind === 'agents' && value.source.scope === 'workspace')).toBe(true);
    expect(result.agents[1].source.label).toContain('src/AGENTS.md');
    expect((await instance.discover(workspace, '../')).diagnostics.length).toBeGreaterThan(0);
  });

  it('rejects symlink escapes for target paths, instruction files and skill roots', async () => {
    const outside = path.join(root, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'AGENTS.md'), 'private');
    await writeFile(path.join(outside, 'SKILL.md'), '---\nname: private\ndescription: no\n---\nsecret');
    await symlink(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(path.join(workspace, '.agents'));
    await symlink(outside, path.join(workspace, '.agents/skills'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await host().discover(workspace, 'escape');
    expect(result.agents).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    await symlink(process.platform === 'win32' ? outside : path.join(outside, 'AGENTS.md'), path.join(workspace, 'AGENTS.md'), process.platform === 'win32' ? 'junction' : 'file');
    expect((await host().discover(workspace)).agents).toEqual([]);
  });

  it('discovers workspace and explicit user roots; invocation reads only the requested skill', async () => {
    await file('.agents/skills/build/SKILL.md', '---\nname: build\ndescription: Build a project\nlicense: MIT\nmetadata:\n  version: "1"\n---\nDo not execute this prose automatically.');
    const userRoot = path.join(root, 'user-skills'); await mkdir(path.join(userRoot, 'read'), { recursive: true });
    await writeFile(path.join(userRoot, 'read/SKILL.md'), '---\nname: read\ndescription: |\n  Read source files\n  with care\n---\nRead guidance.');
    const instance = host({ enabled: true, skillRoots: [userRoot] });
    await instance.start(workspace);
    const discovery = await instance.discover(workspace);
    expect(discovery.skills.map(skill => skill.id).sort()).toEqual(['user-0:read', 'workspace:build']);
    expect(JSON.stringify(discovery.skills)).not.toContain('Do not execute');
    expect(discovery.skills.every(skill => skill.source.kind === 'skill')).toBe(true);
    const result = await instance.registry.execute('invoke_skill', { id: 'workspace:build' }, context());
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Do not execute this prose automatically.');
    expect(JSON.parse(result.output).trust).toBe('untrusted');
    expect((await instance.registry.execute('invoke_skill', { id: '../private' }, context())).ok).toBe(false);
    expect((await instance.registry.execute('invoke_skill', { id: 'workspace:build', shell: true }, context())).ok).toBe(false);
  });

  it('rejects unsafe YAML, mismatched names and oversized files with bounded diagnostics', async () => {
    await file('.agents/skills/unsafe/SKILL.md', '---\nname: unsafe\ndescription: !!js/function function() {}\n---\nno');
    await file('.agents/skills/alias/SKILL.md', '---\nname: alias\ndescription: &anchor unsafe\n---\nno');
    await file('.agents/skills/mismatch/SKILL.md', '---\nname: another\ndescription: mismatch\n---\nno');
    await file('.agents/skills/large/SKILL.md', 'x'.repeat(140000));
    const result = await host().discover(workspace);
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain('function()');
  });

  it('rechecks the file boundary and metadata on invocation after discovery', async () => {
    await file('.agents/skills/safe/SKILL.md', '---\nname: safe\ndescription: Safe\n---\nsafe body');
    const instance = host(); await instance.start(workspace); await instance.discover(workspace);
    await rm(path.join(workspace, '.agents/skills/safe'), { recursive: true });
    const outside = path.join(root, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'SKILL.md'), '---\nname: safe\ndescription: Safe\n---\nprivate body');
    await symlink(outside, path.join(workspace, '.agents/skills/safe'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await instance.registry.execute('invoke_skill', { id: 'workspace:safe' }, context());
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain('private body');
  });
});

it('composes with an existing registry, rejects collisions and removes owned tools', async () => {
  const base: ToolRegistry = {
    definitions: () => [{ type: 'function', function: { name: 'base', description: 'base', parameters: { type: 'object' } } }],
    execute: async () => ({ ok: true, output: 'delegated' }),
  };
  const registry = new ComposableToolRegistry(base);
  expect((await registry.execute('base', {}, context())).output).toBe('delegated');
  const contribution = { name: 'extra', description: 'extra', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, execute: async () => ({ ok: true, output: 'extra' }) };
  registry.register('test', contribution);
  expect(() => registry.register('other', contribution)).toThrow(/duplicate/i);
  expect(() => registry.register('test', { ...contribution, name: 'base' })).toThrow(/duplicate/i);
  expect((await registry.execute('extra', { value: 1 }, context())).ok).toBe(false);
  const definitions = registry.definitions(); definitions[1].function.name = 'corrupted';
  expect(registry.definitions()[1].function.name).toBe('extra');
  registry.unregisterOwner('test'); expect(registry.definitions()).toHaveLength(1);
});



it('accepts standard plain punctuation and descriptive allowed-tools without granting execution', async () => {
  await file('.agents/skills/guide/SKILL.md', '---\nname: guide\ndescription: Read & write; * patterns and ! punctuation are ordinary text here.\nallowed-tools: Bash(git:*) Read\ncompatibility: Node 24\n---\nRun nothing automatically.');
  const result = await host().discover(workspace);
  expect(result.skills).toHaveLength(1);
  expect(result.skills[0].name).toBe('guide');
});

it('allows internal aliases, uses existing parents for new files and rejects protected missing targets', async () => {
  await file('AGENTS.md', 'root'); await file('src/AGENTS.md', 'source');
  await symlink(path.join(workspace, 'src'), path.join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const instance = host();
  expect((await instance.discover(workspace, 'alias')).agents.map(item => item.content)).toEqual(['root', 'source']);
  expect((await instance.discover(workspace, 'src/new/deep.ts')).agents.map(item => item.content)).toEqual(['root', 'source']);
  const protectedTarget = await instance.discover(workspace, '.git/nonexistent/new.ts');
  expect(protectedTarget.agents).toEqual([]);
  expect(protectedTarget.diagnostics.some(item => item.code === 'invalid-target')).toBe(true);
});

it('does not expose partial plugin contributions while registration is pending', async () => {
  const instance = host(); await instance.start(workspace);
  let finish!: () => void;
  const pending = instance.loadPlugin({ apiVersion: 1, id: 'pending', async register(api) {
    api.registerTool({ name: 'partial', description: 'partial', inputSchema: { type: 'object' }, execute: () => ({ ok: true, output: 'partial' }) });
    await new Promise<void>(resolve => { finish = resolve; });
  } });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(instance.registry.definitions().some(item => item.function.name === 'plugin_pending__partial')).toBe(false);
  finish(); await pending;
  expect(instance.registry.definitions().some(item => item.function.name === 'plugin_pending__partial')).toBe(true);
});

it('honors JSON schema refs and nested constraints before executing an extension tool', async () => {
  const registry = new ComposableToolRegistry(); let calls = 0;
  registry.register('schemas', { name: 'schema', description: 'schema', inputSchema: {
    type: 'object', properties: { payload: { $ref: '#/$defs/payload' } }, required: ['payload'], additionalProperties: false,
    $defs: { payload: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false } },
  }, execute: () => { calls++; return { ok: true, output: 'valid' }; } });
  expect((await registry.execute('schema', { payload: { count: 0 } }, context())).ok).toBe(false);
  expect((await registry.execute('schema', { payload: { count: 1, extra: true } }, context())).ok).toBe(false);
  expect((await registry.execute('schema', { payload: { count: 2 } }, context())).ok).toBe(true);
  expect(calls).toBe(1);
});

it('adapts standard MCP names and long names into stable bounded namespaces', async () => {
  const { namespaceToolName } = await import('../src/extensions/index.js');
  for (const name of ['files.read', 'long'.repeat(30)]) {
    const translated = namespaceToolName('mcp', 'names', name);
    expect(translated).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(namespaceToolName('mcp', 'names', name)).toBe(translated);
    expect(translated.startsWith('mcp_names__')).toBe(true);
  }
  expect(namespaceToolName('mcp', 'names', 'files.read')).not.toBe(namespaceToolName('mcp', 'names', 'files_read'));
});

it('does not confuse literal JSON refs in tool data with schema references', async () => {
  const registry = new ComposableToolRegistry();
  registry.register('json', { name: 'json_data', description: 'json', inputSchema: { type: 'object', additionalProperties: true }, execute: args => ({ ok: true, output: JSON.stringify(args) }) });
  expect((await registry.execute('json_data', { $ref: 'https://example.invalid/schema' }, context())).ok).toBe(true);
});


it('keeps explicit skill invocation valid JSON when a body needs output truncation', async () => {
  await file('.agents/skills/large-output/SKILL.md', '---\nname: large-output\ndescription: Large output\n---\n' + '"\t'.repeat(30000));
  const instance = host(); await instance.start(workspace);
  const result = await instance.registry.execute('invoke_skill', { id: 'workspace:large-output' }, context());
  expect(result.ok).toBe(true);
  expect(() => JSON.parse(result.output)).not.toThrow();
  expect(result.truncated).toBe(true);
});
