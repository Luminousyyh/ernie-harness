import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {resolveLocale, translate, type Locale, type TranslationParams} from '../../src/i18n/index.js';
import {request} from './api.js';
export const LOCALE_STORAGE_KEY = 'ernie-locale';
export type LocaleTools = {locale: Locale; t: (key: string, params?: TranslationParams) => string; number: (value: number, options?: Intl.NumberFormatOptions) => string; date: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string; setLocale: (value: Locale) => void; refreshPreferences: () => Promise<void>; preferenceStatus: 'local' | 'saving' | 'saved' | 'error'};
const date = (locale: Locale, value: string | number | Date, options?: Intl.DateTimeFormatOptions) => {const time = new Date(value); return Number.isNaN(time.getTime()) ? '—' : new Intl.DateTimeFormat(locale, options ?? {dateStyle:'medium', timeStyle:'short'}).format(time);};
const defaultTools: LocaleTools = {locale:'zh-CN', t:(key,params)=>translate('zh-CN',key,params), number:(value,options)=>new Intl.NumberFormat('zh-CN',options).format(value), date:(value,options)=>date('zh-CN',value,options), setLocale:()=>{}, refreshPreferences:async()=>{}, preferenceStatus:'local'};
const LocaleContext = createContext<LocaleTools>(defaultTools);
export function useLocale() {return useContext(LocaleContext);}
export class PreferenceQueue {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly save: (locale: Locale) => Promise<unknown>) {}
  enqueue(locale: Locale): Promise<unknown> {const next=this.pending.catch(()=>{}).then(()=>this.save(locale)); this.pending=next; return next;}
}
function storedLocale(): string | null {try{return localStorage.getItem(LOCALE_STORAGE_KEY);}catch{return null;}}
export function LocaleProvider({children, initialLocale}: {children: ReactNode; initialLocale?: Locale}) {
  const [locale, updateLocale] = useState<Locale>(()=>initialLocale ?? resolveLocale(storedLocale()));
  const [preferenceStatus, setPreferenceStatus] = useState<LocaleTools['preferenceStatus']>('local');
  const localeRef=useRef(locale); const revision=useRef(0); const mounted=useRef(true);
  const queue=useRef<PreferenceQueue | null>(null);
  if(!queue.current)queue.current=new PreferenceQueue(value=>request('/preferences',{method:'PATCH',body:JSON.stringify({locale:value})}));
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{document.documentElement.lang=locale;},[locale]);
  const persist=useCallback(async(value: Locale, version: number)=>{setPreferenceStatus('saving');try{await queue.current!.enqueue(value);if(mounted.current&&revision.current===version)setPreferenceStatus('saved');}catch{if(mounted.current&&revision.current===version)setPreferenceStatus('error');}},[]);
  const setLocale=useCallback((value: Locale)=>{const next=resolveLocale(value);localeRef.current=next;revision.current++;updateLocale(next);try{localStorage.setItem(LOCALE_STORAGE_KEY,next);}catch{/* The in-memory choice remains usable. */}void persist(next,revision.current);},[persist]);
  const refreshPreferences=useCallback(async()=>{
    const version=revision.current;
    try{const result=await request<{locale?: unknown}>('/preferences');if(!mounted.current||revision.current!==version)return;
      const remote=typeof result.locale==='string' ? resolveLocale(result.locale) : undefined;const local=storedLocale();
      if(local!==null){if(remote!==localeRef.current)await persist(localeRef.current,version);else setPreferenceStatus('saved');}
      else if(remote){localeRef.current=remote;updateLocale(remote);try{localStorage.setItem(LOCALE_STORAGE_KEY,remote);}catch{}setPreferenceStatus('saved');}
    }catch{if(mounted.current&&revision.current===version)setPreferenceStatus('error');}
  },[persist]);
  const value=useMemo<LocaleTools>(()=>({locale,t:(key,params)=>translate(locale,key,params),number:(n,options)=>new Intl.NumberFormat(locale,options).format(n),date:(value,options)=>date(locale,value,options),setLocale,refreshPreferences,preferenceStatus}),[locale,setLocale,refreshPreferences,preferenceStatus]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
export function LocalePreferenceSync({connected}: {connected: boolean}) {const {refreshPreferences}=useLocale();useEffect(()=>{if(connected)void refreshPreferences();},[connected,refreshPreferences]);return null;}
export function LanguageSwitch({compact=false}: {compact?: boolean}) {
  const {locale,setLocale,t,preferenceStatus,refreshPreferences}=useLocale();
  return <div className={`language-control ${compact?'compact':''}`}><label htmlFor={compact?'locale-topbar':'locale-settings'}>{compact?'文 / A':t('language.title')}</label><select id={compact?'locale-topbar':'locale-settings'} aria-label={t('language.switch')} value={locale} onChange={event=>setLocale(resolveLocale(event.target.value))}><option value="zh-CN">简体中文</option><option value="en">English</option></select>{!compact&&<span className="preference-sync" role="status">{t(`language.${preferenceStatus}`)}{preferenceStatus==='error'&&<button type="button" className="subtle-button" onClick={()=>void refreshPreferences()}>{t('重试')}</button>}</span>}</div>;
}
