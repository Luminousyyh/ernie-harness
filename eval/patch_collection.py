"""Collect an agent diff without executing host Git on an agent repository."""
from __future__ import annotations
import hashlib,json,os,pathlib,re,subprocess,time

# A new Git directory and index live only in the collector namespace. All Git
# configuration, attributes and object alternates are trusted collector inputs.
COLLECTOR_SCRIPT = r"""set -eu
/usr/bin/git init --quiet --bare --template= /tmp/collector.git
/usr/bin/git --git-dir=/tmp/collector.git config core.bare false
mkdir -p /tmp/collector.git/info
printf '%s\n' '* -text -filter -ident !diff -working-tree-encoding' > /tmp/collector.git/info/attributes
git_safe() {
 /usr/bin/git --git-dir=/tmp/collector.git --work-tree=/workspace -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c core.autocrlf=false "$@"
}
git_safe read-tree "$BASE_OBJECT"
git_safe add --all -- .
git_safe diff --cached --binary --full-index --no-ext-diff --no-textconv "$BASE_OBJECT" --
"""

def sha(path):
    result=hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):result.update(block)
    return result.hexdigest()

def private_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with path.open('xb') as stream:
        os.chmod(path,0o600);stream.write((json.dumps(value,sort_keys=True,indent=2)+'\n').encode());stream.flush();os.fsync(stream.fileno())

def trusted_environment():
    return {'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_SYSTEM':'/dev/null','GIT_CONFIG_GLOBAL':'/dev/null','GIT_ATTR_NOSYSTEM':'1','GIT_TERMINAL_PROMPT':'0','CUDA_VISIBLE_DEVICES':'','NVIDIA_VISIBLE_DEVICES':'none'}

def freeze_base_objects(base,private):
    """Before agent launch, pack only objects reachable from the trusted base.

    The source is qualification's evaluator-owned original repository, never the
    copied workspace or its .git. No unreachable gold/test objects are exposed.
    """
    base,private=pathlib.Path(base),pathlib.Path(private)
    gitdir=private/'collector-base.git';gitdir.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    env=trusted_environment()
    original=base/'.git'
    if not original.is_dir() or original.is_symlink():raise ValueError('standalone trusted base Git directory required')
    object_id=subprocess.check_output(['/usr/bin/git','--git-dir='+str(original),'rev-parse','--verify','HEAD'],cwd=private,env=env,text=True,timeout=30).strip()
    if not re.fullmatch('[a-f0-9]{40}',object_id):raise ValueError('invalid base object ID')
    subprocess.run(['/usr/bin/git','init','--quiet','--bare','--template=',str(gitdir)],cwd=private,env=env,check=True,timeout=30,capture_output=True)
    pack=private/'base-only.pack'
    with pack.open('xb') as stream:
        os.chmod(pack,0o600)
        subprocess.run(['/usr/bin/git','--git-dir='+str(original),'pack-objects','--stdout','--revs'],input=(object_id+'\n').encode(),cwd=private,env=env,stdout=stream,stderr=subprocess.PIPE,check=True,timeout=120)
    with pack.open('rb') as stream:
        subprocess.run(['/usr/bin/git','--git-dir='+str(gitdir),'index-pack','--stdin'],stdin=stream,cwd=private,env=env,check=True,capture_output=True,timeout=120)
    return {'baseObject':object_id,'objects':str(gitdir/'objects'),'packSha256':sha(pack)}

def collector_argv(workspace,objects,object_id):
    if not re.fullmatch('[a-f0-9]{40}',object_id):raise ValueError('invalid base object ID')
    args=['bwrap','--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv']
    for path in ['/usr','/bin','/lib','/lib64']:args+=['--ro-bind',path,path]
    args+=['--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/home','--dir','/home/collector','--dir','/etc','--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache',
           '--ro-bind',str(workspace),'/workspace','--ro-bind',str(objects),'/objects','--chdir','/workspace']
    env=trusted_environment();env.update(HOME='/home/collector',GIT_ALTERNATE_OBJECT_DIRECTORIES='/objects',BASE_OBJECT=object_id)
    for key,value in env.items():args+=['--setenv',key,value]
    return args+['/bin/sh','-c',COLLECTOR_SCRIPT]

def collect_patch(root,trialdir,instance,patch):
    root,trialdir,patch=map(pathlib.Path,[root,trialdir,patch])
    if trialdir.parent!=root/'eval/trials' or not re.fullmatch('(trial|dev)-[a-f0-9]{40}',trialdir.name):raise ValueError('invalid collector trial directory')
    if patch.parent.resolve()!=(root/'eval/private/formal/patches').resolve() or patch.name!=trialdir.name+'.diff':raise ValueError('private trial patch path required')
    private=root/'eval/private/formal/preparation'/trialdir.name
    prepared=json.loads((private/'prepared.json').read_text());descriptor=prepared['collector']
    workspace=trialdir/'workspace';objects=pathlib.Path(descriptor['objects'])
    if prepared['instance']!=instance or pathlib.Path(prepared['workspace'])!=workspace:raise ValueError('collector preparation mismatch')
    if not objects.resolve().is_relative_to(private.resolve()) or objects.is_symlink():raise ValueError('untrusted base object mount')
    if not workspace.is_dir() or workspace.is_symlink():raise ValueError('standalone trial workspace required')
    receipt=root/'eval/private/formal/collection'/trialdir.name
    receipt.mkdir(parents=True,mode=0o700)
    private_json(receipt/'started.json',{'instance':instance,'baseObject':descriptor['baseObject'],'at':time.time()})
    patch.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with patch.open('xb') as output,(receipt/'collector.log').open('xb') as log:
        os.chmod(patch,0o600);os.chmod(receipt/'collector.log',0o600)
        subprocess.run(collector_argv(workspace,objects,descriptor['baseObject']),cwd=receipt,env=trusted_environment(),stdout=output,stderr=log,check=True,timeout=120)
        output.flush();os.fsync(output.fileno())
    result={'patchSha256':sha(patch),'baseObject':descriptor['baseObject'],'collectorScriptSha256':hashlib.sha256(COLLECTOR_SCRIPT.encode()).hexdigest(),'patchBytes':patch.stat().st_size,'hostGitOnAgentWorkspace':False,'brokerMounted':False,'networkShared':False}
    private_json(receipt/'evidence.json',result)
    return result
