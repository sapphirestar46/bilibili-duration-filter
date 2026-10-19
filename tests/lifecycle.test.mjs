/**
 * SPEC 3.5 / 3.6：生命周期与健壮性。
 * 对应测试契约第 8（MutationObserver 动态新增）、12（destroy），
 * 外加 3.5 的收起/快捷键/菜单/滑块/自动加载，以及 3.6 的 SPA 看门狗。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendItems,
  boot,
  closeAllPages,
  createGM,
  getCounts,
  getItems,
  hiddenFlags,
  isHidden,
  itemById,
  itemsMarkup,
  plain,
  trackScroll,
  waitUntil,
} from './helpers.mjs';

after(closeAllPages);

const hiddenIds = (document) =>
  getItems(document)
    .filter((el) => isHidden(el))
    .map((el) => el.getAttribute('data-fixture-id'));

/* ================================================================== */
/* 8. 动态新增节点（MutationObserver）                                */
/* ================================================================== */

describe('SPEC 3.6 MutationObserver 增量筛选', () => {
  test('append 新视频项后被正确显隐（异步，无需手动 scan）', async () => {
    const { document, requireApi } = await boot({ items: [] });
    const bddf = requireApi();
    bddf.setOptions({ onlyVideo: true }); // SPEC 3.2：非视频需显式开启才隐藏
    bddf.setRange(60, 300);

    const added = appendItems(document, [
      { kind: 'video', duration: '03:21' }, // 201s → 显示
      { kind: 'video', duration: '05:01' }, // 301s → 隐藏
      { kind: 'video', duration: null }, // 无时长 → 显示
      { kind: 'text' }, // 非视频 + onlyVideo → 隐藏
      { kind: 'video', duration: '00:59' }, // 59s → 隐藏
    ]);
    assert.equal(added.length, 5);

    // MutationObserver + rAF 需要异步余量（SPEC 4 建议 50~150ms）
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(isHidden(added[0]), false, '201s 应显示');
    assert.equal(isHidden(added[1]), true, '301s 应隐藏');
    assert.equal(isHidden(added[2]), false, '无时长应显示');
    assert.equal(isHidden(added[3]), true, '非视频应隐藏');
    assert.equal(isHidden(added[4]), true, '59s 应隐藏');

    const counts = getCounts(document);
    assert.equal(counts.total, 5, '计数应包含新节点');
    assert.equal(counts.visible, 2);
    assert.equal(bddf.getStats().total, 5);
  });

  test('停用状态下 append：新项全部显示', async () => {
    const { document, requireApi } = await boot({ items: [] });
    const bddf = requireApi();
    bddf.setEnabled(false);
    appendItems(document, [
      { kind: 'video', duration: '45:00' },
      { kind: 'text' },
    ]);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(plain(hiddenIds(document)), [], '停用后新增项不应被隐藏');
  });

  test('删除节点后不抛错，统计跟随', async () => {
    const { document, requireApi, scriptError } = await boot({
      items: [{ kind: 'video', duration: '03:21' }],
    });
    const bddf = requireApi();
    bddf.setRange(60, 300);
    const added = appendItems(document, [{ kind: 'video', duration: '01:00' }]);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(isHidden(added[0]), false, '60s 应可见');

    added[0].remove();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(scriptError, null);
    assert.equal(getItems(document).length, 1, '删除后不应复活');
    assert.equal(bddf.getStats().total, 1, '统计应跟随删除');
  });

  test('反复 append 不重复挂载 UI / 样式', async () => {
    const { document, requireApi } = await boot({ items: [] });
    const bddf = requireApi();
    bddf.setRange(60, 300);
    for (let i = 0; i < 5; i += 1) {
      appendItems(document, [{ kind: 'video', duration: '03:21' }]);
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(document.querySelectorAll('.bddf-bar').length, 1, '.bddf-bar 应始终只有一个');
    assert.equal(getItems(document).length, 5);
    assert.equal(bddf.getStats().visible, 5, '5 条 201s 均应可见');
    assert.equal(
      [...document.querySelectorAll('style')].filter((s) => s.textContent.includes('bddf')).length,
      1,
      '样式不应重复注入',
    );
  });
});

/* ================================================================== */
/* 12. destroy()                                                      */
/* ================================================================== */

describe('SPEC 3.6 destroy()', () => {
  test('移除 bar、清除所有 bddf-hidden、移除注入样式', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setRange(3600, Infinity);
    assert.ok(hiddenIds(document).length > 0, '前置：应有隐藏项');

    bddf.destroy();

    assert.equal(document.querySelectorAll('.bddf-bar').length, 0, 'bar 应被移除');
    assert.deepEqual(plain(hiddenIds(document)), [], '不应残留隐藏项');
    for (const el of getItems(document)) {
      assert.deepEqual(plain(hiddenFlags(el)), { cls: false, attr: null }, '隐藏标记应被清除');
    }
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('');
    assert.equal(css.includes('bddf'), false, '注入样式应被移除');
  });

  test('destroy 后 append 新节点不再被处理', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setRange(3600, Infinity);
    bddf.destroy();

    appendItems(document, [
      { kind: 'video', duration: '45:00' },
      { kind: 'text' },
    ]);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(plain(hiddenIds(document)), [], 'destroy 后观察器应已断开');
    assert.equal(document.querySelectorAll('.bddf-bar').length, 0, '不应自动重挂载');
  });

  test('destroy 后 API 调用不抛错', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.destroy();
    assert.doesNotThrow(() => bddf.setRange(60, 300));
    assert.doesNotThrow(() => bddf.scan());
    assert.doesNotThrow(() => bddf.getStats());
    assert.doesNotThrow(() => bddf.getRange());
    assert.equal(document.querySelector('.bddf-bar'), null);
  });

  test('destroy 后可重新 mount，引用不变且只有一个 bar', async () => {
    const { document, window, requireApi } = await boot();
    const bddf = requireApi();
    const ref = bddf;
    bddf.destroy();
    assert.equal(bddf.mount(), true);
    assert.equal(window.__BDDF__, ref, '__BDDF__ 引用必须稳定');
    assert.equal(document.querySelectorAll('.bddf-bar').length, 1);
    bddf.setRange(3600, Infinity);
    assert.equal(isHidden(itemById(document, 'dyn-0')), true, '重挂载后筛选应工作');
  });
});

