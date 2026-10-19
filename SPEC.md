# SPEC — B站动态首页 视频时长筛选（Tampermonkey 用户脚本）

> 内部实现契约。所有实现/测试/文档均以本文件为准。
> 交付物根目录：`D:\dsh\bilibili`（即当前工作目录）。

## 1. 目标

在 B 站动态首页（`https://t.bilibili.com/`，以及带动态流的 `https://www.bilibili.com/` 根路径）
的「视频投稿」动态列表中，注入一个**双滑块时长筛选条**，按视频时长过滤动态卡片。

真实页面结构（2026-10 从线上 bundle 核实，选择器必须以此为准）：

| 元素 | 选择器 | 说明 |
|---|---|---|
| 动态列表根 | `.bili-dyn-list` | Vue 组件 |
| 列表项包裹 | `.bili-dyn-list__item` | 每个动态一条，真正被隐藏的对象 |
| 动态本体 | `.bili-dyn-item` | 内部卡片 |
| 视频卡片 | `.bili-dyn-card-video` | 视频投稿 |
| 视频时长文本 | `.bili-dyn-card-video__cover-shadow .duration-time` | 文本形如 `03:21` / `1:02:03` |
| Tab 栏 | `.bili-dyn-list-tabs` | 全部 / 视频投稿 / 追番追剧 / 专栏 |
| 列表容器 | `.bili-dyn-list__items` | 动态项父节点 |
| 加载更多 | `.bili-dyn-list__loadmore`（错误态可点击） | 滚动到底自动加载 |
| 到底 | `.bili-dyn-list-no-more` | 无更多 |

## 2. 交付文件与分工

| 文件 | 负责人 | 说明 |
|---|---|---|
| `bilibili-dynamic-duration-filter.user.js` | dev | 单文件用户脚本（唯一运行时产物） |
| `tests/*.mjs`、`package.json`、`package-lock.json` | qa | jsdom 集成测试，`node --test` 运行 |
| `README.md`、`demo/demo.html` | docs | 中文使用文档 + 可离线打开的仿真页 |
| `SPEC.md`、`tools/` | lead | 规格、截图/校验工具 |

## 3. 用户脚本契约

### 3.1 元数据（必须完全一致）

```js
// ==UserScript==
// @name         B站动态首页 · 视频时长筛选
// @namespace    https://github.com/bddf/bilibili-duration-filter
// @version      1.0.0
// @description  在 B 站动态首页「视频投稿」栏注入双滑块时长筛选条，按视频时长过滤动态卡片
// @author       bddf
// @match        https://t.bilibili.com/*
// @match        https://www.bilibili.com/
// @match        https://www.bilibili.com/?*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==
```

- 页面裁剪：`t.bilibili.com` 全路径；`www.bilibili.com` 仅根路径（含 query）。
- 没有动态列表的页面必须**完全静默**（无报错、无 DOM 改动）。

### 3.2 状态与持久化

- Key（GM_ / localStorage 同一套 key）：
  - `bddf.enabled`（bool，默认 `true`）
  - `bddf.min`（秒，默认 `0`）
  - `bddf.max`（秒，默认 `Infinity`，存储时序列化为字符串 `"Infinity"`）
  - `bddf.onlyVideo`（bool，默认 `false`；默认不隐藏非视频动态，用户按需在「视频投稿」栏开启）
  - `bddf.autofill`（bool，默认 `true`）
  - `bddf.collapsed`（bool，默认 `false`）
- 读写封装：优先 `GM_getValue/GM_setValue`（try/catch），失败回退 `localStorage`，再失败用内存对象。存储异常不得抛出。
- 每次状态变更立即持久化。

### 3.3 时长解析与格式化（纯函数，测试重点）

```js
parseDuration('03:21')   // 201
parseDuration('1:02:03') // 3723
parseDuration('00:00')   // 0
parseDuration('12:34')   // 754
parseDuration('abc')     // null
parseDuration('')        // null
parseDuration(null)      // null
parseDuration('1:60')    // null（分/秒 >= 60 视为非法）
formatDuration(201)      // '03:21'
formatDuration(3723)     // '1:02:03'
formatDuration(0)        // '00:00'
formatDuration(Infinity) // '不限'
formatDuration(null)     // '--:--'
```

