import type { ToolContext, ToolDefinition, ToolRegistry, ToolResult } from '../contracts/index.js';
import { aborted, clip, listFiles, readText, workspaceRoot, writeText } from './files.js';
import { ProcessRegistry, redactSecrets } from './processes.js';
import { DEFINITIONS, validate } from './schemas.js';
import { search } from './search.js';

export { killProcessTree, scrubEnvironment } from './processes.js';

const EXCLUDED_DIFF_PATHS = [
  '**/.env*', '**/.git/**', '**/.ssh/**', '**/.aws/**', '**/.azure/**',
  '**/.npmrc', '**/.netrc', '**/.pypirc', '**/id_rsa*', '**/id_dsa*', '**/id_ecdsa*', '**/id_ed25519*',
  '**/credentials*', '**/secret*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
].map(glob => `:(exclude,glob,icase)${glob}`);

// File mutations share a FIFO even across registry instances. Native shell writes
// remain the responsibility of the supervisor's one-writer-per-workspace policy.
let fileMutationTail: Promise<void> = Promise.resolve();

export class ProjectTools implements ToolRegistry {
  private readonly processes = new ProcessRegistry();

  definitions(): ToolDefinition[] { return structuredClone(DEFINITIONS); }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      aborted(context.signal);
      if (!context.runId || typeof context.runId !== 'string') throw new Error('A run ID is required');
      const values = validate(name, args);
      const perform = async () => {
        const root = await workspaceRoot(context.workspace, context.signal);
        aborted(context.signal);
        return this.dispatch(name, values, { ...context, workspace: root });
      };
      let result: ToolResult;
      if (name === 'write_file' || name === 'edit_file') {
        const pending = fileMutationTail.then(perform);
        fileMutationTail = pending.then(() => undefined, () => undefined);
        result = await pending;
      } else result = await perform();
      const bounded = clip(redactSecrets(result.output));
      return { ...result, output: bounded.output, truncated: !!result.truncated || bounded.truncated };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed';
      return { ok: false, ...clip(redactSecrets(message)) };
    }
  }

  private async dispatch(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const root = context.workspace;
    const input = (args.path as string | undefined) ?? '.';
    switch (name) {
      case 'list_files': return { ok: true, ...clip(await listFiles(root, input, context.signal)) };
      case 'read_file': {
        const text = await readText(root, input, context.signal);
        const start = (args.startLine as number | undefined) ?? 1;
        const count = (args.lineCount as number | undefined) ?? 10000;
        const lines = text.split('\n');
        const bounded = clip(lines.slice(start - 1, start - 1 + count).join('\n'));
        return { ok: true, ...bounded, truncated: bounded.truncated || (args.lineCount === undefined && lines.length > start - 1 + count) };
      }
      case 'write_file': {
        const artifact = await writeText(root, input, args.content as string, context.signal);
        return { ok: true, output: `Wrote ${artifact}`, artifacts: [artifact] };
      }
      case 'edit_file': {
        const text = await readText(root, input, context.signal);
        const oldText = args.oldText as string;
        const position = text.indexOf(oldText);
        if (position < 0) throw new Error('oldText was not found; file was left unchanged');
        if (text.indexOf(oldText, position + 1) !== -1) throw new Error('oldText must match exactly once; file was left unchanged');
        const next = text.slice(0, position) + (args.newText as string) + text.slice(position + oldText.length);
        const artifact = await writeText(root, input, next, context.signal);
        return { ok: true, output: `Edited ${artifact}`, artifacts: [artifact] };
      }
      case 'search': return search(root, args.pattern as string, input, args.glob as string | undefined, context, this.processes);
      case 'shell':
      case 'run_tests':
        return this.processes.run({ executable: args.command as string, args: [], shell: true, timeoutMs: args.timeoutMs as number | undefined, background: name === 'shell' && args.background === true }, context);
      case 'process_status': return this.processes.status(args.id as string, context.runId);
      case 'process_cancel': return this.processes.cancel(args.id as string, context.runId);
      case 'git_diff': {
        const flags = ['--no-pager', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'];
        const result = await this.processes.run({ executable: 'git', args: [...flags, 'HEAD', '--', '.', ...EXCLUDED_DIFF_PATHS], timeoutMs: 15000 }, context);
        if (!result.ok && /(?:bad revision|ambiguous argument).*HEAD/i.test(result.output)) {
          return this.processes.run({ executable: 'git', args: [...flags, '--cached', '--', '.', ...EXCLUDED_DIFF_PATHS], timeoutMs: 15000 }, context);
        }
        return result;
      }
      default: throw new Error('Unknown tool');
    }
  }
  async cancelAll(runId: string): Promise<void> { await this.processes.cancelAll(runId); }
}

export function createToolRegistry(): ToolRegistry { return new ProjectTools(); }
