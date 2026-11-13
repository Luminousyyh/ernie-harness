#!/usr/bin/env python3
"""Bounded source snapshot and Linux QA for the independent maturation revision."""
import argparse, datetime, hashlib, io, json, os, pathlib, subprocess, tarfile, time
ROOT = pathlib.Path(__file__).resolve().parents[1]
REMOTE_ROOT = pathlib.Path('/home/home_new/yaoyh/ernie-harness')
def sha(data): return hashlib.sha256(data).hexdigest()
def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
def snapshot(output):
    output.mkdir(parents=True, exist_ok=True)
    candidates=[]
    for name in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','vitest.config.ts','README.md','README.zh-CN.md','LICENSE','AGENTS.md','.gitignore']:
        if (ROOT/name).is_file(): candidates.append(ROOT/name)
    for name in ['src','web','tests','scripts','docs','examples','.github']:
        for path in (ROOT/name).rglob('*'):
            rel=path.relative_to(ROOT)
            if any(part in {'node_modules','dist','.ernie','qa','qa-maturation','qa-artifacts','__pycache__','.playwright'} for part in rel.parts): continue
            if path.name.startswith('.locale-') or path.suffix in {'.log','.zip','.tgz','.sqlite','.db','.png','.mp4','.webm'}: continue
            if path.is_file() and not path.is_symlink(): candidates.append(path)
    for name in ['eval/patch_collection.py','eval/qualification_support.py','eval/test_ids.py','eval/observability-v2-native-event-samples-20261113.json']:
        candidates.append(ROOT/name)
    files={p.relative_to(ROOT).as_posix():p.read_bytes() for p in sorted(set(candidates))}
    entries={name:sha(data) for name,data in files.items()}
    tree_hash=sha(''.join(f'{name}\0{entries[name]}\n' for name in sorted(entries)).encode())
    manifest={'schemaVersion':1,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHash':tree_hash,'fileCount':len(files),'files':entries,
              'gitHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
              'scope':'Current dirty shared worktree; explicit source directories; no runtime state, secrets, frozen eval, node_modules, QA media or generated builds'}
    save(output/'source-manifest.json',manifest)
    archive=output/'source.tar.gz'
    with tarfile.open(archive,'w:gz') as tar:
        for name,data in files.items():
            info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o755 if name.endswith('.sh') else 0o644
            tar.addfile(info,io.BytesIO(data))
        data=(json.dumps(manifest,indent=2)+'\n').encode();info=tarfile.TarInfo('artifacts/maturation/source-manifest.json');info.size=len(data);tar.addfile(info,io.BytesIO(data))
    save(output/'archive.json',{'sourceHash':tree_hash,'archiveSha256':sha(archive.read_bytes()),'bytes':archive.stat().st_size})
    print(json.dumps({'sourceHash':tree_hash,'fileCount':len(files),'archive':str(archive),'bytes':archive.stat().st_size}))
def limits():
    os.sched_setaffinity(0,sorted(os.sched_getaffinity(0))[:8])
def linux(output):
    if os.name!='posix': raise SystemExit('Linux only')
    output.mkdir(parents=True,exist_ok=True)
    node=REMOTE_ROOT/'runtimes/node-v24.13.1-linux-x64/bin/node'
    pnpm=REMOTE_ROOT/'runtimes/pnpm-tool/node_modules/pnpm/bin/pnpm.cjs'
    env={**os.environ,'PATH':f'{node.parent}:{REMOTE_ROOT}/runtimes/pnpm-tool/node_modules/.bin:/usr/bin:/bin','OMP_NUM_THREADS':'8','UV_THREADPOOL_SIZE':'8','NODE_OPTIONS':'--max-old-space-size=8192','CI':'true','CUDA_VISIBLE_DEVICES':''}
    report={'schemaVersion':1,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceRoot':str(ROOT),'sourceManifest':json.loads((ROOT/'artifacts/maturation/source-manifest.json').read_text()),'cpuLimit':8,'cgroupMemoryGiB':16,'gpu':False,'commands':[]}
    for label,argv,timeout in [('install',[str(node),str(pnpm),'install','--frozen-lockfile'],900),('check',[str(node),str(pnpm),'check'],900)]:
        start=time.monotonic()
        try:
            with (output/f'{label}.log').open('w') as log:
                result=subprocess.run(['systemd-run','--user','--scope','--quiet','-p','MemoryMax=16G','-p','MemorySwapMax=0',*argv],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,preexec_fn=limits,timeout=timeout)
            code=result.returncode
        except subprocess.TimeoutExpired: code=124
        report['commands'].append({'name':label,'argv':argv,'exitCode':code,'seconds':round(time.monotonic()-start,3),'log':str(output/f'{label}.log')})
        save(output/'linux-qa.json',report)
        print(json.dumps(report['commands'][-1]),flush=True)
        if code: break
    report['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();report['passed']=len(report['commands'])==2 and all(x['exitCode']==0 for x in report['commands'])
    save(output/'linux-qa.json',report)
    raise SystemExit(0 if report['passed'] else 1)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['snapshot','linux']);parser.add_argument('--output',type=pathlib.Path,default=ROOT/'artifacts/maturation');args=parser.parse_args()
    (snapshot if args.action=='snapshot' else linux)(args.output)
