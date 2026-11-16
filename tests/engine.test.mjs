import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemo, apply, quote, summary, getTicketForTable, tableStatus, businessDate,
  getLayoutTables, getLayoutAreas, getTableLabel, layoutGrid, removeLayoutArea, exportLayout, parseLayoutFile } from '../docs/engine.mjs';

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

const newTable = { id: 'table-12345678-1234-4123-8123-123456789abc', name: ' 新卓 ',
  area: 'テラス', x: 0, y: 0, capacity: 4 };

function saveConfiguration(state, { areas = getLayoutAreas(state), tables = getLayoutTables(state) } = {}) {
  return apply(state, { type: 'saveLayout', areas, tables }, now);
}

test('configured areas include empty groups and old states retain their existing groups', () => {
  const state = createDemo('closed', now);
  assert.deepEqual(getLayoutAreas(state), ['フロアA', 'フロアB', 'VIP']);
  const legacy = { ...state, tables: [...state.tables, { id: 'terrace1', area: 'テラス' }] };
  assert.deepEqual(getLayoutAreas(legacy), ['フロアA', 'フロアB', 'VIP', 'テラス']);
  const areas = [...getLayoutAreas(state), ' テラス '];
  const next = saveConfiguration(state, { areas });
  assert.deepEqual(getLayoutAreas(next), ['フロアA', 'フロアB', 'VIP', 'テラス']);
  assert.ok(next.tables.every(({ area }) => area !== 'テラス'));
  const afterOpen = apply(next, { type: 'open', openingCash: 20_000 }, now);
  assert.deepEqual(getLayoutAreas(afterOpen), getLayoutAreas(next));
  const tables = getLayoutTables(afterOpen).map(({ name, ...table }) => table);
  const legacySave = apply(afterOpen, { type: 'saveLayout', tables }, now);
  assert.deepEqual(legacySave.tables, afterOpen.tables);
  assert.deepEqual(getLayoutAreas(legacySave), getLayoutAreas(afterOpen));
});

test('tables can be added, renamed and archived without changing transactions or inventory', () => {
  const state = createDemo('live', now);
  state.tables[0].notes = '入口側';
  const past = state.tickets.find(({ status }) => status === 'departed');
  const areas = [...getLayoutAreas(state), 'テラス'];
  const tables = getLayoutTables(state).filter(({ id }) => id !== 'b4')
    .map((table) => table.id === 'a1' ? { ...table, name: ' 窓際 ' } : table);
  const next = saveConfiguration(state, { areas, tables: [...tables, newTable] });
  assert.equal(getTableLabel(next, 'a1'), '窓際');
  assert.equal(next.tables[0].notes, '入口側');
  assert.equal(getTableLabel(next, newTable.id), '新卓');
  assert.equal(next.tables.some(({ id }) => id === 'b4'), false);
  assert.equal(getTableLabel(next, past.tableIds[0]), 'B-04');
  assert.deepEqual(next.archivedTables.map(({ id }) => id), ['b4']);
  assert.deepEqual(next.tickets, state.tickets);
  assert.deepEqual(next.stock, state.stock);
  assert.deepEqual(next.movements, state.movements);
  assert.deepEqual(next.day, state.day);
  assert.equal(getTableLabel(next, 'unknown'), 'unknown');
  const reopened = apply(next, { type: 'seat', tableIds: [newTable.id], guests: 2, setId: 'set60' }, now);
  assert.equal(ticketAt(reopened, newTable.id).tableIds[0], newTable.id);
});

test('a linked table cannot be removed until it is released even if other tables have enough capacity', () => {
  let state = seatSample(openSample(), ['a1', 'a2'], 2);
  const ticketId = ticketAt(state).id;
  const withoutSecond = getLayoutTables(state).filter(({ id }) => id !== 'a2');
  assert.throws(() => saveConfiguration(state, { tables: withoutSecond }), /A-02.*削除できません/);
  state = apply(state, { type: 'settle', ticketId, payments: [{ method: 'cash', amount: quote(state, ticketId).remaining }] }, now);
  assert.throws(() => saveConfiguration(state, { tables: withoutSecond }), /A-02.*退店待ち/);
  state = apply(state, { type: 'depart', ticketId }, now);
  state = saveConfiguration(state, { tables: withoutSecond });
  assert.equal(state.tables.some(({ id }) => id === 'a2'), false);
  assert.equal(getTableLabel(state, 'a2'), 'A-02');
  assert.deepEqual(state.tickets[0].tableIds, ['a1', 'a2']);
});

test('table identity checks reject malformed IDs, repeats and reinstatement of a removed table', () => {
  const state = createDemo('closed', now);
  const areas = [...getLayoutAreas(state), 'テラス'];
  const tables = getLayoutTables(state);
  assert.throws(() => saveConfiguration(state, { areas, tables: [...tables, { ...newTable, id: 'old-id' }] }), /卓ID/);
  assert.throws(() => saveConfiguration(state, { areas, tables: [...tables, newTable, newTable] }), /重複/);
  const created = saveConfiguration(state, { areas, tables: [...tables, newTable] });
  const removed = saveConfiguration(created, { areas, tables });
  assert.equal(getTableLabel(removed, newTable.id), '新卓');
  assert.throws(() => saveConfiguration(removed, { areas, tables: [...tables, newTable] }), /削除済み/);
});

