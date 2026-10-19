#!/usr/bin/env node
/**
 * 本地验证：用系统已安装的 Chrome 无头打开 demo/demo.html，
 * 注入用户脚本，跑一遍交互断言并截图到 tools/screenshots/。
 *
 * 用法： node tools/screenshot.mjs [--headed]
 * 依赖： tools/ 下已 npm install（playwright-core，不下载浏览器）
 */
import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const shots = resolve(__dirname, 'screenshots');
mkdirSync(shots, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('未找到 Chrome/Edge，可用 CHROME_PATH 环境变量指定');
  process.exit(1);
}

const demoFile = resolve(root, 'demo/demo.html');
const scriptFile = resolve(root, 'bilibili-dynamic-duration-filter.user.js');
for (const f of [demoFile, scriptFile]) {
  if (!existsSync(f)) {
    console.error('缺少文件：', f);
    process.exit(1);
  }
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
};

const browser = await chromium.launch({ executablePath, headless: !process.argv.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1.5 });

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

await page.goto(pathToFileURL(demoFile).href);
await page.addScriptTag({ path: scriptFile });
await page.waitForTimeout(300);

// 1) 脚本挂载
const barCount = await page.locator('.bddf-bar').count();
check('注入筛选条 .bddf-bar', barCount === 1, `count=${barCount}`);

// 2) 位置：紧邻 .bili-dyn-list-tabs 之后
const afterTabs = await page.evaluate(() => {
  const bar = document.querySelector('.bddf-bar');
  const tabs = document.querySelector('.bili-dyn-list-tabs');
  if (!bar || !tabs) return false;
  return tabs.nextElementSibling === bar;
});
check('筛选条位于 tab 栏之后', afterTabs);

// 3) 默认全部可见
const total = await page.locator('.bili-dyn-list__item').count();
const visible0 = await page.locator('.bili-dyn-list__item:not(.bddf-hidden)').count();
check('默认显示全部动态', visible0 === total, `${visible0}/${total}`);

// 4) 设置范围 1-5 分钟，验证显隐
await page.evaluate(() => window.__BDDF__.setRange(60, 300));
await page.waitForTimeout(150);
const visibleMinutes = await page.evaluate(() =>
  [...document.querySelectorAll('.bili-dyn-list__item:not(.bddf-hidden)')].map(
    (li) => li.querySelector('.duration-time')?.textContent.trim() ?? '(无时长/非视频)'
  )
);
check(
  '60s–300s 过滤正确',
  visibleMinutes.includes('03:21') &&
    visibleMinutes.includes('02:10') &&
    !visibleMinutes.includes('00:45') &&
    !visibleMinutes.includes('08:12'),
  JSON.stringify(visibleMinutes)
);
check('无时长视频项默认保留', visibleMinutes.includes('(无时长/非视频)'), JSON.stringify(visibleMinutes));

// 5) 预设按钮
await page.locator('.bddf-preset[data-min="600"][data-max="1800"]').click();
await page.waitForTimeout(120);
const presetRange = await page.evaluate(() => window.__BDDF__.getRange());
check('预设按钮 10–30 分钟生效', presetRange.min === 600 && presetRange.max === 1800, JSON.stringify(presetRange));
const activePreset = await page.locator('.bddf-preset.active').count();
check('预设按钮 active 态', activePreset === 1);

// 6) 键盘操作
await page.locator('.bddf-thumb--min').focus();
await page.keyboard.press('End');
await page.waitForTimeout(100);
const afterEnd = await page.evaluate(() => window.__BDDF__.getRange());
check('键盘 End 将 min 推到最大', afterEnd.min >= 10800 - 60 || afterEnd.min === 10800, JSON.stringify(afterEnd));

// 7) 重置
await page.locator('.bddf-reset').click();
await page.waitForTimeout(100);
const resetRange = await page.evaluate(() => window.__BDDF__.getRange());
const resetVisible = await page.locator('.bili-dyn-list__item:not(.bddf-hidden)').count();
check('重置恢复默认', resetRange.min === 0 && resetRange.max === Infinity && resetVisible === total, JSON.stringify(resetRange));

// 8) 停用开关
await page.locator('.bddf-enabled').uncheck();
await page.waitForTimeout(120);
const hiddenWhenOff = await page.locator('.bili-dyn-list__item.bddf-hidden').count();
check('停用后无隐藏项', hiddenWhenOff === 0, `hidden=${hiddenWhenOff}`);
await page.locator('.bddf-enabled').check();

// 9) 拖动滑块（Pointer 事件）
await page.evaluate(() => window.__BDDF__.setRange(0, Infinity));
await page.waitForTimeout(80);
const thumb = page.locator('.bddf-thumb--min');
const box = await thumb.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(150);
const dragged = await page.evaluate(() => window.__BDDF__.getRange());
check('拖动 min 滑块改变范围', dragged.min > 0, JSON.stringify(dragged));

// 10) 新增动态后自动筛选
await page.evaluate(() => window.__BDDF__.setRange(300, 600));
await page.evaluate(() => {
  const list = document.querySelector('.bili-dyn-list__items');
  const tpl = document.querySelector('.bili-dyn-list__item');
  const li = tpl.cloneNode(true);
  li.querySelector('.duration-time').textContent = '05:30';
  list.appendChild(li);
});
await page.waitForTimeout(400);
const newItemVisible = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.bili-dyn-list__item')];
  const last = items[items.length - 1];
  return !last.classList.contains('bddf-hidden');
});
check('新增 05:30 动态被 MutationObserver 正确显示', newItemVisible);

// 11) 收起
await page.locator('.bddf-collapse').click();
await page.waitForTimeout(120);
const collapsed = await page.evaluate(() => document.querySelector('.bddf-bar').dataset.collapsed);
check('收起状态生效', collapsed === '1');
await page.locator('.bddf-collapse').click();
await page.waitForTimeout(120);

// 12) 无异常
check('控制台无 pageerror', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

// ---- 截图 ----
await page.evaluate(() => window.__BDDF__.setRange(60, 600));
await page.waitForTimeout(250);
await page.screenshot({ path: resolve(shots, 'demo-filtered.png') });

await page.evaluate(() => window.__BDDF__.setRange(0, Infinity));
await page.waitForTimeout(150);
await page.screenshot({ path: resolve(shots, 'demo-all.png'), fullPage: false });

// 滑块细节特写
const bar = page.locator('.bddf-bar');
await bar.screenshot({ path: resolve(shots, 'bar-detail.png') });

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('失败项：', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
console.log('截图已输出：', shots);
