// Usage: node render.mjs   (needs `playwright` installed; uses the system Chromium if PLAYWRIGHT_BROWSERS_PATH is set)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, 'output');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2.5 });
await page.goto('file://' + path.join(dir, 'takeaway-menu.html'));
await page.evaluate(() => document.fonts.ready);

const report = await page.evaluate(() => [...document.querySelectorAll('.panel')].map(p => {
  const flow = p.querySelector('[data-flow]');
  if (!flow) return null;
  const pr = p.getBoundingClientRect();
  const strip = p.querySelector('.order-strip');
  const limit = strip ? strip.getBoundingClientRect().top - 2 : pr.bottom - parseFloat(getComputedStyle(p).paddingBottom);
  const bottoms = [...flow.parentElement.querySelectorAll('.item,.list,.platter,h2')].map(e => e.getBoundingClientRect().bottom);
  const rightEdge = Math.max(...[...flow.querySelectorAll('*')].map(e => e.getBoundingClientRect().right));
  const mm = 96 / 25.4;
  return { id: p.id, spareMm: +((limit - Math.max(...bottoms)) / mm).toFixed(1),
           overflowRight: rightEdge > pr.right - 1 };
}).filter(Boolean));
console.log(report);

await page.pdf({ path: path.join(out, 'la-mar-shish-takeaway-A4-bifold-3mm-bleed.pdf'),
  width: '303mm', height: '216mm', printBackground: true, preferCSSPageSize: true });
for (const id of ['outside', 'inside'])
  await page.locator('#' + id).screenshot({ path: path.join(out, `preview-${id}.png`) });
await browser.close();
