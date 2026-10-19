/**
 * 验证筛选条吸顶时不被 B 站页头遮挡。
 * 用真实 Chrome 打开 demo 页 + 注入脚本，并人为加一个 fixed 页头模拟 B 站。
 */
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const root = resolve('.');
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(pathToFileURL(resolve(root, 'demo/demo.html')).href);

// 模拟 B 站固定页头（60px 高，fixed，z-index 很高）
await page.evaluate(() => {
  const h = document.createElement('div');
  h.className = 'z-top-container';
  h.id = 'bili-header-container';
  h.style.cssText =
    'position:fixed;top:0;left:0;right:0;height:96px;z-index:1000;background:#18191c;color:#fff;display:flex;align-items:center;justify-content:center;';
  h.textContent = '模拟页头 (96px)';
  document.body.prepend(h);
});

await page.addScriptTag({ path: resolve(root, 'bilibili-dynamic-duration-filter.user.js') });
await page.waitForTimeout(600);

const r1 = await page.evaluate(() => {
  const bar = document.querySelector('.bddf-bar');
  return {
    hasBar: !!bar,
    cssVarTop: bar && bar.style.getPropertyValue('--bddf-top'),
    attrOffset: bar && bar.getAttribute('data-header-offset'),
  };
});
console.log('1) 初始测量:', JSON.stringify(r1));

// 滚动到列表中部，检查吸顶位置是否在页头下方
await page.evaluate(() => window.scrollTo(0, 400));
await page.waitForTimeout(500);

const r2 = await page.evaluate(() => {
  const bar = document.querySelector('.bddf-bar');
  const header = document.querySelector('.z-top-container');
  const br = bar.getBoundingClientRect();
  const hr = header.getBoundingClientRect();
  return {
    barTop: Math.round(br.top),
    barBottom: Math.round(br.bottom),
    headerBottom: Math.round(hr.bottom),
    overlapped: br.top < hr.bottom - 1,
    cssVarTop: bar.style.getPropertyValue('--bddf-top'),
  };
});
console.log('2) 滚动后:', JSON.stringify(r2));
console.log(r2.overlapped ? '❌ 仍被页头遮挡' : '✅ 筛选条未被页头遮挡');

await page.screenshot({ path: 'tools/screenshots/sticky-check.png' });
await browser.close();
process.exit(r2.overlapped ? 1 : 0);
