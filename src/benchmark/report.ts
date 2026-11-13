import type { Trial } from './queue.js';

interface ReportInput {
  phase: 'formal' | 'development';
  trials: Trial[];
  bootstrap?: {
    provisional: boolean;
    comparisons: { comparison: string; pairedTasks: number; estimate: number | null; interval95: number[] | null }[];
  };
}

const HARNESSES = [['ernie', 'ERNIE'], ['dsh', 'DSH'], ['pi', 'Pi']] as const;
const CONTEXTS = [64000, 128000, 256000] as const;
const STATUSES: Trial['status'][] = ['pending', 'running', 'needs-reconciliation', 'awaiting-evaluation',
  'evaluating', 'resolved', 'unresolved', 'evaluation-incomplete', 'infrastructure-failed'];
const scored = (trial: Trial): boolean => trial.status === 'resolved' || trial.status === 'unresolved';
const count = (trials: Trial[], status: Trial['status']): number => trials.filter(trial => trial.status === status).length;
const percent = (numerator: number, denominator: number): string => `${(100 * numerator / denominator).toFixed(1)}%`;
const cell = (value: string | number): string => String(value).replaceAll('|', '&#124;').replace(/[\r\n]/g, ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function table(headers: string[], rows: (string | number)[][]): string {
  return [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(cell).join(' | ')} |`).join('\n');
}

// A complete design needs distinct trial IDs and every expected task/harness/repeat slot.
function completeDesign(trials: Trial[], development: boolean): boolean {
  const taskCount = development ? 6 : 24;
  const slots = development ? CONTEXTS.map(context => `ernie:${context}`)
    : HARNESSES.flatMap(([harness]) => [0, 1].map(repeat => `${harness}:${repeat}`));
  if (trials.length !== taskCount * slots.length || !trials.every(scored)
    || new Set(trials.map(trial => trial.id)).size !== trials.length) return false;
  const tasks = new Map<string, Set<string>>();
  for (const trial of trials) {
    const slot = `${trial.harness}:${development ? trial.contextLimit : trial.repeat}`;
    if (!slots.includes(slot)) return false;
    const present = tasks.get(trial.instanceId) ?? new Set<string>();
    if (present.has(slot)) return false;
    present.add(slot);
    tasks.set(trial.instanceId, present);
  }
  return tasks.size === taskCount && [...tasks.values()].every(present => present.size === slots.length);
}

function progressRow(label: string, trials: Trial[], planned: number): (string | number)[] {
  const resolved = count(trials, 'resolved'), unresolved = count(trials, 'unresolved');
  const evaluated = resolved + unresolved;
  const incomplete = count(trials, 'infrastructure-failed') + count(trials, 'evaluation-incomplete');
  const pending = count(trials, 'pending');
  return [label, planned, evaluated, resolved, unresolved, incomplete, pending,
    trials.length - evaluated - incomplete - pending, `${evaluated}/${planned} (${percent(evaluated, planned)})`,
    evaluated ? percent(resolved, evaluated) : '—（无已评分）'];
}
function usageRow(label: string, trials: Trial[]): (string | number)[] {
  return [label, ...(['calls', 'inputTokens', 'outputTokens', 'activeMs'] as const)
    .map(key => trials.reduce((total, trial) => total + trial.usage[key], 0))];
}

function pairedSection(bootstrap: ReportInput['bootstrap'], full: boolean): string {
  const lines = ['## 配对比较',
    '按任务聚类的配对 bootstrap：同一任务的两次重复先求平均，再重采样任务；10000 次，固定种子 20261112，95% 区间。estimate 与 interval95 以百分点展示，正值表示 ERNIE − 基线大于零。'];
  if (!bootstrap) return [...lines, '尚无配对结果；正式比较暂不排名。'].join('\n\n');
  lines.push(full ? '正式设计已全部评分，bootstrap.provisional=false；解读仍限于本适配子集。'
    : `暂定分析（bootstrap.provisional=${bootstrap.provisional}）；仅描述已完成配对，正式整体暂不排名。`);
  const point = (value: number | null): string => value !== null && Number.isFinite(value) ? (value * 100).toFixed(1) : '—';
  lines.push(table(['comparison', 'pairedTasks', 'estimate', 'interval95', '解读'], bootstrap.comparisons.map(comparison => {
    const { pairedTasks, estimate, interval95 } = comparison;
    const valid = Number.isInteger(pairedTasks) && pairedTasks > 0 && pairedTasks <= 24
      && estimate !== null && Number.isFinite(estimate) && Math.abs(estimate) <= 1
      && interval95?.length === 2 && interval95.every(value => Number.isFinite(value) && Math.abs(value) <= 1)
      && interval95[0]! <= interval95[1]!;
    const scope = '正式完整子集内';
    const interpretation = !full || pairedTasks !== 24 ? '暂定差异，等待完整正式评测'
      : !valid ? '配对证据不足或区间不可用'
      : interval95![0]! > 0 ? `${scope}观察到优势`
      : interval95![1]! < 0 ? `${scope}观察到退化` : `${scope}未观察到明确差异`;
    return [comparison.comparison, pairedTasks, point(estimate),
      valid ? `[${point(interval95![0]!)}, ${point(interval95![1]!)}]` : '—', interpretation];
  })));
  return lines.join('\n\n');
}

/** Pure presentation of queue accounting and supplied paired evidence; no I/O or context selection. */
export function renderReport({ phase, trials, bootstrap }: ReportInput): string {
  const development = phase === 'development';
  const complete = completeDesign(trials, development);
  const full = !development && complete && bootstrap?.provisional === false;
  const evaluated = trials.filter(scored).length, planned = development ? 18 : 144;
  const groups = development ? CONTEXTS.map(context => ({ label: `${context / 1000}K`,
    trials: trials.filter(trial => trial.harness === 'ernie' && trial.contextLimit === context) }))
    : HARNESSES.map(([harness, label]) => ({ label, trials: trials.filter(trial => trial.harness === harness) }));
  const lines = [
    `# ${development ? '开发集上下文比较' : '正式 Harness 比较'}报告`,
    `外部评分完成 ${evaluated}/${planned}；实际记录 ${trials.length} 条。模型：baidu/ernie-5.5-flash-preview:free。`,
    '## 进度与解题率',
    '已评分 = resolved + unresolved；已评分成功率 = resolved / 已评分，覆盖率 = 已评分 / 计划。未完成试次不进入成功率分母；缺少的记录也不虚记为 pending。',
    table([development ? '上下文' : 'Harness', '计划', '已评分', 'resolved', 'unresolved', '基础设施失败/评分未完成', 'pending',
      '处理中/待核对', '评分覆盖率', '已评分成功率'], groups.map(group => progressRow(group.label, group.trials, development ? 6 : 48))),
    table(['状态', '实际数量'], STATUSES.map(status => [status, count(trials, status)])),
    '## 实际累计用量',
    '计费调用包括重试和辅助调用；按所有实际状态累计。outputTokens 已含推理，不重复加算；activeMs 为账本活跃毫秒，排除配额与限速等待。',
    table(['Harness', '计费调用', 'inputTokens', 'outputTokens（含推理）', 'activeMs'],
      [...groups.map(group => usageRow(group.label, group.trials)), usageRow('合计', trials)]),
  ];
  lines.push('## 工具观测与轨迹覆盖',
    '按各 Harness 原生工具完成事件计数，记录其观测来源；不是统一的内部操作数量。覆盖不足时只显示已解析部分，未知不等于零。请求/响应及脱敏会话文件见各试次 trajectories 索引。',
    table([development?'上下文':'Harness','工具观测覆盖','已观测完成事件','已观测失败事件','模型轨迹覆盖'],groups.map(group=>{
      const known=group.trials.filter(trial=>trial.observation?.toolMetricsComplete);
      return [group.label,`${known.length}/${group.trials.length}`,known.length?known.reduce((sum,trial)=>sum+trial.observation!.toolCalls!,0):'—（未知）',known.length?known.reduce((sum,trial)=>sum+trial.observation!.toolFailures!,0):'—（未知）',`${group.trials.filter(trial=>trial.observation?.providerComplete).length}/${group.trials.length}`];
    })));
  if (development) {
    lines.push('## 开发集选择规则',
      '先比较完成率（resolved / 每档计划 6 个任务），再取总输入 inputTokens 较少者；仍相同则依次优先 128K、64K、256K。',
      complete ? '开发集 18/18 已完成外部评分；实际冻结配置以 tuning.json 及其 development-evidence.json 为准。'
        : '开发集尚未完成，所选上下文未冻结；暂不排名。');
  } else lines.push(pairedSection(bootstrap, full));
  lines.push('## 适用范围与证据',
    '本实验是适配子集：30 个资格验证通过的任务，分为 24 个正式任务和 6 个开发任务，来自 3 个 Python 仓库；0 GPU，用户态 CPython/venv 适配，非官方 Docker 运行，不能作为全量 SWE-bench 分数。',
    '整套 Harness 比较同时混杂原生提示词、工具、上下文管理与执行策略；差异无法归因于单个机制，结论限于本子集及冻结配置。',
    '原始记录：[results.csv](results.csv) · [results.jsonl](results.jsonl) · [dashboard.json](dashboard.json)。',
    `冻结溯源（以实际文件与哈希核验为准）：[manifest.json](../private/${phase}/manifest.json) · [artifacts.json](../private/formal/artifacts.json) · [tuning.json](../private/formal/tuning.json) · [development-evidence.json](../private/formal/development-evidence.json) · [provenance.json](../qualification/provenance.json) · [evaluation.md](../../docs/evaluation.md)。`,
  );
  return lines.join('\n\n') + '\n';
}

