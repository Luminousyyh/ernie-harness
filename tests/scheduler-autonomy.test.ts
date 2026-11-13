import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import type {ModelTransport, ToolRegistry} from '../src/contracts/index.js';
import {AgentEngine} from '../src/core/engine.js';
import {LocalEventBus} from '../src/store/events.js';
import {SqliteStore} from '../src/store/sqlite.js';
import {Supervisor} from '../src/supervisor/scheduler.js';

const directories: string[] = [];
const stores: SqliteStore[] = [];
const supervisors: Supervisor[] = [];
const tools: ToolRegistry = {
  definitions: () => [],
  execute: async () => ({ok: true, output: 'passed', exitCode: 0}),
};

function fixture(persistent = false) {
  const workspace = mkdtempSync(join(tmpdir(), 'ernie-scheduler-'));
  directories.push(workspace);
  const path = persistent ? join(workspace, 'state.sqlite') : ':memory:';
  const open = () => {
    const store = new SqliteStore(path);
    stores.push(store);
    return store;
  };
  const store = open();
  const bus = new LocalEventBus();
  const calls: string[] = [];
  const model: ModelTransport = {
    async complete(request) {
      const prompt = request.messages.find(message => message.role === 'user')?.content ?? '';
      calls.push(prompt);
      if (prompt === 'fail') throw new Error('fake model failure');
      return {
        message: {role: 'assistant', content: 'done'},
        usage: {inputTokens: 1, outputTokens: 1, reasoningTokens: 0},
        model: 'fake',
        finishReason: 'stop',
      };
    },
  };
  const makeSupervisor = (current = store, transport = model, registry = tools) => {
    const supervisor = new Supervisor(current, bus, new AgentEngine(current, bus, transport, registry), registry);
    supervisors.push(supervisor);
    return supervisor;
  };
  return {workspace, store, bus, calls, model, makeSupervisor, open};
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.shutdown();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'ernie-scheduler-'))) {
      throw new Error('Unexpected temporary directory');
    }
    rmSync(directory, {recursive: true, force: true});
  }
  vi.restoreAllMocks();
});

