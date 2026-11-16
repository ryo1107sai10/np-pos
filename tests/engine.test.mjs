import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemo, apply, quote, summary, getTicketForTable, tableStatus, businessDate, getLayoutTables, layoutGrid } from '../docs/engine.mjs';

const now = Date.parse('2026-11-16T14:41:00Z');
const minutes = (count) => count * 60_000;
const ticketAt = (state, tableId = 'a1') => getTicketForTable(state, tableId);
const quantityOf = (state, id) => state.stock.find((stock) => stock.id === id).quantity;

function openSample() {
  return apply(createDemo('closed', now), { type: 'open', openingCash: 20_000 }, now);
}

function seatSample(state, tableIds = ['a1'], guests = 2) {
  return apply(state, { type: 'seat', tableIds, guests, customer: 'サンプル', setId: 'set60' }, now);
}

test('open, seat, multi-table move, order, extend, split settlement, release and close', () => {
  let state = seatSample(openSample(), ['a1', 'a2'], 2);
  const ticketId = ticketAt(state).id;
  assert.equal(ticketAt(state, 'a2').id, ticketId);
  assert.throws(() => seatSample(state, ['a2'], 1), /使用中/);
  state = apply(state, { type: 'move', ticketId, tableIds: ['a2', 'a3'] }, now);
  assert.equal(ticketAt(state), null);
  assert.equal(ticketAt(state, 'a3').id, ticketId);
  assert.equal(ticketAt(state, 'a3').tableHistory.find((entry) => entry.tableId === 'a1').releasedAt, now);

  const beforeStock = quantityOf(state, 'soda');
  state = apply(state, { type: 'order', ticketId, items: [{ menuId: 'castDrink', quantity: 2, castIds: ['cast1'] }] }, now);
  assert.equal(quantityOf(state, 'soda'), beforeStock - 0.5);
  assert.equal(summary(state).commission.length, 0);
  assert.equal(summary(state).pendingCommission[0].amount, 600);
  assert.equal(tableStatus(state, 'a2', now + minutes(52)), 'soon');
  state = apply(state, { type: 'extend', ticketId, minutes: 30 }, now + minutes(52));
  assert.equal(ticketAt(state, 'a2').endsAt, now + minutes(90));
  assert.equal(tableStatus(state, 'a2', now + minutes(52)), 'active');

  state = apply(state, { type: 'discount', ticketId, amount: 1_300 }, now);
  state = apply(state, { type: 'deposit', ticketId, method: 'cash', amount: 3_000 }, now);
  assert.equal(summary(state).expectedCash, 23_000);
  const due = quote(state, ticketId).remaining;
  assert.throws(() => apply(state, { type: 'settle', ticketId, payments: [{ method: 'cash', amount: due - 1 }] }, now), /合計/);
  state = apply(state, { type: 'settle', ticketId, payments: [{ method: 'card', amount: due - 2_000 }, { method: 'cash', amount: 2_000 }] }, now);
  assert.equal(summary(state).expectedCash, 25_000);
  assert.equal(summary(state).sales, due + 3_000);
  assert.equal(summary(state).pendingCommission.length, 0);
  assert.equal(summary(state).commission[0].amount, 600);
  assert.equal(tableStatus(state, 'a2', now), 'paid');
  assert.throws(() => apply(state, { type: 'close', actualCash: 25_000 }, now), /退店待ち/);
  state = apply(state, { type: 'depart', ticketId }, now);
  assert.equal(tableStatus(state, 'a2', now), 'available');
  assert.equal(tableStatus(state, 'a3', now), 'available');
  assert.equal(state.tickets.find((entry) => entry.id === ticketId).tableHistory.every((entry) => entry.releasedAt !== null), true);
  assert.throws(() => apply(state, { type: 'close', actualCash: 24_990 }, now), /理由/);
  state = apply(state, { type: 'close', actualCash: 24_990, reason: '差異を確認' }, now);
  assert.equal(state.day.status, 'closed');
  assert.equal(state.closedDays[0].discrepancy, -10);
  assert.throws(() => apply(state, { type: 'open', openingCash: 20_000 }, now), /締め済み/);
  state = apply(state, { type: 'open', openingCash: 20_000, date: '2026-11-17' }, now);
  assert.equal(state.tickets.length, 0);
  assert.equal(state.closedDays[0].discrepancy, -10);
});

