import type { ToolContext, ToolRegistry } from '../contracts/index.js';
import type { ContextContribution, DiscoveryResult, ExtensionConfig, ExtensionEvent, ExtensionInspection, HarnessPlugin, ResolvedExtensionConfig, ValidationResult } from './types.js';
import { parseExtensionConfig } from './config.js';
import { InstructionDiscovery } from './discovery.js';
import { ComposableToolRegistry } from './registry.js';
import { PluginManager } from './plugins.js';
import { McpManager } from './mcp.js';
import { canonicalWorkspace, ExtensionRedactor, MAX_OUTPUT_BYTES } from './security.js';

/** One host owns one workspace. Main reads persisted stateDir/extensions.json and passes config here. */
export class ExtensionHost {
  readonly registry: ComposableToolRegistry;
  private readonly config: ResolvedExtensionConfig;
  private readonly instructions: InstructionDiscovery;
  private readonly redactor = new ExtensionRedactor();
  private readonly plugins: PluginManager;
  private readonly mcp: McpManager;
  private workspace?: string;
  private startPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private disposed = false;
  private latest: DiscoveryResult = { agents: [], skills: [], diagnostics: [] };
  constructor(config?: ExtensionConfig, baseRegistry?: ToolRegistry) {
    this.config = parseExtensionConfig(config);
    this.registry = new ComposableToolRegistry(baseRegistry, { timeoutMs: this.config.timeoutMs, redactor: this.redactor });
    this.instructions = new InstructionDiscovery(this.config.skillRoots);
    this.plugins = new PluginManager(this.registry, this.redactor, this.config.timeoutMs);
    this.mcp = new McpManager(this.registry, this.config.mcpServers, this.redactor);
    if (this.config.enabled) this.registry.register('skills', {
      name: 'invoke_skill', description: 'Explicitly read one discovered SKILL.md by source-qualified ID. Returns labeled untrusted guidance; does not execute instructions or grant permissions.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['id'], additionalProperties: false },
      execute: async (args, context) => {
        const contribution = await this.instructions.invoke(context.workspace, args.id as string);
        contribution.content = this.redactor.clean(contribution.content, 128 * 1024);
        let truncated = false;
        const serialize = () => JSON.stringify({ ...contribution, ...(truncated ? { truncated: true } : {}) });
        let output = serialize();
        // Bound the serialized JSON, including escaping and provenance, before the registry's generic clip.
        while (Buffer.byteLength(output) > MAX_OUTPUT_BYTES - 1024 && contribution.content.length) {
          contribution.content = contribution.content.slice(0, Math.floor(contribution.content.length / 2));
          truncated = true; output = serialize();
        }
        return { ok: true, output, truncated };
      },
    });
  }
  async start(workspace: string): Promise<void> {
    if (this.disposed) throw new Error('Extension host is disposed');
    const canonical = await canonicalWorkspace(workspace);
    if (this.disposed) throw new Error('Extension host is disposed');
    if (this.workspace && this.workspace !== canonical) throw new Error('Extension host is already bound to another workspace');
    this.workspace = canonical; this.registry.bindWorkspace(canonical);
    if (!this.startPromise) this.startPromise = this.initialize(canonical);
    await this.startPromise;
  }
  private async initialize(workspace: string): Promise<void> {
    if (!this.config.enabled) return;
    await this.discover(workspace);
    for (const config of this.config.plugins) {
      if (this.disposed) return;
      await this.plugins.loadConfigured(config, workspace);
    }
    for (const config of this.config.mcpServers) {
      if (this.disposed) return;
      await this.mcp.connect(config.id, workspace);
    }
  }
  async discover(workspace: string, targetPath = '.'): Promise<DiscoveryResult> {
    if (this.disposed || !this.config.enabled) return { agents: [], skills: [], diagnostics: [] };
    if (this.workspace && await canonicalWorkspace(workspace) !== this.workspace) throw new Error('Extension host workspace mismatch');
    const result = await this.instructions.discover(workspace, targetPath);
    for (const entry of result.agents) entry.content = this.redactor.clean(entry.content, 128 * 1024);
    for (const skill of result.skills) skill.description = this.redactor.clean(skill.description, 4096);
    this.latest = structuredClone(result);
    return result;
  }
  inspect(): ExtensionInspection {
    const loaded = this.plugins.inspect();
    return structuredClone({ enabled: this.config.enabled, started: !!this.workspace, disposed: this.disposed,
      agents: this.latest.agents.map(agent => ({ source: agent.source, bytes: Buffer.byteLength(agent.content) })),
      skills: this.latest.skills, diagnostics: this.latest.diagnostics, mcpServers: this.mcp.inspect(),
      plugins: [...this.config.plugins.filter(config => !loaded.some(value => value.id === config.id)).map(config => ({ id: config.id, state: 'disabled' as const, tools: [] })), ...loaded],
    });
  }
  private async checkContext(workspace: string): Promise<void> {
    if (this.disposed || !this.config.enabled || !this.workspace) throw new Error('Extension host is not active');
    if (await canonicalWorkspace(workspace) !== this.workspace) throw new Error('Extension host workspace mismatch');
  }
  async collectContext(context: ToolContext, targetPath = '.'): Promise<ContextContribution[]> {
    if (!this.config.enabled) return [];
    await this.checkContext(context.workspace);
    return [...(await this.discover(context.workspace, targetPath)).agents, ...await this.plugins.collectContext(context)];
  }
  async validate(context: ToolContext): Promise<ValidationResult[]> {
    if (!this.config.enabled) return [];
    await this.checkContext(context.workspace); return this.plugins.validate(context);
  }
  async emitEvent(event: ExtensionEvent): Promise<void> {
    if (!this.config.enabled) return;
    await this.checkContext(event.workspace); await this.plugins.emitEvent(event);
  }
  async loadPlugin(plugin: HarnessPlugin): Promise<void> {
    if (!this.workspace) throw new Error('Start the extension host before loading plugins');
    await this.checkContext(this.workspace); await this.plugins.load(plugin);
  }
  async unloadPlugin(id: string): Promise<void> { await this.plugins.unload(id); }
  async connectMcp(id: string): Promise<void> {
    if (!this.workspace) throw new Error('Start the extension host before connecting MCP');
    await this.checkContext(this.workspace); await this.mcp.connect(id, this.workspace);
  }
  async listMcpTools(id: string): Promise<string[]> {
    if (!this.workspace) throw new Error('Extension host is not active');
    await this.checkContext(this.workspace); return this.mcp.listTools(id);
  }
  async disconnectMcp(id: string): Promise<void> { await this.mcp.disconnect(id); }
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.registry.dispose(); this.instructions.clear();
    this.disposePromise = Promise.allSettled([this.mcp.dispose(), this.plugins.dispose()]).then(() => undefined);
    return this.disposePromise;
  }
}
