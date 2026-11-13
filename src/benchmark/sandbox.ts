import { posix } from 'node:path';
export interface SandboxOptions {
  root: string; workspace: string; nodeRuntime: string; baseline: string; brokerSocket: string;
  homeDir?: string; pythonVenv?: string; relayScript: string; guardScript: string; taskFile?: string; configDir?: string; cpus: number[]; command: string[];
}
export function validateBrokerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/v1')
    throw new Error('sandbox broker must be a loopback HTTP /v1 endpoint');
  return url.href.replace(/\/$/, '');
}
export function sandboxArgv(o: SandboxOptions): string[] {
  const root = posix.resolve(o.root);
  const confined = (path: string, subtree: string): string => {
    const resolved = posix.resolve(path), boundary = root + '/' + subtree + '/';
    if (!resolved.startsWith(boundary) || path.includes('\0')) throw new Error(`unsafe ${subtree} mount`);
    return resolved;
  };
  if (root !== '/home/home_new/yaoyh/ernie-harness') throw new Error('unexpected remote root');
  const workspace = confined(o.workspace, 'eval/trials'), runtime = confined(o.nodeRuntime, 'runtimes');
  const baseline = confined(o.baseline, 'baselines'), socket = confined(o.brokerSocket, 'eval');
  const relay = confined(o.relayScript, 'eval'), guard = confined(o.guardScript, 'eval');
  if (o.cpus.length !== 8 || new Set(o.cpus).size !== 8 || o.cpus.some(c => !Number.isSafeInteger(c) || c < 0)) throw new Error('exactly 8 CPU IDs required');
  if (!/\.sock$/.test(socket) || [relay, guard].some(p => p.startsWith(root + '/eval/private/'))) throw new Error('only a broker socket and public launcher scripts may be mounted');
  const extra: string[] = [];
  let path = '/runtime/node/bin:/usr/bin:/bin';
  if (o.homeDir) {
    const home = posix.resolve(o.homeDir);
    const trial = posix.basename(posix.dirname(workspace));
    const prefix = root + '/eval/private/adapter-records/' + trial + '/';
    const suffix = home.slice(prefix.length);
    if (o.homeDir !== home || !home.startsWith(prefix) || !/^(ernie|pi|dsh)-[a-zA-Z0-9_-]+\/home$/.test(suffix))
      throw new Error('HOME must be a fresh private leaf belonging to this trial');
    extra.push('--bind', home, '/home/agent');
  }
  if (o.pythonVenv) {
    const venv = confined(o.pythonVenv, 'eval/trials');
    if (venv !== posix.dirname(workspace) + '/python-venv') throw new Error('Python environment must belong to this trial');
    const python = root + '/runtimes/cpython-3.11.14';
    extra.push('--ro-bind', python, python, '--ro-bind', venv, venv, '--setenv', 'VIRTUAL_ENV', venv, '--setenv', 'PYTHONPATH', '/workspace', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD', '1');
    path = venv + '/bin:' + path;
  }
  if (o.taskFile) extra.push('--ro-bind', confined(o.taskFile, 'eval/trials'), '/task.txt');
  if (o.configDir) extra.push('--ro-bind', confined(o.configDir, 'eval/trials'), '/config');
  if (!o.command.length) throw new Error('sandbox command required');
  return ['taskset', '--cpu-list', o.cpus.join(','), 'python3', guard, '--root', root, '--seconds', '2100', '--',
    'bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', '/home/agent', '--dir', '/etc',
    '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache', '--dir', '/broker', '--ro-bind', socket, '/broker/model.sock',
    '--ro-bind', runtime, '/runtime/node', '--ro-bind', baseline, '/baseline', '--ro-bind', relay, '/relay.py',
    '--bind', workspace, '/workspace', ...extra, '--chdir', '/workspace',
    '--setenv', 'HOME', '/home/agent', '--setenv', 'PATH', path,
    '--setenv', 'CUDA_VISIBLE_DEVICES', '', '--setenv', 'NVIDIA_VISIBLE_DEVICES', 'none',
    '--setenv', 'OMP_NUM_THREADS', '8', '--setenv', 'OPENBLAS_NUM_THREADS', '8',
    '--setenv', 'GIT_CONFIG_NOSYSTEM', '1', '--setenv', 'NO_PROXY', '*',
    '/usr/bin/python3', '/relay.py', '--socket', '/broker/model.sock', '--port', '18080', '--', ...o.command];
}
