/**
 * SPEC 3.4 / 3.5：筛选语义、UI 注入、计数、统计、预设、持久化、静默页。
 * 对应测试契约第 2、6、7、9、10、11 条。
 *
 * fixture（DEFAULT_ITEMS）索引：
 *   dyn-0 00:45 / dyn-1 00:59 / dyn-2 03:21 / dyn-3 05:01 / dyn-4 08:12
 *   dyn-5 15:40 / dyn-6 42:05 / dyn-7 1:02:03 / dyn-8 12:34 / dyn-9 无时长视频
 *   dyn-10,11 文字 / dyn-12 专栏 / dyn-13 追番
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ITEMS,
  boot,
  closeAllPages,
  copyLocalStorage,
  createGM,
  createPage,
  createThrowingGM,
  decodeStored,
  getCounts,
  getItems,
  hasHiddenStyle,
  hiddenFlags,
  itemById,
  loadScript,
  isHidden,
  pageHtml,
  plain,
  readLocalStorage,
  snapshot,
} from './helpers.mjs';

after(closeAllPages);

const VIDEO_IDS = ['dyn-0', 'dyn-1', 'dyn-2', 'dyn-3', 'dyn-4', 'dyn-5', 'dyn-6', 'dyn-7', 'dyn-8', 'dyn-9'];
const NON_VIDEO_IDS = ['dyn-10', 'dyn-11', 'dyn-12', 'dyn-13'];

const hiddenIds = (document) =>
  getItems(document)
    .filter((el) => isHidden(el))
    .map((el) => el.getAttribute('data-fixture-id'));

/** 隐藏后 class 与属性必须成对出现（SPEC 3.4.4） */
function assertHiddenContract(el, label) {
  assert.ok(el, `${label} 不存在`);
  const flags = hiddenFlags(el);
  assert.equal(flags.cls, true, `${label} 应含 class bddf-hidden`);
  assert.equal(flags.attr, '1', `${label} 应含 data-bddf-hidden="1"`);
}

/** 显示后 class 与属性必须都清掉（SPEC 3.4.4） */
function assertShownContract(el, label) {
  assert.ok(el, `${label} 不存在`);
  const flags = hiddenFlags(el);
  assert.equal(flags.cls, false, `${label} 不应含 class bddf-hidden`);
  assert.equal(flags.attr, null, `${label} 不应含 data-bddf-hidden`);
}

/* ================================================================== */
/* 2. 挂载与注入位置                                                  */
/* ================================================================== */

