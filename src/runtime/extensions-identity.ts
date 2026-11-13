import {createHash} from 'node:crypto';
import {readFile,lstat,readdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import type {ExtensionConfig} from '../extensions/index.js';
/** Bind trusted local plugin code and source guidance, not just tool schemas. */
export async function extensionIdentity(config:ExtensionConfig,workspace:string):Promise<string>{
 const pieces=[JSON.stringify(config)];let count=0;
 async function scan(path:string,root:string,depth=0):Promise<void>{if(depth>16||++count>4000)throw new Error('Extension identity exceeds bounded source inventory');let info;try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){pieces.push(path+':missing');return;}throw error;}if(info.isSymbolicLink())throw new Error('Extension identity cannot pin symbolic source');if(info.isDirectory()){for(const entry of (await readdir(path)).sort()){if(['node_modules','.git','.env','artifacts','.cache','dist'].includes(entry))continue;await scan(join(path,entry),root,depth+1);}}else if(info.isFile()&&(/\.(?:[cm]?js|tsx?|json)$/.test(path)||/AGENTS\.md$|SKILL\.md$/.test(path))){if(info.size>2*1024*1024)throw new Error('Extension identity file exceeds limit');pieces.push(path.slice(root.length),(await readFile(path)).toString('base64'));}}
 for(const plugin of config.plugins??[]){if(plugin.enabled===false)continue;const entry=resolve(workspace,plugin.path);await scan(dirname(entry),dirname(entry));}
 await scan(join(workspace,'.agents'),workspace);await scan(join(workspace,'AGENTS.md'),workspace);
 for(const root of config.skillRoots??[])await scan(resolve(workspace,root),resolve(workspace,root));
 return createHash('sha256').update(pieces.join('\n')).digest('hex');
}
