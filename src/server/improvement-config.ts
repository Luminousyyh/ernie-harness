import {existsSync,readFileSync,lstatSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {z} from 'zod';
import {createImprovementBroker,type LinuxEvaluationEnvironment} from '../improvement/index.js';
const absolute=z.string().min(1).refine(isAbsolute,'Use an absolute path');
const suite=z.object({root:absolute,manifestHash:z.string().regex(/^[0-9a-f]{64}$/),evaluatorHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const schema=z.object({version:z.literal(1),development:suite,validation:suite,dependenciesDir:absolute,nodeExecutable:absolute.optional(),bwrapExecutable:absolute.optional()}).strict();
/** Trusted local configuration only. Browser payloads never select mounts, evaluators or credentials. */
export function loadImprovementEnvironment(stateDir:string,apiKey:string|undefined,quotaPath:string):LinuxEvaluationEnvironment|undefined{
 const path=join(stateDir,'improvement-environment.json');if(!existsSync(path))return undefined;
 if(lstatSync(path).isSymbolicLink())throw new Error('Improvement environment config cannot be a symlink');
 if(!apiKey)throw new Error('Configure the server-side OpenRouter credential before enabling isolated improvement');
 const settings=schema.parse(JSON.parse(readFileSync(path,'utf8')));
 if(settings.development.root===settings.validation.root||settings.development.manifestHash===settings.validation.manifestHash)throw new Error('Development and sealed validation must be distinct');
 const {version,...environment}=settings;return{...environment,broker:createImprovementBroker({stateDir:join(stateDir,'improvement-broker'),quotaPath,apiKey})};
}
