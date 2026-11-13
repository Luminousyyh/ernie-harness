import type { ToolDefinition } from '../contracts/index.js';

const string = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const filePath = string('Path within the authorized workspace; secret files and .git are unavailable.', { minLength: 1, maxLength: 4096 });
const command = string('Trusted native shell command executed in the workspace. This is not an OS sandbox.', { minLength: 1, maxLength: 16000 });
const timeoutMs = { type: 'integer', minimum: 1, maximum: 600000, description: 'Wall-clock limit in milliseconds (default 120000, including background jobs).' };
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
export const DEFINITIONS: ToolDefinition[] = [
  tool('list_files', 'List immediate visible entries; directories end in / and safe symlinks in @.', { path: filePath }),
  tool('read_file', 'Read UTF-8 text, with one-based line selection; output is capped at 32 KiB.', { path: filePath, startLine: { type: 'integer', minimum: 1, maximum: 10000000 }, lineCount: { type: 'integer', minimum: 1, maximum: 10000 } }, ['path']),
  tool('search', 'Find literal text recursively with line numbers. Skips secret files, .git, node_modules and symlinks. Glob supports *, **, and ?.', { pattern: string('Literal text to find', { minLength: 1, maxLength: 4096 }), path: filePath, glob: string('Optional glob matched against relative paths or basenames', { minLength: 1, maxLength: 1024 }) }, ['pattern']),
  tool('write_file', 'Atomically create or replace a UTF-8 file, creating parent directories. Maximum content 8 MiB.', { path: filePath, content: string('Complete new file contents', { maxLength: 8388608 }) }, ['path', 'content']),
  tool('edit_file', 'Replace exactly one occurrence of oldText. Rejects absent or ambiguous matches, including overlapping matches.', { path: filePath, oldText: string('Nonempty exact text', { minLength: 1, maxLength: 8388608 }), newText: string('Replacement text', { maxLength: 8388608 }) }, ['path', 'oldText', 'newText']),
  tool('shell', 'Run a trusted native shell command with a scrubbed environment and bounded output. Background jobs belong to this run.', { command, timeoutMs, background: { type: 'boolean' } }, ['command']),
  tool('process_status', 'Read this run’s background process state and bounded output as JSON.', { id: string('Background process ID', { minLength: 1, maxLength: 128 }) }, ['id']),
  tool('process_cancel', 'Terminate a background process and its process tree.', { id: string('Background process ID', { minLength: 1, maxLength: 128 }) }, ['id']),
  tool('git_diff', 'Show tracked staged and unstaged changes without external diff drivers or text converters. Untracked files are not included.', {}),
  tool('run_tests', 'Run a trusted local test command and return its real exit code and bounded output.', { command, timeoutMs }, ['command']),
];

export function validate(name: string, args: unknown): Record<string, unknown> {
  const definition = DEFINITIONS.find(item => item.function.name === name);
  if (!definition) throw new Error(`Unknown tool: ${String(name).slice(0, 128)}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be a JSON object');
  const schema = definition.function.parameters;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const values = args as Record<string, unknown>;
  for (const required of schema.required as string[]) if (!Object.hasOwn(values, required)) throw new Error(`Missing argument: ${required}`);
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(properties, key)) throw new Error(`Unknown argument: ${key}`);
    const rule = properties[key];
    if (rule.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < Number(rule.minimum) || value > Number(rule.maximum)) throw new Error(`Invalid integer argument: ${key}`);
    } else if (typeof value !== rule.type) throw new Error(`Invalid ${String(rule.type)} argument: ${key}`);
    else if (typeof value === 'string') {
      if (value.includes('\0') || (rule.minLength !== undefined && value.length < Number(rule.minLength)) || (rule.maxLength !== undefined && value.length > Number(rule.maxLength))) throw new Error(`Invalid string argument: ${key}`);
      if ((key === 'command' || key === 'path') && !value.trim()) throw new Error(`Empty argument: ${key}`);
    }
  }
  return values;
}
