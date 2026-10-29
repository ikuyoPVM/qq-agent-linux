import assert from 'node:assert/strict';
import { buildStickerContext } from '../src/stickers.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

const entries = [
  { id: 'id-high', desc: '高频', tags: ['开心'], useCount: 100 },
  { id: 'id-second', localNote: '次高频', useCount: 80 },
  { id: 'id-third', desc: '第三', useCount: 30 },
  { id: 'id-fourth', tags: ['冷门'], useCount: 20 },
  { id: 'id-five', desc: '第五', useCount: 10 },
  { id: 'id-six', useCount: 5 },
  { id: 'id-seven', desc: '第七', useCount: 2 },
  { id: 'id-eight', useCount: 0 }
];

check('max=4 的前半包含最高使用次数的两张', () => {
  const output = buildStickerContext(entries, 4, { rotatePeriodMin: 60, now: 0 });
  const lines = output.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 4);
  assert.ok(lines.slice(0, 2).some((line) => line.includes('id-high')));
  assert.ok(lines.slice(0, 2).some((line) => line.includes('id-second')));
});

check('同一轮次输出完全一致', () => {
  const options = { rotatePeriodMin: 10, now: 25 * 60000, withId: true };
  assert.equal(buildStickerContext(entries, 4, options), buildStickerContext(entries, 4, options));
});

check('不同轮次得到不同的轮换批', () => {
  const first = buildStickerContext(entries, 4, { rotatePeriodMin: 10, now: 0, withId: true });
  const second = buildStickerContext(entries, 4, { rotatePeriodMin: 10, now: 10 * 60000, withId: true });
  assert.notEqual(first, second);
});

check('withId 控制 id，且大 max 默认不带 id', () => {
  const withId = buildStickerContext(entries, 4, { rotatePeriodMin: 0, withId: true });
  assert.ok(withId.split('\n').filter((line) => line.startsWith('- ')).every((line) => line.includes('id=')));
  const withoutId = buildStickerContext(entries, 16, { rotatePeriodMin: 0 });
  assert.ok(withoutId.split('\n').filter((line) => line.startsWith('- ')).every((line) => !line.includes('id=')));
});

check('总数不超过 max 时全部列出', () => {
  const output = buildStickerContext(entries.slice(0, 3), 4, { rotatePeriodMin: 60 });
  assert.equal(output.split('\n').filter((line) => line.startsWith('- ')).length, 3);
});

check('空数组和无效条目不抛错并返回空串', () => {
  assert.equal(buildStickerContext([]), '');
  assert.equal(buildStickerContext([null, {}, { id: '' }]), '');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
