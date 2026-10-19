/**
 * jsdom 测试基础设施：
 *  - 仿 B 站动态首页的 fixture 构建
 *  - jsdom 环境补丁（rAF / matchMedia / PointerEvent capture / scrollTo）
 *  - GM_* stub（正常 / 抛异常）
 *  - 在 jsdom window 上下文中加载用户脚本
 *
 * 注意：jsdom 没有真实布局，不要断言像素位置 / getBoundingClientRect 数值。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const SCRIPT_PATH = path.join(ROOT, 'bilibili-dynamic-duration-filter.user.js');
export const SCRIPT_URL = 'https://t.bilibili.com/';
/** SPEC 3.1 规定的可运行页面 */
export const ALLOWED_URLS = [
  'https://t.bilibili.com/',
  'https://t.bilibili.com/h5/dynamic/detail/123',
  'https://www.bilibili.com/',
  'https://www.bilibili.com/?spm_id_from=333.1007',
];

/* ------------------------------------------------------------------ */
/* 基础工具                                                           */
/* ------------------------------------------------------------------ */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等待脚本文件出现（由 run-tests.mjs 使用） */
export async function waitForFile(file, { intervalMs = 20_000, timeoutMs = 15 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const st = fs.statSync(file);
      if (st.size > 0) return true;
    } catch {
      /* 还没出现 */
    }
    if (Date.now() >= deadline) return false;
    console.log(`[qa] 等待脚本文件… ${file}`);
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------ */
/* GM_* stub                                                          */
/* ------------------------------------------------------------------ */

/** 内存版 GM_* stub（同一 store 可跨两个 jsdom window 复用，验证持久化） */
export function createGM(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  const menus = [];
  const gm = {
    GM_getValue(key, fallback) {
      calls.push({ type: 'get', key });
      return store.has(key) ? store.get(key) : fallback;
    },
    GM_setValue(key, value) {
      calls.push({ type: 'set', key, value });
      store.set(key, value);
    },
    GM_registerMenuCommand(label, fn) {
      calls.push({ type: 'menu', label });
      menus.push({ label, fn });
    },
  };
  return { gm, store, calls, menus };
}

/** 所有 GM_* 均抛异常的 stub（验证存储异常不得抛出） */
export function createThrowingGM() {
  const boom = () => {
    throw new Error('GM storage boom');
  };
  return { GM_getValue: boom, GM_setValue: boom, GM_registerMenuCommand: boom };
}

/* ------------------------------------------------------------------ */
/* fixture                                                            */
/* ------------------------------------------------------------------ */

/**
 * 每条 fixture 的 kind：
 *   video    —— 视频投稿，含 `.bili-dyn-card-video` 与时长
 *   text     —— 文字动态（非视频）
 *   article  —— 专栏（非视频）
 *   bangumi  —— 追番追剧（非视频）
 */
export const DEFAULT_ITEMS = [
  { kind: 'video', duration: '00:45' }, // dyn-0  → 45s
  { kind: 'video', duration: '00:59' }, // dyn-1  → 59s   （4.4：应隐藏）
  { kind: 'video', duration: '03:21' }, // dyn-2  → 201s  （4.4：应可见）
  { kind: 'video', duration: '05:01' }, // dyn-3  → 301s  （4.4：应隐藏）
  { kind: 'video', duration: '08:12' }, // dyn-4  → 492s
  { kind: 'video', duration: '15:40' }, // dyn-5  → 940s
  { kind: 'video', duration: '42:05' }, // dyn-6  → 2525s
  { kind: 'video', duration: '1:02:03' }, // dyn-7  → 3723s
  { kind: 'video', duration: '12:34' }, // dyn-8  → 754s
  { kind: 'video', duration: null }, // dyn-9  → 无时长视频（unknown）
  { kind: 'text' }, // dyn-10 非视频
  { kind: 'text' }, // dyn-11 非视频
  { kind: 'article' }, // dyn-12 非视频
  { kind: 'bangumi' }, // dyn-13 非视频
];

export const VIDEO_ONLY_ITEMS = [
  { kind: 'video', duration: '00:45' },
  { kind: 'video', duration: '03:21' },
  { kind: 'video', duration: '08:12' },
  { kind: 'video', duration: '15:40' },
  { kind: 'video', duration: '42:05' },
  { kind: 'video', duration: '1:02:03' },
  { kind: 'video', duration: '12:34' },
  { kind: 'video', duration: null },
];

const NON_VIDEO_MARKUP = {
  text: '<div class="bili-dyn-card-opus"><div class="bili-rich-text">这是一条文字动态</div></div>',
  article: '<div class="bili-dyn-card-article"><div class="bili-dyn-card-article__title">专栏标题</div></div>',
  bangumi: '<div class="bili-dyn-card-bangumi"><div class="bili-dyn-card-bangumi__title">追番</div></div>',
};

function itemMarkup(item, index) {
  const id = `dyn-${index}`;
  const fixtureId = item.id ?? id;
  let body;
  if (item.kind === 'video') {
    const durationHtml =
      item.duration == null
        ? ''
        : `<div class="duration-time">${item.duration}</div>`;
    body = [
      '<div class="bili-dyn-card-video">',
      '  <div class="bili-dyn-card-video__cover">',
      '    <div class="bili-dyn-card-video__cover-shadow">',
      durationHtml,
      '    </div>',
      '  </div>',
      '  <div class="bili-dyn-card-video__title">视频标题</div>',
      '</div>',
    ].join('');
  } else {
    body = NON_VIDEO_MARKUP[item.kind] ?? NON_VIDEO_MARKUP.text;
  }
  return (
    `<div class="bili-dyn-list__item" data-fixture-id="${fixtureId}">` +
    `<div class="bili-dyn-item" data-fixture-id="${fixtureId}">${body}</div>` +
    `</div>`
  );
}

export function itemsMarkup(items) {
  return items.map(itemMarkup).join('');
}

/** 追加动态项（模拟无限滚动新加载的节点），返回新增的 .bili-dyn-list__item 数组 */
export function appendItems(document, items, { prefix = 'new' } = {}) {
  const container = document.querySelector('.bili-dyn-list__items');
  if (!container) throw new Error('缺 .bili-dyn-list__items 容器');
  const base = getItems(document).length;
  const withIds = items.map((item, i) => ({ ...item, id: item.id ?? `${prefix}-${base + i}` }));
  const template = document.createElement('template');
  template.innerHTML = itemsMarkup(withIds).trim();
  const nodes = [...template.content.children];
  for (const node of nodes) container.appendChild(node);
  return nodes;
}

/**
 * @param {string} [activeTab] 哪个 tab 处于 active 态：
 *   'all'（默认，模拟真实首页初始状态）| 'video' | 'pgc' | 'article'
 */
/**
 * 默认 activeTab 用 'video'：SPEC 规定筛选模块只在「视频投稿」标签页工作
 * （非视频投稿 tab 下模块整体隐藏、且不施加任何筛选）。
 * 需要测试「全部/追番/专栏」下静默时，显式传 activeTab。
 */
export function tabsMarkup(activeTab = 'video') {
  const tabs = [
    ['all', '全部'],
    ['video', '视频投稿'],
    ['pgc', '追番追剧'],
    ['article', '专栏'],
  ];
  let html = '<div class="bili-dyn-list-tabs">';
  for (const [key, label] of tabs) {
    const cls = key === activeTab ? ' active' : '';
    html += '<div class="bili-dyn-list-tabs__item' + cls + '">' + label + '</div>';
  }
  html += '</div>';
  return html;
}

export function pageHtml({
  items = DEFAULT_ITEMS,
  withTabs = true,
  activeTab = 'video',
  withItems = true,
  withListRoot = true,
  withLoadMore = false,
  withNoMore = false,
} = {}) {
  const inner = [
    withTabs ? tabsMarkup(activeTab) : '',
    withItems ? `<div class="bili-dyn-list__items">${itemsMarkup(items)}</div>` : '',
    withLoadMore ? '<div class="bili-dyn-list__loadmore">加载更多</div>' : '',
    withNoMore ? '<div class="bili-dyn-list-no-more">没有更多了</div>' : '',
  ].join('\n');
  const list = withListRoot ? `<div class="bili-dyn-list">${inner}</div>` : inner;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>B站动态</title></head>
<body>
  <div id="app">${list}</div>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* jsdom 环境                                                         */
/* ------------------------------------------------------------------ */

const activePages = new Set();

function installJsdomPatches(window) {
  // rAF / cAF：jsdom 默认没有（即使 pretendToBeVisual 也未必稳定），用 setTimeout 实现
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);

  // matchMedia
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });

  // Pointer capture / scrollIntoView：jsdom 未实现
  if (window.Element) {
    const proto = window.Element.prototype;
    if (!proto.setPointerCapture) proto.setPointerCapture = function setPointerCapture() {};
    if (!proto.releasePointerCapture) proto.releasePointerCapture = function releasePointerCapture() {};
    if (!proto.hasPointerCapture) proto.hasPointerCapture = function hasPointerCapture() { return false; };
    if (!proto.scrollIntoView) proto.scrollIntoView = function scrollIntoView() {};
  }

  // 滚动：jsdom 未实现，避免 "Not implemented" jsdomError
  window.scrollTo = function scrollTo() {};
  window.scrollBy = function scrollBy() {};
  window.scroll = function scroll() {};
  if (window.Element) {
    const el = window.Element.prototype;
    if (!el.scrollTo) el.scrollTo = function scrollTo() {};
    if (!el.scrollBy) el.scrollBy = function scrollBy() {};
  }
}

