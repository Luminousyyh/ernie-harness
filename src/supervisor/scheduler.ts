import {realpathSync} from 'node:fs';
import {initialMessages} from '../core/context.js';
import {StateError} from '../store/sqlite.js';
import type {EventBus, ToolRegistry, GoalScheduler, Goal} from '../contracts/index.js';
import type {SqliteStore} from '../store/sqlite.js';
import type {AgentEngine} from '../core/engine.js';

type ActiveRun = {
  controller: AbortController;
  promise: Promise<void>;
  workspace: string;
};

export class Supervisor implements GoalScheduler {
  private active = new Map<string, ActiveRun>();
  private snapshots = new Set<string>();
  private pumping = false;
  private stopping = false;

  constructor(
    private store: SqliteStore,
    private bus: EventBus,
    private engine: AgentEngine,
    private tools: ToolRegistry,
  ) {}

  async start(id: string): Promise<void> {
    const goal = this.require(id);
    if(this.snapshots.has(this.workspaceKey(goal.workspace)))throw new StateError('正在创建工作区快照，请稍后继续',409);
    if (goal.status === 'cancelled') throw new Error('Cancelled goals cannot restart');
    if (goal.status === 'succeeded') throw new Error('Goal already completed');
    if (goal.status === 'needs-reconciliation' || this.store.pendingTools(id).length) {
      throw new Error('请先核对未完成操作');
    }
    if (this.active.has(id)) return;
    this.store.enqueue(id);
    this.publishUpdate(id, {status: 'pending', error: undefined});
    this.schedulePump();
  }

