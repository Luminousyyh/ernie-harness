import {CheckpointPanel, SupervisorPanel} from './MaturationViews.js';
import {useLocale} from './Locale.js';
import {useState} from 'react';
import {GitBranch, Plus} from 'lucide-react';
import type {Harness} from './useHarness.js';
import {continuationBlock} from './workspaces.js';
import {Modal, StatusBadge} from './components.js';
import {parseAcceptance, record} from './state.js';
export function SuperAgent({harness}: {harness: Harness}) {
  const {t, locale, number, date} = useLocale();

  const [creating, setCreating] = useState(false);
  const goal = harness.goal;
  if (!goal) return null;
  const goals = harness.state?.goals ?? [];
  const children = goals.filter(item => item.parentId === goal.id);
  const parent = goals.find(item => item.id === goal.parentId);
  const checkpoints = (harness.thread?.events ?? []).filter(event => ['context.compacted', 'reconciliation', 'run.completed', 'verification', 'supervisor.checkpoint'].includes(event.type)).slice(-8).reverse();
  const plan = harness.thread?.events.filter(event => event.type === 'plan.updated').at(-1);
  const blocked = !!continuationBlock(goal.status) || !!harness.busy || harness.connection !== 'ready';
  return <section className="detail-section super-agent"><h3><GitBranch size={14}/>{t("Super-Agent 协作")}</h3>{parent && <button className="relationship-link" onClick={() => harness.setSelectedId(parent.id)}>{t("父目标 ·")} {parent.title}</button>}<h4>{t("依赖目标")}</h4>{goal.dependsOn.length ? goal.dependsOn.map(id => {const dependency = goals.find(item => item.id === id); return <button key={id} className="relationship-link" onClick={() => harness.setSelectedId(id)}><span>{dependency?.title ?? id}</span>{dependency && <StatusBadge status={dependency.status}/>}</button>;}) : <p className="muted-copy">{t("此目标未设置依赖。")}</p>}<h4>{t("子目标 ·")} {number(children.length)}</h4>{children.map(child => <div className="child-goal" key={child.id}><button className="relationship-link" onClick={() => harness.setSelectedId(child.id)}>{child.title}<StatusBadge status={child.status}/></button><span className="path-text">{child.workspace}</span><div className="child-actions">{['pending','paused','waiting-input','failed'].includes(child.status) && <button className="subtle-button" disabled={!!harness.busy || !harness.state?.provider.configured} onClick={() => void harness.act(child.id, ['paused','waiting-input'].includes(child.status) ? 'resume' : 'start')}>{t("启动子目标")}</button>}{['running','waiting-rate-limit'].includes(child.status) && <button className="subtle-button" disabled={!!harness.busy} onClick={() => void harness.act(child.id,'pause')}>{t("暂停子目标")}</button>}</div></div>)}<button className="secondary-button" disabled={blocked} onClick={() => {harness.clearError(); setCreating(true);}}><Plus size={13}/>{t("创建子目标")}</button><p className="muted-copy">{t("子目标使用独立 Git worktree；父目录须为干净的 Git 仓库根目录，最多 2 个子工作树。创建后手动启动，完成后检查差异。")}</p>{blocked && <p className="muted-copy">{t("先暂停执行并完成不确定操作的核对，再创建子目标。")}</p>}<CheckpointPanel harness={harness}/><SupervisorPanel harness={harness}/><h4>{t("执行检查点")}</h4>{checkpoints.length ? <ol className="checkpoint-list">{checkpoints.map(event => <li key={event.seq}><strong>{({'context.compacted':t("上下文已压缩"),reconciliation:t("人工核对记录"),'run.completed':t("本轮执行结束"),verification:t("验收记录"),'supervisor.checkpoint':t("监督器检查点")} as Record<string,string>)[event.type]}</strong><time>{new Date(event.createdAt).toLocaleString(locale)}</time><details><summary>{t("查看已记录内容")}</summary><pre>{JSON.stringify(event.data,null,2)}</pre></details></li>)}</ol> : <p className="muted-copy">{t("暂无检查点。执行或上下文压缩后显示服务记录。")}</p>}{plan && <RecordedPlan data={plan.data} revision={goal.revision}/>}{creating && <ChildDialog harness={harness} onClose={() => setCreating(false)}/>}</section>;
}
function ChildDialog({harness, onClose}: {harness: Harness; onClose: () => void}) {
  const {t, locale, number, date} = useLocale();

  const [prompt,setPrompt] = useState(''); const [acceptance,setAcceptance] = useState(''); const [dependencies,setDependencies] = useState<string[]>([]);
  return <Modal title={t("创建独立子目标")} onClose={onClose}><form className="edit-form" onSubmit={async event => {event.preventDefault(); if (prompt.trim() && harness.goal && await harness.createChild(harness.goal.id,{prompt:prompt.trim(),acceptanceCommands:parseAcceptance(acceptance),dependsOn:dependencies,supervised:true})) onClose();}}><p className="modal-description">{t("从父目录当前提交创建独立工作树。服务会检查仓库状态与工作树数量。")}</p><label htmlFor="child-prompt">{t("子目标描述")}</label><textarea id="child-prompt" required rows={4} value={prompt} onChange={event => setPrompt(event.target.value)}/><label htmlFor="child-acceptance">{t("验收命令 · 每行一条")}</label><textarea id="child-acceptance" rows={2} value={acceptance} onChange={event => setAcceptance(event.target.value)}/><fieldset className="dependency-options"><legend>{t("先完成的依赖 · 最多 20 项")}</legend>{(harness.state?.goals ?? []).filter(goal => goal.id !== harness.goal?.id).map(goal => <label key={goal.id}><input type="checkbox" checked={dependencies.includes(goal.id)} disabled={!dependencies.includes(goal.id) && dependencies.length >= 20} onChange={event => setDependencies(current => event.target.checked ? [...current,goal.id] : current.filter(id => id !== goal.id))}/><span>{goal.title}</span><StatusBadge status={goal.status}/></label>)}</fieldset>{harness.error && <p role="alert" className="inline-error">{t(harness.error)}</p>}<div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>{t("返回")}</button><button className="primary-button" type="submit" disabled={!prompt.trim() || !!harness.busy}>{t("创建工作树与子目标")}</button></div></form></Modal>;
}

