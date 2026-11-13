import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';import { resolve } from 'node:path';
describe('execution artifact freeze',()=>{
 it('includes the actual mounted relay and rejects a changed relay after freeze',()=>{
  const code=`
import pathlib,importlib.util,tempfile,sys
spec=importlib.util.spec_from_file_location('artifact_freeze',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);(root/'eval').mkdir()
 for name in m.EXECUTION_HELPERS:(root/'eval'/name).write_text('initial execution helper')
 relay=root/'eval/relay.py';relay.write_text('relay original')
 first=m.helper_fingerprints(root)
 assert 'eval/relay.py' in first,'mounted relay is absent from the source freeze'
 target=root/'artifacts.json';a=m.persist_freeze(target,{'files':first})
 assert m.persist_freeze(target,{'files':first})==a
 relay.write_text('relay changed')
 second=m.helper_fingerprints(root)
 assert first['eval/relay.py']['sha256']!=second['eval/relay.py']['sha256']
 try:m.persist_freeze(target,{'files':second})
 except ValueError:pass
 else:raise AssertionError('changed relay was accepted under an existing freeze')
 print('relay drift rejected')
`;
  const result=spawnSync(process.env.PYTHON||(process.platform==='win32'?'python':'python3'),['-c',code,resolve('scripts/remote-freeze-artifacts.py')],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('relay drift rejected');
 });
});
