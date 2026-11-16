import assert from 'node:assert/strict';
import test from 'node:test';
import { applySetSchedule, isValidInitialSetSchedule, suggestInitialSet } from '../docs/set-schedule.mjs';
import { readInitialSetSchedule, renderInitialSetSchedule } from '../docs/set-schedule-ui.mjs';

const admin = { role: 'admin' };
const manager = { role: 'manager' };
const evening = { start: '20:00', end: '22:00', setId: 'set60' };
const late = { start: '22:00', end: '03:00', setId: 'set90' };
const afterHours = { start: '03:00', end: '05:00', setId: 'vip60' };
const time = (hours, day = 16) => Date.parse(`2026-11-${day}T${hours}:00+09:00`);
const save = (state, rules, actor = admin) => applySetSchedule(state, { type: 'saveInitialSetSchedule', rules }, actor);

function shop() {
  return { menu: [
    { id: 'set60', name: '初回セット', category: 'セット', duration: 60, price: 5_000 },
    { id: 'set90', name: 'ナイトセット', category: 'セット', duration: 90, price: 7_000 },
    { id: 'vip60', name: '深夜セット', category: 'セット', duration: 60, price: 9_000 },
    { id: 'hidden', name: '非表示セット', category: 'セット', enabled: false, duration: 60, price: 4_000 },
    { id: 'extension', name: '延長30分', category: '延長', duration: 30, price: 2_000 },
  ] };
}

test('uses half-open Tokyo intervals across midnight and preserves the fallback in gaps', () => {
  const state = shop();
  assert.equal(suggestInitialSet(state, time('20:30')), undefined);
  save(state, [late, evening, afterHours]);
  assert.deepEqual(state.initialSetSchedule, [afterHours, evening, late]);
  assert.equal(suggestInitialSet(state, Date.parse('2026-11-16T10:59:59Z')), undefined);
  assert.equal(suggestInitialSet(state, Date.parse('2026-11-16T11:00:00Z')).id, 'set60');
  assert.equal(suggestInitialSet(state, time('22:00')).id, 'set90');
  assert.equal(suggestInitialSet(state, time('00:00', 17)).id, 'set90');
  assert.equal(suggestInitialSet(state, time('02:59', 17)).id, 'set90');
  assert.equal(suggestInitialSet(state, time('03:00', 17)).id, 'vip60');
  assert.equal(suggestInitialSet(state, time('05:00', 17)), undefined);
  save(state, []);
  assert.equal(suggestInitialSet(state, time('20:30')), undefined);
});

test('rejects overlapping bands, invalid times and unavailable IDs atomically', () => {
  const state = shop();
  save(state, [late]);
  const before = structuredClone(state);
  assert.throws(() => save(state, [{ ...evening, end: '22:01' }, late]), /重ならない/);
  assert.throws(() => save(state, [late, { ...afterHours, start: '02:59' }]), /重ならない/);
  assert.throws(() => save(state, [late, { ...evening, start: '23:00', end: '01:00' }]), /重ならない/);
  assert.throws(() => save(state, [{ ...evening, start: '24:00' }]), /異なる時刻/);
  assert.throws(() => save(state, [{ ...evening, start: evening.end }]), /異なる時刻/);
  for (const setId of ['hidden', 'extension', 'removed']) {
    assert.throws(() => save(state, [{ ...evening, setId }]), /初回セット/);
  }
  assert.throws(() => save(state, [evening], manager), /店舗管理者/);
  assert.deepEqual(state, before);

  save(state, [{ ...late, end: '00:00' }, { ...afterHours, start: '00:00' }]);
  assert.equal(suggestInitialSet(state, time('23:59')).id, 'set90');
  assert.equal(suggestInitialSet(state, time('00:00', 17)).id, 'vip60');
});

test('recognizes older backups and suggests nothing for a later hidden or removed set', () => {
  assert.equal(isValidInitialSetSchedule(undefined), true);
  assert.equal(isValidInitialSetSchedule(null), false);
  assert.equal(isValidInitialSetSchedule([null]), false);
  assert.equal(isValidInitialSetSchedule(Array(1)), false);
  assert.equal(isValidInitialSetSchedule([late, { ...afterHours, start: '02:59' }]), false);
  assert.equal(isValidInitialSetSchedule([{ ...evening, setId: '<removed>' }]), false);
  const state = shop();
  save(state, [evening, late]);
  state.menu[1].enabled = false;
  assert.equal(suggestInitialSet(state, time('22:00')), undefined);
  state.menu.shift();
  assert.equal(suggestInitialSet(state, time('20:00')), undefined);
  assert.equal(isValidInitialSetSchedule(state.initialSetSchedule), true);
  const {menu} = state;
  const html = renderInitialSetSchedule({menu, initialSetSchedule: state.initialSetSchedule}, { escape: String, yen: String });
  assert.match(html, /利用できないセット（set60）/);
  assert.match(html, /利用できないセット（set90）/);
  assert.doesNotMatch(html, /value="extension"|value="hidden"/);
});

test('reads a schedule saved from the form, including empty lists used to remove all bands', () => {
  const data = new FormData();
  assert.deepEqual(readInitialSetSchedule(data), []);
  for (const {start, end, setId} of [evening, late]) {
    data.append('initialSetStart', start);
    data.append('initialSetEnd', end);
    data.append('initialSetId', setId);
  }
  assert.deepEqual(readInitialSetSchedule(data), [evening, late]);
  data.append('initialSetEnd', '23:00');
  assert.throws(() => readInitialSetSchedule(data), /一覧/);
});
