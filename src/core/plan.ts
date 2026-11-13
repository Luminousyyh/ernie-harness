import type {AgentPlan,PlanCheckpoint,PlanStep,ToolDefinition} from '../contracts/index.js';
export const updatePlanDefinition:ToolDefinition={type:'function',function:{name:'update_plan',description:'Record a model-provided plan and checkpoints for this supervised goal. These claims do not count as independently verified acceptance evidence.',parameters:{type:'object',additionalProperties:false,required:['steps'],properties:{explanation:{type:'string',maxLength:2000},steps:{type:'array',minItems:1,maxItems:64,items:{type:'object',additionalProperties:false,required:['id','title','status'],properties:{id:{type:'string',maxLength:100},title:{type:'string',maxLength:500},status:{type:'string',enum:['pending','in-progress','completed']}}}},checkpoints:{type:'array',maxItems:64,items:{type:'object',additionalProperties:false,required:['id','title','status'],properties:{id:{type:'string',maxLength:100},title:{type:'string',maxLength:500},status:{type:'string',enum:['pending','passed','failed']},evidence:{type:'string',maxLength:4000}}}}}}}};
export function parsePlan(args:Record<string,unknown>,revision:number):AgentPlan{
 const fail=()=>{throw new Error('Invalid model plan: supply bounded steps and checkpoints with supported statuses');};
 const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
 if(Object.keys(args).some(k=>!['steps','checkpoints','explanation'].includes(k))||!Array.isArray(args.steps)||args.steps.length<1||args.steps.length>64||args.explanation!==undefined&&!text(args.explanation,2000))fail();
 const parseItems=(value:unknown,statuses:string[],checkpoint:boolean)=>{
  if(!Array.isArray(value)||value.length>64)return fail();const ids=new Set<string>();
  return value.map(item=>{
   if(!item||typeof item!=='object'||Array.isArray(item))return fail();
   const data=item as Record<string,unknown>;
   if(Object.keys(data).some(k=>!['id','title','status',...(checkpoint?['evidence']:[])].includes(k))||!text(data.id,100)||!text(data.title,500)||typeof data.status!=='string'||!statuses.includes(data.status)||ids.has(data.id)||data.evidence!==undefined&&!text(data.evidence,4000))return fail();
   ids.add(data.id as string);return {id:data.id as string,title:data.title as string,status:data.status as string,...(data.evidence?{evidence:data.evidence as string}:{})};
  });
 };
 return {source:'model',revision,steps:parseItems(args.steps,['pending','in-progress','completed'],false) as PlanStep[],checkpoints:parseItems(args.checkpoints??[],['pending','passed','failed'],true) as PlanCheckpoint[],...(args.explanation?{explanation:args.explanation as string}:{})};
}
