import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, createDemo, exportStoreConfiguration, parseStoreConfiguration, quote, summary } from '../docs/engine.mjs';
import { catalogDeletionBlocker, getStoreSettings } from '../docs/store-settings.mjs';

const now = Date.parse('2026-11-16T14:30:00Z');
const send = (state, action) => apply(state, action, now);
const find = (items, id) => items.find((item) => item.id === id);
const without = (items, id) => items.filter((item) => item.id !== id);

function visit() {
  let state = send(createDemo('closed', now), { type: 'open', openingCash: 20_000 });
  state = send(state, { type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 2 });
  const ticketId = state.tickets[0].id;
  state = send(state, { type: 'order', ticketId, items: [
    { menuId: 'castDrink', castIds: ['cast2'], quantity: 1 },
    { menuId: 'highball', quantity: 1 },
  ] });
  return { state, ticketId };
}

function remove(state, kind, id, explicit = true) {
  const settings = getStoreSettings(state);
  settings[kind] = without(settings[kind], id);
  const request = kind === 'menu' ? { removeMenuIds: [id] } : { removeCastIds: [id] };
  return send(state, { type: 'saveStoreSettings', settings, ...(explicit ? request : {}) });
}

function readFile(state, file) {
  return send(state, {
    type: 'importStoreConfiguration',
    configuration: parseStoreConfiguration(JSON.stringify(file)),
  });
}

test('settings save guards referenced products, initial sets, extensions and cast on active tickets', () => {
  const { state, ticketId } = visit();
  const extended = send(state, { type: 'extend', ticketId, menuId: 'extend30' });
  const before = structuredClone(extended);
  for (const [kind, id] of [['menu', 'highball'], ['menu', 'set60'], ['menu', 'extend30'], ['cast', 'cast2']]) {
    assert.match(catalogDeletionBlocker(extended, kind, id), /利用中または退店待ち/);
    assert.throws(() => remove(extended, kind, id), /利用中または退店待ち/);
    assert.throws(() => remove(extended, kind, id, false), /利用中または退店待ち/);
  }
  assert.deepEqual(extended, before);
});

test('hiding referenced products and cast stops new selection and keeps existing calculations', () => {
  const { state, ticketId } = visit();
  const extended = send(state, { type: 'extend', ticketId, menuId: 'extend30' });
  const expected = quote(extended, ticketId);
  const settings = getStoreSettings(extended);
  for (const id of ['highball', 'set60', 'extend30']) find(settings.menu, id).enabled = false;
  find(settings.cast, 'cast2').enabled = false;
  const hidden = send(extended, { type: 'saveStoreSettings', settings });
  assert.deepEqual(quote(hidden, ticketId), expected);
  assert.deepEqual(hidden.tickets, extended.tickets);
  assert.throws(() => send(hidden, { type: 'order', ticketId, items: [{ menuId: 'highball', quantity: 1 }] }), /提供を停止/);
  assert.throws(() => send(hidden, { type: 'order', ticketId, items: [{ menuId: 'castDrink', quantity: 1, castIds: ['cast2'] }] }),
    /歩合対象者/);
  assert.throws(() => send(hidden, { type: 'seat', tableIds: ['a2'], setId: 'set60', guests: 1 }), /初回セット/);
  assert.throws(() => send(hidden, { type: 'extend', ticketId, menuId: 'extend30' }), /延長時間/);
  const roundTrip = readFile(extended, exportStoreConfiguration(hidden));
  assert.deepEqual(roundTrip.tickets, extended.tickets);
  assert.equal(find(roundTrip.menu, 'set60').enabled, false);
  assert.equal(find(roundTrip.cast, 'cast2').enabled, false);
});

