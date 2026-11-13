import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';import { resolve } from 'node:path';
const python=process.env.PYTHON||(process.platform==='win32'?'python':'python3');
describe('private patch collection',()=>{
 it('binds only read-only workspace/base objects with no socket, oracle or credential mount',()=>{
  const code=`
import sys,pathlib
sys.path.insert(0,sys.argv[1]);from patch_collection import collector_argv
workspace=pathlib.Path('/fixture/eval/trials/dev-'+'a'*40)/'workspace';objects=pathlib.Path('/fixture/private/collector/objects')
args=collector_argv(workspace,objects,'a'*40)
assert '--unshare-all' in args and '--clearenv' in args and '--share-net' not in args
mounts=[(args[i+1],args[i+2]) for i,x in enumerate(args) if x in ['--bind','--ro-bind']]
assert (str(workspace),'/workspace') in mounts and (str(objects),'/objects') in mounts
assert '--bind' not in args
assert not any('credential' in source or 'qualification' in source or 'broker' in source for source,target in mounts)
print('minimal readonly collector mounts')
`;
  const result=spawnSync(python,['-c',code,resolve('eval')],{encoding:'utf8'});expect(result.status,result.stderr).toBe(0);
 });
 it.runIf(process.platform==='linux')('ignores malicious Git hooks/drivers and collects tracked changes plus a new file without host private access',()=>{
  const code=`
import sys,pathlib,tempfile,subprocess,shutil,json
sys.path.insert(0,sys.argv[1]);from patch_collection import freeze_base_objects,collect_patch,private_json,trusted_environment
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);base=root/'qualification/base';base.mkdir(parents=True)
 env=trusted_environment()
 def git(*args):subprocess.run(['/usr/bin/git',*args],cwd=base,env=env,check=True,capture_output=True)
 git('init','-q','--template=');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid')
 (base/'tracked.txt').write_text('original value\\n');git('add','.');git('commit','-qm','trusted base')
 identity='dev-'+'a'*40;private=root/'eval/private/formal/preparation'/identity;private.mkdir(parents=True)
 descriptor=freeze_base_objects(base,private)
 trial=root/'eval/trials'/identity;workspace=trial/'workspace';shutil.copytree(base,workspace)
 private_json(private/'prepared.json',{'instance':'fixture__task','workspace':str(workspace),'collector':descriptor})
 vault=root/'vault';vault.mkdir();sentinel=vault/'private.txt';sentinel.write_text('PRIVATE_SENTINEL')
 marker=root/'host-marker';exfil=root/'host-private-copy'
 probe=workspace/'probe.sh';probe.write_text('#!/bin/sh\\ncat '+str(sentinel)+' > '+str(exfil)+'\\nprintf invoked > '+str(marker)+'\\n');probe.chmod(0o755)
 with (workspace/'.git/config').open('a') as config:
  config.write('\\n[core]\\n fsmonitor = '+str(probe)+'\\n[diff]\\n external = '+str(probe)+'\\n[diff "steal"]\\n command = '+str(probe)+'\\n textconv = '+str(probe)+'\\n[filter "steal"]\\n clean = '+str(probe)+'\\n required = true\\n')
 (workspace/'.gitattributes').write_text('*.txt filter=steal diff=steal working-tree-encoding=UTF-16\\n')
 (workspace/'tracked.txt').write_text('changed value\\n');(workspace/'helper.txt').write_text('new helper\\n')
 patch=root/'eval/private/formal/patches'/(identity+'.diff')
 receipt=collect_patch(root,trial,'fixture__task',patch);content=patch.read_text()
 assert '+changed value' in content and '+new helper' in content and 'a/helper.txt' in content,content
 assert 'diff --git a/.git/' not in content and 'PRIVATE_SENTINEL' not in content
 assert not marker.exists() and not exfil.exists()
 assert receipt['hostGitOnAgentWorkspace'] is False and receipt['brokerMounted'] is False
 assert sentinel.read_text()=='PRIVATE_SENTINEL'
 print('malicious Git configuration isolated; truthful patch collected')
`;
  const result=spawnSync(python,['-c',code,resolve('eval')],{encoding:'utf8',timeout:120000});
  expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('truthful patch collected');
 });
});
