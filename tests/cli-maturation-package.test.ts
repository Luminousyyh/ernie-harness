import {describe,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {extractPackageArchive,verifyPackageLayout,runPackageQa,verifyArchiveEntries} from '../scripts/package-qa.mjs';
import {runCli} from '../src/cli/main.js';
function archive(name:string,content='fixture'){
 const member=(name:string,content:string)=>{
 const header=Buffer.alloc(512);header.write(name);header.write('0000644\0',100);header.write(content.length.toString(8).padStart(11,'0')+'\0',124);header.write('0',156);header.fill(32,148,156);let sum=0;for(const value of header)sum+=value;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
 return Buffer.concat([header,Buffer.from(content),Buffer.alloc((512-content.length%512)%512)]);};
 return gzipSync(Buffer.concat([member(name,content),member('package/package.json','{}'),Buffer.alloc(1024)]));
}
describe('offline package and executable checks',()=>{
 it('checks bilingual help without acquiring a service, reading credentials, or calling fetch',async()=>{
  const connect=vi.fn(async()=>{throw new Error('Help started a service');});const request=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Help used the network'));
  try{for(const locale of ['en','zh-CN']){const print=vi.fn();await runCli(['--help','--lang',locale],{connect,print});const help=print.mock.calls[0]?.[0];expect(help).toContain('ERNIE Harness');expect(help).toContain('memory');expect(help).toContain('--mode plan|standard|trusted');expect(help).toContain('checkpoint restore');}expect(connect).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();}finally{request.mockRestore();}
 });
 it('extracts actual regular archive files but rejects archive traversal',()=>{
  const root=mkdtempSync(join(tmpdir(),'ernie-cli-archive-'));
  try{const path=join(root,'valid.tgz');writeFileSync(path,archive('package/dist/cli/main.js'));const entries=extractPackageArchive(path,join(root,'unpack'));expect(entries).toContain('package/dist/cli/main.js');expect(readFileSync(join(root,'unpack/package/dist/cli/main.js'),'utf8')).toBe('fixture');writeFileSync(path,archive('package/../../escaped'));expect(()=>extractPackageArchive(path,join(root,'bad'))).toThrow(/path/i);}finally{rmSync(root,{recursive:true,force:true});}
 });
 it('packs and inspects a real fixture archive, skips lifecycle scripts, and checks help offline',()=>{
  const root=mkdtempSync(join(tmpdir(),'ernie-cli-pack-fixture-'));
  try{
   mkdirSync(join(root,'dist/cli'),{recursive:true});mkdirSync(join(root,'dist/server'),{recursive:true});mkdirSync(join(root,'web/dist'),{recursive:true});mkdirSync(join(root,'src/improvement'),{recursive:true});writeFileSync(join(root,'src/improvement/proposer-strategy.json'),'{}');
   writeFileSync(join(root,'package.json'),JSON.stringify({name:'ernie-harness',version:'0.0.0-fixture',private:true,type:'module',engines:{node:'>=24.9.0'},bin:{'ernie-harness':'dist/cli/main.js'},files:['dist','web/dist','src'],scripts:{prepack:'node -e "process.exit(99)"'}}));
   writeFileSync(join(root,'dist/cli/main.js'),`#!/usr/bin/env node\nconsole.log('ERNIE Harness memory --mode plan|standard|trusted checkpoint restore');\n`);
   writeFileSync(join(root,'dist/server/app.js'),'// package layout fixture\n');writeFileSync(join(root,'web/dist/index.html'),'<html lang="en"></html>');
   const result=runPackageQa(root);expect(result.status).toBe('passed');expect(result.runtimeSource).toBe('included');expect(result.helpNetwork).toBe('blocked');expect(result.locales).toEqual(['zh-CN','en']);expect(result.dependencyInstallation).toBe('not performed');
  }finally{rmSync(root,{recursive:true,force:true});}
 },15000);
 it('allows owned runtime source but rejects tests, evaluation data, artifacts, state and secrets',()=>{
  expect(()=>verifyArchiveEntries(['src/core/engine.ts','src/improvement/proposer-strategy.json','src/extensions/README.md','pnpm-lock.yaml'])).not.toThrow();
  for(const name of ['tests/unit.test.ts','eval/record.json','artifacts/run.json','state/session.json','src/core/test.test.ts','src/core/__tests__/unit.ts','src/unowned/task.ts','src/core/service.json','src/core/secrets.json','src/core/.env','dist/state.db'])expect(()=>verifyArchiveEntries([name])).toThrow();
 });
 it('rejects a package without its declared executable and bundled service UI',()=>{
  const root=mkdtempSync(join(tmpdir(),'ernie-cli-layout-'));
  try{writeFileSync(join(root,'package.json'),JSON.stringify({name:'ernie-harness',bin:{'ernie-harness':'dist/cli/main.js'},engines:{node:'>=24.9.0'}}));expect(()=>verifyPackageLayout(root)).toThrow(/missing/i);mkdirSync(join(root,'dist/cli'),{recursive:true});writeFileSync(join(root,'dist/cli/main.js'),'#!/usr/bin/env node\n');expect(()=>verifyPackageLayout(root)).toThrow(/missing/i);mkdirSync(join(root,'dist/server'),{recursive:true});mkdirSync(join(root,'web/dist'),{recursive:true});writeFileSync(join(root,'dist/server/app.js'),'');writeFileSync(join(root,'web/dist/index.html'),'');expect(()=>verifyPackageLayout(root)).toThrow(/src\/improvement\/proposer-strategy\.json/);}finally{rmSync(root,{recursive:true,force:true});}
 });
});