- 解析规则：`mm:ss` 或 `h:mm:ss`（小时不补零）；各段必须为纯数字；分钟、秒 `0..59`；
  小时位允许任意非负数；前后空白忽略。`>` 24h 的时长同样支持。

### 3.4 筛选语义

对每个 `.bili-dyn-list__item`（不含 `.bddf-hidden` 之外的任何自定义结构调整）：

1. 找它内部**第一个** `.duration-time` 文本解析时长；无则为 `null`。
2. `enabled === false` → 全部显示。
3. `enabled === true`：
   - 视频项（存在 `.bili-dyn-card-video`）：
     - 时长 `null`（解析失败/缺失）→ **显示**（无法判断，不误伤）。
     - 时长在 `[min, max]` 闭区间内 → 显示，否则隐藏。
   - 非视频项：`onlyVideo === true` → 隐藏；`false` → 显示。
4. 隐藏实现：加类 `bddf-hidden` + 属性 `data-bddf-hidden="1"`，并插入样式
   `.bili-dyn-list__item.bddf-hidden{display:none!important}`。显示时移除二者。
5. 重新扫描必须幂等，不得重复添加 DOM。

### 3.5 UI 契约（选择器名称固定，测试依赖）

注入位置：`.bili-dyn-list-tabs` 的**下一个兄弟节点**（`insertAdjacentElement('afterend', bar)`）；
若没有 tabs，则插到 `.bili-dyn-list__items` 前面。`position: sticky; top` 自适应，滚动时保持可见。
**注入必须幂等**：重复 `mount()` 后页面中 `.bddf-bar` 数量恒为 1。

```html
<div class="bddf-bar" data-bddf="1" data-collapsed="0|1">
  <div class="bddf-head">
    <span class="bddf-title">时长筛选</span>
    <label class="bddf-switch"><input type="checkbox" class="bddf-enabled" checked><i></i></label>
    <span class="bddf-count">显示 12 / 20</span>
    <button class="bddf-reset" type="button">重置</button>
    <button class="bddf-collapse" type="button">收起</button>
  </div>
  <div class="bddf-body">
    <div class="bddf-slider-wrap">
      <div class="bddf-track"><div class="bddf-range"></div></div>
      <button class="bddf-thumb bddf-thumb--min" type="button" role="slider"
              aria-label="最短时长" aria-valuemin="0" aria-valuemax="10800" aria-valuenow="0"></button>
      <button class="bddf-thumb bddf-thumb--max" type="button" role="slider"
              aria-label="最长时长" aria-valuemin="0" aria-valuemax="10800" aria-valuenow="10800"></button>
      <span class="bddf-bubble bddf-bubble--min">00:00</span>
      <span class="bddf-bubble bddf-bubble--max">不限</span>
    </div>
    <div class="bddf-presets">
      <button class="bddf-preset" type="button" data-min="0" data-max="Infinity">不限</button>
      <button class="bddf-preset" type="button" data-min="0" data-max="60">≤1分钟</button>
      <button class="bddf-preset" type="button" data-min="60" data-max="300">1–5分钟</button>
      <button class="bddf-preset" type="button" data-min="300" data-max="600">5–10分钟</button>
      <button class="bddf-preset" type="button" data-min="600" data-max="1800">10–30分钟</button>
      <button class="bddf-preset" type="button" data-min="1800" data-max="3600">30–60分钟</button>
      <button class="bddf-preset" type="button" data-min="3600" data-max="Infinity">≥1小时</button>
    </div>
    <div class="bddf-opts">
      <label class="bddf-opt"><input type="checkbox" class="bddf-only-video">仅显示视频投稿</label>
      <label class="bddf-opt"><input type="checkbox" class="bddf-autofill" checked>自动加载更多</label>
      <span class="bddf-hint">拖动两端滑块按视频时长筛选，双击滑块恢复默认</span>
    </div>
  </div>
</div>
```