test('awaiting departure remains protected and settled receipt and commission survive later deletions', () => {
  const { state, ticketId } = visit();
  const due = quote(state, ticketId);
  assert.deepEqual({ subtotal: due.subtotal, service: due.service, tax: due.tax, total: due.total },
    { subtotal: 12_400, service: 2_480, tax: 1_488, total: 16_368 });
  assert.deepEqual(due.commission, [{ castId: 'cast2', sales: 1_500, amount: 300, points: 1 }]);
  const paid = send(state, { type: 'settle', ticketId, payments: [
    { method: 'cash', amount: 10_000 },
    { method: 'card', amount: 6_368 },
  ] });
  assert.throws(() => remove(paid, 'menu', 'castDrink'), /退店待ち/);
  assert.throws(() => remove(paid, 'cast', 'cast2'), /退店待ち/);
  const departed = send(paid, { type: 'depart', ticketId });
  const settings = getStoreSettings(departed);
  settings.menu = without(without(settings.menu, 'castDrink'), 'set60');
  settings.cast = without(settings.cast, 'cast2');
  const deleted = send(departed, { type: 'saveStoreSettings', settings, removeMenuIds: ['castDrink', 'set60'], removeCastIds: ['cast2'] });
  assert.deepEqual(deleted.tickets, departed.tickets);
  assert.deepEqual(quote(deleted, ticketId), quote(departed, ticketId));
  assert.deepEqual(summary(deleted).commission, due.commission);
  assert.equal(find(deleted.archivedCast, 'cast2').name, '凛');
  assert.equal(find(deleted.menu, 'castDrink'), undefined);
  assert.equal(find(deleted.cast, 'cast2'), undefined);
  assert.equal(find(exportStoreConfiguration(deleted).settings.cast, 'cast2'), undefined);
});

test('settings imports that omit live references fail before applying layout or prices', () => {
  const { state } = visit();
  const before = structuredClone(state);
  for (const [kind, id] of [['menu', 'highball'], ['cast', 'cast2']]) {
    for (const version of [1, 2]) {
      const file = exportStoreConfiguration(state);
      file.version = version;
      file.layout.tables[0].name = '取込後の卓';
      file.settings.menu[0].price = 8_888;
      file.settings[kind] = without(file.settings[kind], id);
      assert.throws(() => readFile(state, file), /利用中または退店待ち/);
    }
  }
  assert.deepEqual(state, before);
});

test('cancelled lines release catalog references and prior lines with missing cancellation fields stay protected', () => {
  const { state, ticketId } = visit();
  const ticket = find(state.tickets, ticketId);
  const line = ticket.lines.find((entry) => entry.menuId === 'castDrink');
  const legacy = structuredClone(state);
  delete find(legacy.tickets, ticketId).lines.find((entry) => entry.menuId === 'castDrink').cancelledAt;
  assert.match(catalogDeletionBlocker(legacy, 'cast', 'cast2'), /利用中/);
  assert.match(catalogDeletionBlocker(legacy, 'menu', 'castDrink'), /利用中/);
  const cancelled = send(state, { type: 'cancelLine', ticketId, lineId: line.id, returnStock: true });
  const deleted = remove(remove(cancelled, 'menu', 'castDrink'), 'cast', 'cast2');
  assert.deepEqual(deleted.tickets, cancelled.tickets);
  assert.deepEqual(deleted.movements, cancelled.movements);
});

test('catalog deletion requests must name unique existing records omitted from the draft', () => {
  const state = createDemo('closed', now);
  const settings = getStoreSettings(state);
  settings.menu = without(settings.menu, 'highball');
  settings.cast = without(settings.cast, 'cast2');
  for (const request of [{ removeMenuIds: 'highball' }, { removeMenuIds: ['unknown'] },
    { removeMenuIds: ['highball', 'highball'] }, { removeCastIds: ['cast1'] }]) {
    assert.throws(() => send(state, { type: 'saveStoreSettings', settings, ...request }), /削除する設定項目の指定/);
  }
  const loneSet = settings.menu.filter((entry) => entry.category === 'セット');
  for (const item of loneSet) item.enabled = item.id === 'set60';
  assert.match(catalogDeletionBlocker(state, 'menu', 'set60', settings.menu), /初回セット/);
  settings.menu = without(settings.menu, 'set60');
  assert.throws(() => send(state, { type: 'saveStoreSettings', settings }), /初回セット/);
});
