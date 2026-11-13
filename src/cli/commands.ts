import {serviceRequest,type Connection,type RequestOptions} from './client.js';
import {cliText,type CliLocale} from './locale.js';
export type ExecutionMode='plan'|'standard'|'trusted';
export function executionMode(value:unknown):ExecutionMode{if(value===undefined)return 'standard';if(value==='plan'||value==='standard'||value==='trusted')return value;throw new Error('Mode must be plan, standard, or trusted.');}
export interface CommandContext {workspace:string;locale?:CliLocale;selectedGoalId?:string;signal?:AbortSignal}
const segment=(value:string)=>encodeURIComponent(value);
export function listItems(value:unknown,key:string):Record<string,unknown>[] {
 const result=Array.isArray(value)?value:(value&&typeof value==='object'?(value as Record<string,unknown>)[key]:[]);
 return Array.isArray(result)?result as Record<string,unknown>[]:[];
}
export function isManagementCommand(command:string):boolean{return ['memory','memories','improve','improvements','approvals','sessions','session','checkpoint','checkpoints'].includes(command);}
export async function executeManagementCommand(connection:Connection,command:string,args:string[],context:CommandContext):Promise<unknown>{
 const locale=context.locale??'zh-CN';const options:RequestOptions={signal:context.signal};
 const request=(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>serviceRequest<unknown>(connection,path,body,method,options);
 const required=(value:string|undefined,usage:string)=>{if(!value?.trim())throw new Error(cliText(locale,'missing',{usage}));return value;};
 const action=args[0]??'list';const id=args[1];
 if(command==='memory'||command==='memories'){
  if(action==='list'||action==='show'){
   if(action==='show')required(id,'memory show <id>');const result=await request('/memories?workspace='+segment(context.workspace));
   if(action==='list')return result;const memory=listItems(result,'memories').find(item=>item.id===id);
   if(!memory)throw new Error(cliText(locale,'memoryMissing',{id:id!}));return memory;
  }
  required(id,'memory edit|disable <id>');
  if(action==='edit')return request('/memories/'+segment(id!),{text:required(args.slice(2).join(' '),'memory edit <id> <content>')},'PATCH');
  if(action==='disable')return request('/memories/'+segment(id!),{status:'disabled'},'PATCH');
 }
 if(command==='improve'||command==='improvements'){
  if(action==='list')return request('/improvements?workspace='+segment(context.workspace));
  if(action==='start'){if(args.length>1)throw new Error(cliText(locale,'unknown',{command:'improve start '+args.slice(1).join(' ')}));return request('/improvements',{workspace:context.workspace});}
  required(id,'improve status|cancel|apply|rollback <id>');
  if(action==='status'||action==='show')return request('/improvements/'+segment(id!));
  if(action==='cancel'||action==='rollback')return request(`/improvements/${segment(id!)}/${action}`,{});
  if(action==='apply')return request(`/improvements/${segment(id!)}/apply`,{candidateId:required(args[2],'improve apply <id> <candidateId>')});
 }
 if(command==='approvals'){
  if(action==='list')return request('/approvals');
  if(action==='allow'||action==='deny')return request('/approvals/'+segment(required(id,'approvals allow|deny <id>')),{decision:action});
 }
 if(command==='sessions'||command==='session'){
  if(action==='branch')return request(`/goals/${segment(required(id,'sessions branch <goalId> [title]'))}/branch`,args.length>2?{title:args.slice(2).join(' ')}:{});
 }
 if(command==='checkpoint'||command==='checkpoints'){
  const goal=id??context.selectedGoalId;required(goal,'checkpoint list|create|restore <goalId>');const base=`/goals/${segment(goal!)}/checkpoints`;
  if(action==='list')return request(base);
  if(action==='create')return request(base,args.length>2?{label:args.slice(2).join(' ')}:{});
  if(action==='restore')return request(`${base}/${segment(required(args[2],'checkpoint restore <goalId> <checkpointId>'))}/restore`,{confirm:true});
 }
 throw new Error(cliText(locale,'unknown',{command:[command,...args].join(' ')}));
}
export const slashCommands=[
 '/help','/goals','/select','/new','/continue','/pause','/resume','/cancel','/workspace','/mode','/lang',
 '/memory list','/memory show','/memory edit','/memory disable','/improve list','/improve start','/improve status','/improve cancel','/improve apply','/improve rollback',
 '/approvals list','/allow','/deny','/branch','/checkpoints','/checkpoint','/restore','/clear','/quit',
] as const;
export function slashHelp(locale:CliLocale):string {
 return locale==='en'?
 `/goals [search] · /select <ID or row> · /new · /continue <ID> [message]\n/pause · /resume · /cancel · /workspace [ID or row] · /mode plan|standard|trusted\n/lang zh-CN|en · /memory list|show <ID>|edit <ID> <text>|disable <ID>\n/improve list|start|status <ID>|cancel <ID>|apply <ID> <candidateID>|rollback <ID>\n/approvals list · /allow <ID> · /deny <ID> · /branch [title]\n/checkpoints · /checkpoint [label] · /restore <checkpointID> · /clear · /quit\nEnter sends; Alt+Enter or Ctrl+J inserts a newline. Up/Down edits lines. Ctrl+P opens commands.`:
 `/goals [搜索] · /select <ID 或行号> · /new · /continue <ID> [补充要求]\n/pause · /resume · /cancel · /workspace [ID 或行号] · /mode plan|standard|trusted\n/lang zh-CN|en · /memory list|show <ID>|edit <ID> <内容>|disable <ID>\n/improve list|start|status <ID>|cancel <ID>|apply <ID> <candidateID>|rollback <ID>\n/approvals list · /allow <ID> · /deny <ID> · /branch [标题]\n/checkpoints · /checkpoint [标签] · /restore <检查点ID> · /clear · /quit\nEnter 发送；Alt+Enter 或 Ctrl+J 换行；方向键编辑；Ctrl+P 打开命令。`;
}
