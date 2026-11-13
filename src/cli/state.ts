import type {ChatMessage,Goal,GoalContext,HarnessEvent} from '../contracts/index.js';
export interface Transcript {goalId:string;messages:ChatMessage[];events:HarnessEvent[];draft:string;reasoning:string;lastSeq:number;loaded:boolean;context?:GoalContext}
export function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'?value as Record<string,unknown>:{};}
export function emptyTranscript(goalId:string):Transcript{return{goalId,messages:[],events:[],draft:'',reasoning:'',lastSeq:0,loaded:false};}
export function reduceTranscript(thread:Transcript,event:HarnessEvent):Transcript {
 if(event.goalId!==thread.goalId||event.seq<=thread.lastSeq)return thread;
 const next={...thread,lastSeq:event.seq,events:[...thread.events,event].slice(-300)};const data=record(event.data);
 if(event.type==='model.delta'&&typeof data.text==='string'){
  if(data.type==='text')next.draft=(next.draft+data.text).slice(-200000);
  if(data.type==='reasoning')next.reasoning=(next.reasoning+data.text).slice(-200000);
 }
 if(event.type==='message'&&['system','user','assistant','tool'].includes(String(data.role))){
  next.messages=[...thread.messages,data as unknown as ChatMessage].slice(-300);
  if(data.role==='assistant'){next.draft='';next.reasoning='';}
 }
 if(event.type==='context.updated')next.context=data as unknown as GoalContext;
 if(event.type==='context.compacted'){next.draft='';next.reasoning='';}
 return next;
}
export function hydrateTranscript(goalId:string,snapshot:{messages:ChatMessage[];events:HarnessEvent[];eventCursor?:number;goal?:Goal},current?:Transcript):Transcript {
 let next=emptyTranscript(goalId);
 for(const event of [...snapshot.events].sort((a,b)=>a.seq-b.seq))next=reduceTranscript(next,event);
 next.messages=snapshot.messages.slice(-300);next.loaded=true;next.context=snapshot.goal?.context??next.context;
 next.lastSeq=Math.max(snapshot.eventCursor??0,next.lastSeq);
 for(const event of current?.events??[])if(event.seq>next.lastSeq)next=reduceTranscript(next,event);
 return next;
}
export function filterGoals(goals:Goal[],workspace:string,query=''):Goal[]{const search=query.toLocaleLowerCase();return goals.filter(goal=>(!workspace||goal.workspace===workspace)&&(!search||`${goal.id} ${goal.title} ${goal.prompt}`.toLocaleLowerCase().includes(search)));}
export interface Composer {text:string;cursor:number}
export type Edit='insert'|'backspace'|'delete'|'left'|'right'|'home'|'end'|'up'|'down';
function previous(text:string,cursor:number){return cursor<=0?0:cursor-(cursor>1&&/[\uDC00-\uDFFF]/.test(text[cursor-1]!)&&/[\uD800-\uDBFF]/.test(text[cursor-2]!)?2:1);}
function following(text:string,cursor:number){return cursor>=text.length?text.length:cursor+(/[\uD800-\uDBFF]/.test(text[cursor]!)&&/[\uDC00-\uDFFF]/.test(text[cursor+1]??'')?2:1);}
export function editComposer(value:Composer,action:Edit,input=''):Composer {
 const{text}=value;const cursor=Math.max(0,Math.min(value.cursor,text.length));
 if(action==='insert'){const normalized=input.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'');return{text:text.slice(0,cursor)+normalized+text.slice(cursor),cursor:cursor+normalized.length};}
 if(action==='left')return{text,cursor:previous(text,cursor)};
 if(action==='right')return{text,cursor:following(text,cursor)};
 if(action==='backspace'){const before=previous(text,cursor);return{text:text.slice(0,before)+text.slice(cursor),cursor:before};}
 if(action==='delete')return{text:text.slice(0,cursor)+text.slice(following(text,cursor)),cursor};
 const lineStart=text.lastIndexOf('\n',cursor-1)+1;const nextBreak=text.indexOf('\n',cursor);const lineEnd=nextBreak<0?text.length:nextBreak;
 if(action==='home')return{text,cursor:lineStart};if(action==='end')return{text,cursor:lineEnd};
 if(action==='up'){if(lineStart===0)return{text,cursor:0};const previousStart=text.lastIndexOf('\n',lineStart-2)+1;return{text,cursor:Math.min(lineStart-1,previousStart+cursor-lineStart)};}
 if(action==='down'){if(lineEnd===text.length)return{text,cursor:text.length};const start=lineEnd+1;const end=text.indexOf('\n',start);return{text,cursor:Math.min(end<0?text.length:end,start+cursor-lineStart)};}
 return value;
}
