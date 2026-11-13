#!/usr/bin/env node
import {readFile, lstat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {loadApiKey} from '../provider/index.js';
import {createModelBroker} from './index.js';
import {object} from './policy.js';
import {type Budget} from '../contracts/index.js';

export async function main():Promise<void>{
  const stateDir=process.env.ERNIE_BROKER_STATE_DIR,socketPath=process.env.ERNIE_BROKER_SOCKET_PATH,registryPath=process.env.ERNIE_BROKER_REGISTRY_FILE,quotaPath=process.env.ERNIE_BROKER_QUOTA_PATH;
  if(!stateDir||!socketPath||!registryPath)throw new Error('Broker state directory, socket path and trusted registry file are required');
  const apiKey=await loadApiKey();if(!apiKey)throw new Error('Runtime provider credential is required');
  const info=await lstat(registryPath);if(!info.isFile()||info.size>1024*1024||process.platform!=='win32'&&(info.mode&0o077)!==0)throw new Error('Trusted registry must be a private regular file');
  const registry:unknown=JSON.parse(await readFile(registryPath,'utf8'));
  if(!object(registry)||!Array.isArray(registry.trials))throw new Error('Invalid trusted trial registry');
  const broker=createModelBroker({apiKey,stateDir,socketPath,...(quotaPath?{quotaPath}:{})});
  try{
    for(const trial of registry.trials){if(!object(trial)||typeof trial.id!=='string'||typeof trial.token!=='string')throw new Error('Invalid trusted trial registration');await broker.registerTrial({id:trial.id,token:trial.token,...(trial.budget?{budget:trial.budget as Partial<Budget>}:{})});}
    await broker.listen();
  }catch(error){await broker.close();throw error;}
  const stop=()=>{void broker.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  process.stdout.write('Model broker listening on configured local socket\n');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){main().catch(()=>{process.stderr.write('Model broker startup failed; inspect trusted configuration and durable state\n');process.exitCode=1;});}