/* ================================================================== */
/* 3.6 SPA 看门狗                                                     */
/* ================================================================== */

describe('SPEC 3.6 SPA 看门狗', () => {
  test('bar 被移除后自动重挂载并重扫', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setRange(3600, Infinity);
    document.querySelector('.bddf-bar').remove();

    await waitUntil(() => document.querySelectorAll('.bddf-bar').length === 1, {
      timeoutMs: 4000,
      label: '看门狗重挂载 .bddf-bar',
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(isHidden(itemById(document, 'dyn-0')), true, '重挂载后应重新应用筛选');
    assert.equal(document.querySelectorAll('.bddf-bar').length, 1, '不应重复挂载');
  });

  test('列表容器被整体替换后仍能筛选（重扫）', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setRange(3600, Infinity);

    const container = document.querySelector('.bili-dyn-list__items');
    const replacement = document.createElement('div');
    replacement.className = 'bili-dyn-list__items';
    replacement.innerHTML = itemsMarkup([
      { kind: 'video', duration: '03:21' }, // 201s → 隐藏
      { kind: 'video', duration: '45:00' }, // 2700s → 隐藏
      { kind: 'video', duration: '2:00:00' }, // 7200s → 显示
    ]);
    container.replaceWith(replacement);

    await waitUntil(
      () => {
        const st = bddf.getStats();
        return st.total === 3 && st.hidden === 2;
      },
      { timeoutMs: 4000, label: '新容器被重扫并完成筛选' },
    );
    const items = getItems(document);
    assert.equal(items.length, 3);
    assert.equal(isHidden(items[0]), true, '201s 应隐藏');
    assert.equal(isHidden(items[1]), true, '2700s 应隐藏');
    assert.equal(isHidden(items[2]), false, '7200s 在 [3600,∞) 应显示');
  });
});

