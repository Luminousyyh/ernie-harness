import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import type { ToolContext, ToolResult } from '../contracts/index.js';
import { aborted, clip, MAX_OUTPUT_BYTES } from './files.js';

const SENSITIVE_NAME = /(?:openrouter|api.?key|secret|token|password|passwd|credential|authorization|private.?key|^aws_|^azure_|^google_|^gcp_)/i;
const UNSAFE_ENV = /^(?:NODE_OPTIONS|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|CDPATH|ZDOTDIR|GIT_.*|SSH_ASKPASS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i;
export function scrubEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !SENSITIVE_NAME.test(key) && !UNSAFE_ENV.test(key)));
}
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const [key, value] of Object.entries(env)) if (SENSITIVE_NAME.test(key) && value && value.length >= 4) text = text.split(value).join('[REDACTED]');
  return text;
}

/** Terminate an owned detached process group (Unix) or the entire PID tree (Windows). */
export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Invalid process ID to terminate');
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawn(executable, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, env: scrubEnvironment(), stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); reject(new Error('Process tree termination timed out')); }, 5000);
      killer.once('error', error => { clearTimeout(timer); reject(error); });
      killer.once('exit', code => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        try { process.kill(pid, 0); reject(new Error('Failed to terminate process tree')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') resolve(); else reject(error); }
      });
    });
  } else {
    const send = (signal: NodeJS.Signals) => {
      try { process.kill(-pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    send('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    send('SIGKILL');
  }
}

type State = 'running' | 'exited' | 'failed' | 'cancelled' | 'timed-out';
interface RecordEntry {
  id: string;
  runId: string;
  process: ChildProcess;
  status: State;
  output: string;
  bytes: number;
  truncated: boolean;
  exitCode?: number;
  done: Promise<void>;
  stop?: Promise<void>;
}
export interface CommandOptions {
  executable: string;
  args: string[];
  shell?: boolean;
  timeoutMs?: number;
  background?: boolean;
  acceptedExitCodes?: number[];
}

export class ProcessRegistry {
  private readonly records = new Map<string, RecordEntry>();

  private emit(context: ToolContext, type: string, data: unknown): void {
    try { context.emit?.(type, data); } catch { /* A disconnected consumer must not break process ownership. */ }
  }
  async run(options: CommandOptions, context: ToolContext): Promise<ToolResult> {
    aborted(context.signal);
    const owned = [...this.records.values()].filter(record => record.runId === context.runId);
    if (owned.filter(record => record.status === 'running').length >= 16) throw new Error('At most 16 concurrent processes are allowed per run');
    for (const record of owned.filter(record => record.status !== 'running').slice(0, Math.max(0, owned.length - 127))) this.records.delete(record.id);
    const id = randomUUID();
    // A detached cmd.exe drops external-command output on Windows. The hidden
    // Node owner retains the pipe handles and gives taskkill a stable tree root.
    const wrapShell = process.platform === 'win32' && options.shell;
    const wrapper = `const {spawn}=require('node:child_process');
      const child=spawn(process.argv[1],[],{shell:true,windowsHide:true,stdio:['ignore','inherit','inherit']});
      child.on('error',error=>{console.error(error.message);process.exitCode=1});
      child.on('exit',code=>{process.exitCode=code===null?1:code});`;
    const child = spawn(wrapShell ? process.execPath : options.executable,
      wrapShell ? ['-e', wrapper, '--', options.executable] : options.args, {
      cwd: context.workspace, env: scrubEnvironment(), shell: wrapShell ? false : options.shell ?? false,
      detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let finish!: () => void;
    const record: RecordEntry = { id, runId: context.runId, process: child, status: 'running', output: '', bytes: 0, truncated: false, done: new Promise(resolve => { finish = resolve; }) };
    this.records.set(id, record);
    let finished = false;
    const secrets = Object.fromEntries(Object.entries(process.env).filter(([key]) => SENSITIVE_NAME.test(key)));
    const secretValues = Object.values(secrets).filter((value): value is string => !!value && value.length >= 4);
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const pending = { stdout: '', stderr: '' };
    const append = (stream: 'stdout' | 'stderr', text: string) => {
      if (!text) return;
      const remaining = MAX_OUTPUT_BYTES - 1024 - record.bytes;
      const bounded = clip(text, remaining);
      record.truncated ||= bounded.truncated;
      if (bounded.output) {
        record.output += bounded.output;
        record.bytes += Buffer.byteLength(bounded.output);
        this.emit(context, 'process.output', { id, stream, chunk: bounded.output, truncated: record.truncated });
      }
    };
    const consume = (stream: 'stdout' | 'stderr', chunk: string, flush = false) => {
      pending[stream] += chunk;
      const redacted = redactSecrets(pending[stream], secrets);
      // Hold only a suffix that could be the beginning of a split credential.
      // A fixed-size lookbehind would hide short progress lines indefinitely.
      let retain = 0;
      if (!flush) for (const secret of secretValues) {
        for (let start = Math.max(0, redacted.length - secret.length + 1); start < redacted.length; start++) {
          if (secret.startsWith(redacted.slice(start))) { retain = Math.max(retain, redacted.length - start); break; }
        }
      }
      const cutoff = redacted.length - retain;
      append(stream, redacted.slice(0, cutoff));
      pending[stream] = redacted.slice(cutoff);
    };
    child.stdout!.on('data', (chunk: Buffer) => consume('stdout', decoders.stdout.write(chunk)));
    child.stderr!.on('data', (chunk: Buffer) => consume('stderr', decoders.stderr.write(chunk)));
    const onAbort = () => { void this.stop(record, 'cancelled').catch(() => undefined); };
    const timer = setTimeout(() => { void this.stop(record, 'timed-out').catch(() => undefined); }, options.timeoutMs ?? 120000);
    const complete = (code: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      consume('stdout', decoders.stdout.end(), true);
      consume('stderr', decoders.stderr.end(), true);
      if (record.status === 'running') record.status = error ? 'failed' : 'exited';
      record.exitCode = code ?? (record.status === 'cancelled' ? 130 : record.status === 'timed-out' ? 124 : 1);
      if (error) append('stderr', `\nProcess failed: ${error.message}`);
      this.emit(context, 'process.exit', { id, status: record.status, exitCode: record.exitCode, truncated: record.truncated });
      finish();
    };
    child.once('error', error => complete(null, error));
    child.once('close', code => {
      // Unix children can survive their immediate parent even after closing the
      // output pipes. Clean the owned process group before reporting completion.
      if (process.platform !== 'win32' && child.pid && record.status === 'running') {
        void killProcessTree(child.pid).then(() => complete(code), error => complete(code, error));
      } else complete(code);
    });
    this.emit(context, 'process.started', { id, pid: child.pid });
    context.signal?.addEventListener('abort', onAbort, { once: true });
    if (context.signal?.aborted) onAbort();
    // Await spawn before reporting success: missing executables are real failures.
    await new Promise<void>(resolve => { child.once('spawn', resolve); child.once('error', () => resolve()); });
    if (options.background && record.status === 'running') return { ok: true, output: JSON.stringify({ id, status: 'running', pid: child.pid }), backgroundId: id };
    await record.done;
    const reason = record.status === 'timed-out' ? '\nProcess timed out.' : record.status === 'cancelled' ? '\nProcess cancelled.' : '';
    return { ok: record.status === 'exited' && (options.acceptedExitCodes ?? [0]).includes(record.exitCode!), ...clip(record.output + reason), truncated: record.truncated, exitCode: record.exitCode };
  }

  private async stop(record: RecordEntry, status: 'cancelled' | 'timed-out'): Promise<void> {
    if (record.stop) return record.stop;
    if (record.status !== 'running') return;
    record.status = status;
    record.stop = (async () => {
      if (record.process.pid) await killProcessTree(record.process.pid);
      await record.done;
    })();
    return record.stop;
  }
  private lookup(id: string, runId: string): RecordEntry {
    const record = this.records.get(id);
    if (!record || record.runId !== runId) throw new Error('Unknown process ID for this run');
    return record;
  }
  status(id: string, runId: string): ToolResult {
    const record = this.lookup(id, runId);
    const view = { id, status: record.status, pid: record.process.pid, exitCode: record.exitCode, output: record.output, truncated: record.truncated };
    let output = JSON.stringify(view);
    while (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
      view.output = clip(view.output, Math.max(0, Buffer.byteLength(view.output) - 1024)).output;
      view.truncated = true;
      output = JSON.stringify(view);
    }
    return { ok: true, output, truncated: view.truncated };
  }
  async cancel(id: string, runId: string): Promise<ToolResult> {
    const record = this.lookup(id, runId);
    await this.stop(record, 'cancelled');
    return this.status(id, runId);
  }
  async cancelAll(runId: string): Promise<void> {
    const records = [...this.records.values()].filter(record => record.runId === runId);
    const results = await Promise.allSettled(records.map(record => this.stop(record, 'cancelled')));
    for (let index = 0; index < records.length; index++) if (results[index].status === 'fulfilled') this.records.delete(records[index].id);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Failed to cancel all owned process trees');
  }
}
