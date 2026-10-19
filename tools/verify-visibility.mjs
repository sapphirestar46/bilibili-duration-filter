/**
 * 验证：筛选条只在「视频投稿」tab 出现；切到其它 tab 时整体隐藏且不筛选。
 */
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const root = resolve('.');
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

await page.goto(pathToFileURL(resolve(root, 'demo/demo.html')).href);
await page.addScriptTag({ path: resolve(root, 'bilibili-dynamic-duration-filter.user.js') });
await page.waitForTimeout(500);

const state = () =>
  page.evaluate(() => {
    const bar = document.querySelector('.bddf-bar');
    const cs = bar ? getComputedStyle(bar) : null;
    const tabs = [...document.querySelectorAll('.bili-dyn-list-tabs__item')];
    return {
      activeTab: (tabs.find((t) => t.classList.contains('active')) || {}).textContent?.trim(),
      barExists: !!bar,
      barHiddenAttr: bar?.getAttribute('data-hidden'),
      barDisplay: cs?.display,
      visibleItems: document.querySelectorAll('.bili-dyn-list__item:not(.bddf-hidden)').length,
      hiddenItems: document.querySelectorAll('.bili-dyn-list__item.bddf-hidden').length,
    };
  });

const clickTab = async (name) => {
  await page.locator('.bili-dyn-list-tabs__item', { hasText: name }).first().click();
  await page.waitForTimeout(400);
};

// 1) 默认在视频投稿
const s1 = await state();
console.log('1) 默认（视频投稿）:', JSON.stringify(s1));

// 应用一个筛选
await page.evaluate(() => window.__BDDF__.setRange(600, Infinity));
await page.waitForTimeout(400);
const s2 = await state();
console.log('2) 应用 ≥10分钟:', JSON.stringify(s2));

// 2) 切到「全部」
await clickTab('全部');
const s3 = await state();
console.log('3) 切到「全部」:', JSON.stringify(s3));

// 3) 切到「追番追剧」
await clickTab('追番追剧');
const s4 = await state();
console.log('4) 切到「追番追剧」:', JSON.stringify(s4));

// 4) 切回「视频投稿」
await clickTab('视频投稿');
const s5 = await state();
console.log('5) 切回「视频投稿」:', JSON.stringify(s5));

const checks = [
  ['默认视频投稿下模块可见', s1.barDisplay !== 'none' && s1.barHiddenAttr === '0'],
  ['视频投稿下可筛选', s2.hiddenItems > 0],
  ['切到全部后模块隐藏', s3.barDisplay === 'none'],
  ['切到全部后筛选被撤销', s3.hiddenItems === 0],
  ['全部下保留原列表', s3.visibleItems === 12],
  ['切到追番追剧模块隐藏', s4.barDisplay === 'none'],
  ['追番追剧下无筛选', s4.hiddenItems === 0],
  ['切回视频投稿模块恢复', s5.barDisplay !== 'none'],
  ['切回后筛选重新生效', s5.hiddenItems > 0],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failed += 1;
}

// 截图：视频投稿 vs 全部
await page.screenshot({ path: 'tools/screenshots/tab-video.png' });
await clickTab('全部');
await page.screenshot({ path: 'tools/screenshots/tab-all.png' });

await browser.close();
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