/* ================================================================== */
/* 3.5 收起 / 快捷键 / 菜单                                           */
/* ================================================================== */

describe('SPEC 3.5 收起与快捷键', () => {
  test('收起按钮切换 data-collapsed 并持久化', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    const bar = document.querySelector('.bddf-bar');
    const btn = document.querySelector('.bddf-collapse');
    const body = document.querySelector('.bddf-body');
    const click = () => btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(bar.getAttribute('data-collapsed'), '0');

    click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bar.getAttribute('data-collapsed'), '1');
    assert.equal(bddf.getOptions().collapsed, true);
    assert.equal(String(window.localStorage.getItem('bddf.collapsed')), 'true');
    const collapsedHidden =
      body.hidden === true ||
      body.style.display === 'none' ||
      body.classList.contains('bddf-hidden') ||
      window.getComputedStyle(body).display === 'none';
    assert.equal(collapsedHidden, true, '.bddf-body 应收起（不可见）');

    click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bar.getAttribute('data-collapsed'), '0');
    assert.equal(bddf.getOptions().collapsed, false);
  });

  test('Alt+Shift+D 切换启用状态', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    const press = () =>
      document.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'd',
          code: 'KeyD',
          altKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    assert.equal(bddf.isEnabled(), true);
    press();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(bddf.isEnabled(), false, 'Alt+Shift+D 应停用');
    press();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(bddf.isEnabled(), true, '再按一次应启用');
  });

  test('输入框内 Alt+Shift+D 不触发', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    const input = document.createElement('input');
    document.querySelector('.bili-dyn-list-tabs').after(input);
    input.focus();
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'd',
        code: 'KeyD',
        altKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(bddf.isEnabled(), true, '输入框内不应切换');
  });
});

describe('SPEC 3.5 GM_registerMenuCommand', () => {
  test('注册两项菜单命令，且可生效', async () => {
    const { gm, menus } = createGM();
    const { requireApi, document } = await boot({ gm });
    const bddf = requireApi();

    assert.equal(menus.length, 2, `应注册 2 项，实际：${menus.map((m) => m.label).join(' / ')}`);
    const toggle = menus.find((m) => /启用|停用/.test(m.label));
    const reset = menus.find((m) => /重置/.test(m.label));
    assert.ok(toggle, '缺少「启用/停用时长筛选」菜单');
    assert.ok(reset, '缺少「重置筛选范围」菜单');

    bddf.setRange(3600, 7200);
    assert.equal(isHidden(itemById(document, 'dyn-0')), true, '前置：45s 应被隐藏');
    reset.fn();
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(plain(bddf.getRange()), { min: 0, max: Infinity }, '菜单应重置范围');

    toggle.fn();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(bddf.isEnabled(), false, '菜单应能停用');
  });

  test('没有 GM_registerMenuCommand 时静默（不抛错）', async () => {
    const { scriptError, requireApi } = await boot();
    assert.equal(scriptError, null);
    assert.ok(requireApi());
  });
});

/* ================================================================== */
/* 3.5 滑块交互（jsdom 无布局：只断言状态/aria/气泡，不断言像素）       */
/* ================================================================== */

