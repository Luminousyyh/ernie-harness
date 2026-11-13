import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {startSiteServer} from './site-preview.mjs';

const output=new URL('../artifacts/site-qa/',import.meta.url);
await mkdir(output,{recursive:true});
const urlIndex=process.argv.indexOf('--url');
const local=urlIndex<0?await startSiteServer():null;
const url=local?.url??process.argv[urlIndex+1];
if(!url)throw new Error('Missing --url value');
const executable=process.env.ERNIE_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser=await chromium.launch({headless:true,...(existsSync(executable)?{executablePath:executable}:{})});
const reports=[];
try {
  for(const [name,viewport,speed] of [['desktop',{width:1440,height:1000},420],['mobile',{width:390,height:844},500]]) {
    const context=await browser.newContext({viewport,deviceScaleFactor:1,reducedMotion:'no-preference',recordVideo:{dir:fileURLToPath(output),size:viewport}});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const response=await page.goto(url,{waitUntil:'networkidle'});
    assert.equal(response.status(),200);
    assert.ok(await page.locator('[data-reveal].reveal-pending').count()>0);
    await page.screenshot({path:fileURLToPath(new URL(`scroll-${name}-start.png`,output)),animations:'allow'});
    const motion=await page.evaluate(async pixelsPerSecond=>{
      const max=document.documentElement.scrollHeight-innerHeight;
      const duration=max/pixelsPerSecond*1000;
      const gaps=[];let frames=0;let previous;
      const started=performance.now();
      await new Promise(resolve=>{
        const step=now=>{
          if(previous!==undefined)gaps.push(now-previous);
          previous=now;frames++;
          const fraction=Math.min(1,(now-started)/duration);
          window.scrollTo({top:max*fraction,behavior:'instant'});
          if(fraction<1)requestAnimationFrame(step);else resolve();
        };
        requestAnimationFrame(step);
      });
      gaps.sort((a,b)=>a-b);
      return {distance:max,durationMs:duration,frames,frameGapP95Ms:gaps[Math.floor(gaps.length*.95)]};
    },speed);
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-reveal]')].every(element=>getComputedStyle(element).opacity==='1'));
    assert.equal(await page.locator('.reveal-pending').count(),0);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:fileURLToPath(new URL(`scroll-${name}-end.png`,output)),animations:'allow'});
    const card=await page.locator('.capability-card').first().boundingBox();
    assert.ok(card);
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    await page.screenshot({path:fileURLToPath(new URL(`scroll-${name}-full.png`,output)),fullPage:true,animations:'disabled'});
    const video=page.video();await context.close();
    await rename(await video.path(),fileURLToPath(new URL(`scroll-${name}.webm`,output)));
    reports.push({name,url,status:response.status(),viewport,motion,errors,allRevealed:true});
    console.log(`Recorded ${name}: ${Math.round(motion.durationMs/1000)}s of natural scrolling.`);
  }
  await writeFile(new URL('scroll-recording.json',output),JSON.stringify({checkedAt:new Date().toISOString(),reports},null,2));
} finally {await browser.close();await local?.close();}
