import { describe, expect, it } from 'vitest';
import { developmentManifest, freezeDevelopment, verifyDevelopmentEvidence, CONTEXT_LIMITS } from '../src/benchmark/development.js';
import { freezeManifest, digest, type Qualification } from '../src/benchmark/schedule.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrialQueue, type Trial } from '../src/benchmark/queue.js';
const h = (n: number, width = 64) => n.toString(16).padStart(width, '0');
const rows: Qualification[] = Array.from({length:30}, (_,i)=>({instanceId:`r__${i}`,repo:`repo${i%3}`,baseCommit:h(i+1,40),datasetRevision:h(40,40),specCommit:h(41,40),failToPass:['x'],passToPass:[],base:{completed:true,exitCode:1,statuses:{x:'FAILED'},logSha256:h(i+100)},oracle:{completed:true,exitCode:0,statuses:{x:'PASSED'},logSha256:h(i+200)},environmentDigest:h(i+300),qualifiedAt:'2026-11-13T00:00:00Z'}));
const formal = freezeManifest(rows,{experimentId:'formal',providerEpoch:'epoch',createdAt:'2026-11-13'});
const development = developmentManifest(formal);
const results = () => development.trials.map(t=>({...t,status:'unresolved',infrastructureRestarts:0,usage:{calls:3,inputTokens:100,outputTokens:50,activeMs:1},evidenceSha256:h(500),patchSha256:h(501)}) as Trial);
describe('real development context selection',()=>{
 it('schedules 18 ERNIE trials using only six dev tasks and stable 64K/128K/256K blocks',()=>{
  expect(development.trials).toHaveLength(18);expect(new Set(development.trials.map(t=>t.instanceId)).size).toBe(6);
  expect(development.trials.every(t=>t.harness==='ernie'&&formal.devTasks.some(d=>d.instanceId===t.instanceId))).toBe(true);
  expect(developmentManifest(formal)).toEqual(development);expect(CONTEXT_LIMITS).toEqual([64000,128000,256000]);
 });
 it('persists the 18-trial development queue and fences interrupted work on restart',()=>{
  const directory=mkdtempSync(join(tmpdir(),'dev-queue-'));
  try{const path=join(directory,'queue.db');let q=new TrialQueue(path,development);const first=q.claimNext()!;q.close();q=new TrialQueue(path,development);q.recoverInterrupted();expect(q.list()).toHaveLength(18);expect(q.get(first.id)?.status).toBe('needs-reconciliation');expect(q.claimNext()).toBeUndefined();q.close();}finally{rmSync(directory,{recursive:true,force:true});}
 });
 it('refuses unfinished, zero-call, missing receipt and mismatched results',()=>{
  const pending=results();pending[0]!.status='pending';expect(()=>freezeDevelopment(formal,pending)).toThrow(/development/);
  const zero=results();zero[0]!.usage.calls=0;expect(()=>freezeDevelopment(formal,zero)).toThrow(/evidence|calls/);
  expect(()=>freezeDevelopment(formal,results().slice(1))).toThrow();
 });
 it('uses total input tokens even when fewer calls favor another context',()=>{
  const trials=results();
  for(const t of trials){t.usage.calls=[1,20,2][t.repeat]!;t.usage.inputTokens=[1000,10,100][t.repeat]!;}
  expect(freezeDevelopment(formal,trials).tuning.settings.contextLimit).toBe(128000);
 });
 it('prefers 128K when completion rate and input usage all tie',()=>{
  expect(freezeDevelopment(formal,results()).tuning.settings.contextLimit).toBe(128000);
 });
 it('prefers 64K over 256K when both beat 128K and otherwise tie',()=>{
  const trials=results();for(const t of trials)if(t.repeat===1)t.usage.inputTokens=999;
  expect(freezeDevelopment(formal,trials).tuning.settings.contextLimit).toBe(64000);
 });
 it('selects by completion rate then input tokens then 128K preference and binds the evidence hash',()=>{
  const trials=results();for(const t of trials) if(t.repeat===1)t.status='resolved';
  const {tuning,evidence}=freezeDevelopment(formal,trials);
  expect(tuning.settings.contextLimit).toBe(128000);expect(tuning.evidenceSha256).toBe(digest(evidence));
  expect(()=>verifyDevelopmentEvidence(formal,tuning,evidence)).not.toThrow();
  expect(()=>verifyDevelopmentEvidence(formal,{...tuning,evidenceSha256:h(999)},evidence)).toThrow(/hash/);
  expect(()=>verifyDevelopmentEvidence(formal,{...tuning,settings:{...tuning.settings,contextLimit:256000}},evidence)).toThrow();
 });
});
