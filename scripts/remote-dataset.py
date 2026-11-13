import json,pathlib,subprocess
root=pathlib.Path('/home/home_new/yaoyh/ernie-harness');info=json.loads((root/'eval/dataset/hf-mirror.json').read_text());revision=info['sha']
print(json.dumps({'dataset_revision':revision,'files':[x['rfilename'] for x in info.get('siblings',[])],'features':info.get('cardData',{}).get('dataset_info',{}).get('features')}),flush=True)
for x in info.get('siblings',[]):
 if x['rfilename'].endswith('.parquet') and 'test' in x['rfilename']:
  dest=root/'eval/dataset'/pathlib.Path(x['rfilename']).name
  url=f'https://hf-mirror.com/datasets/SWE-bench/SWE-bench_Verified/resolve/{revision}/'+x['rfilename']
  result=subprocess.run(['curl','-fL','--connect-timeout','10','--max-time','180','-o',str(dest)+'.part',url],capture_output=True)
  print(json.dumps({'file':str(dest),'exit':result.returncode,'bytes':pathlib.Path(str(dest)+'.part').stat().st_size if pathlib.Path(str(dest)+'.part').exists() else 0,'error':result.stderr.decode(errors='replace')[-300:]}),flush=True)
  if result.returncode==0:pathlib.Path(str(dest)+'.part').replace(dest)
