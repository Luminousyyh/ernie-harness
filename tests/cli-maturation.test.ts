import {afterEach,describe,expect,it,vi} from 'vitest';
import type {ChatMessage,HarnessEvent} from '../src/contracts/index.js';
import {serviceRequest} from '../src/cli/client.js';
import {streamEvents} from '../src/cli/events.js';
import {emptyTranscript,hydrateTranscript,reduceTranscript,editComposer,filterGoals} from '../src/cli/state.js';
import {executeManagementCommand} from '../src/cli/commands.js';
import {cliMessages,cliText,resolveCliLocale} from '../src/cli/locale.js';
const connection={url:'http://127.0.0.1:4317',token:'private-service-credential',pid:1};
const event=(seq:number,type:string,data:unknown,goalId='g'):HarnessEvent=>({seq,goalId,type,data,createdAt:'2026-11-13T00:00:00Z'});
const frame=(value:HarnessEvent)=>`id: ${value.seq}\r\nevent: harness\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
afterEach(()=>vi.restoreAllMocks());
describe('CLI cursor delivery and cleanup',()=>{
 it('reconnects after the last delivered event, deduplicates replay, and cancels the reader',async()=>{
  const abort=new AbortController();const seen:number[]=[];let attempt=0;let cancelled=false;
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(_input,options)=>{
   attempt++;expect(String(_input)).not.toContain(connection.token);
   if(attempt===1)return new Response(frame(event(1,'model.delta',{type:'text',text:'你'})),{headers:{'content-type':'text/event-stream'}});
   expect(new Headers(options?.headers).get('last-event-id')).toBe('1');expect(String(_input)).toContain('after=1');
   return new Response(new ReadableStream({start(controller){const bytes=new TextEncoder().encode(frame(event(1,'message',{role:'user',content:'old'}))+frame(event(2,'model.delta',{type:'text',text:'好'})));controller.enqueue(bytes.subarray(0,13));controller.enqueue(bytes.subarray(13));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  });
  await streamEvents(connection,{signal:abort.signal,retryMs:1,onEvent(value){seen.push(value.seq);if(value.seq===2)abort.abort();}});
  expect(seen).toEqual([1,2]);expect(fetcher).toHaveBeenCalledTimes(2);expect(cancelled).toBe(true);
 });
 it('does not retry an invalid service credential or expose the response body',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(connection.token,{status:401}));
  await expect(streamEvents(connection,{signal:new AbortController().signal,onEvent(){}})).rejects.toThrow('401');
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('aborts a pending stream read immediately and removes its reader',async()=>{
  const abort=new AbortController();let cancelled=false;
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
  const running=streamEvents(connection,{signal:abort.signal,onEvent(){}});await new Promise(resolve=>setTimeout(resolve,5));abort.abort();await running;expect(cancelled).toBe(true);
 });
 it('redacts credentials and terminal escapes in service errors',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({error:`bad ${connection.token} Bearer abc-def \u001b[2J`}),{status:400}));
  await expect(serviceRequest(connection,'/state')).rejects.toThrow(/HTTP 400/);
  try{await serviceRequest(connection,'/state');}catch(error){expect(String(error)).not.toContain(connection.token);expect(String(error)).not.toContain('abc-def');expect(String(error)).not.toContain('\u001b');}
 });
});
describe('terminal transcript and composer',()=>{
 it('keeps live events newer than a snapshot without duplicating committed assistant messages',()=>{
  let current=reduceTranscript(emptyTranscript('g'),event(6,'model.delta',{type:'text',text:'new'}));
  current=reduceTranscript(current,event(7,'message',{role:'assistant',content:'new'}));
  const snapshot={messages:[{role:'user',content:'request'}] as ChatMessage[],events:[event(4,'model.delta',{type:'text',text:'old'}),event(5,'message',{role:'assistant',content:'old'})],eventCursor:5};
  const hydrated=hydrateTranscript('g',snapshot,current);
  expect(hydrated.messages.map(message=>message.content)).toEqual(['request','new']);expect(hydrated.draft).toBe('');expect(hydrated.lastSeq).toBe(7);
  expect(reduceTranscript(hydrated,event(7,'message',{role:'assistant',content:'new'}))).toBe(hydrated);
  expect(reduceTranscript(hydrated,event(8,'message',{role:'assistant',content:'other'},'different'))).toBe(hydrated);
 });
 it('retains streamed tool output and context metadata while bounding old events',()=>{
  let transcript=emptyTranscript('g');for(let seq=1;seq<=420;seq++)transcript=reduceTranscript(transcript,event(seq,'tool.output',{output:'line'}));
  transcript=reduceTranscript(transcript,event(421,'context.updated',{effectiveLimit:1000,requestInputTokens:200,remainingTokens:800}));
  expect(transcript.events.length).toBeLessThanOrEqual(300);expect(transcript.context?.remainingTokens).toBe(800);
 });
 it('edits multiline text at the cursor and removes a complete Unicode code point',()=>{
  let draft={text:'a😀b',cursor:3};draft=editComposer(draft,'backspace');expect(draft).toEqual({text:'ab',cursor:1});
  draft=editComposer(draft,'insert','\nsecond');expect(draft.text).toBe('a\nsecondb');draft=editComposer(draft,'home');expect(draft.cursor).toBe(2);
 });
 it('has matching locale keys and placeholders and resolves only supported explicit languages',()=>{
  expect(Object.keys(cliMessages.en).sort()).toEqual(Object.keys(cliMessages['zh-CN']).sort());
  for(const key of Object.keys(cliMessages.en) as (keyof typeof cliMessages.en)[]){expect(cliMessages.en[key].match(/\{\w+\}/g)?.sort()??[]).toEqual(cliMessages['zh-CN'][key].match(/\{\w+\}/g)?.sort()??[]);}
  expect(resolveCliLocale('en')).toBe('en');expect(resolveCliLocale(undefined)).toBe('zh-CN');expect(()=>resolveCliLocale('fr')).toThrow();
  expect(cliText('en','selected',{id:'g'})).toContain('g');
 });
});
describe('management commands use shared service APIs',()=>{
 it.each([
  ['memory',['disable','m/a'],'/memories/m%2Fa','PATCH',{status:'disabled'}],
  ['memory',['edit','m','corrected text'],'/memories/m','PATCH',{text:'corrected text'}],
  ['improve',['start'],'/improvements','POST',{workspace:'C:/project'}],
  ['improve',['cancel','i'],'/improvements/i/cancel','POST',{}],
  ['improve',['apply','i','candidate'],'/improvements/i/apply','POST',{candidateId:'candidate'}],
  ['improve',['rollback','i'],'/improvements/i/rollback','POST',{}],
  ['approvals',['allow','a'],'/approvals/a','POST',{decision:'allow'}],
  ['sessions',['branch','g','fork'],'/goals/g/branch','POST',{title:'fork'}],
  ['checkpoint',['create','g','before'],'/goals/g/checkpoints','POST',{label:'before'}],
  ['checkpoint',['restore','g','c/a'],'/goals/g/checkpoints/c%2Fa/restore','POST',{confirm:true}],
 ] as const)('%s %j',async(command,args,path,method,body)=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ok:true}));
  await executeManagementCommand(connection,command,[...args],{workspace:'C:/project'});
  expect(fetcher).toHaveBeenCalledWith(connection.url+'/api'+path,expect.objectContaining({method,body:JSON.stringify(body)}));
 });
 it('loads a memory by ID from the workspace list and rejects incomplete mutations before sending',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({memories:[{id:'one',content:'a'},{id:'two',content:'b'}]}));
  expect(await executeManagementCommand(connection,'memory',['show','two'],{workspace:'C:/project'})).toEqual({id:'two',content:'b'});
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('/memories?workspace=C%3A%2Fproject');fetcher.mockClear();
  await expect(executeManagementCommand(connection,'improve',['apply','i'],{workspace:'C:/project'})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
 });
});
