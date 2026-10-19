/**
 * SPEC 3.3：时长解析 / 格式化纯函数（通过 window.__BDDF__ 暴露）。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, closeAllPages } from './helpers.mjs';

after(closeAllPages);

/** 在真实页面里取一次 API（与筛选无关，但脚本本就该在动态页工作） */
async function api() {
  const handle = await boot({ url: 'https://t.bilibili.com/' });
  return handle.requireApi();
}

describe('SPEC 3.3 parseDuration', () => {
  test('版本号与钩子齐全', async () => {
    const bddf = await api();
    assert.equal(bddf.version, '1.5.0');
    for (const key of [
      'mount',
      'destroy',
      'scan',
      'setRange',
      'getRange',
      'setEnabled',
      'isEnabled',
      'parseDuration',
      'formatDuration',
      'getOptions',
      'setOptions',
      'getStats',
      'filterNow',
    ]) {
      assert.equal(typeof bddf[key], 'function', `__BDDF__.${key} 应为函数`);
    }
  });

  const valid = [
    ['03:21', 201],
    ['1:02:03', 3723],
    ['00:00', 0],
    ['12:34', 754],
    ['00:59', 59],
    ['59:59', 3599],
    ['1:00:00', 3600],
    ['3:00:00', 10800],
    ['25:00:00', 90000], // > 24h
    ['100:00:00', 360000], // 小时位任意非负数
  ];

  for (const [input, expected] of valid) {
    test(`parseDuration(${JSON.stringify(input)}) === ${expected}`, async () => {
      const bddf = await api();
      assert.equal(bddf.parseDuration(input), expected);
    });
  }

  const invalid = ['abc', '', null, '1:60', '01:60', '1:60:00', '60:00', '1:2a', ':21', '03:', '::', '1:2:3:4', '-1:00', '1:-2:03'];

  for (const input of invalid) {
    test(`parseDuration(${JSON.stringify(input)}) === null`, async () => {
      const bddf = await api();
      assert.equal(bddf.parseDuration(input), null);
    });
  }

  test('parseDuration 忽略前后空白', async () => {
    const bddf = await api();
    assert.equal(bddf.parseDuration('  03:21  '), 201);
    assert.equal(bddf.parseDuration('\n1:02:03\t'), 3723);
  });

  test('parseDuration 不抛异常（任意输入）', async () => {
    const bddf = await api();
    for (const bad of [undefined, 0, 201, {}, [], 'Infinity', '03:21:00:00']) {
      assert.doesNotThrow(() => bddf.parseDuration(bad));
      assert.equal(bddf.parseDuration(bad), null);
    }
  });
});

describe('SPEC 3.3 formatDuration', () => {
  const cases = [
    [201, '03:21'],
    [3723, '1:02:03'],
    [0, '00:00'],
    [59, '00:59'],
    [60, '01:00'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [10800, '3:00:00'],
    [90000, '25:00:00'],
    [Infinity, '不限'],
    [null, '--:--'],
  ];

  for (const [input, expected] of cases) {
    test(`formatDuration(${String(input)}) === ${JSON.stringify(expected)}`, async () => {
      const bddf = await api();
      assert.equal(bddf.formatDuration(input), expected);
    });
  }

  test('formatDuration 与 parseDuration 互逆（含 >24h）', async () => {
    const bddf = await api();
    for (const sec of [0, 45, 201, 754, 3599, 3600, 10800, 90000, 360000]) {
      const text = bddf.formatDuration(sec);
      assert.equal(bddf.parseDuration(text), sec, `${sec}s → ${text} → ?`);
    }
  });
});
