import assert from 'node:assert/strict';

const pending = '[data-reveal].reveal-pending';
const revealTargets = '[data-reveal]';
const assertReadable = async page => {
  const unreadable = await page.locator(revealTargets).evaluateAll(elements => elements.filter(element => getComputedStyle(element).opacity !== '1').map(element => element.className));
  assert.deepEqual(unreadable, []);
};

export async function revealForScreenshot(page) {
  await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
  // Walk through the page so a full-page capture includes real, completed reveals.
  const step = await page.evaluate(() => Math.floor(innerHeight * .7));
  let top = 0;
  while (top < await page.evaluate(() => document.documentElement.scrollHeight)) {
    await page.evaluate(y => window.scrollTo({top:y,behavior:'instant'}), top);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-reveal]')].filter(element => {
      const bounds=element.getBoundingClientRect(); return bounds.top<innerHeight-48 && bounds.bottom>0;
    }).every(element => !element.classList.contains('reveal-pending') && getComputedStyle(element).opacity==='1'));
    top += step;
  }
  await page.waitForFunction(() => !document.querySelector('[data-reveal].reveal-pending'));
  await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
}

export async function verifyScrollReveal({browser,url,pass}) {
  const contexts = [];
  const contextFor = async options => {const context=await browser.newContext({viewport:{width:1440,height:1050},...options});contexts.push(context);return context;};
  const fresh = async (options={},init) => {
    const context=await contextFor(options); if(init)await context.addInitScript(init);
    const page=await context.newPage();await page.goto(url,{waitUntil:'networkidle'});return page;
  };
  try {
    const page=await fresh();
    assert.ok(await page.locator(revealTargets).count()>=15, 'Expected semantic reveal targets on the showcase');
    assert.equal(await page.locator('[data-reveal] [data-reveal]').count(),0,'Reveal targets must not be nested');
    assert.equal(await page.locator('.hero [data-reveal],.site-header [data-reveal]').count(),0);
    assert.ok(await page.locator(pending).count()>0, 'Below-fold content should wait for viewport entry');
    assert.equal(await page.locator(pending).first().evaluate(e=>getComputedStyle(e).pointerEvents),'none');
    assert.equal(await page.locator('.hero h1').evaluate(e=>getComputedStyle(e).opacity),'1');
    pass('first screen is immediate; non-nested below-fold targets wait for scroll');
    const startHeight=await page.evaluate(()=>document.documentElement.scrollHeight);
    const cards=page.locator('.capability-card');
    const desktop=await cards.evaluateAll(elements=>elements.map(element=>{
      const style=getComputedStyle(element);return {duration:style.transitionDuration,delay:style.transitionDelay,easing:style.transitionTimingFunction,distance:style.getPropertyValue('--reveal-distance').trim()};
    }));
    assert.ok(desktop.every(style=>style.duration.includes('0.65s')&&style.easing.includes('0.22, 1, 0.36, 1')&&style.distance==='24px'));
    assert.deepEqual(desktop.map(style=>parseFloat(style.delay)),[0,.08,.16]);
    await cards.first().evaluate(element=>window.scrollTo({top:element.getBoundingClientRect().top+scrollY-innerHeight+300,behavior:'instant'}));
    await page.waitForFunction(()=>[...document.querySelectorAll('.capability-card')].every(e=>!e.classList.contains('reveal-pending')));
    await page.waitForFunction(()=>[...document.querySelectorAll('.capability-card')].every(e=>getComputedStyle(e).opacity==='1'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),startHeight,'Reveals must not reflow page height');
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    assert.equal(await cards.first().evaluate(e=>e.classList.contains('reveal-pending')),false);
    assert.equal(await cards.first().evaluate(e=>getComputedStyle(e).opacity),'1');
    pass('desktop cards stagger at 0/80/160ms, complete once and preserve page height');
    await page.reload({waitUntil:'networkidle'});
    assert.equal(await cards.first().evaluate(e=>e.classList.contains('reveal-pending')),true);
    pass('a fresh page load starts a fresh reveal cycle');
    await page.locator('.desktop-nav a[href="#quickstart"]').click();
    assert.equal(await page.locator('#quickstart .reveal-pending').count(),0);
    assert.equal(await page.locator('#install-command').evaluate(e=>getComputedStyle(e.closest('[data-reveal]')).opacity),'1');
    await page.reload({waitUntil:'networkidle'});
    assert.equal(await page.locator('#quickstart .reveal-pending').count(),0);
    pass('anchor clicks and direct hash loads reveal destination immediately');
    const focusPage=await fresh();
    await focusPage.locator('[data-copy]').evaluate(e=>e.focus({preventScroll:true}));
    assert.equal(await focusPage.locator('[data-copy]').evaluate(e=>e===document.activeElement),true);
    assert.equal(await focusPage.locator('.install-card').evaluate(e=>getComputedStyle(e).opacity),'1');
    assert.equal(await focusPage.locator('.install-card').evaluate(e=>e.classList.contains('reveal-pending')),false);
    pass('keyboard focus immediately exposes controls inside pending content');
    const mobile=await fresh({viewport:{width:390,height:844}});
    assert.equal(await mobile.locator('.capability-card').first().evaluate(e=>getComputedStyle(e).getPropertyValue('--reveal-distance').trim()),'16px');
    const mobileStyles=await mobile.locator('.capability-card').evaluateAll(elements=>elements.map(e=>({duration:getComputedStyle(e).transitionDuration,delay:getComputedStyle(e).transitionDelay})));
    assert.ok(mobileStyles.every(style=>style.duration.includes('0.48s')));
    assert.deepEqual(mobileStyles.map(style=>parseFloat(style.delay)),[0,.06,.12]);
    await mobile.evaluate(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));
    await mobile.setViewportSize({width:320,height:900});await mobile.setViewportSize({width:768,height:900});
    await revealForScreenshot(mobile);await assertReadable(mobile);
    assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    pass('mobile uses 16px/480ms and 60ms stagger; fast scroll and resizing remain readable');
    const reduced=await fresh({reducedMotion:'reduce'});
    await assertReadable(reduced);assert.equal(await reduced.locator(pending).count(),0);
    pass('reduced motion displays all content immediately');
    const dynamic=await fresh();assert.ok(await dynamic.locator(pending).count()>0);
    await dynamic.emulateMedia({reducedMotion:'reduce'});await assertReadable(dynamic);
    assert.equal(await dynamic.locator(pending).count(),0);
    await dynamic.emulateMedia({reducedMotion:'no-preference'});assert.equal(await dynamic.locator(pending).count(),0);
    pass('switching reduced motion on releases waiting content without rehiding it later');
    const noJS=await fresh({javaScriptEnabled:false});await assertReadable(noJS);pass('no JavaScript leaves every section readable');
    const noObserver=await fresh({},()=>{window.IntersectionObserver=undefined;});await assertReadable(noObserver);
    pass('missing IntersectionObserver falls back to visible content');
    const failed=await fresh({},()=>{const Native=window.IntersectionObserver;window.IntersectionObserver=class extends Native {observe(){throw new Error('fixture: observer setup failure');}};});
    await assertReadable(failed);assert.equal(await failed.locator(pending).count(),0);
    await failed.locator('#tab-context').click();assert.equal(await failed.locator('#panel-context').isVisible(),true);
    pass('observer initialization failure exposes all content and preserves existing controls');
    const observed=await fresh({},()=>{
      const Native=window.IntersectionObserver;
      window.observerOptions=[];
      window.IntersectionObserver=class extends Native {
        constructor(callback,options){super(callback,options);window.observerOptions.push(options);}
      };
    });
    assert.deepEqual(await observed.evaluate(()=>window.observerOptions),[{rootMargin:'0px 0px -48px 0px',threshold:.08}]);
    pass('one observer owns the documented viewport margin and intersection threshold');
    const callbackFailure=await fresh({},()=>{
      const Native=window.IntersectionObserver;
      window.IntersectionObserver=class extends Native {unobserve(){throw new Error('fixture: observer callback failure');}};
    });
    await callbackFailure.locator('.capability-card').first().evaluate(element=>window.scrollTo({top:element.getBoundingClientRect().top+scrollY-100,behavior:'instant'}));
    await callbackFailure.waitForFunction(()=>!document.querySelector('[data-reveal].reveal-pending'));
    await assertReadable(callbackFailure);
    pass('observer callback failure releases all remaining content');
    const printed=await fresh();await printed.emulateMedia({media:'print'});await assertReadable(printed);
    pass('print output exposes all pending sections');
  } finally {await Promise.all(contexts.map(context=>context.close()));}
}
