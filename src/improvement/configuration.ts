import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createImprovementBroker} from './broker.js';
import {hashTree,sha256} from './archive.js';
import type {LinuxEvaluationEnvironment} from './types.js';
import type {EvaluationManifest,EvaluationSuite} from './evaluation.js';
export interface ImprovementEnvironmentConfig extends Omit<LinuxEvaluationEnvironment,'broker'> {
 broker:Parameters<typeof createImprovementBroker>[0];
}
/** Trusted server/CLI configuration; lazy, no model calls and no credentials in the returned data fields. */
export function createImprovementEnvironment(config:ImprovementEnvironmentConfig):LinuxEvaluationEnvironment{
 const {broker,...runtime}=config;return{...runtime,broker:createImprovementBroker(broker)};
}
/** Fresh, genuinely graded fixture suitable for a <=10-call candidate-runner smoke, not a quality benchmark. */
export async function createImprovementSmokeSuite(path:string):Promise<EvaluationSuite>{
 const root=resolve(path);await mkdir(root,{recursive:false,mode:0o700});const fixture=join(root,'fixtures','tiny');await mkdir(fixture,{recursive:true,mode:0o700});
 await writeFile(join(fixture,'answer.txt'),'0\n',{flag:'wx',mode:0o600});
 const grader=`import {readFileSync} from 'node:fs';\nimport {join} from 'node:path';\nconst root=process.argv[2]??'/workspace';\ntry{if(readFileSync(join(root,'answer.txt'),'utf8').trim()!=='42')process.exitCode=1;}catch{process.exitCode=1;}\n`;
 await writeFile(join(root,'grade.mjs'),grader,{flag:'wx',mode:0o600});
 const manifest:EvaluationManifest={schemaVersion:1,version:'tiny-candidate-runner-smoke-v1',partition:'development',tasks:[{id:'tiny-smoke',fixture:'fixtures/tiny',fixtureHash:await hashTree(fixture),prompt:'Change answer.txt so it contains exactly 42 followed by a newline. Read the existing file, make that change, then finish. No other files need changes.',grade:['/runtime/node','/evaluator/grade.mjs']}]};
 const text=JSON.stringify(manifest,null,2)+'\n';await writeFile(join(root,'manifest.json'),text,{flag:'wx',mode:0o600});return{root,manifestHash:sha256(text),evaluatorHash:await hashTree(root)};
}
