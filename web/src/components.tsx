import {useLocale} from './Locale.js';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check, Copy, LoaderCircle, X } from 'lucide-react';
import type { Goal } from '../../src/contracts/index.js';
import { statusLabels } from './state.js';

export function IconButton({label, children, className = '', ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {label: string; children: ReactNode}) {
  const {t, locale, number, date} = useLocale();

  return <button type="button" className={`icon-button ${className}`} aria-label={t(label)} title={t(label)} {...props}>{children}</button>;
}
export function StatusBadge({status}: {status: Goal['status']}) {
  const {t, locale, number, date} = useLocale();

  return <span className={`status-badge status-${status}`}><span className="status-dot" />{t(statusLabels[status] ?? status)}</span>;
}
export function Spinner({label = '正在加载'}: {label?: string}) {
  const {t, locale, number, date} = useLocale();
 return <span className="loading-inline" role="status"><LoaderCircle size={16} className="spin" />{t(label)}</span>; }
export function CopyButton({text, label = '复制'}: {text: string; label?: string}) {
  const {t, locale, number, date} = useLocale();

  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className="copy-button" aria-label={copied ? t("已复制") : t(label)} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setError(false); timer.current = setTimeout(() => setCopied(false), 1800); }
    catch { setError(true); }
  }}>{copied ? <Check size={13} /> : <Copy size={13} />}<span role="status">{copied ? t("已复制") : error ? t("请手动复制") : t(label)}</span></button>;
}
export function Modal({title, children, onClose}: {title: string; children: ReactNode; onClose: () => void}) {
  const {t, locale, number, date} = useLocale();

  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => { ref.current?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="modal" aria-labelledby={id} onCancel={event => {event.preventDefault(); onClose();}} onClick={event => {if (event.target === event.currentTarget) onClose();}}>
    <div className="modal-inner"><header className="modal-header"><h2 id={id}>{title}</h2><IconButton label={t("关闭对话框")} onClick={onClose}><X size={18} /></IconButton></header>{children}</div>
  </dialog>;
}
export function EmptyState({icon, title, children}: {icon: ReactNode; title: string; children: ReactNode}) {
  const {t, locale, number, date} = useLocale();

  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{t(title)}</h3><div className="empty-description">{children}</div></div>;
}
