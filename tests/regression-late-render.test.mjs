/**
 * 回归测试：真实 B 站是 SPA，@run-at document-idle 执行时
 * Vue 往往还没渲染出 .bili-dyn-list__items。
 * 脚本必须先把观察器装上，等列表出现后自动挂载，而不是永久放弃。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, closeAllPages, isHidden, itemById, waitUntil } from './helpers.mjs';

after(closeAllPages);

/** 只有 tab 栏、列表还没渲染的页面（模拟 SPA 首次加载） */
// 筛选模块只在「视频投稿」tab 工作，故 fixture 需让该 tab 处于 active
const LATE_PAGE = `<!DOCTYPE html><html><body>
  <div class="bili-dyn-list-tabs">
    <div class="bili-dyn-list-tabs__item">全部</div>
    <div class="bili-dyn-list-tabs__item active">视频投稿</div>
  </div>
  <div id="dyn-home-app"></div>
</body></html>`;

const LATE_ITEMS = `
  <div class="bili-dyn-list__item" data-fixture-id="late-0">
    <div class="bili-dyn-item"><div class="bili-dyn-card-video">
      <div class="bili-dyn-card-video__cover-shadow"><div class="duration-time">03:21</div></div>
    </div></div>
  </div>
  <div class="bili-dyn-list__item" data-fixture-id="late-1">
    <div class="bili-dyn-item"><div class="bili-dyn-card-video">
      <div class="bili-dyn-card-video__cover-shadow"><div class="duration-time">1:02:03</div></div>
    </div></div>
  </div>`;

describe('回归：列表延迟渲染（真实 B 站 SPA 场景）', () => {
  test('脚本先于列表执行 → 列表出现后自动挂载并筛选', async () => {
    const { document, requireApi } = await boot({ html: LATE_PAGE });
    const bddf = requireApi();

    // 初始：列表还没渲染，不应挂载，但也不应抛错
    assert.equal(document.querySelector('.bddf-bar'), null, '列表未出现时不应挂载');

    // 模拟 Vue 稍后渲染出列表
    const app = document.querySelector('#dyn-home-app');
    const list = document.createElement('div');
    list.className = 'bili-dyn-list';
    list.innerHTML = `<div class="bili-dyn-list__items">${LATE_ITEMS}</div>`;
    app.appendChild(list);

    // 观察器应在有限时间内自动挂载（不依赖手动 mount）
    await waitUntil(() => !!document.querySelector('.bddf-bar'), {
      timeoutMs: 3000,
      label: '列表出现后自动挂载 .bddf-bar',
    });
    assert.equal(document.querySelectorAll('.bddf-bar').length, 1);

    // 且已能正常筛选
    bddf.setRange(60, 300);
    assert.equal(isHidden(itemById(document, 'late-0')), false, '201s 应可见');
    assert.equal(isHidden(itemById(document, 'late-1')), true, '3723s 应隐藏');
  });

  test('延迟渲染后新增动态仍被继续筛选（观察器未断）', async () => {
    const { document, requireApi } = await boot({ html: LATE_PAGE });
    const bddf = requireApi();

    const app = document.querySelector('#dyn-home-app');
    const list = document.createElement('div');
    list.className = 'bili-dyn-list';
    list.innerHTML = `<div class="bili-dyn-list__items">${LATE_ITEMS}</div>`;
    app.appendChild(list);
    await waitUntil(() => !!document.querySelector('.bddf-bar'), { timeoutMs: 3000 });

    bddf.setRange(60, 300);

    // 再追加一条短视频
    const container = document.querySelector('.bili-dyn-list__items');
    const extra = document.createElement('div');
    extra.className = 'bili-dyn-list__item';
    extra.setAttribute('data-fixture-id', 'late-2');
    extra.innerHTML =
      '<div class="bili-dyn-item"><div class="bili-dyn-card-video">' +
      '<div class="bili-dyn-card-video__cover-shadow"><div class="duration-time">00:30</div></div>' +
      '</div></div>';
    container.appendChild(extra);

    await waitUntil(() => isHidden(extra) === true, {
      timeoutMs: 3000,
      label: '新增 30s 动态应被隐藏',
    });
    assert.equal(isHidden(itemById(document, 'late-0')), false, '201s 仍可见');
  });
});
