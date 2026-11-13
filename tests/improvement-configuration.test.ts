import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createImprovementEnvironment,createImprovementSmokeSuite} from '../src/improvement/index.js';
import {loadSuite} from '../src/improvement/evaluation.js';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe('trusted environment configuration and tiny fixture smoke (no model calls)',()=>{
 it('assembles the Linux environment lazily without secrets in the returned configuration',()=>{const env=createImprovementEnvironment({dependenciesDir:'/trusted/dependencies',development:{root:'/trusted/dev',manifestHash:'a'.repeat(64),evaluatorHash:'b'.repeat(64)},validation:{root:'/trusted/heldout',manifestHash:'c'.repeat(64),evaluatorHash:'d'.repeat(64)},broker:{stateDir:'/private/broker',quotaPath:'/private/global.json',apiKey:'fixture-runtime-only'}});expect(env.dependenciesDir).toBe('/trusted/dependencies');expect(typeof env.broker.openTrial).toBe('function');expect(JSON.stringify(env)).not.toContain('fixture-runtime-only');});
 it('builds a real small evaluator with a failing oracle before the file fix and passing after it',async()=>{const root=mkdtempSync(join(tmpdir(),'improvement-smoke-'));dirs.push(root);const suite=await createImprovementSmokeSuite(join(root,'suite'));const manifest=await loadSuite(suite,'development');expect(manifest.tasks).toHaveLength(1);expect(manifest.tasks[0].id).toBe('tiny-smoke');const grader=join(suite.root,'grade.mjs'),workspace=join(suite.root,'fixtures/tiny');expect(()=>execFileSync(process.execPath,[grader,workspace],{stdio:'pipe'})).toThrow();writeFileSync(join(workspace,'answer.txt'),'42\n');expect(()=>execFileSync(process.execPath,[grader,workspace],{stdio:'pipe'})).not.toThrow();expect(readFileSync(grader,'utf8')).toContain('answer.txt');await expect(loadSuite(suite,'development')).rejects.toThrow(/hash/i);});
});
