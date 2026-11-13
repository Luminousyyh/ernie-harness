import {describe, expect, it, vi, afterEach} from 'vitest';
import {api} from '../web/src/api.js';
import {workspaceEntries, activeWorkspace, isAbsoluteDirectory, continuationBlock, contextSnapshot} from '../web/src/workspaces.js';
import type {ServiceState} from '../web/src/api.js';
const state = {workspace:'/new', activeWorkspaceId:'a', workspaces:[{id:'a',path:'/new',name:'Renamed',createdAt:'now'}], goals:[{id:'old',workspace:'/old'}]} as ServiceState;
afterEach(() => vi.unstubAllGlobals());
describe('workspace and conversation boundaries', () => {
  it('keeps historical goal paths after editing registration and resolves active directory', () => {
    expect(activeWorkspace(state)?.path).toBe('/new');
    expect(workspaceEntries(state).map(item => item.path)).toEqual(['/new','/old']);
    expect(workspaceEntries(state)[1].id).toBeUndefined();
  });
  it('supports an older service state without workspace extensions', () => {
    expect(activeWorkspace({workspace:'D:\\project',goals:[]} as unknown as ServiceState)?.path).toBe('D:\\project');
    expect(workspaceEntries(null)).toEqual([]);
  });
  it('accepts absolute Windows, UNC and POSIX paths while rejecting drive-relative input', () => {
    for (const path of ['D:\\my project','C:/code','\\\\server\\share','/tmp/project']) expect(isAbsoluteDirectory(path)).toBe(true);
    for (const path of ['relative','C:project','~/project','\\project','']) expect(isAbsoluteDirectory(path)).toBe(false);
  });
  it('blocks busy, cancelled and uncertain conversations with an explanatory reason', () => {
    for (const status of ['running','waiting-rate-limit','cancelled','needs-reconciliation']) expect(continuationBlock(status)).toBeTruthy();
    for (const status of ['succeeded','failed','pending','paused','waiting-input']) expect(continuationBlock(status)).toBe('');
  });
  it('posts continuation with explicit start and never retries a rejected write', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'busy'}),{status:409}));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.message('a/b','继续',true)).rejects.toMatchObject({status:409});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/goals/a%2Fb/messages',expect.objectContaining({method:'POST',body:JSON.stringify({content:'继续',start:true})}));
  });
  it('sends exact workspace edit and child-worktree requests', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}',{status:200})));
    vi.stubGlobal('fetch',fetcher);
    await api.editWorkspace('x',{path:'/updated',name:'新目录'});
    await api.selectWorkspace('x');
    await api.child('p',{prompt:'独立子任务',dependsOn:['q']});
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/workspaces/x','/api/workspaces/x/select','/api/goals/p/children']);
    expect(fetcher.mock.calls[0][1].method).toBe('PATCH');
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({prompt:'独立子任务',dependsOn:['q']});
  });
});
describe('current context truthfulness', () => {
  it('withholds current totals when the backend context belongs to an earlier revision', () => {
    const snapshot = contextSnapshot({revision:3,contextLimit:64000,context:{requestRevision:2,requestInputTokens:12000,remainingTokens:40000}} as never);
    expect(snapshot.used).toBeUndefined(); expect(snapshot.remaining).toBeUndefined();
  });
  it('does not interpret cumulative input usage as the current context', () => {
    const snapshot = contextSnapshot({contextLimit:32000,usage:{inputTokens:900000}} as never);
    expect(snapshot.used).toBeUndefined(); expect(snapshot.remaining).toBeUndefined();
  });
});