test('layout names are bounded and normalized for uniqueness within each area', () => {
  const state = createDemo('closed', now);
  const tables = getLayoutTables(state);
  const rename = (id, name) => tables.map((table) => table.id === id ? { ...table, name } : table);
  assert.throws(() => saveConfiguration(state, { areas: [] }), /1つ以上/);
  assert.throws(() => saveConfiguration(state, { areas: [...getLayoutAreas(state), 'フロアＡ'] }), /エリア名.*重複/);
  assert.throws(() => saveConfiguration(state, { tables: rename('a2', ' Ａ－０１ ') }), /卓名.*重複/);
  assert.doesNotThrow(() => saveConfiguration(state, { tables: rename('b1', ' Ａ－０１ ') }));
  for (const invalid of [' ', '卓'.repeat(25), '改\n行']) {
    assert.throws(() => saveConfiguration(state, { tables: rename('a1', invalid) }), /卓名.*24/);
  }
  const japaneseName = 'カ\u3099ーデン';
  const next = saveConfiguration(state, { tables: rename('a1', japaneseName) });
  assert.equal(getTableLabel(next, 'a1'), 'ガーデン');
});

test('an area cannot be removed while it contains any table, even when the table is available', () => {
  const state = createDemo('closed', now);
  assert.equal(tableStatus(state, 'a1', now), 'available');
  const areas = getLayoutAreas(state);
  const tables = getLayoutTables(state);
  assert.throws(() => removeLayoutArea(areas, tables, 'フロアA'), /卓があるエリアは削除できません/);
  assert.throws(() => removeLayoutArea(areas, [{ ...tables[0], area: ' フロアＡ ' }], 'フロアA'), /卓がある/);
  assert.deepEqual(areas, getLayoutAreas(state));
  assert.deepEqual(tables, getLayoutTables(state));
});

test('an empty area is removed from the draft without mutating the input or changing existing tables', () => {
  const state = createDemo('closed', now);
  const areas = [...getLayoutAreas(state), 'テラス'];
  const tables = getLayoutTables(state);
  const remaining = removeLayoutArea(areas, tables, 'テラス');
  assert.deepEqual(remaining, getLayoutAreas(state));
  assert.equal(areas.at(-1), 'テラス');
  assert.throws(() => removeLayoutArea(areas, tables, '未登録'), /見つかりません/);
  const saved = saveConfiguration(state, { areas: remaining, tables });
  assert.deepEqual(getLayoutTables(saved), tables);
});

test('saving a stale list rejects any table that still references a removed area', () => {
  const state = createDemo('closed', now);
  const areas = getLayoutAreas(state).filter((area) => area !== 'フロアA');
  assert.throws(() => saveConfiguration(state, { areas }), /A-01のエリアを確認/);
  assert.throws(() => saveConfiguration(state, { areas: [] }), /1つ以上/);
  assert.equal(getLayoutAreas(state)[0], 'フロアA');
});

test('the last empty area can be removed and saved, then a new area and table can be added', () => {
  let state = saveConfiguration(createDemo('closed', now), { areas: ['予備'], tables: [] });
  const areas = removeLayoutArea(getLayoutAreas(state), getLayoutTables(state), '予備');
  state = saveConfiguration(state, { areas, tables: [] });
  state = JSON.parse(JSON.stringify(state));
  assert.deepEqual(getLayoutAreas(state), []);
  assert.deepEqual(getLayoutTables(state), []);
  state = saveConfiguration(state, { areas: ['テラス'], tables: [newTable] });
  assert.deepEqual(getLayoutAreas(state), ['テラス']);
  assert.equal(getTableLabel(state, newTable.id), '新卓');
});

function importConfiguration(state, layout) {
  return apply(state, { type: 'importLayout', layout }, now);
}

test('the portable file contains only layout data and is normalized on reading', () => {
  const state = createDemo('live', now);
  state.tables[0].notes = '持ち出さないメモ';
  const layout = exportLayout(state);
  assert.deepEqual(Object.keys(layout), ['format', 'version', 'areas', 'tables']);
  assert.equal(layout.format, 'np-pos.layout');
  assert.equal(layout.version, 1);
  assert.deepEqual(Object.keys(layout.tables[0]), ['id', 'name', 'area', 'x', 'y', 'capacity']);
  assert.deepEqual(parseLayoutFile(JSON.stringify(layout)), layout);
  const unnormalized = { ...layout, tickets: state.tickets, areas: layout.areas.map((area) => ` ${area} `),
    tables: layout.tables.map((table) => ({ ...table, name: ` ${table.name} `, notes: '付加情報' })) };
  assert.deepEqual(parseLayoutFile(`\uFEFF${JSON.stringify(unnormalized)}`), layout);
});