  async wait(id: string): Promise<void> {
    while (this.store.queued().includes(id) || this.active.has(id)) {
      const active = this.active.get(id);
      if (active) await active.promise;
      else await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  private schedulePump(): void {
    void this.pump().catch(error => {
      // Per-goal failures are persisted below. A store failure must also be observed.
      console.error('Supervisor pump failed', error);
    });
  }

  private nextReady(): {id: string; workspace: string} | undefined {
    // Leave blocked outbox entries pending, but never let them hold up ready work.
    for (const id of new Set(this.store.queued())) {
      try {
        const goal = this.require(id);
        if(this.snapshots.has(this.workspaceKey(goal.workspace)))continue;
        if (goal.status !== 'pending' && goal.status !== 'waiting-input') {
          this.store.settleQueue(id);
          continue;
        }
        const intents = this.store.pendingTools(id);
        if (intents.length) {
          for (const intent of intents) this.store.markUncertain(intent.id);
          this.store.settleQueue(id);
          this.publishUpdate(id, {status: 'needs-reconciliation', error: '请先核对未完成操作'});
          continue;
        }
        const dependencies = goal.dependsOn.map(dependency => ({
          id: dependency,
          goal: this.store.getGoal(dependency),
        }));
        const failed = dependencies.filter(dependency =>
          dependency.goal?.status === 'failed' || dependency.goal?.status === 'cancelled',
        );
        if (failed.length) {
          const error = `依赖目标失败或已取消，需要处理后才能继续：${failed.map(dependency => `${dependency.id} (${dependency.goal!.status})`).join('、')}`;
          if (goal.status !== 'waiting-input' || goal.error !== error) {
            this.publishUpdate(id, {status: 'waiting-input', error});
          }
          continue;
        }
        if (goal.status === 'waiting-input') {
          this.publishUpdate(id, {status: 'pending', error: undefined});
        }
        if (dependencies.some(dependency => dependency.goal?.status !== 'succeeded')) continue;
        return {id, workspace: realpathSync(goal.workspace)};
      } catch (error) {
        this.recordFailure(id, error);
      }
    }
    return undefined;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      // Await every run, including its cleanup: only one model and workspace writer.
      while (!this.stopping && !this.active.size) {
        const next = this.nextReady();
        if (!next) return;
        const {id, workspace} = next;
        const controller = new AbortController();
        const promise = Promise.resolve()
          .then(() => this.engine.run(id, controller.signal))
          .catch(error => this.recordFailure(id, error, controller.signal.aborted))
          .finally(() => {
            this.active.delete(id);
            this.store.settleQueue(id);
          });
        this.active.set(id, {controller, promise, workspace});
        await promise;
      }
    } finally {
      this.pumping = false;
    }
  }

  private recordFailure(id: string, error: unknown, aborted = false): void {
    console.error('Supervisor goal failed', id, error);
    // Remove the job first so a bad path cannot repeatedly fail in the same pump.
    this.store.settleQueue(id);
    const goal = this.store.getGoal(id);
    const intents = this.store.pendingTools(id);
    for (const intent of intents) this.store.markUncertain(intent.id);
    const message = error instanceof Error ? error.message : String(error);
    if (goal && goal.status !== 'cancelled') {
      this.publishUpdate(id, {
        status: intents.length ? 'needs-reconciliation' : aborted ? 'paused' : 'failed',
        error: message,
      });
    }
    this.bus.publish(this.store.appendEvent(id, 'supervisor.failed', {error: message}));
  }

  async pause(id: string): Promise<void> {
    const goal = this.require(id);
    if (goal.status === 'cancelled' || goal.status === 'succeeded') {
      throw new Error('Terminal goal cannot pause');
    }
    this.store.settleQueue(id);
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Error('User paused'));
      await this.tools.cancelAll?.(id);
      await active.promise;
    }
    const current = this.require(id);
    if (current.status !== 'needs-reconciliation' && current.status !== 'cancelled') this.publishUpdate(id, {status: 'paused'});
    this.schedulePump();
  }

  async cancel(id: string): Promise<void> {
    this.require(id);
    this.store.settleQueue(id);
    this.publishUpdate(id, {status: 'cancelled'});
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Error('User cancelled'));
      await this.tools.cancelAll?.(id);
      await active.promise;
    }
    this.publishUpdate(id, {status: 'cancelled'});
    this.schedulePump();
  }

  async recover(): Promise<void> {
    for (const goal of this.store.listGoals()) {
      this.store.recoverActivity(goal.id);
      const intents = this.store.pendingTools(goal.id);
      if (goal.status === 'cancelled') {
        for (const intent of intents) this.store.markUncertain(intent.id);
        this.store.settleQueue(goal.id);
        continue;
      }
      if (goal.status === 'running' || intents.length) {
        for (const intent of intents) this.store.markUncertain(intent.id);
        this.store.settleQueue(goal.id);
        this.publishUpdate(goal.id, {
          status: intents.length ? 'needs-reconciliation' : 'paused',
          error: '服务中断后已恢复记录，请检查并继续。',
        });
      }
    }
    this.schedulePump();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const id of [...this.active.keys()]) await this.pause(id);
  }

  private workspaceKey(workspace:string):string {const value=realpathSync(workspace);return process.platform==='win32'?value.toLowerCase():value;}

  async withWorkspaceSnapshot<T>(workspace:string,action:()=>Promise<T>):Promise<T> {
    const key=this.workspaceKey(workspace);
    if(this.snapshots.has(key)||[...this.active.values()].some(run=>this.workspaceKey(run.workspace)===key))throw new StateError('工作区已有写入者，请先暂停',409);
    const queued=new Set(this.store.queued());
    if(this.store.listGoals().some(goal=>{
      let same=false;try{same=this.workspaceKey(goal.workspace)===key;}catch{return false;}
      return same&&(goal.status==='running'||queued.has(goal.id)||this.store.pendingTools(goal.id).length>0);
    }))throw new StateError('请先暂停同工作区任务并核对未完成操作',409);
    this.snapshots.add(key);
    try{return await action();}finally{this.snapshots.delete(key);this.schedulePump();}
  }

  async continueConversation(id:string,content:string):Promise<Goal> {
    const goal=this.require(id);
    if(this.snapshots.has(this.workspaceKey(goal.workspace)))throw new StateError('正在创建工作区快照，请稍后继续',409);
    if(this.active.has(id)||this.store.queued().includes(id)||['running','waiting-rate-limit','cancelled','needs-reconciliation'].includes(goal.status)||this.store.pendingTools(id).length)throw new StateError('请先暂停任务并核对未完成操作；已取消的对话不能继续',409);
    const initial=this.store.getMessages(id).length?[]:await initialMessages(goal);
    // Recheck after filesystem reads: a simultaneous start/input must not race.
    if(this.snapshots.has(this.workspaceKey(goal.workspace))||this.active.has(id)||this.require(id).revision!==goal.revision)throw new StateError('对话状态已变更，请重试',409);
    this.engine.prepareContinuation(id);
    const result=this.store.continueConversation(id,content,initial);
    for(const event of this.store.events(0,id).slice(-2))this.bus.publish(event);
    return result;
  }

  async revise(id: string, patch: Pick<Partial<Goal>, 'title' | 'prompt' | 'acceptanceCommands'>) {
    const goal = this.require(id);
    if (goal.status === 'cancelled') throw new Error('Cancelled goal is terminal');
    if (this.active.has(id)) await this.pause(id);
    const revised=this.store.reviseGoal(id,goal.revision,patch);
    const event=this.store.latestEvent(id);if(event)this.bus.publish(event);
    return revised;
  }

  reconcile(id: string, note: string) {
    const goal = this.require(id);
    if (goal.status !== 'needs-reconciliation') throw new Error('Goal does not require reconciliation');
    this.store.reconcile(id, note);
    return this.publishUpdate(id, {status: 'paused', error: undefined});
  }

  private require(id: string): Goal {
    const goal = this.store.getGoal(id);
    if (!goal) throw new Error('Goal not found');
    return goal;
  }

  private publishUpdate(id: string, patch: Partial<Goal>): Goal {
    const goal = this.store.updateGoal(id, patch);
    const event = this.store.latestEvent(id);
    if (event) this.bus.publish(event);
    return goal;
  }
}
