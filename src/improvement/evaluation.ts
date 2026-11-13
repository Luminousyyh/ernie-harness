import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hashTree, relativeFile, sha256} from './archive.js';
export interface EvaluationTask {id:string;fixture:string;fixtureHash:string;prompt:string;grade:string[]}
export interface EvaluationManifest {schemaVersion:1;version:string;partition:'development'|'sealed-validation';tasks:EvaluationTask[]}
export interface EvaluationSuite {root:string;manifestHash:string;evaluatorHash:string}
export interface TaskScore {taskId:string;fixtureHash:string;promptHash:string;resolved:boolean;inputTokens:number;calls:number;activeMs:number}
export interface EvaluationScore {schemaVersion:1;partition:'development'|'sealed-validation';manifestHash:string;evaluatorHash:string;sourceHash:string;tasks:TaskScore[]}
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
export function validateCommand(v:unknown):asserts v is string[]{if(!Array.isArray(v)||!v.length||v.length>64||v.some(a=>typeof a!=='string'||a.includes('\0')||a.length>16384)||!v[0].startsWith('/')||['sh','bash','dash','zsh','cmd','powershell'].includes(v[0].split('/').pop()??''))throw new Error('Command must be an executable argument array');}
export function validateManifest(raw:unknown,partition:EvaluationManifest['partition']):EvaluationManifest{
 const v=raw as EvaluationManifest;if(!v||v.schemaVersion!==1||v.partition!==partition||typeof v.version!=='string'||!/^[a-zA-Z0-9._-]{1,80}$/.test(v.version)||!Array.isArray(v.tasks)||v.tasks.length<1||v.tasks.length>8)throw new Error('Invalid evaluator manifest version/partition');
 const seen=new Set<string>();for(const t of v.tasks){if(!t||typeof t.id!=='string'||!/^[a-zA-Z0-9._-]{1,80}$/.test(t.id)||seen.has(t.id)||!hash(t.fixtureHash)||typeof t.prompt!=='string'||!t.prompt.trim()||t.prompt.length>64000)throw new Error('Invalid evaluator task');seen.add(t.id);relativeFile(t.fixture);if(!t.fixture.startsWith('fixtures/'))throw new Error('Fixture outside evaluator');validateCommand(t.grade);}
 return v;
}
export async function loadSuite(suite:EvaluationSuite,partition:EvaluationManifest['partition']):Promise<EvaluationManifest>{
 if(!hash(suite.manifestHash)||!hash(suite.evaluatorHash))throw new Error('Evaluator pins required');const text=await readFile(join(suite.root,'manifest.json'),'utf8');if(sha256(text)!==suite.manifestHash||await hashTree(suite.root)!==suite.evaluatorHash)throw new Error('Evaluator manifest/hash mismatch');
 const manifest=validateManifest(JSON.parse(text),partition);for(const t of manifest.tasks)if(await hashTree(join(suite.root,t.fixture))!==t.fixtureHash)throw new Error('Fixture hash mismatch');return manifest;
}
export function validateScore(s:EvaluationScore):void{
 if(s.schemaVersion!==1||!['development','sealed-validation'].includes(s.partition)||![s.manifestHash,s.evaluatorHash,s.sourceHash].every(hash)||!Array.isArray(s.tasks)||!s.tasks.length)throw new Error('Invalid score contract');const ids=new Set<string>();
 for(const t of s.tasks){if(ids.has(t.taskId)||!t.taskId||![t.fixtureHash,t.promptHash].every(hash)||typeof t.resolved!=='boolean'||![t.inputTokens,t.calls,t.activeMs].every(v=>Number.isSafeInteger(v)&&v>=0)||t.calls>20||t.activeMs>1_800_000)throw new Error('Invalid score or task budget');ids.add(t.taskId);}
}
export function totals(s:EvaluationScore):{resolved:number;inputTokens:number;calls:number}{validateScore(s);return s.tasks.reduce((a,t)=>({resolved:a.resolved+Number(t.resolved),inputTokens:a.inputTokens+t.inputTokens,calls:a.calls+t.calls}),{resolved:0,inputTokens:0,calls:0});}
export function comparePairedScores(parent:EvaluationScore,candidate:EvaluationScore):'candidate'|'retain-parent'{
 validateScore(parent);validateScore(candidate);if(parent.partition!==candidate.partition||parent.manifestHash!==candidate.manifestHash||parent.evaluatorHash!==candidate.evaluatorHash||parent.tasks.length!==candidate.tasks.length)throw new Error('Unpaired score partition/hash');
 const p=new Map(parent.tasks.map(t=>[t.taskId,t]));for(const t of candidate.tasks){const other=p.get(t.taskId);if(!other||other.fixtureHash!==t.fixtureHash||other.promptHash!==t.promptHash)throw new Error('Unpaired task identity/hash');}
 const a=totals(parent),b=totals(candidate);if(a.resolved!==b.resolved)return b.resolved>a.resolved?'candidate':'retain-parent';if(a.inputTokens!==b.inputTokens)return b.inputTokens<a.inputTokens?'candidate':'retain-parent';return b.calls<a.calls?'candidate':'retain-parent';
}

/** Host-only metadata check. Neither sealed task descriptions nor outcomes are sent to the proposer. */
export function validatePartitionSeparation(development:EvaluationManifest,validation:EvaluationManifest):void{
 if(development.partition!=='development'||validation.partition!=='sealed-validation')throw new Error('Invalid partition pairing');
 const ids=new Set(development.tasks.map(t=>t.id)),fixtures=new Set(development.tasks.map(t=>t.fixtureHash));
 if(validation.tasks.some(t=>ids.has(t.id)||fixtures.has(t.fixtureHash)))throw new Error('Development and sealed-validation partitions overlap');
}
