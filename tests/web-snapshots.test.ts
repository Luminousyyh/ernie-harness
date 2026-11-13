import {describe, expect, it} from 'vitest';
import type {Goal} from '../src/contracts/index.js';
import type {ServiceState} from '../web/src/api.js';
import {mergeGoalSnapshot, mergeServiceSnapshot} from '../web/src/snapshots.js';
const goal=(id:string,status:string,revision=1):Goal=>({id,status,revision,updatedAt:'2026-11-13T00:00:00Z',budget:{maxCalls:20}} as Goal);
const state=(goals:Goal[]):ServiceState=>({goals,workspace:'/project'} as ServiceState);
describe('HTTP snapshots overtaken by SSE',()=>{
 it('keeps seq95 success, revision and budget when a pre-SSE detail response arrives',async()=>{
  const before=goal('a','running');let current=before;
  let respond!:(value:Goal)=>void;
  const pending=new Promise<Goal>(resolve=>{respond=resolve;});
  const startedAt=94;const watermarks:Record<string,number>={a:94};
  const loading=pending.then(snapshot=>{current=mergeGoalSnapshot(current,snapshot,startedAt,watermarks);});
  current={...goal('a','succeeded',2),budget:{...before.budget,maxCalls:50}};watermarks.a=95;
  respond(before);await loading;
  expect(current).toMatchObject({status:'succeeded',revision:2,budget:{maxCalls:50}});
 });
 it('preserves per-goal SSE updates and newly created goals while accepting unrelated state rows',()=>{
  const latest=state([goal('a','succeeded',2),goal('new','pending')]);
  const merged=mergeServiceSnapshot(latest,state([goal('a','running'),goal('b','paused')]),94,{a:95,new:96});
  expect(merged.goals.map(item=>[item.id,item.status])).toEqual([['a','succeeded'],['b','paused'],['new','pending']]);
 });
 it('accepts an HTTP response requested after the last per-goal event',()=>{
  expect(mergeGoalSnapshot(goal('a','running'),goal('a','succeeded'),95,{a:95}).status).toBe('succeeded');
 });
 it('does not block updates for a different goal when another goal receives an event',()=>{
  expect(mergeGoalSnapshot(goal('b','running'),goal('b','succeeded'),94,{a:95}).status).toBe('succeeded');
 });
 it('does not regress revision or timestamp even when no intervening SSE was received',()=>{
  expect(mergeGoalSnapshot(goal('a','paused',3),goal('a','running',2),100,{}).revision).toBe(3);
  const current={...goal('a','succeeded'),updatedAt:'2026-11-13T00:00:01Z'};
  expect(mergeGoalSnapshot(current,goal('a','running'),100,{})).toBe(current);
 });
 it('retains HTTP-created goals and children omitted by an older full-state response without SSE',async()=>{
  for (const id of ['new-chat','new-child']) {
    let current=state([goal('existing','paused')]);
    let respond!:(value:ServiceState)=>void;
    const pending=new Promise<ServiceState>(resolve=>{respond=resolve;});
    const loading=pending.then(snapshot=>{current=mergeServiceSnapshot(current,snapshot,20,{});});
    current=state([...current.goals,goal(id,'pending')]);
    current=state(current.goals.map(item=>item.id===id?goal(id,'running'):item));
    respond(state([goal('existing','paused')]));await loading;
    expect(current.goals.find(item=>item.id===id)?.status).toBe('running');
  }
 });
 it('protects an existing HTTP-mutated goal even when revision/timestamps are equal and SSE is delayed',()=>{
  const older=goal('a','running');const edited={...older,status:'paused' as const,budget:{...older.budget,maxCalls:51}};
  const merged=mergeServiceSnapshot(state([edited]),state([older]),20,{}, {startedAt:3,watermarks:{a:4}});
  expect(merged.goals[0]).toEqual(edited);
 });
 it('allows fresh requests after a local mutation and does not block unrelated goals',()=>{
  const current=state([goal('a','paused'),goal('b','running')]);
  const incoming=state([goal('a','succeeded'),goal('b','succeeded')]);
  expect(mergeServiceSnapshot(current,incoming,20,{}, {startedAt:4,watermarks:{a:4}}).goals.map(item=>item.status)).toEqual(['succeeded','succeeded']);
  expect(mergeServiceSnapshot(current,incoming,20,{}, {startedAt:3,watermarks:{a:4}}).goals.map(item=>item.status)).toEqual(['paused','succeeded']);
 });

});
