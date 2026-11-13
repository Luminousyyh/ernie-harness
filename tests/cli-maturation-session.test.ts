import {afterEach,describe,expect,it,vi} from 'vitest';
import {runCli} from '../src/cli/main.js';
import {TerminalSession,splitArguments} from '../src/cli/session.js';
import type {Goal} from '../src/contracts/index.js';
const connection={url:'http://127.0.0.1:4317',token:'local-test-secret',pid:1};
const goal=(id:string,workspace='C:/work')=>({id,title:id,prompt:id,workspace,status:'paused',usage:{calls:0},budget:{},createdAt:'2026-11-13',updatedAt:'2026-11-13',acceptanceCommands:[],revision:1,evidence:[],dependsOn:[],supervised:false,contextLimit:10000}) as Goal;
afterEach(()=>vi.restoreAllMocks());
describe('CLI compatibility and execution mode',()=>{
 it('adds mode and persists an explicit locale while retaining background run semantics',async()=>{
  const requests:{path:string;body:unknown;method:string}[]=[];
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input,options)=>{
   const path=new URL(String(input)).pathname;requests.push({path,body:options?.body?JSON.parse(String(options.body)):undefined,method:options?.method??'GET'});
   if(path==='/api/preferences')return Response.json({locale:'en'});
   if(path==='/api/state')return Response.json({workspace:'C:/work'});
   if(path==='/api/goals')return Response.json(goal('new'));
   if(path==='/api/goals/new/start')return Response.json(goal('new'));
   throw new Error('Unexpected request '+path);
  });
  const output:string[]=[];await runCli(['run','goal','--mode','plan','--lang','en','--background','--max-calls','4'],{connect:async()=>connection,print:value=>output.push(value)});
  expect(requests.find(request=>request.path==='/api/preferences')).toMatchObject({method:'PATCH',body:{locale:'en'}});
  expect(requests.find(request=>request.path==='/api/goals')?.body).toMatchObject({mode:'plan',budget:{maxCalls:4},prompt:'goal',workspace:'C:/work'});
  expect(JSON.parse(output[0]!)).toEqual({id:'new',status:'pending'});
 });
 it('keeps existing pause and show routes and URL encodes goal IDs',async()=>{
  const requests:string[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{requests.push(String(input));return Response.json({locale:'zh-CN',ok:true});});
  await runCli(['pause','goal/one'],{connect:async()=>connection,print(){}});await runCli(['show','goal/one'],{connect:async()=>connection,print(){}});
  expect(requests).toContain(connection.url+'/api/goals/goal%2Fone/pause');expect(requests).toContain(connection.url+'/api/goals/goal%2Fone');
 });
 it('rejects malformed numeric budgets and languages before connecting',async()=>{
  const connect=vi.fn(async()=>connection);
  await expect(runCli(['run','goal','--max-calls','NaN'],{connect})).rejects.toThrow();await expect(runCli(['--lang','fr','--help'],{connect})).rejects.toThrow();await expect(runCli(['run','goal','--mode','unrestricted'],{connect})).rejects.toThrow();expect(connect).not.toHaveBeenCalled();
 });
});
describe('terminal session selection and lifetime',()=>{
 it('does not replace the selected transcript when an older goal request completes later',async()=>{
  const session=new TerminalSession(connection,'C:/work');session.state={...session.state,goals:[goal('first'),goal('second')]};let finish:((response:Response)=>void)|undefined;
  vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
   if(String(input).endsWith('/first'))return new Promise<Response>(resolve=>{finish=resolve;});
   return Response.json({goal:goal('second'),messages:[{role:'user',content:'second transcript'}],events:[],eventCursor:0});
  });
  const first=session.selectGoal('first');await session.selectGoal('second');finish!(Response.json({goal:goal('first'),messages:[{role:'user',content:'first transcript'}],events:[],eventCursor:0}));await first;
  expect(session.state.selectedGoalId).toBe('second');expect(session.state.thread?.messages[0]?.content).toBe('second transcript');await session.stop();
 });
 it('loads persisted locale, preserves the composer target, and stops an active stream on exit',async()=>{
  let streamCancelled=false;const seen:AbortSignal[]=[];
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input,options)=>{
   if(options?.signal)seen.push(options.signal);const path=new URL(String(input)).pathname;
   if(path==='/api/preferences')return Response.json({locale:'en'});
   if(path==='/api/state')return Response.json({workspace:'C:/work',workspaces:[],goals:[goal('g')]});
   if(path==='/api/events')return new Response(new ReadableStream({cancel(){streamCancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
   return Response.json({goal:goal('g'),messages:[],events:[],eventCursor:0});
  });
  const session=new TerminalSession(connection);await session.start();expect(session.state.locale).toBe('en');expect(session.state.selectedGoalId).toBe('g');await session.command('/new');await session.refreshState();expect(session.state.selectedGoalId).toBeUndefined();await session.stop();expect(streamCancelled).toBe(true);expect(seen.every(signal=>signal.aborted)).toBe(true);
 });
 it('handles quoted slash arguments without stripping Windows path separators',()=>{
  expect(splitArguments('/memory edit id "a multi word lesson"')).toEqual(['/memory','edit','id','a multi word lesson']);expect(splitArguments('/workspace C:\\project')).toEqual(['/workspace','C:\\project']);expect(()=>splitArguments('/memory edit id "broken')).toThrow();
 });
});
