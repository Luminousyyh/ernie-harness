import {ApiError, abortError, checkAbort, retryAfter, protocolError} from './errors.js';
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export async function* readChunks(response: Response, signal?: AbortSignal, maxBytes = MAX_RESPONSE_BYTES): AsyncGenerator<Uint8Array> {
  if (signal?.aborted) { void response.body?.cancel().catch(()=>{}); checkAbort(signal); }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) { void response.body?.cancel().catch(()=>{}); throw protocolError('RESPONSE_TOO_LARGE'); }
  if (!response.body) throw protocolError('EMPTY_RESPONSE');
  const reader = response.body.getReader(); let bytes = 0; let ended = false;
  let rejectAbort: ((error: unknown)=>void) | undefined;
  const aborted = new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const onAbort = () => {rejectAbort?.(abortError()); void reader.cancel().catch(()=>{});};
  signal?.addEventListener('abort', onAbort, {once:true});
  if (signal?.aborted) onAbort();
  try {
    while (true) {
      const result = await Promise.race([reader.read(), aborted]); checkAbort(signal);
      if (result.done) { ended = true; break; }
      bytes += result.value.byteLength;
      if (bytes > maxBytes) throw protocolError('RESPONSE_TOO_LARGE');
      yield result.value;
    }
  } finally { signal?.removeEventListener('abort',onAbort); if (!ended) void reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
export async function readJson(response: Response, signal?: AbortSignal, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of readChunks(response,signal,maxBytes)) { chunks.push(chunk); length+=chunk.byteLength; }
  const bytes = new Uint8Array(length);let offset=0;for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));} catch {throw protocolError('INVALID_JSON');}
}
export async function request(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  checkAbort(init.signal ?? undefined);
  let response: Response;
  try { response = await fetcher(url,{...init,redirect:'error'}); }
  catch {checkAbort(init.signal ?? undefined);throw new ApiError('Provider connection failed; request outcome may be uncertain',{code:'NETWORK_ERROR',retryable:true});}
  if (!response.ok) {
    // Never retain upstream error bodies: they may echo credentials, prompts or tool output.
    void response.body?.cancel().catch(()=>{});
    throw new ApiError(`Provider HTTP ${response.status}`,{status:response.status,retryAfterMs:retryAfter(response.headers.get('retry-after')),code:'HTTP_ERROR'});
  }
  return response;
}
export function scopedSignal(signal: AbortSignal | undefined, timeoutMs: number): {signal: AbortSignal; dispose:()=>void} {
  const controller = new AbortController();
  const abort=()=>controller.abort(); signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
  const timer=setTimeout(abort,timeoutMs);timer.unref?.();
  return {signal:controller.signal,dispose:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
}
