import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, CheckCheck, ChevronDown, Folder, Plus, Sparkles, X } from 'lucide-react';
import type { GoalInput } from '../../src/contracts/index.js';
import {useDraft} from './useDraft.js';
import { parseAcceptance } from './state.js';
import { IconButton, Spinner } from './components.js';

export function Composer({workspace: defaultWorkspace, initialPrompt, disabled, busy, configured, onCreate}: {
  workspace: string; initialPrompt: {text: string; key: number}; disabled: boolean; busy: boolean; configured: boolean;
  onCreate: (input: GoalInput) => Promise<boolean>;
}) {
  const workspace = defaultWorkspace;
  const [prompt, setPrompt] = useDraft(workspace, '');
  const [acceptance, setAcceptance] = useDraft(workspace, '');
  const [showAcceptance, setShowAcceptance] = useState(false);
  const [supervised, setSupervised] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {if (initialPrompt.text) {setPrompt(initialPrompt.text); textarea.current?.focus();}}, [initialPrompt]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !workspace.trim() || disabled || busy || !configured) return;
    if (await onCreate({prompt: prompt.trim(), workspace: workspace.trim(), acceptanceCommands: parseAcceptance(acceptance), supervised, reasoningEffort: 'high'})) {setPrompt(''); setAcceptance('');}
  }
  return <form className="composer" onSubmit={submit} aria-label="创建目标">
    <label className="sr-only" htmlFor="goal-prompt">描述你的目标</label>
    <textarea ref={textarea} id="goal-prompt" className="prompt-input" placeholder="描述你想实现的目标，让 ERNIE 帮你完成…" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {event.preventDefault(); event.currentTarget.form?.requestSubmit();}}} rows={4} required disabled={busy} />
    {showAcceptance && <div className="acceptance-input"><div className="field-heading"><label htmlFor="acceptance-commands"><CheckCheck size={14} />验收命令 <span>可选 · 每行一条</span></label><IconButton label="收起验收命令" onClick={() => setShowAcceptance(false)}><X size={14} /></IconButton></div><textarea id="acceptance-commands" placeholder={'例如：pnpm test\npnpm build'} value={acceptance} onChange={event => setAcceptance(event.target.value)} rows={3} disabled={busy} /><p>目标完成前，执行这些命令核验结果。</p></div>}
    <div className="composer-workspace"><Folder size={15} /><label className="sr-only" htmlFor="goal-workspace">工作目录（绝对路径）</label><input id="goal-workspace" placeholder="工作目录的绝对路径，如 D:\my-project" value={workspace} readOnly required disabled={busy} title="工作目录（绝对路径）" /><span className="local-label">本地目录</span></div>
    <div className="composer-toolbar"><div className="composer-tools"><button type="button" className={`subtle-button ${showAcceptance ? 'is-active' : ''}`} onClick={() => setShowAcceptance(!showAcceptance)} aria-expanded={showAcceptance}><Plus size={15} /><span>验收条件</span>{parseAcceptance(acceptance).length > 0 && <span className="small-count">{parseAcceptance(acceptance).length}</span>}</button><label className="mode-select"><Sparkles size={14} /><select aria-label="执行模式" value={supervised ? 'supervised' : 'single'} onChange={event => setSupervised(event.target.value === 'supervised')}><option value="supervised">Super-Agent 持续目标</option><option value="single">普通对话</option></select><ChevronDown size={12} /></label></div><div className="submit-group"><span className="submit-shortcut">Ctrl ↵</span><button className="send-button" type="submit" aria-label="创建并启动目标" disabled={disabled || busy || !configured || !prompt.trim() || !workspace.trim()} title={!configured ? '请先在本地配置模型服务' : '创建并启动目标'}>{busy ? <Spinner label="" /> : <ArrowUp size={20} />}</button></div></div>
  </form>;
}
