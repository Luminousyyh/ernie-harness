/** Independent plugin author entrypoint: no host, MCP client, secret store or transport imports. */
import type { HarnessPlugin } from './types.js';
export const EXTENSION_API_VERSION = 1 as const;
export function definePlugin<T extends HarnessPlugin>(plugin: T): T { return plugin; }
export type { HarnessPlugin, PluginAPI, ExtensionTool, ContextContribution, ValidationResult, ExtensionEvent, Dispose } from './types.js';
export type { ToolContext, ToolResult } from '../contracts/index.js';
