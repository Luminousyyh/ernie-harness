import hashlib,json,pathlib,urllib.request
root=pathlib.Path('/home/home_new/yaoyh/ernie-harness');url='https://hf-mirror.com/api/datasets/SWE-bench/SWE-bench_Verified/tree/78f471bf655a3137b2e8a75af1501690ec009ec3/data?expand=true'
try:
 data=json.load(urllib.request.urlopen(url,timeout=20));(root/'eval/dataset/lfs-metadata.json').write_text(json.dumps(data,indent=2));print(json.dumps(data))
except Exception as e:print(str(e))
