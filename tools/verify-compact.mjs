/**
 * 验证吸顶后筛选条自动压缩成「只有滑条」的窄条。
 */
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const root = resolve('.');
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(pathToFileURL(resolve(root, 'demo/demo.html')).href);
await page.evaluate(() => {
  const h = document.createElement('div');
  h.className = 'z-top-container';
  h.id = 'bili-header-container';
  h.style.cssText =
    'position:fixed;top:0;left:0;right:0;height:60px;z-index:1000;background:#18191c;color:#fff;display:flex;align-items:center;justify-content:center;';
  h.textContent = '模拟固定页头 60px';
  document.body.prepend(h);
});
await page.addScriptTag({ path: resolve(root, 'bilibili-dynamic-duration-filter.user.js') });
await page.waitForTimeout(600);

const measure = () =>
  page.evaluate(() => {
    const bar = document.querySelector('.bddf-bar');
    const br = bar.getBoundingClientRect();
    const visible = (sel) => {
      const el = bar.querySelector(sel);
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && el.getBoundingClientRect().height > 0;
    };
    return {
      compact: bar.classList.contains('bddf-compact'),
      barHeight: Math.round(br.height),
      barTop: Math.round(br.top),
      headVisible: visible('.bddf-head'),
      sliderVisible: visible('.bddf-slider-wrap'),
      presetsVisible: visible('.bddf-presets'),
      optsVisible: visible('.bddf-opts'),
      thumbVisible: visible('.bddf-thumb--min'),
      bubbleText: bar.querySelector('.bddf-bubble--min')?.textContent.trim(),
    };
  });

const before = await measure();
console.log('1) 页面顶部（未滚动）:', JSON.stringify(before));

// 滚动到中部，让筛选条吸顶
await page.evaluate(() => window.scrollTo(0, 600));
await page.waitForTimeout(600);
const after = await measure();
console.log('2) 滚动后（应紧凑）:', JSON.stringify(after));

// 滚回顶部，应恢复完整面板
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(600);
const back = await measure();
console.log('3) 回到顶部（应复原）:', JSON.stringify(back));

const checks = [
  ['未滚动时不紧凑', before.compact === false],
  ['未滚动时完整显示', before.headVisible && before.presetsVisible && before.optsVisible],
  ['滚动后进入紧凑', after.compact === true],
  ['紧凑时隐藏标题行', after.headVisible === false],
  ['紧凑时隐藏预设', after.presetsVisible === false],
  ['紧凑时隐藏选项', after.optsVisible === false],
  ['紧凑时滑条仍可见', after.sliderVisible === true && after.thumbVisible === true],
  ['紧凑时高度显著减小', after.barHeight > 0 && after.barHeight < before.barHeight / 2],
  ['回到顶部恢复完整', back.compact === false && back.headVisible && back.presetsVisible],
  ['吸顶位置仍在页头下方', after.barTop >= 59],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failed += 1;
}
console.log(`\n紧凑态高度 ${after.barHeight}px vs 完整态 ${before.barHeight}px`);

await page.evaluate(() => window.scrollTo(0, 600));
await page.waitForTimeout(500);
await page.screenshot({ path: 'tools/screenshots/compact-sticky.png' });

await browser.close();
process.exit(failed ? 1 : 0);
