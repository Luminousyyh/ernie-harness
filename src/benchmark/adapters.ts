import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile, stat, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { redactText } from '../trace/redact.js';
import { basename, dirname, join, resolve } from 'node:path';
import { MODEL_ID, type BenchmarkAdapter } from '../contracts/index.js';
import { BASELINE_PINS, type HarnessName } from './schedule.js';
import { sandboxArgv, validateBrokerUrl } from './sandbox.js';

function fakeToken(token: string): void {
  if (!/^(trial|eval|fake)-[a-zA-Z0-9_-]{4,160}$/.test(token)) throw new Error('adapter accepts only an explicit fake per-trial token');
}
export function baselineConfig(name: HarnessName, baseUrl: string, token: string): unknown {
  validateBrokerUrl(baseUrl); fakeToken(token);
  const model = { id: MODEL_ID, name: 'ERNIE 5.5 Flash free', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  if (name === 'pi') return { providers: { 'ernie-eval': { baseUrl, api: 'openai-completions', apiKey: token,
    compat: { thinkingFormat: 'openrouter', supportsReasoningEffort: true, maxTokensField: 'max_tokens' }, models: [model] } } };
  if (name === 'dsh') return [
    // Pinned base enables delegation. Primary trials use native single-agent configuration.
    { id: 'subagent', config: { maxDepth: 0 } },
    ...['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-agent-team', 'tool-workflow'].map(id => ({ id, disabled: true })),
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { 'ernie-eval': { baseURL: baseUrl, api: 'openai-completions', apiKeyEnv: 'ERNIE_EVAL_TRIAL_TOKEN',
      reasoning: 'high', compat: { thinkingFormat: 'openrouter' }, models: [{ id: MODEL_ID, contextWindow: 1000000, maxTokens: 16384, reasoningEfforts: { high: 'high' } }] } } } },
    { id: 'agent-default-model', config: { provider: 'ernie-eval', model: MODEL_ID } },
  ];
  return { model: MODEL_ID, baseUrl, token };
}
export function baselineEnvironment(name: HarnessName, token: string): Record<string, string> {
  fakeToken(token);
  return { DSH_HOME: '/home/agent/.dsh', PI_OFFLINE: '1', PI_TELEMETRY: '0',
    ...(name === 'dsh' ? { ERNIE_EVAL_TRIAL_TOKEN: token } : {}) };
}
export function baselineCommand(name: HarnessName, token = 'trial-placeholder', contextLimit = 128000): string[] {
  fakeToken(token);
  if (![64000, 128000, 256000].includes(contextLimit)) throw new Error('unsupported development context limit');
  const node = '/runtime/node/bin/node';
  if (name === 'ernie') return [node, '/baseline/dist/cli/headless.js', '--workspace', '/workspace', '--prompt-file', '/task.txt',
    '--base-url', 'http://127.0.0.1:18080/v1', '--token', token, '--state-dir', '/home/agent/.ernie-trial', '--context-limit', String(contextLimit)];
  if (name === 'pi') return [node, '/baseline/packages/coding-agent/dist/cli.js', '--print', '--mode', 'json', '--provider', 'ernie-eval', '--model', MODEL_ID,
    '--thinking', 'high', '--api-key', token, '@/task.txt'];
  return [node, '/baseline/apps/cli/lib/bin.js',
    'headless', '--patch', '/config/dsh.patch.yml', '--json', '--approval-policy', 'never', '-'];
}
export interface RemoteAdapterOptions { root: string; brokerSocket: string; cpus: number[]; contextLimit?: number }
/** Linux host launcher. Broker registration and external evaluation remain trusted runner responsibilities. */
export class SandboxedBenchmarkAdapter implements BenchmarkAdapter {
  constructor(readonly name: HarnessName, private readonly options: RemoteAdapterOptions) {}
  async run(input: Parameters<BenchmarkAdapter['run']>[0]): ReturnType<BenchmarkAdapter['run']> {
    if (process.platform !== 'linux') throw new Error('actual benchmark trials require Linux bwrap');
    if (input.signal?.aborted) throw new Error('trial cancelled before launch');
    const baseUrl = validateBrokerUrl(input.baseUrl);
    if (baseUrl !== 'http://127.0.0.1:18080/v1') throw new Error('relay port is fixed at 18080');
    fakeToken(input.token);
    const root = await realpath(this.options.root), workspace = await realpath(input.workspace);
    if (!workspace.startsWith(root + '/eval/trials/')) throw new Error('workspace must be a fresh evaluator trial directory');
    const baseline = join(root, 'baselines', this.name);
    if (this.name !== 'ernie') {
      const provenance = JSON.parse(await readFile(join(baseline, '.source-pin.json'), 'utf8')) as { pin: string };
      if (provenance.pin !== BASELINE_PINS[this.name]) throw new Error('baseline pin mismatch');
    }
    // Require readiness evidence from an operator-verified headless build.
    const ready = JSON.parse(await readFile(join(root, 'eval', `${this.name}-ready.json`), 'utf8')) as { ready: boolean };
    if (ready.ready !== true) throw new Error('baseline headless readiness not verified');
    const native = await createPrivateTrialHome(root, workspace, this.name);
    const control = await mkdtemp(join(dirname(workspace), 'control-'));
    await writeFile(join(control, 'task.txt'), input.prompt, { mode: 0o600 });
    const config = baselineConfig(this.name, baseUrl, input.token);
    const configName = this.name === 'dsh' ? 'dsh.patch.yml' : 'models.json';
    await writeFile(join(control, configName), JSON.stringify(config, null, 2), { mode: 0o600 }); // JSON is valid YAML.
    const command = baselineCommand(this.name, input.token, this.options.contextLimit);
    const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
    const init = ['#!/bin/sh', 'set -eu', 'mkdir -p /home/agent/.pi/agent /home/agent/.dsh',
      ...(this.name === 'pi' ? ['cp /config/models.json /home/agent/.pi/agent/models.json'] : []),
      ...Object.entries(baselineEnvironment(this.name, input.token)).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
      `exec ${command.map(shellQuote).join(' ')}${this.name === 'dsh' ? ' < /task.txt' : ''}`, ''].join('\n');
    await writeFile(join(control, 'launch.sh'), init, { mode: 0o700 });
    const candidateVenv = join(dirname(workspace), 'python-venv');
    const venvExists = await stat(candidateVenv).then(s => s.isDirectory(), error => { if (error.code === 'ENOENT') return false; throw error; });
    const pythonVenv = venvExists ? await realpath(candidateVenv) : undefined;
    const argv = sandboxArgv({ ...this.options, workspace, baseline, nodeRuntime: join(root, 'runtimes/node-v24.13.1-linux-x64'),
      relayScript: join(root, 'eval/relay.py'), guardScript: join(root, 'eval/remote-guard.py'), taskFile: join(control, 'task.txt'),
      configDir: control, homeDir: native.home, pythonVenv, command: ['/bin/sh', '/config/launch.sh'] });
    return await captureNativeProcess(argv, { ...native, cwd: root, token: input.token, harness: this.name, signal: input.signal, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  }
}

export const NATIVE_LOG_LIMIT = 64 * 1024 * 1024;
const OUTPUT_TAIL_LIMIT = 1024 * 1024;
export function sanitizeNativeText(text: string, token: string): string {
  return redactText(text, [token]).replace(/\bsk-[a-zA-Z0-9_-]*/g, '[REDACTED]');
}
async function privateChild(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('unsafe private native directory');
  return path;
}
export interface PrivateTrialHome {recordDir: string; home: string; trialId: string}
/** Only this newly created HOME leaf is writable in the agent namespace. Its parent is never mounted. */
export async function createPrivateTrialHome(root: string, workspace: string, harness: HarnessName): Promise<PrivateTrialHome> {
  root = await realpath(root);
  const trialId = basename(dirname(workspace));
  if (!/^[a-zA-Z0-9_-]+$/.test(trialId) || resolve(workspace) !== join(root, 'eval', 'trials', trialId, 'workspace')) throw new Error('unsafe trial workspace');
  let directory = root;
  for (const name of ['eval', 'private', 'adapter-records', trialId]) directory = await privateChild(directory, name);
  const recordDir = await mkdtemp(join(directory, harness + '-'));
  const home = await privateChild(recordDir, 'home');
  await writeFile(join(recordDir, 'started.json'), JSON.stringify({schemaVersion:1, trialId, harness, startedAt:new Date().toISOString(), home}), {flag:'wx',mode:0o600});
  return {recordDir, home, trialId};
}
interface NativeFile {
  relativePath: string; bytes?: number; sha256?: string; sanitizedPath?: string; sanitizedSha256?: string;
  skipped?: string; truncated?: boolean;
}
/** Open every directory through an already-held descriptor on Linux. No agent symlink is traversed. */
async function exportNativeHome(home: string, destination: string, token: string): Promise<NativeFile[]> {
  const records: NativeFile[] = [];
  let exportedBytes = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32 || records.length >= 10000) { records.push({relativePath:sanitizeNativeText(prefix,token),skipped:'inventory-limit'}); return; }
    const dir = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      const anchored = process.platform === 'linux' ? `/proc/self/fd/${dir.fd}` : directory;
      for (const name of (await readdir(anchored)).sort()) {
        if (records.length >= 10000) {records.push({relativePath:sanitizeNativeText(prefix,token),skipped:'inventory-limit'});break;}
        const source = join(anchored, name), relativeName = prefix ? prefix + '/' + name : name;
        const item: NativeFile = {relativePath:sanitizeNativeText(relativeName,token)};
        const info = await lstat(source);
        if (info.isSymbolicLink()) {records.push({...item,skipped:'symlink'});continue;}
        if (info.isDirectory()) {await visit(source,relativeName,depth+1);continue;}
        if (!info.isFile() || info.nlink !== 1) {records.push({...item,skipped:'non-regular-or-hardlink'});continue;}
        const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const current = await handle.stat();
          if (!current.isFile() || current.nlink !== 1 || current.dev !== info.dev || current.ino !== info.ino) throw new Error('native file changed during export');
          item.bytes = current.size;
          if (current.size > NATIVE_LOG_LIMIT || exportedBytes + current.size > 256 * 1024 * 1024) {records.push({...item,skipped:'export-byte-limit',truncated:true});continue;}
          const bytes = Buffer.alloc(current.size);
          let offset = 0;
          while (offset < bytes.length) {const read = await handle.read(bytes,offset,bytes.length-offset,offset); if (!read.bytesRead) break; offset += read.bytesRead;}
          const end = await handle.stat();
          if (offset !== bytes.length || end.size !== current.size || end.mtimeMs !== current.mtimeMs) throw new Error('native file changed during export');
          item.sha256 = createHash('sha256').update(bytes).digest('hex');
          exportedBytes += bytes.length;
          // SQLite/compressed native files remain private. Events have a separate JSON/JSONL export.
          if (bytes.includes(0) || !/^(?:[^\x00-\x08\x0e-\x1f]*)$/.test(bytes.toString('utf8'))) item.skipped = 'binary-retained-privately';
          else {
            const extension = /\.(jsonl|json|log|txt|ya?ml)$/i.exec(name)?.[1] ?? 'txt';
            item.sanitizedPath = join(destination, 'native-' + String(records.length).padStart(5,'0') + '.' + extension);
            const text = sanitizeNativeText(bytes.toString('utf8'),token);
            await writeFile(item.sanitizedPath,text,{flag:'wx',mode:0o600});
            item.sanitizedSha256 = createHash('sha256').update(text).digest('hex');
          }
          records.push(item);
        } finally {await handle.close();}
      }
    } finally {await dir.close();}
  };
  await visit(home,'',0);
  return records;
}
interface CaptureOptions extends PrivateTrialHome {
  cwd: string; token: string; harness: HarnessName; signal?: AbortSignal; env?: NodeJS.ProcessEnv; limitBytes?: number;
}
/** Capture is capped in RAM. Only a whole-capture sanitized string is ever written as a log. */
export async function captureNativeProcess(argv: string[], options: CaptureOptions): Promise<{exitCode:number;output:string}> {
  fakeToken(options.token);
  const limit = options.limitBytes ?? NATIVE_LOG_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > NATIVE_LOG_LIMIT || !argv.length) throw new Error('invalid native capture limit');
  if (options.signal?.aborted) throw new Error('trial cancelled before launch');
  const sanitizedDir = await privateChild(options.recordDir,'sanitized');
  const logs = Object.fromEntries(['stdout','stderr'].map(name => [name,{chunks:[] as Buffer[],observedBytes:0,retainedBytes:0}])) as
    Record<'stdout'|'stderr',{chunks:Buffer[];observedBytes:number;retainedBytes:number}>;
  const start = await open(join(options.recordDir,'capture-started.json'),'wx',0o600);
  try {await start.writeFile(JSON.stringify({schemaVersion:1,kind:'native-capture-started',trialId:options.trialId,harness:options.harness,
    startedAt:new Date().toISOString(),argv:argv.map(arg=>sanitizeNativeText(arg,options.token)),home:options.home,
    limitBytesPerStream:limit,sanitizedStreams:{stdout:join(sanitizedDir,'stdout.log'),stderr:join(sanitizedDir,'stderr.log')},capturePolicy:'RAM only until whole-stream sanitization; no raw disk log',eventSchemas:{ernie:'ernie-harness.event.v1',pi:'pinned native JSON events',dsh:'pinned native JSON events'}})+'\n');await start.sync();}
  finally{await start.close();}
  let tail = Buffer.alloc(0);
  let outcome: {exitCode:number;signal:NodeJS.Signals|null;spawnError:boolean};
  outcome = await new Promise((resolveResult) => {
      const child = spawn(argv[0],argv.slice(1),{cwd:options.cwd,env:options.env,stdio:['ignore','pipe','pipe']});
      const collect = (name:'stdout'|'stderr', chunk:Buffer):void => {
        const log = logs[name]; log.observedBytes += chunk.length;
        const retained = chunk.subarray(0,Math.max(0,limit-log.retainedBytes));
        if(retained.length)log.chunks.push(Buffer.from(retained));
        log.retainedBytes += retained.length;
        tail = Buffer.concat([tail,chunk]).subarray(-OUTPUT_TAIL_LIMIT-512);
      };
      child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
      const abort=():void=>{child.kill('SIGTERM');};options.signal?.addEventListener('abort',abort,{once:true});
      let spawnError=false;child.on('error',()=>{spawnError=true;});
      child.on('close',(code,signal)=>{options.signal?.removeEventListener('abort',abort);resolveResult({exitCode:code??130,signal,spawnError});});
      if(options.signal?.aborted)abort();
    });
  const streamEvidence: Record<string,unknown> = {};
  for (const [name,log] of Object.entries(logs)) {
    const bytes = Buffer.concat(log.chunks), sanitized = sanitizeNativeText(bytes.toString('utf8'),options.token);
    const sanitizedPath = join(sanitizedDir,name+'.log');
    const file=await open(sanitizedPath,'wx',0o600);try{await file.writeFile(sanitized);await file.sync();}finally{await file.close();}
    log.chunks.length=0;
    const sha256=createHash('sha256').update(sanitized).digest('hex');
    streamEvidence[name] = {path:sanitizedPath,sanitizedPath,observedBytes:log.observedBytes,retainedBytes:log.retainedBytes,sanitizedBytes:Buffer.byteLength(sanitized),
      truncated:log.observedBytes>log.retainedBytes,sha256,sanitizedSha256:sha256,capturedSha256:createHash('sha256').update(bytes).digest('hex')};
  }
  let nativeFiles: NativeFile[] = [], nativeExportFailed = false;
  try {nativeFiles = await exportNativeHome(options.home,sanitizedDir,options.token);} catch {nativeExportFailed = true;}

  const manifest = {schemaVersion:1,kind:'native-trajectory',trialId:options.trialId,harness:options.harness,home:options.home,
    recordedAt:new Date().toISOString(),...outcome,...streamEvidence,nativeFiles,limitBytesPerStream:limit,
    nativeExportFailed,complete:!nativeExportFailed&&!outcome.spawnError&&Object.values(logs).every(log=>log.observedBytes===log.retainedBytes)&&!nativeFiles.some(file=>file.truncated||file.skipped==='inventory-limit'),
    trajectoryCompleteness:'not-asserted',toolFailures:{value:null,provenance:'unknown until native event schema is analyzed; missing observations are not zero'},
    provenance:{ernie:'ERNIE_EVENT_JSON stderr and retained SQLite HOME',pi:'native --mode json stdout and retained session HOME',dsh:'native --json stdout and retained session HOME'}[options.harness],
    redaction:'whole RAM capture sanitized before first disk log write: exact fake trial token, sk-* patterns, shared credential forms; native HOME remains private'};
  const receipt=await open(join(options.recordDir,'manifest.json'),'wx',0o600);try{await receipt.writeFile(JSON.stringify(manifest,null,2)+'\n');await receipt.sync();}finally{await receipt.close();}
  if(nativeExportFailed||outcome.spawnError)throw new Error('native process capture failed; private evidence retained');
  const sanitizedTail=Buffer.from(sanitizeNativeText(tail.toString('utf8'),options.token));
  let output=sanitizedTail.subarray(-OUTPUT_TAIL_LIMIT).toString('utf8');
  while(Buffer.byteLength(output)>OUTPUT_TAIL_LIMIT)output=output.slice(1);
  return {exitCode:outcome.exitCode,output};
}
