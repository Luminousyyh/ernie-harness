import {MODEL_ID, type ChatMessage, type ModelDelta, type ModelRequest, type ModelResponse, type ToolCall, type Usage} from '../contracts/index.js';
import {ApiError, protocolError, record} from './errors.js';
import {readChunks} from './http.js';
const MAX_EVENT_CHARS = 1024 * 1024;
/** Incremental UTF-8 and SSE framing, including CR, LF, CRLF and multiline data. */
export async function* readSse(response:Response,signal?:AbortSignal):AsyncGenerator<unknown>{
  const decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',data:string[]=[],event='',eventSize=0;
  const line=(value:string):{ready:boolean;value?:unknown}=>{
    if(value===''){
      if(data.length===0){event='';return {ready:false};}
      const text=data.join('\n'),kind=event;data=[];event='';eventSize=0;
      if(text==='[DONE]')return {ready:true,value:'[DONE]'};
      let parsed:unknown;try{parsed=JSON.parse(text);}catch{throw protocolError('INVALID_SSE_JSON');}
      if(kind==='error'&&!(record(parsed)&&'error' in parsed))parsed={error:parsed};
      return {ready:true,value:parsed};
    }
    if(value.startsWith(':'))return {ready:false};
    const colon=value.indexOf(':'),field=colon<0?value:value.slice(0,colon);let content=colon<0?'':value.slice(colon+1);if(content.startsWith(' '))content=content.slice(1);
    if(field==='data'){eventSize+=content.length+1;if(eventSize>MAX_EVENT_CHARS)throw protocolError('SSE_EVENT_TOO_LARGE');data.push(content);}else if(field==='event')event=content;
    return {ready:false};
  };
  for await(const chunk of readChunks(response,signal)){
    try{buffer+=decoder.decode(chunk,{stream:true});}catch{throw protocolError('INVALID_UTF8');}
    let start=0;
    for(let i=0;i<buffer.length;i++){
      const char=buffer[i];if(char!=='\n'&&char!=='\r')continue;if(char==='\r'&&i===buffer.length-1)break;
      const result=line(buffer.slice(start,i));if(char==='\r'&&buffer[i+1]==='\n')i++;start=i+1;if(result.ready)yield result.value;
    }
    buffer=buffer.slice(start);if(buffer.length>MAX_EVENT_CHARS)throw protocolError('SSE_EVENT_TOO_LARGE');
  }
  try{buffer+=decoder.decode();}catch{throw protocolError('INVALID_UTF8');}
  // Accept a final event without the optional final empty line.
  for(const value of buffer.split(/\r\n|\r|\n/)){const result=line(value);if(result.ready)yield result.value;}
  const result=line('');if(result.ready)yield result.value;
}
function tokenCount(value:unknown):number|undefined {
  if(value===undefined||value===null)return undefined;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw protocolError('INVALID_USAGE');return value;
}
function estimatedTokens(value:string):number{return Math.ceil(Buffer.byteLength(value,'utf8')/4);}
export function estimateUsage(request:ModelRequest,message:ChatMessage,raw:Record<string,unknown>):Usage{
  const detail=record(raw.completion_tokens_details)?raw.completion_tokens_details:{};
  const reportedInput=tokenCount(raw.prompt_tokens),reportedOutput=tokenCount(raw.completion_tokens),reportedReasoning=tokenCount(detail.reasoning_tokens);
  const reasoningText=message.reasoning??JSON.stringify(message.reasoning_details??[]);
  const estimatedReasoning=message.reasoning||message.reasoning_details?.length?estimatedTokens(reasoningText):0;
  const reasoning=reportedReasoning??Math.min(estimatedReasoning,reportedOutput??Number.MAX_SAFE_INTEGER);
  const input=reportedInput??(estimatedTokens(JSON.stringify(request.messages))+estimatedTokens(JSON.stringify(request.tools??[]))+8*request.messages.length);
  const output=reportedOutput??Math.max(reasoning,estimatedTokens((message.content??'')+JSON.stringify(message.tool_calls??[]))+reasoning);
  if(reportedOutput!==undefined&&reportedReasoning!==undefined&&reportedReasoning>reportedOutput)throw protocolError('INVALID_USAGE');
  const inputEstimated=reportedInput===undefined,outputEstimated=reportedOutput===undefined,reasoningEstimated=reportedReasoning===undefined;
  return {inputTokens:input,outputTokens:output,reasoningTokens:reasoning,inputEstimated,outputEstimated,reasoningEstimated,...(inputEstimated||outputEstimated||reasoningEstimated?{estimated:true}:{})};
}
/** A completion is released to the executor only after all tool arguments validate. */
export class CompletionAssembler {
  private content='';private reasoning='';private details=new Map<number,Record<string,unknown>>();private jsonDetails:unknown[]|undefined;
  private tools=new Map<number,ToolCall>();private rawUsage:Record<string,unknown>={};private finishReason='';private provider:string|undefined;
  constructor(private readonly request:ModelRequest,private readonly onDelta?:(delta:ModelDelta)=>void){}
  add(payload:unknown,streaming:boolean):void{
    if(!record(payload))throw protocolError('INVALID_COMPLETION');
    if(payload.error!==undefined){const error=record(payload.error)?payload.error:{};const status=typeof error.code==='number'&&error.code>=400&&error.code<=599?error.code:502;throw new ApiError('Provider reported a completion error',{status,code:'UPSTREAM_ERROR'});}
    if(payload.model!==undefined&&payload.model!==MODEL_ID)throw protocolError('UNEXPECTED_MODEL');
    if(payload.provider!==undefined){if(payload.provider!=='Baidu')throw protocolError('UNEXPECTED_PROVIDER');this.provider='Baidu';}
    if(record(payload.usage)){
      if(typeof payload.usage.cost==='number'&&payload.usage.cost>0)throw new ApiError('Provider reported a nonzero charge on a free route',{code:'UNEXPECTED_COST',retryable:false});
      this.rawUsage={...this.rawUsage,...payload.usage};
    }
    if(!Array.isArray(payload.choices))throw protocolError('INVALID_CHOICES');
    if(!streaming&&payload.choices.length!==1)throw protocolError('INVALID_CHOICES');
    for(const choice of payload.choices){
      if(!record(choice)||(choice.index!==undefined&&choice.index!==0))throw protocolError('INVALID_CHOICES');
      if(choice.finish_reason!==undefined&&choice.finish_reason!==null){
        if(typeof choice.finish_reason!=='string'||choice.finish_reason==='error')throw protocolError('INVALID_FINISH_REASON');
        if(this.finishReason&&this.finishReason!==choice.finish_reason)throw protocolError('CONFLICTING_FINISH_REASON');this.finishReason=choice.finish_reason;
      }
      const message=streaming?choice.delta:choice.message;if(!record(message))throw protocolError('INVALID_MESSAGE');
      if(message.content!==undefined&&message.content!==null){if(typeof message.content!=='string')throw protocolError('INVALID_CONTENT');this.content+=message.content;if(message.content)this.onDelta?.({type:'text',text:message.content});}
      if(message.reasoning!==undefined&&message.reasoning!==null){if(typeof message.reasoning!=='string')throw protocolError('INVALID_REASONING');this.reasoning+=message.reasoning;if(message.reasoning)this.onDelta?.({type:'reasoning',text:message.reasoning});}
      if(message.reasoning_details!==undefined&&message.reasoning_details!==null){
        if(!Array.isArray(message.reasoning_details))throw protocolError('INVALID_REASONING_DETAILS');
        if(!streaming)this.jsonDetails=structuredClone(message.reasoning_details);
        else message.reasoning_details.forEach((detail:unknown,position:number)=>{
          if(!record(detail))throw protocolError('INVALID_REASONING_DETAILS');
          const index=detail.index??position;if(typeof index!=='number'||!Number.isSafeInteger(index)||index<0||index>1024)throw protocolError('INVALID_REASONING_INDEX');
          const existing=this.details.get(index)??{};
          for(const [key,value]of Object.entries(detail)){
            if(['text','summary','data','signature'].includes(key)&&typeof value==='string')existing[key]=String(existing[key]??'')+value;
            else if(existing[key]!==undefined&&JSON.stringify(existing[key])!==JSON.stringify(value))throw protocolError('CONFLICTING_REASONING_DETAILS');
            else existing[key]=structuredClone(value);
          }
          this.details.set(index,existing);
          if(!message.reasoning&&typeof detail.text==='string'&&detail.text)this.onDelta?.({type:'reasoning',text:detail.text});
        });
      }
      if(message.tool_calls!==undefined&&message.tool_calls!==null){
        if(!Array.isArray(message.tool_calls))throw protocolError('INVALID_TOOL_CALL');
        message.tool_calls.forEach((part:unknown,position:number)=>{
          if(!record(part))throw protocolError('INVALID_TOOL_CALL');const index=streaming?part.index:position;
          if(typeof index!=='number'||!Number.isSafeInteger(index)||index<0||index>127)throw protocolError('INVALID_TOOL_INDEX');
          const call=this.tools.get(index)??{id:'',type:'function',function:{name:'',arguments:''}};
          if(part.type!==undefined&&part.type!=='function')throw protocolError('INVALID_TOOL_CALL');
          if(part.id!==undefined){if(typeof part.id!=='string')throw protocolError('INVALID_TOOL_CALL');call.id+=part.id;}
          if(part.function!==undefined){if(!record(part.function))throw protocolError('INVALID_TOOL_CALL');
            for(const key of ['name','arguments'] as const){if(part.function[key]!==undefined){if(typeof part.function[key]!=='string')throw protocolError('INVALID_TOOL_CALL');call.function[key]+=part.function[key];if(key==='arguments'&&part.function[key])this.onDelta?.({type:'tool',text:part.function[key]});}}
          }
          this.tools.set(index,call);
        });
      }
    }
  }
  finish():ModelResponse{
    if(!this.finishReason)throw protocolError('TRUNCATED_RESPONSE');
    const tools=[...this.tools.entries()].sort((a,b)=>a[0]-b[0]).map(([,value])=>value),ids=new Set<string>();
    for(const tool of tools){
      if(!tool.id||tool.id.length>512||ids.has(tool.id)||!tool.function.name||tool.function.name.length>256)throw protocolError('INVALID_TOOL_CALL');ids.add(tool.id);
      try{if(!record(JSON.parse(tool.function.arguments)))throw new Error();}catch{throw protocolError('INVALID_TOOL_CALL');}
    }
    if(this.finishReason==='tool_calls'&&tools.length===0)throw protocolError('INVALID_TOOL_CALL');
    const details=this.jsonDetails??[...this.details.entries()].sort((a,b)=>a[0]-b[0]).map(([,value])=>value);
    const message:ChatMessage={role:'assistant',content:this.content||null,...(tools.length?{tool_calls:tools}:{}),...(details.length?{reasoning_details:details}:{}),...(this.reasoning?{reasoning:this.reasoning}:{})};
    return {message,usage:estimateUsage(this.request,message,this.rawUsage),model:MODEL_ID,...(this.provider?{provider:this.provider}:{}),finishReason:this.finishReason};
  }
}
