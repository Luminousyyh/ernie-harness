import {randomUUID} from 'node:crypto';
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {cp,lstat,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {MODEL_ID,type ModelRequest} from '../contracts/index.js';
import {redactText,redactTrace} from '../trace/redact.js';
import {applyEdits,DEFAULT_TARGETS,hashMaterialization,hashTree,makeSnapshot,materializeSnapshot,readSnapshot,sha256,snapshotSource,validateEdits,type SourceSnapshot,type ValidatedPatch} from './archive.js';
import {comparePairedScores,loadSuite,totals,validateScore,validatePartitionSeparation,type EvaluationManifest,type EvaluationScore,type EvaluationSuite} from './evaluation.js';
import {LinuxCandidateSandbox} from './isolation.js';
import {ImprovementRepository} from './repository.js';
import {featureVector,FullCovarianceLinUCB,selectModules} from './search.js';
import {readProposerStrategy,validateProposerStrategy} from './proposer.js';
import {PROPOSAL_RULES} from './prompt.js';
import {developmentReflection} from './reflection.js';
import {abortable,checkAbort,runProcess} from './process.js';
import {ActiveRunError} from './errors.js';
import {captureWorkspace,workspacePatch} from './workspace.js';
import type {Activation,ActiveRunRecord,ActiveRunResult,RunActiveInput,AttemptUsage,DevelopmentTrace,ImprovementAttempt,ImprovementCandidate,ImprovementJob,ImprovementModule,ImprovementOptions,PatchProposal,StartImprovement} from './types.js';
export interface ImprovementView extends ImprovementJob {candidates:ImprovementCandidate[];attempts:ImprovementAttempt[]}
const ZERO:AttemptUsage={calls:0,inputTokens:0,outputTokens:0,reasoningTokens:0,activeMs:0};
/** Source archive + durable experiments; main owns HTTP/UI and supplies its shared model/budget/broker. */
export class ImprovementService {
 private readonly repository:ImprovementRepository;private readonly sandbox:LinuxCandidateSandbox;
 private readonly sourceRoot:string;private readonly stateDir:string;private readonly secretValues:readonly string[];
 private readonly tasks=new Map<string,{controller:AbortController;promise:Promise<void>}>();
 private closed=false;private closePromise?:Promise<void>;private readonly lockPath:string;private readonly owner=String(process.pid)+':'+randomUUID();
 constructor(private readonly options:ImprovementOptions){
  if(!options.model?.complete||!options.budget?.reserve||!options.budget?.settle)throw new Error('Shared model transport and persistent budget callbacks required');
  this.sourceRoot=realpathSync(resolve(options.sourceRoot));this.stateDir=resolve(options.stateDir);mkdirSync(this.stateDir,{recursive:true,mode:0o700});
  if(lstatSync(this.stateDir).isSymbolicLink()||realpathSync(this.stateDir).toLowerCase()!==this.stateDir.toLowerCase())throw new Error('Linked improvement state directory');
  this.lockPath=join(this.stateDir,'service.owner');
  if(existsSync(this.lockPath)){
   const s=lstatSync(this.lockPath);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw new Error('Unsafe improvement owner lock');
   const prior=readFileSync(this.lockPath,'utf8'),pid=Number(prior.split(':')[0]);if(!Number.isSafeInteger(pid)||pid<1)throw new Error('Invalid improvement owner lock');
   try{process.kill(pid,0);throw new Error('Improvement service already has an owner');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw new Error('Improvement service already has an owner');}
   unlinkSync(this.lockPath);
  }
  const fd=openSync(this.lockPath,'wx',0o600);try{writeFileSync(fd,this.owner);}finally{closeSync(fd);}
  try{this.repository=new ImprovementRepository(this.stateDir);}catch(e){unlinkSync(this.lockPath);throw e;}
  this.sandbox=new LinuxCandidateSandbox(options.environment);
  this.secretValues=[...(options.secrets??[]),...Object.entries(process.env).filter(([k])=>/key|token|secret|password|credential|authorization/i.test(k)).map(([,v])=>v??'').filter(v=>v.length>=8)];
 }
 private assertOpen(){if(this.closed)throw new Error('Improvement service closed');}
 private emit(jobId:string,type:string,data:unknown){try{this.options.onEvent?.({jobId,type,data:redactTrace(data,this.secretValues)});}catch{/* Observers do not control durable execution. */}}
 private archivePath(jobId:string,...parts:string[]):string{if(!/^[a-zA-Z0-9-]+$/.test(jobId)||parts.some(p=>!/^([a-zA-Z0-9._-]+)$/.test(p)||p==='..'||p==='.'))throw new Error('Invalid archive ID');return join(this.stateDir,'jobs',jobId,...parts);}
 list():ImprovementView[]{this.assertOpen();return this.repository.listJobs().map(j=>this.get(j.id)!);}
 get(id:string):ImprovementView|undefined{this.assertOpen();const j=this.repository.getJob(id);return j?{...j,candidates:j.candidateIds.map(x=>this.repository.candidate(x)!).filter(Boolean),attempts:this.repository.attempts(id)}:undefined;}
 active():Activation|undefined{this.assertOpen();return this.repository.active();}
 lineage(){this.assertOpen();return this.repository.lineage();}
 start(input:StartImprovement):ImprovementJob{
  this.assertOpen();const workspace=realpathSync(resolve(input.workspace));if(!lstatSync(workspace).isDirectory())throw new Error('Workspace must be a directory');
  const traces=input.traces??[];if(traces.length>100||traces.some(t=>t.partition!=='development'||!this.options.environment||t.manifestHash!==this.options.environment.development.manifestHash))throw new Error('Only pinned development partition traces may reach the proposer');
  const selection=input.selection??{mode:'search' as const};selectModules(selection,new FullCovarianceLinUCB(),[]);
  const job=this.repository.createJob({workspace,maxCalls:input.maxCalls??400,maxCandidates:input.maxCandidates??2,selection});
  const controller=new AbortController(),promise=Promise.resolve().then(()=>this.run(job.id,traces,controller.signal)).catch(()=>{/* run persists terminal state. */});this.tasks.set(job.id,{controller,promise});
  void promise.finally(()=>this.tasks.delete(job.id));this.emit(job.id,'improvement.queued',{status:job.status});return job;
 }
 async wait(id:string):Promise<void>{this.assertOpen();await this.tasks.get(id)?.promise;}
 cancel(id:string):ImprovementJob|ActiveRunRecord{
  this.assertOpen();const activeRun=this.repository.activeRun(id);if(activeRun){this.tasks.get(id)?.controller.abort();if(['preparing','running','needs-reconciliation'].includes(activeRun.status))this.repository.patchActiveRun(id,{status:'cancelled'});return this.repository.activeRun(id)!;}const job=this.repository.getJob(id);if(!job)throw new Error('Unknown improvement job');if(['completed','cancelled','failed'].includes(job.status))return job;
  this.tasks.get(id)?.controller.abort();return this.repository.patchJob(id,{status:'cancelled'});
 }
 private async writeJson(path:string,data:unknown):Promise<void>{await writeFile(path,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});}
 private assertNoCredentials(text:string){if(this.secretValues.some(s=>text.includes(s)))throw new Error('Runtime credential detected in archive input');}
 private async reserve(jobId:string,kind:ImprovementAttempt['kind'],calls:number,signal:AbortSignal,meta:Pick<ImprovementAttempt,'candidateId'|'partition'>={}):Promise<ImprovementAttempt>{
  checkAbort(signal);const a=this.repository.reserve(jobId,kind,calls,meta);
  try{await abortable(this.options.budget.reserve({jobId,attemptId:a.id,kind,maxCalls:calls,inputTokens:kind==='proposal'?512000:2000000,outputTokens:kind==='proposal'?16384:128000},signal),signal);return a;}
  catch{this.repository.failAttempt(a.id);throw new Error('Shared improvement budget unavailable');}
 }
 private async settle(a:ImprovementAttempt,usage:AttemptUsage|undefined):Promise<void>{
  if(!usage)this.repository.failAttempt(a.id);
  try{await this.options.budget.settle({jobId:a.jobId,attemptId:a.id,usage:usage??{...ZERO,calls:a.reservedCalls},uncertain:!usage});}
  catch{if(usage)this.repository.failAttempt(a.id);throw new Error('Shared improvement settlement requires reconciliation');}
  if(usage)try{this.repository.settle(a.id,usage);}catch{this.repository.failAttempt(a.id);throw new Error('Improvement settlement requires reconciliation');}
 }
 private async propose(jobId:string,parent:SourceSnapshot,modules:ImprovementModule[],traces:DevelopmentTrace[],signal:AbortSignal):Promise<PatchProposal>{
  traces=[...new Map([...traces,...this.repository.developmentTraces(this.options.environment?.development.manifestHash??'')].map(t=>[sha256(JSON.stringify(t)),t])).values()];const strategy=readProposerStrategy(parent),prior=this.repository.getJob(jobId)!.candidateIds.map(id=>this.repository.candidate(id)!).filter(c=>c.score?.partition==='development'&&c.score.manifestHash===this.options.environment?.development.manifestHash).map(c=>totals(c.score!));
  const files=Object.entries(parent.files).filter(([p])=>modules.some(m=>DEFAULT_TARGETS[m].includes(p))).map(([path,content])=>({path,beforeSha256:sha256(content),content}));
  if(!files.length)throw new Error('Selected modules have no editable source files');if(strategy.sourceOrder==='path')files.sort((a,b)=>a.path.localeCompare(b.path));else{const evidence=JSON.stringify(traces);files.sort((a,b)=>Number(evidence.includes(b.path))-Number(evidence.includes(a.path))||a.path.localeCompare(b.path));}
  const evidence=JSON.stringify(redactTrace(traces,this.secretValues)).slice(0,strategy.maxTraceChars),reflection=strategy.reflection?developmentReflection(traces,prior):undefined;
  const request:ModelRequest={messages:[{role:'system',content:PROPOSAL_RULES},{role:'user',content:JSON.stringify({selectedModules:modules,files,strategy:strategy.instructions,developmentEvidence:evidence,pairedDevelopmentOutcomes:prior,reflection,maxFiles:strategy.maxFiles})}],maxTokens:16384,temperature:0,reasoningEffort:'high'};
  if(Buffer.byteLength(JSON.stringify(request))>512000)throw new Error('Proposal source context limit exceeded');
  const a=await this.reserve(jobId,'proposal',1,signal);let usage:AttemptUsage|undefined;
  try{
   const started=Date.now(),response=await abortable(this.options.model.complete(request,undefined,signal),signal);
   if(response.model!==MODEL_ID||![response.usage.inputTokens,response.usage.outputTokens,response.usage.reasoningTokens].every(v=>Number.isSafeInteger(v)&&v>=0))throw new Error('Unexpected model or invalid usage');
   usage={inputTokens:response.usage.inputTokens,outputTokens:response.usage.outputTokens,reasoningTokens:response.usage.reasoningTokens,calls:1,activeMs:Date.now()-started};const text=response.message.content;if(typeof text!=='string'||Buffer.byteLength(text)>600000||redactText(text,this.secretValues)!==text)throw new Error('Invalid or sensitive model proposal');
   const proposal=JSON.parse(text) as PatchProposal;if(proposal.schemaVersion!==1||typeof proposal.summary!=='string'||proposal.summary.length>4000||!Array.isArray(proposal.edits)||proposal.edits.length>strategy.maxFiles||Object.keys(proposal).some(k=>!['schemaVersion','summary','edits'].includes(k)))throw new Error('Invalid structured proposal schema');
   for(const e of proposal.edits)if(e.path==='src/improvement/proposer-strategy.json')validateProposerStrategy(JSON.parse(e.content));
   return proposal;
  }finally{await this.settle(a,usage);}
 }
 private patchText(parent:SourceSnapshot,patch:ValidatedPatch):string{
  const lines=(text:string)=>text.match(/[^\n]*\n|[^\n]+$/g)??[];
  const render=(values:string[],prefix:string)=>values.map(v=>prefix+v+(v.endsWith('\n')?'':'\n\\ No newline at end of file\n')).join('');
  return patch.edits.map(e=>{const a=lines(parent.files[e.path]),b=lines(e.content);return`diff --git a/${e.path} b/${e.path}\n--- a/${e.path}\n+++ b/${e.path}\n@@ -${a.length?1:0},${a.length} +${b.length?1:0},${b.length} @@\n`+render(a,'-')+render(b,'+');}).join('');
 }
 private async archiveCandidate(jobId:string,parent:SourceSnapshot,modules:ImprovementModule[],proposal:PatchProposal,parentDir:string,signal:AbortSignal):Promise<ImprovementCandidate>{
  const patch=await validateEdits(parentDir,proposal.edits,modules);for(const e of patch.edits)this.assertNoCredentials(e.content);
  const id=randomUUID(),dir=this.archivePath(jobId,'candidates',id);await mkdir(dir,{recursive:true,mode:0o700});
  const source=makeSnapshot({...parent.files,...Object.fromEntries(patch.edits.map(e=>[e.path,e.content]))});
  const c=this.repository.addCandidate(jobId,{id,modules,parentId:this.repository.getJob(jobId)!.parentId,sourceHash:source.hash,patchHash:patch.hash,status:'proposed',archivePath:dir,developmentHash:this.options.environment?.development.manifestHash,validationHash:this.options.environment?.validation.manifestHash});
  await this.writeJson(join(dir,'source.json'),source);await this.writeJson(join(dir,'edits.json'),patch);await this.writeJson(join(dir,'proposal.json'),redactTrace(proposal,this.secretValues));await writeFile(join(dir,'changes.patch'),this.patchText(parent,patch),{flag:'wx',mode:0o600});
  // Git worktree keeps provenance isolated. Its .git pointer is NEVER mounted in a sandbox.
  const worktree=join(dir,'git-worktree'),hooks=join(this.stateDir,'empty-hooks');await mkdir(hooks,{recursive:true});
  const git=['git','-c','core.hooksPath='+hooks,'-c','core.fsmonitor=false','-C',this.sourceRoot];
  const head=await runProcess([...git,'rev-parse','--verify','HEAD'],{cwd:this.sourceRoot,signal,secrets:this.secretValues});if(head.exitCode!==0||!/^[a-f0-9]{40,64}$/.test(head.output.trim()))throw new Error('Source Git revision unavailable');
  const created=await runProcess([...git,'worktree','add','--detach','--no-checkout',worktree,head.output.trim()],{cwd:this.sourceRoot,signal,secrets:this.secretValues});if(created.exitCode!==0)throw new Error('Isolated Git worktree creation failed');
  for(const [path,content] of Object.entries(parent.files)){const dest=join(worktree,...path.split('/'));await mkdir(dirname(dest),{recursive:true});await writeFile(dest,content,{flag:'wx',mode:0o600});}
  await applyEdits(worktree,patch);if((await snapshotSource(worktree)).hash!==source.hash)throw new Error('Candidate worktree source hash mismatch');
  await this.writeJson(join(dir,'provenance.json'),{gitHead:head.output.trim(),parentSourceHash:parent.hash,sourceHash:source.hash,patchHash:patch.hash,modules});await materializeSnapshot(source,join(dir,'materialized'));return c;
 }
 private async evaluate(jobId:string,candidateId:string|undefined,source:SourceSnapshot,materialized:string,suite:EvaluationSuite,manifest:EvaluationManifest,signal:AbortSignal):Promise<EvaluationScore>{
  const score:EvaluationScore={schemaVersion:1,partition:manifest.partition,manifestHash:suite.manifestHash,evaluatorHash:suite.evaluatorHash,sourceHash:source.hash,tasks:[]};
  for(const task of manifest.tasks){
   checkAbort(signal);await loadSuite(suite,manifest.partition);const a=await this.reserve(jobId,'evaluation',20,signal,{candidateId,partition:manifest.partition});let usage:AttemptUsage|undefined,trial:Awaited<ReturnType<NonNullable<ImprovementOptions['environment']>['broker']['openTrial']>>|undefined;
   try{
    trial=await this.options.environment!.broker.openTrial({id:a.id,maxCalls:20,maxActiveMs:1800000,partition:manifest.partition,signal});
    const result=await this.sandbox.task({candidate:materialized,suite,manifest,task,stateDir:this.archivePath(jobId),signal,trial});
    const completedTrial=trial;trial=undefined;const final=await completedTrial.finish();if(final.uncertain)throw new Error('Broker attempt outcome uncertain');usage=final.usage;if(usage.calls>20||usage.activeMs>1800000)throw new Error('Broker task allowance exceeded');
    if(manifest.partition==='development'&&result.developmentTrace)this.repository.recordDevelopmentTrace(jobId,{partition:'development',manifestHash:suite.manifestHash,taskId:task.id,content:redactTrace({sourceHash:source.hash,...result.developmentTrace},this.secretValues)});
    score.tasks.push({taskId:task.id,fixtureHash:task.fixtureHash,promptHash:sha256(task.prompt),resolved:result.resolved,inputTokens:usage.inputTokens,calls:usage.calls,activeMs:usage.activeMs});
    // Scores/hashes only; sealed stdout, prompts and grading traces never enter the proposal archive.
    await this.writeJson(this.archivePath(jobId,'attempt-'+a.id+'.json'),{attemptId:a.id,partition:manifest.partition,taskId:task.id,...result});
   }finally{if(trial)try{const interruptedTrial=trial;trial=undefined;const final=await interruptedTrial.finish();if(!final.uncertain)usage=final.usage;}catch{/* Unknown effects keep the entire reservation. */}await this.settle(a,usage);}
  }
  validateScore(score);return score;
 }
 private async run(id:string,traces:DevelopmentTrace[],signal:AbortSignal):Promise<void>{
  try{
   checkAbort(signal);const dir=this.archivePath(id);await mkdir(dir,{recursive:true,mode:0o700});const rootSnapshot=await snapshotSource(this.sourceRoot);for(const content of Object.values(rootSnapshot.files))this.assertNoCredentials(content);
   const active=this.repository.active(),parent=active?await snapshotSource(active.path):rootSnapshot;const parentDir=join(dir,'parent');await materializeSnapshot(parent,parentDir);await this.writeJson(join(dir,'parent-source.json'),parent);await this.writeJson(join(dir,'root-source.json'),rootSnapshot);
   const env=this.options.environment;let dev:EvaluationManifest|undefined;if(env){if((resolve(env.development.root)===resolve(env.validation.root)||resolve(env.development.root).startsWith(resolve(env.validation.root)+sep)||resolve(env.validation.root).startsWith(resolve(env.development.root)+sep))||env.development.manifestHash===env.validation.manifestHash)throw new Error('Development and sealed validation must be separate');dev=await loadSuite(env.development,'development');const sealed=await loadSuite(env.validation,'sealed-validation');validatePartitionSeparation(dev,sealed);for(const suite of [env.development,env.validation])for(const part of ['src','web','tests']){const subtree=join(this.sourceRoot,part);if(resolve(suite.root)===this.sourceRoot||resolve(suite.root)===subtree||resolve(suite.root).startsWith(subtree+sep)||subtree.startsWith(resolve(suite.root)+sep))throw new Error('Evaluator overlaps source archive');}if(traces.some(t=>!dev!.tasks.some(x=>x.id===t.taskId)))throw new Error('Trace task outside development manifest');}
   const cleanTraces=redactTrace(traces,this.secretValues) as DevelopmentTrace[];if(JSON.stringify(cleanTraces).length>2000000)throw new Error('Development trace archive limit exceeded');await this.writeJson(join(dir,'development-traces.json'),cleanTraces);for(const t of cleanTraces)this.repository.recordDevelopmentTrace(id,t);traces=cleanTraces;
   this.repository.patchJob(id,{parentId:active?.candidateId??null,parentSourceHash:parent.hash,developmentHash:env?.development.manifestHash,validationHash:env?.validation.manifestHash,status:'proposing'});
   const isolation=await this.sandbox.verify(signal);checkAbort(signal);this.repository.patchJob(id,{isolation});
   const context=sha256(JSON.stringify({developmentHash:env?.development.manifestHash,evaluatorHash:env?.development.evaluatorHash,featureVersion:1})),bandit=new FullCovarianceLinUCB(16,this.repository.getBandit(context));
   const selected:ImprovementModule[][]=[],evaluated:ImprovementCandidate[]=[];let parentScore:EvaluationScore|undefined,parentBuilt=false;
   const max=this.repository.getJob(id)!.maxCandidates;
   for(let i=0;i<max;i++){
    checkAbort(signal);this.repository.patchJob(id,{status:'proposing'});const modules=selectModules(this.repository.getJob(id)!.selection,bandit,selected);selected.push(modules);
    const proposal=await this.propose(id,parent,modules,traces,signal);checkAbort(signal);const candidate=await this.archiveCandidate(id,parent,modules,proposal,parentDir,signal);this.emit(id,'improvement.proposed',{candidateId:candidate.id,modules});
    if(!isolation.verified){this.repository.patchCandidate(candidate.id,{status:'awaiting-environment',isolation});continue;}
    if(!env||!dev)throw new Error('Pinned evaluation environment missing');this.repository.patchJob(id,{status:'evaluating'});this.repository.patchCandidate(candidate.id,{status:'building',isolation});
    if(!parentBuilt){const build=await this.sandbox.build(parentDir,dir,signal);await this.writeJson(join(dir,'parent-build.json'),build);if(!build.passed)throw new Error('Parent build/tests failed');if((await snapshotSource(parentDir)).hash!==parent.hash)throw new Error('Parent source mutated during build/tests');parentBuilt=true;}
    const runtime=join(candidate.archivePath!,'materialized'),build=await this.sandbox.build(runtime,dir,signal);await this.writeJson(join(candidate.archivePath!,'build.json'),build);
    if(!build.passed){this.repository.patchCandidate(candidate.id,{status:'failed',buildPassed:false,error:'Candidate build/tests failed'});continue;}
    if((await snapshotSource(runtime)).hash!==candidate.sourceHash)throw new Error('Candidate source mutated during build/tests');
    const artifactHash=await hashMaterialization(runtime);parentScore??=await this.evaluate(id,undefined,parent,parentDir,env.development,dev,signal);
    const source=await readSnapshot(join(candidate.archivePath!,'source.json')),score=await this.evaluate(id,candidate.id,source,runtime,env.development,dev,signal),decision=comparePairedScores(parentScore,score);
    const c=this.repository.patchCandidate(candidate.id,{status:decision==='candidate'?'evaluated':'rejected',parentScore,score,buildPassed:true,artifactHash,isolation});evaluated.push(c);
    const total=totals(score),n=score.tasks.length;bandit.update(featureVector(modules),total.resolved/n+0.01/(n+1)/(1+total.inputTokens)+0.0001/(n+1)/(1+total.calls));this.repository.saveBandit(context,bandit.state());
   }
   if(!isolation.verified){this.repository.patchJob(id,{status:'awaiting-environment',error:isolation.reason});return;}
   let winner:ImprovementCandidate|undefined;for(const c of evaluated.filter(x=>x.status==='evaluated'))if(!winner||comparePairedScores(winner.score!,c.score!)==='candidate')winner=c;
   if(winner&&env){
    const val=await loadSuite(env.validation,'sealed-validation');if(this.repository.getJob(id)!.calls+val.tasks.length*40>this.repository.getJob(id)!.maxCalls)throw new Error('Insufficient remaining calls for paired sealed validation');
    // Durably consume BEFORE any heldout call; interrupted/failed runs cannot reuse the partition.
    this.repository.seal(env.validation.manifestHash,id,winner.id);this.repository.patchJob(id,{status:'validating'});
    const source=await readSnapshot(join(winner.archivePath!,'source.json'));
    const parentValidation=await this.evaluate(id,undefined,parent,parentDir,env.validation,val,signal),validation=await this.evaluate(id,winner.id,source,join(winner.archivePath!,'materialized'),env.validation,val,signal);
    const accepted=comparePairedScores(parentValidation,validation)==='candidate';this.repository.patchCandidate(winner.id,{status:accepted?'eligible':'rejected',parentValidation,validation});if(accepted)this.repository.patchJob(id,{winnerId:winner.id});
   }
   this.repository.patchJob(id,{status:'completed'});this.emit(id,'improvement.completed',{winnerId:this.repository.getJob(id)!.winnerId});
  }catch{
   const cancelled=signal.aborted||this.repository.getJob(id)?.status==='cancelled';this.repository.patchJob(id,{status:cancelled?'cancelled':'failed',error:cancelled?'Improvement cancelled':'Improvement failed; inspect durable attempt and candidate states'});this.emit(id,cancelled?'improvement.cancelled':'improvement.failed',{status:cancelled?'cancelled':'failed'});
  }
 }
 async apply(candidateId:string):Promise<Activation>{
  this.assertOpen();const c=this.repository.candidate(candidateId);if(!c||c.status!=='eligible'||!c.buildPassed||!c.isolation?.verified||!c.score||!c.parentScore||!c.validation||!c.parentValidation)throw new Error('Candidate requires eligible isolated evaluation and sealed validation');
  const env=this.options.environment;if(!env||(await this.sandbox.verify(new AbortController().signal)).verified!==true)throw new Error('Verified Linux isolation required for activation');
  await loadSuite(env.development,'development');await loadSuite(env.validation,'sealed-validation');
  if(c.developmentHash!==env.development.manifestHash||c.validationHash!==env.validation.manifestHash||c.score.sourceHash!==c.sourceHash||c.validation.sourceHash!==c.sourceHash||comparePairedScores(c.parentScore,c.score)!=='candidate'||comparePairedScores(c.parentValidation,c.validation)!=='candidate')throw new Error('Candidate evidence/manifest stale or promotion tie');
  const parent=await readSnapshot(this.archivePath(c.jobId,'parent-source.json')),root=await readSnapshot(this.archivePath(c.jobId,'root-source.json'));
  if((await snapshotSource(this.sourceRoot)).hash!==root.hash||parent.hash!==c.parentScore.sourceHash||parent.hash!==c.parentValidation.sourceHash)throw new Error('Stable source changed since evaluation');
  const archive=this.archivePath(c.jobId,'candidates',c.id),source=await readSnapshot(join(archive,'source.json')),patch=JSON.parse(await readFile(join(archive,'edits.json'),'utf8')) as ValidatedPatch;
  if(!c.artifactHash||await hashMaterialization(join(archive,'materialized'))!==c.artifactHash||source.hash!==c.sourceHash||patch.hash!==c.patchHash||patch.hash!==sha256(JSON.stringify(patch.edits))||source.hash!==makeSnapshot({...parent.files,...Object.fromEntries(patch.edits.map(e=>[e.path,e.content]))}).hash||(await snapshotSource(join(archive,'materialized'))).hash!==source.hash)throw new Error('Candidate archive hash mismatch');
  // Atomic activation points at an immutable source version; no executing/overwriting arbitrary source on the host.
  if(!this.repository.active())this.repository.activate({candidateId:null,sourceHash:parent.hash,path:this.archivePath(c.jobId,'parent'),artifactHash:await hashMaterialization(this.archivePath(c.jobId,'parent')),parentId:null},null);
  const activation=this.repository.activate({candidateId:c.id,sourceHash:c.sourceHash,path:join(archive,'materialized'),artifactHash:c.artifactHash,parentId:c.parentId},c.parentId);this.repository.patchCandidate(c.id,{status:'applied'});return activation;
 }
 async rollback(input?:{expectedCandidateId?:string|null}):Promise<Activation>{
  this.assertOpen();const current=this.repository.active();if(!current)throw new Error('No active improvement version');
  const history=this.repository.lineage().filter(x=>x.action==='apply'),prior=[...history].reverse().find(x=>x.activation.candidateId===current.parentId)?.activation;if(!prior||(await snapshotSource(prior.path)).hash!==prior.sourceHash)throw new Error('Rollback archive unavailable or changed');
  return this.repository.rollback(input&&Object.hasOwn(input,'expectedCandidateId')?input.expectedCandidateId!:current.candidateId);
 }
 getActiveRun(id:string):ActiveRunRecord|undefined{this.assertOpen();return this.repository.activeRun(id);}
 listActiveRuns():ActiveRunRecord[]{this.assertOpen();return this.repository.listActiveRuns();}
 /** Execute only the activated version, never fall back to stable source or import candidate code on the host. */
 runActive(input:RunActiveInput):Promise<ActiveRunResult>{
  this.assertOpen();const id=input.id??randomUUID(),controller=new AbortController();
  if(!/^[a-zA-Z0-9-]{1,100}$/.test(id)||this.tasks.has(id)||this.repository.activeRun(id)||this.repository.getJob(id))return Promise.reject(new ActiveRunError(id,'INVALID_INPUT','Active launch ID invalid or already used'));
  const abort=()=>controller.abort();input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();
  const result=Promise.resolve().then(()=>this.executeActive(id,input,controller.signal)).catch(error=>{if(error instanceof ActiveRunError)throw error;if(controller.signal.aborted)throw new ActiveRunError(id,'CANCELLED','Active launch cancelled','cancelled');throw new ActiveRunError(id,'EXECUTION_FAILED','Active launch failed; inspect durable record');});
  const owned=result.then(()=>{},()=>{}).finally(()=>{input.signal?.removeEventListener('abort',abort);this.tasks.delete(id);});
  this.tasks.set(id,{controller,promise:owned});return result;
 }
 private async executeActive(id:string,input:RunActiveInput,signal:AbortSignal):Promise<ActiveRunResult>{
  checkAbort(signal);if(!this.options.environment)throw new ActiveRunError(id,'ENVIRONMENT_UNAVAILABLE','Verified Linux improvement environment required');
  if(typeof input.prompt!=='string'||!input.prompt.trim()||Buffer.byteLength(input.prompt)>64000)throw new ActiveRunError(id,'INVALID_INPUT','Bounded task prompt required');this.assertNoCredentials(input.prompt);
  const maxCalls=input.maxCalls??20,maxActiveMs=input.maxActiveMs??1800000;
  if(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>20||!Number.isSafeInteger(maxActiveMs)||maxActiveMs<1||maxActiveMs>1800000)throw new ActiveRunError(id,'INVALID_INPUT','Active task budget must be 1..20 calls and at most 30 minutes');
  const active=this.repository.active();if(!active?.artifactHash)throw new ActiveRunError(id,'ACTIVE_VERSION_UNAVAILABLE','Active materialization with pinned build artifact hash required');
  if(input.expectedSourceHash!==undefined&&input.expectedSourceHash!==active.sourceHash||Object.hasOwn(input,'expectedCandidateId')&&input.expectedCandidateId!==active.candidateId)throw new ActiveRunError(id,'ACTIVE_VERSION_MISMATCH','Goal-pinned active version differs from current activation');
  const candidate=active.candidateId?this.repository.candidate(active.candidateId):undefined;
  if(active.candidateId&&(!candidate||!['applied','eligible'].includes(candidate.status)||candidate.sourceHash!==active.sourceHash||candidate.artifactHash!==active.artifactHash))throw new ActiveRunError(id,'ACTIVE_INTEGRITY_FAILED','Active candidate integrity mismatch');
  if((await snapshotSource(active.path)).hash!==active.sourceHash||await hashMaterialization(active.path)!==active.artifactHash)throw new ActiveRunError(id,'ACTIVE_INTEGRITY_FAILED','Active source/build artifact hash changed');
  const isolation=await this.sandbox.verify(signal);checkAbort(signal);if(!isolation.verified)throw new ActiveRunError(id,'ENVIRONMENT_UNAVAILABLE','Verified Linux Bubblewrap isolation required');
  const workspace=realpathSync(resolve(input.workspace));
  for(const forbidden of [this.stateDir,this.options.environment.development.root,this.options.environment.validation.root]){
   const boundary=resolve(forbidden);if(workspace===boundary||workspace.startsWith(boundary+sep)||boundary.startsWith(workspace+sep))throw new ActiveRunError(id,'PRIVATE_WORKSPACE','User workspace overlaps private state/evaluator');
  }
  if(this.repository.listActiveRuns().some(r=>r.workspace===workspace&&['preparing','running','needs-reconciliation'].includes(r.status))||this.repository.listJobs().some(j=>j.workspace===workspace&&['queued','proposing','evaluating','validating','needs-reconciliation'].includes(j.status)))throw new ActiveRunError(id,'WORKSPACE_BUSY','Workspace already owned by an improvement operation');
  const r=this.repository.createActiveRun({id,workspace,promptHash:sha256(input.prompt),candidateId:active.candidateId,sourceHash:active.sourceHash,artifactHash:active.artifactHash,status:'preparing',maxCalls,maxActiveMs,reservation:{id:randomUUID(),status:'unreserved',maxCalls,inputTokens:2000000,outputTokens:128000}});
  const dir=join(this.stateDir,'active-runs',id),trialSecrets:string[]=[];let usage:AttemptUsage|undefined,trial:Awaited<ReturnType<NonNullable<ImprovementOptions['environment']>['broker']['openTrial']>>|undefined,settlementAttempted=false;
  const settle=async(uncertain:boolean)=>{settlementAttempted=true;try{await this.options.budget.settle({jobId:id,attemptId:r.reservation.id,usage:usage??{...ZERO,calls:maxCalls},uncertain});this.repository.patchActiveRun(id,{reservation:{...r.reservation,status:uncertain?'uncertain':'completed',usage}});}catch{this.repository.patchActiveRun(id,{reservation:{...r.reservation,status:'uncertain',usage}});throw new Error('Shared budget settlement requires reconciliation');}};
  try{
   await mkdir(dir,{recursive:true,mode:0o700});const before=await captureWorkspace(workspace,this.secretValues),staged=join(dir,'workspace'),materialized=join(dir,'candidate');
   await materializeSnapshot(before,staged);
   // Copy source AND tested build artifacts after hashing; only the copy enters the namespace.
   await cp(active.path,materialized,{recursive:true,dereference:false,errorOnExist:true,force:false});
   if((await snapshotSource(materialized)).hash!==active.sourceHash||await hashMaterialization(materialized)!==active.artifactHash)throw new Error('Active copy hash mismatch');
   await this.writeJson(join(dir,'provenance.json'),{candidateId:active.candidateId,sourceHash:active.sourceHash,artifactHash:active.artifactHash,workspaceHash:before.hash,promptHash:r.promptHash,isolation});
   checkAbort(signal);this.repository.patchActiveRun(id,{reservation:{...r.reservation,status:'reserved'}});
   await abortable(this.options.budget.reserve({jobId:id,attemptId:r.reservation.id,kind:'active-run',maxCalls,inputTokens:r.reservation.inputTokens,outputTokens:r.reservation.outputTokens},signal),signal);
   checkAbort(signal);trial=await this.options.environment.broker.openTrial({id:r.reservation.id,maxCalls,maxActiveMs,partition:'user-task',signal});trialSecrets.push(trial.token);this.repository.patchActiveRun(id,{status:'running'});
   const execution=await this.sandbox.runAgent({candidate:materialized,workspace:staged,prompt:input.prompt,stateDir:dir,signal,maxCalls,maxActiveMs,trial});
   const completed=trial;trial=undefined;const final=await completed.finish();if(final.uncertain)throw new Error('Broker usage uncertain; reconciliation required');usage=final.usage;
   if(!['calls','inputTokens','outputTokens','reasoningTokens','activeMs'].every(k=>Number.isSafeInteger(usage![k as keyof AttemptUsage])&&usage![k as keyof AttemptUsage]>=0)||usage.calls>maxCalls||usage.activeMs>maxActiveMs)throw new ActiveRunError(id,'BUDGET_EXCEEDED','Authoritative broker allowance exceeded','failed',usage);
   await settle(false);checkAbort(signal);
   if(await hashMaterialization(materialized)!==active.artifactHash)throw new Error('Candidate artifacts changed during isolated launch');
   const patch=workspacePatch(before,await captureWorkspace(staged,[...this.secretValues,...trialSecrets])),result:ActiveRunResult={id,status:execution.exitCode===0?'completed':'failed',candidateId:active.candidateId,sourceHash:active.sourceHash,artifactHash:active.artifactHash,isolation,usage,patch,exitCode:execution.exitCode,outputHash:execution.outputHash,...(execution.exitCode===0?{}:{failureCode:'AGENT_EXIT_NONZERO' as const})};
   await this.writeJson(join(dir,'result.json'),result);this.repository.patchActiveRun(id,{status:result.status,result});return result;
  }catch(error){
   if(trial){const interrupted=trial;trial=undefined;try{const final=await interrupted.finish();if(!final.uncertain)usage=final.usage;}catch{/* Full reservation remains when broker cannot confirm. */}}
   const current=this.repository.activeRun(id)!;
   if(!settlementAttempted&&current.reservation.status==='reserved')try{await settle(!usage);}catch{/* No replay of a settlement whose effect is uncertain. */}
   const cancelled=signal.aborted||current.status==='cancelled',uncertain=this.repository.activeRun(id)!.reservation.status==='uncertain';
   this.repository.patchActiveRun(id,{status:cancelled?'cancelled':uncertain?'needs-reconciliation':'failed',error:cancelled?'Active launch cancelled':uncertain?'Active launch budget uncertain; reconciliation required':'Active launch failed; no changes applied'});
   if(cancelled)throw new ActiveRunError(id,'CANCELLED','Active launch cancelled','cancelled',usage);if(uncertain)throw new ActiveRunError(id,'NEEDS_RECONCILIATION','Active launch budget uncertain; reconciliation required','needs-reconciliation',usage);if(error instanceof ActiveRunError)throw error;throw new ActiveRunError(id,'EXECUTION_FAILED','Active launch failed; inspect durable record','failed',usage);
  }finally{if(!resolve(dir).startsWith(join(this.stateDir,'active-runs')+sep)||!/^[-a-zA-Z0-9]+$/.test(id))throw new Error('Unsafe active launch cleanup');await rm(join(dir,'workspace'),{recursive:true,force:true});await rm(join(dir,'candidate'),{recursive:true,force:true});}
 }
 close():Promise<void>{
  if(this.closePromise)return this.closePromise;this.closed=true;
  this.closePromise=(async()=>{for(const t of this.tasks.values())t.controller.abort();await Promise.allSettled([...this.tasks.values()].map(t=>t.promise));this.repository.close();if(existsSync(this.lockPath)&&readFileSync(this.lockPath,'utf8')===this.owner)unlinkSync(this.lockPath);})();return this.closePromise;
 }
}