test('seed includes the documented example and varied hall statuses', () => {
  const state = createDemo('live', now);
  const ticket = ticketAt(state);
  const totals = quote(state, ticket.id);
  assert.deepEqual([totals.subtotal, totals.discount, totals.service, totals.tax, totals.total, totals.remaining],
    [13_000, 1_300, 2_340, 1_404, 15_444, 12_444]);
  assert.equal(tableStatus(state, 'a2', now), 'soon');
  assert.equal(tableStatus(state, 'b1', now), 'overtime');
  assert.equal(tableStatus(state, 'b2', now), 'paid');
  assert.equal(ticketAt(state, 'v1').id, ticketAt(state, 'v2').id);
});

test('multi-item stock rejection is atomic and only reusable stock is returned', () => {
  let state = seatSample(openSample());
  const ticketId = ticketAt(state).id;
  const beforeQty = quantityOf(state, 'soda');
  assert.throws(() => apply(state, { type: 'order', ticketId, items: [
    { menuId: 'highball', quantity: 1 }, { menuId: 'champagne', quantity: 6 },
  ] }, now), /在庫が不足/);
  assert.equal(ticketAt(state).lines.length, 1);
  assert.equal(quantityOf(state, 'soda'), beforeQty);

  state = apply(state, { type: 'order', ticketId, items: [{ menuId: 'highball', quantity: 2 }] }, now);
  const lineId = ticketAt(state).lines.at(-1).id;
  assert.equal(quantityOf(state, 'soda'), beforeQty - 0.5);
  const served = apply(state, { type: 'serve', ticketId, lineId }, now);
  assert.throws(() => apply(served, { type: 'cancelLine', ticketId, lineId, returnStock: true }, now), /提供済み/);
  state = apply(state, { type: 'cancelLine', ticketId, lineId, returnStock: true }, now);
  assert.equal(quantityOf(state, 'soda'), beforeQty);
  assert.equal(quote(state, ticketId).subtotal, 10_000);
});

test('rounds consumption tax once per rate and conserves weighted allocation', () => {
  let state = seatSample(openSample());
  state.menu.push({ id: 'testReduced', name: '軽減試験', category: 'フード', price: 107, taxRate: 800, serviceEligible: false },
    { id: 'testRegular', name: '標準試験', category: 'フード', price: 107, serviceEligible: false },
    { id: 'testShare', name: '歩合試験', category: 'ドリンク', price: 1001, commission: { fixed: 1001, points: 1 } });
  const ticketId = ticketAt(state).id;
  state = apply(state, { type: 'order', ticketId, items: [
    { menuId: 'testReduced', quantity: 1 }, { menuId: 'testReduced', quantity: 1 },
    { menuId: 'testRegular', quantity: 1 }, { menuId: 'testRegular', quantity: 1 },
  ] }, now);
  const groups = quote(state, ticketId).taxBreakdown;
  assert.deepEqual(groups, [{ rate: 1000, base: 12_214, tax: 1_221 }, { rate: 800, base: 214, tax: 17 }]);
  state = apply(state, { type: 'order', ticketId, items: [{ menuId: 'testShare', quantity: 1, castIds: ['cast1', 'cast2', 'cast3'] }] }, now);
  assert.deepEqual(quote(state, ticketId).commission.map(({ sales, amount, points }) => [sales, amount, points]),
    [[334, 334, 0.334], [334, 334, 0.333], [333, 333, 0.333]]);
});

test('uses Tokyo cutover at six in the morning', () => {
  assert.equal(businessDate(Date.parse('2026-11-16T20:59:59Z')), '2026-11-16');
  assert.equal(businessDate(Date.parse('2026-11-16T21:00:00Z')), '2026-11-17');
});

function saveLayout(state, changes = {}) {
  const tables = getLayoutTables(state).map((table) => ({ ...table, ...changes[table.id] }));
  return apply(state, { type: 'saveLayout', tables }, now);
}

