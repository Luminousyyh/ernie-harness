import {afterEach, describe, expect, it} from 'vitest';
import {createHash, randomUUID} from 'node:crypto';
import {lstat, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {captureTrialObservation, type TrialObservationInput} from '../src/benchmark/observations.js';

const roots: string[] = [];
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const event = (type: string, data: unknown = {}) => 'ERNIE_EVENT_JSON ' + JSON.stringify({schema:'ernie-harness.event.v1',event:{type,data}}) + '\n';
const pi = (value: unknown) => JSON.stringify(value) + '\n';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
async function fixture(harness: 'ernie'|'pi'|'dsh' = 'ernie') {
  const root = await mkdtemp(join(tmpdir(),'ernie-observations-')); roots.push(root);
  const input: TrialObservationInput = {root,phase:'development',trialId:'trial_1',harness,attempts:[]};
  return {root,input};
}
async function json(path: string, value: unknown) { await mkdir(dirname(path),{recursive:true}); await writeFile(path,JSON.stringify(value)); }
async function trace(input: TrialObservationInput, id: string, kind: string, override = {}) {
  const path = join(input.traceDirectory ?? join(input.root,'eval/private/formal/traces'),`${id}.${kind}.json`);
  await json(path,{schemaVersion:1,attemptId:id,trialId:input.trialId,kind,recordedAt:'2026-11-13T00:00:00.000Z',data:{text:'[REDACTED]',reasoning_details:[{type:'reasoning.encrypted',data:'opaque+/=='}]},...override});
  return path;
}
async function native(input: TrialObservationInput, suffix: string, stdout = '', stderr = '') {
  const dir = join(input.root,'eval/private/adapter-records',input.trialId,`${input.harness}-${suffix}`);
  const sanitized = join(dir,'sanitized'); await mkdir(sanitized,{recursive:true});
  type Stream = {sanitizedPath:string;sha256:string;sanitizedSha256:string;truncated:boolean};
  const streams = {} as Record<'stdout'|'stderr',Stream>;
  for (const [name,text] of Object.entries({stdout,stderr})) {
    const path = join(sanitized,name+'.log'); await writeFile(path,text);
    streams[name as 'stdout'|'stderr'] = {sanitizedPath:path,sha256:sha(text),sanitizedSha256:sha(text),truncated:false};
  }
  const manifest = {schemaVersion:1,kind:'native-trajectory',trialId:input.trialId,harness:input.harness,
    home:join(dir,'home'),complete:true,nativeExportFailed:false,...streams,nativeFiles:[] as Record<string,unknown>[]};
  await json(join(dir,'manifest.json'),manifest);
  return {dir,sanitized,manifest,save: () => json(join(dir,'manifest.json'),manifest)};
}
async function receipt(result: Awaited<ReturnType<typeof captureTrialObservation>>) {
  const bytes = await readFile(result.receiptPath);
  expect(sha(bytes)).toBe(result.receiptSha256);
  expect(result.receiptPath).toContain(result.receiptSha256);
  return JSON.parse(bytes.toString('utf8'));
}
async function safeFailure(input: TrialObservationInput) {
  const error = await captureTrialObservation(input).then(() => undefined,error => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error) + error.stack).not.toContain('PRIVATE_CREDENTIAL_MARKER');
  expect(error).not.toHaveProperty('cause');
  return error;
}