describe('SPEC 3.5 注入位置与幂等', () => {
  test('正常页：.bddf-bar 存在且紧跟 .bili-dyn-list-tabs', async () => {
    const { document, requireApi } = await boot();
    requireApi();
    const bar = document.querySelector('.bddf-bar');
    const tabs = document.querySelector('.bili-dyn-list-tabs');
    assert.ok(bar, '.bddf-bar 应存在');
    assert.ok(tabs, 'fixture 应含 tabs');
    assert.equal(document.querySelectorAll('.bddf-bar').length, 1);
    assert.equal(bar.previousElementSibling, tabs, '筛选条应是 tabs 的下一个兄弟节点');
    assert.equal(bar.getAttribute('data-bddf'), '1');
    assert.equal(bar.getAttribute('data-collapsed'), '0');
  });

  test('UI 结构与选择器符合 3.5', async () => {
    const { document, requireApi } = await boot();
    requireApi();
    const q = (sel) => document.querySelector(sel);
    for (const sel of [
      '.bddf-bar .bddf-head',
      '.bddf-bar .bddf-title',
      '.bddf-bar .bddf-switch .bddf-enabled',
      '.bddf-bar .bddf-count',
      '.bddf-bar .bddf-reset',
      '.bddf-bar .bddf-collapse',
      '.bddf-bar .bddf-body',
      '.bddf-bar .bddf-slider-wrap .bddf-track .bddf-range',
      '.bddf-bar .bddf-thumb--min',
      '.bddf-bar .bddf-thumb--max',
      '.bddf-bar .bddf-bubble--min',
      '.bddf-bar .bddf-bubble--max',
      '.bddf-bar .bddf-opts .bddf-only-video',
      '.bddf-bar .bddf-opts .bddf-autofill',
      '.bddf-bar .bddf-hint',
    ]) {
      assert.ok(q(sel), `缺少 ${sel}`);
    }
    assert.equal(document.querySelectorAll('.bddf-bar .bddf-preset').length, 9, '应有 9 个预设（含长视频快捷档）');
    const minThumb = q('.bddf-thumb--min');
    const maxThumb = q('.bddf-thumb--max');
    assert.equal(minThumb.getAttribute('role'), 'slider');
    assert.equal(maxThumb.getAttribute('role'), 'slider');
    assert.equal(minThumb.getAttribute('aria-label'), '最短时长');
    assert.equal(maxThumb.getAttribute('aria-label'), '最长时长');
    assert.equal(minThumb.getAttribute('aria-valuemin'), '0');
    assert.equal(minThumb.getAttribute('aria-valuemax'), '10800');
    assert.equal(q('.bddf-bubble--min').textContent.trim(), '00:00');
    assert.equal(q('.bddf-bubble--max').textContent.trim(), '不限');
    assert.equal(q('.bddf-enabled').checked, true);
    assert.equal(q('.bddf-only-video').checked, false, 'SPEC 3.2：默认 onlyVideo=false');
    assert.equal(q('.bddf-autofill').checked, true);
  });

  test('重复 mount()：bar 数量恒为 1，__BDDF__ 引用不变', async () => {
    const { document, window, requireApi } = await boot();
    const bddf = requireApi();
    const before = bddf;
    assert.equal(bddf.mount(), true);
    assert.equal(bddf.mount(), true);
    assert.equal(bddf.mount(), true);
    assert.equal(document.querySelectorAll('.bddf-bar').length, 1);
    assert.equal(window.__BDDF__, before, '__BDDF__ 必须始终指向同一对象');
  });

  test('无 tabs 时插到 .bili-dyn-list__items 前面', async () => {
    const { document, requireApi } = await boot({ withTabs: false });
    requireApi();
    const bar = document.querySelector('.bddf-bar');
    const items = document.querySelector('.bili-dyn-list__items');
    assert.ok(bar, '无 tabs 也应注入');
    assert.equal(bar.nextElementSibling, items, '筛选条应紧邻 items 之前');
  });

  test('隐藏样式已注入（3.4.4）', async () => {
    const { document, requireApi } = await boot();
    requireApi();
    assert.equal(
      hasHiddenStyle(document),
      true,
      '缺少 `.bili-dyn-list__item.bddf-hidden{display:none!important}`',
    );
  });

  test('不覆盖除 __BDDF__ 之外的全局变量', async () => {
    const { window, requireApi } = await boot();
    requireApi();
    for (const name of ['BDDF', 'bddf', '$$', 'utils', 'parseDuration', 'filterBar']) {
      assert.equal(name in window, false, `脚本不应污染全局 ${name}`);
    }
  });
});

/* ================================================================== */
/* 3. 默认状态                                                        */
/* ================================================================== */

describe('SPEC 3.2/3.4 默认状态', () => {
  test('默认范围 0..Infinity，全部项可见', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    assert.deepEqual(plain(bddf.getRange()), { min: 0, max: Infinity });
    assert.equal(bddf.isEnabled(), true);
    // SPEC 3.2：onlyVideo 默认 false（默认不隐藏非视频动态）
    assert.deepEqual(plain(bddf.getOptions()), { onlyVideo: false, autofill: true, collapsed: false });
    assert.deepEqual(plain(hiddenIds(document)), [], '默认不应隐藏任何项');
    assert.equal(getItems(document).length, DEFAULT_ITEMS.length);
    assert.equal(document.querySelector('.bddf-bar').getAttribute('data-collapsed'), '0');
  });

  test('默认计数文本 显示 N / N', async () => {
    const { document, requireApi } = await boot();
    requireApi();
    const counts = getCounts(document);
    assert.equal(counts.total, DEFAULT_ITEMS.length);
    assert.equal(counts.visible, DEFAULT_ITEMS.length);
  });
});

