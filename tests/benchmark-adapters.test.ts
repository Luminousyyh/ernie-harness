import { describe, expect, it } from 'vitest';
import { baselineConfig, baselineCommand, baselineEnvironment } from '../src/benchmark/adapters.js';
import { MODEL_ID } from '../src/contracts/index.js';

describe('pinned baseline transport adapters', () => {
  it('uses only the exact free model, provided loopback URL and fake trial token', () => {
    for (const name of ['ernie', 'dsh', 'pi'] as const) {
      const config = baselineConfig(name, 'http://127.0.0.1:18080/v1', 'trial-test-only');
      expect(JSON.stringify(config)).toContain(MODEL_ID);
      expect(JSON.stringify(config)).toContain('http://127.0.0.1:18080/v1');
      if (name === 'dsh') {
        const route = (config as { id: string; config?: any }[]).find(row => row.id === 'llm-pi-ai')!.config.providers['ernie-eval'];
        expect(route.apiKeyEnv).toBe('ERNIE_EVAL_TRIAL_TOKEN');
        expect(route).not.toHaveProperty('apiKey');
        expect(baselineEnvironment(name, 'trial-test-only').ERNIE_EVAL_TRIAL_TOKEN).toBe('trial-test-only');
      } else expect(JSON.stringify(config)).toContain('trial-test-only');
      expect(JSON.stringify(config)).not.toContain('api.openai.com');
      expect(JSON.stringify(config)).not.toContain('openrouter.ai');
    }
    expect(() => baselineConfig('pi', 'https://openrouter.ai/api/v1', 'trial-test-only')).toThrow();
    expect(() => baselineConfig('pi', 'http://127.0.0.1:18080/v1', 'sk-or-real-key')).toThrow();
  });
  it('keeps native headless entrypoints and separate task/config mounts', () => {
    expect(baselineCommand('ernie')).toContain('/baseline/dist/cli/headless.js');
    expect(baselineCommand('ernie')).toContain('/task.txt');
    expect(baselineCommand('pi')).toContain('/baseline/packages/coding-agent/dist/cli.js');
    expect(baselineCommand('pi')).toContain('--print');
    expect(baselineCommand('pi').slice(baselineCommand('pi').indexOf('--mode'), baselineCommand('pi').indexOf('--mode')+2)).toEqual(['--mode','json']);
    expect(baselineCommand('dsh')).toContain('--json');
    // The pinned launcher forwards flags after the first app-only option.
    expect(baselineCommand('dsh').indexOf('--patch')).toBeLessThan(baselineCommand('dsh').indexOf('--json'));
    expect(baselineCommand('dsh')).toContain('/baseline/apps/cli/lib/bin.js');
    expect(baselineCommand('dsh')).not.toContain('/baseline/apps/cli/src/bin.ts');
    expect(baselineCommand('ernie', 'trial-test-only', 64000)).toContain('64000');
    expect(() => baselineCommand('ernie', 'trial-test-only', 123)).toThrow(/context/);
    expect(baselineCommand('dsh')).toContain('headless');
    expect(baselineCommand('dsh')).toContain('/config/dsh.patch.yml');
  });
});

it('enforces primary single-agent mode using the pinned DSH native plugin IDs', () => {
  const rows=baselineConfig('dsh','http://127.0.0.1:18080/v1','trial-test-only') as {id:string;disabled?:boolean;config?:any}[];
  expect(rows.find(row=>row.id==='subagent')?.config).toEqual({maxDepth:0});
  for(const id of ['tool-subagent','tool-subagent-fork','tool-subagent-control','tool-agent-team','tool-workflow'])expect(rows.find(row=>row.id===id)?.disabled,id).toBe(true);
  expect(rows.some(row=>row.id==='system-prompt')).toBe(false);
});