交互要求：

- 双滑块基于**对数刻度**，定义域 `0..10800` 秒（3 小时），右端 = `Infinity`（不限）。
  映射：`norm = log1p(sec)/log1p(10800)`，`sec = round(expm1(norm*log1p(10800)))`；
  norm=1 时存 `Infinity`。拖动时实时更新气泡/`aria-valuenow`，并节流（rAF）重新筛选。
- 不允许两滑块交叉：拖动 min 超过 max 时，max 跟随（或反之），可视上不重叠。
- 滑块支持鼠标/触摸（Pointer Events，`setPointerCapture` 可选）和键盘 ←/→（步进 1 分钟）、Home/End。
- 点击轨道：就近移动某一滑块。
- 预设按钮点击 → 设置范围并应用，当前匹配的预设按钮加 `.active`。
- 「收起」切换 `data-collapsed`，隐去 `.bddf-body`；状态持久化。
- 计数文本格式：`显示 {visible} / {total}`（统计范围为当前列表内的 `.bili-dyn-list__item`）。
  筛选无结果时额外加类 `bddf-empty`，可显示兜底文案「没有符合时长的视频」。
- 自动加载（`autofill` 且 `enabled` 且可见视频项 < 2 且页面未 `no-more`）：
  以 2 秒节流向下滚动触发原生加载，最多连续 6 轮；新一轮筛选 / 手动点击后重置计数。
  不得高频触发（每轮间隔 ≥ 1200ms）。
- 「重置」：`enabled=true, min=0, max=Infinity, onlyVideo=false`，并清空筛选。
- `GM_registerMenuCommand`（存在时）注册「启用/停用时长筛选」「重置筛选范围」两项。
- `Alt+Shift+D` 切换启用状态（在 input/textarea 内不触发）。

### 3.6 生命周期与健壮性

- SPA：tab 切换、Vue 重渲染后筛选条可能被移除 → 看门狗：`MutationObserver(document.documentElement,{childList:true,subtree:true})`
  + 1s 兜底 `setInterval`（页面不可见时跳过），若 `.bddf-bar` 不在且存在锚点则重挂载并重扫。
- 列表变化（滚动加载新动态）：`MutationObserver` 监听 `.bili-dyn-list__items` 子树 + 兜底 800ms 轮询；
  变更后 rAF 批量重扫。筛选条自身的 DOM 变动不得触发死循环。
- 所有观察器/定时器集中管理，`destroy()` 时全部断开并移除注入的 DOM 与样式。
- 不得影响 bilibili 原有点击、滚动、路由行为；不得覆盖全局变量（除 `window.__BDDF__`）。
- 代码风格：ES2020 语法（Chrome 常青 + Tampermonkey），无外部依赖，IIFE 包裹，`'use strict'`。
- 单文件 ≤ 1200 行；必要处中文注释。

### 3.7 测试钩子（必须实现，测试依赖）

`window.__BDDF__ = { ... }`（每次 mount 后可用）：

| 成员 | 签名 | 说明 |
|---|---|---|
| `version` | string | `'1.0.0'` |
| `mount()` | `boolean` | 幂等挂载，成功返回 true |
| `destroy()` | `void` | 移除 UI 与观察器 |
| `scan()` | `void` | 立即重算显隐 |
| `setRange(min, max)` | `void` | 秒；`max` 可传 `Infinity`/`null`（=不限）；自动 apply |
| `getRange()` | `{min:number,max:number}` | `max` 为 `Infinity` 时返回 `Infinity` |
| `setEnabled(bool)` | `void` | 切换启用并持久化 |
| `isEnabled()` | `boolean` | |
| `parseDuration(text)` | `number\|null` | 同 3.3 |
| `formatDuration(sec)` | `string` | 同 3.3 |
| `getOptions()` | `{onlyVideo:boolean, autofill:boolean, collapsed:boolean}` | |
| `setOptions(partial)` | `void` | 局部更新并 apply |
| `getStats()` | `{total, videos, visible, hidden, unknown}` | 当前列表统计 |
| `filterNow()` | `void` | `scan()` 别名 |

