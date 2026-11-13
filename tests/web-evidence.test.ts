import {LocaleProvider} from '../web/src/Locale.js';
import {createElement} from 'react';
import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ModelContext, ModelEvidence} from '../web/src/ModelContext.js';
import {SuperAgent} from '../web/src/SuperAgent.js';
import {contextSnapshot} from '../web/src/workspaces.js';
const goal = {id:'p',title:'父目标',prompt:'task',workspace:'/project',status:'paused',contextLimit:64000,dependsOn:[],usage:{inputTokens:999999},evidence:[]} as never;
describe('model and supervisor evidence', () => {
  it('uses current request input rather than cumulative tokens and labels estimates', () => {
    const current = {...goal as object, context:{effectiveLimit:60000,requestInputTokens:12000,estimatedInputTokens:14000,remainingTokens:40000,responseReserve:8000,estimated:true,source:'request-estimate',compressionCount:2}} as never;
    expect(contextSnapshot(current)).toMatchObject({limit:60000,used:12000,remaining:40000});
    const html=renderToStaticMarkup(createElement(LocaleProvider, {children:createElement(ModelContext, {goal:current,capabilities:null})}));
    expect(html).toContain('估算'); expect(html).toContain('12,000');
  });
  it('renders unavailable metadata as unverified high only and pending comparisons distinctly', () => {
    const html = renderToStaticMarkup(createElement(LocaleProvider, {children:createElement(ModelContext, {goal,capabilities:null})}));
    expect(html).toContain('high'); expect(html).toContain('未返回'); expect(html).not.toContain('999,999');
    const evidence=renderToStaticMarkup(createElement(LocaleProvider,{children:createElement(ModelEvidence)}));
    expect(evidence).toContain('真实 smoke'); expect(evidence).toContain('144'); expect(evidence).toContain('独立比较'); expect(evidence).toContain('以实验页为准');
  });
  it('shows only persisted checkpoints and child relationships, without invented success', () => {
    const harness={goal,state:{goals:[goal]},thread:{events:[]},busy:'',connection:'ready'} as never;
    const html=renderToStaticMarkup(createElement(SuperAgent,{harness}));
    expect(html).toContain('暂无检查点'); expect(html).toContain('独立 Git worktree');
    expect(html).not.toContain('自动合并成功');
  });
  it('labels model plan checkpoints separately from independently verified acceptance', () => {
    const harness={goal,state:{goals:[goal]},thread:{events:[{seq:1,type:'plan.updated',data:{source:'model',revision:1,steps:[{id:'s1',title:'读取入口',status:'completed'}],checkpoints:[{id:'c1',title:'功能核验',status:'passed',evidence:'模型自行报告'}]}}]},busy:'',connection:'ready'} as never;
    const html=renderToStaticMarkup(createElement(SuperAgent,{harness}));
    expect(html).toContain('模型报告'); expect(html).toContain('独立验收');
    expect(html).toContain('读取入口'); expect(html).toContain('功能核验');
  });

  it('does not equate the configured high effort with a live-success record', () => {
    const html=renderToStaticMarkup(createElement(LocaleProvider, {children:createElement(ModelContext, {capabilities:{reasoning:{selected:'high',advertised:[],verified:[],reason:'No live-success record supplied.'}}})}));
    expect(html).toContain('当前配置'); expect(html).toContain('未提供实测成功记录');
    expect(html).not.toContain('唯一支持档位');
  });

  it('uses a Chinese capability explanation when the service returns English provenance', () => {
    const html=renderToStaticMarkup(createElement(LocaleProvider, {children:createElement(ModelContext, {capabilities:{status:'unavailable',reasoning:{selected:'high',verified:[],reason:'The current free route could not be confirmed; no live-success record was supplied.'}}})}));
    expect(html).toContain('免费路由'); expect(html).not.toContain('The current free route');
  });

});