test('invalid layout files are refused before importing any table', () => {
  const layout = exportLayout(createDemo('closed', now));
  const parse = (value) => parseLayoutFile(JSON.stringify(value));
  assert.throws(() => parseLayoutFile('{bad'), /JSON形式/);
  assert.throws(() => parse({ ...layout, format: 'other.format' }), /NP POS/);
  assert.throws(() => parse({ ...layout, version: 2 }), /バージョン/);
  assert.throws(() => parse({ ...layout, tables: {} }), /卓の配置/);
  const replaceFirst = (patch) => ({ ...layout, tables: [{ ...layout.tables[0], ...patch }, ...layout.tables.slice(1)] });
  assert.throws(() => parse(replaceFirst({ id: 'a7' })), /無効な卓ID/);
  assert.throws(() => parse(replaceFirst({ id: 'a2' })), /重複/);
  assert.throws(() => parse(replaceFirst({ area: '存在しない' })), /エリア/);
  assert.throws(() => parse(replaceFirst({ x: 4 })), /重なっ/);
  assert.throws(() => parse(replaceFirst({ capacity: 0 })), /定員/);
  assert.throws(() => parse(replaceFirst({ name: undefined })), /卓名/);
  assert.throws(() => importConfiguration(createDemo('closed', now), replaceFirst({ id: 'a7' })), /無効な卓ID/);
});

test('import preserves matching destination IDs and rejects changes that invalidate active or paid tickets', () => {
  const state = createDemo('live', now);
  state.tables[0].notes = '店舗固有メモ';
  const source = exportLayout(state);
  source.tables[0].name = '新しい卓名';
  source.tables[0].x = 1;
  const next = importConfiguration(state, source);
  assert.deepEqual(exportLayout(next), source);
  assert.equal(next.tables[0].notes, '店舗固有メモ');
  assert.equal(ticketAt(next).id, ticketAt(state).id);
  assert.deepEqual(next.tickets, state.tickets);
  assert.deepEqual(next.stock, state.stock);
  assert.deepEqual(next.movements, state.movements);
  assert.deepEqual(next.day, state.day);
  assert.deepEqual(next.closedDays, state.closedDays);

  const refused = structuredClone(next);
  for (const id of ['a1', 'b2', 'v1']) {
    const withoutOccupied = { ...source, tables: source.tables.filter((table) => table.id !== id) };
    assert.throws(() => importConfiguration(next, withoutOccupied), /使用中か退店待ち/);
  }
  const tooSmall = { ...source, tables: source.tables.map((table) => table.id === 'a1' ? { ...table, capacity: 1 } : table) };
  assert.throws(() => importConfiguration(next, tooSmall), /合計定員/);
  assert.deepEqual(next, refused);
});

test('import accepts registered sample IDs absent locally and replaces empty layouts', () => {
  const layout = exportLayout(createDemo('closed', now));
  const blank = { ...createDemo('closed', now), layoutAreas: [], tables: [] };
  const imported = importConfiguration(blank, layout);
  assert.deepEqual(exportLayout(imported), layout);
  const empty = { ...layout, areas: [], tables: [] };
  const cleared = importConfiguration(imported, empty);
  assert.deepEqual(exportLayout(cleared), empty);
  assert.deepEqual(cleared.stock, imported.stock);
  const custom = { ...layout, areas: ['テラス', '空のエリア'], tables: [newTable] };
  const normalized = parseLayoutFile(JSON.stringify(custom));
  assert.deepEqual(exportLayout(importConfiguration(cleared, custom)), normalized);
});

test('repeated imports update the alias of an archived table while leaving historical links intact', () => {
  const state = createDemo('live', now);
  const original = exportLayout(state);
  const departed = state.tickets.find((ticket) => ticket.tableIds.includes('b4'));
  const archived = importConfiguration(state, { ...original, tables: original.tables.filter((table) => table.id !== 'b4') });
  const replacement = { ...original, tables: original.tables.map((table) => table.id === 'b4' ? { ...table, name: '新B-04' } : table) };
  let next = importConfiguration(archived, replacement);
  const alias = next.tables.find((table) => table.layoutSourceId === 'b4');
  assert.match(alias.id, /^table-/);
  assert.equal(alias.name, '新B-04');
  assert.equal(getTableLabel(next, departed.tableIds[0]), 'B-04');
  assert.deepEqual(exportLayout(next), replacement);

  next = seatSample(next, [alias.id]);
  const placement = { ...replacement, tables: replacement.tables.map((table) => table.id === 'b4' ? { ...table, name: '更新B-04' } : table) };
  const repeated = importConfiguration(next, placement);
  assert.equal(repeated.tables.find((table) => table.layoutSourceId === 'b4').id, alias.id);
  assert.equal(ticketAt(repeated, alias.id).id, ticketAt(next, alias.id).id);
  assert.equal(getTableLabel(repeated, 'b4'), 'B-04');
  assert.deepEqual(exportLayout(repeated), placement);
  assert.deepEqual(repeated.archivedTables, archived.archivedTables);
});
