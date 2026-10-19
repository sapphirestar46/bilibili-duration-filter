// ==UserScript==
// @name         B站动态 · 视频时长筛选
// @name:en      Bilibili Dynamic - Video Duration Filter
// @namespace    https://github.com/sapphirestar46/bilibili-duration-filter
// @version      1.6.0
// @description  在 B 站动态页「视频投稿」标签下注入双滑块时长筛选条，按视频时长区间过滤动态卡片
// @description:en  Add a dual-range duration filter to Bilibili's dynamic (feed) page video tab.
// @author       sapphirestar
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// @homepageURL  https://github.com/sapphirestar46/bilibili-duration-filter
// @supportURL   https://github.com/sapphirestar46/bilibili-duration-filter/issues
// @match        https://t.bilibili.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

/* eslint-disable */
(function () {
  'use strict';

  /* ================================================================== */
  /* 常量                                                                */
  /* ================================================================== */

  const VERSION = '1.6.0';
  const STYLE_ID = 'bddf-style';
  /** 滑块定义域上限：3 小时；到达右端表示「不限」 */
  const MAX_SEC = 10800;
  // （已弃用对数刻度：LOG_MAX 不再使用，改为分段线性映射）
  /** 双滑块最小间隔（秒），避免两端重合导致无法拖回 */
  const MIN_GAP = 1;
  const AUTOFILL_DELAY = 1200; // 自动加载每轮间隔（≥1200ms，勿低于此值）
  /**
   * 目标：凑够这么多条「可见视频」就停手。
   * B 站动态接口默认 page_size 就是 20，所以这里对齐「一页」的观感：
   * 当筛选条件很严（比如 ≥1 小时）导致整屏只剩一两条时，自动往下补到接近一页。
   */
  const AUTOFILL_TARGET = 20;
  /** 轮数硬上限：每次「补充」最多触发 20 轮 */
  const AUTOFILL_MAX_ROUNDS = 20;
  /** 时间硬上限：从本轮补充开始计时，超过 30 秒无论如何都停 */
  const AUTOFILL_MAX_DURATION = 30000;
  const PASS_DELAY = 40; // MutationObserver 合并窗口

  const PRESETS = [
    { min: 0, max: Infinity, label: '不限' },
    { min: 0, max: 60, label: '≤1分钟' },
    { min: 60, max: 300, label: '1–5分钟' },
    { min: 300, max: 600, label: '5–10分钟' },
    { min: 600, max: 1800, label: '10–30分钟' },
    { min: 1800, max: 3600, label: '30–60分钟' },
    { min: 3600, max: Infinity, label: '≥1小时' },
    { min: 600, max: Infinity, label: '≥10分钟' },
    { min: 1800, max: Infinity, label: '≥30分钟' },
  ];

  /* ================================================================== */
  /* 运行时状态                                                          */
  /* ================================================================== */

  const DEFAULTS = {
    enabled: true,
    min: 0,
    max: Infinity,
    onlyVideo: false,
    autofill: true,
    collapsed: false,
  };

  /** 已持久化 / 内存回退的键值（key → 原始值） */
  const memStore = new Map();
  /** 当前状态 */
  const state = Object.assign({}, DEFAULTS);

  let barNode = null; // .bddf-bar
  let refs = null; // 内部元素引用
  let destroyed = false;
  let eventsBound = false;

  let observer = null;
  let watchdogTimer = null;
  let passTimer = null;
  let autofillTimer = null;
  let autofillRounds = 0;
  /** 连续多少轮没有加载出新内容（用于判断是否真的到底） */
  let autofillStalls = 0;
  /** 本轮补充的开始时间，0 表示当前没有进行中的补充 */
  let autofillStartedAt = 0;
  let dragging = null; // 'min' | 'max' | null
  let scanQueued = false;
  let resizeObserver = null;

  /* ================================================================== */
  /* 存储层：GM → localStorage → 内存                                    */
  /* ================================================================== */

  function gmAvailable() {
    try {
      return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    } catch (err) {
      return false;
    }
  }

  const HAS_GM = gmAvailable();

  function readStore(key) {
    if (HAS_GM) {
      try {
        return GM_getValue(key, undefined);
      } catch (err) {
        /* GM 异常 → 回退 localStorage */
      }
    }
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null && raw !== undefined) return raw;
      return memStore.get(key);
    } catch (err) {
      return memStore.get(key);
    }
  }

  function writeStore(key, value) {
    // 先写内存，保证任何存储都不可用时功能仍正常
    memStore.set(key, value);
    if (HAS_GM) {
      try {
        GM_setValue(key, value);
        return;
      } catch (err) {
        /* GM 写失败 → 回退 localStorage */
      }
    }
    try {
      window.localStorage.setItem(key, String(value));
    } catch (err) {
      /* 全部不可用：仅内存 */
    }
  }

  function toBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  }

  function toSeconds(value, fallback) {
    if (typeof value === 'number') return Number.isNaN(value) ? fallback : value;
    if (value === 'Infinity' || value === Infinity) return Infinity;
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isNaN(n) ? fallback : n;
  }

  function loadState() {
    state.enabled = toBoolean(readStore('bddf.enabled'), DEFAULTS.enabled);
    state.min = clampSec(toSeconds(readStore('bddf.min'), DEFAULTS.min));
    const storedMax = toSeconds(readStore('bddf.max'), DEFAULTS.max);
    state.max = storedMax === Infinity ? Infinity : clampSec(storedMax);
    if (state.max !== Infinity && state.max < state.min) state.max = state.min;
    state.onlyVideo = toBoolean(readStore('bddf.onlyVideo'), DEFAULTS.onlyVideo);
    state.autofill = toBoolean(readStore('bddf.autofill'), DEFAULTS.autofill);
    state.collapsed = toBoolean(readStore('bddf.collapsed'), DEFAULTS.collapsed);
  }

  function persistRange() {
    writeStore('bddf.min', state.min);
    writeStore('bddf.max', state.max === Infinity ? 'Infinity' : state.max);
  }

  function persistOptions() {
    writeStore('bddf.onlyVideo', state.onlyVideo);
    writeStore('bddf.autofill', state.autofill);
    writeStore('bddf.collapsed', state.collapsed);
  }

  function persistEnabled() {
    writeStore('bddf.enabled', state.enabled);
  }

  /* ================================================================== */
  /* 纯函数：时长解析 / 格式化 / 刻度映射                                */
  /* ================================================================== */

  /**
   * 解析 B 站时长文本。
   * 支持 `mm:ss` 与 `h:mm:ss`，分/秒必须 0..59；非法输入返回 null。
   */
  function parseDuration(input) {
    if (typeof input !== 'string') return null;
    const text = input.trim();
    if (!text) return null;

    // h:mm:ss —— 小时位任意非负整数
    const hms = /^(\d{1,4}):(\d{1,2}):(\d{2})$/.exec(text);
    if (hms) {
      const hours = Number(hms[1]);
      const minutes = Number(hms[2]);
      const seconds = Number(hms[3]);
      if (minutes > 59 || seconds > 59) return null;
      return hours * 3600 + minutes * 60 + seconds;
    }

    // mm:ss —— 分钟位最多两位且须 ≤ 59
    const ms = /^(\d{1,3}):(\d{2})$/.exec(text);
    if (ms) {
      const minutes = Number(ms[1]);
      const seconds = Number(ms[2]);
      if (minutes > 59 || seconds > 59) return null;
      return minutes * 60 + seconds;
    }

    return null;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * 秒 → 时长文本。Infinity 表示不限，null/NaN 表示未知。
   */
  function formatDuration(input) {
    if (input === Infinity || input === 'Infinity') return '不限';
    if (input === null || input === undefined) return '--:--';
    const total = Number(input);
    if (!Number.isFinite(total) || Number.isNaN(total)) return '--:--';
    const sec = Math.max(0, Math.round(total));
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    if (hours > 0) return hours + ':' + pad2(minutes) + ':' + pad2(seconds);
    return pad2(minutes) + ':' + pad2(seconds);
  }

  function clampSec(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return n === Infinity ? MAX_SEC : 0;
    if (n < 0) return 0;
    if (n > MAX_SEC) return MAX_SEC;
    return Math.round(n);
  }

  /**
   * 秒 → 0..1 的轨道位置。
   *
   * 为什么不用对数刻度：对数映射下 1 分钟就占了轨道 44%，而 1 分钟内的视频本来就极少，
   * 用户想筛「10 分钟以上 / 1 小时以上」时可选区域被挤在右侧很小的范围里，非常难拖。
   *
   * 改用分段线性：
   *   0 : 00 – 10:00  → 占据左侧 30%   （保留短视频的精细度）
   *   10:00 – 3:00:00 → 占据右侧 70%   （长视频区间被放大，便于筛选）
   */
  const PIVOT_SEC = 600; // 10 分钟：两段的交界
  const PIVOT_NORM = 0.3; // 交界处的轨道位置

  function normOf(sec) {
    if (sec === Infinity || sec >= MAX_SEC) return 1;
    const s = Math.max(0, Math.min(MAX_SEC, Number(sec) || 0));
    if (s <= PIVOT_SEC) return (s / PIVOT_SEC) * PIVOT_NORM;
    return PIVOT_NORM + ((s - PIVOT_SEC) / (MAX_SEC - PIVOT_SEC)) * (1 - PIVOT_NORM);
  }

  /** 0..1 → 秒；右端返回 Infinity（不限） */
  function secOfNorm(norm) {
    const n = Math.max(0, Math.min(1, Number(norm) || 0));
    if (n >= 0.999) return Infinity;
    let sec;
    if (n <= PIVOT_NORM) {
      sec = (n / PIVOT_NORM) * PIVOT_SEC;
    } else {
      sec = PIVOT_SEC + ((n - PIVOT_NORM) / (1 - PIVOT_NORM)) * (MAX_SEC - PIVOT_SEC);
    }
    return Math.round(sec);
  }

  function pct(norm) {
    return (Math.max(0, Math.min(1, norm)) * 100).toFixed(3) + '%';
  }

  /* ================================================================== */
  /* 页面判定 / 锚点                                                     */
  /* ================================================================== */

  function isTargetPage() {
    try {
      const protocol = window.location.protocol;
      // 本地 demo / 离线预览：file:// 也允许挂载（仍需页面上存在动态列表锚点）
      if (protocol === 'file:') return true;
      const host = window.location.hostname;
      const path = window.location.pathname || '/';
      if (host === 't.bilibili.com') return true;
      if (host === 'www.bilibili.com') return path === '/' || path === '/index.html';
      return false;
    } catch (err) {
      return false;
    }
  }

  /**
   * 当前是否处于「视频投稿」标签页。
   *
   * 自动加载更多是一种「为了凑够 video 条数而主动滚动」的激进行为，
   * 只有在视频投稿这个我们真正关心的列表里才可以接受；
   * 在「全部 / 追番追剧 / 专栏」下滚动会打扰用户浏览无关内容，必须禁用。
   */
  function isVideoTabActive() {
    try {
      const tabs = document.querySelectorAll('.bili-dyn-list-tabs__item');
      if (!tabs.length) return true; // 没有 tab 栏（或被隐藏）时不做限制
      for (let i = 0; i < tabs.length; i += 1) {
        const tab = tabs[i];
        const active = tab.classList.contains('active');
        if (!active) continue;
        const text = (tab.textContent || '').trim();
        // 命中「视频投稿」才算
        return text.indexOf('视频') !== -1;
      }
      // 有 tab 但没有任何 active（异常态）：保守处理，视为非视频投稿
      return false;
    } catch (err) {
      return false;
    }
  }

  function itemsContainer() {
    return document.querySelector('.bili-dyn-list__items');
  }

  function tabsContainer() {
    return document.querySelector('.bili-dyn-list-tabs');
  }

  /* ================================================================== */
  /* 样式                                                                */
  /* ================================================================== */

  const CSS = [
    // top 由 JS 动态计算（预留 B 站固定页头的高度），见 syncStickyTop()
    '.bddf-bar{position:sticky;top:var(--bddf-top,0px);z-index:50;margin:8px 0 12px;padding:10px 14px 12px;',
    'border-radius:8px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.04);',
    'font-size:12px;line-height:1.5;color:#18191c;box-sizing:border-box;user-select:none;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    '.bddf-bar *{box-sizing:border-box}',
    '.bddf-bar .bddf-head{display:flex;align-items:center;gap:10px;min-height:22px}',
    '.bddf-bar .bddf-title{font-size:13px;font-weight:600;color:#18191c;white-space:nowrap}',
    '.bddf-bar .bddf-count{margin-left:auto;color:#9499a0;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.bddf-bar.bddf-empty .bddf-count{color:#fb7299;font-weight:600}',
    '.bddf-bar .bddf-switch{display:inline-flex;align-items:center;cursor:pointer}',
    '.bddf-bar .bddf-switch input{width:32px;height:16px;margin:0;cursor:pointer;accent-color:#fb7299}',
    '.bddf-bar .bddf-switch i{display:none}',
    '.bddf-bar .bddf-reset,.bddf-bar .bddf-collapse{border:1px solid #e3e5e7;border-radius:6px;background:#fff;',
    'color:#61666d;font-size:12px;padding:2px 10px;cursor:pointer;font-family:inherit;transition:all .15s}',
    '.bddf-bar .bddf-reset:hover,.bddf-bar .bddf-collapse:hover{border-color:#fb7299;color:#fb7299}',
    '.bddf-bar .bddf-body{margin-top:8px}',
    '.bddf-bar[data-collapsed="1"] .bddf-body{display:none}',
    // 非「视频投稿」标签页：整个模块不出现
    '.bddf-bar[data-hidden="1"]{display:none!important}',
    // 停用状态：整体变灰 + 滑块不可拖 + 明确提示，避免「拖了没反应」的困惑
    '.bddf-bar[data-enabled="0"]{opacity:.55}',
    '.bddf-bar[data-enabled="0"] .bddf-slider-wrap{pointer-events:none}',
    '.bddf-bar[data-enabled="0"] .bddf-title::after{content:"（已停用）";color:#fb7299;font-weight:400;font-size:12px}',
    '.bddf-bar .bddf-slider-wrap{position:relative;height:38px;margin:4px 6px 0;touch-action:none}',
    '.bddf-bar .bddf-track{position:absolute;left:0;right:0;top:22px;height:6px;border-radius:3px;',
    'background:#f1f2f3;cursor:pointer}',
    '.bddf-bar .bddf-range{position:absolute;left:0;right:0;top:0;bottom:0;height:6px;border-radius:3px;',
    'background:#fb7299;pointer-events:none}',
    '.bddf-bar .bddf-thumb{position:absolute;top:22px;width:18px;height:18px;margin:-9px 0 0 -9px;padding:0;',
    'border-radius:50%;border:2px solid #fb7299;background:#fff;cursor:grab;',
    'box-shadow:0 1px 4px rgba(0,0,0,.15);z-index:2}',
    '.bddf-bar .bddf-thumb:active,.bddf-bar.bddf-dragging .bddf-thumb{cursor:grabbing;transform:scale(1.1)}',
    '.bddf-bar .bddf-thumb:focus{outline:none;box-shadow:0 0 0 3px rgba(251,114,153,.35)}',
    '.bddf-bar .bddf-bubble{position:absolute;top:0;transform:translate(-50%,0);background:#18191c;color:#fff;',
    'border-radius:4px;padding:1px 6px;font-size:11px;white-space:nowrap;pointer-events:none;z-index:3;',
    'font-variant-numeric:tabular-nums}',
    // ===== 紧凑模式：滑动后筛选条吸顶时，压缩成「只有滑条」的窄条 =====
    // 触发方式：JS 检测到筛选条已吸顶（被顶部页头挡住后仍在视口内）时加 .bddf-compact
    '.bddf-bar.bddf-compact{padding:14px 10px 6px;margin:4px 0 8px;box-shadow:0 2px 8px rgba(0,0,0,.12)}',
    '.bddf-bar.bddf-compact .bddf-head{display:none}',
    '.bddf-bar.bddf-compact .bddf-presets{display:none}',
    '.bddf-bar.bddf-compact .bddf-opts{display:none}',
    '.bddf-bar.bddf-compact .bddf-body{margin-top:0}',
    '.bddf-bar.bddf-compact .bddf-slider-wrap{height:26px;margin:0 6px}',
    '.bddf-bar.bddf-compact .bddf-track{top:16px;height:4px}',
    '.bddf-bar.bddf-compact .bddf-range{height:4px}',
    '.bddf-bar.bddf-compact .bddf-thumb{top:16px;width:15px;height:15px;margin:-7.5px 0 0 -7.5px}',
    '.bddf-bar.bddf-compact .bddf-bubble{font-size:10px;padding:0 4px;line-height:14px;top:1px}',

    '.bddf-bar .bddf-presets{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
    '.bddf-bar .bddf-preset{border:1px solid #e3e5e7;border-radius:12px;background:#f6f7f8;color:#61666d;',
    'font-size:12px;padding:2px 10px;cursor:pointer;font-family:inherit;transition:all .15s}',
    '.bddf-bar .bddf-preset:hover{border-color:#fb7299;color:#fb7299}',
    '.bddf-bar .bddf-preset.active{background:#fb7299;border-color:#fb7299;color:#fff}',
    '.bddf-bar .bddf-opts{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-top:8px;color:#61666d}',
    '.bddf-bar .bddf-opt{display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}',
    '.bddf-bar .bddf-opt input{margin:0;cursor:pointer;accent-color:#fb7299}',
    '.bddf-bar .bddf-hint{color:#9499a0;margin-left:auto;white-space:nowrap}',
    '.bili-dyn-list__item.bddf-hidden{display:none!important}',
  ].join('');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeStyle() {
    const style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  /* ================================================================== */
  /* UI 构建                                                             */
  /* ================================================================== */

  function presetMarkup() {
    return PRESETS.map(function (p) {
      return (
        '<button class="bddf-preset" type="button" data-min="' +
        p.min +
        '" data-max="' +
        (p.max === Infinity ? 'Infinity' : p.max) +
        '">' +
        p.label +
        '</button>'
      );
    }).join('');
  }

  function createBar() {
    const bar = document.createElement('div');
    bar.className = 'bddf-bar';
    bar.setAttribute('data-bddf', '1');
    bar.setAttribute('data-collapsed', '0');
    // 初始按当前 tab 决定可见性，避免在非视频投稿 tab 下闪现
    try {
      bar.setAttribute('data-hidden', isVideoTabActive() ? '0' : '1');
    } catch (err) {
      bar.setAttribute('data-hidden', '0');
    }
    bar.innerHTML =
      '<div class="bddf-head">' +
      '<span class="bddf-title">时长筛选</span>' +
      '<label class="bddf-switch" title="启用 / 停用筛选">' +
      '<input type="checkbox" class="bddf-enabled" aria-label="启用时长筛选">' +
      '<i></i>' +
      '</label>' +
      '<span class="bddf-count">显示 0 / 0</span>' +
      '<button class="bddf-reset" type="button" title="恢复默认设置">重置</button>' +
      '<button class="bddf-collapse" type="button">收起</button>' +
      '</div>' +
      '<div class="bddf-body">' +
      '<div class="bddf-slider-wrap">' +
      '<div class="bddf-track"><div class="bddf-range"></div></div>' +
      '<button class="bddf-thumb bddf-thumb--min" type="button" role="slider" ' +
      'aria-label="最短时长" aria-valuemin="0" aria-valuemax="' +
      MAX_SEC +
      '" aria-valuenow="0"></button>' +
      '<button class="bddf-thumb bddf-thumb--max" type="button" role="slider" ' +
      'aria-label="最长时长" aria-valuemin="0" aria-valuemax="' +
      MAX_SEC +
      '" aria-valuenow="' +
      MAX_SEC +
      '"></button>' +
      '<span class="bddf-bubble bddf-bubble--min">00:00</span>' +
      '<span class="bddf-bubble bddf-bubble--max">不限</span>' +
      '</div>' +
      '<div class="bddf-presets">' +
      presetMarkup() +
      '</div>' +
      '<div class="bddf-opts">' +
      '<label class="bddf-opt"><input type="checkbox" class="bddf-only-video">仅显示视频投稿</label>' +
      '<label class="bddf-opt" title="仅在「视频投稿」标签页生效，凑够 20 条即可">' +
      '<input type="checkbox" class="bddf-autofill" checked>自动加载（仅视频投稿）</label>' +
      '<span class="bddf-hint">拖动两端滑块按视频时长筛选，双击滑块恢复默认</span>' +
      '</div>' +
      '</div>';
    return bar;
  }

  function collectRefs(bar) {
    return {
      enabled: bar.querySelector('.bddf-enabled'),
      count: bar.querySelector('.bddf-count'),
      reset: bar.querySelector('.bddf-reset'),
      collapse: bar.querySelector('.bddf-collapse'),
      body: bar.querySelector('.bddf-body'),
      wrap: bar.querySelector('.bddf-slider-wrap'),
      track: bar.querySelector('.bddf-track'),
      range: bar.querySelector('.bddf-range'),
      thumbMin: bar.querySelector('.bddf-thumb--min'),
      thumbMax: bar.querySelector('.bddf-thumb--max'),
      bubbleMin: bar.querySelector('.bddf-bubble--min'),
      bubbleMax: bar.querySelector('.bddf-bubble--max'),
      onlyVideo: bar.querySelector('.bddf-only-video'),
      autofill: bar.querySelector('.bddf-autofill'),
      presets: Array.prototype.slice.call(bar.querySelectorAll('.bddf-preset')),
    };
  }

  /* ================================================================== */
  /* UI 同步                                                             */
  /* ================================================================== */

  function updateSliderUI() {
    if (!refs) return;
    const nMin = normOf(state.min);
    const nMax = normOf(state.max);

    refs.thumbMin.style.left = pct(nMin);
    refs.thumbMax.style.left = pct(nMax);
    refs.range.style.left = pct(nMin);
    refs.range.style.right = pct(1 - nMax);
    refs.bubbleMin.style.left = pct(nMin);
    refs.bubbleMax.style.left = pct(nMax);

    refs.bubbleMin.textContent = formatDuration(state.min);
    refs.bubbleMax.textContent = formatDuration(state.max);

    refs.thumbMin.setAttribute('aria-valuenow', String(clampSec(state.min)));
    refs.thumbMax.setAttribute(
      'aria-valuenow',
      String(state.max === Infinity ? MAX_SEC : clampSec(state.max))
    );

    // 预设高亮
    for (let i = 0; i < refs.presets.length; i += 1) {
      const btn = refs.presets[i];
      const pMin = Number(btn.getAttribute('data-min'));
      const rawMax = btn.getAttribute('data-max');
      const pMax = rawMax === 'Infinity' ? Infinity : Number(rawMax);
      const active = pMin === state.min && pMax === state.max;
      if (active) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  }

  /**
   * 计算「B 站固定页头」遮住了顶部多少像素，并把结果写进 CSS 变量 --bddf-top。
   *
   * 为什么需要：筛选条用 position:sticky 吸顶，而 B 站头部是 position:fixed 且层级更高
   * （.z-top-container / .bili-header），两者都贴顶部时会重叠，导致筛选条上半截被挡。
   * 页头高度会随登录态、滚动收窄、不同页面而变化，所以不能写死，必须运行时测量。
   */
  function syncStickyTop() {
    if (!barNode) return;
    let offset = 0;
    try {
      // 收集所有「固定/吸顶且贴在视口顶部」的候选元素
      const candidates = document.querySelectorAll(
        '.z-top-container, #bili-header-container, .bili-header, .bili-header__bar, .mini-header, .fixed-header'
      );
      for (let i = 0; i < candidates.length; i += 1) {
        const el = candidates[i];
        if (!el.isConnected) continue;
        const cs = window.getComputedStyle(el);
        if (!cs) continue;
        const positioned = cs.position === 'fixed' || cs.position === 'sticky';
        if (!positioned) continue;
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0) continue;
        // 只统计确实贴在视口上沿（允许 2px 误差）的元素
        if (rect.top > 2) continue;
        // 被它盖住的下沿位置
        const covered = Math.max(0, rect.bottom);
        if (covered > offset) offset = covered;
      }
    } catch (err) {
      offset = 0;
    }
    barNode.style.setProperty('--bddf-top', offset + 'px');
    barNode.setAttribute('data-header-offset', String(Math.round(offset)));

    // 吸顶判定：筛选条原本在文档流里（top 较大），一旦贴到顶部偏移位置就进入紧凑模式
    updateCompactMode(offset);
  }

  /**
   * 判断筛选条是否已经「吸顶」，吸顶时压缩成只保留滑条的窄条。
   *
   * 判定依据：sticky 元素的 getBoundingClientRect().top 会停在 var(--bddf-top) 处，
   * 与「它原本的自然位置」相差较大即说明已经吸顶。这里用 offset 作为基准，
   * 并留 1px 容差避免抖动。
   */
  function updateCompactMode(offset) {
    if (!barNode) return;
    // 用户手动收起时保持收起态，不再叠加紧凑样式
    if (state.collapsed) {
      barNode.classList.remove('bddf-compact');
      return;
    }
    let compact = false;
    try {
      const rect = barNode.getBoundingClientRect();
      // rect.top 已贴在 top 偏移处，且页面确实滚动过了（否则不会吸顶）
      const stuckAtTop = Math.abs(rect.top - offset) <= 2;
      compact = stuckAtTop && (window.scrollY || window.pageYOffset || 0) > 40;
    } catch (err) {
      compact = false;
    }
    if (compact) barNode.classList.add('bddf-compact');
    else barNode.classList.remove('bddf-compact');
  }

  function updateUI() {
    if (!refs || !barNode) return;
    if (refs.enabled) refs.enabled.checked = state.enabled;
    if (refs.onlyVideo) refs.onlyVideo.checked = state.onlyVideo;
    if (refs.autofill) refs.autofill.checked = state.autofill;

    barNode.setAttribute('data-collapsed', state.collapsed ? '1' : '0');
    // 停用时要让用户一眼看出来，否则「拖了没反应」会被误当成 bug
    barNode.setAttribute('data-enabled', state.enabled ? '1' : '0');
    if (refs.body) refs.body.style.display = state.collapsed ? 'none' : '';
    if (refs.collapse) refs.collapse.textContent = state.collapsed ? '展开' : '收起';

    updateSliderUI();
  }

  /* ================================================================== */
  /* 筛选                                                                */
  /* ================================================================== */

  function isHiddenEl(el) {
    return el.classList.contains('bddf-hidden') || el.getAttribute('data-bddf-hidden') === '1';
  }

  function setHidden(el, hide) {
    if (hide) {
      if (!el.classList.contains('bddf-hidden')) el.classList.add('bddf-hidden');
      if (el.getAttribute('data-bddf-hidden') !== '1') el.setAttribute('data-bddf-hidden', '1');
    } else if (isHiddenEl(el)) {
      el.classList.remove('bddf-hidden');
      el.removeAttribute('data-bddf-hidden');
    }
  }

  /** 判断单个动态项是否应隐藏 */
  /**
   * 判断一条动态是否属于「视频投稿」并取出其时长。
   *
   * 可靠性排序：
   *   1. 有无 .duration-time 文本 —— 这是视频卡片独有的最可靠信号；
   *   2. .bili-dyn-card-video 等类名 —— 用于兜底判断「视频卡片但时长还没渲染」。
   *
   * 早期版本只看 .bili-dyn-card-video，一旦 B 站改版/AB 测试导致该类名未命中，
   * 所有动态都会被当成「非视频」，叠加 onlyVideo=false 后表现为「拖动完全没反应」。
   */
  function inspectItem(item) {
    const durEl = item.querySelector('.duration-time');
    const text = durEl ? durEl.textContent : null;
    const sec = parseDuration(text);
    const hasDuration = sec !== null;
    const hasVideoCard = !!item.querySelector('.bili-dyn-card-video');
    // 有可解析时长，或带有视频卡片结构 → 视为视频投稿
    const isVideo = hasDuration || hasVideoCard;
    return { isVideo: isVideo, sec: sec, hasDuration: hasDuration };
  }

  function shouldHide(item) {
    if (!state.enabled) return false;
    const info = inspectItem(item);

    // 非视频动态：只在用户显式开启「仅显示视频投稿」时隐藏
    if (!info.isVideo) return !!state.onlyVideo;

    // 视频但拿不到时长（转码中 / 结构未渲染完）→ 不误伤
    if (!info.hasDuration) return false;

    return !(info.sec >= state.min && info.sec <= state.max);
  }

  function updateCount(visible, total) {
    if (!refs) return;
    let text = '显示 ' + visible + ' / ' + total;
    // 正在自动补足时给出明确提示，避免用户以为筛选卡住了
    if (autofillRounds > 0 && visible < AUTOFILL_TARGET && !noMoreItems()) {
      text += ' · 补充中';
    }
    if (refs.count.textContent !== text) refs.count.textContent = text;
    if (barNode) {
      if (visible === 0) barNode.classList.add('bddf-empty');
      else barNode.classList.remove('bddf-empty');
    }
  }

  /** 同步筛选所有动态项并刷新计数 */
  /**
   * 只在「视频投稿」标签页显示本模块。
   *
   * 切到「全部 / 追番追剧 / 专栏」时把筛选条整个隐藏，并清除我们施加的所有隐藏，
   * 让列表恢复原样；切回视频投稿时再显示并重新应用筛选。
   */
  function syncVisibility() {
    if (!barNode || destroyed) return;
    const shouldShow = isVideoTabActive();

    if (barNode.getAttribute('data-hidden') === (shouldShow ? '0' : '1')) {
      return; // 状态未变，避免反复操作 DOM
    }
    barNode.setAttribute('data-hidden', shouldShow ? '0' : '1');

    if (!shouldShow) {
      // 离开视频投稿：撤销筛选，避免在别的 tab 里误藏内容
      const items = document.querySelectorAll('.bili-dyn-list__item');
      for (let i = 0; i < items.length; i += 1) setHidden(items[i], false);
      clearAutofill();
    }
  }

  function scan() {
    if (destroyed) return;
    syncVisibility();

    const items = document.querySelectorAll('.bili-dyn-list__item');
    const active = isVideoTabActive();
    let visible = 0;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      // 非视频投稿 tab 下不做任何筛选
      const hide = active ? shouldHide(item) : false;
      setHidden(item, hide);
      if (!hide) visible += 1;
    }
    updateCount(visible, items.length);
  }

  function queueScan() {
    if (destroyed || scanQueued) return;
    scanQueued = true;
    const run = function () {
      scanQueued = false;
      scan();
    };
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(run);
    } else {
      window.setTimeout(run, 16);
    }
  }

  function getStats() {
    const items = document.querySelectorAll('.bili-dyn-list__item');
    let videos = 0;
    let unknown = 0;
    let visible = 0;
    let hidden = 0;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      // 与 shouldHide 使用同一套判定，保证统计与筛选结果一致
      const info = inspectItem(item);
      if (info.isVideo) {
        videos += 1;
        if (!info.hasDuration) unknown += 1;
      }
      if (isHiddenEl(item)) hidden += 1;
      else visible += 1;
    }
    return { total: items.length, videos: videos, visible: visible, hidden: hidden, unknown: unknown };
  }

  /* ================================================================== */
  /* 自动加载更多                                                        */
  /* ================================================================== */

  function clearAutofill() {
    if (autofillTimer) {
      window.clearTimeout(autofillTimer);
      autofillTimer = null;
    }
  }

  function noMoreItems() {
    return !!document.querySelector('.bili-dyn-list-no-more');
  }

  function visibleVideoCount() {
    const items = document.querySelectorAll('.bili-dyn-list__item');
    let n = 0;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!isHiddenEl(item) && inspectItem(item).isVideo) n += 1;
    }
    return n;
  }

  function scheduleAutofill() {
    if (destroyed || autofillTimer) return;
    if (!state.enabled || !state.autofill) return;
    if (!isTargetPage()) return;
    // 仅在「视频投稿」标签页启用：其它 tab 下不做任何主动滚动
    if (!isVideoTabActive()) return;
    if (noMoreItems()) return;
    // 已经够数就没必要排队；否则会在「够数→排队→进来发现够数→返回」之间空转
    if (visibleVideoCount() >= AUTOFILL_TARGET) return;
    // 超出时间预算/轮数上限时不再排队
    if (autofillStartedAt && Date.now() - autofillStartedAt > AUTOFILL_MAX_DURATION) return;
    if (autofillRounds >= AUTOFILL_MAX_ROUNDS) return;
    autofillTimer = window.setTimeout(runAutofill, AUTOFILL_DELAY);
  }

  /**
   * 触发一次「加载更多」，但把滚动位置还原回去。
   *
   * 早期实现直接 window.scrollTo(0, 页面高度)，会把用户正在看的位置顶到最底部，
   * 非常打扰。这里改为：只把列表底部那个「加载更多」哨兵滚进视口（或做一次
   * 极短距离的贴底滚动），随后立即把滚动位置还原到用户原来的位置。
   */
  function triggerLoadOnce() {
    const prevX = window.scrollX || window.pageXOffset || 0;
    const prevY = window.scrollY || window.pageYOffset || 0;

    // 1) 优先：把列表底部滚进视口，触发 B 站自己的 IntersectionObserver / 滚动监听
    const itemsEl = document.querySelector('.bili-dyn-list__items');
    const sentinel =
      document.querySelector('.bili-dyn-list__loadmore') ||
      document.querySelector('.bili-dyn-list-no-more') ||
      (itemsEl && itemsEl.lastElementChild);

    let scrolled = false;
    try {
      if (sentinel && typeof sentinel.scrollIntoView === 'function') {
        sentinel.scrollIntoView({ block: 'end', behavior: 'instant' });
        scrolled = true;
      }
    } catch (err) {
      scrolled = false;
    }

    // 2) 兜底：整体贴底一次
    if (!scrolled) {
      try {
        const docEl = document.documentElement;
        const body = document.body;
        const height = Math.max(
          (docEl && docEl.scrollHeight) || 0,
          (body && body.scrollHeight) || 0,
          1
        );
        if (typeof window.scrollTo === 'function') window.scrollTo(0, height);
        else if (docEl) docEl.scrollTop = height;
      } catch (err) {
        /* ignore */
      }
    }

    // 3) 立刻还原滚动位置，用户视觉上不应被拽走
    try {
      window.scrollTo(prevX, prevY);
    } catch (err) {
      /* ignore */
    }
  }

  /** 自动加载的硬性刹车：超过这个时长无论如何都停，防止无限跑 */
  function autofillBudgetExceeded() {
    if (!autofillStartedAt) return false;
    if (Date.now() - autofillStartedAt <= AUTOFILL_MAX_DURATION) return false;
    // 超时后彻底停手，并清零计数，等用户下次主动操作再重新开始
    autofillRounds = 0;
    autofillStalls = 0;
    autofillStartedAt = 0;
    clearAutofill();
    return true;
  }

  function runAutofill() {
    autofillTimer = null;
    if (destroyed) return;
    if (!state.enabled || !state.autofill) return;
    if (!isVideoTabActive()) return; // tab 已切走 → 立即停止

    // 硬性时间预算：无论还剩多少缺口，超时即停
    if (autofillBudgetExceeded()) return;

    // B 站默认一页 20 条动态；筛选后可见视频数远低于这个量时，说明"这一屏被筛空了"
    if (visibleVideoCount() >= AUTOFILL_TARGET) {
      autofillRounds = 0;
      autofillStartedAt = 0;
      return;
    }
    if (noMoreItems()) return; // 确实到底了，再怎么滚也没有
    if (document.hidden) {
      // 页面在后台时不滚动；回到前台后由 visibilitychange 重新触发
      return;
    }
    // 轮数上限
    if (autofillRounds >= AUTOFILL_MAX_ROUNDS) {
      autofillRounds = 0;
      autofillStartedAt = 0;
      return;
    }

    const before = document.querySelectorAll('.bili-dyn-list__item').length;

    autofillRounds += 1;
    // 第一轮时记录起始时间，用于时间预算判定
    if (!autofillStartedAt) autofillStartedAt = Date.now();
    triggerLoadOnce();

    // 一轮之后按"实际新增了多少条"决定还要不要继续。
    // 关键：这不是死板地数轮数，而是看这一轮有没有把列表撑大。
    window.setTimeout(function () {
      if (destroyed || !state.autofill || !state.enabled) return;
      if (!isVideoTabActive()) return;
      if (autofillBudgetExceeded()) return;

      const after = document.querySelectorAll('.bili-dyn-list__item').length;
      const grew = after - before;

      if (grew <= 0) {
        // 这一轮没加载出东西：可能是网络慢，也可能是到底了。
        // 连续两次无增长才放弃，避免偶发慢请求让补充提前中断。
        autofillStalls += 1;
        if (autofillStalls >= 2 || noMoreItems()) {
          autofillRounds = 0;
          return;
        }
        scheduleAutofill();
        return;
      }

      autofillStalls = 0;
      // 仍未凑够则继续补
      if (visibleVideoCount() < AUTOFILL_TARGET) scheduleAutofill();
      else autofillRounds = 0;
    }, AUTOFILL_DELAY);
  }

  /** 新一轮筛选 / 用户手动操作后重置自动加载计数 */
  function resetAutofill() {
    autofillRounds = 0;
    autofillStalls = 0;
    autofillStartedAt = 0;
    clearAutofill();
    scheduleAutofill();
  }

  /* ================================================================== */
  /* 状态修改入口                                                        */
  /* ================================================================== */

  function applyRange(min, max) {
    state.min = clampSec(min);
    let hi;
    if (max === null || max === undefined || max === Infinity) {
      hi = Infinity;
    } else {
      const n = Number(max);
      // SPEC 3.5：右端（≥3 小时）即「不限」，统一归一化为 Infinity
      hi = !Number.isFinite(n) || n >= MAX_SEC ? Infinity : clampSec(n);
    }
    if (hi !== Infinity && hi < state.min) hi = state.min;
    state.max = hi;
  }

  function setRange(min, max) {
    applyRange(min, max);
    persistRange();
    updateUI();
    scan();
    resetAutofill();
  }

  function getRange() {
    return { min: state.min, max: state.max };
  }

  function setEnabled(value) {
    state.enabled = !!value;
    persistEnabled();
    updateUI();
    scan();
    resetAutofill();
  }

  function isEnabled() {
    return !!state.enabled;
  }

  function getOptions() {
    return { onlyVideo: state.onlyVideo, autofill: state.autofill, collapsed: state.collapsed };
  }

  function setOptions(partial) {
    if (!partial || typeof partial !== 'object') return;
    if (typeof partial.onlyVideo === 'boolean') state.onlyVideo = partial.onlyVideo;
    if (typeof partial.autofill === 'boolean') state.autofill = partial.autofill;
    if (typeof partial.collapsed === 'boolean') state.collapsed = partial.collapsed;
    // 无论值是否变化都落盘：显式用户操作本身也是一次状态确认
    persistOptions();
    updateUI();
    scan();
    if (!state.autofill) clearAutofill();
    else resetAutofill();
  }

  function resetAll() {
    state.enabled = true;
    state.min = 0;
    state.max = Infinity;
    state.onlyVideo = false;
    persistEnabled();
    persistRange();
    persistOptions();
    updateUI();
    scan();
    resetAutofill();
  }

  /* ================================================================== */
  /* 滑块交互                                                            */
  /* ================================================================== */

  function trackRect() {
    if (!refs || !refs.track) return null;
    try {
      return refs.track.getBoundingClientRect();
    } catch (err) {
      return null;
    }
  }

  /** 把某个滑块移动到指定秒数（min / max 互相夹紧） */
  function moveThumb(which, seconds, options) {
    const opts = options || {};
    const isInf = seconds === Infinity;
    const sec = isInf ? MAX_SEC : clampSec(seconds);

    if (which === 'min') {
      // SPEC 3.5：min 越过 max 时 max 跟随；推到最右端则直接变为「不限」
      if (state.max !== Infinity && sec > state.max) {
        state.max = sec >= MAX_SEC ? Infinity : sec;
      }
      state.min = sec;
      if (state.max !== Infinity && state.max < state.min) state.max = state.min;
      // 两端不重叠
      if (state.max !== Infinity && state.max - state.min < MIN_GAP) {
        const bumped = state.min + MIN_GAP;
        state.max = bumped >= MAX_SEC ? Infinity : bumped;
      }
    } else {
      // max 越过 min 时 min 跟随
      if (sec < state.min) state.min = sec;
      state.max = isInf || sec >= MAX_SEC ? Infinity : sec;
      if (state.max !== Infinity && state.max < state.min) state.min = state.max;
      if (state.max !== Infinity && state.max - state.min < MIN_GAP) {
        state.min = Math.max(0, state.max - MIN_GAP);
      }
    }
    if (state.min < 0) state.min = 0;
    if (state.min > MAX_SEC) state.min = MAX_SEC;

    persistRange();
    updateUI();
    queueScan();
  }

  function commitRange() {
    persistRange();
    updateUI();
    scan();
    resetAutofill();
  }

  function normFromPointer(clientX) {
    const rect = trackRect();
    if (!rect || !rect.width) return null;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function onThumbDown(which) {
    return function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      dragging = which;
      if (barNode) barNode.classList.add('bddf-dragging');
      try {
        if (event.currentTarget && event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      } catch (err) {
        /* jsdom / 旧浏览器可能不支持 */
      }
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
    };
  }

  function onDragMove(event) {
    if (!dragging) return;
    const norm = normFromPointer(event.clientX);
    if (norm === null) return;
    moveThumb(dragging, secOfNorm(norm), { push: true });
  }

  function onDragEnd() {
    if (!dragging) return;
    dragging = null;
    if (barNode) barNode.classList.remove('bddf-dragging');
    commitRange();
  }

  function onTrackClick(event) {
    const norm = normFromPointer(event.clientX);
    if (norm === null) return;
    const dMin = Math.abs(norm - normOf(state.min));
    const dMax = Math.abs(norm - normOf(state.max));
    const which = dMin <= dMax ? 'min' : 'max';
    moveThumb(which, secOfNorm(norm), { push: true });
    commitRange();
  }

  function onThumbKey(which) {
    return function (event) {
      const current =
        which === 'min' ? state.min : state.max === Infinity ? MAX_SEC : state.max;
      let next = null;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          next = current + 60;
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          next = current - 60;
          break;
        case 'PageUp':
          next = current + 300;
          break;
        case 'PageDown':
          next = current - 300;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = MAX_SEC;
          break;
        default:
          return;
      }
      if (typeof event.preventDefault === 'function') event.preventDefault();
      moveThumb(which, next, { push: true });
      commitRange();
    };
  }

  function onThumbDblClick(which) {
    return function () {
      setRange(which === 'min' ? 0 : state.min, which === 'min' ? state.max : Infinity);
    };
  }

  function bindEvents() {
    if (!refs || !barNode) return;

    refs.thumbMin.addEventListener('pointerdown', onThumbDown('min'));
    refs.thumbMax.addEventListener('pointerdown', onThumbDown('max'));
    refs.thumbMin.addEventListener('keydown', onThumbKey('min'));
    refs.thumbMax.addEventListener('keydown', onThumbKey('max'));
    refs.thumbMin.addEventListener('dblclick', onThumbDblClick('min'));
    refs.thumbMax.addEventListener('dblclick', onThumbDblClick('max'));
    refs.track.addEventListener('click', onTrackClick);

    refs.enabled.addEventListener('change', function (event) {
      setEnabled(event.target.checked);
    });
    refs.onlyVideo.addEventListener('change', function (event) {
      setOptions({ onlyVideo: event.target.checked });
    });
    refs.autofill.addEventListener('change', function (event) {
      setOptions({ autofill: event.target.checked });
    });
    refs.reset.addEventListener('click', function () {
      resetAll();
    });
    refs.collapse.addEventListener('click', function () {
      setOptions({ collapsed: !state.collapsed });
    });

    for (let i = 0; i < refs.presets.length; i += 1) {
      refs.presets[i].addEventListener('click', function (event) {
        const btn = event.currentTarget;
        const rawMin = btn.getAttribute('data-min');
        const rawMax = btn.getAttribute('data-max');
        const min = rawMin === 'Infinity' ? Infinity : Number(rawMin);
        const max = rawMax === 'Infinity' ? Infinity : Number(rawMax);
        setRange(min, max);
      });
    }

    // 拖动与键盘的组合事件只绑定一次（destroy → mount 后不重复）
    if (!eventsBound) {
      eventsBound = true;

      // 页头高度会随滚动收窄/展开、窗口缩放、登录态变化而改变，需持续校正吸顶偏移
      var onViewportChange = function () {
        if (destroyed || !barNode) return;
        syncStickyTop();
      };
      window.addEventListener('scroll', onViewportChange, { passive: true });
      window.addEventListener('resize', onViewportChange);

      // 从后台切回前台时，若仍有缺口则恢复补充
      document.addEventListener('visibilitychange', function () {
        if (destroyed || document.hidden) return;
        if (!state.enabled || !state.autofill) return;
        if (visibleVideoCount() < AUTOFILL_TARGET) scheduleAutofill();
      });
      if (typeof window.ResizeObserver === 'function') {
        try {
          var headerProbe = document.querySelector('.z-top-container, #bili-header-container');
          if (headerProbe) {
            var ro = new window.ResizeObserver(onViewportChange);
            ro.observe(headerProbe);
            resizeObserver = ro;
          }
        } catch (err) {
          /* 忽略 */
        }
      }

      window.addEventListener('pointermove', onDragMove, { passive: true });
      window.addEventListener('pointerup', onDragEnd);
      window.addEventListener('pointercancel', onDragEnd);

      document.addEventListener(
        'keydown',
        function (event) {
          if (!event.altKey || !event.shiftKey) return;
          if (String(event.key || '').toLowerCase() !== 'd') return;
          const target = event.target;
          const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          if (target && target.isContentEditable) return;
          if (destroyed) return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          setEnabled(!state.enabled);
        },
        true
      );
    }
  }

  /* ================================================================== */
  /* 观察器 / 看门狗                                                     */
  /* ================================================================== */

  function stopObservers() {
    if (observer) {
      try {
        observer.disconnect();
      } catch (err) {
        /* 忽略 */
      }
      observer = null;
    }
    if (watchdogTimer) {
      window.clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (resizeObserver) {
      try {
        resizeObserver.disconnect();
      } catch (err) {
        /* 忽略 */
      }
      resizeObserver = null;
    }
    if (passTimer) {
      window.clearTimeout(passTimer);
      passTimer = null;
    }
  }

  function runPass() {
    if (destroyed) return;
    if (document.hidden) return;
    if (!ensureMounted()) return;
    scan();
  }

  function schedulePass() {
    if (destroyed || passTimer) return;
    passTimer = window.setTimeout(function () {
      passTimer = null;
      runPass();
    }, PASS_DELAY);
  }

  function onMutations(records) {
    if (destroyed || !records || !records.length) return;
    let relevant = false;
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      const target = record.target;
      if (target && target.nodeType === 1) {
        // 跳过自身 UI 引起的变动，避免死循环
        if (target.closest && target.closest('.bddf-bar')) continue;
        if (target.id === STYLE_ID) continue;
      }
      relevant = true;
      break;
    }
    if (!relevant) return;

    // 只观察 childList（不看 attributes），所以这里同步 scan 不会自触发死循环；
    // 同步执行可让新插入的动态立刻得到正确显隐，不必等下一帧。
    if (barNode && barNode.isConnected) {
      try {
        scan();
      } catch (err) {
        /* 单次扫描异常不影响后续兜底 */
      }
    }
    // 兜底：一批 Mutation 内的其余记录合并到下一轮统一重扫
    schedulePass();
  }

  function startObservers() {
    stopObservers();
    try {
      if (typeof window.MutationObserver === 'function' && document.documentElement) {
        observer = new window.MutationObserver(onMutations);
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    } catch (err) {
      observer = null;
    }
    watchdogTimer = window.setInterval(function () {
      if (destroyed) return;
      if (!barNode || !barNode.isConnected) mount();
      else scan();
    }, 1000);
  }

  /* ================================================================== */
  /* 挂载 / 卸载                                                         */
  /* ================================================================== */

  function placeBar(itemsEl) {
    if (!barNode) return false;
    if (barNode.isConnected) return true;
    const tabs = tabsContainer();
    if (tabs && tabs.parentNode) {
      tabs.insertAdjacentElement('afterend', barNode);
      return true;
    }
    if (itemsEl && itemsEl.parentNode) {
      itemsEl.parentNode.insertBefore(barNode, itemsEl);
      return true;
    }
    return false;
  }

  function ensureMounted() {
    if (destroyed) return false;
    const itemsEl = itemsContainer();
    if (!itemsEl) return false;
    if (!barNode || !barNode.isConnected) return mount();
    return true;
  }

  function mount() {
    if (!isTargetPage()) return false;

    destroyed = false;

    // 无论列表是否已渲染，都要先把观察器装上：
    // B 站是 SPA，@run-at document-idle 时 Vue 往往还没渲染出 .bili-dyn-list__items，
    // 若此处直接 return，之后新插入的动态将永远无人扫描（真实页面上的致命问题）。
    if (!observer && !watchdogTimer) startObservers();

    const itemsEl = itemsContainer();
    if (!itemsEl) {
      // 列表还没来，交给 MutationObserver / 看门狗稍后重试。
      // 此时不注入样式，保证「无非目标内容」的页面保持完全静默。
      return false;
    }

    injectStyle();

    if (!barNode) {
      barNode = createBar();
      refs = collectRefs(barNode);
      bindEvents();
    }

    if (!placeBar(itemsEl)) return false;

    updateUI();
    syncStickyTop();
    scan();
    scheduleAutofill();
    return true;
  }

  function destroy() {
    destroyed = true;
    stopObservers();
    clearAutofill();

    if (barNode && barNode.parentNode) barNode.parentNode.removeChild(barNode);
    barNode = null;
    refs = null;
    dragging = null;

    // 清除所有筛选痕迹
    const hiddenItems = document.querySelectorAll('.bili-dyn-list__item');
    for (let i = 0; i < hiddenItems.length; i += 1) {
      hiddenItems[i].classList.remove('bddf-hidden');
      hiddenItems[i].removeAttribute('data-bddf-hidden');
    }
    removeStyle();
  }

  /* ================================================================== */
  /* 对外调试 / 测试钩子                                                 */
  /* ================================================================== */

  const API = {
    version: VERSION,
    mount: mount,
    destroy: destroy,
    scan: scan,
    filterNow: scan,
    setRange: setRange,
    getRange: getRange,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    parseDuration: parseDuration,
    formatDuration: formatDuration,
    getOptions: getOptions,
    setOptions: setOptions,
    getStats: getStats,
  };

  /* ================================================================== */
  /* 启动                                                                */
  /* ================================================================== */

  function registerMenu() {
    try {
      if (typeof GM_registerMenuCommand !== 'function') return;
      GM_registerMenuCommand('启用/停用时长筛选', function () {
        setEnabled(!state.enabled);
      });
      GM_registerMenuCommand('重置筛选范围', function () {
        resetAll();
      });
    } catch (err) {
      /* 菜单注册失败不影响主流程 */
    }
  }

  function boot() {
    loadState();

    // 重复注入（脚本被再次执行 / SPA 内重载）时复用同一份 API
    if (window.__BDDF__ && window.__BDDF__.__bddf) {
      try {
        window.__BDDF__.mount();
      } catch (err) {
        /* 忽略 */
      }
      return;
    }

    window.__BDDF__ = API;
    Object.defineProperty(API, '__bddf', { value: true, enumerable: false });

    registerMenu();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        mount();
      }, { once: true });
    } else {
      mount();
    }
  }

  boot();
})();