function makeThrowingStorage() {
  const boom = () => {
    throw new Error('storage boom');
  };
  return {
    getItem: boom,
    setItem: boom,
    removeItem: boom,
    clear: boom,
    key: boom,
    get length() {
      throw new Error('storage boom');
    },
  };
}

function installBrokenStorage(window) {
  const throwing = makeThrowingStorage();
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          return throwing;
        },
      });
    } catch {
      /* 忽略：环境不支持覆盖时跳过 */
    }
  }
}

/**
 * 创建一个 jsdom 页面。
 * @param {object} opts
 * @param {Array}  [opts.items]          动态项描述
 * @param {boolean}[opts.withTabs]        是否含 `.bili-dyn-list-tabs`
 * @param {boolean}[opts.withItems]       是否含 `.bili-dyn-list__items`
 * @param {boolean}[opts.withListRoot]    是否含 `.bili-dyn-list`
 * @param {string} [opts.url]             jsdom url（默认 t.bilibili.com）
 * @param {string} [opts.html]            完全自定义 HTML（优先级最高）
 * @param {object} [opts.gm]              GM_* stub 对象
 * @param {boolean}[opts.storageThrows]   让 localStorage/sessionStorage 抛异常
 * @returns {object} page
 */
export function createPage(opts = {}) {
  const {
    url = SCRIPT_URL,
    html,
    gm = null,
    storageThrows = false,
  } = opts;

  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    consoleErrors.push(`jsdomError: ${err && err.message ? err.message : String(err)}`);
  });
  virtualConsole.on('error', (...args) => {
    consoleErrors.push(`console.error: ${args.map((a) => String(a)).join(' ')}`);
  });

  const dom = new JSDOM(html ?? pageHtml(opts), {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });

  const window = dom.window;
  const document = window.document;
  installJsdomPatches(window);
  if (gm) Object.assign(window, gm);
  if (storageThrows) installBrokenStorage(window);

  const page = {
    dom,
    window,
    document,
    consoleErrors,
    ctx: dom.getInternalVMContext(),
    ready: async () => {
      if (document.readyState === 'complete') return;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        const timer = setTimeout(finish, 3000);
        window.addEventListener(
          'load',
          () => {
            clearTimeout(timer);
            finish();
          },
          { once: true },
        );
      });
    },
    close: () => {
      activePages.delete(page);
      try {
        window.close();
      } catch {
        /* 忽略 */
      }
    },
  };
  activePages.add(page);
  return page;
}

