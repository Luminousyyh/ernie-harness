import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Beaker, Check, ChevronDown, ChevronRight, CircleHelp, Command, Folder, Keyboard, LayoutDashboard, Menu, MessageSquare, Moon, PanelLeftClose, PanelRight, Pencil, Plus, RefreshCw, Search, Settings, ShieldCheck, Sun, Target, WifiOff, X } from 'lucide-react';
import type { Goal } from '../../src/contracts/index.js';
import { useHarness, type Harness } from './useHarness.js';
import { IconButton, Modal, Spinner, StatusBadge } from './components.js';
import { basename, parseAcceptance, statusLabels } from './state.js';
import {WorkspacePicker, WorkspaceDialog} from './WorkspaceControls.js';
import {workspaceEntries, type WorkspaceEntry} from './workspaces.js';
import { Welcome, Conversation } from './Workbench.js';
import { GoalControls, Inspector } from './Inspector.js';
import { ExperimentsView, GoalsView, SettingsView, type Theme } from './Views.js';

type View = 'workbench' | 'goals' | 'experiments' | 'settings';
const navigation = [{id: 'workbench', label: '工作台', icon: LayoutDashboard}, {id: 'goals', label: '目标', icon: Target}, {id: 'experiments', label: '实验', icon: Beaker}, {id: 'settings', label: '设置', icon: Settings}] as const;
function readTheme(): Theme {try {const value = localStorage.getItem('ernie-theme'); return value === 'light' || value === 'dark' || value === 'system' ? value : 'light';} catch {return 'light';}}
export default function App() {
  const harness = useHarness();
  const [workspaceEditor, setWorkspaceEditor] = useState<WorkspaceEntry | null | undefined>(undefined);
  const [view, setView] = useState<View>('workbench');
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [resolvedTheme, setResolvedTheme] = useState('light');
  const [mobileSidebar, setMobileSidebar] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1100);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const newGoal = () => {harness.setDraftWorkspace(harness.activeWorkspace?.path ?? null); harness.setSelectedId(null); setView('workbench'); setSidebarOpen(false); requestAnimationFrame(() => document.getElementById('goal-prompt')?.focus());};
  const newForWorkspace = async (entry: WorkspaceEntry) => {if (entry.id && !await harness.selectWorkspace(entry.id)) return; harness.setDraftWorkspace(entry.path); harness.setSelectedId(null); setView('workbench'); setSidebarOpen(false); requestAnimationFrame(() => document.getElementById('goal-prompt')?.focus());};
  const selectGoal = (id: string) => {harness.setSelectedId(id); setView('workbench'); setSidebarOpen(false);};
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const update = () => setMobileSidebar(media.matches);
    media.addEventListener('change', update); update();
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {const result = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; document.documentElement.dataset.theme = result; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', result === 'dark' ? '#111823' : '#f7f9fc'); setResolvedTheme(result);};
    apply(); media.addEventListener('change', apply);
    try {localStorage.setItem('ernie-theme', theme);} catch { /* Private browsing may disable local storage. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {document.title = `${harness.goal && view === 'workbench' ? harness.goal.title : navigation.find(item => item.id === view)?.label} · ERNIE Harness`;}, [view, harness.goal?.title]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {setSidebarOpen(false); if (window.innerWidth < 1100) setInspectorOpen(false);}
      if (document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {event.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => searchRef.current?.focus());}
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') {event.preventDefault(); newGoal();}
      if (event.key === '?' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) {event.preventDefault(); setHelpOpen(true);}
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!sidebarOpen || !mobileSidebar) return;
    const element = sidebarRef.current; const previous = document.activeElement as HTMLElement | null;
    element?.querySelector<HTMLElement>('button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !element) return;
      const controls = [...element.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter(node => node.offsetParent !== null);
      if (event.shiftKey && document.activeElement === controls[0]) {event.preventDefault(); controls.at(-1)?.focus();}
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) {event.preventDefault(); controls[0]?.focus();}
    };
    document.addEventListener('keydown', trap); return () => {document.removeEventListener('keydown', trap); previous?.focus();};
  }, [sidebarOpen, mobileSidebar]);
  const goals = harness.state?.goals ?? [];
  const projects = workspaceEntries(harness.state);
  const projectPaths = projects.map(item => item.path);
  const isConnected = harness.connection === 'ready';
  return <div className={`app ${sidebarOpen ? 'sidebar-open' : ''} ${inspectorOpen && view === 'workbench' ? 'inspector-open' : ''}`}><a className="skip-link" href="#main-content">跳转到主要内容</a>{sidebarOpen && <button className="sidebar-backdrop" tabIndex={-1} aria-label="关闭侧边栏" onClick={() => setSidebarOpen(false)} />}<aside ref={sidebarRef} className="sidebar" aria-label="主导航" inert={mobileSidebar && !sidebarOpen} aria-hidden={mobileSidebar && !sidebarOpen ? true : undefined}><div className="brand"><button type="button" className="brand-link" onClick={newGoal} aria-label="ERNIE Harness 首页"><img src={resolvedTheme === 'dark' ? '/ernie-wordmark-dark.svg' : '/ernie-wordmark.svg'} alt="ERNIE Harness" /></button><IconButton className="mobile-close" label="关闭侧边栏" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={18} /></IconButton></div><button className="new-goal-button" aria-label="新建会话" onClick={newGoal}><Plus size={17} /><span>新建会话</span><span className="button-key">⇧ N</span></button><WorkspacePicker harness={harness} onEdit={entry => {harness.clearError(); setWorkspaceEditor(entry);}} /><nav className="main-navigation">{navigation.map(({id, label, icon: Icon}) => <button key={id} type="button" className={view === id ? 'nav-item active' : 'nav-item'} aria-current={view === id ? 'page' : undefined} onClick={() => {setView(id); setSidebarOpen(false);}}><Icon size={18} strokeWidth={1.75} /><span>{label}</span>{id === 'goals' && goals.length > 0 && <span className="nav-count">{goals.length}</span>}{view === id && <span className="nav-indicator" />}</button>)}</nav><div className="sidebar-divider" /><div className="sessions-heading"><span>项目与会话</span><IconButton label="搜索会话 (Ctrl+K)" onClick={() => searchRef.current?.focus()}><Search size={14} /></IconButton></div><div className="sidebar-search"><Search size={13} /><input ref={searchRef} aria-label="搜索项目与会话" placeholder="搜索…" value={search} onChange={event => setSearch(event.target.value)} /><kbd>⌘ K</kbd></div><div className="project-list">{projectPaths.map(path => {
    const projectGoals = goals.filter(goal => goal.workspace === path && `${goal.title} ${path}`.toLowerCase().includes(search.toLowerCase()));
    if (search && !projectGoals.length && !path.toLowerCase().includes(search.toLowerCase())) return null;
    const entry = projects.find(item => item.path === path)!;
    return <section className="project-group" key={path}><div className="project-row"><button className="project-heading" title={path} aria-expanded={!collapsed[path]} onClick={() => setCollapsed(current => ({...current, [path]: !current[path]}))}>{collapsed[path] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<Folder size={15} /><span>{entry.name}</span><span>{projectGoals.length}</span></button><IconButton label={`在 ${entry.name} 新建会话`} disabled={!!harness.busy || !isConnected} onClick={() => void newForWorkspace(entry)}><Plus size={14}/></IconButton><IconButton label={`编辑 ${entry.name} 工作空间`} disabled={!!harness.busy || !entry.id} onClick={() => {harness.clearError(); setWorkspaceEditor(entry);}}><Pencil size={12}/></IconButton></div>{!entry.id && <span className="historical-label">历史会话目录</span>}{!collapsed[path] && <div className="session-list">{projectGoals.length ? projectGoals.map(goal => <button className={`session-item ${goal.id === harness.selectedId && view === 'workbench' ? 'selected' : ''}`} key={goal.id} onClick={() => selectGoal(goal.id)} title={`${goal.title} · ${statusLabels[goal.status]}`}><span className={`session-status status-${goal.status}`} /><span>{goal.title}</span></button>) : <p className="project-empty">这个项目还没有目标</p>}</div>}</section>;
  })}{!projectPaths.length && <div className="sidebar-empty"><MessageSquare size={23} strokeWidth={1.2} /><p>{isConnected ? '还没有会话' : '会话将在连接后显示'}</p><span>你的每一个想法<br />都可以从一个目标开始</span></div>}{search && projectPaths.length > 0 && !projectPaths.some(path => path.toLowerCase().includes(search.toLowerCase()) || goals.some(goal => goal.workspace === path && goal.title.toLowerCase().includes(search.toLowerCase()))) && <p className="project-empty">未找到匹配的会话</p>}</div><div className="sidebar-bottom"><button className="sidebar-help" onClick={() => setHelpOpen(true)}><Keyboard size={16} /><span>快捷键</span><kbd>?</kbd></button><div className="local-service"><div className="local-service-icon"><Command size={17} /></div><div><strong>本地工作站</strong><span><i className={`tiny-dot ${isConnected ? 'green' : 'muted'}`} />{isConnected ? '服务已连接' : harness.connection === 'connecting' ? '正在连接' : harness.connection === 'auth' ? '等待认证' : '服务未连接'}</span></div><span className="local-only">LOCAL</span></div></div></aside><div className="app-body"><header className="topbar"><div className="topbar-start"><button ref={menuRef} className="icon-button mobile-menu" aria-label="打开侧边栏" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><span className="breadcrumb-root">工作空间</span><ChevronRight size={13} /><strong>{navigation.find(item => item.id === view)?.label}</strong>{harness.goal && view === 'workbench' && <><span className="breadcrumb-separator">/</span><span className="breadcrumb-goal">{harness.goal.title}</span></>}</div><div className="topbar-actions"><span className="local-running"><ShieldCheck size={13} />本地运行</span><span className="topbar-divider" /><IconButton label={resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>{resolvedTheme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</IconButton><IconButton label="快捷键帮助" onClick={() => setHelpOpen(true)}><CircleHelp size={17} /></IconButton>{view === 'workbench' && <IconButton label={inspectorOpen ? '隐藏检查器' : '显示检查器'} aria-pressed={inspectorOpen} className={inspectorOpen ? 'is-active' : ''} onClick={() => setInspectorOpen(!inspectorOpen)}><PanelRight size={17} /></IconButton>}</div></header><div className="content-layout"><main id="main-content" className="main-content" tabIndex={-1}><ConnectionNotice harness={harness} onSettings={() => setView('settings')} />{harness.error && harness.connection === 'ready' && <div className="error-banner" role="alert"><span>{harness.error}</span><IconButton label="关闭提示" onClick={harness.clearError}><X size={14} /></IconButton></div>}<section className="preserved-page workbench-page" hidden={view !== 'workbench'}><div className="preserved-conversation" hidden={!harness.selectedId}><div className="goal-subbar">{harness.goal ? <><StatusBadge status={harness.goal.status} /><span className="stream-state"><i className={`tiny-dot ${harness.stream === 'live' ? 'green' : 'muted'}`} />{harness.stream === 'live' ? '实时同步' : '正在重新连接'}</span><div className="goal-subbar-actions"><IconButton label="编辑目标" disabled={['running', 'waiting-rate-limit'].includes(harness.goal.status) || !!harness.busy} onClick={() => setEditing(true)}><Pencil size={15} /></IconButton><GoalControls goal={harness.goal} harness={harness} /></div></> : <Spinner label="读取目标" />}</div><Conversation harness={harness} onEdit={() => setEditing(true)} /></div><div className="preserved-welcome" hidden={!!harness.selectedId}><Welcome harness={harness} /></div></section><section className="preserved-page" hidden={view !== 'goals'}><GoalsView harness={harness} onNew={newGoal} onSelect={selectGoal} /></section><section className="preserved-page" hidden={view !== 'experiments'}><ExperimentsView connected={isConnected} /></section><section className="preserved-page" hidden={view !== 'settings'}><SettingsView harness={harness} theme={theme} setTheme={setTheme} /></section></main>{inspectorOpen && view === 'workbench' && <Inspector harness={harness} onSettings={() => setView('settings')} onClose={() => setInspectorOpen(false)} />}</div></div>{workspaceEditor !== undefined && <WorkspaceDialog entry={workspaceEditor} harness={harness} onClose={() => setWorkspaceEditor(undefined)} />}{helpOpen && <Modal title="让操作更顺手" onClose={() => setHelpOpen(false)}><p className="modal-description">在工作台中使用这些快捷键。</p><dl className="shortcut-list"><div><dt>搜索项目与会话</dt><dd><kbd>Ctrl / ⌘</kbd><kbd>K</kbd></dd></div><div><dt>新建目标</dt><dd><kbd>Ctrl / ⌘</kbd><kbd>Shift</kbd><kbd>N</kbd></dd></div><div><dt>创建并启动目标</dt><dd><kbd>Ctrl / ⌘</kbd><kbd>Enter</kbd></dd></div><div><dt>关闭弹窗与移动面板</dt><dd><kbd>Esc</kbd></dd></div></dl></Modal>}{editing && harness.goal && <EditGoal key={harness.goal.id} goal={harness.goal} harness={harness} onClose={() => setEditing(false)} />}</div>;
}
function ConnectionNotice({harness, onSettings}: {harness: Harness; onSettings: () => void}) {
  const [token, setToken] = useState('');
  if (harness.connection === 'connecting') return <div className="connection-notice connecting"><Spinner label="正在连接本地工作空间…" /></div>;
  if (harness.connection === 'auth') return <section className="auth-card" aria-label="连接本地服务"><div className="notice-icon"><ShieldCheck size={21} /></div><div className="auth-content"><h2>连接你的本地工作台</h2><p>打开服务终端给出的地址，或输入本地服务令牌。</p><form onSubmit={async event => {event.preventDefault(); const value = token.trim(); setToken(''); if (value) await harness.authenticate(value);}}><label className="sr-only" htmlFor="service-token">本地服务令牌</label><input id="service-token" type="password" autoComplete="off" placeholder="本地服务令牌（非模型 API Key）" value={token} onChange={event => setToken(event.target.value)} required /><button type="submit" className="primary-button" disabled={!token.trim() || harness.busy === 'auth'}>{harness.busy === 'auth' ? <Spinner label="连接中" /> : <>连接<ArrowRight size={14} /></>}</button></form>{harness.error && <p className="auth-error" role="alert">{harness.error}</p>}</div></section>;
  if (harness.connection === 'offline') return <div className="connection-notice offline"><span className="notice-icon"><WifiOff size={17} /></span><div><strong>工作台已就绪，等待本地服务</strong><p>在项目目录运行 <code>pnpm dev</code>，再打开终端给出的工作台地址。</p></div><button className="notice-action" onClick={() => void harness.retryConnection()}><RefreshCw size={13} />重试连接</button></div>;
  if (!harness.state?.provider.configured) return <div className="connection-notice setup"><span className="notice-icon"><ShieldCheck size={17} /></span><div><strong>连接成功，还需配置模型服务</strong><p>在本地设置 OPENROUTER_API_KEY 后重启服务，即可开始执行。</p></div><button className="notice-action" onClick={onSettings}>查看设置<ArrowRight size={13} /></button></div>;
  if (['mock', 'injected'].includes(harness.state.provider.mode)) return <div className="connection-notice setup"><ShieldCheck size={16} /><span>当前为模拟或注入模式，仅用于离线行为检查，不能作为真实模型验证结果。</span></div>;
  return null;
}
function EditGoal({goal, harness, onClose}: {goal: Goal; harness: Harness; onClose: () => void}) {
  const [title, setTitle] = useState(goal.title); const [prompt, setPrompt] = useState(goal.prompt); const [acceptance, setAcceptance] = useState(goal.acceptanceCommands.join('\n'));
  const active = ['running', 'waiting-rate-limit'].includes(goal.status);
  return <Modal title="调整目标" onClose={onClose}><form className="edit-form" onSubmit={async event => {event.preventDefault(); if (!active && await harness.edit(goal.id, {title: title.trim(), prompt: prompt.trim(), acceptanceCommands: parseAcceptance(acceptance)})) onClose();}}><p className="modal-description">当前为修订 {goal.revision}。保存后会创建新修订。</p><label htmlFor="edit-title">目标名称</label><input id="edit-title" value={title} onChange={event => setTitle(event.target.value)} required maxLength={160} /><label htmlFor="edit-prompt">目标描述</label><textarea id="edit-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} required rows={7} /><label htmlFor="edit-acceptance">验收命令 <span>可选 · 每行一条</span></label><textarea id="edit-acceptance" value={acceptance} onChange={event => setAcceptance(event.target.value)} rows={3} placeholder={'pnpm test\npnpm build'} />{active && <p className="inline-error">请先暂停执行，再修改目标。</p>}{harness.error && <p className="inline-error" role="alert">{harness.error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>返回</button><button type="submit" className="primary-button" disabled={!!harness.busy || !title.trim() || !prompt.trim() || active}><Check size={15} />保存修订</button></div></form></Modal>;
}

