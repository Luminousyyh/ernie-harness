import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, Bot, CheckCheck, CircleCheck, Code2, FileSearch, Pencil, Sparkles, User, Wrench } from 'lucide-react';
import type { Goal } from '../../src/contracts/index.js';
import { Markdown } from './Markdown.js';
import { CopyButton, Spinner } from './components.js';
import {FollowUp} from './FollowUp.js';
import { Composer } from './Composer.js';
import type { Harness } from './useHarness.js';

const ideas = [
  {icon: FileSearch, title: '理解一个项目', subtitle: '梳理架构，找到关键逻辑', prompt: '阅读当前项目，梳理目录结构、核心模块及数据流，解释如何启动和测试。先分析，不修改文件。', color: 'blue'},
  {icon: Wrench, title: '定位并修复问题', subtitle: '追踪根因，让测试重新通过', prompt: '检查当前项目中的失败测试，定位根因并修复。保留现有行为，执行相关测试验证修改。', color: 'purple'},
  {icon: Code2, title: '把想法变成代码', subtitle: '从明确的目标开始构建', prompt: '我想在当前项目实现一个功能：\n\n预期行为：\n\n验收方式：', color: 'teal'},
];
export function Welcome({harness}: {harness: Harness}) {
  const [suggestion, setSuggestion] = useState({text: '', key: 0});
  const {state, connection, create, busy} = harness;
  return <div className="welcome"><div className="welcome-inner"><div className="eyebrow"><span className="eyebrow-line" />想法从这里开始</div><div className="welcome-heading"><div className="hero-symbol"><img src="/ernie-mark.svg" alt="" /></div><h1>你的下一个想法，<br /><span>即刻开始构建。</span></h1></div><p className="welcome-description">把目标交给 ERNIE，让理解、编写与验证<br className="desktop-break" />在同一个工作空间里发生。</p><Composer workspace={harness.draftWorkspace ?? harness.activeWorkspace?.path ?? ''} initialPrompt={suggestion} disabled={connection !== 'ready'} busy={!!busy} configured={state?.provider.configured ?? false} onCreate={create} /><div className="composer-caption"><span><span className="tiny-dot" />ERNIE 5.5 Flash</span><span>本地工作空间 · 目标驱动 · 结果可验证</span></div><div className="ideas-heading"><span>从一个清晰的目标开始</span><span>任务灵感 <ArrowDown size={12} /></span></div><div className="idea-grid">{ideas.map(({icon: Icon, title, subtitle, prompt, color}) => <button type="button" className="idea-card" key={title} onClick={() => setSuggestion({text: prompt, key: Date.now()})}><span className={`idea-icon ${color}`}><Icon size={19} strokeWidth={1.65} /></span><span className="idea-title">{title}<ArrowRight size={14} /></span><span className="idea-subtitle">{subtitle}</span></button>)}</div><div className="welcome-note"><CheckCheck size={15} /><span>每一次执行都有迹可循，每一个结果都值得核验。</span></div></div><footer className="welcome-footer"><span>BUILT FOR THE WAY YOU BUILD.</span><span>ERNIE HARNESS</span></footer></div>;
}
export function Conversation({harness, onEdit}: {harness: Harness; onEdit: () => void}) {
  const {goal, thread} = harness;
  const scroll = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {if (atBottom) scroll.current?.scrollTo({top: scroll.current.scrollHeight, behavior: 'instant'});}, [thread?.messages.length, thread?.draft, thread?.reasoning, atBottom]);
  useEffect(() => {setAtBottom(true);}, [goal?.id]);
  if (!goal || !thread) return <div className="center-loading"><Spinner label="正在读取目标" /></div>;
  const messages = thread.messages.filter(message => (message.role === 'user' || message.role === 'assistant') && (message.content || message.tool_calls?.length));
  const hasPrompt = messages.some(message => message.role === 'user' && message.content === goal.prompt);
  const active = ['running', 'waiting-rate-limit'].includes(goal.status);
  return <div className="conversation"><div className="conversation-scroll" ref={scroll} onScroll={event => {const node = event.currentTarget; setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 100);}}><div className="conversation-inner"><div className="conversation-intro"><span className="eyebrow">目标会话</span><h1>{goal.title}</h1><p>修订 {goal.revision} <span>·</span> {new Date(goal.createdAt).toLocaleString('zh-CN')}</p></div>{!hasPrompt && <Message role="user" content={goal.prompt} />}{!thread.loaded && <div className="history-loading"><Spinner label="正在同步会话记录" /></div>}{messages.map((message, index) => <Message key={`${goal.id}-${index}`} role={message.role as 'user' | 'assistant'} content={message.content ?? ''} tools={message.tool_calls?.map(tool => tool.function.name)} />)}{thread.reasoning && <details className="reasoning-block"><summary><Sparkles size={14} />推理过程</summary><pre>{thread.reasoning}</pre></details>}{thread.draft && <Message role="assistant" content={thread.draft} streaming />}{active && !thread.draft && <div className="assistant-waiting"><span className="avatar assistant-avatar"><Bot size={17} /></span><Spinner label={goal.status === 'waiting-rate-limit' ? '等待服务额度恢复…' : 'ERNIE 正在处理目标…'} /></div>}{goal.status === 'succeeded' && <div className="completion-note"><CircleCheck size={18} /><div><strong>本次目标已完成</strong><span>{goal.evidence.length ? `已记录 ${goal.evidence.length} 条验证证据，可在右侧查看。` : '查看执行记录，了解本次完成情况。'}</span></div></div>}{goal.error && <div className="inline-error" role="alert">{goal.error}</div>}</div></div>{!atBottom && <button className="jump-bottom" onClick={() => {setAtBottom(true); scroll.current?.scrollTo({top: scroll.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});}}><ArrowDown size={14} />回到最新</button>}<FollowUp harness={harness}/><div className="conversation-bottom"><div><span className="small-label">目标持续保存</span><p>{active ? '执行过程中可暂停；修改目标前请先暂停执行。' : '调整目标与验收条件，再继续推进。'}</p></div><button className="secondary-button" disabled={active || !!harness.busy} onClick={onEdit}><Pencil size={14} />编辑目标</button></div></div>;
}
function Message({role, content, tools, streaming}: {role: 'user' | 'assistant'; content: string; tools?: string[]; streaming?: boolean}) {
  return <article className={`chat-message message-${role}`}><div className={`avatar ${role === 'assistant' ? 'assistant-avatar' : 'user-avatar'}`}>{role === 'assistant' ? <Bot size={17} /> : <User size={16} />}</div><div className="message-body"><div className="message-meta"><strong>{role === 'assistant' ? 'ERNIE' : '你'}</strong>{role === 'assistant' && <span>5.5 Flash</span>}{streaming && <span className="stream-label">正在输出<span className="stream-caret" /></span>}</div>{content && <Markdown text={content} />}{tools && <div className="message-tools">{tools.map((tool, index) => <span key={`${tool}-${index}`}><Wrench size={12} />{tool}</span>)}</div>}{content && !streaming && <div className="message-actions"><CopyButton text={content} label="复制内容" /></div>}</div></article>;
}