/** 关闭本文件里创建过的全部页面（测试文件 after() 调用，保证隔离 & 进程退出） */
export function closeAllPages() {
  for (const page of [...activePages]) page.close();
  activePages.clear();
}

/* ------------------------------------------------------------------ */
/* 脚本加载                                                           */
/* ------------------------------------------------------------------ */

function readScriptSource() {
  return fs.readFileSync(SCRIPT_PATH, 'utf8');
}

/**
 * 在 jsdom window 上下文执行用户脚本（@run-at document-idle 的 IIFE，直接执行即可）。
 * @returns {Promise<object>} handle
 */
export async function loadScript(page, { waitMs = 80 } = {}) {
  await page.ready();
  const source = readScriptSource();
  let scriptError = null;
  try {
    vm.runInContext(source, page.ctx, { filename: SCRIPT_PATH });
  } catch (err) {
    scriptError = err;
  }
  await sleep(waitMs);

  const api = page.window.__BDDF__;
  const handle = {
    page,
    window: page.window,
    document: page.window.document,
    api,
    scriptError,
    consoleErrors: page.consoleErrors,
    /** 等 MutationObserver / rAF / 定时器回调落地 */
    tick: (ms = 120) => sleep(ms),
    evalIn: (code) => vm.runInContext(code, page.ctx),
    close: () => page.close(),
    /** 断言性取 API：失败信息更直白 */
    requireApi() {
      if (scriptError) {
        throw new Error(`脚本执行时抛错：\n${scriptError.stack || scriptError}`);
      }
      if (!api) {
        throw new Error('脚本执行后未暴露 window.__BDDF__');
      }
      return api;
    },
    /** 第二次加载脚本（验证幂等 / 重复注入） */
    async reload(wait = 80) {
      let err = null;
      try {
        vm.runInContext(readScriptSource(), page.ctx, { filename: SCRIPT_PATH });
      } catch (e) {
        err = e;
      }
      await sleep(wait);
      return err;
    },
  };
  return handle;
}

