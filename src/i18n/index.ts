import {dictionaries} from './dictionaries.js';
export {dictionaries} from './dictionaries.js';
export type Locale = 'zh-CN' | 'en';
export type TranslationParams = Record<string, string | number | boolean | null | undefined>;
export function resolveLocale(value: unknown): Locale {
  return typeof value === 'string' && /^en(?:[-_]|$)/i.test(value.trim()) ? 'en' : 'zh-CN';
}
// Small ICU message formatter: named interpolation, number, plural, selectordinal and select.
// Formatting always returns text; rendering/escaping is the caller's responsibility.
function format(message: string, locale: Locale, params: TranslationParams, pound?: number): string {
  let output = '';
  for (let i=0; i<message.length;) {
    if (message[i] !== '{') {output += message[i] === '#' && pound !== undefined ? new Intl.NumberFormat(locale).format(pound) : message[i]; i++; continue;}
    let depth=1, end=i+1;
    while (end<message.length && depth) {if(message[end]==='{') depth++; if(message[end]==='}') depth--; end++;}
    if (depth) {output += message.slice(i); break;}
    const raw=message.slice(i,end); const inside=raw.slice(1,-1); const match=/^\s*([\w.]+)\s*(?:,\s*(\w+)\s*(?:,([\s\S]*))?)?$/.exec(inside);
    if (!match) {output += raw; i=end; continue;}
    const [,name,type,options='']=match; const value=params[name];
    if (value===undefined || value===null) {output+=raw; i=end; continue;}
    if (!type) output+=String(value);
    else if (type==='number') output+=new Intl.NumberFormat(locale).format(Number(value));
    else if (type==='plural' || type==='selectordinal' || type==='select') {
      const choices: Record<string,string>={}; let cursor=0;
      while(cursor<options.length){const choice=/^\s*(=?[-\w.]+)\s*\{/.exec(options.slice(cursor));if(!choice)break;cursor+=choice[0].length;const start=cursor;let level=1;while(cursor<options.length&&level){if(options[cursor]==='{')level++;if(options[cursor]==='}')level--;cursor++;}choices[choice[1]]=options.slice(start,cursor-1);}
      const number=Number(value); const selected=type==='select' ? String(value) : choices[`=${number}`] !== undefined ? `=${number}` : new Intl.PluralRules(locale,{type:type==='selectordinal'?'ordinal':'cardinal'}).select(number);
      output+=format(choices[selected]??choices.other??raw,locale,params,type==='select'?pound:number);
    } else output+=raw;
    i=end;
  }
  return output;
}
export function translate(locale: Locale, key: string, params: TranslationParams = {}): string {
  return format(dictionaries[locale]?.[key] ?? dictionaries['zh-CN'][key] ?? key,locale,params);
}
