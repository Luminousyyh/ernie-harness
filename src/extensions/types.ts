import type { ToolContext, ToolRegistry, ToolResult } from '../contracts/index.js';

export interface StdioServerConfig {
  id: string; transport: 'stdio'; enabled?: boolean; command: string; args?: string[];
  /** Target environment name -> runtime process environment name. Values are never persisted. */
  envFrom?: Record<string, string>; cwd?: string; timeoutMs?: number;
}
export interface HttpServerConfig {
  id: string; transport: 'http'; enabled?: boolean; url: string; allowRemote?: boolean;
  bearerTokenEnv?: string; timeoutMs?: number;
}
export type McpServerConfig = StdioServerConfig | HttpServerConfig;
export interface PluginConfig { id: string; path: string; enabled?: boolean; trusted?: boolean }
export interface ExtensionConfig {
  enabled?: boolean; skillRoots?: string[]; mcpServers?: McpServerConfig[]; plugins?: PluginConfig[];
  timeoutMs?: number;
}
export interface ResolvedExtensionConfig {
  enabled: boolean; skillRoots: string[]; mcpServers: McpServerConfig[]; plugins: PluginConfig[]; timeoutMs: number;
}
export interface ExtensionSource {
  kind: 'agents' | 'skill' | 'plugin'; scope: 'workspace' | 'user' | 'plugin'; label: string; path?: string;
}
export interface ContextContribution { content: string; source: ExtensionSource; trust: 'untrusted' }
export interface SkillDescriptor { id: string; name: string; description: string; source: ExtensionSource }
export interface DiscoveryDiagnostic { source: string; code: string; message: string }
export interface DiscoveryResult { agents: ContextContribution[]; skills: SkillDescriptor[]; diagnostics: DiscoveryDiagnostic[] }
export interface ExtensionTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> | ToolResult;
}
export interface ValidationResult { ok: boolean; messages: string[]; source?: string }
export interface ExtensionEvent { type: string; data: unknown; workspace: string; runId: string; signal?: AbortSignal }
export interface PluginAPI {
  readonly apiVersion: 1;
  registerTool(tool: ExtensionTool): void;
  addContext(id: string, provider: (context: ToolContext) => string | Promise<string>): void;
  addValidator(id: string, validate: (context: ToolContext) => ValidationResult | Promise<ValidationResult>): void;
  onEvent(handler: (event: ExtensionEvent) => void | Promise<void>): void;
}
export type Dispose = () => void | Promise<void>;
/** Trusted in-process code; this interface is not a sandbox. */
export interface HarnessPlugin {
  apiVersion: 1; id: string; register(api: PluginAPI): void | Dispose | Promise<void | Dispose>; dispose?: Dispose;
}
export interface ExtensionStatus {
  id: string; state: 'disabled' | 'blocked' | 'connecting' | 'connected' | 'loaded' | 'failed' | 'disposed';
  tools: string[]; error?: string;
}
export interface ExtensionInspection {
  enabled: boolean; started: boolean; disposed: boolean;
  agents: Array<{ source: ExtensionSource; bytes: number }>;
  skills: SkillDescriptor[]; mcpServers: ExtensionStatus[]; plugins: ExtensionStatus[];
  diagnostics: DiscoveryDiagnostic[];
}
export type { ToolRegistry };
