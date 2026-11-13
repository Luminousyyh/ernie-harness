import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {LocaleProvider, PreferenceQueue} from '../web/src/Locale.js';
import {Composer} from '../web/src/Composer.js';
import {Conversation} from '../web/src/Workbench.js';
import {Inspector} from '../web/src/Inspector.js';
import {SettingsView,GoalsView} from '../web/src/Views.js';
import {ExperienceView,ImprovementView,RecordStatus} from '../web/src/MaturationViews.js';
import type {Harness} from '../web/src/useHarness.js';
import type {Locale} from '../src/i18n/index.js';
const render=(node:ReactNode,locale:Locale='en')=>renderToStaticMarkup(createElement(LocaleProvider,{initialLocale:locale,children:node}));
const goal={id:'g',title:'Original goal title',prompt:'原文：不要翻译用户内容',workspace:'/project',status:'paused',revision:1,mode:'standard',acceptanceCommands:['pnpm test'],budget:{maxCalls:20,maxInputTokens:2000000,maxOutputTokens:128000,maxActiveMs:1800000,maxOutputPerCall:16384},usage:{calls:5,inputTokens:10000,outputTokens:100,activeMs:2000},evidence:[],dependsOn:[],supervised:true,contextLimit:64000,createdAt:'2026-11-13T00:00:00Z',updatedAt:'2026-11-13T00:00:00Z',manifest:{version:1,id:'manifest',contextSnapshot:'原始上下文'}};
const harness={goal,state:{goals:[goal],workspace:'/project',provider:{model:'baidu/ernie-5.5-flash-preview:free',configured:true,mode:'mock'},stats:{calls:5,inputTokens:10000,outputTokens:100},version:'fixture'},thread:{messages:[{role:'user',content:goal.prompt},{role:'assistant',content:'历史回复保持原文'}],events:[],draft:'流式输出原文',reasoning:'历史推理内容',loaded:true},connection:'ready',stream:'live',capabilities:null,busy:'',conversationDrafts:{g:'未发送的草稿'},setConversationDrafts:vi.fn(),setSelectedId:vi.fn()} as unknown as Harness;
describe('localized workbench render contracts',()=>{
 it('renders the composer in both locales with translated ARIA and unchanged input payloads',()=>{
  const props={workspace:'/project',initialPrompt:{text:'',key:0},disabled:false,busy:false,configured:true,onCreate:vi.fn()};
  const en=render(createElement(Composer,props));expect(en).toContain('aria-label="Create goal"');expect(en).toContain('Permission mode');expect(en).toContain('Trusted workspace');expect(en).not.toMatch(/[\u4e00-\u9fff]/);
  const zh=render(createElement(Composer,props),'zh-CN');expect(zh).toContain('aria-label="创建目标"');expect(zh).toContain('权限模式');expect(zh).toContain('/project');
 });
 it('keeps historical user/model/stream content in its original language while translating surrounding controls',()=>{
  const html=render(createElement(Conversation,{harness,onEdit:vi.fn()}));
  for(const original of [goal.prompt,'历史回复保持原文','流式输出原文','历史推理内容','未发送的草稿'])expect(html).toContain(original);
  expect(html).toContain('Goal conversation');expect(html).toContain('Reasoning');expect(html).toContain('Send and continue');expect(html).toContain('aria-label="Continue conversation"');
 });
 it('localizes inspector status, permissions, pending records, and model evidence without inventing validation',()=>{
  const html=render(createElement(Inspector,{harness,onSettings:vi.fn(),onClose:vi.fn()}));
  expect(html).toContain('Goal inspector');expect(html).toContain('Paused');expect(html).toContain('Permission mode');expect(html).toContain('Manifest &amp; context');expect(html).toContain('No live-success record supplied');expect(html).toContain('dsh-superagent');expect(html).toContain('No recorded wakes.');expect(html).toContain('No assignment');expect(html).toContain('No assessment records.');expect(html).toContain('原始上下文');expect(html.replaceAll('原始上下文','')).not.toMatch(/[\u4e00-\u9fff]/);expect(html).not.toContain('自动合并成功');
 });
 it('translates settings and goals including locale formatting, while preserving stored goal text',()=>{
  const settings=render(createElement(SettingsView,{harness,theme:'light',setTheme:vi.fn()}));expect(settings).toContain('Switch interface language');expect(settings).toContain('Free');expect(settings).toContain('144');expect(settings).not.toContain('独立比较');
  const goals=render(createElement(GoalsView,{harness,onSelect:vi.fn(),onNew:vi.fn()}));expect(goals).toContain('Original goal title');expect(goals).toContain(goal.prompt);expect(goals).toContain('Paused');expect(goals).toContain(new Date(goal.updatedAt).toLocaleDateString('en'));expect(goals).toContain('5');
 });
 it('shows translated offline empty states rather than fabricated rows',()=>{
  const offline={...harness,connection:'offline'} as Harness;
  expect(render(createElement(ExperienceView,{harness:offline,active:true}))).toContain('Connect to load experience');
  expect(render(createElement(ImprovementView,{harness:offline,active:true}))).toContain('Connect to load improvements');
  expect(render(createElement(RecordStatus,{status:'candidate'}))).toContain('Candidate');expect(render(createElement(RecordStatus,{status:'eligible'}))).toContain('Eligible for activation');expect(render(createElement(RecordStatus,{status:'applied'}))).toContain('Applied');expect(render(createElement(RecordStatus,{status:'applied',active:true}))).toContain('Active');
 });
 it('serializes preference mutations and continues after a failed write',async()=>{
  const writes:string[]=[];let release!:()=>void;const first=new Promise<void>(resolve=>{release=resolve;});
  const queue=new PreferenceQueue(async locale=>{writes.push(locale);if(writes.length===1){await first;throw new Error('offline');}});
  const initial=queue.enqueue('en').catch(()=>{});const final=queue.enqueue('zh-CN');await Promise.resolve();await Promise.resolve();expect(writes).toEqual(['en']);release();await initial;await final;expect(writes).toEqual(['en','zh-CN']);
 });
});