describe('persistent autonomous dependency queue', () => {
  it('skips a blocked head without spinning and runs its prerequisite before the dependent', async () => {
    const {workspace, store, calls, makeSupervisor} = fixture();
    const prerequisite = store.createGoal({workspace, prompt: 'prerequisite'});
    const dependent = store.createGoal({workspace, prompt: 'dependent', dependsOn: [prerequisite.id]});
    const independent = store.createGoal({workspace, prompt: 'independent'});
    const supervisor = makeSupervisor();
    await supervisor.start(dependent.id);
    expect(store.getGoal(dependent.id)?.status).toBe('pending');
    const events = store.events().length;
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(calls).toEqual([]);
    expect(store.events()).toHaveLength(events);
    await supervisor.start(independent.id);
    await supervisor.wait(independent.id);
    await supervisor.start(prerequisite.id);
    await supervisor.wait(dependent.id);
    expect(calls).toEqual(['independent', 'prerequisite', 'dependent']);
    expect(store.getGoal(dependent.id)?.status).toBe('succeeded');
    expect(store.queued()).toEqual([]);
  });

  it('explains failed and cancelled dependencies, waits for missing dependencies, and removes paused jobs', async () => {
    const {workspace, store, calls, makeSupervisor} = fixture();
    const prerequisite = store.createGoal({workspace, prompt: 'fail'});
    const failedChild = store.createGoal({workspace, prompt: 'failed child', dependsOn: [prerequisite.id]});
    const cancelled = store.createGoal({workspace, prompt: 'cancelled'});
    const cancelledChild = store.createGoal({workspace, prompt: 'cancelled child', dependsOn: [cancelled.id]});
    const missing = store.createGoal({workspace, prompt: 'missing'});
    store.updateGoal(missing.id, {dependsOn: ['missing-dependency']});
    const supervisor = makeSupervisor();
    await supervisor.start(failedChild.id);
    await supervisor.start(cancelledChild.id);
    await supervisor.start(missing.id);
    await supervisor.cancel(cancelled.id);
    await supervisor.start(prerequisite.id);
    await supervisor.wait(prerequisite.id);
    for (const [child, dependency] of [[failedChild, prerequisite], [cancelledChild, cancelled]]) {
      expect(store.getGoal(child.id)?.status).toBe('waiting-input');
      expect(store.getGoal(child.id)?.error).toContain(dependency.id);
    }
    expect(store.getGoal(missing.id)?.status).toBe('pending');
    expect(calls).toEqual(['fail']);
    await supervisor.pause(missing.id);
    await supervisor.cancel(cancelledChild.id);
    expect(store.queued()).not.toContain(missing.id);
    expect(store.queued()).not.toContain(cancelledChild.id);
    await expect(supervisor.start(cancelledChild.id)).rejects.toThrow('Cancelled');
    await supervisor.revise(prerequisite.id, {prompt: 'repaired'});
    await supervisor.start(prerequisite.id);
    await supervisor.wait(failedChild.id);
    expect(calls).toEqual(['fail', 'repaired', 'failed child']);
    expect(store.getGoal(missing.id)?.status).toBe('paused');
  });

  it('recovers the persisted pending queue while pausing interrupted work and preserving uncertain cancellation', async () => {
    const {workspace, store, calls, makeSupervisor, open} = fixture(true);
    const prerequisite = store.createGoal({workspace, prompt: 'prerequisite'});
    const dependent = store.createGoal({workspace, prompt: 'dependent', dependsOn: [prerequisite.id]});
    const interrupted = store.createGoal({workspace, prompt: 'interrupted'});
    const cancelled = store.createGoal({workspace, prompt: 'cancelled'});
    for (const goal of [dependent, prerequisite, interrupted, cancelled]) store.enqueue(goal.id);
    store.updateGoal(interrupted.id, {status: 'running'});
    store.updateGoal(cancelled.id, {status: 'cancelled'});
    const intent = store.beginTool(cancelled.id, 1, 'write_file', {path: 'unknown'});
    store.close();
    const reopened = open();
    const supervisor = makeSupervisor(reopened);
    await supervisor.recover();
    await supervisor.wait(dependent.id);
    expect(calls).toEqual(['prerequisite', 'dependent']);
    expect(reopened.getGoal(interrupted.id)?.status).toBe('paused');
    expect(reopened.getGoal(cancelled.id)?.status).toBe('cancelled');
    expect(reopened.pendingTools(cancelled.id)).toEqual([expect.objectContaining({id: intent.id, status: 'uncertain'})]);
    expect(reopened.queued()).toEqual([]);
  });

  it('never resets an exhausted cumulative budget on revision, restart, or queue recovery', async () => {
    const {workspace, store, calls, makeSupervisor, open} = fixture(true);
    const goal = store.createGoal({workspace, prompt: 'fail', budget: {maxCalls: 1}});
    const supervisor = makeSupervisor();
    await supervisor.start(goal.id);
    await supervisor.wait(goal.id);
    const charged = store.getGoal(goal.id)!.usage;
    await supervisor.revise(goal.id, {prompt: 'revised', acceptanceCommands: ['verify']});
    expect(store.getGoal(goal.id)?.usage).toEqual(charged);
    await supervisor.start(goal.id);
    await supervisor.wait(goal.id);
    expect(calls).toEqual(['fail']);
    expect(store.getGoal(goal.id)?.usage.calls).toBe(1);
    store.updateGoal(goal.id, {status: 'pending'});
    store.enqueue(goal.id);
    store.close();
    const reopened = open();
    const recovered = makeSupervisor(reopened);
    await recovered.recover();
    await recovered.wait(goal.id);
    expect(calls).toEqual(['fail']);
    expect(reopened.getGoal(goal.id)?.status).toBe('failed');
    expect(reopened.getGoal(goal.id)?.usage.calls).toBe(1);
    expect(reopened.getGoal(goal.id)?.acceptanceCommands).toEqual(['verify']);
  });

  it('runs two queued jobs in one workspace serially and keeps model concurrency at one across workspaces', async () => {
    const {workspace, store, calls, model, makeSupervisor} = fixture();
    const other = fixture().workspace;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    let concurrent = 0;
    let maximum = 0;
    const transport: ModelTransport = {
      async complete(request, delta, signal) {
        concurrent++;
        maximum = Math.max(maximum, concurrent);
        try {
          if (request.messages.some(message => message.content === 'hold')) await gate;
          return await model.complete(request, delta, signal);
        } finally {
          concurrent--;
        }
      },
    };
    const supervisor = makeSupervisor(store, transport);
    const hold = store.createGoal({workspace: other, prompt: 'hold'});
    const first = store.createGoal({workspace, prompt: 'first'});
    const second = store.createGoal({workspace, prompt: 'second'});
    await supervisor.start(hold.id);
    await vi.waitFor(() => expect(concurrent).toBe(1));
    await supervisor.start(first.id);
    await supervisor.start(second.id);
    expect(store.getGoal(first.id)?.status).toBe('pending');
    expect(store.getGoal(second.id)?.status).toBe('pending');
    release();
    await supervisor.wait(second.id);
    expect(calls).toEqual(['hold', 'first', 'second']);
    expect(maximum).toBe(1);
  });

  it('persists scheduler failures and continues after invalid workspaces and rejected engine cleanup', async () => {
    const {workspace, store, calls, makeSupervisor} = fixture();
    const invalid = store.createGoal({workspace, prompt: 'invalid'});
    store.updateGoal(invalid.id, {workspace: join(workspace, 'does-not-exist')});
    const broken = store.createGoal({workspace, prompt: 'broken'});
    const healthy = store.createGoal({workspace, prompt: 'healthy'});
    const registry: ToolRegistry = {
      ...tools,
      async cancelAll(id) {
        if (id === broken.id) throw new Error('fake cleanup failure');
      },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supervisor = makeSupervisor(store, undefined, registry);
    for (const goal of [invalid, broken, healthy]) store.enqueue(goal.id);
    await supervisor.recover();
    await supervisor.wait(healthy.id);
    expect(store.getGoal(invalid.id)?.status).toBe('failed');
    expect(store.getGoal(broken.id)?.status).toBe('failed');
    expect(store.getGoal(broken.id)?.error).toContain('fake cleanup failure');
    expect(store.events().filter(event => event.type === 'supervisor.failed')).toHaveLength(2);
    expect(logged).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['broken', 'healthy']);
    expect(store.queued()).toEqual([]);
  });
});
