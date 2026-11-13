import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {startSiteServer} from './site-preview.mjs';
import {verifyScrollReveal,revealForScreenshot} from './site-reveal-qa.mjs';
const output=new URL('../artifacts/site-qa/',import.meta.url);
await mkdir(output,{recursive:true});
const edge=process.env.ERNIE_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const site=await startSiteServer();
const browser=await chromium.launch({headless:true,...(existsSync(edge)?{executablePath:edge}:{})});
const checks=[];const errors=[];const requests=[];
let language='zh-CN';
const pass=name=>{const text=`[${language}] ${name}`;checks.push(text);console.log('PASS '+text);};
try {
  for(const en of [false,true]){
    language=en?'en':'zh-CN';const url=site.url+(en?'en/':'');
    await verifyScrollReveal({browser,url,pass});
    const context=await browser.newContext({viewport:{width:1440,height:1050},deviceScaleFactor:1,permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    page.on('response',response=>{if(response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
    page.on('request',request=>requests.push(request.url()));
    assert.equal((await page.goto(url,{waitUntil:'networkidle'})).status(),200);
    assert.match(await page.title(),/ERNIE Harness/);
    assert.equal(await page.locator('h1').count(),1);
    assert.equal(await page.locator('html').getAttribute('lang'),language);
    assert.equal(await page.locator('.demo-label').textContent(),en?'Interactive demo · no model connection':'交互演示 · 不连接模型');
    const canonical=`https://luminousyyh.github.io/ernie-harness/${en?'en/':''}`;
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'),canonical);
    assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'),canonical);
    assert.equal(await page.locator('link[hreflang="zh-CN"]').getAttribute('href'),'https://luminousyyh.github.io/ernie-harness/');
    assert.equal(await page.locator('link[hreflang="en"]').getAttribute('href'),'https://luminousyyh.github.io/ernie-harness/en/');
    pass('real localized HTML, title, canonical, hreflang and demo label load without missing resources');
    const anchors=await page.locator('a[href^="#"]').evaluateAll(links=>links.map(link=>link.hash).filter(hash=>hash.length>1));
    for(const hash of anchors) assert.equal(await page.locator(hash).count(),1,hash);
    assert.equal(await page.locator('a[href*="localhost"],a[href*="127.0.0.1"]').count(),0);
    pass('all local navigation destinations exist; no localhost product links');
    for(const anchor of ['usage','architecture','learning','extensions','evidence','roadmap']){
      await page.goto(url+'#'+anchor,{waitUntil:'networkidle'});
      assert.equal(await page.locator('#'+anchor+' h2').isVisible(),true);
      assert.equal(await page.locator('#'+anchor+' .reveal-pending').count(),0);
    }
    await page.locator('.language-switch').click();
    assert.equal(new URL(page.url()).pathname,new URL(site.url).pathname+(en?'':'en/'));
    assert.equal(new URL(page.url()).hash,'#roadmap');
    assert.equal(await page.locator('html').getAttribute('lang'),en?'zh-CN':'en');
    await page.locator('.language-switch').click();assert.equal(new URL(page.url()).hash,'#roadmap');
    assert.equal(await page.locator('html').getAttribute('lang'),language);
    pass('all documentation deep links reveal their destination; language round trip preserves section and Pages base');
    const initialHeight=await page.locator('.workbench').evaluate(element=>element.offsetHeight);
    for(const mode of ['goal','context','code']) {
      await page.locator(`[data-preview="${mode}"]`).click();
      assert.equal(await page.locator(`#panel-${mode}`).isVisible(),true);
      assert.equal(await page.locator('.preview-panel:visible').count(),1);
      assert.equal(await page.locator('.workbench').evaluate(element=>element.offsetHeight),initialHeight);
    }
    pass('three product demos switch without page height shifts');
    await page.locator('#tab-code').focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-goal').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#tab-goal').evaluate(element=>element===document.activeElement),true);
    await page.keyboard.press('End');assert.equal(await page.locator('#panel-context').isVisible(),true);
    await page.keyboard.press('Home');assert.equal(await page.locator('#panel-code').isVisible(),true);
    pass('preview tabs support roving focus, arrows, Home and End');
    const flowHeight=await page.locator('.flow-board').evaluate(element=>element.offsetHeight);
    for(let index=0;index<4;index++) {
      await page.locator(`[data-flow="${index}"]`).click();
      assert.equal(await page.locator(`#flow-panel-${index}`).isVisible(),true);
      assert.equal(await page.locator('.flow-board').evaluate(element=>element.offsetHeight),flowHeight);
    }
    await page.locator('#flow-tab-3').press('Home');assert.equal(await page.locator('#flow-tab-0').getAttribute('aria-selected'),'true');
    pass('four Super-Agent explanations are accessible and keep stable layout');
    await page.locator('[data-copy]').click();
    await page.waitForFunction(english=>document.querySelector('.toast').textContent===(english?'Installation commands copied':'安装命令已复制'),en);
    assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/git clone https:\/\/github.com\/Luminousyyh\/ernie-harness.git/);
    pass('copy button writes exact clone/build/setup instructions with localized feedback');
    await page.evaluate(()=>{Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new Error('clipboard denied');}});});
    await page.locator('[data-copy]').click();
    assert.match(await page.locator('.toast').textContent(),en?/manually/:/手动复制/);
    assert.match(await page.evaluate(()=>window.getSelection().toString()),/pnpm cli setup/);
    pass('clipboard denial selects commands and reports manual-copy fallback');
    await page.locator('.faq-list summary').first().click();assert.equal(await page.locator('.faq-list details').first().getAttribute('open'),'');
    await page.locator('.faq-list summary').first().click();pass('FAQ expands and collapses with native details');
    assert.match(await page.locator('.benchmark-stats').textContent(),en?/November 13, 2026/:/2026.11.13/);
    assert.match(await page.locator('.benchmark').textContent(),en?/no performance ranking/:/不发布性能排名/);
    assert.match(await page.locator('.site-footer').textContent(),en?/no affiliation/:/无隶属关系/);
    assert.match(await page.locator('.publication-status').textContent(),en?/pending/:/待完成/);
    pass('dated research snapshot, pending live status and independent-project notice remain explicit');
    await revealForScreenshot(page);
    await page.screenshot({path:fileURLToPath(new URL(en?'desktop-en.png':'desktop.png',output)),fullPage:true,animations:'disabled'});
    for(const width of [1440,1024,768,390,320]) {
      await page.setViewportSize({width,height:900});
      for(const mode of ['code','goal','context']) {
        await page.locator(`[data-preview="${mode}"]`).click();
        const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));
        assert.ok(sizes.scroll<=sizes.viewport+1,`overflow at ${language}/${width}/${mode}: ${JSON.stringify(sizes)}`);
      }
      pass(`no horizontal page overflow at ${width}px, for all previews`);
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('.mobile-toggle').click();assert.equal(await page.locator('#mobile-nav').isVisible(),true);
    assert.equal(await page.locator('.mobile-toggle').getAttribute('aria-label'),en?'Close navigation':'收起导航');
    await page.keyboard.press('Escape');assert.equal(await page.locator('#mobile-nav').isVisible(),false);
    assert.equal(await page.locator('.mobile-toggle').evaluate(element=>element===document.activeElement),true);
    await page.locator('.mobile-toggle').click();await page.locator('#mobile-nav a[href="#quickstart"]').click();
    assert.equal(await page.locator('#mobile-nav').isVisible(),false);
    pass('mobile menu supports localized labels, Escape, focus return and navigation closure');
    await page.locator('#tab-code').click();await revealForScreenshot(page);
    await page.screenshot({path:fileURLToPath(new URL(en?'mobile-en.png':'mobile.png',output)),fullPage:true,animations:'disabled'});
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.hero-emblem').evaluate(element=>getComputedStyle(element).animationName),'none');
    assert.equal(await page.locator('html').evaluate(element=>getComputedStyle(element).scrollBehavior),'auto');
    pass('reduced-motion preference disables animation and smooth scrolling');
    const noJS=await browser.newContext({javaScriptEnabled:false});
    const staticPage=await noJS.newPage();
    staticPage.on('pageerror',error=>errors.push(error.message));
    staticPage.on('response',response=>{if(response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
    staticPage.on('request',request=>requests.push(request.url()));
    await staticPage.goto(url,{waitUntil:'networkidle'});
    for(const width of [1440,1024,768,390,320]){
      await staticPage.setViewportSize({width,height:900});
      for(const selector of ['h1','#install-command','#panel-code','#panel-goal','#panel-context',...Array.from({length:4},(_,i)=>'#flow-panel-'+i),...['usage','architecture','learning','extensions','evidence','roadmap'].map(id=>'#'+id+' .doc-body')])assert.equal(await staticPage.locator(selector).isVisible(),true,`${language}/${width}/${selector}`);
      assert.ok(await staticPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`noJS overflow ${language}/${width}`);
    }
    await staticPage.locator('.language-switch').click();
    assert.equal(await staticPage.locator('html').getAttribute('lang'),en?'zh-CN':'en');
    await noJS.close();pass('every demo panel, flow explanation and document remains readable at five widths without JavaScript; language navigation works');
    await context.close();
  }
  assert.equal(requests.some(url=>!url.startsWith(new URL(site.url).origin)),false);
  assert.deepEqual(errors,[]);pass('no browser exceptions, failing responses or external model/tracking requests');
  await writeFile(new URL('report.json',output),JSON.stringify({passed:true,checkedAt:new Date().toISOString(),checks,errors,requestCount:requests.length,siteModelCalls:0},null,2));
  console.log(`Site QA complete: ${checks.length} checks passed.`);
} catch(error) {
  await writeFile(new URL('report.json',output),JSON.stringify({passed:false,checks,errors,error:String(error)},null,2));throw error;
} finally {await browser.close();await site.close();}
