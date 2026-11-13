import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('qualification evidence integrity', () => {
  it('rejects altered logs, missing tests and success flags without results; deduplicates successful retries', () => {
    const code = `
import sys,tempfile,pathlib,json,hashlib
sys.path.insert(0,sys.argv[1])
from qualification_support import qualified_records,is_eligible,write_json,candidates,reconcile_test_ids
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);attempt=root/'task'/ 'attempt-1';attempt.mkdir(parents=True)
 for phase in ['base','oracle']:(attempt/(phase+'.log')).write_text(phase)
 rec={'instanceId':'task','eligible':True,'failToPass':['fix'],'passToPass':['stable'],'base':{'completed':True,'exitCode':1,'statuses':{'fix':'FAILED','stable':'PASSED'},'logSha256':hashlib.sha256(b'base').hexdigest()},'oracle':{'completed':True,'exitCode':0,'statuses':{'fix':'PASSED','stable':'PASSED'},'logSha256':hashlib.sha256(b'oracle').hexdigest()}}
 write_json(attempt/'result.json',rec)
 assert len(qualified_records(root))==1
 (attempt/'oracle.log').write_text('altered')
 assert qualified_records(root)==[]
 (attempt/'oracle.log').write_text('oracle')
 del rec['oracle']['statuses']['stable'];write_json(attempt/'result.json',rec)
 assert qualified_records(root)==[]
 assert not is_eligible({'eligible':True})
 rec['oracle']['statuses']['stable']='PASSED'
 rec['base']['statuses']['fix']='ERROR';assert is_eligible(rec)
 rec['base']['statuses']['fix']='SKIPPED';assert not is_eligible(rec)
 rec['base']['statuses']['fix']='FAILED'
 old='test_fix (pkg.Case)';new='test_fix (pkg.Case.test_fix)'
 mapped,aliases=reconcile_test_ids([old],{new:'FAILED'},'django/django')
 assert mapped[old]=='FAILED' and aliases[old]==[new]
 mapped,_=reconcile_test_ids([new],{new:'PASSED'},'django/django');assert mapped[new]=='PASSED'
 mapped,_=reconcile_test_ids([old],{new+' (x=1)':'ERROR'},'django/django');assert mapped[old]=='ERROR'
 mapped,_=reconcile_test_ids([old],{new+' (x=1)':'PASSED'},'django/django');assert old not in mapped
 mapped,_=reconcile_test_ids([old],{'test_fix (pkg.Other.test_fix)':'PASSED'},'django/django');assert old not in mapped
 rec['oracle']['statuses']['stable']='PASSED';write_json(attempt/'result.json',rec)
 import shutil
 shutil.copytree(attempt,root/'task'/'attempt-2')
 assert len(qualified_records(root))==1
 rows=[{'instance_id':f'{repo}-{i}','repo':repo,'version':'4.2'} for repo in ['django/django','sympy/sympy'] for i in range(35)]
 a=candidates(rows,48);b=candidates(list(reversed(rows)),48)
 assert a==b and len(a)==48 and len({r['instance_id'] for r in a})==48
 assert sum(r['repo']=='sympy/sympy' for r in a)==24
 print('qualification evidence checks passed')
`;
    const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', code, resolve('eval')], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('qualification evidence checks passed');
  });
});
