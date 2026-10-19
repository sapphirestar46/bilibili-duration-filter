/**
 * 自动加载的刹车：轮数上限、时间预算、无缺口时不空转。
 * 背景：筛选条件极端（如 ≥1小时）时整屏只剩一两条，
 * 脚本应自动补到接近 B 站默认一页（20），但绝不允许无限跑。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, closeAllPages, trackScroll } from './helpers.mjs';

after(closeAllPages);

/** 一批视频，全部会被「≥1小时」筛掉 → 可见视频恒为 0，制造持续缺口 */
const allShort = Array.from({ length: 8 }, () => ({ kind: 'video', duration: '05:00' }));

const baseOpts = (extra = {}) => ({
  items: allShort,
  withLoadMore: true,
  activeTab: 'video',
  ...extra,
});

describe('自动加载刹车', () => {
  test('缺口存在时会持续补充，但不超过轮数上限', async () => {
    const { document, requireApi, window } = await boot(baseOpts());
    const bddf = requireApi();
    const scroll = trackScroll({ window, document });
    bddf.setRange(3600, Infinity); // 全部筛掉，缺口一直存在
    scroll.reset();

    // 观察 8 秒：间隔 1.2s，轮数上限 20，但 jsdom 里列表不会真的增长
    await new Promise((r) => setTimeout(r, 8000));
    const clusters = [];
    for (const e of scroll.at) {
      const last = clusters[clusters.length - 1];
      if (!last || e.t - last.t > 300) clusters.push({ t: e.t });
      else last.t = e.t;
    }
    // 连续 2 轮无增长就会停手，所以 8 秒内远少于 20 轮
    assert.ok(clusters.length <= 8, `不应无限补充，实际 ${clusters.length} 轮`);
    assert.ok(scroll.count > 0, '应至少尝试过一轮');
  });

  test('没有缺口（可见视频已达标）时不触发任何滚动', async () => {
    const many = Array.from({ length: 25 }, () => ({ kind: 'video', duration: '05:00' }));
    const { requireApi, window, document } = await boot(
      baseOpts({ items: many }),
    );
    const bddf = requireApi();
    const scroll = trackScroll({ window, document });
    bddf.setRange(0, Infinity); // 25 条全可见 >= 20，无缺口
    scroll.reset();

    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(scroll.count, 0, `已达标不应滚动，实际 ${scroll.count} 次`);
  });

  test('页面到底（no-more）时不再补充', async () => {
    const { requireApi, window, document } = await boot(
      baseOpts({ withNoMore: true }),
    );
    const bddf = requireApi();
    const scroll = trackScroll({ window, document });
    bddf.setRange(3600, Infinity);
    scroll.reset();

    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(scroll.count, 0, '到底后不应滚动');
  });

  test('切到非视频投稿 tab 后立即停止补充', async () => {
    const { document, requireApi, window } = await boot(baseOpts());
    const bddf = requireApi();
    bddf.setRange(3600, Infinity);

    // 让它先跑起来
    await new Promise((r) => setTimeout(r, 1400));

    // 切到「全部」
    const tabs = [...document.querySelectorAll('.bili-dyn-list-tabs__item')];
    tabs.find((t) => t.textContent.trim() === '全部').classList.add('active');
    tabs.find((t) => t.textContent.trim() === '视频投稿').classList.remove('active');
    bddf.scan();

    const scroll = trackScroll({ window, document });
    scroll.reset();
    await new Promise((r) => setTimeout(r, 2600));
    assert.equal(scroll.count, 0, '切走后不应继续滚动');
  });

  test('补充过程不改变用户的滚动位置（每次触发都还原）', async () => {
    const { document, requireApi, window } = await boot(baseOpts());
    const bddf = requireApi();

    // 记录 scrollTo 的调用参数
    const calls = [];
    const original = window.scrollTo;
    window.scrollTo = function (x, y) {
      calls.push([x, y]);
      try {
        return original.apply(window, arguments);
      } catch {
        return undefined;
      }
    };

    await window.scrollTo(0, 500);
    bddf.setRange(3600, Infinity);
    await new Promise((r) => setTimeout(r, 2000));

    // 每次补充都应包含一次「还原到原位置」的 scrollTo
    const restores = calls.filter(([, y]) => y === 500);
    assert.ok(restores.length > 0, `应还原到原滚动位置，实际调用 ${JSON.stringify(calls.slice(0, 6))}`);
  });
});
