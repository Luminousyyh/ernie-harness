"""Private final SWE-bench scorer. No model calls and no hidden feedback to agents.

Run with root/runtimes/evaluator/bin/python. --prepare creates agent-visible
source/venv only; scoring uses a separately copied private checkout and official
adapted TestSpec script (which installs the official test patch exactly once).
"""
from __future__ import annotations
import argparse, hashlib, importlib.util, json, os, pathlib, re, shutil, subprocess, sys, time

ROOT = pathlib.Path('/home/home_new/yaoyh/ernie-harness')
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'eval'))
from qualification_support import qualified_records, is_eligible
from test_ids import reconcile_test_ids
from patch_collection import freeze_base_objects, collect_patch

def sha(data):
    return hashlib.sha256(data).hexdigest()

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    with open(path, 'xb') as stream:
        os.chmod(path, 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return sha(data)

def qualification(instance, expected=None):
    found = []
    for path in sorted((ROOT / 'eval/qualification' / instance).glob('attempt-*/result.json')):
        try:
            record = json.loads(path.read_text())
            if not is_eligible(record):
                continue
            for phase in ['base', 'oracle']:
                if sha((path.parent / (phase + '.log')).read_bytes()) != record[phase]['logSha256']:
                    raise ValueError('qualification evidence changed')
            # Mirror schedule.digest() insertion-order JSON, not this script's sorted evidence JSON.
            if expected and sha(json.dumps(record, separators=(',', ':'), ensure_ascii=False).encode()) != expected:
                continue
            if sha((path.parent / 'adapted-eval.sh').read_bytes()) != record['adaptedScriptSha256']:
                raise ValueError('adapted official script changed')
            found.append((path.parent, record))
        except (OSError, KeyError, ValueError):
            continue
    if not found:
        raise ValueError('no intact eligible qualification evidence for instance')
    return found[-1]

def checked_run(argv, cwd, log):
    result = subprocess.run(argv, cwd=cwd, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1'}, stdout=log, stderr=subprocess.STDOUT, timeout=120)
    if result.returncode:
        raise ValueError('private source preparation failed')

def clean_source(base, destination, log):
    # Qualification local HEAD is the original source archive, before hidden tests.
    shutil.copytree(base, destination, symlinks=True)
    checked_run(['git', 'reset', '--hard', 'HEAD'], destination, log)
    checked_run(['git', 'clean', '-fd'], destination, log)
    checked_run(['git', 'clean', '-fdx'], destination, log)
    # No external worktree metadata or symlink may expose evaluator files.
    if not (destination / '.git').is_dir():
        raise ValueError('standalone original source repository required')
    for path in destination.rglob('*'):
        if path.is_symlink() and not path.resolve().is_relative_to(destination.resolve()):
            raise ValueError('source symlink escapes trial workspace')

def copy_venv(context, destination, workspace):
    shutil.copytree(context / 'venv', destination, symlinks=True)
    original = str(context / 'venv')
    # Editable installs in qualification point to oracle. Rewrite those references
    # without mounting the oracle or reinstalling hidden source in the agent.
    for path in destination.rglob('*'):
        if path.is_symlink():
            target = os.readlink(path)
            if target.startswith(original):
                path.unlink()
                path.symlink_to(target.replace(original, str(destination), 1))
            elif pathlib.Path(target).is_absolute() and not pathlib.Path(target).resolve().is_relative_to(ROOT / 'runtimes/cpython-3.11.14'):
                raise ValueError('venv symlink exposes unapproved host path')
            continue
        if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
            continue
        if path.suffix not in ['.pth', '.egg-link', '.cfg', '.json'] and path.parent != destination / 'bin' and not path.name.startswith('__editable__'):
            continue
        try:
            text = path.read_text()
        except (UnicodeError, OSError):
            continue
        text = text.replace(str(context / 'oracle'), str(workspace)).replace(str(context / 'base'), str(workspace)).replace(original, str(destination))
        # Do not preserve an editable-install provenance URL pointing to a hidden folder.
        if str(context) in text:
            text = text.replace(str(context), str(workspace))
        path.write_text(text)

def dataset_row(instance):
    import pyarrow.parquet as pq
    data = ROOT / 'eval/dataset/test-00000-of-00001.parquet'
    metadata = json.loads((ROOT / 'eval/dataset/lfs-metadata.json').read_text())
    expected = next(row['lfs']['oid'] for row in metadata if row['path'].endswith('.parquet'))
    if sha(data.read_bytes()) != expected:
        raise ValueError('dataset provenance changed')
    return next(row for row in pq.read_table(data).to_pylist() if row['instance_id'] == instance)

def prepare(args, context, record, trialdir):
    # mkdir is the durable abort point. Existing directories must be reconciled,
    # never overwritten or blindly reused after a crash.
    trialdir.mkdir(parents=True, mode=0o700)
    private = ROOT / 'eval/private/formal/preparation' / trialdir.name
    private.mkdir(parents=True, mode=0o700)
    with open(private / 'setup.log', 'xb') as log:
        os.chmod(private / 'setup.log', 0o600)
        clean_source(context / 'base', trialdir / 'workspace', log)
    collector = freeze_base_objects(context / 'base', private)
    copy_venv(context, trialdir / 'python-venv', pathlib.Path('/workspace'))
    # Bin shebangs use the original host venv mount; editable imports use /workspace.
    row = dataset_row(args.instance)
    result = {'workspace': str(trialdir / 'workspace'), 'prompt': row['problem_statement']}
    write_json(private / 'prepared.json', {'instance': args.instance, 'baseCommit': record['baseCommit'], 'workspace': result['workspace'], 'context': str(context), 'collector': collector})
    return result

def score(args, context, record, trialdir):
    hidden = ROOT / 'eval/private/formal/evaluation' / trialdir.name
    hidden.mkdir(parents=True, mode=0o700)
    # Exclusive receipt ensures that final observation is never run twice.
    write_json(hidden / 'evaluation-started.json', {'instance': args.instance, 'at': time.time(), 'patchSha256': sha(args.patch.read_bytes())})
    workspace, venv = hidden / 'workspace', hidden / 'venv'
    with open(hidden / 'setup.log', 'xb') as setup:
        os.chmod(hidden / 'setup.log', 0o600)
        clean_source(context / 'base', workspace, setup)
        if args.patch.stat().st_size:
            checked_run(['git', 'apply', '--binary', '--', str(args.patch)], workspace, setup)
    copy_venv(context, venv, workspace)
    script = hidden / 'adapted-eval.sh'
    shutil.copyfile(context / 'adapted-eval.sh', script)
    os.chmod(script, 0o600)
    # Use precisely the qualification helper's private interpreter/environment
    # bindings. It exposes this checkout, this venv and CPython, no oracle.
    module_spec = importlib.util.spec_from_file_location('qualification_runtime', ROOT / 'eval/remote-qualify.py')
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    testlog = hidden / 'hidden-test.log'
    code = module.run(module.sandbox(workspace, venv, script), hidden, testlog, 600, False)
    os.chmod(testlog, 0o600)
    from swebench.harness.log_parsers import PARSER_REGISTRY
    from swebench.harness.utils import make_test_spec
    row = dataset_row(args.instance)
    spec = make_test_spec(row)
    text = testlog.read_text(errors='replace')
    statuses = PARSER_REGISTRY[row['log_parser']](text, spec)
    statuses, aliases = reconcile_test_ids(record['failToPass'] + record['passToPass'], statuses, record['repo'])
    test_codes = re.findall(r'(?m)^>>>>> Test Exit Code: (\d+)', text)
    expected_tests = record['failToPass'] + record['passToPass']
    completed = bool(test_codes) and '>>>>> End Test Output' in text and all(test in statuses for test in expected_tests)
    resolved = completed and all(statuses.get(test) == 'PASSED' for test in expected_tests)
    evidence = {'instanceId': args.instance, 'completed': completed, 'resolved': resolved,
                'processExitCode': code, 'testExitCode': int(test_codes[-1]) if test_codes else None,
                'patchSha256': sha(args.patch.read_bytes()), 'hiddenLogSha256': sha(testlog.read_bytes()),
                'adaptedScriptSha256': record['adaptedScriptSha256'], 'statuses': statuses, 'parserAliases': aliases,
                'environmentDigest': record['environmentDigest'], 'environmentAdaptation': record.get('environmentAdaptation'), 'officialDocker': False}
    evidence_path = hidden / 'evidence.json'
    evidence_sha = write_json(evidence_path, evidence)
    return {'completed': completed, 'resolved': resolved, 'evidenceSha256': evidence_sha, 'evidencePath': str(evidence_path)}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', action='store_true')
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--collect-patch', action='store_true')
    parser.add_argument('--instance')
    parser.add_argument('--patch', type=pathlib.Path)
    parser.add_argument('--trialdir', type=pathlib.Path)
    parser.add_argument('--qualification-sha256')
    args = parser.parse_args()
    os.umask(0o077)
    if args.index:
        print(json.dumps(qualified_records(ROOT / 'eval/qualification')))
        return
    if not args.instance or not re.fullmatch(r'[A-Za-z0-9_.-]+', args.instance) or not args.trialdir:
        parser.error('--instance and --trialdir required')
    trialdir = args.trialdir.absolute()
    if trialdir.parent != ROOT / 'eval/trials' or not re.fullmatch(r'(trial|dev)-[a-f0-9]{40}', trialdir.name):
        parser.error('trial directory must be a direct evaluator-owned trial path')
    context, record = qualification(args.instance, args.qualification_sha256)
    if args.collect_patch:
        if not args.patch:parser.error('private output patch path required')
        result = collect_patch(ROOT, trialdir, args.instance, args.patch)
    elif args.prepare:
        result = prepare(args, context, record, trialdir)
    else:
        if not args.patch or not args.patch.is_file() or not args.patch.resolve().is_relative_to(ROOT / 'eval/private/formal/patches'):
            parser.error('private submitted patch required')
        result = score(args, context, record, trialdir)
    print(json.dumps(result))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Details and hidden test output remain private, never echoed to model logs.
        sys.stderr.write('Private evaluation failed; observation is incomplete and requires reconciliation.\n')
        sys.exit(1)
