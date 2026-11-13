const english = document.documentElement.lang === 'en';
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
function wireTabs(selector) {
  const tabs = $$(selector);
  const select = (tab, focus = false) => {
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(item.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    }
    if (focus) tab.focus({preventScroll: true});
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); select(tabs[next], true); }
    });
  }
}
wireTabs('[data-preview]');
wireTabs('[data-flow]');
const menuButton = $('.mobile-toggle');
const mobileNav = $('#mobile-nav');
const setMenu = open => {
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? (english ? 'Close navigation' : '收起导航') : (english ? 'Open navigation' : '展开导航'));
  mobileNav.hidden = !open;
  $('use', menuButton).setAttribute('href', open ? '#i-close' : '#i-menu');
};
menuButton.addEventListener('click', () => setMenu(menuButton.getAttribute('aria-expanded') !== 'true'));
$$('a', mobileNav).forEach(link => link.addEventListener('click', () => setMenu(false)));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !mobileNav.hidden) { setMenu(false); menuButton.focus(); }
});
document.addEventListener('click', event => {
  if (!mobileNav.hidden && !mobileNav.contains(event.target) && !menuButton.contains(event.target)) setMenu(false);
});
window.matchMedia('(min-width: 601px)').addEventListener('change', event => { if (event.matches) setMenu(false); });
let toastTimer;
function notify(text) {
  const toast = $('.toast');
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}
$$('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.textContent.trim());
      notify(english ? 'Installation commands copied' : '安装命令已复制');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      notify(english ? 'Commands selected; copy them manually' : '已选中命令，请手动复制');
    }
  });
});


// One observer reveals each block once; layout and native scrolling stay intact.
function initScrollReveal() {
  const targets = $$('[data-reveal]');
  if (!targets.length) return;
  const pending = new Set();
  let observer;
  let motion;
  let detach = () => {};
  const instant = element => {
    element.classList.add('reveal-instant', 'is-revealed');
    element.classList.remove('reveal-pending', 'reveal-active');
    pending.delete(element);
  };
  const exposeAll = () => {
    targets.forEach(instant);
    try { observer?.disconnect(); } catch { /* Content is already visible. */ }
    detach();
  };
  const reveal = (element, immediately = false) => {
    if (immediately) instant(element);
    else {
      element.classList.remove('reveal-pending');
      element.classList.add('is-revealed');
      pending.delete(element);
    }
    observer?.unobserve(element);
  };
  const exposeRegion = element => {
    if (!(element instanceof Element)) return;
    // Focus can enter a control before the observer has delivered its callback.
    const enclosing = element.closest('[data-reveal]');
    if (enclosing) reveal(enclosing, true);
    element.querySelectorAll('[data-reveal]').forEach(target => reveal(target, true));
  };
  const exposeHash = hash => {
    if (!hash || hash === '#') return;
    try { exposeRegion(document.getElementById(decodeURIComponent(hash.slice(1)))); } catch { exposeAll(); }
  };
  try {
    motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches || typeof IntersectionObserver !== 'function') { exposeAll(); return; }
    observer = new IntersectionObserver(entries => {
      try {
        for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio >= .08) reveal(entry.target);
      } catch { exposeAll(); }
    }, {rootMargin: '0px 0px -48px 0px', threshold: .08});
    const onFocus = event => {
      try {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const enclosing = target.closest('[data-reveal]');
        // Pointer focus must not move a visible button between down and up.
        if (pending.has(enclosing) || target.matches(':focus-visible')) exposeRegion(target);
      } catch { exposeAll(); }
    };
    const onHash = () => exposeHash(window.location.hash);
    const onClick = event => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      try {
        const url = new URL(anchor.href, document.baseURI);
        if (url.origin === window.location.origin && url.pathname === window.location.pathname) exposeHash(url.hash);
      } catch { exposeAll(); }
    };
    const onPageShow = () => {
      try {
        onHash();
        for (const target of pending) if (target.getBoundingClientRect().top < innerHeight) reveal(target, true);
      } catch { exposeAll(); }
    };
    const onMotion = event => { if (event.matches) exposeAll(); };
    const onTransition = event => {
      if (event.propertyName === 'opacity' && event.target instanceof Element && event.target.matches('[data-reveal].is-revealed')) {
        event.target.classList.remove('reveal-active');
      }
    };
    detach = () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('click', onClick);
      document.removeEventListener('transitionend', onTransition);
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('pageshow', onPageShow);
      motion.removeEventListener('change', onMotion);
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('click', onClick);
    document.addEventListener('transitionend', onTransition);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('pageshow', onPageShow);
    motion.addEventListener('change', onMotion);
    for (const target of targets) {
      if (target.getBoundingClientRect().top < innerHeight) instant(target);
      else {
        target.classList.add('reveal-active', 'reveal-pending');
        pending.add(target);
        observer.observe(target);
      }
    }
    onHash();
  } catch { exposeAll(); }
}
initScrollReveal();

// Retain the current section when moving between real static language pages.
const languageLink = $('.language-switch');
function syncLanguageAnchor() {
  if (!languageLink) return;
  const destination = languageLink.getAttribute('href').split('#')[0];
  languageLink.setAttribute('href', destination + (location.hash || '#main'));
}
syncLanguageAnchor();
window.addEventListener('hashchange', syncLanguageAnchor);
languageLink?.addEventListener('click', syncLanguageAnchor);