test('legacy table positions are deterministic and persist on saving', () => {
  const state = createDemo('closed', now);
  assert.deepEqual(layoutGrid, { columns: 12, rows: 8, tableWidth: 3, tableHeight: 2 });
  const positions = getLayoutTables(state).map(({ id, x, y }) => [id, x, y]);
  assert.deepEqual(positions.slice(0, 7), [
    ['a1', 0, 0], ['a2', 4, 0], ['a3', 8, 0], ['a4', 0, 3], ['a5', 4, 3], ['a6', 8, 3], ['b1', 0, 0],
  ]);
  assert.equal(state.tables[0].x, undefined);
  assert.deepEqual(saveLayout(state).tables, getLayoutTables(state));
});

test('layout rejects overlaps, bad coordinates, invalid areas, invalid capacity and missing or duplicate table IDs', () => {
  const state = createDemo('closed', now);
  assert.throws(() => saveLayout(state, { a2: { x: 2 } }), /重なっ/);
  assert.doesNotThrow(() => saveLayout(state, { a2: { x: 3 } }));
  for (const x of [-1, 10, 2.5, NaN, Infinity, '0']) {
    assert.throws(() => saveLayout(state, { a1: { x } }), /範囲内/);
  }
  assert.throws(() => saveLayout(state, { a1: { y: 7 } }), /範囲内/);
  assert.doesNotThrow(() => saveLayout(state, { a1: { x: 9, y: 6 } }));
  assert.throws(() => saveLayout(state, { a1: { area: '未登録' } }), /エリア/);
  assert.throws(() => saveLayout(state, { a1: { capacity: 0 } }), /定員/);
  assert.throws(() => saveLayout(state, { a1: { capacity: 101 } }), /定員/);
  assert.throws(() => apply(state, { type: 'saveLayout', tables: getLayoutTables(state).slice(1) }, now), /すべて/);
  assert.throws(() => saveLayout(state, { a1: { id: 'a2' } }), /重複/);
  assert.equal(state.tables[1].x, undefined);
});

test('editing an occupied seat preserves the attached ticket and inventory', () => {
  const state = createDemo('live', now);
  const next = saveLayout(state, { a1: { area: 'フロアB', x: 4, y: 3 } });
  assert.equal(next.tables.find(({ id }) => id === 'a1').area, 'フロアB');
  assert.equal(next.tables.find(({ id }) => id === 'a1').name, 'A-01');
  assert.deepEqual(next.tickets, state.tickets);
  assert.deepEqual(next.stock, state.stock);
  assert.deepEqual(next.day, state.day);
  assert.equal(ticketAt(next).id, ticketAt(state).id);
  assert.equal(tableStatus(next, 'a1', now), 'active');
});

test('combined capacity protects open and paid tickets until departure', () => {
  let state = seatSample(openSample(), ['a1', 'a2'], 6);
  assert.throws(() => saveLayout(state, { a1: { capacity: 2 }, a2: { capacity: 3 } }), /利用人数/);
  state = saveLayout(state, { a1: { capacity: 3 }, a2: { capacity: 3 } });
  const ticketId = ticketAt(state).id;
  state = apply(state, { type: 'settle', ticketId, payments: [{ method: 'cash', amount: quote(state, ticketId).remaining }] }, now);
  assert.throws(() => saveLayout(state, { a2: { capacity: 2 } }), /利用人数/);
  state = apply(state, { type: 'depart', ticketId }, now);
  assert.equal(saveLayout(state, { a2: { capacity: 2 } }).tables[1].capacity, 2);
});

test('layout saves while closed and remains through opening and closing', () => {
  let state = saveLayout(createDemo('closed', now), { a1: { y: 6, capacity: 8 } });
  assert.equal(state.day.status, 'closed');
  const layout = getLayoutTables(state);
  state = apply(state, { type: 'open', openingCash: 20_000 }, now);
  state = apply(state, { type: 'close', actualCash: 20_000 }, now);
  assert.equal(state.day.status, 'closed');
  assert.deepEqual(getLayoutTables(state), layout);
});