/** 一步到位：建页面 → 等 load → 执行脚本 */
export async function boot(opts = {}) {
  const page = createPage(opts);
  return loadScript(page, opts);
}

/* ------------------------------------------------------------------ */
/* DOM 断言工具                                                       */
/* ------------------------------------------------------------------ */

export function getItems(document) {
  return [...document.querySelectorAll('.bili-dyn-list__item')];
}

/** SPEC 3.4.4：隐藏 = class + 属性，二者都要在 */
export function isHidden(el) {
  return el.classList.contains('bddf-hidden') || el.getAttribute('data-bddf-hidden') === '1';
}

export function hiddenFlags(el) {
  return {
    cls: el.classList.contains('bddf-hidden'),
    attr: el.getAttribute('data-bddf-hidden'),
  };
}

/** 每项状态快照，便于断言/调试 */
export function snapshot(document) {
  return getItems(document).map((el) => ({
    id: el.getAttribute('data-fixture-id'),
    hidden: isHidden(el),
    hasVideo: !!el.querySelector('.bili-dyn-card-video'),
    duration:
      el.querySelector('.duration-time')?.textContent?.trim() ?? null,
  }));
}

export function itemDurationText(item) {
  return item.querySelector('.duration-time')?.textContent?.trim() ?? null;
}