describe('SPEC 3.5 滑块交互', () => {
  test('setRange 后气泡与 aria-valuenow 同步', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setRange(201, 3723);
    const minThumb = document.querySelector('.bddf-thumb--min');
    const maxThumb = document.querySelector('.bddf-thumb--max');
    assert.equal(document.querySelector('.bddf-bubble--min').textContent.trim(), '03:21');
    assert.equal(document.querySelector('.bddf-bubble--max').textContent.trim(), '1:02:03');
    assert.equal(minThumb.getAttribute('aria-valuenow'), '201');
    assert.equal(maxThumb.getAttribute('aria-valuenow'), '3723');

    bddf.setRange(0, Infinity);
    assert.equal(document.querySelector('.bddf-bubble--max').textContent.trim(), '不限');
    assert.equal(
      maxThumb.getAttribute('aria-valuenow'),
      '10800',
      'Infinity 应对应右端 10800',
    );
  });

  test('键盘 End/Home 调整滑块', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    const minThumb = document.querySelector('.bddf-thumb--min');
    const maxThumb = document.querySelector('.bddf-thumb--max');
    const key = (el, k) =>
      el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, code: k, bubbles: true }));

    // max 按 Home → 移到左端（与 min 相同，具体值随实现夹紧，只需 <= 10800 且 >= min）
    key(maxThumb, 'Home');
    await new Promise((r) => setTimeout(r, 50));
    let range = bddf.getRange();
    assert.ok(range.max <= 10800, `max 应 ≤10800，实际 ${range.max}`);
    assert.ok(range.min <= range.max, '不允许交叉');

    // max 按 End → 右端 = Infinity
    key(maxThumb, 'End');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bddf.getRange().max, Infinity, 'max 到 End 应为 Infinity');

    // min 按 Home → 0
    key(minThumb, 'Home');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bddf.getRange().min, 0, 'min 到 Home 应为 0');

    // 方向键步进 1 分钟（60s）
    bddf.setRange(0, Infinity);
    const before = bddf.getRange().min;
    key(minThumb, 'ArrowRight');
    await new Promise((r) => setTimeout(r, 50));
    const after = bddf.getRange().min;
    assert.ok(after > before, `ArrowRight 应增大 min（${before} → ${after}）`);
    assert.ok(after - before <= 90, `步进应为 1 分钟左右，实际 +${after - before}s`);
  });

  test('pointer 交互不抛错，且 min ≤ max', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    const thumb = document.querySelector('.bddf-thumb--min');
    const track = document.querySelector('.bddf-track');

    // jsdom 无布局（track 宽高 0）：不断言移动结果，只保证健壮性 + UI 不崩
    assert.doesNotThrow(() => {
      thumb.dispatchEvent(
        new window.MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }),
      );
      window.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 0 }));
      window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 20, clientY: 0 }));
      track.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 10, clientY: 5 }));
      thumb.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 80));

    const range = bddf.getRange();
    assert.ok(range.min <= range.max, 'min 不得大于 max');
    assert.ok(Number.isFinite(range.min), 'min 应为有限数');
    assert.match(
      document.querySelector('.bddf-bubble--min').textContent.trim(),
      /^(\d+:[0-5]\d|\d+:[0-5]\d:[0-5]\d|不限)$/,
      '气泡文本格式应符合 formatDuration',
    );
    assert.equal(document.querySelectorAll('.bddf-bar').length, 1);
  });

  test('min > max 时自动夹紧（不允许交叉）', async () => {
    const { requireApi } = await boot();
    const bddf = requireApi();
    bddf.setRange(300, 600);
    bddf.setRange(900, 600);
    const range = bddf.getRange();
    assert.ok(range.min <= range.max, `不允许交叉，实际 ${JSON.stringify(range)}`);
  });

  test('对数映射：右端 10800 归一到 Infinity，其余秒值精确往返', async () => {
    const { requireApi } = await boot();
    const bddf = requireApi();
    const points = [0, 60, 600, 1800, 3600];
    for (let i = 0; i < points.length; i += 1) {
      bddf.setRange(0, points[i]);
      assert.equal(bddf.getRange().max, points[i], `${points[i]}s 应精确往返`);
    }
    // SPEC 3.5：定义域右端（10800s）即「不限」，实现归一化为 Infinity
    bddf.setRange(0, 10800);
    const atRightEnd = bddf.getRange().max;
    assert.ok(
      atRightEnd === Infinity || atRightEnd === 10800,
      `定义域右端应表示「不限」，实际 ${atRightEnd}`,
    );
    assert.equal(bddf.formatDuration(atRightEnd), '不限', '右端气泡应显示「不限」');
    bddf.setRange(0, Infinity);
    assert.equal(bddf.getRange().max, Infinity);
  });
});

/* ================================================================== */
/* 3.5 自动加载（autofill）：只验证“会滚/不会滚”，不依赖真实网络      */
/* ================================================================== */