/* ================================================================== */
/* 4. 筛选语义                                                        */
/* ================================================================== */

describe('SPEC 3.4 setRange(60, 300)', () => {
  test('201s 可见；59s/301s 隐藏；无时长视频显示；onlyVideo=true 时非视频隐藏', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    // SPEC 3.2 起 onlyVideo 默认 false；本用例验证「开启 onlyVideo」后的语义
    bddf.setOptions({ onlyVideo: true });
    bddf.setRange(60, 300);

    assert.equal(isHidden(itemById(document, 'dyn-2')), false, '201s 落在 [60,300] 应可见');
    assert.equal(isHidden(itemById(document, 'dyn-1')), true, '59s < 60 应隐藏');
    assert.equal(isHidden(itemById(document, 'dyn-3')), true, '301s > 300 应隐藏');
    assert.equal(isHidden(itemById(document, 'dyn-9')), false, '无时长视频应显示（不误伤）');
    for (const id of NON_VIDEO_IDS) {
      assert.equal(isHidden(itemById(document, id)), true, `${id}（非视频，onlyVideo=true）应隐藏`);
    }
    for (const id of ['dyn-0', 'dyn-4', 'dyn-5', 'dyn-6', 'dyn-7', 'dyn-8']) {
      assert.equal(isHidden(itemById(document, id)), true, `${id}（不在区间）应隐藏`);
    }

    // class + 属性成对；显示时二者都清掉
    assertHiddenContract(itemById(document, 'dyn-0'), 'dyn-0');
    assertHiddenContract(itemById(document, 'dyn-10'), 'dyn-10');
    assertShownContract(itemById(document, 'dyn-2'), 'dyn-2');
    assertShownContract(itemById(document, 'dyn-9'), 'dyn-9');
  });

  test('闭区间边界：59s 隐藏、60s 可见、300s 可见、301s 隐藏', async () => {
    const { document, requireApi } = await boot({
      items: [
        { kind: 'video', duration: '00:59' },
        { kind: 'video', duration: '01:00' },
        { kind: 'video', duration: '05:00' },
        { kind: 'video', duration: '05:01' },
      ],
    });
    const bddf = requireApi();
    bddf.setRange(60, 300);
    assert.deepEqual(
      plain(snapshot(document).map((s) => [s.id, s.hidden])),
      [
        ['dyn-0', true],
        ['dyn-1', false],
        ['dyn-2', false],
        ['dyn-3', true],
      ],
    );
  });

  test('max = Infinity / null 表示不限上限', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setRange(600, Infinity);
    assert.equal(bddf.getRange().max, Infinity);
    assert.equal(isHidden(itemById(document, 'dyn-8')), false, '754s ≥600 应可见');
    assert.equal(isHidden(itemById(document, 'dyn-7')), false, '3723s 应可见');
    assert.equal(isHidden(itemById(document, 'dyn-4')), true, '492s <600 应隐藏');

    bddf.setRange(600, null);
    assert.equal(bddf.getRange().max, Infinity, 'null 应归一化为 Infinity');
    assert.equal(isHidden(itemById(document, 'dyn-7')), false);
  });

  test('onlyVideo=false：非视频项显示且不受时长区间影响', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setOptions({ onlyVideo: false });
    bddf.setRange(60, 300);
    for (const id of NON_VIDEO_IDS) {
      assert.equal(isHidden(itemById(document, id)), false, `${id}（非视频）应显示`);
    }
    assert.equal(isHidden(itemById(document, 'dyn-2')), false, '201s 应可见');
    assert.equal(isHidden(itemById(document, 'dyn-0')), true, '45s 应隐藏');
  });

  test('时长解析失败的视频项视为 unknown 并显示', async () => {
    const { document, requireApi } = await boot({
      items: [
        { kind: 'video', duration: '03:21' },
        { kind: 'video', duration: 'abc' },
        { kind: 'video', duration: null },
      ],
    });
    const bddf = requireApi();
    bddf.setRange(3600, Infinity);
    assert.equal(isHidden(itemById(document, 'dyn-1')), false, '非法时长 → unknown → 显示');
    assert.equal(isHidden(itemById(document, 'dyn-2')), false, '缺失时长 → 显示');
    assert.equal(isHidden(itemById(document, 'dyn-0')), true, '201s 不在 [3600,∞) 内 → 隐藏');
  });

  test('列表项内第一个 .duration-time 生效', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div class="bili-dyn-list-tabs"></div>
      <div class="bili-dyn-list"><div class="bili-dyn-list__items">
        <div class="bili-dyn-list__item" data-fixture-id="multi">
          <div class="bili-dyn-item">
            <div class="bili-dyn-card-video">
              <span class="duration-time">03:21</span>
              <span class="duration-time">59:59</span>
            </div>
          </div>
        </div>
      </div></div>
    </body></html>`;
    const { document, requireApi } = await boot({ html });
    const bddf = requireApi();
    assert.equal(bddf.parseDuration(document.querySelector('.duration-time').textContent), 201);
    bddf.setRange(600, 1200);
    assert.equal(
      isHidden(document.querySelector('.bili-dyn-list__item')),
      true,
      '取第一个 03:21=201s，不在 [600,1200] → 应隐藏',
    );
  });
});

/* ================================================================== */
/* 6. setEnabled(false)                                               */
/* ================================================================== */

describe('SPEC 3.4 setEnabled(false)', () => {
  test('所有项恢复，data-bddf-hidden 清除', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setRange(3600, Infinity);
    assert.ok(hiddenIds(document).length > 0, '前置条件：应已有隐藏项');

    bddf.setEnabled(false);
    assert.equal(bddf.isEnabled(), false);
    assert.deepEqual(plain(hiddenIds(document)), [], '停用后不应有任何隐藏项');
    for (const el of getItems(document)) {
      assertShownContract(el, el.getAttribute('data-fixture-id'));
    }
    assert.equal(document.querySelector('.bddf-enabled').checked, false);

    bddf.setEnabled(true);
    assert.equal(bddf.isEnabled(), true);
    assert.equal(isHidden(itemById(document, 'dyn-7')), false, '3723s 应可见');
    assert.equal(isHidden(itemById(document, 'dyn-0')), true, '45s 应隐藏');
  });

  test('停用期间 setRange 不隐藏项，但范围被记住', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setEnabled(false);
    bddf.setRange(3600, Infinity);
    assert.deepEqual(plain(hiddenIds(document)), [], '停用期间不应隐藏');
    assert.deepEqual(plain(bddf.getRange()), { min: 3600, max: Infinity });

    bddf.setEnabled(true);
    assert.equal(isHidden(itemById(document, 'dyn-0')), true, '启用后 45s 应隐藏');
    assert.equal(isHidden(itemById(document, 'dyn-7')), false, '启用后 3723s 应可见');
  });

  test('顶部开关复选框切换 enabled', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    const box = document.querySelector('.bddf-enabled');
    box.checked = false;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bddf.isEnabled(), false);
    assert.deepEqual(plain(hiddenIds(document)), []);
  });
});

/* ================================================================== */
/* 5. onlyVideo                                                 */
/* ================================================================== */

describe('SPEC 3.4 onlyVideo', () => {
  test('默认 onlyVideo=false：非视频项全部显示', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    assert.equal(bddf.getOptions().onlyVideo, false, 'SPEC 3.2：默认 false');
    for (const id of NON_VIDEO_IDS) {
      assert.equal(isHidden(itemById(document, id)), false, `${id} 默认应显示`);
    }
    assert.equal(document.querySelector('.bddf-only-video').checked, false, 'UI 应同步');
  });

  test('onlyVideo=true：非视频项隐藏；再设回 false 恢复（SPEC 4.5）', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setOptions({ onlyVideo: true });
    assert.equal(bddf.getOptions().onlyVideo, true);
    for (const id of NON_VIDEO_IDS) {
      assert.equal(isHidden(itemById(document, id)), true, `${id} 应隐藏`);
    }
    assert.equal(document.querySelector('.bddf-only-video').checked, true);
    // onlyVideo 不影响视频项
    for (const id of VIDEO_IDS) {
      assert.equal(isHidden(itemById(document, id)), false, `${id}（视频）应显示`);
    }

    bddf.setOptions({ onlyVideo: false });
    for (const id of NON_VIDEO_IDS) {
      assert.equal(isHidden(itemById(document, id)), false, `${id} 应恢复显示`);
    }
  });

  test('onlyVideo 勾选框点击 → 生效并持久化', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    assert.equal(bddf.getOptions().onlyVideo, false, '前置：默认 false');
    const box = document.querySelector('.bddf-only-video');
    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bddf.getOptions().onlyVideo, true, 'change 事件应更新状态');
    assert.equal(isHidden(itemById(document, 'dyn-10')), true, '非视频项应隐藏');
    assert.equal(
      decodeStored(window.localStorage.getItem('bddf.onlyVideo')),
      true,
      '应写入 bddf.onlyVideo=true',
    );
  });

  test('onlyVideo 反复切换幂等（不复制 UI）', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    for (let i = 0; i < 4; i += 1) {
      bddf.setOptions({ onlyVideo: false });
      assert.equal(isHidden(itemById(document, 'dyn-10')), false);
      bddf.setOptions({ onlyVideo: true });
      assert.equal(isHidden(itemById(document, 'dyn-10')), true);
    }
    assert.equal(document.querySelectorAll('.bddf-bar').length, 1);
  });
});

/* ================================================================== */
/* 7. 预设按钮                                                        */
/* ================================================================== */

describe('SPEC 3.5 预设按钮', () => {
  const click = (window, el) =>
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  test('点击 5–10分钟 预设 → 范围生效且该按钮 .active', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    const preset = document.querySelector('.bddf-preset[data-min="300"][data-max="600"]');
    assert.ok(preset, '缺少 5–10分钟 预设按钮');
    click(window, preset);
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(plain(bddf.getRange()), { min: 300, max: 600 });
    assert.equal(preset.classList.contains('active'), true, '被选中的预设应加 .active');
    assert.equal(document.querySelectorAll('.bddf-preset.active').length, 1);

    assert.equal(isHidden(itemById(document, 'dyn-4')), false, '492s 在区间内应可见');
    assert.equal(isHidden(itemById(document, 'dyn-2')), true, '201s 应隐藏');
    assert.equal(isHidden(itemById(document, 'dyn-5')), true, '940s 应隐藏');
    assert.equal(isHidden(itemById(document, 'dyn-9')), false, '无时长视频仍显示');
  });

  test('切换预设时 .active 随之迁移', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    const fiveMin = document.querySelector('.bddf-preset[data-min="300"][data-max="600"]');
    const oneHour = document.querySelector('.bddf-preset[data-min="3600"][data-max="Infinity"]');

    click(window, fiveMin);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fiveMin.classList.contains('active'), true);

    click(window, oneHour);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(plain(bddf.getRange()), { min: 3600, max: Infinity });
    assert.equal(oneHour.classList.contains('active'), true);
    assert.equal(fiveMin.classList.contains('active'), false);
    assert.equal(document.querySelectorAll('.bddf-preset.active').length, 1);
  });

  test('「不限」预设恢复全显示', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    bddf.setRange(3600, Infinity);
    click(window, document.querySelector('.bddf-preset[data-min="0"][data-max="Infinity"]'));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(plain(bddf.getRange()), { min: 0, max: Infinity });
    assert.deepEqual(plain(hiddenIds(document)), []);
  });

  test('重置按钮恢复默认（enabled/min/max/onlyVideo）', async () => {
    const { document, requireApi, window } = await boot();
    const bddf = requireApi();
    bddf.setEnabled(false);
    bddf.setRange(600, 1800);
    bddf.setOptions({ onlyVideo: true }); // 与默认相反，验证重置回 false（SPEC 3.5）
    bddf.setOptions({ autofill: false });

    click(window, document.querySelector('.bddf-reset'));
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(plain(bddf.getRange()), { min: 0, max: Infinity });
    assert.equal(bddf.isEnabled(), true);
    assert.equal(bddf.getOptions().onlyVideo, false, '重置后 onlyVideo 应为 false（SPEC 3.5）');
    assert.deepEqual(plain(hiddenIds(document)), []);
    assert.equal(document.querySelector('.bddf-enabled').checked, true);
    assert.equal(document.querySelector('.bddf-only-video').checked, false);
  });
});

/* ================================================================== */
/* 9. getStats 与计数文本                                             */
/* ================================================================== */

describe('SPEC 3.5/3.7 getStats 与计数', () => {
  test('初始统计正确', async () => {
    const { requireApi } = await boot();
    const bddf = requireApi();
    const stats = bddf.getStats();
    assert.equal(stats.total, DEFAULT_ITEMS.length, 'total = 所有 .bili-dyn-list__item');
    assert.equal(stats.videos, VIDEO_IDS.length, 'videos = 含 .bili-dyn-card-video 的项');
    assert.equal(stats.visible, DEFAULT_ITEMS.length, '默认全可见');
    assert.equal(stats.hidden, 0);
    assert.equal(stats.unknown, 1, '无时长视频计 1 个 unknown');
  });

  test('setRange 后统计与计数文本一致（onlyVideo 默认 false）', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setRange(60, 300);
    const stats = bddf.getStats();
    assert.equal(stats.total, DEFAULT_ITEMS.length);
    assert.equal(stats.videos, VIDEO_IDS.length);
    // 可见 = 201s 视频 + 无时长视频 + 4 条非视频（onlyVideo 默认 false）
    assert.equal(stats.visible, 6, `实际 ${JSON.stringify(stats)}`);
    assert.equal(stats.hidden, DEFAULT_ITEMS.length - 6);
    assert.equal(stats.unknown, 1);
    assert.equal(stats.visible + stats.hidden, stats.total, 'visible + hidden = total');

    const counts = getCounts(document);
    assert.equal(counts.total, stats.total);
    assert.equal(counts.visible, stats.visible);
    assert.match(counts.text, /显示\s*6\s*\/\s*14/);
  });

  test('onlyVideo=true 时非视频不计入 visible', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setOptions({ onlyVideo: true });
    bddf.setRange(60, 300);
    const stats = bddf.getStats();
    assert.equal(stats.visible, 2, `可见 = 201s + 无时长视频；实际 ${JSON.stringify(stats)}`);
    assert.equal(stats.hidden, DEFAULT_ITEMS.length - 2);
    assert.match(getCounts(document).text, /显示\s*2\s*\/\s*14/);
  });

  test('无结果时计数 0 且加 bddf-empty', async () => {
    const { document, requireApi } = await boot({
      items: [
        { kind: 'video', duration: '03:21' },
        { kind: 'text' },
      ],
    });
    const bddf = requireApi();
    // 非视频默认可见，需开启 onlyVideo 才可能 0 可见
    bddf.setOptions({ onlyVideo: true });
    bddf.setRange(3600, 7200);
    const counts = getCounts(document);
    assert.equal(counts.visible, 0);
    assert.equal(counts.total, 2);
    assert.equal(document.querySelector('.bddf-bar').classList.contains('bddf-empty'), true);
  });

  test('有结果时清除 bddf-empty', async () => {
    const { document, requireApi } = await boot({
      items: [
        { kind: 'video', duration: '03:21' },
        { kind: 'text' },
      ],
    });
    const bddf = requireApi();
    bddf.setOptions({ onlyVideo: true });
    bddf.setRange(3600, 7200);
    assert.equal(document.querySelector('.bddf-bar').classList.contains('bddf-empty'), true);
    bddf.setRange(0, Infinity);
    assert.equal(document.querySelector('.bddf-bar').classList.contains('bddf-empty'), false);
  });

  test('filterNow() 是 scan() 别名', async () => {
    const { document, requireApi } = await boot();
    const bddf = requireApi();
    bddf.setRange(3600, Infinity);
    const hiddenBefore = hiddenIds(document).length;
    const el = itemById(document, 'dyn-0');
    el.classList.remove('bddf-hidden');
    el.removeAttribute('data-bddf-hidden');
    bddf.filterNow();
    assert.equal(hiddenIds(document).length, hiddenBefore, 'filterNow 应重新应用筛选');
  });
});

/* ================================================================== */
/* 10. 持久化                                                         */
/* ================================================================== */

describe('SPEC 3.2 持久化', () => {
  test('localStorage：状态变更立即写入 bddf.* key', async () => {
    const { requireApi, window } = await boot();
    const bddf = requireApi();
    bddf.setRange(60, 300);
    bddf.setOptions({ onlyVideo: true, collapsed: true });
    bddf.setEnabled(false);

    const ls = readLocalStorage(window);
    assert.equal(decodeStored(ls.get('bddf.min')), 60, 'bddf.min');
    assert.equal(decodeStored(ls.get('bddf.max')), 300, 'bddf.max');
    assert.equal(decodeStored(ls.get('bddf.onlyVideo')), true, 'bddf.onlyVideo');
    assert.equal(decodeStored(ls.get('bddf.collapsed')), true, 'bddf.collapsed');
    assert.equal(decodeStored(ls.get('bddf.enabled')), false, 'bddf.enabled');
  });

  test('Infinity 序列化为字符串 "Infinity"', async () => {
    const { requireApi, window } = await boot();
    const bddf = requireApi();
    bddf.setRange(60, Infinity);
    assert.equal(String(window.localStorage.getItem('bddf.max')), 'Infinity', 'max 应存为 "Infinity"');
  });

  test('刷新后（预置 localStorage）重新加载脚本可恢复范围', async () => {
    // 1) 先用一个页面产生真实存储
    const first = await boot();
    first.requireApi().setRange(600, 1800);
    first.requireApi().setOptions({ onlyVideo: true });
    first.requireApi().setEnabled(true);

    // 2) 新页面先把存储灌进去，再执行脚本（等价于浏览器刷新）
    const second = createPage({ items: DEFAULT_ITEMS });
    copyLocalStorage(first.window, second.window);
    const handle = await loadScript(second);
    const api2 = handle.requireApi();

    assert.deepEqual(plain(api2.getRange()), { min: 600, max: 1800 });
    assert.equal(api2.getOptions().onlyVideo, true, 'onlyVideo 应恢复为 true');
    assert.equal(isHidden(itemById(second.document, 'dyn-0')), true, '45s 应隐藏');
    assert.equal(isHidden(itemById(second.document, 'dyn-5')), false, '940s 应可见');
    assert.equal(isHidden(itemById(second.document, 'dyn-10')), true, 'onlyVideo=true 时非视频应隐藏');
    first.close();
  });

  test('GM stub 优先：读写走 GM_*，localStorage 不被使用', async () => {
    const { gm, store, calls } = createGM();
    const { requireApi, window } = await boot({ gm });
    const bddf = requireApi();
    bddf.setRange(300, 600);
    assert.equal(decodeStored(store.get('bddf.min')), 300, 'GM store 应写入 bddf.min');
    assert.equal(decodeStored(store.get('bddf.max')), 600, 'GM store 应写入 bddf.max');
    assert.ok(calls.some((c) => c.type === 'set' && c.key === 'bddf.min'), '应调用 GM_setValue');
    assert.equal(window.localStorage.getItem('bddf.min'), null, '有 GM 时不应回退 localStorage');
  });

  test('GM stub 预置存储 → 脚本初始化即恢复', async () => {
    // 先让一个页面写出一套 GM 值，再把同一个 store 交给新页面
    const { gm, store } = createGM();
    const first = await boot({ gm });
    first.requireApi().setRange(1800, 3600);
    first.requireApi().setEnabled(false);
    assert.equal(decodeStored(store.get('bddf.min')), 1800);
    first.close();

    const second = await boot({ gm });
    const bddf2 = second.requireApi();
    assert.deepEqual(plain(bddf2.getRange()), { min: 1800, max: 3600 });
    assert.equal(bddf2.isEnabled(), false);
  });

  test('GM 抛异常时回退 localStorage 且不抛出', async () => {
    const page = await boot({ gm: createThrowingGM() });
    const bddf = page.requireApi();
    assert.doesNotThrow(() => bddf.setRange(60, 300));
    assert.doesNotThrow(() => bddf.setEnabled(false));
    assert.deepEqual(plain(bddf.getRange()), { min: 60, max: 300 });
    assert.equal(
      decodeStored(page.window.localStorage.getItem('bddf.min')),
      60,
      'GM 失败应回退写入 localStorage',
    );
  });

  test('localStorage 与 GM 都不可用时不抛出，功能仍正常（内存回退）', async () => {
    const page = await boot({ storageThrows: true });
    const bddf = page.requireApi();
    assert.doesNotThrow(() => bddf.setRange(600, 1800));
    assert.deepEqual(plain(bddf.getRange()), { min: 600, max: 1800 }, '内存状态仍生效');
    assert.equal(isHidden(itemById(page.document, 'dyn-8')), false, '754s 在 [600,1800] 应可见');
    assert.equal(isHidden(itemById(page.document, 'dyn-5')), false, '940s 在 [600,1800] 应可见');
    assert.equal(isHidden(itemById(page.document, 'dyn-4')), true, '492s < 600 应隐藏');
    assert.equal(isHidden(itemById(page.document, 'dyn-0')), true, '45s 应隐藏');
    assert.deepEqual(plain(page.consoleErrors), [], `不应有 jsdomError：${page.consoleErrors.join(' | ')}`);
  });
});

/* ================================================================== */
/* 11. 无锚点页面必须完全静默                                          */
/* ================================================================== */

describe('SPEC 3.1/3.4 无锚点页面静默', () => {
  test('空页面：mount() 返回 false，无 .bddf-bar，无异常，无 DOM 改动', async () => {
    const { document, requireApi, scriptError, consoleErrors } = await boot({
      html: '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
    });
    assert.equal(scriptError, null, `脚本不应抛错：${scriptError && scriptError.stack}`);
    const bddf = requireApi();
    assert.equal(bddf.mount(), false, '无锚点页面 mount() 应返回 false');
    assert.equal(document.querySelectorAll('.bddf-bar').length, 0, '不应注入 .bddf-bar');
    assert.equal(document.body.innerHTML, '<div id="app"></div>', '静默页面不应改动 DOM');
    assert.equal(document.querySelectorAll('style').length, 0, '静默页面不应注入样式（SPEC 3.1）');
    assert.deepEqual(plain(consoleErrors), []);
  });

  test('只有 tabs / list 容器、没有 items：mount() 返回 false', async () => {
    const html =
      '<!DOCTYPE html><html><body><div class="bili-dyn-list-tabs"></div><div class="bili-dyn-list"></div></body></html>';
    const { document, requireApi, scriptError } = await boot({ html });
    assert.equal(scriptError, null);
    assert.equal(requireApi().mount(), false);
    assert.equal(document.querySelectorAll('.bddf-bar').length, 0);
  });

  test('www.bilibili.com 根路径（含 query）：可注入', async () => {
    const { document, requireApi, scriptError } = await boot({
      url: 'https://www.bilibili.com/?spm_id_from=333.1007',
      html: pageHtml(),
    });
    assert.equal(scriptError, null);
    assert.equal(requireApi().mount(), true);
    assert.equal(document.querySelectorAll('.bddf-bar').length, 1);
  });
});
