import {expect,it} from 'vitest';import{spawnSync}from'node:child_process';import{resolve}from'node:path';
it('displays only durable completion counts and excludes credentials from the Web snapshot',()=>{
const code=`import importlib.util,sys,json
spec=importlib.util.spec_from_file_location('sync',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rows={'development':[{'id':'d','instanceId':'task','harness':'ernie','repeat':0,'contextLimit':64000,'status':'pending','token':'must-not-appear','usage':{'calls':0}}],'formal':[{'id':'f','instanceId':'task','harness':'pi','repeat':0,'status':'unresolved','usage':{'calls':4,'inputTokens':123}}]}
x=m.build_snapshot(rows,{'state':'waiting-quota','retryAt':'2026-11-13T00:00:00Z','apiKey':'must-not-appear'},'2026-11-13T03:00:00+08:00')
assert x['summary']['开发试验']=='0 / 1' and x['summary']['正式试验']=='1 / 1'
assert x['summary']['正式已落盘模型请求']==4
assert x['summary']['下次额度窗口（北京时间）']=='2026-11-13T08:00:00+08:00'
assert 'must-not-appear' not in json.dumps(x)
assert 'must-not-appear' not in json.dumps(m.public_trial(rows['development'][0]))
assert not m.finished(rows,{'state':'complete','phase':'development'})
full={'development':[], 'formal':[{'id':str(i),'status':'resolved'} for i in range(144)]}
assert m.finished(full,{'state':'complete','phase':'formal'})
full['formal'][143]['id']='0';assert not m.finished(full,{'state':'complete'})
print('display checks passed')`;
const result=spawnSync(process.env.PYTHON??(process.platform==='win32'?'python':'python3'),['-c',code,resolve('scripts/sync-evaluation.py')],{encoding:'utf8'});expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('display checks passed');
});
