#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {writeFileSync,unlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {ensureService,serviceRequest,connectionPath,acquireServiceLock,safeText,type Connection} from './client.js';
import {executionMode,executeManagementCommand,isManagementCommand} from './commands.js';
import {cliText,resolveCliLocale,type CliLocale} from './locale.js';
import {abortableDelay} from './events.js';
import type {Goal,GoalInput,Workspace} from '../contracts/index.js';
let diagnosticsConnection:Connection|undefined;
const diagnosticSecrets:string[]=[];
export function cliHelp(locale:CliLocale):string {
 const en=locale==='en';return `ERNIE Harness\n\n${en?'Usage':'用法'}: ernie-harness <command> [--lang zh-CN|en]\n\n  serve [--port 4317] [--open]\n  open\n  tui [-w ${en?'workspace':'工作区'}] [--mode plan|standard|trusted]\n  run "${en?'goal':'目标'}" [-w ${en?'path':'路径'}] [-c "${en?'acceptance command':'验收命令'}"] [--supervised]\n      [--mode plan|standard|trusted] [--max-calls N] [--context-limit N] [--json] [--background]\n  list [${en?'search':'搜索'}] [--json]\n  workspace list|add <${en?'path':'路径'}>|select <ID>|edit <ID> [-w ${en?'path':'路径'}] [--name ${en?'name':'名称'}]\n  reply|continue <${en?'goalID':'目标ID'}> "${en?'message':'补充要求'}" [--background]\n  pause|resume|cancel|show <${en?'goalID':'目标ID'}>\n  memory list|show <ID>|edit <ID> "${en?'content':'内容'}"|disable <ID> [-w ${en?'path':'路径'}]\n  improve list|start|status <ID>|cancel <ID>\n  improve apply <ID> <candidateID>|rollback <ID>\n  approvals list|allow <ID>|deny <ID>\n  sessions branch <${en?'goalID':'目标ID'}> [${en?'title':'标题'}]\n  checkpoint list|create <${en?'goalID':'目标ID'}> [${en?'label':'标签'}]\n  checkpoint restore <${en?'goalID':'目标ID'}> <${en?'checkpointID':'检查点ID'}>\n  setup [--stdin]\n  doctor\n\n${en?'TUI: /help shows slash commands; Ctrl+P opens the command palette.\nOnly the free ERNIE model is used. Service credentials are never printed.':'TUI：/help 查看命令，Ctrl+P 打开命令面板。\n仅使用 ERNIE 免费模型；服务凭据不会输出。'}\n${cliText(locale,'noModelNetwork')}`;
}
async function readSecret(stdin:boolean,locale:CliLocale):Promise<string>{
 if(stdin){let value='';for await(const chunk of process.stdin)value+=chunk;return value.trim();}
 if(!process.stdin.isTTY)throw new Error(cliText(locale,'secretStdin'));
 process.stdout.write(cliText(locale,'secretPrompt'));const wasRaw=process.stdin.isRaw;process.stdin.setRawMode(true);process.stdin.resume();
 return new Promise((resolveSecret,reject)=>{
  let value='';const cleanup=()=>{process.stdin.off('data',listener);process.stdin.setRawMode(wasRaw);process.stdin.pause();process.stdout.write('\n');};
  const listener=(chunk:Buffer)=>{for(const c of chunk.toString()){
   if(c==='\r'||c==='\n'){cleanup();resolveSecret(value);return;}
   if(c==='\u0003'){cleanup();reject(new Error(cliText(locale,'cancelled')));return;}
   if(c==='\u007f'||c==='\b')value=Array.from(value).slice(0,-1).join('');else if(c>=' ')value+=c;
  }};process.stdin.on('data',listener);
 });
}
export interface CliDependencies {connect?:()=>Promise<Connection>;print?:(value:string)=>void}
export async function runCli(args=process.argv.slice(2),dependencies:CliDependencies={}):Promise<void>{
 const{positionals,values}=parseArgs({args,allowPositionals:true,options:{help:{type:'boolean',short:'h'},workspace:{type:'string',short:'w'},check:{type:'string',short:'c',multiple:true},json:{type:'boolean'},stdin:{type:'boolean'},background:{type:'boolean'},name:{type:'string'},supervised:{type:'boolean'},port:{type:'string'},'max-calls':{type:'string'},'context-limit':{type:'string'},open:{type:'boolean'},lang:{type:'string'},mode:{type:'string'}}});
 let locale=resolveCliLocale(values.lang);const mode=executionMode(values.mode);const print=dependencies.print??console.log;
 const command=positionals[0]??(process.stdin.isTTY?'tui':'help');const workspace=resolve(values.workspace??process.cwd());
 const output=(value:unknown)=>print(safeText(typeof value==='string'?value:JSON.stringify(value,null,values.json?undefined:2),[diagnosticsConnection?.token??'',...diagnosticSecrets]));
 const required=(value:string|undefined,usage:string)=>{if(!value?.trim())throw new Error(cliText(locale,'missing',{usage}));return value;};
 if(values.help||command==='help'){print(cliHelp(locale));return;}
 if(command==='setup'){const{storeApiKey}=await import('../provider/index.js');const key=await readSecret(values.stdin??false,locale);diagnosticSecrets.push(key);await storeApiKey(key,{explicitSetup:true});output(cliText(locale,'credentialsSaved'));return;}
 if(command==='doctor'){const{loadApiKey,probeCapabilities}=await import('../provider/index.js');const key=await loadApiKey();if(key)diagnosticSecrets.push(key);output({node:process.version,configured:!!key,capabilities:await probeCapabilities(key??'')});return;}
 if(command==='serve'){
  const{createHarnessService}=await import('../server/app.js');const{defaultStateDirectory}=await import('../provider/index.js');
  const port=Number(values.port??process.env.ERNIE_PORT??4317);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port');
  const dir=defaultStateDirectory();const release=acquireServiceLock(dir);
  try{
   const service=await createHarnessService({stateDir:dir,workspace,webRoot:fileURLToPath(new URL('../../web/dist',import.meta.url))});await service.app.listen({host:'127.0.0.1',port});
   diagnosticsConnection={url:`http://127.0.0.1:${port}`,token:service.token,pid:process.pid};writeFileSync(connectionPath(),JSON.stringify(diagnosticsConnection),{mode:0o600});
   output(cliText(locale,'serverStarted',{url:diagnosticsConnection.url}));output(cliText(locale,'serviceNotice'));
   if(values.open)openBrowser(`${diagnosticsConnection.url}/#token=${service.token}`);
   let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;try{await service.app.close();}finally{release();try{unlinkSync(connectionPath());}catch{}process.exit(0);}};
   process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
  }catch(error){release();throw error;}return;
 }
 if(!['open','workspace','reply','continue','tui','list','pause','resume','cancel','show','run'].includes(command)&&!isManagementCommand(command))throw new Error(cliText(locale,'unknown',{command}));
 if(command==='tui'&&!process.stdin.isTTY)throw new Error(cliText(locale,'interactiveRequired'));
 const positive=(value:string|undefined,label:string)=>{if(value===undefined)return undefined;const number=Number(value);if(!Number.isSafeInteger(number)||number<1)throw new Error(`${label}: positive integer required`);return number;};
 const maxCalls=positive(values['max-calls'],'--max-calls');const contextLimit=positive(values['context-limit'],'--context-limit');
 if(command==='run')required(positionals.slice(1).join(' ').trim(),'run <prompt>');
 const connection=await(dependencies.connect??ensureService)();diagnosticsConnection=connection;
 if(values.lang)await serviceRequest(connection,'/preferences',{locale},'PATCH');
 else {try{const preferences=await serviceRequest<{locale?:unknown}>(connection,'/preferences');locale=resolveCliLocale(preferences.locale);}catch{/* Older services retain the Chinese default. */}}
 if(command==='open'){openBrowser(`${connection.url}/#token=${connection.token}`);output(cliText(locale,'opened',{url:connection.url}));return;}
 const goalPath=(id:string)=>'/goals/'+encodeURIComponent(id);
 if(command==='workspace'){
  const action=positionals[1]??'list';let result:unknown;
  if(action==='list'){const state=await serviceRequest<{workspaces:Workspace[];activeWorkspaceId:string}>(connection,'/state');result=state.workspaces.map(item=>({...item,active:item.id===state.activeWorkspaceId}));}
  else if(action==='add'){const path=required(positionals[2]??values.workspace,'workspace add <path>');result=await serviceRequest(connection,'/workspaces',{path:resolve(path),...(values.name?{name:values.name}:{})});}
  else if(action==='select')result=await serviceRequest(connection,`/workspaces/${encodeURIComponent(required(positionals[2],'workspace select <ID>'))}/select`,{});
  else if(action==='edit')result=await serviceRequest(connection,`/workspaces/${encodeURIComponent(required(positionals[2],'workspace edit <ID>'))}`,{...(values.workspace?{path:workspace}:{}),...(values.name?{name:values.name}:{})},'PATCH');
  else throw new Error(cliText(locale,'unknown',{command:`workspace ${action}`}));output(result);return;
 }
 if(command==='reply'||command==='continue'){
  const id=required(positionals[1],'reply <goalID> <message>');const content=positionals.slice(2).join(' ').trim();
  if(command==='continue'&&!content)output(await serviceRequest(connection,goalPath(id)+'/resume',{}));
  else output(await serviceRequest(connection,goalPath(id)+'/messages',{content:required(content,'reply <goalID> <message>'),start:true}));return;
 }
 if(command==='tui'){const{runTerminal}=await import('./terminal.js');await runTerminal(connection,values.workspace?workspace:undefined,{locale,mode});return;}
 if(command==='list'){
  const state=await serviceRequest<{goals:Goal[]}>(connection,'/state');const search=positionals.slice(1).join(' ').toLocaleLowerCase();
  const goals=state.goals.filter(goal=>(!values.workspace||goal.workspace===workspace)&&(!search||`${goal.id} ${goal.title} ${goal.prompt}`.toLocaleLowerCase().includes(search)));
  output(values.json?goals:goals.map(goal=>`${goal.id}  ${goal.status.padEnd(20)} ${goal.title}`).join('\n')||cliText(locale,'noGoals'));return;
 }
 if(['pause','resume','cancel','show'].includes(command)){
  const id=required(positionals[1],`${command} <goalID>`);output(await serviceRequest(connection,goalPath(id)+(command==='show'?'':'/'+command),command==='show'?undefined:{}));return;
 }
 const selected=values.workspace?workspace:(await serviceRequest<{workspace:string}>(connection,'/state')).workspace;
 if(isManagementCommand(command)){output(await executeManagementCommand(connection,command,positionals.slice(1),{workspace:selected,locale}));return;}
 if(command==='run'){
  const input:GoalInput&{mode:typeof mode}={workspace:selected,prompt:positionals.slice(1).join(' ').trim(),mode,acceptanceCommands:values.check??[],supervised:values.supervised??false,...(maxCalls?{budget:{maxCalls}}:{}),...(contextLimit?{contextLimit}:{})};
  const goal=await serviceRequest<Goal>(connection,'/goals',input);await serviceRequest(connection,goalPath(goal.id)+'/start',{});
  if(values.background){output({id:goal.id,status:'pending'});return;}
  const abort=new AbortController();const stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);let last='';
  try{while(!abort.signal.aborted){
   const detail=await serviceRequest<{goal:Goal;messages:unknown[]}>(connection,goalPath(goal.id),undefined,'GET',{signal:abort.signal});const current=detail.goal;
   if(!values.json&&current.status!==last){output(`[${current.status}] ${current.title}`);last=current.status;}
   if(!['pending','running'].includes(current.status)){output(values.json?detail:current.summary??current.error??current.status);if(current.status!=='succeeded')process.exitCode=1;return;}
   await abortableDelay(500,abort.signal);
  }}catch(error){if(!abort.signal.aborted)throw error;}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
 }
}
function openBrowser(url:string){const command=process.platform==='win32'?'rundll32':process.platform==='darwin'?'open':'xdg-open';const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];const child=spawn(command,args,{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)runCli().catch(error=>{console.error(safeText(error instanceof Error?error.message:String(error),[diagnosticsConnection?.token??'',...diagnosticSecrets]));process.exitCode=1;});
