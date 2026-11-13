import {ApprovalsPanel, ManifestPanel} from './MaturationViews.js';
import {useLocale} from './Locale.js';
import {ModelContext} from './ModelContext.js';
import {SuperAgent} from './SuperAgent.js';
import { useEffect, useState, type ReactNode } from 'react';
import { Activity, ArrowUpRight, Check, CheckCheck, ChevronRight, CircleHelp, Clock3, Code2, FileCode2, Folder, GitBranch, Info, ListChecks, Pause, Play, RefreshCw, Settings2, ShieldCheck, Square, Terminal, Wrench, X } from 'lucide-react';
import type { Goal, HarnessEvent } from '../../src/contracts/index.js';
import { api } from './api.js';
import { EmptyState, IconButton, Spinner, StatusBadge } from './components.js';
import { basename, errorMessage, formatNumber, formatTime, record } from './state.js';
import type { Harness } from './useHarness.js';

export function GoalControls({goal, harness}: {goal: Goal; harness: Harness}) {
  const {t, locale, number, date} = useLocale();

  const active = ['running', 'waiting-rate-limit'].includes(goal.status);
  const resumable = ['paused', 'waiting-input'].includes(goal.status);
  const startable = ['pending', 'failed'].includes(goal.status);
  const cancellable = ['pending', 'running', 'waiting-rate-limit', 'waiting-input', 'paused'].includes(goal.status);
  return <div className="goal-controls">{active && <button className="secondary-button" disabled={!!harness.busy} onClick={() => void harness.act(goal.id, 'pause')}><Pause size={14} />{t("暂停")}</button>}{(resumable || startable) && <button className="primary-button" disabled={!!harness.busy || !harness.state?.provider.configured || harness.connection !== 'ready'} onClick={() => void harness.act(goal.id, resumable ? 'resume' : 'start')}><Play size={14} />{resumable ? t("继续执行") : goal.status === 'failed' ? t("重新启动") : t("启动目标")}</button>}{cancellable && <IconButton label={t("取消目标")} disabled={!!harness.busy} onClick={() => void harness.act(goal.id, 'cancel')}><Square size={14} /></IconButton>}</div>;
}
const tabs = [{id: 'details', label: '详情', icon: Info}, {id: 'timeline', label: '执行', icon: Activity}, {id: 'diff', label: '变更', icon: GitBranch}, {id: 'terminal', label: '终端', icon: Terminal}] as const;
type Tab = typeof tabs[number]['id'];
export function Inspector({harness, onSettings, onClose, hidden=false}: {harness: Harness; onSettings: () => void; onClose: () => void; hidden?: boolean}) {
  const {t, locale, number, date} = useLocale();

  const [tab, setTab] = useState<Tab>('details');
  const {goal, thread} = harness;
  return <aside hidden={hidden} className="inspector" aria-label={t("目标检查器")}><header className="inspector-heading"><span><ListChecks size={16} />{t("工作上下文")}</span><IconButton label={t("关闭检查器")} onClick={onClose}><X size={15} /></IconButton></header><div className="inspector-tabs" role="tablist" aria-label={t("检查器视图")}>{tabs.map(({id, label, icon: Icon}, index) => <button type="button" role="tab" key={id} id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={event => {if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; setTab(tabs[next].id); document.getElementById(`tab-${tabs[next].id}`)?.focus();}}}><Icon size={14} />{t(label)}</button>)}</div><div className="inspector-content" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>{tab === 'details' && (goal ? <GoalDetails key={goal.id} goal={goal} harness={harness} /> : <EmptyDetails harness={harness} onSettings={onSettings} />)}{tab === 'timeline' && <Timeline events={thread?.events ?? []} />}{tab === 'diff' && <Diff goalId={goal?.id} revision={goal?.revision} eventSeq={thread?.events.filter(event => event.type === 'tool.completed' || event.type === 'run.completed').at(-1)?.seq ?? 0} />}{tab === 'terminal' && <TerminalOutput events={thread?.events ?? []} goal={goal} />}</div><footer className="inspector-footer"><ShieldCheck size={13} /><span>{t("执行记录保存在本地")}</span><span className={`tiny-dot ${harness.stream === 'live' && harness.connection === 'ready' ? 'green' : 'muted'}`} /></footer></aside>;
}
function DetailSection({title, children}: {title: string; children: ReactNode}) {
  const {t, locale, number, date} = useLocale();
return <section className="detail-section"><h3>{t(title)}</h3>{children}</section>;}
function EmptyDetails({harness, onSettings}: {harness: Harness; onSettings: () => void}) {
  const {t, locale, number, date} = useLocale();

  const {state, connection} = harness;
  return <><div className="context-illustration"><div className="context-orbit"><Folder size={27} strokeWidth={1.25} /><span className="orbit-spark"><SparkIcon /></span></div><h3>{t("为下一步，准备就绪")}</h3><p>{t("创建或选择一个目标，")}<br />{t("在这里查看执行的每一个细节。")}</p></div><DetailSection title={t("工作空间")}><div className="context-row"><span className="context-icon"><Folder size={16} /></span><div><strong>{state?.workspace ? basename(state.workspace) : t("尚未选择目录")}</strong><span className="path-text" title={state?.workspace}>{state?.workspace || t("创建目标时指定本地目录")}</span></div></div></DetailSection><DetailSection title={t("模型服务")}><div className="model-card"><div className="model-card-top"><span className="model-mark">E</span><div><strong>ERNIE 5.5 Flash</strong><span>{t('model.freeRoute')}</span></div><span className={`tiny-dot ${state?.provider.configured ? 'green' : 'muted'}`} /></div><div className="model-card-bottom"><span>{connection !== 'ready' ? t("等待本地服务") : ['mock', 'injected'].includes(state?.provider.mode ?? '') ? t("模拟模式 · 非真实模型") : state?.provider.configured ? t("服务已配置") : t("尚未配置模型服务")}</span><button type="button" aria-label={t("查看模型服务设置")} onClick={onSettings}><ArrowUpRight size={14} /></button></div></div></DetailSection><ModelContext capabilities={harness.capabilities}/><DetailSection title={t("从目标到结果")}><ol className="workflow-list"><li><span>01</span><div><strong>{t("明确你的目标")}</strong><p>{t("描述需求与验收条件")}</p></div></li><li><span>02</span><div><strong>{t("在项目中执行")}</strong><p>{t("读取、编辑代码并运行工具")}</p></div></li><li><span>03</span><div><strong>{t("验证每一次改变")}</strong><p>{t("查看差异与真实执行结果")}</p></div></li></ol></DetailSection><button className="inspector-help" onClick={onSettings}><CircleHelp size={15} /><span>{t("了解工作台设置")}</span><ChevronRight size={13} /></button></>;
}
function SparkIcon() {
  const {t, locale, number, date} = useLocale();
return <Code2 size={13} />;}
function GoalDetails({goal, harness}: {goal: Goal; harness: Harness}) {
  const {t, locale, number, date} = useLocale();

  const [note, setNote] = useState('');
  return <><DetailSection title={t("目标状态")}><div className="detail-status"><StatusBadge status={goal.status} /><span className="revision-pill">{t("修订")} {number(goal.revision)}</span></div><GoalControls goal={goal} harness={harness} /></DetailSection>{goal.status === 'needs-reconciliation' && <div className="reconcile-card" role="status"><ShieldCheck size={20} /><strong>{t("需要人工核对")}</strong><p>{t("上次执行的外部影响尚不确定。请检查文件和进程，确认实际结果后记录说明。核对完成后目标将暂停，需手动继续。")}</p><form onSubmit={async event => {event.preventDefault(); if (note.trim() && await harness.reconcile(goal.id, note.trim())) setNote('');}}><label htmlFor="reconcile-note">{t("核对记录")}</label><textarea id="reconcile-note" value={note} onChange={event => setNote(event.target.value)} placeholder={t("已检查哪些文件或进程，实际发生了什么…")} rows={4} required /><button className="primary-button" disabled={!note.trim() || !!harness.busy} type="submit"><Check size={14} />{t("记录核对结果")}</button></form></div>}<DetailSection title={t("工作目录")}><div className="workspace-detail"><Folder size={16} /><span>{goal.workspace}</span></div></DetailSection><ModelContext goal={goal} capabilities={harness.capabilities}/><ManifestPanel harness={harness}/><ApprovalsPanel harness={harness}/><SuperAgent harness={harness}/><DetailSection title={t("累计执行预算")}><BudgetBar label={t("模型调用")} used={goal.usage.calls} max={goal.budget.maxCalls} /><BudgetBar label={t("输入 Token")} used={goal.usage.inputTokens} max={goal.budget.maxInputTokens} /><BudgetBar label={t("输出 Token")} used={goal.usage.outputTokens} max={goal.budget.maxOutputTokens} /><div className="data-row"><span><Clock3 size={13} />{t("活跃时间")}</span><strong>{number(Math.round(goal.usage.activeMs / 1000))} {t("秒")}</strong></div><div className="data-row"><span>{t("执行模式")}</span><strong>{goal.supervised ? t("Super-Agent 持续目标") : t("普通对话")}</strong></div></DetailSection><DetailSection title={t("验收条件")}>{goal.acceptanceCommands.length ? <ul className="acceptance-list">{goal.acceptanceCommands.map((command, index) => <li key={index}><CheckCheck size={14} /><code>{command}</code></li>)}</ul> : <p className="muted-copy">{t("未设置验收命令。可编辑目标补充。")}</p>}</DetailSection>{goal.evidence.length > 0 && <DetailSection title={t("验证证据")}>{goal.evidence.map((item, index) => <details className="evidence-item" key={`${item.createdAt}-${index}`}><summary><span className={item.exitCode === 0 ? 'success-text' : 'danger-text'}>{item.exitCode === 0 ? <Check size={14} /> : <X size={14} />}</span><code>{item.command}</code></summary><div className="evidence-meta">{t("退出码")} {number(item.exitCode)} {t("· 修订")} {number(item.goalRevision)}</div><pre>{item.output || t("（命令无输出）")}</pre></details>)}</DetailSection>}<DetailSection title={t("目标标识")}><code className="goal-identifier">{goal.id}</code><p className="muted-copy">{t("更新于")} {new Date(goal.updatedAt).toLocaleString(locale)}</p></DetailSection></>;
}
function BudgetBar({label, used, max}: {label: string; used: number; max: number}) {
  const {t, locale, number, date} = useLocale();
return <div className="budget-item"><div><span>{t(label)}</span><span><strong>{formatNumber(used, locale)}</strong> / {formatNumber(max, locale)}</span></div><meter min={0} max={max || 1} value={used} aria-label={`${label}: ${used} / ${max}`} /></div>;}
const eventLabels: Record<string, string> = {'goal.created': '目标已创建', 'goal.updated': '目标状态更新', 'run.started': '开始执行', 'run.completed': '执行结束', 'run.failed': '执行失败', 'verification': '运行验证', 'context.compacted': '上下文已压缩', 'reconciliation': '已记录人工核对', 'tool.started': '调用工具', 'tool.completed': '工具执行完成'};
function Timeline({events}: {events: HarnessEvent[]}) {
  const {t, locale, number, date} = useLocale();

  const visible = events.filter(event => eventLabels[event.type] && event.type !== 'goal.updated' && event.type !== 'tool.completed');
  if (!visible.length) return <EmptyState icon={<Activity size={25} />} title={t("还没有执行记录")}><p>{t("工具调用与验证结果会按发生顺序显示在这里。")}</p></EmptyState>;
  return <div className="timeline"><div className="panel-caption">{t("来自当前目标的真实事件")}</div>{visible.map(event => {
    const data = record(event.data);
    const completion = event.type === 'tool.started' ? events.find(item => item.type === 'tool.completed' && record(item.data).id === data.id) : undefined;
    const result = record(record(completion?.data).result);
    return <details className={`timeline-item ${completion ? result.ok === false ? 'event-failed' : 'event-complete' : ''}`} key={event.seq}><summary><span className="timeline-node">{event.type.startsWith('tool.') ? <Wrench size={13} /> : event.type === 'run.completed' ? <Check size={13} /> : <Activity size={13} />}</span><span className="timeline-title"><strong>{event.type === 'tool.started' ? String(data.name || t("工具调用")) : t(eventLabels[event.type])}</strong><span>{formatTime(event.createdAt, locale)}{completion && ` · ${result.ok === false ? t("失败") : t("已完成")}`}</span></span><ChevronRight size={13} /></summary><div className="timeline-payload">{event.type === 'tool.started' ? <><span className="small-label">{t("输入参数")}</span><pre>{JSON.stringify(data.args ?? {}, null, 2)}</pre>{completion ? <><span className="small-label">{t("执行结果")}{typeof result.exitCode === 'number' ? t(" · 退出码 {p0}", {p0: result.exitCode}) : ''}</span><pre>{String(result.output ?? t("（无输出）"))}</pre></> : <p className="muted-copy">{t("尚未记录完成结果。")}</p>}</> : <pre>{JSON.stringify(event.data, null, 2)}</pre>}</div></details>;
  })}</div>;
}
function Diff({goalId, revision, eventSeq}: {goalId?: string; revision?: number; eventSeq: number}) {
  const {t, locale, number, date} = useLocale();

  const [diff, setDiff] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setDiff(''); setError('');
    if (!goalId) {setLoading(false); return;}
    setLoading(true);
    const timer = setTimeout(() => {void api.diff(goalId).then(result => {if (active) setDiff(result.diff);}).catch(cause => {if (active) setError(errorMessage(cause));}).finally(() => {if (active) setLoading(false);});}, 200);
    return () => {active = false; clearTimeout(timer);};
  }, [goalId, revision, eventSeq, retry]);
  if (loading) return <div className="panel-loading"><Spinner label={t("正在读取代码差异")} /></div>;
  if (error) return <div className="panel-error" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => setRetry(retry + 1)}><RefreshCw size={14} />{t("重试")}</button></div>;
  if (!diff) return <EmptyState icon={<FileCode2 size={25} />} title={goalId ? t("暂时没有代码差异") : t("选择一个目标查看变更")}><p>{t("工作目录中的 Git 差异将在这里显示。")}</p></EmptyState>;
  return <div className="diff-view"><div className="panel-caption">{t("工作目录 Git 差异")} <button aria-label={t("刷新代码差异")} onClick={() => setRetry(retry + 1)}><RefreshCw size={13} /></button></div><pre>{diff.split('\n').map((line, index) => <span className={`diff-line ${line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}`} key={index}><span className="diff-line-number">{index + 1}</span>{line || ' '}{'\n'}</span>)}</pre></div>;
}
function TerminalOutput({events, goal}: {events: HarnessEvent[]; goal: Goal | null}) {
  const {t, locale, number, date} = useLocale();

  const outputs = events.filter(event => event.type === 'tool.completed' && /exec|shell|terminal|command|process|run/i.test(String(record(event.data).name)));
  return <div className="terminal-panel"><div className="terminal-heading"><span><Terminal size={13} />{t("运行输出")}</span><span>{t("只读")}</span></div>{!outputs.length ? <EmptyState icon={<Terminal size={25} />} title={t("等待命令输出")}><p>{t("执行过的终端命令会在这里留下记录。")}</p></EmptyState> : <div className="terminal-scroll">{outputs.map(event => {
    const data = record(event.data); const result = record(data.result);
    const start = events.find(item => item.type === 'tool.started' && record(item.data).id === data.id);
    const args = record(record(start?.data).args);
    return <div className="terminal-entry" key={event.seq}><div className="terminal-command"><span>$</span>{String(args.command ?? args.cmd ?? data.name)}</div><pre>{String(result.output ?? '')}</pre><div className="terminal-exit">{formatTime(event.createdAt, locale)} · {typeof result.exitCode === 'number' ? t("退出码 {p0}", {p0: result.exitCode}) : result.ok ? t("已完成") : t("未成功")}{result.truncated === true && t(" · 输出已截断")}</div></div>;
  })}</div>}{goal && <div className="terminal-path">{goal.workspace}</div>}</div>;
}
