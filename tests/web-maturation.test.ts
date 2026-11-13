import {describe, expect, it} from 'vitest';
import {canApplyCandidate, listRows, jobFrom, activeCandidateId} from '../web/src/maturation.js';
import {api} from '../web/src/api.js';
import {vi, afterEach} from 'vitest';

afterEach(()=>vi.unstubAllGlobals());
describe('maturation views use persisted API evidence',()=>{
 it('accepts evolving response envelopes without inventing rows or winners',()=>{
  expect(listRows({memories:[{id:'m'}]},'memories')).toEqual([{id:'m'}]);
  expect(listRows({jobs:[{id:'j'}]},'jobs')).toEqual([{id:'j'}]);expect(listRows({runs:[{id:'j'}],active:{candidateId:'active'}},'runs')).toEqual([{id:'j'}]);expect(activeCandidateId({runs:[],active:{candidateId:'active'}})).toBe('active');
  expect(listRows({status:'pending'},'jobs')).toEqual([]);
  expect(jobFrom({job:{id:'j',status:'completed'}}).status).toBe('completed');
  expect(activeCandidateId({job:{winnerId:'candidate'}})).toBeUndefined();
  expect(activeCandidateId({activation:{candidateId:'active'}})).toBe('active');
 });
 it('requires recorded eligibility, build, isolation, and comparison evidence before apply',()=>{
  const candidate={id:'a',status:'eligible',buildPassed:true,isolation:{verified:true},score:{},parentScore:{},validation:{},parentValidation:{}};
  expect(canApplyCandidate(candidate)).toBe(true);
  for(const patch of [{status:'completed'},{status:'proposed'},{buildPassed:false},{isolation:{verified:false}},{validation:undefined}]) expect(canApplyCandidate({...candidate,...patch})).toBe(false);
 });
 it('sends only explicit workspace/decision/candidate fields and encodes IDs',async()=>{
  const fetch=vi.fn(async()=>new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetch);
  await api.memories('C:\\a b');await api.editMemory('m/1',{text:'Original user text',status:'active'});await api.startImprovement('C:\\a b');await api.applyImprovement('j/1','c/1');await api.decideApproval('a/1','deny');
  expect(fetch.mock.calls.map(call=>String(call[0]))).toEqual(['/api/memories?workspace=C%3A%5Ca%20b','/api/memories/m%2F1','/api/improvements','/api/improvements/j%2F1/apply','/api/approvals/a%2F1']);
  expect(JSON.parse(fetch.mock.calls[2][1]!.body as string)).toEqual({workspace:'C:\\a b'});
  expect(JSON.parse(fetch.mock.calls[3][1]!.body as string)).toEqual({candidateId:'c/1'});
  expect(JSON.parse(fetch.mock.calls[4][1]!.body as string)).toEqual({decision:'deny'});
 });
});
