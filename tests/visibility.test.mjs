/**
 * 模块可见性：只在「视频投稿」标签页出现并生效。
 * 其他 tab 下：模块整体隐藏，且不施加任何筛选（列表保持原样）。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, closeAllPages, getItems, isHidden, waitUntil } from './helpers.mjs';

after(closeAllPages);

const items = [
  { kind: 'video', duration: '00:45' },
  { kind: 'video', duration: '15:40' },
  { kind: 'text' },
];

const barHidden = (document) =>
  document.querySelector('.bddf-bar')?.getAttribute('data-hidden') === '1';

const barDisplay = (window, document) => {
  const bar = document.querySelector('.bddf-bar');
  return bar ? window.getComputedStyle(bar).display : null;
};

describe('模块仅在「视频投稿」标签页可见', () => {
  test('video tab：模块可见且可筛选', async () => {
    const { document, requireApi } = await boot({ items, activeTab: 'video' });
    const bddf = requireApi();
    assert.equal(barHidden(document), false, '视频投稿 tab 下模块应可见');
    bddf.setRange(600, Infinity);
    assert.equal(isHidden(getItems(document)[0]), true, '00:45 应隐藏');
    assert.equal(isHidden(getItems(document)[1]), false, '15:40 应可见');
  });

  for (const tab of ['all', 'pgc', 'article']) {
    test(`${tab} tab：模块隐藏且不施加筛选`, async () => {
      const { document, requireApi, window } = await boot({ items, activeTab: tab });
      const bddf = requireApi();

      assert.equal(barHidden(document), true, `${tab} tab 下模块应隐藏`);
      assert.equal(barDisplay(window, document), 'none', '应为 display:none');

      // 即使设置范围，也不应隐藏任何内容
      bddf.setRange(600, Infinity);
      const hiddenCount = getItems(document).filter(isHidden).length;
      assert.equal(hiddenCount, 0, `${tab} tab 下不应隐藏任何动态`);

      // 模块不可见时「显示 x / y」仍应保持全量
      assert.equal(bddf.getStats().hidden, 0);
    });
  }

  test('切 tab：视频投稿 → 全部 时模块隐藏并撤销筛选', async () => {
    const { document, requireApi } = await boot({ items, activeTab: 'video' });
    const bddf = requireApi();
    bddf.setRange(600, Infinity);
    assert.ok(getItems(document).filter(isHidden).length > 0, '前置：应已隐藏部分');

    // 模拟点击「全部」
    const tabs = [...document.querySelectorAll('.bili-dyn-list-tabs__item')];
    const allTab = tabs.find((t) => t.textContent.trim() === '全部');
    const videoTab = tabs.find((t) => t.textContent.trim() === '视频投稿');
    allTab.classList.add('active');
    videoTab.classList.remove('active');
    bddf.scan();

    await waitUntil(() => barHidden(document) === true, { label: '模块隐藏' });
    assert.equal(
      getItems(document).filter(isHidden).length,
      0,
      '离开视频投稿后应撤销所有筛选，恢复列表原样',
    );
  });

  test('切回视频投稿：模块重新出现并恢复筛选', async () => {
    const { document, requireApi } = await boot({ items, activeTab: 'all' });
    const bddf = requireApi();
    bddf.setRange(600, Infinity);
    assert.equal(barHidden(document), true, '初始在全部 tab，模块隐藏');

    const tabs = [...document.querySelectorAll('.bili-dyn-list-tabs__item')];
    const allTab = tabs.find((t) => t.textContent.trim() === '全部');
    const videoTab = tabs.find((t) => t.textContent.trim() === '视频投稿');
    videoTab.classList.add('active');
    allTab.classList.remove('active');
    bddf.scan();

    await waitUntil(() => barHidden(document) === false, { label: '模块重新出现' });
    assert.equal(isHidden(getItems(document)[0]), true, '恢复后 00:45 应被隐藏');
    assert.equal(isHidden(getItems(document)[1]), false, '15:40 应可见');
  });

  test('无 tab 栏时不隐藏模块（向后兼容）', async () => {
    const { document, requireApi } = await boot({ items, withTabs: false });
    const bddf = requireApi();
    assert.ok(document.querySelector('.bddf-bar'), '无 tab 时仍应挂载');
    assert.equal(barHidden(document), false);
    bddf.setRange(600, Infinity);
    assert.equal(isHidden(getItems(document)[0]), true, '无 tab 时筛选照常工作');
  });
});
