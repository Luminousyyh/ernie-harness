import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureNativeProcess, createPrivateTrialHome, sanitizeNativeText } from '../src/benchmark/adapters.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'native-evidence-'))); roots.push(root);
  const workspace=join(root,'eval','trials','dev-test','workspace'); await mkdir(workspace,{recursive:true});
  return {root,workspace};
}
describe('private native trajectory retention', () => {
  it('creates a fresh isolated HOME for every launch and rejects paths outside the trial', async () => {
    const {root,workspace}=await fixture();
    const first=await createPrivateTrialHome(root,workspace,'ernie');
    await writeFile(join(first.home,'prior-session'),'not inherited');
    const second=await createPrivateTrialHome(root,workspace,'ernie');
    expect(first.home).not.toBe(second.home);
    expect(second.home.startsWith(join(root,'eval','private','adapter-records')+requireSeparator())).toBe(true);
    expect(await readdir(second.home)).toEqual([]);
    await expect(createPrivateTrialHome(root,join(root,'eval','private','credential'),'ernie')).rejects.toThrow(/trial/);
  });
  it('rejects a redirected private-control parent before creating a HOME', async () => {
    const {root,workspace}=await fixture();const outside=join(root,'outside');await mkdir(outside);
    await symlink(outside,join(root,'eval','private'),process.platform==='win32'?'junction':'dir');
    await expect(createPrivateTrialHome(root,workspace,'pi')).rejects.toThrow(/unsafe/);
    expect(await readdir(outside)).toEqual([]);
  });
  it('retains startup-failure evidence and does not pretend a failed launch completed', async () => {
    const {root,workspace}=await fixture();const record=await createPrivateTrialHome(root,workspace,'ernie');
    await expect(captureNativeProcess([join(root,'missing-executable')],{...record,cwd:root,token:'trial-visible-token',harness:'ernie'})).rejects.toThrow(/capture failed/);
    const manifest=JSON.parse(await readFile(join(record.recordDir,'manifest.json'),'utf8'));
    expect(manifest.spawnError).toBe(true);expect(manifest.complete).toBe(false);
  });
  it('retains early output beyond the 1 MiB tail, separates stderr, and redacts split credentials', async () => {
    const {root,workspace}=await fixture(); const record=await createPrivateTrialHome(root,workspace,'pi');
    await mkdir(join(record.home,'.pi','agent','sessions'),{recursive:true});
    await writeFile(join(record.home,'.pi','agent','sessions','one.jsonl'),'session trial-visible-token sk-short-example\n');
    const script="process.stdout.write('EARLY\\ntrial-visible-');setTimeout(()=>{process.stdout.write('token sk-short-example\\n'+'x'.repeat(1100000));process.stderr.write('TOOL_FAILED\\n')},10)";
    const result=await captureNativeProcess([process.execPath,'-e',script],{...record,cwd:root,token:'trial-visible-token',harness:'pi'});
    expect(result.exitCode).toBe(0); expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024*1024);
    const manifest=JSON.parse(await readFile(join(record.recordDir,'manifest.json'),'utf8'));
    expect(await readFile(manifest.stdout.path,'utf8')).toContain('EARLY');
    expect(await readFile(manifest.stdout.path,'utf8')).not.toContain('trial-visible-token');
    expect(await readFile(manifest.stdout.path,'utf8')).not.toContain('sk-short-example');
    expect(manifest.stdout).not.toHaveProperty('rawPath');
    const sanitized=await readFile(manifest.stdout.sanitizedPath,'utf8');
    expect(sanitized).toContain('EARLY'); expect(sanitized).not.toContain('trial-visible-token');expect(sanitized).not.toContain('sk-short-example');
    expect(await readFile(manifest.stderr.sanitizedPath,'utf8')).toContain('TOOL_FAILED');
    expect(manifest.toolFailures.value).toBeNull();expect(manifest.toolFailures.provenance).toContain('native');
    const native=manifest.nativeFiles.find((f:any)=>f.relativePath.endsWith('one.jsonl'));
    expect(await readFile(native.sanitizedPath,'utf8')).toContain('[REDACTED]');
    expect(manifest.stdout.truncated).toBe(false);expect(manifest.complete).toBe(true);
  });
  it('writes no stream log until the complete in-memory capture can be sanitized', async () => {
    const {root,workspace}=await fixture();const record=await createPrivateTrialHome(root,workspace,'ernie');
    const pending=captureNativeProcess([process.execPath,'-e',"process.stdout.write('trial-visible-');setTimeout(()=>process.stdout.write('token sk-short-example'),400)"],{...record,cwd:root,token:'trial-visible-token',harness:'ernie'});
    for(let attempt=0;attempt<100;attempt++){
      if((await readdir(record.recordDir)).includes('capture-started.json'))break;
      await new Promise(done=>setTimeout(done,2));
    }
    try {
      expect(await readdir(record.recordDir)).not.toContain('stdout.log');
      expect(await readdir(record.recordDir)).not.toContain('stderr.log');
      expect(await readdir(join(record.recordDir,'sanitized'))).toEqual([]);
    } finally {await pending;}
    const manifest=JSON.parse(await readFile(join(record.recordDir,'manifest.json'),'utf8'));
    expect(await readFile(manifest.stdout.path,'utf8')).toBe('[REDACTED] [REDACTED]');
  });
  it('enforces independent byte caps and marks incomplete records explicitly', async () => {
    const {root,workspace}=await fixture(); const record=await createPrivateTrialHome(root,workspace,'dsh');
    await captureNativeProcess([process.execPath,'-e',"process.stdout.write('a'.repeat(100));process.stderr.write('b'.repeat(80))"],{...record,cwd:root,token:'trial-visible-token',harness:'dsh',limitBytes:32});
    const manifest=JSON.parse(await readFile(join(record.recordDir,'manifest.json'),'utf8'));
    expect(manifest.stdout.retainedBytes).toBe(32);expect(manifest.stdout.observedBytes).toBe(100);
    expect(manifest.stderr.retainedBytes).toBe(32);expect(manifest.stderr.observedBytes).toBe(80);
    expect(manifest.stdout.truncated).toBe(true);expect(manifest.complete).toBe(false);
  });
  it.skipIf(process.platform!=='linux')('never follows an agent-created file or directory symlink when exporting HOME', async () => {
    const {root,workspace}=await fixture(); const record=await createPrivateTrialHome(root,workspace,'ernie');
    const secret=join(root,'private-marker');await writeFile(secret,'HOST_PRIVATE_MARKER');
    await symlink(secret,join(record.home,'stolen.jsonl'));
    await symlink(root,join(record.home,'escape'));
    await writeFile(join(record.home,'benign.jsonl'),'native-tool-failure\n');
    await writeFile(join(record.home,'state.db'),Buffer.from([83,81,76,0,1,2]));
    await captureNativeProcess([process.execPath,'-e',''],{...record,cwd:root,token:'trial-visible-token',harness:'ernie'});
    const manifest=JSON.parse(await readFile(join(record.recordDir,'manifest.json'),'utf8'));
    expect(manifest.nativeFiles.filter((f:any)=>f.skipped==='symlink')).toHaveLength(2);
    expect(manifest.nativeFiles.find((f:any)=>f.relativePath==='benign.jsonl').sanitizedPath).toBeTruthy();
    expect(manifest.nativeFiles.find((f:any)=>f.relativePath==='state.db').skipped).toBe('binary-retained-privately');
    expect(await readFile(join(record.home,'state.db'))).toEqual(Buffer.from([83,81,76,0,1,2]));
    const paths=manifest.nativeFiles.flatMap((f:any)=>f.sanitizedPath?[f.sanitizedPath]:[]);
    for(const path of paths)expect(await readFile(path,'utf8')).not.toContain('HOST_PRIVATE_MARKER');
  });
  it('redacts known fake auth and standalone sk-patterns while preserving ordinary task/disk text', () => {
    expect(sanitizeNativeText('task-created disk-cache sk-credential', 'trial-visible-token')).toBe('task-created disk-cache [REDACTED]');
    expect(sanitizeNativeText('trial-visible-token sk-short sk-or-v1-abcdef tool failed','trial-visible-token')).toBe('[REDACTED] [REDACTED] [REDACTED] tool failed');
  });
});
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
