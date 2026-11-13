import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
describe('trial Python environment',()=>{
 it('rewrites editable imports and executable shebangs without exposing the oracle; rejects foreign symlinks',()=>{
  const code=`
import importlib.util,pathlib,sys,tempfile,os
spec=importlib.util.spec_from_file_location('private_evaluator',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);m.ROOT=root
 context=root/'qualification';venv=context/'venv';(venv/'bin').mkdir(parents=True);(venv/'lib').mkdir()
 (venv/'bin/pytest').write_text('#!'+str(venv/'bin/python')+'\\n')
 (venv/'lib/editable.pth').write_text(str(context/'oracle'))
 (venv/'pyvenv.cfg').write_text('home = '+str(root/'runtimes/cpython-3.11.14/bin'))
 destination=root/'trial/python-venv';m.copy_venv(context,destination,pathlib.Path('/workspace'))
 assert (destination/'bin/pytest').read_text().startswith('#!'+str(destination/'bin/python'))
 assert (destination/'lib/editable.pth').read_text()==str(pathlib.Path('/workspace'))
 if os.name!='nt':
  (venv/'bin/foreign').symlink_to('/etc/passwd')
  try:m.copy_venv(context,root/'other/python-venv',pathlib.Path('/workspace'))
  except ValueError:pass
  else:raise AssertionError('foreign symlink accepted')
 print('safe Python environment passed')
`;
  const result=spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),['-c',code,resolve('scripts/remote-evaluate.py')],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('safe Python environment passed');
 });
});
