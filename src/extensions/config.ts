import { z } from 'zod';
import type { ResolvedExtensionConfig } from './types.js';

const id = z.string().regex(/^(?!.*__)[a-z][a-z0-9_-]{0,19}$/);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const timeout = z.number().int().min(10).max(120_000);
const text = z.string().min(1).max(4096).refine(value => !/[\0\r\n]/.test(value));
const common = { id, enabled: z.boolean().optional(), timeoutMs: timeout.optional() };
const http = z.object({ ...common, transport: z.literal('http'), url: text, allowRemote: z.boolean().optional(), bearerTokenEnv: envName.optional() }).strict().superRefine((value, ctx) => {
  try {
    const url = new URL(value.url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || (!loopback && (!value.allowRemote || url.protocol !== 'https:'))) throw new Error();
  } catch { ctx.addIssue({ code: 'custom', message: 'HTTP URL must be credential-free loopback or explicitly allowed remote HTTPS' }); }
});
const stdio = z.object({ ...common, transport: z.literal('stdio'), command: text, args: z.array(text).max(128).optional(), cwd: text.optional(), envFrom: z.record(envName, envName).optional() }).strict();
const schema = z.object({
  enabled: z.boolean().default(false), skillRoots: z.array(text).max(16).default([]),
  mcpServers: z.array(z.union([stdio, http])).max(16).default([]),
  plugins: z.array(z.object({ id, path: text, enabled: z.boolean().optional(), trusted: z.boolean().optional() }).strict()).max(32).default([]),
  timeoutMs: timeout.default(30_000),
}).strict();

/** Main loads stateDir/extensions.json and passes the parsed object here. Never serializes environment values. */
export function parseExtensionConfig(input: unknown = {}): ResolvedExtensionConfig {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid extension configuration (unknown fields, invalid bounds or unsafe transport settings)');
  for (const list of [parsed.data.mcpServers, parsed.data.plugins]) {
    if (new Set(list.map(value => value.id)).size !== list.length) throw new Error('Duplicate extension configuration ID');
  }
  return parsed.data;
}
