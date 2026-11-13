// Rebuild checked-in static HTML; no client-side translation or external dependencies.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const root=new URL('../docs/',import.meta.url);
const base='https://luminousyyh.github.io/ernie-harness/';
const template=await readFile(new URL('site-content/home.zh.html',root),'utf8');
const translations=JSON.parse(await readFile(new URL('site-content/en.json',root),'utf8'));
const content=JSON.parse(await readFile(new URL('site-content/sections.json',root),'utf8'));
const check=process.argv.includes('--check');
for(const locale of ['zh','en']){
  const en=locale==='en';const strings=content[locale];
  let html=template;
  if(en){
    const translate=text=>{if(!(text in translations))throw Error(`Missing English translation: ${text}`);return translations[text];};
    html=html.replace(/>([^<>]*[\p{Script=Han}][^<>]*)</gu,(_,text)=>`>${translate(text)}<`)
      .replace(/((?:aria-label|alt|content|title)=")([^"]*[\p{Script=Han}][^"]*)(")/gu,(_,a,text,b)=>a+translate(text)+b)
      .replace('<html lang="zh-CN">','<html lang="en">').replace('content="zh_CN"','content="en_US"');
  }
  const canonical=base+(en?'en/':'');
  html=html.replace(`rel="canonical" href="${base}"`,`rel="canonical" href="${canonical}"`)
    .replace(`property="og:url" content="${base}"`,`property="og:url" content="${canonical}"`)
    .replace('v=20261113-scroll-1','v=20261113-bilingual-1').replace('v=20261113-scroll-1','v=20261113-bilingual-1')
    .replaceAll('site-assets/ernie-mark.svg','site-assets/harness-mark.svg');
  const alternate=`\n  <link rel="alternate" hreflang="zh-CN" href="${base}">\n  <link rel="alternate" hreflang="en" href="${base}en/">\n  <link rel="alternate" hreflang="x-default" href="${base}">\n  <meta property="og:locale:alternate" content="${en?'zh_CN':'en_US'}">`;
  html=html.replace('</head>',alternate+'\n</head>');
  const switchLink=`<a class="language-switch" href="${en?'../':'./en/'}#main" lang="${en?'zh-CN':'en'}" hreflang="${en?'zh-CN':'en'}" aria-label="${strings.skip}">${strings.language}</a>`;
  html=html.replace('<a class="nav-github"',`${switchLink}<a class="nav-github"`);
  html=html.replace('<section class="experience',`<aside class="publication-status wrap" role="note"><strong>${strings.status}</strong><p>${strings.statusText}</p><a href="#evidence">${en?'Inspect the evidence':'查看证据边界'} →</a></aside>\n  <section class="experience`);
  const nav=`<nav class="docs-nav" aria-label="${strings.nav}">${strings.sections.map(([id,,title])=>`<a href="#${id}">${title}</a>`).join('')}</nav>`;
  const sections=`<div class="docs-content wrap">${nav}${strings.sections.map(([id,label,title,body])=>`<section class="doc-section" id="${id}" aria-labelledby="${id}-title"><div data-reveal><p class="eyebrow">${label}</p><h2 id="${id}-title">${title}</h2></div><div class="doc-body" data-reveal>${body}</div></section>`).join('\n')}</div>`;
  html=html.replace('  <section class="faq',sections+'\n  <section class="faq');
  html=html.replace('</head>',`<noscript><style>html .preview-panel[hidden],html .flow-detail[hidden],html .mobile-nav[hidden]{display:block!important}html .preview-content,html .preview-shell,html .workbench,html .flow-board{height:auto;min-height:0;overflow:visible}html .preview-panel{position:relative;inset:auto;min-height:350px}html .preview-tabs,html .flow-tabs,html .mobile-toggle,html [data-copy]{display:none!important}html .mobile-nav{position:static;padding:12px 20px}html .flow-detail{position:relative;inset:auto;height:auto;min-height:0;overflow:visible;border-bottom:1px solid #293447;padding:24px}html .mobile-nav a{display:inline-block;margin:8px}</style></noscript>\n</head>`);
  // Replace old capability wording: configuration is not live evidence.
  if(!en)html=html.replaceAll('已验证档位','配置档位').replace('仅启用已验证的免费路由档位','当前配置档位；实测验证单独记录').replace('正式比较尚未开始，不发布性能排名。','正式比较尚未完成，不发布性能排名。');
  html=html.replace('https://github.com/Luminousyyh/ernie-harness#启动',`https://github.com/Luminousyyh/ernie-harness/blob/main/${en?'README.md#quick-start':'README.zh-CN.md#快速开始'}`);
  if(en)html=html.replaceAll('href="./site','href="../site').replaceAll('src="./site','src="../site');
  const path=en?'en/index.html':'index.html';
  if(check){const actual=await readFile(new URL(path,root),'utf8');if(actual!==html)throw Error(`${path} is stale; run node scripts/site-build.mjs`);}
  else {if(en)await mkdir(new URL('en/',root),{recursive:true});await writeFile(new URL(path,root),html);}
  console.log(`${check?'Checked':'Built'} ${path}`);
}
