import {createHash} from 'node:crypto';
import {lstat, mkdir, readdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {dirname, join, resolve, sep} from 'node:path';
import type {ImprovementModule, StructuredEdit} from './types.js';
export const sha256=(value:string|Buffer):string=>createHash('sha256').update(value).digest('hex');
export const DEFAULT_TARGETS:Record<ImprovementModule,readonly string[]>={
 tools:['src/tools/files.ts','src/tools/search.ts','src/tools/schemas.ts'],
 context:['src/core/context.ts'],prompt:['src/improvement/prompt.ts'],reflection:['src/improvement/reflection.ts'],proposer:['src/improvement/proposer-strategy.json'],
};
export interface SourceSnapshot {schemaVersion:1;hash:string;files:Record<string,string>}
export interface ValidatedPatch {schemaVersion:1;hash:string;edits:(StructuredEdit&{module:ImprovementModule;afterSha256:string})[]}
const SHA=/^[a-f0-9]{64}$/;
export function relativeFile(path:string):void {
 if(typeof path!=='string'||path.length>240||!path||path!==path.normalize('NFC')||!/^[a-zA-Z0-9_./@+-]+$/.test(path)||path.startsWith('/')||path.split('/').some(s=>!s||s==='.'||s==='..'||s.toLowerCase()==='.git')||path.includes(':'))throw new Error('Unsafe archive/edit path');
}
export async function safeRegular(root:string,path:string):Promise<string>{
 relativeFile(path);const base=resolve(root);if((await lstat(base)).isSymbolicLink())throw new Error('Linked source root');
 const canonical=await realpath(base);if(canonical.toLowerCase()!==base.toLowerCase())throw new Error('Linked source ancestor');
 let current=base;for(const [i,segment] of path.split('/').entries()){
  current=join(current,segment);const s=await lstat(current);if(s.isSymbolicLink()||s.nlink>1&&s.isFile())throw new Error('Linked source/edit target');
  if(i<path.split('/').length-1?!s.isDirectory():!s.isFile())throw new Error('Not a regular source file');
 }
 if(!current.startsWith(base+sep))throw new Error('Escaping source path');return current;
}
export async function validateEdits(root:string,raw:unknown,modules:readonly ImprovementModule[]):Promise<ValidatedPatch>{
 if(!Array.isArray(raw)||raw.length<1||raw.length>6)throw new Error('Proposal must contain 1..6 edits');
 const seen=new Set<string>();let bytes=0;const edits:ValidatedPatch['edits']=[];
 for(const item of raw){
  if(!item||typeof item!=='object'||Object.keys(item).some(k=>!['path','beforeSha256','content'].includes(k)))throw new Error('Invalid structured edit');
  const e=item as StructuredEdit;relativeFile(e.path);if(seen.has(e.path.toLowerCase()))throw new Error('Duplicate edit');seen.add(e.path.toLowerCase());
  const module=modules.find(m=>DEFAULT_TARGETS[m]?.includes(e.path));if(!module)throw new Error('Edit outside selected module allowlist');
  if(typeof e.content!=='string'||e.content.includes('\0')||!SHA.test(e.beforeSha256)||e.content===await readFile(await safeRegular(root,e.path),'utf8'))throw new Error('Invalid or empty edit');
  bytes+=Buffer.byteLength(e.content);if(bytes>512_000)throw new Error('Edit size exceeded');
  if(sha256(await readFile(await safeRegular(root,e.path)))!==e.beforeSha256)throw new Error('Stale edit base hash');
  edits.push({...e,module,afterSha256:sha256(e.content)});
 }
 return{schemaVersion:1,hash:sha256(JSON.stringify(edits)),edits};
}
export async function applyEdits(root:string,patch:ValidatedPatch):Promise<void>{
 if(patch.schemaVersion!==1||patch.hash!==sha256(JSON.stringify(patch.edits)))throw new Error('Invalid patch hash');
 // Validate every base before mutating even an isolated materialization.
 const paths=await Promise.all(patch.edits.map(async e=>{const p=await safeRegular(root,e.path);if(sha256(await readFile(p))!==e.beforeSha256)throw new Error('Stale patch base');return p;}));
 for(let i=0;i<paths.length;i++)await writeFile(paths[i],patch.edits[i].content,{flag:'w'});
}
const ROOT_FILES=new Set(['package.json','pnpm-lock.yaml','tsconfig.json','vitest.config.ts']);
const IGNORE=new Set(['node_modules','.git','dist','coverage','.env','.DS_Store']);
export async function snapshotSource(root:string):Promise<SourceSnapshot>{
 const files:Record<string,string>={};let total=0;
 async function walk(path:string){
  const absolute=join(root,...path.split('/'));const stat=await lstat(absolute);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw new Error('Linked archive source');
  if(stat.isDirectory()){for(const e of (await readdir(absolute)).sort()){if(IGNORE.has(e)||e.startsWith('.env')||/\.(db|sqlite|sqlite3|log|zip|png|jpg|woff2?)$/i.test(e))continue;await walk(path?path+'/'+e:e);}return;}
  if(!stat.isFile())throw new Error('Nonregular archive source');relativeFile(path);const content=await readFile(await safeRegular(root,path),'utf8');
  total+=Buffer.byteLength(content);if(total>32*1024*1024||Object.keys(files).length>=4096||content.includes('\0'))throw new Error('Source archive exceeds text bounds');files[path]=content;
 }
 if((await lstat(root)).isSymbolicLink())throw new Error('Linked source root');
 for(const e of (await readdir(root)).sort())if(ROOT_FILES.has(e)||['src','web','tests'].includes(e))await walk(e);
 return makeSnapshot(files);
}
export function makeSnapshot(files:Record<string,string>):SourceSnapshot {
 const ordered:Record<string,string>={};for(const k of Object.keys(files).sort()){relativeFile(k);ordered[k]=files[k];}return{schemaVersion:1,hash:sha256(JSON.stringify(ordered)),files:ordered};
}
export async function readSnapshot(path:string):Promise<SourceSnapshot>{const s=JSON.parse(await readFile(path,'utf8')) as SourceSnapshot;if(s.schemaVersion!==1||!s.files||s.hash!==makeSnapshot(s.files).hash)throw new Error('Invalid snapshot hash');return s;}
export async function materializeSnapshot(snapshot:SourceSnapshot,destination:string):Promise<void>{
 if(snapshot.hash!==makeSnapshot(snapshot.files).hash)throw new Error('Snapshot hash mismatch');
 await mkdir(destination,{recursive:false,mode:0o700});
 for(const [path,content] of Object.entries(snapshot.files)){relativeFile(path);const dest=join(destination,...path.split('/'));await mkdir(dirname(dest),{recursive:true});await writeFile(dest,content,{flag:'wx',mode:0o600});}
}
/** Hash all evaluator/fixture bytes; no symlinks, hardlinks, Git metadata, DBs or credential files. */
export async function hashTree(root:string):Promise<string>{return hashRegularTree(root,false);}
/** Candidate source AND compiled output; differs from an evaluator tree only by allowing dist/. */
export async function hashMaterialization(root:string):Promise<string>{return hashRegularTree(root,true);}
async function hashRegularTree(root:string,allowBuild:boolean):Promise<string>{
 if((await lstat(root)).isSymbolicLink()||(await realpath(root)).toLowerCase()!==resolve(root).toLowerCase())throw new Error('Linked evaluator root');const rows:string[]=[];
 async function walk(rel:string){for(const e of (await readdir(join(root,rel))).sort()){
  const p=rel?rel+'/'+e:e;relativeFile(p);if(IGNORE.has(e)&&!(allowBuild&&e==='dist')||/\.(db|sqlite|sqlite3|pem|key)$/i.test(e)||e.startsWith('.env'))throw new Error('Private or metadata file in evaluator');
  const a=join(root,p),s=await lstat(a);if(s.isSymbolicLink()||s.isFile()&&s.nlink>1)throw new Error('Linked evaluator/fixture');
  if(s.isDirectory())await walk(p);else if(s.isFile())rows.push(p+'\0'+sha256(await readFile(a)));else throw new Error('Nonregular evaluator entry');
 }}await walk('');return sha256(JSON.stringify(rows));
}