function RecordedPlan({data, revision}: {data: unknown; revision: number}) {
  const {t, locale, number, date} = useLocale();

  const plan = record(data);
  const steps = Array.isArray(plan.steps) ? plan.steps.map(record) : [];
  const checkpoints = Array.isArray(plan.checkpoints) ? plan.checkpoints.map(record) : [];
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  const labels: Record<string,string> = {'pending':t("待处理"),'in-progress':t("进行中"),'completed':t("已完成"),'passed':t("报告通过"),'failed':t("报告失败")};
  return <div className="supervisor-plan"><h4>{t("监督器计划 · 模型报告")}</h4><p className="muted-copy">{t("计划与检查点由模型报告，独立验收结果请查看验证证据。")}{typeof plan.revision === 'number' && plan.revision !== revision ? t(" 此计划属于旧修订 {p0}。", {p0: plan.revision}) : ''}</p>{typeof plan.explanation === 'string' && <p className="muted-copy">{plan.explanation}</p>}<ol className="plan-steps">{steps.map((step,index) => <li key={text(step.id) || index}><span className={`plan-state plan-${text(step.status)}`}>{labels[text(step.status)] ?? text(step.status)}</span><span>{text(step.title)}</span></li>)}</ol>{checkpoints.length > 0 && <><h4>{t("计划检查点")}</h4>{checkpoints.map((checkpoint,index) => <details key={text(checkpoint.id)||index} className="plan-checkpoint"><summary><span className={`plan-state plan-${text(checkpoint.status)}`}>{labels[text(checkpoint.status)] ?? text(checkpoint.status)}</span>{text(checkpoint.title)}</summary><p>{text(checkpoint.evidence) || t("尚未记录模型说明。")}</p></details>)}</>}</div>;
}