/**
 * 跨 realm 归一化：`vm.runInContext` 里创建的对象原型来自 jsdom realm，
 * 与 Node 主 realm 的 Object.prototype 不同，`assert.deepEqual` 会因原型不等而失败。
 * 这里深拷贝成主 realm 的纯对象/数组，并保留 Infinity。
 */
export function plain(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plain);
  const out = {};
  for (const key of Object.keys(value)) out[key] = plain(value[key]);
  return out;
}

export function itemById(document, id) {
  return document.querySelector(`.bili-dyn-list__item[data-fixture-id="${id}"]`);
}

/** 解析计数文本「显示 x / y」 */
export function getCounts(document) {
  const text = document.querySelector('.bddf-count')?.textContent ?? '';
  const match = /显示\s*(\d+)\s*\/\s*(\d+)/.exec(text);
  if (!match) return { text, visible: null, total: null };
  return { text, visible: Number(match[1]), total: Number(match[2]) };
}

export function barOf(document) {
  return document.querySelector('.bddf-bar');
}

/** SPEC 3.4.4 样式规则是否已注入 */
export function hasHiddenStyle(document) {
  const css = [...document.querySelectorAll('style')]
    .map((s) => s.textContent.replace(/\s+/g, ''))
    .join('');
  return css.includes('.bili-dyn-list__item.bddf-hidden') && css.includes('display:none!important');
}

/** 把持久化值（localStorage 字符串 / GM 原始值）还原成 JS 值 */
export function decodeStored(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  const text = String(raw).trim();
  if (text === 'Infinity') return Infinity;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 读出全部 bddf.* 键（localStorage） */
export function readLocalStorage(window) {
  const out = new Map();
  const ls = window.localStorage;
  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    out.set(key, ls.getItem(key));
  }
  return out;
}

/** 把 A 页面的 localStorage 复制到 B 页面（模拟浏览器重开 / 刷新） */
export function copyLocalStorage(fromWindow, toWindow) {
  const entries = readLocalStorage(fromWindow);
  for (const [key, value] of entries) toWindow.localStorage.setItem(key, value);
  return entries;
}

/** 等待某个条件成立（轮询），超时抛错 */
export async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await sleep(intervalMs);
  }
}

/**
 * 记录“向下滚动”的意图（SPEC 3.5 自动加载要求以滚动触发原生加载）。
 * 脚本可能用 window.scrollTo / window.scrollBy / scrollTop 赋值 / dispatchEvent(scroll)，
 * 这里全部计数，避免把测试绑定到某一种实现方式上。
 */
export function trackScroll(page) {
  const { window, document } = page;
  const record = { count: 0, at: [] };
  const mark = (via) => {
    record.count += 1;
    record.at.push({ via, t: Date.now() });
  };

  const wrap = (obj, name) => {
    const original = obj[name];
    if (typeof original !== 'function') return;
    obj[name] = function wrapped(...args) {
      mark(name);
      try {
        return original.apply(obj, args);
      } catch {
        return undefined; // jsdom 未实现的滚动不应让脚本崩掉
      }
    };
  };

  wrap(window, 'scrollTo');
  wrap(window, 'scrollBy');
  wrap(window, 'scroll');
  wrap(window.Element.prototype, 'scrollIntoView');
  wrap(window.Element.prototype, 'scrollTo');
  wrap(window.Element.prototype, 'scrollBy');

  for (const target of [document.documentElement, document.body]) {
    if (!target) continue;
    let value = 0;
    try {
      Object.defineProperty(target, 'scrollTop', {
        configurable: true,
        get: () => value,
        set: (next) => {
          if (Number(next) > 0) mark('scrollTop');
          value = Number(next) || 0;
        },
      });
    } catch {
      /* 忽略 */
    }
  }

  const onScroll = () => mark('scroll-event');
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('scroll', onScroll, { passive: true });

  record.reset = () => {
    record.count = 0;
    record.at.length = 0;
  };
  return record;
}
