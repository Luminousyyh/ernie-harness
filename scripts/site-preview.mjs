import {createServer} from 'node:http';
import {readFile,stat,realpath} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../docs/', import.meta.url));
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.xml':'application/xml; charset=utf-8','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8'};
export async function startSiteServer({port=0}={}) {
  const server = createServer(async (request, response) => {
    try {
      if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      let path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (path.startsWith('/ernie-harness/')) path = path.slice('/ernie-harness'.length);
      if (path === '/') path = '/index.html';
      const target = await realpath(resolve(root, '.'+path));
      if (!target.startsWith(root.endsWith(sep) ? root : root+sep) || !(await stat(target)).isFile()) { response.writeHead(404).end(); return; }
      const data = await readFile(target);
      response.writeHead(200, {'content-type':mime[extname(target)]??'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});
      response.end(request.method==='HEAD'?undefined:data);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});
  return {server,url:`http://127.0.0.1:${server.address().port}/ernie-harness/`,close:()=>new Promise((accept,reject)=>server.close(error=>error?reject(error):accept()))};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await startSiteServer({port:Number(process.env.PORT??4321)});
  console.log(`ERNIE Harness showcase: ${instance.url}`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{instance.server.close();});
}
