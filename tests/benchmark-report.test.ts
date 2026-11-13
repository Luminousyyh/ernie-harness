import { describe, expect, it } from 'vitest';
import type { Trial } from '../src/benchmark/queue.js';
import { renderReport } from '../src/benchmark/report.js';

const harnesses = ['ernie', 'dsh', 'pi'] as const;
const formalTrials = (status: Trial['status'] = 'pending'): Trial[] =>
  Array.from({ length: 24 }, (_, task) => harnesses.flatMap(harness => [0, 1].map(repeat => ({
    id: `${task}-${harness}-${repeat}`, instanceId: `task-${task}`, harness, repeat,
    block: `${task}:${repeat}`, status, infrastructureRestarts: 0,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, activeMs: 0 },
  })))).flat();
const developmentTrials = (): Trial[] => Array.from({ length: 6 }, (_, task) =>
  [64000, 128000, 256000].map((contextLimit, repeat) => ({
    id: `dev-${task}-${contextLimit}`, instanceId: `dev-${task}`, harness: 'ernie', repeat,
    contextLimit, block: `dev-${task}`, status: 'unresolved', infrastructureRestarts: 0,
    usage: { calls: 1, inputTokens: [100, 30, 70][repeat]!, outputTokens: 10, activeMs: 20 },
  } satisfies Trial))).flat();
const bootstrap = (interval95: number[] | null, provisional = false, pairedTasks = 24) => ({
  provisional, comparisons: [{ comparison: 'ernie-dsh', pairedTasks, estimate: interval95 ? (interval95[0]! + interval95[1]!) / 2 : null, interval95 }],
});

// Read semantic table columns; assertions do not depend on whitespace or a whole-report snapshot.
function table(report: string, column: string): Record<string, string>[] {
  const lines = report.split('\n');
  const cells = (line: string) => line.split('|').slice(1, -1).map(cell => cell.trim());
  const start = lines.findIndex(line => line.startsWith('|') && cells(line).includes(column));
  expect(start, `missing table column ${column}`).toBeGreaterThanOrEqual(0);
  const headers = cells(lines[start]!);
  const rows: Record<string, string>[] = [];
  for (let i = start + 2; lines[i]?.startsWith('|'); i++) {
    rows.push(Object.fromEntries(cells(lines[i]!).map((value, j) => [headers[j]!, value])));
  }
  return rows;
}
const harnessRow = (report: string, name: string) => table(report, '计划').find(row => row.Harness === name)!;
const costRow = (report: string, name: string) => table(report, '计费调用').find(row => row.Harness === name)!;
const comparisonRow = (report: string) => table(report, 'pairedTasks')[0]!;

