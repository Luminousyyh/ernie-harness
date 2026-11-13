"""Linux-only process-tree resource guard; no sudo/cgroups/GPU access required."""
from __future__ import annotations
import argparse, fcntl, json, os, pathlib, resource, signal, subprocess, sys, time, threading

def process_tree(pid):
    records = {}
    for item in pathlib.Path('/proc').iterdir():
        if not item.name.isdigit(): continue
        try:
            fields = (item/'stat').read_text().rsplit(')', 1)[1].split()
            records[int(item.name)] = (int(fields[1]), int(fields[21]) * os.sysconf('SC_PAGE_SIZE'))
        except (OSError, ValueError, IndexError): continue
    included, changed = {pid}, True
    while changed:
        children = {p for p, (parent, _) in records.items() if parent in included}
        changed = bool(children - included)
        included |= children
    return included, sum(records.get(p, (0, 0))[1] for p in included)

def reap_adopted(excluded_pid):
    # PR_SET_CHILD_SUBREAPER makes this guard responsible for orphaned
    # descendants. Reap only its own direct children, leaving Popen's child
    # to Popen.poll/wait so its exit code cannot be stolen.
    try:
        children = pathlib.Path(f'/proc/{os.getpid()}/task/{os.getpid()}/children').read_text().split()
    except OSError:
        return
    for value in children:
        pid = int(value)
        if pid == excluded_pid:
            continue
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass

def tree_rss(pid):
    return process_tree(pid)[1]

def signal_owned(signum):
    # Subreaper adopts double-forked descendants; include separate sessions too.
    included, _ = process_tree(os.getpid())
    for pid in sorted(included - {os.getpid()}, reverse=True):
        try: os.kill(pid, signum)
        except ProcessLookupError: pass

def disk_bytes(root):
    seen, size = set(), 0
    for path, dirs, files in os.walk(root, followlinks=False):
        for name in files:
            try:
                s = os.lstat(os.path.join(path, name))
                key = (s.st_dev, s.st_ino)
                if key not in seen:
                    seen.add(key)
                    size += max(s.st_size, s.st_blocks * 512)
            except OSError: pass
    return size

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--seconds', type=int, default=5400)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    root = pathlib.Path(args.root).resolve()
    if root != pathlib.Path('/home/home_new/yaoyh/ernie-harness'):
        parser.error('unexpected remote root')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command: parser.error('command required')
    lock = open(root/'eval/resource.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:8])
    # Enforce resident process-tree memory below. V8/Wasm reserve large virtual
    # address ranges, so RLIMIT_AS would reject them far below 16 GiB RSS.
    import ctypes
    ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
    os.environ.update(CUDA_VISIBLE_DEVICES='', NVIDIA_VISIBLE_DEVICES='none', OMP_NUM_THREADS='8', OPENBLAS_NUM_THREADS='8', MKL_NUM_THREADS='8', PYTHONUNBUFFERED='1')
    limit, start, last_disk, peak = None, time.monotonic(), 0.0, 0
    if disk_bytes(root) >= 200 * 1024**3: raise SystemExit('disk quota already exhausted')
    last_disk = time.monotonic()
    disk_thread = None
    disk_result = {}
    def scan_disk():
        try: disk_result['bytes'] = disk_bytes(root)
        except BaseException: disk_result['error'] = True
    child = subprocess.Popen(command, start_new_session=True)
    def stop(signum, frame):
        raise KeyboardInterrupt('resource guard cancelled')
    signal.signal(signal.SIGTERM, stop)
    try:
        while child.poll() is None:
            reap_adopted(child.pid)
            now = time.monotonic()
            rss = tree_rss(os.getpid())
            peak = max(peak, rss)
            if rss > 16 * 1024**3: limit = 'memory-tree-16GiB'
            if now - start > args.seconds: limit = 'wall-time'
            # Directory walks can take seconds; keep RSS, timeout and orphan
            # reaping responsive while the read-only disk scan runs separately.
            if disk_thread is not None and not disk_thread.is_alive():
                if disk_result.get('error'): limit = 'disk-scan-error'
                elif disk_result.get('bytes', 0) >= 200 * 1024**3: limit = 'disk-root-200GiB'
                disk_thread = None
                last_disk = now
            if disk_thread is None and now - last_disk > 15:
                disk_result.clear()
                disk_thread = threading.Thread(target=scan_disk, daemon=True)
                disk_thread.start()
            if limit: break
            time.sleep(0.25)
    finally:
        signal_owned(signal.SIGTERM)
        try: child.wait(timeout=3)
        except subprocess.TimeoutExpired: pass
        signal_owned(signal.SIGKILL)
        child.wait()
        for _ in range(8):
            reap_adopted(child.pid)
            time.sleep(0.05)
        result = {'command': command, 'exit_code': child.returncode, 'limit': limit,
            'peak_tree_rss_bytes': peak, 'elapsed_seconds': time.monotonic()-start,
            'cpu_affinity': sorted(os.sched_getaffinity(0)), 'disk_guard_bytes': 200*1024**3}
        print(json.dumps({'resource_guard': result}), flush=True)
    return 124 if limit else child.returncode
if __name__ == '__main__': sys.exit(main())
