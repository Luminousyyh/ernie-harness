import {createHash} from 'node:crypto';
import {readFile,unlink} from 'node:fs/promises';
import {resolvePath,writeText} from '../tools/files.js';
import type {WorkspacePatch} from '../improvement/index.js';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
/** Validate every preimage before the first write; callers journal the entire operation. */
export async function applyCandidatePatch(workspace:string,patch:WorkspacePatch,signal:AbortSignal):Promise<void>{
 if(patch.schemaVersion!==1||patch.hash!==sha(JSON.stringify({baseHash:patch.baseHash,resultHash:patch.resultHash,edits:patch.edits,unified:patch.unified})))throw new Error('Candidate patch checksum mismatch');
 const paths=new Set<string>();for(const edit of patch.edits){if(signal.aborted)throw signal.reason;const path=await resolvePath(workspace,edit.path,signal);if(paths.has(path.toLowerCase()))throw new Error('Duplicate candidate patch path');paths.add(path.toLowerCase());let current:string|null;try{current=sha(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;current=null;}if(current!==edit.beforeSha256||((edit.content===null?null:sha(edit.content))!==edit.afterSha256))throw new Error('Candidate patch preimage changed: '+edit.path);}
 for(const edit of patch.edits){if(signal.aborted)throw signal.reason;if(edit.content===null)await unlink(await resolvePath(workspace,edit.path,signal));else await writeText(workspace,edit.path,edit.content,signal);}
}
