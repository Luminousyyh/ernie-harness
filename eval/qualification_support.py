"""Evidence-only qualification index. Standard library; also used in offline tests."""
from __future__ import annotations
import hashlib,json,pathlib

from test_ids import reconcile_test_ids

def is_eligible(record):
    try:
        f2p,p2p=record['failToPass'],record['passToPass'];base,oracle=record['base'],record['oracle']
        return bool(f2p) and len(set(f2p+p2p))==len(f2p+p2p) and base['completed'] is True and oracle['completed'] is True and base['exitCode']!=0 and oracle['exitCode']==0 and all(base['statuses'].get(t) in ('FAILED','ERROR') and oracle['statuses'].get(t)=='PASSED' for t in f2p) and all(base['statuses'].get(t)=='PASSED' and oracle['statuses'].get(t)=='PASSED' for t in p2p)
    except (KeyError,TypeError):return False

def qualified_records(root):
    found={}
    for path in sorted(pathlib.Path(root).glob('*/attempt-*/result.json')):
        try:
            record=json.loads(path.read_text())
            if not is_eligible(record):continue
            for phase in ['base','oracle']:
                if hashlib.sha256((path.parent/(phase+'.log')).read_bytes()).hexdigest()!=record[phase]['logSha256']:
                    raise ValueError('log hash mismatch')
            found[record['instanceId']]=record
        except (OSError,ValueError,KeyError,TypeError):continue
    return [found[key] for key in sorted(found)]

def write_json(path,value):
    path=pathlib.Path(path);temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value,indent=2));temporary.replace(path)

def candidates(rows,limit,seed=20261112):
    supported=[r for r in rows if r['repo']=='pallets/flask' or (r['repo']=='django/django' and float(r['version'])>=4) or r['repo']=='sympy/sympy']
    strata={repo:sorted([r for r in supported if r['repo']==repo],key=lambda r:hashlib.sha256((str(seed)+r['instance_id']).encode()).hexdigest()) for repo in sorted({r['repo'] for r in supported})}
    result=[]
    while strata and len(result)<limit:
        for repo in list(strata):
            result.append(strata[repo].pop(0))
            if not strata[repo]:del strata[repo]
            if len(result)>=limit:break
    return result
