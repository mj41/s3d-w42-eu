// A headless check of the page at 1200, 420 and 1600 px: no labels overlap (ten frames as it
// turns), the side panel does not overflow, a group's list opens on a tap, and screenshots
// (<name>.png) before and after a resize. Needs Playwright and the site running:
//   go run . -listen :8086 &  THREE_DIR=<npm three@0.160.0> node tools/pagecheck.cjs
// three.js is served from THREE_DIR in place of jsDelivr (for sandboxes without it).
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const site = process.env.SITE || 'http://localhost:8086';
const three = process.env.THREE_DIR;
const path = require('path');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [name, vp, mobile] of [['w1200', {width:1200,height:800}, false], ['w420', {width:420,height:860}, true], ['w1600', {width:1600,height:700}, false]]) {
    const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
    const p = await ctx.newPage();
    p.on('pageerror', e => console.log(name, 'pageerror', e.message));
    p.on('console', m => { if (m.type() !== 'log') console.log(name, m.type(), m.text()); });
    if (three) await p.route('https://cdn.jsdelivr.net/npm/three@0.160.0/**', r => r.fulfill({ path: path.join(three, r.request().url().split('three@0.160.0/')[1]), contentType: 'text/javascript' }));
    await p.goto(site + '/#pet');
    await p.waitForTimeout(3500);
    for (let k = 0; k < 10; k++) {
      const res = await p.evaluate(() => {
        const ls = [...document.querySelectorAll('.label')].filter(e => e.offsetParent && getComputedStyle(e.parentElement).display !== 'none').map(e => [e.textContent, e.getBoundingClientRect()]);
        let ov = [];
        for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
          const a = ls[i][1], c = ls[j][1];
          if (a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom) ov.push(ls[i][0] + ' / ' + ls[j][0]);
        }
        const aside = document.querySelector('aside');
        return { labels: ls.length, overlaps: ov, asideOverflow: aside.scrollWidth - aside.clientWidth, docOverflow: document.documentElement.scrollWidth - innerWidth };
      });
      console.log(name, 't' + k, JSON.stringify(res));
      await p.waitForTimeout(700);
    }
    const stage = p.locator('#stage');
        const g = p.locator('.label.group').first();
    await g.click({ force: true });
    await p.waitForTimeout(300);
    console.log(name, 'pop', await p.evaluate(() => { const e = document.getElementById('pop'); return e.hidden ? 'hidden' : e.innerText.replace(/\n/g, ' | '); }));
    await p.screenshot({ path: name + '.png' });
    await p.setViewportSize({ width: Math.round(vp.width * 0.7), height: vp.height });
    await p.waitForTimeout(800);
    await stage.screenshot({ path: name + '-resized-stage.png' });
    await ctx.close();
  }
  await b.close();
})();
