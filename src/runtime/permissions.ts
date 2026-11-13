import {createHash} from 'node:crypto';
import type {ApprovalRequest,Goal,ToolCall} from '../contracts/index.js';
interface ApprovalStore {requestApproval(input:Omit<ApprovalRequest,'id'|'status'|'createdAt'>):ApprovalRequest}
export const READ_TOOLS=new Set(['read_file','list_files','search','git_diff','process_status','update_plan','invoke_skill']);
export function authorizeTool(store:ApprovalStore,goal:Goal,call:ToolCall,args:Record<string,unknown>):{status:'allowed'|'denied'|'pending';approval?:ApprovalRequest}{
 if(READ_TOOLS.has(call.function.name))return{status:'allowed'};
 if(goal.mode==='plan')return{status:'denied'};
 if(call.function.name==='run_tests'&&typeof args.command==='string'&&goal.acceptanceCommands.includes(args.command))return{status:'allowed'};
 if(!goal.mode||goal.mode==='trusted')return{status:'allowed'};
 if(['write_file','edit_file'].includes(call.function.name))return{status:'allowed'};
 const binding=createHash('sha256').update(JSON.stringify([goal.id,goal.revision,goal.manifest?.id??'legacy',call.id,call.function.name,args])).digest('hex');
 const approval=store.requestApproval({goalId:goal.id,revision:goal.revision,toolCallId:call.id,name:call.function.name,args,binding});
 return{status:approval.status==='allow'?'allowed':approval.status==='deny'?'denied':'pending',approval};
}
