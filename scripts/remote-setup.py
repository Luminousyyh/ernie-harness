"""Private remote preparation. Run with system Python 3.10; no credentials required."""
from __future__ import annotations
import hashlib, json, os, pathlib, resource, socket, subprocess, tarfile, time, urllib.request, zipfile
socket.setdefaulttimeout(40)
ROOT = pathlib.Path('/home/home_new/yaoyh/ernie-harness')
NODE = '24.13.1'
UV = '0.9.11'
PINS = {
    'dsh': ('https://github.com/deepseek-ai/deepseek-harness.git', 'e8f7b93a344964de3dca1ace9e72b6e4d6de87cb'),
    'pi': ('https://github.com/badlogic/pi-mono.git', 'b22e525b325ff1934b4110f7fc60426fd6f0a8f3'),
    'swebench': ('https://github.com/SWE-bench/SWE-bench.git', '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e'),
}
def run(argv, cwd=None):
    print(json.dumps({'command': argv, 'cwd': str(cwd or ROOT)}), flush=True)
    subprocess.run(argv, cwd=cwd or ROOT, check=True, timeout=900)
def download(url, dest):
    if not dest.exists():
        temp = dest.with_suffix(dest.suffix + '.part')
        urllib.request.urlretrieve(url, temp)
        temp.replace(dest)
def unpack(archive, dest):
    dest = dest.resolve()
    with tarfile.open(archive) as stream:
        for member in stream.getmembers():
            path = (dest / member.name).resolve()
            if not path.is_relative_to(dest): raise ValueError('archive path escapes runtime')
            if member.issym():
                target = (path.parent / member.linkname).resolve()
                if not target.is_relative_to(dest): raise ValueError('archive link escapes runtime')
            elif member.islnk():
                if not (dest / member.linkname).resolve().is_relative_to(dest): raise ValueError('archive hardlink escapes runtime')
            elif not (member.isfile() or member.isdir()): raise ValueError('unsupported archive entry')
        stream.extractall(str(dest), filter='fully_trusted')
def main():
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:8])
    resource.setrlimit(resource.RLIMIT_AS, (16 * 1024**3, 16 * 1024**3))
    for name in ['eval', 'cache', 'runtimes', 'baselines']:
        (ROOT / name).mkdir(parents=True, exist_ok=True)
    for name in ['cache/tmp', 'cache/uv', 'cache/npm', 'runtimes/home', 'runtimes/python']:
        (ROOT / name).mkdir(parents=True, exist_ok=True)
    os.environ.update(HOME=str(ROOT/'runtimes/home'), TMPDIR=str(ROOT/'cache/tmp'),
        UV_CACHE_DIR=str(ROOT/'cache/uv'), UV_PYTHON_INSTALL_DIR=str(ROOT/'runtimes/python'),
        npm_config_cache=str(ROOT/'cache/npm'), UV_HTTP_TIMEOUT='60', UV_HTTP_RETRIES='1', GIT_TERMINAL_PROMPT='0', CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='8',
        OPENBLAS_NUM_THREADS='8', MKL_NUM_THREADS='8', UV_CONCURRENT_BUILDS='2', UV_CONCURRENT_INSTALLS='4')
    archive = ROOT / 'cache' / f'node-v{NODE}-linux-x64.tar.xz'
    download(f'https://nodejs.org/dist/v{NODE}/{archive.name}', archive)
    sums = urllib.request.urlopen(f'https://nodejs.org/dist/v{NODE}/SHASUMS256.txt').read().decode()
    expected = next(line.split()[0] for line in sums.splitlines() if line.endswith(archive.name))
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected, 'Node checksum mismatch'
    if not (ROOT/'runtimes'/f'node-v{NODE}-linux-x64/bin/node').exists(): unpack(archive, ROOT/'runtimes')
    nodebin = ROOT/'runtimes'/f'node-v{NODE}-linux-x64/bin'
    os.environ['PATH'] = str(nodebin) + ':' + os.environ['PATH']
    run(['node', '--version'])
    metadata = json.load(urllib.request.urlopen(f'https://pypi.org/pypi/uv/{UV}/json', timeout=30))
    wheel = next(f for f in metadata['urls'] if 'manylinux' in f['filename'] and 'x86_64' in f['filename'] and f['filename'].endswith('.whl'))
    uvarc = ROOT/'cache'/wheel['filename']
    download(wheel['url'], uvarc)
    assert hashlib.sha256(uvarc.read_bytes()).hexdigest() == wheel['digests']['sha256']
    uvroot = ROOT/'runtimes/uv-wheel'
    uvroot.mkdir(exist_ok=True)
    with zipfile.ZipFile(uvarc) as stream: stream.extractall(uvroot)
    uvpath = next(p for p in uvroot.rglob('uv') if p.is_file() and p.stat().st_size > 1000000)
    uvpath.chmod(0o755)
    uv = str(uvpath)
    run([uv, '--version'])
    for name, (url, pin) in PINS.items():
        dest = ROOT/'baselines'/name
        if not (dest/'.git').exists():
            run(['git', 'init', str(dest)])
            run(['git', 'remote', 'add', 'origin', url], dest)
        if subprocess.run(['git', 'cat-file', '-e', pin], cwd=dest, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            run(['git', '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30', 'fetch', '--depth=1', 'origin', pin], dest)
        run(['git', 'checkout', '--detach', pin], dest)
        assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=dest, text=True).strip() == pin
    # GitHub binary assets are timing out on this host. Build an official CPython
    # release privately, then let uv own the evaluator venv and package installation.
    python = ROOT/'runtimes/cpython-3.11.14/bin/python3.11'
    if not python.exists():
        archive = ROOT/'cache/Python-3.11.14.tar.xz'
        download('https://www.python.org/ftp/python/3.11.14/Python-3.11.14.tar.xz', archive)
        unpack(archive, ROOT/'runtimes')
        source = ROOT/'runtimes/Python-3.11.14'
        run(['./configure', '--prefix='+str(ROOT/'runtimes/cpython-3.11.14'), '--with-ensurepip=install'], source)
        run(['make', '-j8'], source)
        run(['make', 'install'], source)
    run([str(python), '--version'])
    if not (ROOT/'runtimes/evaluator/bin/python').exists():
        run([uv, 'venv', str(ROOT/'runtimes/evaluator'), '--python', str(python)])
    run([uv, 'pip', 'install', '--python', str(ROOT/'runtimes/evaluator/bin/python'), 'psutil==7.1.3', 'requests==2.32.5', 'huggingface-hub==0.36.0', '-e', str(ROOT/'baselines/swebench')])
    result = {'node': NODE, 'node_sha256': expected, 'uv': UV, 'python': '3.11.14', 'python_install_method': 'official source; uv-managed venv',
        'pins': {name: pin for name, (_, pin) in PINS.items()}, 'cpu_affinity': sorted(os.sched_getaffinity(0)),
        'gpu_visible': False, 'timestamp': time.time(), 'status': 'runtime-and-source-ready',
        'baseline_builds': 'pending', 'model_calls': 0, 'eligible_tasks': 0}
    (ROOT/'eval/bootstrap.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
if __name__ == '__main__': main()