describe('bounded Chinese benchmark report', () => {
  it('keeps pending trials out of the performance denominator and shows planned coverage', () => {
    const report = renderReport({ phase: 'formal', trials: formalTrials() });
    for (const name of ['ERNIE', 'DSH', 'Pi']) {
      const row = harnessRow(report, name);
      expect(row['计划']).toBe('48');
      expect(row['已评分']).toBe('0');
      expect(row.pending).toBe('48');
      expect(row['评分覆盖率']).toContain('0/48');
      expect(row['已评分成功率']).not.toContain('0%');
      expect(row['已评分成功率']).toMatch(/—|暂无|未评分/);
    }
    expect(report).toContain('暂不排名');
    expect(report).not.toContain('正式完整子集内观察到优势');
  });

  it('counts every real status and all charged usage, including unsuccessful and unfinished trials', () => {
    const trials = formalTrials();
    const statuses: Trial['status'][] = ['resolved', 'unresolved', 'infrastructure-failed', 'evaluation-incomplete',
      'running', 'needs-reconciliation', 'awaiting-evaluation', 'evaluating'];
    const ernie = trials.filter(trial => trial.harness === 'ernie');
    statuses.forEach((status, index) => {
      ernie[index]!.status = status;
      ernie[index]!.usage = { calls: index + 1, inputTokens: (index + 1) * 10, outputTokens: (index + 1) * 3, activeMs: (index + 1) * 7 };
    });
    const before = structuredClone(trials);
    const report = renderReport({ phase: 'formal', trials });
    const row = harnessRow(report, 'ERNIE');
    expect(row['已评分']).toBe('2');
    expect(row.resolved).toBe('1');
    expect(row.unresolved).toBe('1');
    expect(row['基础设施失败/评分未完成']).toBe('2');
    expect(row.pending).toBe('40');
    expect(row['处理中/待核对']).toBe('4');
    expect(row['评分覆盖率']).toContain('2/48');
    expect(row['已评分成功率']).toContain('50.0%');
    const statusCounts = table(report, '状态');
    for (const status of statuses) expect(statusCounts.find(row => row['状态'] === status)?.['实际数量']).toBe('1');
    expect(statusCounts.find(row => row['状态'] === 'pending')?.['实际数量']).toBe('136');
    for (const name of ['ERNIE', '合计']) {
      expect(costRow(report, name)).toMatchObject({ '计费调用': '36', inputTokens: '360', 'outputTokens（含推理）': '108', activeMs: '252' });
    }
    expect(report).toMatch(/重试.*辅助|辅助.*重试/);
    expect(trials).toEqual(before);
  });

  it('shows full positive paired evidence only after all 144 formal trials are externally scored', () => {
    const report = renderReport({ phase: 'formal', trials: formalTrials('resolved'), bootstrap: bootstrap([0.1, 0.4]) });
    const row = comparisonRow(report);
    expect(row.pairedTasks).toBe('24');
    expect(row.estimate).toContain('25.0');
    expect(row.interval95).toMatch(/10\.0.*40\.0/);
    expect(row['解读']).toContain('正式完整子集内观察到优势');
    expect(report).toContain('144/144');
    expect(report).toContain('10000');
    expect(report).toContain('20261112');
    expect(report).toMatch(/任务聚类.*配对|配对.*任务聚类/);
  });

  it.each([
    { interval: [0.2, 0.6], estimate: '40.0', bounds: ['20.0', '60.0'] },
    { interval: [-0.6, -0.2], estimate: '-40.0', bounds: ['-60.0', '-20.0'] },
  ])('withholds directional claims on partial trials with interval $interval', ({ interval, estimate, bounds }) => {
    const trials = formalTrials();
    trials.filter(trial => trial.instanceId === 'task-0').forEach(trial => { trial.status = 'resolved'; });
    const report = renderReport({ phase: 'formal', trials, bootstrap: bootstrap(interval, false, 1) });
    const row = comparisonRow(report);
    expect(row['解读']).toBe('暂定差异，等待完整正式评测');
    expect(row.pairedTasks).toBe('1');
    expect(row.estimate).toBe(estimate);
    for (const bound of bounds) expect(row.interval95).toContain(bound);
    expect(harnessRow(report, 'ERNIE')['评分覆盖率']).toContain('2/48');
    expect(report).toContain('暂不排名');
    expect(report).not.toMatch(/优势|退化/);
  });

  it.each([{ interval: [0.1, 0.4] }, { interval: [-0.4, -0.1] }])('withholds provisional directional claims with interval $interval even at 144/144', ({ interval }) => {
    const report = renderReport({ phase: 'formal', trials: formalTrials('resolved'), bootstrap: bootstrap(interval, true) });
    expect(comparisonRow(report)['解读']).toBe('暂定差异，等待完整正式评测');
    expect(report).toContain('144/144');
    expect(report).toContain('暂不排名');
    expect(report).not.toMatch(/优势|退化/);
  });

  it.each([{ interval: [0.1, 0.4] }, { interval: [-0.4, -0.1] }])('requires 24 paired tasks before interpreting interval $interval', ({ interval }) => {
    const report = renderReport({ phase: 'formal', trials: formalTrials('resolved'), bootstrap: bootstrap(interval, false, 23) });
    const row = comparisonRow(report);
    expect(row.pairedTasks).toBe('23');
    expect(row.interval95).not.toBe('—');
    expect(row['解读']).toBe('暂定差异，等待完整正式评测');
    expect(report).not.toMatch(/优势|退化/);
  });

  it('cannot mistake 144 repeated records for the full formal design', () => {
    const trials = formalTrials('resolved');
    trials[1] = structuredClone(trials[0]!);
    const report = renderReport({ phase: 'formal', trials, bootstrap: bootstrap([0.1, 0.4]) });
    expect(report).toContain('暂不排名');
    expect(report).not.toContain('正式完整子集内观察到优势');
  });

  it.each([
    [[-0.4, -0.1], '退化'],
    [[-0.1, 0.3], '未观察到明确差异'],
    [[0, 0.3], '未观察到明确差异'],
    [[-0.2, 0], '未观察到明确差异'],
    [[0, 0], '未观察到明确差异'],
  ] as const)('interprets interval %j by its bounds rather than the point estimate', (interval, interpretation) => {
    const report = renderReport({ phase: 'formal', trials: formalTrials('resolved'), bootstrap: bootstrap([...interval]) });
    const interpretationText = comparisonRow(report)['解读'];
    expect(interpretationText).toContain(interpretation);
    expect(interpretationText).not.toMatch(/等效|等价|相当|持平|观察到优势/);
  });

  it.each([{ interval: null }, { interval: [0.2] }, { interval: [0.4, 0.1] }, { interval: [NaN, 0.2] }])('withholds conclusions for missing or invalid intervals $interval', ({ interval }) => {
    const report = renderReport({ phase: 'formal', trials: formalTrials('resolved'), bootstrap: bootstrap(interval) });
    expect(comparisonRow(report)['解读']).toMatch(/不足|不可用/);
    expect(report).not.toContain('观察到优势');
  });

  it('reports development contexts, total input and the frozen selection rule without selecting on partial data', () => {
    const trials = developmentTrials();
    trials[0]!.status = 'pending';
    const report = renderReport({ phase: 'development', trials, bootstrap: bootstrap([0.1, 0.4]) });
    const rows = table(report, '计划');
    expect(rows.map(row => row['上下文'])).toEqual(['64K', '128K', '256K']);
    for (const row of rows) expect(row['计划']).toBe('6');
    expect(costRow(report, '64K').inputTokens).toBe('600');
    expect(costRow(report, '128K').inputTokens).toBe('180');
    expect(costRow(report, '256K').inputTokens).toBe('420');
    expect(costRow(report, '合计').inputTokens).toBe('1200');
    expect(report).toMatch(/完成率.*总输入.*128K.*64K.*256K/s);
    expect(report).toMatch(/尚未完成.*未冻结/);
    expect(report).not.toMatch(/已选(?:定|择)|胜出|正式完整子集内观察到优势/);
  });

  it('reports empty input as no observations, without fabricating pending trials or performance', () => {
    const report = renderReport({ phase: 'formal', trials: [] });
    expect(harnessRow(report, 'ERNIE').pending).toBe('0');
    expect(harnessRow(report, 'ERNIE')['评分覆盖率']).toContain('0/48');
    expect(harnessRow(report, 'ERNIE')['已评分成功率']).not.toContain('0%');
    expect(costRow(report, '合计')['计费调用']).toBe('0');
  });

  it('links portable artifacts and states the scope and mechanism confounding', () => {
    const report = renderReport({ phase: 'formal', trials: [] });
    for (const name of ['results.csv', 'results.jsonl', 'dashboard.json', 'manifest.json', 'artifacts.json', 'tuning.json', 'development-evidence.json', 'provenance.json']) {
      expect(report).toContain(`[${name}](`);
    }
    for (const match of report.matchAll(/\]\(([^)]+)\)/g)) {
      expect(match[1]).not.toMatch(/^[a-z]+:|^[/\\]|\\/i);
    }
    expect(report).toMatch(/30.*24.*6/s);
    expect(report).toMatch(/3.*Python/);
    expect(report).toMatch(/0 GPU/);
    expect(report).toContain('用户态');
    expect(report).toMatch(/非官方 Docker|不是官方 Docker/);
    expect(report).toMatch(/全量 SWE.*分数/);
    expect(report).toMatch(/整套 Harness.*(?:混杂|无法归因)/);
    expect(report).toContain('baidu/ernie-5.5-flash-preview:free');
  });
});


