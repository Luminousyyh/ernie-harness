// Inspect a locally packed tarball; never publish or perform a model request.
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const directory=new URL('../artifacts/package/',import.meta.url);
const archives=(await readdir(directory)).filter(name=>name.endsWith('.tgz'));
assert.equal(archives.length,1,'Expected one fresh package archive');
const archive=fileURLToPath(new URL(archives[0],directory));
function tar(args){const result=spawnSync('tar',args,{encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(result.status,0,result.stderr||String(result.error));return result.stdout;}
const metadata=JSON.parse(tar(['-xOf',archive,'package/package.json']));
assert.equal(metadata.name,'ernie-harness');assert.equal(metadata.license,'MIT');
assert.match(metadata.version,/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
assert.match(metadata.engines.node,/24/);
// pnpm pack strips the development-only packageManager field from its manifest.
const source=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
assert.match(source.packageManager,/^pnpm@10\./);
assert.equal(metadata.version,source.version,'Archive version differs from the working tree; repack');
assert.equal(metadata.engines.node,source.engines.node);
assert.equal(metadata.private,source.private);
if(metadata.packageManager!==undefined)assert.equal(metadata.packageManager,source.packageManager);
const files=tar(['-tf',archive]).split(/\r?\n/).filter(Boolean);
for(const path of ['package/README.md','package/README.zh-CN.md','package/LICENSE'])assert.ok(files.includes(path),`Missing ${path}`);
// Documentation is deployed separately by Pages; runtime packages may omit docs/.
const forbidden=files.filter(path=>path!=='package/.env.example'&&/(?:^|\/)(?:\.env(?:\.|$)|node_modules\/|\.ssh\/|\.ernie\/|artifacts\/|credentials\.(?:json|enc|db)(?:$|\/)|sessions?\.sqlite(?:-|$)|learning\.sqlite(?:-|$))/.test(path));
assert.deepEqual(forbidden,[],'Runtime/private artifacts found in archive');
console.log(`Package metadata and exclusions checked: ${metadata.name}@${metadata.version}, ${files.length} files (local archive only).`);
