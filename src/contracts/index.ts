export const MODEL_ID = 'baidu/ernie-5.5-flash-preview:free' as const;
export interface Workspace {id:string;path:string;name:string;createdAt:string}
export type ReasoningEffort = 'high';
export interface GoalContext {requestRevision:number;contextLimit:number;modelContextLength?:number;effectiveLimit:number;requestInputTokens:number;estimatedInputTokens:number;estimated:boolean;source:'request-estimate'|'provider-usage';estimateMethod:'utf8-bytes';responseReserve:number;remainingTokens:number;remainingRatio:number;lastPromptTokens?:number;lastUsageEstimated?:boolean;compressionCount:number;lastCompressedAt?:string;retainedSummaryOutline?:string[];updatedAt:string}
export interface ModelCapabilities {status:'available'|'unavailable';model:typeof MODEL_ID;contextLength?:number;reasoning:{advertised:string[];verified:string[];selected:ReasoningEffort;reason:string};checkedAt?:string}
export interface PlanStep {id:string;title:string;status:'pending'|'in-progress'|'completed'}
export interface PlanCheckpoint {id:string;title:string;status:'pending'|'passed'|'failed';evidence?:string}
export interface AgentPlan {source:'model';revision:number;steps:PlanStep[];checkpoints:PlanCheckpoint[];explanation?:string}
export type RunStatus = 'pending'|'running'|'waiting-rate-limit'|'waiting-input'|'paused'|'needs-reconciliation'|'succeeded'|'failed'|'cancelled';
export interface ToolCall {id:string;type:'function';function:{name:string;arguments:string}}
export interface ChatMessage {role:'system'|'user'|'assistant'|'tool';content:string|null;tool_calls?:ToolCall[];tool_call_id?:string;name?:string;reasoning_details?:unknown[];reasoning?:string}
export interface ToolDefinition {type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}}
export interface Usage {inputTokens:number;outputTokens:number;reasoningTokens:number;estimated?:boolean;inputEstimated?:boolean;outputEstimated?:boolean;reasoningEstimated?:boolean}
export interface ModelRequest {messages:ChatMessage[];tools?:ToolDefinition[];maxTokens?:number;temperature?:number;reasoningEffort?:ReasoningEffort}
export interface ModelResponse {message:ChatMessage;usage:Usage;model:string;provider?:string;finishReason:string}
export interface ModelDelta {type:'text'|'reasoning'|'tool';text:string}
export interface ModelTransport {readonly contextLength?:number;complete(request:ModelRequest,onDelta?:(delta:ModelDelta)=>void,signal?:AbortSignal):Promise<ModelResponse>}
export interface ToolContext {workspace:string;runId:string;signal?:AbortSignal;emit?:(type:string,data:unknown)=>void}
export interface ToolResult {ok:boolean;output:string;exitCode?:number;artifacts?:string[];backgroundId?:string;truncated?:boolean}
export interface ToolRegistry {definitions():ToolDefinition[];execute(name:string,args:Record<string,unknown>,context:ToolContext):Promise<ToolResult>;cancelAll?(runId:string):Promise<void>}
export interface Budget {maxCalls:number;maxInputTokens:number;maxOutputTokens:number;maxActiveMs:number;maxOutputPerCall:number}
export const DEFAULT_BUDGET:Budget={maxCalls:20,maxInputTokens:2000000,maxOutputTokens:128000,maxActiveMs:1800000,maxOutputPerCall:16384};
export interface Evidence {command:string;exitCode:number;output:string;workspaceHash:string;goalRevision:number;createdAt:string}
export interface Goal {id:string;title:string;prompt:string;workspace:string;acceptanceCommands:string[];status:RunStatus;revision:number;budget:Budget;usage:Usage&{calls:number;activeMs:number};createdAt:string;updatedAt:string;error?:string;summary?:string;evidence:Evidence[];parentId?:string;dependsOn:string[];supervised:boolean;contextLimit:number;reasoningEffort?:ReasoningEffort;context?:GoalContext}
export interface GoalInput {title?:string;prompt:string;workspace:string;acceptanceCommands?:string[];budget?:Partial<Budget>;supervised?:boolean;dependsOn?:string[];parentId?:string;contextLimit?:number;reasoningEffort?:ReasoningEffort}
export interface HarnessEvent {seq:number;goalId:string;type:string;data:unknown;createdAt:string}
export interface ToolIntent {id:string;goalId:string;revision:number;name:string;args:Record<string,unknown>;status:'pending'|'completed'|'uncertain';result?:ToolResult;createdAt:string}
export interface SessionStore {createGoal(input:GoalInput):Goal;getGoal(id:string):Goal|undefined;listGoals():Goal[];updateGoal(id:string,patch:Partial<Goal>):Goal;getMessages(id:string):ChatMessage[];appendMessage(id:string,message:ChatMessage):void;replaceMessages(id:string,messages:ChatMessage[]):void;appendEvent(goalId:string,type:string,data:unknown):HarnessEvent;events(after?:number,goalId?:string):HarnessEvent[];beginTool(goalId:string,revision:number,name:string,args:Record<string,unknown>):ToolIntent;finishTool(id:string,result:ToolResult):void;pendingTools(goalId?:string):ToolIntent[];close():void}
export interface EventBus {publish(event:HarnessEvent):void;subscribe(listener:(event:HarnessEvent)=>void):()=>void}
export interface GoalScheduler {start(id:string):Promise<void>;pause(id:string):Promise<void>;cancel(id:string):Promise<void>;recover():Promise<void>}
export interface BenchmarkAdapter {name:string;run(input:{workspace:string;prompt:string;baseUrl:string;token:string;signal?:AbortSignal}):Promise<{exitCode:number;output:string}>}
