/**
 * 回归测试：针对真实使用中暴露的两个问题。
 *
 * 1) 「拖动没反应」—— B 站改版 / AB 测试导致 .bili-dyn-card-video 类名未命中时，
 *    早期实现会把所有动态当成「非视频」，叠加 onlyVideo=false 后全部放行。
 *    修复后应以 .duration-time 文本为主要信号，仍能正常筛选。
 *
 * 2) 「前半段全是 1 分钟以内」—— 对数刻度把 1 分钟映射到 44% 位置，
 *    筛长视频时可选区域过窄。修复后改为分段线性：0–10min 占 30%，10min–3h 占 70%。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, closeAllPages, getItems, isHidden, waitUntil } from './helpers.mjs';

after(closeAllPages);

/** 没有 .bili-dyn-card-video 类名，但仍有 .duration-time 的「变异」页面 */
const NO_CARD_CLASS_PAGE = `<!DOCTYPE html><html><body>
  <div class="bili-dyn-list-tabs"><div class="bili-dyn-list-tabs__item active">视频投稿</div></div>
  <div class="bili-dyn-list"><div class="bili-dyn-list__items">
    <div class="bili-dyn-list__item" data-fixture-id="v-short">
      <div class="bili-dyn-item"><div class="bili-dyn-card-newvideo">
        <div class="duration-time">00:30</div>
      </div></div>
    </div>
    <div class="bili-dyn-list__item" data-fixture-id="v-mid">
      <div class="bili-dyn-item"><div class="bili-dyn-card-newvideo">
        <div class="duration-time">08:12</div>
      </div></div>
    </div>
    <div class="bili-dyn-list__item" data-fixture-id="v-long">
      <div class="bili-dyn-item"><div class="bili-dyn-card-newvideo">
        <div class="duration-time">1:12:30</div>
      </div></div>
    </div>
    <div class="bili-dyn-list__item" data-fixture-id="plain-text">
      <div class="bili-dyn-item"><div class="bili-rich-text">纯文字动态</div></div>
    </div>
  </div></div>
</body></html>`;

const byId = (document, id) =>
  document.querySelector(`.bili-dyn-list__item[data-fixture-id="${id}"]`);

describe('回归：类名未命中时仍能按时长筛选', () => {
  test('无 .bili-dyn-card-video 类名，但有时长文本 → 仍按区间过滤', async () => {
    const { document, requireApi } = await boot({ html: NO_CARD_CLASS_PAGE });
    const bddf = requireApi();

    // 关键复现条件：onlyVideo 保持默认 false
    assert.equal(bddf.getOptions().onlyVideo, false);

    bddf.setRange(600, Infinity); // ≥10 分钟

    assert.equal(isHidden(byId(document, 'v-short')), true, '00:30 应隐藏（核心 bug 复现点）');
    assert.equal(isHidden(byId(document, 'v-mid')), true, '08:12 = 492s < 600s，应隐藏');
    assert.equal(isHidden(byId(document, 'v-long')), false, '1:12:30 应可见');
    // 纯文字动态（无时长、无视频结构）→ 不算视频，onlyVideo=false 时保留
    assert.equal(isHidden(byId(document, 'plain-text')), false, '非视频动态默认保留');
  });

  test('统计口径与筛选一致：有时长文本的项计入 videos', async () => {
    const { requireApi } = await boot({ html: NO_CARD_CLASS_PAGE });
    const bddf = requireApi();
    const stats = bddf.getStats();
    assert.equal(stats.total, 4);
    assert.equal(stats.videos, 3, '3 条带时长文本的应计为视频');
    assert.equal(stats.unknown, 0, '都能解析出时长');
  });

  test('8:12 在 ≥10 分钟下应被隐藏（区间语义校验）', async () => {
    const { document, requireApi } = await boot({ html: NO_CARD_CLASS_PAGE });
    const bddf = requireApi();
    bddf.setRange(600, Infinity);
    assert.equal(isHidden(byId(document, 'v-mid')), true, '492s 不在 [600,∞) 内');
  });
});

describe('回归：滑块刻度偏向长视频', () => {

  test('阶梯刻度：各典型时长在轨道上的相对顺序正确', async () => {
    const h = await boot({ html: NO_CARD_CLASS_PAGE });
    const { document, requireApi } = h;

    const posOf = (sec) => {
      requireApi().setRange(0, sec);
      // max 滑块位置即该时长在轨道上的百分比
      return parseFloat(document.querySelector('.bddf-thumb--max').style.left);
    };

    const p60 = posOf(60);
    const p600 = posOf(600);
    const p3600 = posOf(3600);
    const p7200 = posOf(7200);

    // 单调递增
    assert.ok(p60 < p600, `60s(${p60}) 应在 600s(${p600}) 左侧`);
    assert.ok(p600 < p3600, `10min 应在 1h 左侧`);
    assert.ok(p3600 < p7200, `1h 应在 2h 左侧`);

    // 关键：1 分钟应落在一小段内（旧对数刻度下是 44.3%）
    assert.ok(p60 <= 5, `1 分钟应位于轨道最左侧 ≤5%，实际 ${p60}%（旧实现为 44.3%）`);
    // 10 分钟落在约 30% 处
    assert.ok(Math.abs(p600 - 30) <= 2, `10 分钟应约在 30%，实际 ${p600}%`);
    // 1 小时落在轨道中段，长视频区间被显著放大
    assert.ok(p3600 > 45 && p3600 < 60, `1 小时应约在轨道中部，实际 ${p3600}%`);
    // 长视频（10min–3h）占据 70% 的轨道
    assert.ok(p7200 - p600 > 40, `10min→2h 应占据 >40% 轨道，实际 ${(p7200 - p600).toFixed(1)}%`);
  });

  test('新增「≥10分钟 / ≥30分钟」预设可用', async () => {
    const h = await boot({ html: NO_CARD_CLASS_PAGE });
    const { document, requireApi, window } = h;
    const bddf = requireApi();

    const p10 = document.querySelector('.bddf-preset[data-min="600"][data-max="Infinity"]');
    assert.ok(p10, '缺少 ≥10分钟 预设');
    assert.equal(p10.textContent.trim(), '≥10分钟');

    p10.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(JSON.parse(JSON.stringify(bddf.getRange())), { min: 600, max: null });
    assert.equal(p10.classList.contains('active'), true);
  });
});
