import React,{useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {render,Box,Text,useApp,useInput,useStdout} from 'ink';
import {safeText,type Connection} from './client.js';
import {TerminalSession,type TerminalOptions} from './session.js';
import {cliText,statusLabel,type CliLocale} from './locale.js';
import {slashCommands} from './commands.js';
import {editComposer,filterGoals,record,type Composer,type Transcript} from './state.js';
export async function runTerminal(connection:Connection,workspace?:string,options:TerminalOptions={}){
 const session=new TerminalSession(connection,workspace,options);const instance=render(<Terminal session={session}/>,{exitOnCtrlC:false});
 try{await instance.waitUntilExit();}finally{await session.stop();}
}
/** Keep rendering deterministic and safe for both narrow terminals and untrusted tool text. */
export function wrapTerminalText(text:string,width:number):string[]{
 const lines:string[]=[];for(const source of text.split('\n')){let line='';let count=0;for(const character of source){const code=character.codePointAt(0)!;const size=code>=0x2e80&&code!==0xfe0f?2:1;if(count+size>width&&line){lines.push(line);line='';count=0;}line+=character;count+=size;}lines.push(line);}return lines;
}
export function transcriptText(thread:Transcript|undefined,locale:CliLocale,secrets:string[]):string {
 if(!thread)return cliText(locale,'noMessages');const lines:string[]=[];
 for(const message of thread.messages){if(message.role==='system')continue;const content=message.content??'';const tools=message.tool_calls?.map(tool=>tool.function.name).join(', ');lines.push(`${cliText(locale,message.role)}${message.name?' · '+message.name:''}${tools?' · '+tools:''}\n${safeText(content,secrets)}`);}
 if(thread.reasoning)lines.push(`${cliText(locale,'reasoning')}\n${safeText(thread.reasoning,secrets)}`);
 if(thread.draft)lines.push(`${cliText(locale,'assistant')} ▌\n${safeText(thread.draft,secrets)}`);
 const events=thread.events.filter(event=>event.type.startsWith('tool.')||event.type.startsWith('approval.')||event.type==='run.failed').slice(-6);
 for(const event of events){const data=record(event.data);const result=record(data.result);const output=result.output??data.output??data.error;const details=output??data.args??data;
  lines.push(`[${event.seq}] ${event.type} ${String(data.name??'')}\n${safeText(typeof details==='string'?details:JSON.stringify(details),secrets).slice(-1800)}`);
 }
 return lines.join('\n\n')||cliText(locale,'noMessages');
}
export function Terminal({session}:{session:TerminalSession}){
 const state=useSyncExternalStore(session.subscribe,session.snapshot,session.snapshot);const{exit}=useApp();const{stdout:output}=useStdout();const stdout=output as NodeJS.WriteStream;
 const submitting=useRef(false);const[composer,setComposer]=useState<Composer>({text:'',cursor:0});const[picker,setPicker]=useState<'commands'|'goals'|'workspaces'>();
 const[query,setQuery]=useState('');const[index,setIndex]=useState(0);const[scroll,setScroll]=useState(0);const[error,setError]=useState('');const[size,setSize]=useState({columns:stdout.columns??100,rows:stdout.rows??30});
 const text=(key:Parameters<typeof cliText>[1])=>cliText(state.locale,key);const safe=(value:unknown)=>safeText(value,[session.connection.token]);
 useEffect(()=>{void session.start().catch(error=>setError(safe(error instanceof Error?error.message:error)));return()=>{void session.stop();};},[session]);
 useEffect(()=>{const resize=()=>setSize({columns:stdout.columns??100,rows:stdout.rows??30});stdout.on('resize',resize);return()=>{stdout.off('resize',resize);};},[stdout]);
 useEffect(()=>{setScroll(0);setError('');},[state.selectedGoalId]);
 const goals=filterGoals(state.goals,state.workspace,picker==='goals'?query:'');
 const workspaceOptions=state.workspaces.filter(workspace=>`${workspace.name} ${workspace.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 const commandOptions=slashCommands.filter(command=>command.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 const choices=picker==='goals'?goals.map(goal=>({id:goal.id,label:`${goal.title} [${statusLabel(state.locale,goal.status)}] ${goal.id}`})):picker==='workspaces'?workspaceOptions.map(workspace=>({id:workspace.id,label:`${workspace.name} · ${workspace.path}`})):commandOptions.map(command=>({id:command,label:command}));
 const run=async()=>{
  if(submitting.current||state.busy||!composer.text.trim())return;submitting.current=true;const value=composer.text;setError('');
  try{
   if(value.startsWith('/')){const result=await session.command(value);if(result.quit){exit();return;}if(result.picker){setPicker(result.picker);setQuery(result.query??'');setIndex(0);}}
   else await session.submit(value);
   setComposer({text:'',cursor:0});setScroll(0);
  }catch(error){setError(safe(error instanceof Error?error.message:error));}finally{submitting.current=false;}
 };
 const choose=async()=>{const choice=choices[Math.max(0,Math.min(index,choices.length-1))];if(!choice)return;try{
  if(picker==='commands'){const value=choice.id+' ';setComposer({text:value,cursor:value.length});}
  else if(picker==='goals')await session.selectGoal(choice.id);else await session.selectWorkspace(choice.id);
  setPicker(undefined);setQuery('');setIndex(0);
 }catch(error){setError(safe(error instanceof Error?error.message:error));}};
 useInput((input,key)=>{
  if(key.ctrl&&input==='c'){exit();return;}
  if(key.escape){setPicker(undefined);setQuery('');setError('');if(state.panel)void session.command('/clear');return;}
  if(key.ctrl&&['p','g','w'].includes(input)){setPicker(input==='p'?'commands':input==='g'?'goals':'workspaces');setQuery('');setIndex(0);return;}
  if(key.pageUp){setScroll(value=>value+Math.max(1,size.rows-15));return;}if(key.pageDown){setScroll(value=>Math.max(0,value-Math.max(1,size.rows-15)));return;}
  if(picker){
   if(key.upArrow)setIndex(value=>Math.max(0,value-1));else if(key.downArrow)setIndex(value=>Math.min(choices.length-1,value+1));
   else if(key.return)void choose();else if(key.backspace||key.delete){setQuery(value=>Array.from(value).slice(0,-1).join(''));setIndex(0);}
   else if(input&&!key.ctrl&&!key.meta){setQuery(value=>value+safeText(input).replace(/\n/g,''));setIndex(0);}return;
  }
  if(key.ctrl&&(input==='a'||input==='e')){setComposer(value=>editComposer(value,input==='a'?'home':'end'));return;}
  if(key.ctrl&&input==='u'){setComposer({text:'',cursor:0});return;}
  if((key.ctrl&&input==='j')||input==='\n'||(key.return&&(key.meta||key.shift))){setComposer(value=>editComposer(value,'insert','\n'));return;}
  if(key.return){void run();return;}
  if(key.tab&&composer.text.startsWith('/')){const match=slashCommands.find(command=>command.startsWith(composer.text));if(match)setComposer({text:match+' ',cursor:match.length+1});return;}
  const action=key.backspace?'backspace':key.delete?'delete':key.leftArrow?'left':key.rightArrow?'right':key.upArrow?'up':key.downArrow?'down':key.home?'home':key.end?'end':undefined;
  if(action)setComposer(value=>editComposer(value,action));else if(input&&!key.ctrl&&!key.meta)setComposer(value=>editComposer(value,'insert',input));
 });
 const narrow=size.columns<82;const sidebar=narrow?0:30;const width=Math.max(20,size.columns-sidebar-5);const height=Math.max(3,size.rows-13);
 const transcript=useMemo(()=>wrapTerminalText(state.panel?safe(state.panel):transcriptText(state.thread,state.locale,[session.connection.token]),width),[state.thread,state.panel,state.locale,width]);
 const bottom=Math.max(height,transcript.length-Math.min(scroll,Math.max(0,transcript.length-height)));const visible=transcript.slice(Math.max(0,bottom-height),bottom);
 const selected=state.goals.find(goal=>goal.id===state.selectedGoalId);const context=state.thread?.context??selected?.context;
 const draftBefore=composer.text.slice(0,composer.cursor);const draftAfter=composer.text.slice(composer.cursor);const beforeLines=draftBefore.split('\n');const afterLines=draftAfter.split('\n');
 const suggestions=composer.text.startsWith('/')&&!composer.text.includes('\n')?slashCommands.filter(command=>command.startsWith(composer.text)).slice(0,4):[];
 return <Box flexDirection="column" width={Math.max(25,size.columns)}>
  <Box justifyContent="space-between"><Text bold color="cyan">ERNIE Harness</Text><Text color={state.connection==='connected'?'green':'yellow'}>{text(state.connection)} · {state.locale} · {text('mode')}: {state.mode}</Text></Box>
  <Text wrap="truncate">{text('workspace')}: {safe(state.workspace)||text('loading')}</Text>
  <Text wrap="truncate">{selected?`${safe(selected.title)} · ${selected.id} · ${statusLabel(state.locale,selected.status)}`:text('none')}</Text>
  <Text dimColor>{text('context')}: {context?`${context.requestInputTokens}/${context.effectiveLimit} · ${text('remaining')} ${context.remainingTokens}${context.estimated?' ('+text('estimated')+')':''}`:'—'} · {text('calls')}: {selected?.usage.calls??0}/{selected?.budget.maxCalls??'—'}{scroll?' · ↑ '+scroll:''}</Text>
  <Box height={height+2}>
   {!narrow&&<Box width={sidebar} borderStyle="round" flexDirection="column" overflow="hidden"><Text bold>{text('goals')} · Ctrl+G</Text>{goals.slice(0,height-1).map((goal,row)=><Text key={goal.id} color={goal.id===selected?.id?'cyan':undefined} wrap="truncate">{goal.id===selected?.id?'›':' '} {row+1}. {safe(goal.title)}</Text>)}{!goals.length&&<Text dimColor>{text('noGoals')}</Text>}</Box>}
   <Box borderStyle="round" flexDirection="column" flexGrow={1} overflow="hidden"><Text bold>{picker?(picker==='goals'?text('search'):picker==='workspaces'?text('workspace'):text('palette')):text('transcript')}</Text>
    {picker?<><Text color="cyan">› {safe(query)}▌</Text>{choices.slice(Math.max(0,index-height+3),Math.max(height-2,index+1)).map(choice=><Text key={choice.id} color={choice.id===choices[index]?.id?'cyan':undefined} wrap="truncate">{choice.id===choices[index]?.id?'› ':'  '}{safe(choice.label)}</Text>)}{!choices.length&&<Text dimColor>{text('noMatch')}</Text>}</>:<Text>{visible.join('\n')}</Text>}
   </Box>
  </Box>
  <Text color={error?'red':'yellow'} wrap="truncate">{error||safe(state.notice)||text('ready')}</Text>
  <Box borderStyle="round" flexDirection="column"><Text dimColor>{state.busy?text('busy'):selected?text('composerReply'):text('composerNew')}</Text><Text>{beforeLines.slice(-3).join('\n')}<Text inverse>{Array.from(draftAfter)[0]??' '}</Text>{afterLines.slice(0,3).join('\n').slice((Array.from(draftAfter)[0]??'').length)}</Text></Box>
  <Text dimColor wrap="truncate">{suggestions.length?suggestions.join(' · '):text('hint')}</Text>
 </Box>;
}
