import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {makeSnapshot,relativeFile,safeRegular,sha256,type SourceSnapshot} from './archive.js';
import type {WorkspacePatch,WorkspaceEdit} from './types.js';
const EXCLUDED=new Set(['.git','.hg','.svn','.env','.npmrc','.netrc','.pypirc','.ssh','.aws','.config','node_modules','dist','coverage','eval','evaluation','formal','sealed-validation','.ernie','.codex']);
const privateFile=(name:string)=>EXCLUDED.has(name.toLowerCase())||name.toLowerCase().startsWith('.env')||/\.(db|sqlite|sqlite3|pem|key|p12|log)(-(wal|shm))?$/i.test(name)||/^(credentials|secrets?)(\.|$)/i.test(name);
/** A bounded text workspace; intentionally omits evaluation archives and runtime/private state. */
export async function captureWorkspace(root:string,secrets:readonly string[]=[]):Promise<SourceSnapshot>{
 const base=resolve(root);if((await lstat(base)).isSymbolicLink()||(await realpath(base)).toLowerCase()!==base.toLowerCase())throw new Error('Linked workspace root');
 const files:Record<string,string>={},paths=new Set<string>();let bytes=0,count=0;
 async function walk(relative:string):Promise<void>{for(const name of (await readdir(join(base,relative))).sort()){
  if(++count>8192)throw new Error('Workspace entry limit exceeded');if(privateFile(name))continue;
  const p=relative?relative+'/'+name:name;relativeFile(p);if(paths.has(p.toLowerCase()))throw new Error('Case-colliding workspace path');paths.add(p.toLowerCase());const s=await lstat(join(base,p));
  if(s.isSymbolicLink()||s.isFile()&&s.nlink>1)throw new Error('Linked workspace file');
  if(s.isDirectory()){await walk(p);continue;}if(!s.isFile()||s.size>1024*1024)throw new Error('Workspace must contain bounded regular text files');
  const content=await readFile(await safeRegular(base,p)),text=new TextDecoder('utf-8',{fatal:true}).decode(content);bytes+=content.length;
  if(bytes>16*1024*1024||Object.keys(files).length>=4096||text.includes('\0'))throw new Error('Workspace text limit exceeded');if(secrets.some(v=>v&&text.includes(v)))throw new Error('Runtime credential in workspace');files[p]=text;
 }}await walk('');return makeSnapshot(files);
}
export function unifiedPatch(edits:WorkspaceEdit[],before:SourceSnapshot):string{
 const lines=(text:string)=>text.match(/[^\n]*\n|[^\n]+$/g)??[];
 const render=(rows:string[],prefix:string)=>rows.map(v=>prefix+v+(v.endsWith('\n')?'':'\n\\ No newline at end of file\n')).join('');
 return edits.map(e=>{const a=lines(before.files[e.path]??''),b=lines(e.content??'');return`diff --git a/${e.path} b/${e.path}\n`+(e.beforeSha256===null?'new file mode 100644\n':e.afterSha256===null?'deleted file mode 100644\n':'')+`--- ${e.beforeSha256===null?'/dev/null':'a/'+e.path}\n+++ ${e.afterSha256===null?'/dev/null':'b/'+e.path}\n`+(a.length||b.length?`@@ -${a.length?1:0},${a.length} +${b.length?1:0},${b.length} @@\n`+render(a,'-')+render(b,'+'):'');}).join('');
}
export function workspacePatch(before:SourceSnapshot,after:SourceSnapshot):WorkspacePatch{
 if(before.hash!==makeSnapshot(before.files).hash||after.hash!==makeSnapshot(after.files).hash)throw new Error('Workspace snapshot hash mismatch');const edits:WorkspaceEdit[]=[];
 for(const path of [...new Set([...Object.keys(before.files),...Object.keys(after.files)])].sort()){
  if(before.files[path]===after.files[path])continue;edits.push({path,beforeSha256:Object.hasOwn(before.files,path)?sha256(before.files[path]):null,afterSha256:Object.hasOwn(after.files,path)?sha256(after.files[path]):null,content:after.files[path]??null});
 }
 const unified=unifiedPatch(edits,before);return{schemaVersion:1,baseHash:before.hash,resultHash:after.hash,hash:sha256(JSON.stringify({baseHash:before.hash,resultHash:after.hash,edits,unified})),edits,unified};
}