describe('sanitized trial observations', () => {
  it('copies exact provider bytes, verifies identity, and publishes an immutable digest receipt and index', async () => {
    const {input} = await fixture(); const id = randomUUID(); input.attempts = [{id,status:'completed',dispatchAt:1}];
    const request = await trace(input,id,'request'); const response = await trace(input,id,'response');
    const before = structuredClone(input); const original = await readFile(response);
    const result = await captureTrialObservation(input); const record = await receipt(result);
    expect(input).toEqual(before); expect(result.providerComplete).toBe(true);
    expect(result.toolCalls).toBeNull(); expect(result.toolFailures).toBeNull(); expect(result.toolMetricsComplete).toBe(false);
    expect(record.modelRecords).toHaveLength(2);
    for (const file of record.modelRecords) {
      expect(file).toMatchObject({id,trialId:input.trialId});
      expect(file.path).toMatch(/\.json$/);
      const bytes = await readFile(join(dirname(result.receiptPath),file.path));
      expect(sha(bytes)).toBe(file.sha256);
      expect(bytes).toEqual(await readFile(file.kind === 'request' ? request : response));
    }
    expect(await readFile(response)).toEqual(original);
    const index = JSON.parse(await readFile(join(dirname(result.receiptPath),'index.json'),'utf8'));
    expect(index.receiptSha256).toBe(result.receiptSha256);
    expect(index.receiptPath).toBe(result.receiptPath.split(/[\\/]/).at(-1));
    const again = await captureTrialObservation(input);
    expect(again.receiptPath).toBe(result.receiptPath);
    expect(await readFile(result.receiptPath)).toEqual(await readFile(again.receiptPath));
  });

  it('isolates diagnostic receipts and uses a confined controller trace override', async () => {
    const {input} = await fixture(); input.phase = 'diagnostic';
    input.traceDirectory = join(input.root,'eval/private/obs-v2-fixture/traces');
    const id = randomUUID(); input.attempts = [{id,status:'completed',dispatchAt:1}];
    await trace(input,id,'request'); await trace(input,id,'response'); await native(input,'run','',event('run.started'));
    const before = structuredClone(input), result = await captureTrialObservation(input); const record = await receipt(result);
    expect(result.receiptPath.startsWith(join(input.root,'eval/diagnostic/trajectories',input.trialId))).toBe(true);
    expect(record.phase).toBe('diagnostic'); expect(result.providerComplete).toBe(true); expect(record.modelRecords).toHaveLength(2);
    expect(input).toEqual(before);
    for (const path of ['eval/formal/trajectories','eval/development/trajectories','eval/private/formal/traces']) {
      await expect(lstat(join(input.root,path))).rejects.toMatchObject({code:'ENOENT'});
    }
  });

  it.each(['outside-private','private-root','wrong-basename','credential','credentials','adapter-records','home','HOME'])(
    'rejects unsafe diagnostic trace override %s before publishing', async condition => {
      const {input} = await fixture(); input.phase = 'diagnostic';
      input.traceDirectory = condition === 'outside-private' ? join(input.root,'eval/other/traces')
        : condition === 'private-root' ? join(input.root,'eval/private')
        : condition === 'wrong-basename' ? join(input.root,'eval/private/controller/key')
        : join(input.root,'eval/private',condition,'traces');
      await safeFailure(input); expect(await readdir(input.root)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== 'linux')('rejects a symlink trace override even with no attempts', async () => {
    const {input} = await fixture(); input.phase = 'diagnostic';
    const privateRoot = join(input.root,'eval/private'); await mkdir(privateRoot,{recursive:true});
    const target = join(input.root,'PRIVATE_CREDENTIAL_MARKER'); await mkdir(target);
    input.traceDirectory = join(privateRoot,'traces'); await symlink(target,input.traceDirectory);
    await safeFailure(input); expect(await readdir(target)).toEqual([]);
  });

  it('keeps prior receipts and trial-grouped copies when subsequent retries appear', async () => {
    const {input} = await fixture();
    const first = await native(input,'first','',event('tool.started',{id:'same'}) + event('tool.completed',{id:'same',result:{ok:false}}));
    const one = await captureTrialObservation(input); const original = await readFile(one.receiptPath);
    await native(input,'retry','',event('tool.started',{id:'same'}) + event('tool.completed',{id:'same',result:{ok:true}}));
    const two = await captureTrialObservation(input); const record = await receipt(two);
    expect(two.receiptPath).not.toBe(one.receiptPath); expect(await readFile(one.receiptPath)).toEqual(original);
    expect(two).toMatchObject({toolCalls:2,toolFailures:1,toolMetricsComplete:true});
    expect(record.nativeRecords).toHaveLength(2);
    expect(JSON.stringify(record)).not.toContain(first.dir);
  });

  it('counts unique ERNIE tool completions and explicit failures without counting stderr error words', async () => {
    const {input} = await fixture();
    const started = event('tool.started',{id:'one'}), ended = event('tool.completed',{id:'one',result:{ok:false}});
    await native(input,'run','ordinary stdout',event('run.started') + started + started + ended + ended +
      event('tool.started',{id:'two'}) + event('tool.completed',{id:'two',result:{ok:true}}) + 'ERROR failed text\n');
    expect(await captureTrialObservation(input)).toMatchObject({toolCalls:2,toolFailures:1,toolMetricsComplete:true});
  });

  it('counts only Pi root native tool events and explicit isError', async () => {
    const {input} = await fixture('pi');
    await native(input,'run',pi({type:'session'}) + pi({type:'tool_execution_start',toolCallId:'x'}) +
      pi({type:'tool_execution_end',toolCallId:'x',isError:true}) + pi({type:'tool_execution_start',toolCallId:'y'}) +
      pi({type:'tool_execution_end',toolCallId:'y',isError:false}) + pi({type:'message_end',message:{type:'tool_execution_end',toolCallId:'nested',isError:true}}),'ERROR failure\n');
    const result = await captureTrialObservation(input);
    expect(result).toMatchObject({toolCalls:2,toolFailures:1,toolMetricsComplete:true});
    expect(result.toolMetricsSource).toContain('native-tool-events');
  });

  it.each(['update','guard','both'])('counts Pi completions with the expected %s records', async extra => {
    const {input} = await fixture('pi');
    const update = (id: string) => extra === 'guard' ? '' : pi({type:'tool_execution_update',toolCallId:id,toolName:'bash',partialResult:{content:[{type:'text',text:'partial output'}]}});
    const footer = extra === 'update' ? '' : pi({resource_guard:{command:['node','native-cli.js'],exit_code:0,limit:null,
      peak_tree_rss_bytes:4096,elapsed_seconds:0.25,cpu_affinity:[0,1],disk_guard_bytes:200*1024**3}});
    await native(input,'run',pi({type:'session'}) + pi({type:'tool_execution_start',toolCallId:'failed'}) + update('failed') +
      pi({type:'tool_execution_end',toolCallId:'failed',isError:true}) + pi({type:'tool_execution_start',toolCallId:'ok'}) + update('ok') +
      pi({type:'tool_execution_end',toolCallId:'ok',isError:false}) + footer);
    expect(await captureTrialObservation(input)).toMatchObject({toolCalls:2,toolFailures:1,toolMetricsComplete:true});
  });

  it.each(['missing-end-id','missing-end','unknown-object','bad-guard','extra-guard-field','unknown-guard-field','unknown-update-id','unknown-tool-event'])(
    'keeps malformed Pi %s observations unknown', async condition => {
      const {input} = await fixture('pi');
      let tail = pi({type:'tool_execution_end',toolCallId:'x',isError:false});
      if (condition === 'missing-end-id') tail = pi({type:'tool_execution_end',isError:false});
      if (condition === 'missing-end') tail = '';
      if (condition === 'unknown-object') tail += pi({unrecognized_footer:{exit_code:0}});
      if (condition === 'bad-guard') tail += pi({resource_guard:{exit_code:'0'}});
      if (condition === 'extra-guard-field') tail += pi({resource_guard:{exit_code:0},unrecognized:true});
      if (condition === 'unknown-guard-field') tail += pi({resource_guard:{exit_code:0,unrecognized:true}});
      if (condition === 'unknown-update-id') tail += pi({type:'tool_execution_update',toolCallId:'other'});
      if (condition === 'unknown-tool-event') tail += pi({type:'tool_execution_unrecognized',toolCallId:'x'});
      await native(input,'run',pi({type:'session'}) + pi({type:'tool_execution_start',toolCallId:'x'}) +
        pi({type:'tool_execution_update',toolCallId:'x'}) + tail + pi({resource_guard:{exit_code:0}}));
      expect(await captureTrialObservation(input)).toMatchObject({toolCalls:null,toolFailures:null,toolMetricsComplete:false});
    },
  );

  it('does not use a guard footer alone as proof of the Pi native schema', async () => {
    const {input} = await fixture('pi'); await native(input,'run',pi({resource_guard:{exit_code:0}}));
    expect(await captureTrialObservation(input)).toMatchObject({toolCalls:null,toolFailures:null,toolMetricsComplete:false});
  });

  it.each(['ernie','pi'] as const)('proves zero tools only from a recognized complete %s schema', async harness => {
    const {input} = await fixture(harness);
    await native(input,'run',harness === 'pi' ? pi({type:'session'}) : '',harness === 'ernie' ? event('run.started') : '');
    expect(await captureTrialObservation(input)).toMatchObject({providerComplete:false,toolCalls:0,toolFailures:0,toolMetricsComplete:true});
  });

  async function actualDshEvents(): Promise<Record<string,any>[]> {
    const source = JSON.parse(await readFile(new URL('../eval/observability-v2-native-event-samples-20261113.json',import.meta.url),'utf8'));
    expect(source.schemaVersion).toBe(1);
    expect(source.samples.dsh).toHaveLength(4);
    return source.samples.dsh;
  }

  it('counts the actual sanitized V2 DSH sample as two completions and one explicit failure', async () => {
    const {input} = await fixture('dsh'); const events = await actualDshEvents();
    const before = structuredClone(events);
    await native(input,'actual-v2',events.map(pi).join('') + pi({resource_guard:{exit_code:0}}),'Error words do not define tool failures\n');
    const result = await captureTrialObservation(input); const record = await receipt(result);
    expect(result).toMatchObject({toolCalls:2,toolFailures:1,toolMetricsComplete:true,toolMetricsSource:'native-tool-events:dsh:headless-json'});
    expect(record.nativeRecords[0].observed.schemaObserved).toBe(true);
    expect(events).toEqual(before);
  });

  it('pairs interleaved DSH calls by callId and deduplicates repeated events within each run', async () => {
    const {input} = await fixture('dsh'); const [first,second,failed,completed] = await actualDshEvents();
    const stream = [first,second,completed,failed,first,completed,failed].map(pi).join('');
    await native(input,'first',stream); await native(input,'retry',stream);
    expect(await captureTrialObservation(input)).toMatchObject({toolCalls:4,toolFailures:2,toolMetricsComplete:true});
  });

  it.each([undefined,null,'failed','success','pending',0])('keeps unknown DSH status %s incomplete', async status => {
    const {input} = await fixture('dsh'); const events = await actualDshEvents(); events[2].status = status;
    await native(input,'run',events.map(pi).join(''));
    expect(await captureTrialObservation(input)).toMatchObject({toolCalls:null,toolFailures:null,toolMetricsComplete:false});
  });

  it('uses DSH status alone and does not infer failure from Error text in a completed result', async () => {
    const {input} = await fixture('dsh'); const events = await actualDshEvents(); events[2].status = 'completed';
    await native(input,'run',events.map(pi).join(''));
    expect(await captureTrialObservation(input)).toMatchObject({toolCalls:2,toolFailures:0,toolMetricsComplete:true});
  });

  it.each(['missing-end','missing-id','missing-start','unknown-tool-event','unknown-footer'])(
    'keeps malformed DSH %s observations unknown', async condition => {
      const {input} = await fixture('dsh'); const events = await actualDshEvents();
      if (condition === 'missing-end') events.pop();
      if (condition === 'missing-id') delete events[2].callId;
      if (condition === 'missing-start') events.shift();
      if (condition === 'unknown-tool-event') events.push({type:'tool_result_unrecognized',callId:'unknown'});
      if (condition === 'unknown-footer') events.push({unrecognized:{exit_code:0}});
      await native(input,'run',events.map(pi).join('') + pi({resource_guard:{exit_code:0}}));
      expect(await captureTrialObservation(input)).toMatchObject({toolCalls:null,toolFailures:null,toolMetricsComplete:false});
    },
  );

  it('does not prove zero DSH tools from a terminal-looking header or guard without a recognized tool event', async () => {
    const {input} = await fixture('dsh');
    await native(input,'run',pi({type:'session'}) + pi({type:'completed'}) + pi({resource_guard:{exit_code:0}}));
    expect(await captureTrialObservation(input)).toMatchObject({toolCalls:null,toolFailures:null,toolMetricsComplete:false});
  });

  it('does not infer DSH metrics from Pi-shaped JSON or error text', async () => {
    const {input} = await fixture('dsh');
    await native(input,'run',pi({type:'session'}) + pi({type:'tool_execution_start',toolCallId:'x'}) + pi({type:'tool_execution_end',toolCallId:'x',isError:false}),'ERROR failed\n');
    expect(await captureTrialObservation(input)).toMatchObject({toolCalls:null,toolFailures:null,toolMetricsComplete:false});
  });

  it.each(['missing','schema-absent','truncated','unmatched','malformed','bad-result','conflict','incomplete','hash-mismatch'])('keeps %s tool evidence unknown instead of zero', async condition => {
    const {input} = await fixture();
    if (condition !== 'missing') {
      let text = condition === 'schema-absent' ? 'ERROR failed\n' : event('run.started');
      if (condition === 'unmatched') text += event('tool.started',{id:'x'});
      if (condition === 'malformed') text += 'ERNIE_EVENT_JSON {bad\n';
      if (condition === 'bad-result') text += event('tool.started',{id:'x'}) + event('tool.completed',{id:'x',result:{ok:'false'}});
      if (condition === 'conflict') text += event('tool.started',{id:'x'}) + event('tool.completed',{id:'x',result:{ok:true}}) + event('tool.completed',{id:'x',result:{ok:false}});
      const run = await native(input,'run','',text);
      if (condition === 'truncated') (run.manifest.stderr as any).truncated = true;
      if (condition === 'incomplete') run.manifest.complete = false;
      if (condition === 'hash-mismatch') (run.manifest.stderr as any).sanitizedSha256 = '0'.repeat(64);
      await run.save();
    }
    const result = await captureTrialObservation(input); const record = await receipt(result);
    expect(result).toMatchObject({toolCalls:null,toolFailures:null,toolMetricsComplete:false});
    expect(record.incomplete.length).toBeGreaterThan(0);
  });

  it('requires each provider attempt, allows pre-parse failures, and leaves pending/missing identities incomplete', async () => {
    const {input} = await fixture(); const id = randomUUID();
    await trace(input,id,'failure'); input.attempts = [{id,status:'received'}];
    expect((await captureTrialObservation(input)).providerComplete).toBe(true);
    input.attempts = [{id,status:'rejected'}]; expect((await captureTrialObservation(input)).providerComplete).toBe(true);
    input.attempts = [{id,status:'completed'}]; expect((await captureTrialObservation(input)).providerComplete).toBe(false);
    await trace(input,id,'request'); expect((await captureTrialObservation(input)).providerComplete).toBe(false);
    await trace(input,id,'response'); expect((await captureTrialObservation(input)).providerComplete).toBe(true);
    input.attempts.push({status:'received'}); expect((await captureTrialObservation(input)).providerComplete).toBe(false);
    input.attempts = []; expect((await captureTrialObservation(input)).providerComplete).toBe(false);
  });

  it.each([false,true])('requires a response for completed attempts regardless of duplicate metadata order: %s', async reverse => {
    const {input} = await fixture(); const id = randomUUID();
    await trace(input,id,'request'); await trace(input,id,'failure');
    input.attempts = [{id,status:'received'},{id,status:'completed',dispatchAt:1}];
    if (reverse) input.attempts.reverse();
    const result = await captureTrialObservation(input); const record = await receipt(result);
    expect(result.providerComplete).toBe(false); expect(record.attempts[0].complete).toBe(false);
    expect(record.attempts[0].missing).toContain('required-provider-records');
    await trace(input,id,'response'); expect((await captureTrialObservation(input)).providerComplete).toBe(true);
  });

  it.each(['uncertain','rejected'])('retains request plus failure as valid evidence for %s attempts', async status => {
    const {input} = await fixture(); const id = randomUUID(); input.attempts = [{id,status,dispatchAt:1}];
    await trace(input,id,'request'); await trace(input,id,'failure');
    expect((await captureTrialObservation(input)).providerComplete).toBe(true);
  });

  it('does not let duplicate attempt metadata weaken dispatched evidence requirements', async () => {
    const {input} = await fixture(); const id = randomUUID(); await trace(input,id,'failure');
    input.attempts = [{id,status:'received'},{id,status:'completed',dispatchAt:1}];
    const result = await captureTrialObservation(input); const record = await receipt(result);
    expect(result.providerComplete).toBe(false); expect(record.modelRecords).toHaveLength(1);
  });

  it('marks a missing manifest, missing sanitized file or malformed export inventory incomplete', async () => {
    for (const condition of ['manifest','file','inventory']) {
      const {input} = await fixture(); const run = await native(input,'run','',event('run.started'));
      if (condition === 'manifest') await rm(join(run.dir,'manifest.json'));
      if (condition === 'file') await rm(join(run.sanitized,'stdout.log'));
      if (condition === 'inventory') { run.manifest.nativeFiles.push(null as any); await run.save(); }
      expect(await captureTrialObservation(input)).toMatchObject({toolCalls:null,toolFailures:null,toolMetricsComplete:false});
    }
  });

  it('does not publish trace files with mismatched trial/attempt metadata or malformed JSON', async () => {
    const {input} = await fixture(); const id = randomUUID(); input.attempts = [{id,status:'completed'}];
    await trace(input,id,'request',{trialId:'other'}); await trace(input,id,'response',{attemptId:randomUUID()});
    const path = await trace(input,id,'failure'); await writeFile(path,'{incomplete');
    const result = await captureTrialObservation(input); const record = await receipt(result);
    expect(result.providerComplete).toBe(false); expect(record.modelRecords).toEqual([]);
  });

  it('copies sanitized native text using its sanitized hash and leaves raw HOME and binary files private', async () => {
    const {input} = await fixture('pi'); const run = await native(input,'run',pi({type:'session'}));
    await mkdir(join(run.dir,'home')); await writeFile(join(run.dir,'home','key'),'PRIVATE_CREDENTIAL_MARKER');
    const text = '{"message":"[REDACTED]"}\n'; const path = join(run.sanitized,'native-00000.jsonl'); await writeFile(path,text);
    run.manifest.nativeFiles.push({relativePath:'.pi/session.jsonl',sanitizedPath:path,sha256:sha('original-unsanitized'),sanitizedSha256:sha(text)},
      {relativePath:'state.db',skipped:'binary-retained-privately'});
    await run.save(); const result = await captureTrialObservation(input); const record = await receipt(result);
    const files = record.nativeRecords[0].files;
    expect(files).toHaveLength(3);
    for (const file of files) { const bytes = await readFile(join(dirname(result.receiptPath),file.path)); expect(sha(bytes)).toBe(file.sha256); expect(bytes.toString()).not.toContain('PRIVATE_CREDENTIAL_MARKER'); }
    expect(JSON.stringify(record)).not.toContain('home');
  });

  it.each(['trial','attempt','phase','harness'])('rejects invalid %s path components with a generic error', async part => {
    const {input,root} = await fixture();
    if (part === 'trial') input.trialId = '../PRIVATE_CREDENTIAL_MARKER';
    if (part === 'attempt') input.attempts = [{id:'../../PRIVATE_CREDENTIAL_MARKER',status:'completed'}];
    if (part === 'phase') input.phase = '../PRIVATE_CREDENTIAL_MARKER' as any;
    if (part === 'harness') input.harness = '../PRIVATE_CREDENTIAL_MARKER' as any;
    await safeFailure(input); expect(await readdir(root)).toEqual([]);
  });

  it.each(['outside','raw-home','sibling'])('rejects malicious %s manifest paths before copying their contents', async attack => {
    const {input} = await fixture(); const run = await native(input,'run','',event('run.started'));
    const key = attack === 'outside' ? join(input.root,'PRIVATE_CREDENTIAL_MARKER') : attack === 'raw-home' ? join(run.dir,'home','key') : join(run.dir,'sanitized-other','key');
    await mkdir(dirname(key),{recursive:true}); await writeFile(key,'PRIVATE_CREDENTIAL_MARKER');
    (run.manifest.stdout as any).sanitizedPath = key; (run.manifest.stdout as any).sha256 = sha('PRIVATE_CREDENTIAL_MARKER');
    await run.save(); await safeFailure(input);
    await expect(lstat(join(input.root,'eval/development/trajectories'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await readFile(key,'utf8')).toBe('PRIVATE_CREDENTIAL_MARKER');
  });

  it('never overwrites a tampered immutable receipt', async () => {
    const {input} = await fixture(); const result = await captureTrialObservation(input);
    await writeFile(result.receiptPath,'tampered'); await safeFailure(input);
    expect(await readFile(result.receiptPath,'utf8')).toBe('tampered');
  });

  it.skipIf(process.platform !== 'linux')('does not read a credential referenced by an escaping manifest path', async () => {
    const {input} = await fixture(); const run = await native(input,'run','',event('run.started'));
    const key = join(input.root,'PRIVATE_CREDENTIAL_MARKER'); await writeFile(key,'PRIVATE_CREDENTIAL_MARKER'); await utimes(key,1,1);
    const before = (await stat(key)).atimeMs;
    run.manifest.stdout.sanitizedPath = key; run.manifest.stdout.sha256 = sha('PRIVATE_CREDENTIAL_MARKER'); await run.save();
    await safeFailure(input); expect((await stat(key)).atimeMs).toBe(before);
  });

  it.skipIf(process.platform !== 'linux')('rejects source/ancestor/output symlinks and hardlinks without copying credential bytes', async () => {
    for (const attack of ['source','hardlink','ancestor','output','target']) {
      const {input} = await fixture(); const run = await native(input,'run','',event('run.started'));
      const key = join(input.root,'PRIVATE_CREDENTIAL_MARKER'); await writeFile(key,'PRIVATE_CREDENTIAL_MARKER');
      if (attack === 'source') { await rm(join(run.sanitized,'stdout.log')); await symlink(key,join(run.sanitized,'stdout.log')); }
      if (attack === 'hardlink') { await rm(join(run.sanitized,'stdout.log')); await link(key,join(run.sanitized,'stdout.log')); }
      if (attack === 'ancestor') { await rm(run.sanitized,{recursive:true}); await symlink(input.root,run.sanitized); }
      if (attack === 'output') { const output = join(input.root,'eval/development'); await mkdir(dirname(output),{recursive:true}); await symlink(input.root,output); }
      if (attack === 'target') { const output = join(input.root,'eval/development/trajectories',input.trialId); await mkdir(output,{recursive:true}); await symlink(key,join(output,'index.json')); }
      await safeFailure(input); expect(await readFile(key,'utf8')).toBe('PRIVATE_CREDENTIAL_MARKER');
    }
  });
});
