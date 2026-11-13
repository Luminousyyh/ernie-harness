import {useLocale} from './Locale.js';
import {useState} from 'react';
import {Check, Folder, Pencil, Plus} from 'lucide-react';
import type {Harness} from './useHarness.js';
import {IconButton, Modal} from './components.js';
import {isAbsoluteDirectory, type WorkspaceEntry} from './workspaces.js';
export function WorkspacePicker({harness, onEdit}: {harness: Harness; onEdit: (entry: WorkspaceEntry | null) => void}) {
  const {t, locale, number, date} = useLocale();

  const entries = harness.state?.workspaces ?? [];
  return <div className="workspace-picker"><label htmlFor="active-workspace"><Folder size={14}/>{t("当前工作空间")}</label><div><select id="active-workspace" value={harness.state?.activeWorkspaceId ?? ''} disabled={!!harness.busy || !entries.length} onChange={event => void harness.selectWorkspace(event.target.value)}>{!entries.length && <option value="">{t("连接后读取目录")}</option>}{entries.map(item => <option key={item.id} value={item.id}>{item.name || item.path}</option>)}</select><IconButton label={t("编辑当前工作空间")} disabled={!harness.activeWorkspace?.id || !!harness.busy} onClick={() => onEdit(harness.activeWorkspace!)}><Pencil size={14}/></IconButton><IconButton label={t("添加工作空间")} disabled={harness.connection !== 'ready' || !!harness.busy} onClick={() => onEdit(null)}><Plus size={15}/></IconButton></div><span title={harness.activeWorkspace?.path}>{harness.activeWorkspace?.path ?? t("选择一个本地目录开始")}</span></div>;
}
export function WorkspaceDialog({entry, harness, onClose}: {entry: WorkspaceEntry | null; harness: Harness; onClose: () => void}) {
  const {t, locale, number, date} = useLocale();

  const [path, setPath] = useState(entry?.path ?? '');
  const [name, setName] = useState(entry?.name ?? '');
  const valid = isAbsoluteDirectory(path);
  return <Modal title={entry?.id ? t("编辑工作空间") : t("添加工作空间")} onClose={onClose}><form className="edit-form" onSubmit={async event => {event.preventDefault(); if (valid && await harness.saveWorkspace(entry?.id, {path: path.trim(), ...(name.trim() ? {name: name.trim()} : {})})) onClose();}}><p className="modal-description">{t("选择已存在的本地绝对目录。目录与名称由本地服务保存，重启后仍可使用。")}</p><label htmlFor="workspace-name">{t("名称")} <span>{t("可选")}</span></label><input id="workspace-name" value={name} onChange={event => setName(event.target.value)} maxLength={160} placeholder={t("例如：我的应用")}/><label htmlFor="workspace-path">{t("工作目录（绝对路径）")}</label><input id="workspace-path" value={path} onChange={event => setPath(event.target.value)} placeholder={t("D:\\my-project 或 /home/me/project")} required aria-invalid={path.length > 0 && !valid} aria-describedby="workspace-path-help"/><p id="workspace-path-help" className={path && !valid ? 'inline-error' : 'muted-copy'}>{path && !valid ? t("请输入绝对目录，例如 D:project 或 /home/me/project。") : t("服务端会检查目录是否存在以及是否重复。")}</p>{entry?.id && <p className="workspace-edit-note">{t("修改目录只影响之后的新会话。已有会话会继续使用创建时的目录。")}</p>}{harness.error && <p role="alert" className="inline-error">{t(harness.error)}</p>}<div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>{t("返回")}</button><button className="primary-button" type="submit" disabled={!valid || !!harness.busy}><Check size={15}/>{harness.busy === 'workspace' ? t("保存中…") : t("保存工作空间")}</button></div></form></Modal>;
}
