import json,pathlib,pyarrow.parquet as pq
root=pathlib.Path('/home/home_new/yaoyh/ernie-harness');rows=pq.read_table(root/'eval/dataset/test-00000-of-00001.parquet').to_pylist()
for repo in ['django/django','sympy/sympy','psf/requests','pytest-dev/pytest','sphinx-doc/sphinx']:
 row=sorted((x for x in rows if x['repo']==repo),key=lambda x:x['version'],reverse=True)[0]
 s=row['eval_script'];a=s.index(": '>>>>> Start Test Output'");b=s.index(": '>>>>> End Test Output'")
 print(json.dumps({'id':row['instance_id'],'version':row['version'],'tests':s[a:b],'prefix':s[:s.index('git apply')],'f2p':len(row['FAIL_TO_PASS']),'p2p':len(row['PASS_TO_PASS'])}))
