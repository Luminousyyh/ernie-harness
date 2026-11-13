"""Sync allowlisted remote benchmark exports into the local workbench.

SSH credentials are runtime-only. --watch observes the existing queue; it never
runs a model, starts a trial, changes remote state or sends notifications.
"""
from __future__ import annotations
import argparse,datetime,getpass,json,os,pathlib,re,time,uuid
ROOT='/home/home_new/yaoyh/ernie-harness'
BJT=datetime.timezone(datetime.timedelta(hours=8))
LABELS={'pending':'待执行','running':'执行中','needs-reconciliation':'待核对','awaiting-evaluation':'待评分','evaluating':'评分中','resolved':'已解决','unresolved':'未解决','evaluation-incomplete':'评分未完成','infrastructure-failed':'环境失败'}
STATES={'waiting-main-integration':'等待集成放行','waiting-quota':'等待免费额度恢复','waiting-qualification':'等待环境资格验证','waiting-dev-tuning':'等待开发集调参','complete':'已完成','incomplete':'执行已停止，需核对','running':'执行中','provider-changed':'模型路由变化，等待核对'}
def public_trial(value):
 fields=['id','instanceId','harness','repeat','contextLimit','status','infrastructureRestarts','agentExitCode','patchSha256','evidenceSha256']
 result={key:value[key] for key in fields if key in value}
 observation=value.get('observation')
 if isinstance(observation,dict):result['observation']={key:observation[key] for key in ['receiptPath','receiptSha256','providerComplete','toolCalls','toolFailures','toolMetricsComplete','toolMetricsSource'] if key in observation}
 result['usage']={key:value.get('usage',{}).get(key,0) for key in ['calls','inputTokens','outputTokens','activeMs']}
 return result
def build_snapshot(phases,status,checked_at=None):
 checked_at=checked_at or datetime.datetime.now(BJT).isoformat()
 summary={'最近同步（北京时间）':checked_at,'任务目标':'18 次开发试验 + 144 次正式试验','统计口径':'持久化导出；排队记录不算完成，运行用量在检查点更新'};rows=[]
 for phase,name in [('development','开发'),('formal','正式')]:
  trials=phases[phase];complete=sum(t['status'] in ['resolved','unresolved'] for t in trials)
  summary[name+'试验']=f'{complete} / {len(trials)}'
  summary[name+'已落盘模型请求']=sum(t.get('usage',{}).get('calls',0) for t in trials)
  for t in trials:
   usage=t.get('usage',{});rows.append({'阶段':name,'任务':t['instanceId'],'Harness':{'ernie':'ERNIE','dsh':'DSH','pi':'Pi'}.get(t['harness'],'未知'),'轮次':t['repeat']+1,'上下文上限':t.get('contextLimit',status.get('contextLimit','待开发集选型')),'状态':LABELS.get(t['status'],'未知'),'模型请求':usage.get('calls',0),'输入 Token':usage.get('inputTokens',0)})
 for field,label in [('remaining','当前免费请求余额（保守）'),('reservedPerTrial','每轮预留模型请求')]:
  if type(status.get(field)) is int and status[field]>=0:summary[label]=status[field]
 if status.get('contextLimit') in [64000,128000,256000]:summary['已选活动上下文']=status['contextLimit']
 retry=status.get('retryAt')
 if isinstance(retry,str):
  try:summary['下次额度窗口（北京时间）']=datetime.datetime.fromisoformat(retry.replace('Z','+00:00')).astimezone(BJT).isoformat()
  except ValueError:pass
 state=status.get('state','unknown')
 return {'status':STATES.get(state,'运行状态：'+state if isinstance(state,str) and len(state)<64 else '状态待核对'),'summary':summary,'trials':rows,'checkedAt':checked_at,'source':'remote durable queue exports; no mock results'}
def finished(phases,status):
 formal=phases.get('formal',[])
 return status.get('state')=='complete' and len(formal)==144 and len({row.get('id') for row in formal})==144 and all(row.get('status') in ['resolved','unresolved'] for row in formal)
def atomic(path,value):
 path.parent.mkdir(parents=True,exist_ok=True);temporary=path.with_name(path.name+'.'+str(uuid.uuid4())+'.tmp')
 with os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w',encoding='utf8') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
 temporary.replace(path)
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--watch',action='store_true');parser.add_argument('--interval',type=int,default=60);parser.add_argument('--host',default='10.15.196.230');parser.add_argument('--port',type=int,default=51700);parser.add_argument('--user',default='yaoyh');parser.add_argument('--output',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parent.parent/'artifacts/benchmark/summary.json');args=parser.parse_args()
 if args.interval<10:parser.error('interval must be at least ten seconds')
 import paramiko
 password=os.environ.pop('ERNIE_SSH_PASSWORD',None) or getpass.getpass('SSH password: ');client=None
 try:
  while True:
   try:
    if client is None:
     client=paramiko.SSHClient();client.load_system_host_keys();known=pathlib.Path.home()/'.ernie-harness/evaluation-known-hosts'
     if known.exists():client.load_host_keys(str(known))
     client.connect(args.host,port=args.port,username=args.user,password=password,timeout=12)
     client.get_transport().set_keepalive(30)
    sftp=client.open_sftp();sftp.get_channel().settimeout(15)
    def read(relative):
     with sftp.open(ROOT+'/'+relative) as handle:
      if handle.stat().st_size>4*1024*1024:raise ValueError('export size limit')
      return handle.read().decode('utf8')
    phases={phase:[public_trial(json.loads(line)) for line in read('eval/'+phase+'/results.jsonl').splitlines() if line.strip()] for phase in ['development','formal']}
    status=json.loads(read('eval/private/formal/status.json'))
    try:
     tuning=json.loads(read('eval/private/formal/tuning.json'))
     if tuning.get('status')=='frozen' and tuning.get('settings',{}).get('contextLimit') in [64000,128000,256000]:status['contextLimit']=tuning['settings']['contextLimit']
    except (OSError,ValueError,TypeError):pass
    snapshot=build_snapshot(phases,status)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    reports=[]
    for phase,name in [('development','开发集'),('formal','正式集')]:
     text=re.sub(r'sk-or-v1-[A-Za-z0-9]+','[REDACTED]',read('eval/'+phase+'/summary.md'))
     reports.append('## '+name+'\n\n'+text)
     (args.output.parent/(phase+'-summary.md')).write_text(text,encoding='utf8')
    snapshot['report']='\n\n'.join(reports);atomic(args.output,snapshot)
    for phase,rows in phases.items():atomic(args.output.parent/(phase+'-trials.json'),rows)
    sftp.close();print('Evaluation exports synchronized.',flush=True)
    if not args.watch or finished(phases,status):break
   except Exception as error:
    if client:client.close();client=None
    print('Evaluation sync unavailable: '+type(error).__name__,flush=True)
    if not args.watch:raise SystemExit(1)
   time.sleep(args.interval)
 finally:
  if client:client.close()
if __name__=='__main__':main()
