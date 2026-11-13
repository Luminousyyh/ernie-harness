import {readFileSync,readdirSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {dictionaries, resolveLocale, translate} from '../src/i18n/index.js';

describe('shared workbench localization', () => {
  it('defaults to Chinese, normalizes supported language tags, and rejects unsupported values', () => {
    expect(resolveLocale(undefined)).toBe('zh-CN');
    expect(resolveLocale('en-US')).toBe('en');
    expect(resolveLocale('EN')).toBe('en');
    expect(resolveLocale('zh-Hans')).toBe('zh-CN');
    expect(resolveLocale('fr')).toBe('zh-CN');
    expect(resolveLocale({locale:'en'})).toBe('zh-CN');
  });
  it('keeps all dictionary keys and ICU argument names in parity', () => {
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries['zh-CN']).sort());
    const argumentsOf = (value: string) => [...new Set([...value.matchAll(/\{\s*(\w+)\s*(?:[,}])/g)].map(match => match[1]))].sort();
    for (const [key, value] of Object.entries(dictionaries['zh-CN'])) {
      expect(dictionaries.en[key], key).toBeTruthy();
      expect(argumentsOf(dictionaries.en[key]), key).toEqual(argumentsOf(value));
    }
  });
  it('formats plural counts using the selected locale and does not consume unknown placeholders', () => {
    expect(translate('en', 'common.items', {count:1})).toBe('1 item');
    expect(translate('en', 'common.items', {count:2})).toBe('2 items');
    expect(translate('zh-CN', 'common.items', {count:2})).toBe('2 项');
    expect(translate('en', 'goal.revision', {revision:4})).toBe('Revision 4');
    expect(translate('en', 'goal.revision')).toContain('{revision}');
    expect(translate('en', 'unknown.key')).toBe('unknown.key');
  });
  it('leaves interpolation as plain text, including user-supplied markup', () => {
    expect(translate('en', 'workspace.newSession', {name:'<script>hello</script>'})).toBe('New session in <script>hello</script>');
  });
});

it('covers every literal React translation key',()=>{
  for(const file of readdirSync(new URL('../web/src/',import.meta.url)).filter(file=>file.endsWith('.tsx'))){
    const source=readFileSync(new URL('../web/src/'+file,import.meta.url),'utf8');
    for(const match of source.matchAll(/\bt\(\s*(['"])([^'"\n]+)\1\s*(?=[,)])/g)){
      const key=match[1]==='"'?JSON.parse('"'+match[2]+'"') as string:match[2];
      expect(dictionaries.en[key],file+': '+key).toBeDefined();
    }
  }
});
