import {useLocale} from './Locale.js';
import type {Goal} from '../../src/contracts/index.js';
import type {ModelCapabilities} from './api.js';
import {contextSnapshot} from './workspaces.js';

function LocalizedModelContext({goal, capabilities}: {goal?: Goal | null; capabilities: ModelCapabilities | null}) {
  const {t, locale, number, date} = useLocale();
  const fmt = (value: unknown) => typeof value === 'number' ? number(value) : '—';

  const context = goal ? contextSnapshot(goal) : null;
  const reasoning = capabilities?.reasoning;
  const verified = reasoning?.verified?.includes('high');
  const historical=t(verified?'服务器提供了 high 的历史原生成功记录。':'服务器未提供原生实测成功记录。');
  const reason=capabilities?.status==='unavailable'?t('当前免费路由暂时无法确认。{p0}',{p0:historical}):t('{p0}其他推理档位须由路由明确公布，并经过单独实测后才能开放。',{p0:verified?historical:t('high 是当前配置，服务器尚未提供其原生实测成功记录。')});
  return <section className="model-context"><h3>{t("模型与当前上下文")}</h3><div className="model-route"><img src="/ernie-mark.svg" alt=""/><div><strong>ERNIE 5.5 Flash</strong><span>{t("Baidu · OpenRouter · 免费路由")}</span></div></div><label className="reasoning-field">{t("推理强度")}<select aria-label={t("推理强度")} value="high" disabled><option value="high">{t("high · 当前配置（仅开放此项）")}</option></select></label><div className="data-row"><span>{t("路由公布档位")}</span><strong>{reasoning?.advertised?.length ? reasoning.advertised.join(' / ') : t("未单独公布")}</strong></div><div className="data-row"><span>{t("原生实测记录")}</span><strong>{reasoning?.verified?.includes('high') ? t("high · 有历史记录") : t("未提供实测成功记录")}</strong></div><p className="muted-copy">{reason}</p>{capabilities?.status === 'unavailable' && <p className="muted-copy">{t("路由能力元数据暂不可用。")}</p>}<div className="data-row"><span>{t("路由公布窗口")}</span><strong>{capabilities?.contextLength ? `${fmt(capabilities.contextLength)} Token` : t("未返回")}</strong></div>{goal && !context && <p className="muted-copy">{t("此会话尚无当前请求统计；下次模型请求会显示输入、回复预留与剩余空间。")}</p>}{context && <><div className="data-row"><span>{t("当前有效上限")}</span><strong>{fmt(context.limit)}</strong></div><div className="data-row"><span>{t("本次请求输入")}{context.raw.estimated === true ? t(" · 估算") : ''}</span><strong>{fmt(context.used)}</strong></div><div className="data-row"><span>{t("回复预留")}</span><strong>{fmt(context.raw.responseReserve)}</strong></div><div className="data-row"><span>{t("当前剩余")}{context.raw.estimated === true ? t(" · 估算") : ''}</span><strong>{fmt(context.remaining)}</strong></div>{context.remaining !== undefined && !!context.limit && <meter aria-label={t("当前上下文剩余比例")} min={0} max={context.limit} value={Math.min(context.limit, context.remaining)}/>}<p className="muted-copy">{context.stale ? t("目标修订已改变，等待本次请求的上下文统计。") : context.used === undefined ? t("此会话尚未记录单次请求统计；下一次模型请求后会更新。") : context.raw.estimated === true ? t("当前请求使用 UTF-8 字节估算，不等于模型 tokenizer 的精确计数。") : t("本次请求输入采用服务端记录的 provider usage。")} {t("累计输入预算在下方单独统计。")}</p>{typeof context.raw.lastPromptTokens === 'number' && <div className="data-row"><span>{t("上次 provider 输入")}{context.raw.lastUsageEstimated === true ? t("（估算）") : ''}</span><strong>{fmt(context.raw.lastPromptTokens)}</strong></div>}<div className="data-row"><span>{t("上下文压缩次数")}</span><strong>{fmt(context.raw.compressionCount)}</strong></div>{typeof context.raw.lastCompressedAt === 'string' && <p className="muted-copy">{t("最近压缩：")}{new Date(context.raw.lastCompressedAt).toLocaleString(locale)}</p>}{Array.isArray(context.raw.retainedSummaryOutline) && <details className="summary-outline"><summary>{t("保留的摘要提纲")}</summary><ul>{context.raw.retainedSummaryOutline.filter(item => typeof item === 'string').map((item, index) => <li key={index}>{item as string}</li>)}</ul></details>}</>}</section>;
}
function LocalizedModelEvidence() {
  const {t, locale, number, date} = useLocale();

  return <section className="settings-card model-evidence"><div className="settings-section-heading"><div><h2>{t("模型验证与适配依据")}</h2><p>{t("分别记录真实基础闭环、参数对照与正式比较。")}</p></div></div><div className="evidence-grid"><div><span className="evidence-label verified">{t("真实 smoke · 已记录")}</span><h3>{t("三方基础闭环与 ERNIE 重启续接")}</h3><p>{t("2026-11-13：原生 ERNIE 修复代码并通过验收；服务关闭重开后继续同一会话，再次通过。两个阶段累计 7 次调用，预算与记录保持连续。")}</p><p>{t("证据：")}<code>docs/LIVE_VALIDATION.md</code>{t("。DSH 与 Pi 的基础文件编辑、外部测试闭环也已记录成功。三方冒烟均不构成性能排名。")}</p></div><div><span className="evidence-label pending">{t("独立比较 · 以实测为准")}</span><h3>{t("上下文与 144 次正式试验")}</h3><p>{t("比较 64K / 128K / 256K 活动上下文，并执行 144 次正式试验。当前完成进度、选定配置和逐项结果以实验页为准。")}</p><p>{t("论文和路由元数据提供设计依据；基础闭环与 high 档位不构成最优兼容性证据。比较结论应依据完成的正式试验。")}</p></div></div></section>;
}

export function ModelContext(props: Parameters<typeof LocalizedModelContext>[0]) {return <LocalizedModelContext {...props}/>;}
export function ModelEvidence() {return <LocalizedModelEvidence/>;}