- 注意：`window.__BDDF__` 必须始终指向**同一个对象**（重新 mount 不换引用）。
- 测试环境注入时，脚本应能容忍 `window` 上缺少 `GM_*`、`IntersectionObserver`、`requestIdleCallback` 等。

## 4. 测试契约（qa）

- 使用 `jsdom` + `node:test`：`npm test` → `node --test tests/`。
- 测试自建 fixture（仿 bilibili 结构），**不得**依赖 `demo/demo.html`。
- 至少覆盖：
  1. `parseDuration`/`formatDuration` 全部 3.3 用例 + `Infinity`/`null`。
  2. 正常页挂载：`.bddf-bar` 存在、位置在 `.bili-dyn-list-tabs` 之后、重复 mount 仍为 1 个。
  3. 默认状态：范围 `0..Infinity`，全部 `.bili-dyn-list__item` 可见。
  4. `setRange(60,300)`：201s 可见；59s/301s 隐藏；无时长的视频项显示；非视频项默认显示。
  5. `setOptions({onlyVideo:true})` 后非视频项隐藏；`setOptions({onlyVideo:false})` 后恢复显示。
  6. `setEnabled(false)`：所有项恢复，`data-bddf-hidden` 清除。
  7. 预设按钮点击（如 `data-min="300" data-max="600"`）→ 范围生效且该按钮 `.active`。
  8. 动态新增节点（模拟无限滚动 append）→ MutationObserver 后（`await tick(50~150ms)`）新项被正确显隐。
  9. `getStats()` 数值正确；计数文本包含 `显示 x / y`。
  10. 持久化：`localStorage`/GM stub 中 key 写入；`setRange` 后重新加载脚本可恢复（可用 stub store 验证）。
  11. 无锚点页面：`mount()` 返回 false，页面无 `.bddf-bar`，无异常。
  12. `destroy()`：移除 bar、清除所有 `bddf-hidden`、解除观察器（后续 append 不再变化）。
- 运行方式与失败信息写入任务汇报；全部通过才可完成。

## 5. 文档与 demo 契约（docs）

- `README.md`（中文）：简介、功能截图占位（指向 `demo/` 说明）、安装（Tampermonkey → 新建脚本 → 粘贴）、
  使用说明（滑块/预设/开关/自动加载/快捷键）、实现原理（DOM 选择器 + MutationObserver，不改请求）、
  已知限制（B 站改版可能失效、仅 t.bilibili.com 与 www 根路径、屏蔽动态可能影响统计）、
  开发与测试（`npm install && npm test`、`node tools/screenshot.mjs`）、目录结构、许可证。
- `demo/demo.html`：单文件、无外部资源、内联 CSS/JS；
  复刻 `.bili-dyn-list-tabs` / `.bili-dyn-list` / `.bili-dyn-list__item` / `.bili-dyn-item` /
  `.bili-dyn-card-video` / `.duration-time` 结构；至少 12 条（8 视频：`00:45`、`03:21`、`08:12`、`15:40`、
  `42:05`、`1:12:30`、`02:10`、无时长视频；4 条非视频）；带「注入脚本」说明注释与手动加载脚本的按钮
  （用 `<script>` 动态插入 `../bilibili-dynamic-duration-filter.user.js` 可能受 file:// 限制，
  改为提示用户把脚本粘贴/或直接引用相对路径，需在 README 说明）。
- demo 需支持暗色（`prefers-color-scheme`）。

## 6. 验收

1. `node --check bilibili-dynamic-duration-filter.user.js` 通过。
2. `npm test` 全绿。
3. headless Chrome 打开 demo（注入脚本）截图中筛选条样式正常、筛选生效（lead 复核）。
4. 页面无动态列表时静默；控制台无异常。
