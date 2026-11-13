import { describe, expect, it } from 'vitest';
import { sandboxArgv, validateBrokerUrl } from '../src/benchmark/sandbox.js';

describe('Linux evaluation isolation', () => {
  const root = '/home/home_new/yaoyh/ernie-harness';
  const options = { root, workspace: root + '/eval/trials/fresh/workspace', nodeRuntime: root + '/runtimes/node-v24.13.1-linux-x64',
    baseline: root + '/baselines/pi', brokerSocket: root + '/eval/broker.sock', relayScript: root + '/eval/relay.py',
    guardScript: root + '/eval/remote-guard.py', cpus: [0, 1, 2, 3, 4, 5, 6, 7], command: ['/runtime/node/bin/node', '/baseline/packages/coding-agent/dist/cli.js', '--help'] };
  it('requires user/pid/network isolation and mounts only trial, runtime, baseline and socket', () => {
    const argv = sandboxArgv(options);
    for (const flag of ['--unshare-all', '--clearenv', '--new-session', '--die-with-parent', '--cap-drop']) expect(argv).toContain(flag);
    expect(argv).toContain('--cpu-list'); expect(argv).toContain('0,1,2,3,4,5,6,7');
    expect(argv).toContain(options.guardScript); expect(argv).toContain('/broker/model.sock');
    expect(argv).not.toContain('--share-net'); expect(argv).not.toContain('/dev/nvidia0');
    expect(argv.filter(x => x === '/home/home_new/yaoyh')).toHaveLength(0);
    const mounts = argv.filter((_, i) => ['--ro-bind', '--bind'].includes(argv[i - 1]));
    expect(mounts).not.toContain('/etc');
    expect(mounts).not.toContain(root);
    expect(argv.filter(x => x === root)).toHaveLength(1); // guard quota root, never a bind mount
  });
  it('mounts only the trial Python environment and approved CPython runtime', () => {
    const pythonVenv = root + '/eval/trials/fresh/python-venv';
    const argv = sandboxArgv({ ...options, pythonVenv });
    expect(argv).toContain(pythonVenv);
    expect(argv).toContain(root + '/runtimes/cpython-3.11.14');
    expect(argv).toContain(pythonVenv + '/bin:/runtime/node/bin:/usr/bin:/bin');
    expect(() => sandboxArgv({ ...options, pythonVenv: root + '/eval/private/credential' })).toThrow();
    expect(() => sandboxArgv({ ...options, pythonVenv: root + '/eval/trials/other/python-venv' })).toThrow();
    expect(() => sandboxArgv({ ...options, brokerSocket: root + '/eval/private' })).toThrow();
  });
  it('rejects path escape, broad mounts, unbounded CPUs, or external broker URLs', () => {
    expect(() => sandboxArgv({ ...options, workspace: '/home/another' })).toThrow();
    expect(() => sandboxArgv({ ...options, baseline: root })).toThrow();
    expect(() => sandboxArgv({ ...options, cpus: Array.from({ length: 9 }, (_, i) => i) })).toThrow();
    expect(() => validateBrokerUrl('https://openrouter.ai/api/v1')).toThrow();
    expect(() => validateBrokerUrl('http://127.0.0.1:18080/v1')).not.toThrow();
  });
});

it('binds only a fresh private HOME leaf without exposing the private parent', () => {
  const root='/home/home_new/yaoyh/ernie-harness';
  const common={root,workspace:root+'/eval/trials/fresh/workspace',nodeRuntime:root+'/runtimes/node',baseline:root+'/baselines/pi',brokerSocket:root+'/eval/formal.sock',relayScript:root+'/eval/relay.py',guardScript:root+'/eval/remote-guard.py',cpus:[0,1,2,3,4,5,6,7],command:['true']};
  const homeDir=root+'/eval/private/adapter-records/fresh/pi-launch123/home';
  const argv=sandboxArgv({...common,homeDir});
  const i=argv.indexOf(homeDir);expect(argv[i-1]).toBe('--bind');expect(argv[i+1]).toBe('/home/agent');
  for(const unsafe of [root+'/eval/private',root+'/eval/private/credential',root+'/eval/private/adapter-records/other/pi-launch123/home',homeDir+'/..'])expect(()=>sandboxArgv({...common,homeDir:unsafe})).toThrow(/HOME|home/);
});
