import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {startSiteServer} from './site-preview.mjs';
const output=new URL('../artifacts/site-qa/',import.meta.url);
await mkdir(output,{recursive:true});
const edge=process.env.ERNIE_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const site=await startSiteServer();
const browser=await chromium.launch({headless:true,...(existsSync(edge)?{executablePath:edge}:{})});
const checks=[];const errors=[];const requests=[];
const pass=name=>{checks.push(name);console.log('PASS '+name);};
try {
  const context=await browser.newContext({viewport:{width:1440,height:1050},deviceScaleFactor:1,permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
  page.on('request',request=>requests.push(request.url()));
  assert.equal((await page.goto(site.url,{waitUntil:'networkidle'})).status(),200);
  assert.match(await page.title(),/ERNIE Harness/);
  assert.equal(await page.locator('h1').count(),1);
  assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
  assert.equal(await page.locator('.demo-label').textContent(),'交互演示 · 不连接模型');
  pass('semantic Chinese page loads from /ernie-harness/ without missing resources');
  const anchors=await page.locator('a[href^="#"]').evaluateAll(links=>links.map(link=>link.hash).filter(hash=>hash.length>1));
  for(const hash of anchors) assert.equal(await page.locator(hash).count(),1,hash);
  assert.equal(await page.locator('a[href*="localhost"],a[href*="127.0.0.1"]').count(),0);
  pass('all local navigation destinations exist; no localhost product links');
  const initialHeight=await page.locator('.workbench').evaluate(element=>element.getBoundingClientRect().height);
  for(const mode of ['goal','context','code']) {
    await page.locator(`[data-preview="${mode}"]`).click();
    assert.equal(await page.locator(`#panel-${mode}`).isVisible(),true);
    assert.equal(await page.locator('.preview-panel:visible').count(),1);
    assert.equal(await page.locator('.workbench').evaluate(element=>element.getBoundingClientRect().height),initialHeight);
  }
  pass('three product demos switch without page height shifts');
  await page.locator('#tab-code').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tab-goal').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('#tab-goal').evaluate(element=>element===document.activeElement),true);
  await page.keyboard.press('End');assert.equal(await page.locator('#panel-context').isVisible(),true);
  await page.keyboard.press('Home');assert.equal(await page.locator('#panel-code').isVisible(),true);
  pass('preview tabs support roving focus, arrows, Home and End');
  const flowHeight=await page.locator('.flow-board').evaluate(element=>element.getBoundingClientRect().height);
  for(let index=0;index<4;index++) {
    await page.locator(`[data-flow="${index}"]`).click();
    assert.equal(await page.locator(`#flow-panel-${index}`).isVisible(),true);
    assert.equal(await page.locator('.flow-board').evaluate(element=>element.getBoundingClientRect().height),flowHeight);
  }
  await page.locator('#flow-tab-3').press('Home');assert.equal(await page.locator('#flow-tab-0').getAttribute('aria-selected'),'true');
  pass('four Super-Agent explanations are accessible and keep stable layout');
  await page.locator('[data-copy]').click();
  assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/git clone https:\/\/github.com\/Luminousyyh\/ernie-harness.git/);
  assert.match(await page.locator('.toast').textContent(),/已复制/);
  pass('copy button writes the exact clone/build/setup instructions');
  await page.evaluate(()=>{Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new Error('clipboard denied');}});});
  await page.locator('[data-copy]').click();
  assert.match(await page.locator('.toast').textContent(),/手动复制/);
  assert.match(await page.evaluate(()=>window.getSelection().toString()),/pnpm cli setup/);
  pass('clipboard denial selects commands and reports manual-copy fallback');
  await page.locator('.faq-list summary').first().click();assert.equal(await page.locator('.faq-list details').first().getAttribute('open'),'');
  await page.locator('.faq-list summary').first().click();pass('FAQ expands and collapses with native details');
  assert.match(await page.locator('.benchmark-stats').textContent(),/2026.11.13/);
  assert.match(await page.locator('.benchmark').textContent(),/不发布性能排名/);
  assert.match(await page.locator('.site-footer').textContent(),/无隶属关系/);
  pass('dated research snapshot and independent-project notice are visible');
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await page.screenshot({path:fileURLToPath(new URL('desktop.png',output)),fullPage:true,animations:'disabled'});
  for(const width of [1440,1024,768,390,320]) {
    await page.setViewportSize({width,height:900});
    for(const mode of ['code','goal','context']) {
      await page.locator(`[data-preview="${mode}"]`).click();
      const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));
      assert.ok(sizes.scroll<=sizes.viewport+1,`overflow at ${width}/${mode}: ${JSON.stringify(sizes)}`);
    }
    pass(`no horizontal page overflow at ${width}px, for all previews`);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('.mobile-toggle').click();assert.equal(await page.locator('#mobile-nav').isVisible(),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#mobile-nav').isVisible(),false);
  assert.equal(await page.locator('.mobile-toggle').evaluate(element=>element===document.activeElement),true);
  await page.locator('.mobile-toggle').click();await page.locator('#mobile-nav a[href="#quickstart"]').click();
  assert.equal(await page.locator('#mobile-nav').isVisible(),false);
  pass('mobile menu supports Escape, focus return and navigation closure');
  await page.locator('#tab-code').click();await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await page.screenshot({path:fileURLToPath(new URL('mobile.png',output)),fullPage:true,animations:'disabled'});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.hero-emblem').evaluate(element=>getComputedStyle(element).animationName),'none');
  assert.equal(await page.locator('html').evaluate(element=>getComputedStyle(element).scrollBehavior),'auto');
  pass('reduced-motion preference disables animation and smooth scrolling');
  const noJS=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
  const staticPage=await noJS.newPage();await staticPage.goto(site.url,{waitUntil:'networkidle'});
  assert.equal(await staticPage.locator('h1').isVisible(),true);assert.equal(await staticPage.locator('#install-command').isVisible(),true);assert.equal(await staticPage.locator('#panel-code').isVisible(),true);
  await noJS.close();pass('essential content and installation remain readable without JavaScript');
  assert.equal(requests.some(url=>!url.startsWith(new URL(site.url).origin)),false);
  assert.deepEqual(errors,[]);pass('no browser exceptions, failing responses or external model/tracking requests');
  const report={passed:true,checkedAt:new Date().toISOString(),checks,errors,requestCount:requests.length,siteModelCalls:0};
  await writeFile(new URL('report.json',output),JSON.stringify(report,null,2));
  console.log(`Site QA complete: ${checks.length} checks passed.`);
} catch(error) {
  await writeFile(new URL('report.json',output),JSON.stringify({passed:false,checks,errors,error:String(error)},null,2));throw error;
} finally {await browser.close();await site.close();}
