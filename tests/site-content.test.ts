import {describe, expect, it} from 'vitest';
import {readFile, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=(path:string)=>readFile(resolve(root,path),'utf8');
const ids=(html:string)=>[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
describe('bilingual static publication',()=>{
  it('publishes real Chinese and English documents with reciprocal metadata and anchors',async()=>{
    const zh=await read('docs/index.html'); const en=await read('docs/en/index.html');
    expect(zh).toContain('<html lang="zh-CN">');expect(en).toContain('<html lang="en">');
    for(const [html,canonical] of [[zh,'https://luminousyyh.github.io/ernie-harness/'],[en,'https://luminousyyh.github.io/ernie-harness/en/']]){
      expect(html).toContain(`rel="canonical" href="${canonical}"`);
      expect(html).toContain('hreflang="zh-CN" href="https://luminousyyh.github.io/ernie-harness/"');
      expect(html).toContain('hreflang="en" href="https://luminousyyh.github.io/ernie-harness/en/"');
      expect(html).toContain('hreflang="x-default"');expect(html).toContain('class="language-switch"');
      expect((html.match(/<h1\b/g)??[]).length).toBe(1);expect(new Set(ids(html)).size).toBe(ids(html).length);
      for(const match of html.matchAll(/href="#([^\"]+)"/g))expect(ids(html),`Missing #${match[1]}`).toContain(match[1]);
      for(const anchor of ['usage','architecture','learning','extensions','evidence','roadmap'])expect(ids(html)).toContain(anchor);
    }
    expect(ids(en).sort()).toEqual(ids(zh).sort());
    expect(en.replace(/<a class="language-switch"[^>]*>[\s\S]*?<\/a>/g,'').replace(/<[^>]*>/g,'')).not.toMatch(/[\p{Script=Han}]/u);
    expect(en).toMatch(/pending|not completed/i);expect(zh).toMatch(/待完成|尚未完成/);
  });
  it('keeps both languages readable without scripts and resources inside the Pages base',async()=>{
    for(const path of ['docs/index.html','docs/en/index.html']){
      const html=await read(path);expect(html).toContain('<noscript>');expect(html).toContain('id="install-command"');
      for(const match of html.matchAll(/(?:src|href)="([^"#?]+)(?:[?#][^"]*)?"/g)){
        if(/^(https?:|mailto:)/.test(match[1]))continue;
        expect(match[1]).not.toMatch(/^\//);
        await expect(stat(resolve(root,path,'..',match[1]))).resolves.toBeDefined();
      }
      expect(html).not.toMatch(/https?:\/\/(localhost|127\.0\.0\.1)/);
    }
    const map=await read('docs/sitemap.xml');expect(map).toContain('/ernie-harness/en/');
  });
  it('links both READMEs and labels examples and evidence honestly',async()=>{
    const en=await read('README.md');const zh=await read('README.zh-CN.md');
    expect(en).toContain('README.zh-CN.md');expect(zh).toContain('README.md');
    for(const html of [en,zh]){
      expect(html).toContain('baidu/ernie-5.5-flash-preview:free');expect(html).toContain('pnpm install --frozen-lockfile');
      expect(html).toContain('site-assets/workbench-demo.svg');expect(html).toContain('LICENSE');
      expect(html).not.toMatch(/passing-\d+|100%|production.ready|state.of.the.art/i);
    }
  });
  it('declares offline Windows/Linux checks without credentials or live calls',async()=>{
    const workflow=await read('.github/workflows/checks.yml');
    expect(workflow).toContain('ubuntu-latest');expect(workflow).toContain('windows-latest');
    for(const command of ['pnpm typecheck','pnpm test','pnpm build','site-qa.mjs','site-build.mjs --check','pnpm pack'])expect(workflow).toContain(command);
    expect(workflow).not.toContain('OPENROUTER_API_KEY');expect(workflow).not.toMatch(/secrets\./);
  });
});
