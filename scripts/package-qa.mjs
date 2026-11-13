#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync,rmSync,readdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,dirname,delimiter,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

function invariant(condition,message){if(!condition)throw new Error(message);}
function safeArchivePath(name,destination){
 invariant(name.startsWith('package/')&&!name.includes('\\')&&!name.includes(':')&&!name.split('/').includes('..')&&!name.split('/').includes('.')&&!name.includes('\0'),'Unsafe package archive path');
 const target=resolve(destination,...name.split('/'));const inside=relative(destination,target);
 invariant(inside&&!inside.startsWith('..'+sep)&&inside!=='..'&&!resolve(target).startsWith('\\\\'),'Unsafe package archive path');return target;
}
/** Extract only regular files/directories, without trusting archive paths or links. */
export function extractPackageArchive(archive,destination){
 const tar=gunzipSync(readFileSync(archive),{maxOutputLength:128*1024*1024});const entries=[];mkdirSync(destination,{recursive:true});
 for(let offset=0;offset+512<=tar.length;){
  const header=tar.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
  const field=(start,length)=>header.subarray(start,start+length).toString('utf8').split('\0')[0];
  let checksum=0;for(let index=0;index<512;index++)checksum+=index>=148&&index<156?32:header[index];
  invariant(Number.parseInt(field(148,8).trim(),8)===checksum,'Invalid package tar checksum');
  const name=[field(345,155),field(0,100)].filter(Boolean).join('/');const type=field(156,1);const size=Number.parseInt(field(124,12).trim()||'0',8);
  invariant(Number.isSafeInteger(size)&&size>=0&&offset+512+size<=tar.length,'Invalid package tar entry size');
  const target=safeArchivePath(name,destination);
  if(type==='5')mkdirSync(target,{recursive:true});
  else{
   invariant(type===''||type==='0','Package archive contains a link or unsupported tar entry');
   invariant(!entries.includes(name),'Duplicate package archive entry');mkdirSync(dirname(target),{recursive:true});
   const mode=Number.parseInt(field(100,8).trim()||'644',8)&0o777;writeFileSync(target,tar.subarray(offset+512,offset+512+size),{mode});entries.push(name);
  }
  offset+=512+Math.ceil(size/512)*512;
 }
 invariant(entries.includes('package/package.json'),'Missing package manifest in archive');return entries;
}
const runtimeSourceRoots=new Set(['benchmark','broker','cli','contracts','core','extensions','i18n','improvement','learning','provider','runtime','server','store','supervisor','tools','trace']);
const runtimeSourceAssets=new Set(['src/improvement/proposer-strategy.json']);
export function verifyArchiveEntries(files){
 for(const name of files){
  invariant(!name.startsWith('/')&&!name.includes('\\')&&!name.includes(':')&&!name.split('/').includes('..'),'Unsafe package archive path');
  invariant(!/(?:^|\/)(?:tests?|__tests__|eval|artifacts|results|state|fixtures?|node_modules|\.git)(?:\/|$)|\.(?:test|spec)\.[^/]+$/.test(name),'Package includes development data or local service state');
  invariant(!/(?:^|\/)(?:\.env(?:\.[^/]+)?|service\.(?:json|log|lock)|credentials\.(?:json|txt|ya?ml)|\.?(?:secrets?|tokens?)\.(?:json|txt|ya?ml)|[^/]+\.(?:db(?:-shm|-wal)?|sqlite3?|pem|key))$/.test(name),'Package includes local state or secrets');
  if(name.startsWith('src/')){
   const owned=runtimeSourceRoots.has(name.split('/')[1]);
   const sourceFile=/\.(?:ts|tsx)$/.test(name)||runtimeSourceAssets.has(name)||/\/(?:README|PLAN)\.md$/.test(name);
   invariant(owned&&sourceFile,'Package includes unowned or unsupported runtime source');
  }
 }
}
export function verifyPackageLayout(root){
 const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
 invariant(manifest.name==='ernie-harness','Unexpected package name');
 invariant(typeof manifest.engines?.node==='string'&&manifest.engines.node.includes('24'),'Package must declare Node 24 support');
 const bins=typeof manifest.bin==='string'?{[manifest.name]:manifest.bin}:manifest.bin;
 invariant(bins&&typeof bins==='object'&&Object.keys(bins).length>0,'Missing package bin metadata');
 for(const [name,path] of Object.entries(bins)){
  invariant(typeof path==='string'&&!path.includes('..')&&!path.startsWith('/')&&!path.includes('\\'),'Unsafe package executable path');
  invariant(existsSync(join(root,path)),`Missing packaged executable: ${name}`);invariant(readFileSync(join(root,path),'utf8').startsWith('#!/usr/bin/env node'),'Packaged executable is missing its Node shebang');
 }
 for(const path of ['dist/cli/main.js','dist/server/app.js','web/dist/index.html','src/improvement/proposer-strategy.json'])invariant(existsSync(join(root,path)),`Missing package runtime file: ${path}`);
 return{manifest,bins};
}
function pnpmCommand(){
 const configured=process.env.npm_execpath;if(configured&&configured.includes('pnpm')&&existsSync(configured))return[process.execPath,[configured]];
 for(const directory of (process.env.PATH??'').split(delimiter)){
  for(const path of [join(directory,'node_modules/pnpm/bin/pnpm.cjs'),join(directory,'pnpm.cjs')])if(existsSync(path))return[process.execPath,[path]];
  if(process.platform!=='win32'&&existsSync(join(directory,'pnpm'))){const path=realpathSync(join(directory,'pnpm'));if(/\.(?:c?js|mjs)$/.test(path))return[process.execPath,[path]];}
 }
 if(process.platform!=='win32')return['pnpm',[]];throw new Error('Cannot locate pnpm. Run this script using pnpm run or install pnpm on PATH.');
}
function command(executable,args,options){
 const result=spawnSync(executable,args,{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,windowsHide:true,...options});
 invariant(!result.error&&result.status===0,`Package QA command failed: ${executable===process.execPath?'node':'pnpm'} ${args.includes('--dry-run')?'pack --dry-run':args.includes('pack')?'pack':'--help'} (${result.error?.code??result.status})${result.stderr?'\n'+result.stderr.slice(-1200):''}`);return result.stdout;
}
function jsonOutput(text){const start=text.indexOf('{');invariant(start>=0,'pnpm did not produce JSON package metadata');return JSON.parse(text.slice(start));}
function offlineEnvironment(root){
 const env={...process.env};for(const key of Object.keys(env))if(/token|secret|password|api.?key|authorization|cookie/i.test(key))delete env[key];
 return{...env,HOME:root,USERPROFILE:root,ERNIE_HARNESS_HOME:join(root,'state'),CI:'1',NO_COLOR:'1',FORCE_COLOR:'0',NODE_OPTIONS:'',HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',npm_config_ignore_scripts:'true',npm_config_registry:'http://127.0.0.1:9',npm_config_offline:'true'};
}
export function runPackageQa(project=resolve(dirname(fileURLToPath(import.meta.url)),'..')){
 const [major,minor]=process.versions.node.split('.').map(Number);invariant(major===24&&minor>=9,'Package QA requires Node 24.9 or newer within Node 24.');
 const temporary=mkdtempSync(join(tmpdir(),'ernie-package-qa-'));const env=offlineEnvironment(temporary);
 try{
  const [pnpm,prefix]=pnpmCommand();const dry=jsonOutput(command(pnpm,[...prefix,'--config.ignore-scripts=true','pack','--dry-run','--json'],{cwd:project,env}));
  const packed=jsonOutput(command(pnpm,[...prefix,'--config.ignore-scripts=true','pack','--json','--pack-destination',temporary],{cwd:project,env}));
  const archives=readdirSync(temporary).filter(name=>name.endsWith('.tgz'));invariant(archives.length===1,'Expected exactly one actual package archive');
  const archive=join(temporary,archives[0]);const unpacked=join(temporary,'unpacked');const entries=extractPackageArchive(archive,unpacked);
  const actual=entries.map(name=>name.slice('package/'.length)).sort();
  if(Array.isArray(dry.files)){const expected=dry.files.map(file=>typeof file==='string'?file:file.path).sort();invariant(JSON.stringify(actual)===JSON.stringify(expected),'Dry-run and actual archive contents differ');}
  verifyArchiveEntries(actual);
  const packageRoot=join(unpacked,'package');const{manifest,bins}=verifyPackageLayout(packageRoot);
  const guard=join(temporary,'offline-guard.cjs');writeFileSync(guard,`const blocked=()=>{throw new Error('Package help attempted network or child process access')};\nconst net=require('node:net');net.Socket.prototype.connect=blocked;\nfor(const name of ['node:http','node:https']){const mod=require(name);mod.request=blocked;mod.get=blocked;}\nconst cp=require('node:child_process');for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=blocked;\nglobalThis.fetch=blocked;require('node:module').syncBuiltinESMExports();\n`);
  const emptyWorkspace=join(temporary,'fresh-workspace');mkdirSync(emptyWorkspace);
  for(const path of Object.values(bins))for(const locale of ['zh-CN','en']){
   const output=command(process.execPath,['--require',guard,join(packageRoot,path),'--help','--lang',locale],{cwd:emptyWorkspace,env,timeout:15000});
   invariant(output.includes('ERNIE Harness')&&output.includes('memory')&&output.includes('--mode plan|standard|trusted')&&output.includes('checkpoint restore'),'Packaged CLI help is incomplete');
  }
  invariant(!existsSync(join(temporary,'state')),'Package help created local service state');
  return{status:'passed',node:process.version,package:`${manifest.name}@${manifest.version}`,files:entries.length,bins:Object.keys(bins),locales:['zh-CN','en'],archiveInspection:'dry-run and actual archive',helpNetwork:'blocked',runtimeSource:'included',dependencyInstallation:'not performed',filename:packed.filename?String(packed.filename).split(/[\\/]/).at(-1):archives[0]};
 }finally{const resolved=resolve(temporary);invariant(resolved.startsWith(resolve(tmpdir())+sep)&&resolved.includes('ernie-package-qa-'),'Unexpected package QA cleanup path');rmSync(resolved,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(runPackageQa(),null,2));}catch(error){console.error(error instanceof Error?error.message:'Package QA failed');process.exitCode=1;}
}
