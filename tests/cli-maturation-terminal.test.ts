import {afterEach,describe,expect,it,vi} from 'vitest';
import React from 'react';
import {render} from 'ink';
import {PassThrough} from 'node:stream';
import {Terminal,transcriptText} from '../src/cli/terminal.js';
import {TerminalSession} from '../src/cli/session.js';
import {emptyTranscript,reduceTranscript} from '../src/cli/state.js';
import {safeText} from '../src/cli/client.js';
afterEach(()=>vi.restoreAllMocks());
async function until(predicate:()=>boolean){const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw new Error('Terminal did not render expected output');await new Promise(resolve=>setTimeout(resolve,10));}}
describe('rendered terminal',()=>{
 it('localizes transcript roles and strips credentials and terminal escapes from tool events',()=>{
  let thread=reduceTranscript(emptyTranscript('g'),{seq:1,goalId:'g',type:'message',data:{role:'assistant',content:'private-service-secret'},createdAt:''});
  thread=reduceTranscript(thread,{seq:2,goalId:'g',type:'tool.completed',data:{name:'read_file',result:{output:'\u001b[2Jprivate-service-secret'}},createdAt:''});
  const output=transcriptText(thread,'zh-CN',['private-service-secret']);expect(output).toContain('助手');expect(output).toContain('read_file');expect(output).not.toContain('private-service-secret');expect(output).not.toContain('\u001b');
 });
 it('renders the streamed goal and command palette using a local fixture, then cancels on unmount',async()=>{
  let cancelled=false;let capturedPrompt='';let created=false;const connection={url:'http://127.0.0.1:4317',token:'terminal-private-secret',pid:1};
  const goal={id:'g',title:'Fixture goal',prompt:'fixture',workspace:'C:/fixture',status:'running',usage:{calls:1},budget:{maxCalls:5},contextLimit:10000};
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input,options)=>{
   const path=new URL(String(input)).pathname;
   if(path==='/api/goals'&&options?.method==='POST'){capturedPrompt=JSON.parse(String(options.body)).prompt;created=true;return Response.json({...goal,id:'new'});}
   if(path==='/api/state')return Response.json({goals:created?[{...goal,id:'new'},goal]:[goal],workspaces:[],workspace:'C:/fixture'});
   if(path==='/api/preferences')return Response.json({locale:'en'});
   if(path==='/api/events')return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({seq:2,goalId:'g',type:'model.delta',data:{type:'text',text:'Streaming fixture '+connection.token},createdAt:''})+'\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
   return Response.json({goal:path.includes('/new')?{...goal,id:'new'}:goal,messages:[{role:'user',content:'Fixture request'}],events:[],eventCursor:1});
  });
  const stdin=new PassThrough() as PassThrough&{isTTY:boolean;setRawMode:(value:boolean)=>void};stdin.isTTY=true;stdin.setRawMode=()=>{};
  const stdout=new PassThrough() as PassThrough&{columns:number;rows:number};stdout.columns=100;stdout.rows=28;let output='';stdout.on('data',chunk=>{output+=chunk.toString();});
  const session=new TerminalSession(connection);const view=render(React.createElement(Terminal,{session}),{stdin:stdin as unknown as NodeJS.ReadStream,stdout:stdout as unknown as NodeJS.WriteStream,stderr:stdout as unknown as NodeJS.WriteStream,exitOnCtrlC:false,patchConsole:false,interactive:true});
  try{await until(()=>safeText(output).includes('Streaming fixture')).catch(()=>{throw new Error(safeText(output+' STATE '+JSON.stringify(session.state),[connection.token]).slice(-5000));});stdin.write('\u0010');await until(()=>safeText(output).includes('Command palette'));stdin.write('\u001b');await new Promise(resolve=>setTimeout(resolve,30));stdin.write('/new');await new Promise(resolve=>setTimeout(resolve,30));stdin.write('\r');await until(()=>session.state.selectedGoalId===undefined);stdin.write('line one');await new Promise(resolve=>setTimeout(resolve,30));stdin.write('\n');await new Promise(resolve=>setTimeout(resolve,30));stdin.write('line two');await new Promise(resolve=>setTimeout(resolve,30));stdin.write('\r');await until(()=>capturedPrompt!=='');expect(capturedPrompt).toBe('line one\nline two');expect(output).not.toContain(connection.token);}finally{view.unmount();await session.stop();stdin.destroy();stdout.destroy();}expect(cancelled).toBe(true);
 });
});
