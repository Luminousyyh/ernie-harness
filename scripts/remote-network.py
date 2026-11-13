import concurrent.futures,json,urllib.request,pathlib
urls={
 'hf-mirror':'https://hf-mirror.com/api/datasets/SWE-bench/SWE-bench_Verified',
 'cloudflare-dns':'https://1.1.1.1/dns-query?name=datasets-server.huggingface.co&type=A',
 'google-dns':'https://8.8.8.8/resolve?name=huggingface.co&type=A',
 'hf-api':'https://huggingface.co/api/datasets/princeton-nlp/SWE-bench_Verified'}
def get(item):
 name,url=item
 try:
  req=urllib.request.Request(url,headers={'accept':'application/dns-json' if 'dns' in name else 'application/json'})
  data=urllib.request.urlopen(req,timeout=12).read();pathlib.Path('/home/home_new/yaoyh/ernie-harness/eval/dataset',name+'.json').write_bytes(data);return name,data[:1200].decode()
 except Exception as e:return name,str(e)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for result in pool.map(get,urls.items()):print(result,flush=True)