describe('SPEC 3.5 自动加载', () => {
  test('视频投稿 tab + 可见视频不足目标数：autofill 会触发加载，且低频', async () => {
    const { document, requireApi, window } = await boot({
      items: [
        { kind: 'video', duration: '45:00' },
        { kind: 'text' },
      ],
      withLoadMore: true,
      activeTab: 'video', // 自动加载只在视频投稿 tab 生效
    });
    const bddf = requireApi();
    assert.equal(bddf.getOptions().autofill, true);
    const scroll = trackScroll({ window, document });

    bddf.setRange(0, Infinity);
    scroll.reset();

    await new Promise((r) => setTimeout(r, 2800));
    assert.ok(scroll.count >= 1, '视频投稿 tab 下 autofill 应触发加载');

    // 实现会在一次触发里先滚到底部、再还原用户位置（两次滚动调用属于同一轮），
    // 因此按「时间簇」而不是「调用次数」统计轮次。
    const clusters = [];
    for (const e of scroll.at) {
      const last = clusters[clusters.length - 1];
      if (!last || e.t - last.t > 300) clusters.push(e);
      else last.t = e.t;
    }
    assert.ok(clusters.length <= 3, `2.8s 内不应超过 3 轮，实际 ${clusters.length} 轮`);
    if (clusters.length >= 2) {
      const gaps = clusters.slice(1).map((e, i) => e.t - clusters[i].t);
      assert.ok(
        gaps.every((g) => g >= 1000),
        `每轮间隔应 ≥1200ms（留 200ms 容差），实际 ${gaps.join(',')}ms`,
      );
    }
    // 关键：滚动后必须还原，不能把用户拽到底部
    const restored = scroll.at.some((e) => e.via === 'scrollTo');
    assert.ok(restored, '触发加载后应调用 scrollTo 还原原位置');
  });

  test('非视频投稿 tab（全部/追番/专栏）下 autofill 完全不触发', async () => {
    for (const tab of ['all', 'pgc', 'article']) {
      const { document, requireApi, window } = await boot({
        items: [{ kind: 'video', duration: '45:00' }],
        withLoadMore: true,
        activeTab: tab,
      });
      const bddf = requireApi();
      const scroll = trackScroll({ window, document });
      scroll.reset();
      bddf.setRange(3600, Infinity);
      await new Promise((r) => setTimeout(r, 1600));
      assert.equal(scroll.count, 0, `${tab} tab 下不应滚动加载，实际 ${scroll.count} 次`);
    }
  });

  test('autofill=false 时不滚动', async () => {
    const { document, requireApi, window } = await boot({
      items: [{ kind: 'video', duration: '45:00' }],
      withLoadMore: true,
    });
    const bddf = requireApi();
    bddf.setOptions({ autofill: false });
    const scroll = trackScroll({ window, document });
    bddf.setRange(3600, Infinity);
    scroll.reset();
    await new Promise((r) => setTimeout(r, 2800));
    assert.equal(scroll.count, 0, 'autofill 关闭时不应滚动');
  });

  test('页面已到底（no-more）时不滚动', async () => {
    const { document, requireApi, window } = await boot({
      items: [{ kind: 'video', duration: '45:00' }],
      withNoMore: true,
    });
    const bddf = requireApi();
    const scroll = trackScroll({ window, document });
    bddf.setRange(3600, Infinity);
    scroll.reset();
    await new Promise((r) => setTimeout(r, 2800));
    assert.equal(scroll.count, 0, '到底后不应继续触发加载');
  });

  test('可见视频已达目标数（20）时不滚动', async () => {
    // 构造 20 条可见视频，达到 AUTOFILL_TARGET 后应停止
    const many = [];
    for (let i = 0; i < 20; i += 1) many.push({ kind: 'video', duration: '05:00' });
    const { document, requireApi, window } = await boot({
      items: many,
      withLoadMore: true,
      activeTab: 'video',
    });
    const bddf = requireApi();
    const scroll = trackScroll({ window, document });
    bddf.setRange(0, Infinity);
    scroll.reset();
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(scroll.count, 0, '已达目标条数时不应继续自动加载');
    assert.ok(bddf.getStats().visible >= 20);
  });
});
