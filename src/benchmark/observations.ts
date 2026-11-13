import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, readdir, rename, link, unlink, type FileHandle} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

export interface TrialObservationInput {
  root: string; phase: 'development'|'formal'|'diagnostic'; trialId: string; harness: 'ernie'|'pi'|'dsh';
  traceDirectory?: string;
  attempts: {id?: string; status: string; dispatchAt?: number}[];
}
export interface TrialObservation {
  receiptPath: string; receiptSha256: string; providerComplete: boolean;
  toolCalls: number|null; toolFailures: number|null; toolMetricsComplete: boolean; toolMetricsSource: string;
}
type ObjectValue = Record<string, any>;
type Artifact = {path: string; sha256: string; bytes: number};
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const missing = (error: unknown) => object(error) && error.code === 'ENOENT';
const anchored = (handle: FileHandle|undefined, path: string) => process.platform === 'linux' && handle
  ? `/proc/self/fd/${handle.fd}/${basename(path)}` : path;

/** Walk without following symlinks; Linux holds each parent open before descending. */
async function directory(path: string, create = false): Promise<FileHandle|undefined> {
  const paths = [path]; while (dirname(paths[0]) !== paths[0]) paths.unshift(dirname(paths[0]));
  let held: FileHandle|undefined;
  try {
    for (const part of paths) {
      const at = anchored(held, part);
      try { await lstat(at); } catch (error) {
        if (!create || !missing(error)) throw error;
        try { await mkdir(at,{mode:0o700}); } catch (error) { if (!object(error) || error.code !== 'EEXIST') throw error; }
        if (held) await held.sync();
      }
      const info = await lstat(at);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      const next = process.platform === 'win32' ? undefined : await open(at,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (next) {
        const current = await next.stat();
        if (current.dev !== info.dev || current.ino !== info.ino) { await next.close(); throw new Error(); }
      }
      await held?.close(); held = next;
    }
    return held;
  } catch (error) { await held?.close(); throw error; }
}

async function read(path: string): Promise<Buffer|undefined> {
  let parent: FileHandle|undefined, file: FileHandle|undefined;
  try {
    parent = await directory(dirname(path)); const at = anchored(parent,path); const before = await lstat(at);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error();
    file = await open(at,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const start = await file.stat();
    if (!start.isFile() || start.nlink !== 1 || start.dev !== before.dev || start.ino !== before.ino) throw new Error();
    const bytes = await file.readFile(), end = await file.stat();
    if (bytes.length !== start.size || end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs) throw new Error();
    return bytes;
  } catch (error) { if (missing(error)) return undefined; throw error; }
  finally { await file?.close(); await parent?.close(); }
}
async function names(path: string): Promise<string[]> {
  let handle: FileHandle|undefined;
  try {
    handle = await directory(path);
    return (await readdir(process.platform === 'linux' && handle ? `/proc/self/fd/${handle.fd}` : path)).sort();
  } catch (error) { if (missing(error)) return []; throw error; }
  finally { await handle?.close(); }
}
function text(bytes: Buffer): string {
  const value = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if (/[\x00-\x08\x0e-\x1f]/.test(value)) throw new Error();
  return value;
}
function json(bytes: Buffer|undefined): ObjectValue|undefined {
  try { const value = bytes && JSON.parse(text(bytes)); return object(value) ? value : undefined; } catch { return undefined; }
}
async function publish(path: string, bytes: Buffer, replace = false): Promise<void> {
  const parent = await directory(dirname(path),true), target = anchored(parent,path);
  const temporary = anchored(parent,join(dirname(path),`.observation-${randomUUID()}.tmp`));
  let file: FileHandle|undefined, created = false;
  try {
    const previous = await read(path);
    if (previous && !replace) { if (!previous.equals(bytes)) throw new Error(); return; }
    file = await open(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),0o600); created = true;
    await file.writeFile(bytes); await file.sync(); await file.close(); file = undefined;
    if (replace) { await read(path); await rename(temporary,target); created = false; }
    else {
      try { await link(temporary,target); }
      catch (error) { if (!object(error) || error.code !== 'EEXIST' || !(await read(path))?.equals(bytes)) throw error; }
      await unlink(temporary); created = false;
    }
    await parent?.sync();
  } finally { await file?.close(); if (created) await unlink(temporary).catch(() => undefined); await parent?.close(); }
}

function toolEvents(harness: TrialObservationInput['harness'], stream: string) {
  let seen = false, valid = true;
  const starts = new Map<string,string>(), ends = new Map<string,{signature:string; failed:boolean}>();
  const piTypes = new Set(['session','agent_start','agent_end','turn_start','turn_end','message_start','message_update','message_end']);
  const guardFields = new Set(['command','exit_code','limit','peak_tree_rss_bytes','elapsed_seconds','cpu_affinity','disk_guard_bytes']);
  const [startType,endType,relatedPrefix] = harness === 'ernie' ? ['tool.started','tool.completed','tool.']
    : harness === 'pi' ? ['tool_execution_start','tool_execution_end','tool_execution_'] : ['tool_call','tool_result','tool_'];
  for (const line of stream.split(/\r?\n/)) {
    if (!line.trim() || harness === 'ernie' && !line.startsWith('ERNIE_EVENT_JSON ')) continue;
    let value: ObjectValue|undefined;
    try { const parsed = JSON.parse(harness === 'ernie' ? line.slice('ERNIE_EVENT_JSON '.length) : line); if (object(parsed)) value = parsed; } catch { valid = false; continue; }
    if (harness === 'ernie') {
      if (value?.schema !== 'ernie-harness.event.v1' || !object(value.event)) { valid = false; continue; }
      value = value.event;
    }
    // The trusted outer guard appends this envelope; it is not a native tool event.
    const guard = value?.resource_guard;
    if (harness !== 'ernie' && value && Object.keys(value).length === 1 && object(guard)
      && Number.isInteger(guard.exit_code) && Object.keys(guard).every(key => guardFields.has(key))) continue;
    if (!value || typeof value.type !== 'string') { valid = false; continue; }
    const start = value.type === startType, end = value.type === endType;
    const update = harness === 'pi' && value.type === 'tool_execution_update';
    seen ||= harness === 'ernie' || start || end || harness === 'pi' && piTypes.has(value.type);
    if (!start && !end && !update) { if (value.type.startsWith(relatedPrefix)) valid = false; continue; }
    const data = harness === 'ernie' ? value.data : value;
    const id = object(data) ? data[harness === 'ernie' ? 'id' : harness === 'pi' ? 'toolCallId' : 'callId'] : undefined;
    if (typeof id !== 'string' || !id) { valid = false; continue; }
    // Updates neither complete a call nor replace its required start/end pair.
    if (update) { if (!starts.has(id) || ends.has(id)) valid = false; continue; }
    const signature = JSON.stringify(data);
    if (start) { if (starts.has(id) && starts.get(id) !== signature) valid = false; starts.set(id,signature); }
    else {
      const failed = harness === 'ernie' ? (object(data.result) && typeof data.result.ok === 'boolean' ? !data.result.ok : undefined)
        : harness === 'pi' ? data.isError : data.status === 'error' ? true : data.status === 'completed' ? false : undefined;
      if (typeof failed !== 'boolean') { valid = false; continue; }
      if (!starts.has(id) || ends.has(id) && ends.get(id)!.signature !== signature) valid = false;
      ends.set(id,{signature,failed});
    }
  }
  return {schemaObserved:seen,toolCalls:ends.size,toolFailures:[...ends.values()].filter(end => end.failed).length,
    complete:seen && valid && starts.size === ends.size && [...starts.keys()].every(id => ends.has(id))};
}

/** Receipts describe observed native events, not normalized OS operations or scientific success. */
export async function captureTrialObservation(input: TrialObservationInput): Promise<TrialObservation> {
  try {
    if (!input || typeof input.root !== 'string' || !input.root.trim() || input.root.includes('\0')
      || !['development','formal','diagnostic'].includes(input.phase) || !['ernie','pi','dsh'].includes(input.harness)
      || typeof input.trialId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.trialId) || !Array.isArray(input.attempts)) throw new Error();
    const root = resolve(input.root), output = join(root,'eval',input.phase,'trajectories',input.trialId);
    if (input.traceDirectory !== undefined && (typeof input.traceDirectory !== 'string' || !input.traceDirectory.trim() || input.traceDirectory.includes('\0'))) throw new Error();
    const privateRoot = join(root,'eval/private'), traceDirectory = resolve(root,input.traceDirectory ?? join(privateRoot,'formal/traces'));
    const confined = relative(privateRoot,traceDirectory);
    if (!confined || confined === '..' || confined.startsWith('..'+sep) || isAbsolute(confined) || basename(traceDirectory) !== 'traces'
      || confined.split(sep).some(part => /credential|^(?:adapter-records|home)$/i.test(part))) throw new Error();
    const rootHandle = await directory(root); await rootHandle?.close();
    // Even an empty attempt list must not accept a symlink broker directory.
    try { const traceHandle = await directory(traceDirectory); await traceHandle?.close(); }
    catch (error) { if (!missing(error)) throw error; }
    for (const attempt of input.attempts) if (!object(attempt) || typeof attempt.status !== 'string'
      || attempt.id !== undefined && (typeof attempt.id !== 'string' || !uuid.test(attempt.id))
      || attempt.dispatchAt !== undefined && (!Number.isFinite(attempt.dispatchAt) || attempt.dispatchAt < 0)) throw new Error();
    const incomplete: string[] = [], modelRecords: (Artifact & {id:string;trialId:string;kind:string})[] = [];
    const pending: {path:string;bytes:Buffer}[] = [];
    const copy = (bytes: Buffer, group: string, name: string): Artifact => {
      const sha256 = digest(bytes), dot = name.lastIndexOf('.');
      const path = `${group}/${name.slice(0,dot)}-${sha256}${name.slice(dot)}`;
      pending.push({path:join(output,...path.split('/')),bytes}); return {path,sha256,bytes:bytes.length};
    };
    const attempts: {id:string|null;complete:boolean;missing:string[]}[] = [];
    const visited = new Set<string>(), needsRequest = new Map<string,boolean>(), needsResponse = new Set<string>();
    for (const attempt of input.attempts) if (attempt.id) {
      needsRequest.set(attempt.id,!!needsRequest.get(attempt.id)
        || attempt.dispatchAt !== undefined || !['received','rejected'].includes(attempt.status));
      if (attempt.status === 'completed') needsResponse.add(attempt.id);
    }
    for (const attempt of input.attempts) {
      if (attempt.id && visited.has(attempt.id)) continue;
      const entry = {id:attempt.id ?? null,complete:false,missing:[] as string[]}; attempts.push(entry);
      if (!attempt.id) { entry.missing.push('attempt-id'); continue; } visited.add(attempt.id);
      const found = new Set<string>();
      for (const kind of ['request','response','failure']) {
        const bytes = await read(join(traceDirectory,`${attempt.id}.${kind}.json`));
        if (!bytes) continue;
        const record = json(bytes);
        if (!record || record.schemaVersion !== 1 || record.attemptId !== attempt.id || record.trialId !== input.trialId
          || record.kind !== kind || typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt)) || !Object.hasOwn(record,'data')) {
          entry.missing.push('invalid-' + kind); continue;
        }
        found.add(kind); modelRecords.push({...copy(bytes,`provider/${attempt.id}`,kind+'.json'),id:attempt.id,trialId:input.trialId,kind});
      }
      const early = !needsRequest.get(attempt.id);
      const complete = needsResponse.has(attempt.id) ? found.has('request') && found.has('response')
        : early && found.has('failure') || found.has('request') && (found.has('response') || found.has('failure'));
      if (!complete) entry.missing.push('required-provider-records');
      entry.complete = entry.missing.length === 0;
    }
    const providerComplete = attempts.length > 0 && attempts.every(attempt => attempt.complete);
    if (!providerComplete) incomplete.push('provider-records-incomplete');
    const nativeRecords: {id:string;files:Artifact[];complete:boolean;observed:ReturnType<typeof toolEvents>|null}[] = [];
    const nativeRoot = join(root,'eval/private/adapter-records',input.trialId);
    for (const run of await names(nativeRoot)) {
      if (!run.startsWith(input.harness + '-')) continue;
      if (!new RegExp(`^${input.harness}-[A-Za-z0-9_-]+$`).test(run)) throw new Error();
      const runDir = join(nativeRoot,run), sanitized = join(runDir,'sanitized');
      const manifest = json(await read(join(runDir,'manifest.json')));
      const entry = {id:run,files:[] as Artifact[],complete:false,observed:null as ReturnType<typeof toolEvents>|null}; nativeRecords.push(entry);
      if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== 'native-trajectory' || manifest.trialId !== input.trialId
        || manifest.harness !== input.harness || !Array.isArray(manifest.nativeFiles)) { incomplete.push('native-manifest-missing-or-invalid'); continue; }
      const descriptors: [string,any][] = [['stdout',manifest.stdout],['stderr',manifest.stderr],...manifest.nativeFiles.map((file:any,index:number) => [`native-${index}`,file] as [string,any])];
      // Validate every manifest path before reading any referenced bytes or publishing copies.
      for (const [,file] of descriptors) if (object(file) && file.sanitizedPath !== undefined) {
        if (typeof file.sanitizedPath !== 'string' || !isAbsolute(file.sanitizedPath) || file.sanitizedPath.includes('\0')) throw new Error();
        const confined = relative(sanitized,resolve(file.sanitizedPath));
        if (!confined || confined === '..' || confined.startsWith('..'+sep) || isAbsolute(confined)) throw new Error();
      }
      let complete = manifest.complete === true && manifest.nativeExportFailed === false;
      const streams: Record<string,string> = {};
      for (const [name,file] of descriptors) {
        if (!object(file)) { complete = false; continue; }
        if (!file.sanitizedPath) { if (name === 'stdout' || name === 'stderr' || typeof file.skipped !== 'string') complete = false; continue; }
        const expected = file.sanitizedSha256 ?? file.sha256;
        const bytes = await read(resolve(file.sanitizedPath));
        if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected) || !bytes || digest(bytes) !== expected.toLowerCase()) { complete = false; continue; }
        let decoded: string; try { decoded = text(bytes); } catch { complete = false; continue; }
        entry.files.push(copy(bytes,`native/${run}`,name+'.txt'));
        if (name === 'stdout' || name === 'stderr') { streams[name] = decoded; if (file.truncated !== false) complete = false; }
        else if (file.truncated === true) complete = false;
      }
      entry.observed = toolEvents(input.harness,streams[input.harness === 'ernie' ? 'stderr' : 'stdout'] ?? '');
      entry.complete = complete && streams.stdout !== undefined && streams.stderr !== undefined && entry.observed.complete;
      if (!entry.complete) incomplete.push('native-tool-observations-incomplete');
    }
    const toolMetricsComplete = nativeRecords.length > 0 && nativeRecords.every(record => record.complete);
    if (!nativeRecords.length) incomplete.push('native-records-missing');
    const toolCalls = toolMetricsComplete ? nativeRecords.reduce((sum,record) => sum + record.observed!.toolCalls,0) : null;
    const toolFailures = toolMetricsComplete ? nativeRecords.reduce((sum,record) => sum + record.observed!.toolFailures,0) : null;
    const toolMetricsSource = input.harness === 'dsh' ? 'native-tool-events:dsh:headless-json' : `native-tool-events:${input.harness === 'ernie' ? 'ernie-harness.event.v1:stderr' : 'pi:stdout'}`;
    const receipt = {schemaVersion:1,phase:input.phase,trialId:input.trialId,harness:input.harness,providerComplete,
      toolCalls,toolFailures,toolMetricsComplete,toolMetricsSource,toolMetricUnits:'native-tool-events',attempts,modelRecords,nativeRecords,incomplete:[...new Set(incomplete)]};
    const bytes = Buffer.from(JSON.stringify(receipt,null,2)+'\n'), receiptSha256 = digest(bytes);
    const receiptPath = join(output,`receipt-${receiptSha256}.json`);
    for (const file of pending) await publish(file.path,file.bytes);
    await publish(receiptPath,bytes);
    await publish(join(output,'index.json'),Buffer.from(JSON.stringify({schemaVersion:1,trialId:input.trialId,harness:input.harness,
      receiptPath:basename(receiptPath),receiptSha256,providerComplete,toolCalls,toolFailures,toolMetricsComplete,toolMetricsSource},null,2)+'\n'),true);
    return {receiptPath,receiptSha256,providerComplete,toolCalls,toolFailures,toolMetricsComplete,toolMetricsSource};
  } catch { throw new Error('Unable to capture trial observation'); }
}
