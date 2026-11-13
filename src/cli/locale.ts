import {translate,resolveLocale,type Locale} from '../i18n/index.js';
/** CLI-specific copy has explicit bilingual key/placeholder coverage in cli-maturation tests. */
export type CliLocale = Locale;
export const cliMessages = {
 'zh-CN': {
  user:'用户',assistant:'助手',tool:'工具',reasoning:'思考',ready:'就绪', connecting:'连接中', connected:'实时连接', reconnecting:'重新连接中', disconnected:'连接已断开',
  selected:'已选择目标 {id}', none:'未选择目标', goals:'目标', transcript:'对话与工具事件', workspace:'工作区', context:'上下文',
  noGoals:'暂无目标', noMessages:'暂无对话；输入目标开始，或使用 /select 继续。', busy:'正在提交…',
  hint:'Enter 发送 · Alt+Enter / Ctrl+J 换行 · Ctrl+P 命令 · Ctrl+G 目标 · Ctrl+W 工作区 · Ctrl+C 退出',
  composerNew:'新目标', composerReply:'继续当前目标', search:'搜索目标（标题、ID、内容）', palette:'命令面板',
  help:'帮助', quit:'退出界面；后台目标继续执行。', sent:'已交给后台服务。', loading:'正在加载…',
  invalidLanguage:'语言必须为 zh-CN 或 en。', invalidMode:'模式必须为 plan、standard 或 trusted。',
  missing:'缺少参数：{usage}', unknown:'未知命令：{command}', error:'请求未完成',
  mode:'模式', language:'语言', noWorkspace:'未找到工作区；请先使用 workspace add <路径>。',
  workspaceSelected:'已选择工作区 {name}', noSelection:'请先选择目标。', estimated:'估算', remaining:'剩余', calls:'调用',
  disconnectedHint:'按 /help 查看命令；界面会自动重新连接。', noMatch:'未找到匹配目标。',
  credentialsSaved:'已保存凭据。重启服务后生效。', secretPrompt:'OpenRouter API key（输入隐藏）: ',
  secretStdin:'请使用 --stdin 从标准输入读取凭据。', cancelled:'已取消', serverStarted:'ERNIE Harness 已启动：{url}',
  serviceNotice:'只监听本机。关闭界面不会取消目标；停止服务会暂停执行。', opened:'已打开 ERNIE Harness：{url}',
  interactiveRequired:'TUI 需要交互终端；可使用 run --json。', pending:'待启动', running:'执行中', paused:'已暂停',
  succeeded:'已完成', failed:'执行失败', 'waiting-input':'等待输入', 'waiting-rate-limit':'等待额度恢复',
  'needs-reconciliation':'待人工核对', noModelNetwork:'帮助和安装检查不调用模型。',
  memoryMissing:'未找到记忆 {id}', invalidResponse:'服务返回无效数据。', authFailed:'服务认证失败（HTTP {status}）。',
  requestFailed:'服务请求失败（HTTP {status}）。', startupFailed:'服务启动失败，请检查本地 service.log。',
 },
 en: {
  user:'User',assistant:'Assistant',tool:'Tool',reasoning:'Reasoning',ready:'Ready', connecting:'Connecting', connected:'Live', reconnecting:'Reconnecting', disconnected:'Disconnected',
  selected:'Selected goal {id}', none:'No goal selected', goals:'Goals', transcript:'Conversation and tool events', workspace:'Workspace', context:'Context',
  noGoals:'No goals yet', noMessages:'No messages yet. Enter a goal to start, or /select to continue.', busy:'Submitting…',
  hint:'Enter send · Alt+Enter / Ctrl+J newline · Ctrl+P commands · Ctrl+G goals · Ctrl+W workspaces · Ctrl+C quit',
  composerNew:'New goal', composerReply:'Continue selected goal', search:'Search goals (title, ID, prompt)', palette:'Command palette',
  help:'Help', quit:'Interface closed; background goals continue.', sent:'Submitted to the background service.', loading:'Loading…',
  invalidLanguage:'Language must be zh-CN or en.', invalidMode:'Mode must be plan, standard, or trusted.',
  missing:'Missing argument: {usage}', unknown:'Unknown command: {command}', error:'Request failed',
  mode:'Mode', language:'Language', noWorkspace:'No workspace found; use workspace add <path> first.',
  workspaceSelected:'Selected workspace {name}', noSelection:'Select a goal first.', estimated:'estimated', remaining:'remaining', calls:'calls',
  disconnectedHint:'Use /help for commands. The interface reconnects automatically.', noMatch:'No matching goals.',
  credentialsSaved:'Credential saved. Restart the service to use it.', secretPrompt:'OpenRouter API key (hidden): ',
  secretStdin:'Use --stdin to read the credential from standard input.', cancelled:'Cancelled', serverStarted:'ERNIE Harness started: {url}',
  serviceNotice:'Listening on loopback only. Closing the interface keeps goals running; stopping the service pauses execution.', opened:'Opened ERNIE Harness: {url}',
  interactiveRequired:'TUI requires an interactive terminal; use run --json.', pending:'Pending', running:'Running', paused:'Paused',
  succeeded:'Succeeded', failed:'Failed', 'waiting-input':'Waiting for input', 'waiting-rate-limit':'Waiting for quota',
  'needs-reconciliation':'Needs reconciliation', noModelNetwork:'Help and installation checks do not call the model.',
  memoryMissing:'Memory {id} was not found', invalidResponse:'The service returned invalid data.', authFailed:'Service authentication failed (HTTP {status}).',
  requestFailed:'Service request failed (HTTP {status}).', startupFailed:'Service startup failed; inspect local service.log.',
 },
} as const;
export type CliKey = keyof typeof cliMessages.en;
export function resolveCliLocale(value?:unknown):CliLocale {
 if(value===undefined||value===null||value==='')return 'zh-CN';
 if(value==='zh-CN'||value==='en')return resolveLocale(value);
 throw new Error(cliMessages.en.invalidLanguage);
}
export function cliText(locale:CliLocale,key:CliKey,params:Record<string,string|number>={}):string {
 const sharedKey='cli.'+key;const shared=translate(locale,sharedKey,params);if(shared!==sharedKey)return shared;
 return cliMessages[locale][key].replace(/\{(\w+)\}/g,(_match,name:string)=>String(params[name]??`{${name}}`));
}
export function statusLabel(locale:CliLocale,status:string):string {
 return status in cliMessages[locale]?cliText(locale,status as CliKey):status;
}
