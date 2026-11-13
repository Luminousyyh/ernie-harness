import json,pathlib
root=pathlib.Path('/home/home_new/yaoyh/ernie-harness/eval/qualification')
qualified=[]
for path in root.glob('*/attempt-*/result.json'):
 x=json.loads(path.read_text())
 if x.get('eligible'):
  qualified.append({'id':x['instanceId'],'repo':x['repo'],'f2p':len(x['failToPass']),'p2p':len(x['passToPass']),'base_exit':x['base']['exitCode'],'oracle_exit':x['oracle']['exitCode'],'path':str(path)})
print(json.dumps({'eligible_count':len(qualified),'eligible':qualified,'failed_attempts':len(list(root.glob('*/attempt-*/failure.json')))},indent=2))
