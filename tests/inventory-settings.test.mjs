import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, createDemo, exportStoreConfiguration, parseStoreConfiguration } from '../docs/engine.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';

const now = Date.parse('2026-11-16T14:41:00Z');
const customId = 'stock-e5255970-82c8-466d-b252-ebc47d89a7eb';
const customDefinition = { id: customId, name: 'シロップ', unit: 'mL', minimum: 5.5, defaultUnitCost: 1.25 };

const find = (items, id) => items.find((item) => item.id === id);

function configureInventory(state) {
  const settings = getStoreSettings(state);
  Object.assign(find(settings.stock, 'soda'), { name: '強炭酸', unit: '缶', minimum: 5.75, defaultUnitCost: 180.25 });
  settings.stock.push({ ...customDefinition });
  find(settings.menu, 'highball').recipe.push({ stockId: customId, quantity: 2.5 });
  return settings;
}

function portable(state) {
  return parseStoreConfiguration(JSON.stringify(exportStoreConfiguration(state)));
}

test('saving stock masters atomically edits existing fields and creates an empty recipe-linked item', () => {
  const legacy = createDemo('live', now);
  delete find(legacy.stock, 'soda').defaultUnitCost;
  assert.equal(find(getStoreSettings(legacy).stock, 'soda').defaultUnitCost, find(legacy.stock, 'soda').unitCost);
  const settings = configureInventory(legacy);
  const saved = apply(legacy, { type: 'saveStoreSettings', settings }, now);
  const soda = find(legacy.stock, 'soda');
  assert.deepEqual(find(saved.stock, 'soda'), {
    ...soda, name: '強炭酸', unit: '缶', minimum: 5.75, defaultUnitCost: 180.25,
  });
  assert.deepEqual(find(saved.stock, customId), {
    ...customDefinition, category: 'その他', quantity: 0, unitCost: 1.25, value: 0,
  });
  assert.deepEqual(find(saved.menu, 'highball').recipe.at(-1), { stockId: customId, quantity: 2.5 });
  assert.deepEqual(saved.movements, legacy.movements);
  assert.deepEqual(saved.tickets, legacy.tickets);
  assert.equal(find(legacy.stock, customId), undefined);
  assert.equal(soda.unit, '本');
});

test('portable stock definitions and recipes omit device-specific inventory data', () => {
  const source = createDemo('closed', now);
  let stocked = apply(source, { type: 'saveStoreSettings', settings: configureInventory(source) }, now);
  stocked = apply(stocked, { type: 'stockAdjust', stockId: customId, quantity: 250, reason: '仕入れ' }, now);
  const file = exportStoreConfiguration(stocked);
  assert.equal(file.version, 2);
  const definition = find(file.settings.stock, customId);
  assert.deepEqual(definition, { ...customDefinition, category: 'その他' });
  assert.ok(file.settings.stock.every((item) => !('quantity' in item || 'unitCost' in item || 'value' in item)));
  assert.equal(find(stocked.stock, customId).quantity, 250);
  assert.ok(stocked.movements.length > 0);

  const target = createDemo('live', now);
  const imported = apply(target, { type: 'importStoreConfiguration', configuration: portable(stocked) }, now);
  assert.equal(find(imported.stock, customId).quantity, 0);
  assert.deepEqual(imported.movements, target.movements);
  assert.equal(find(imported.stock, 'soda').quantity, find(target.stock, 'soda').quantity);
  assert.equal(find(imported.stock, 'soda').value, find(target.stock, 'soda').value);
  assert.equal(find(imported.stock, 'soda').unitCost, find(target.stock, 'soda').unitCost);
  assert.equal(find(imported.stock, 'soda').defaultUnitCost, 180.25);
  assert.deepEqual(find(imported.menu, 'highball').recipe.at(-1), { stockId: customId, quantity: 2.5 });
});

test('import keeps local-only items available for active order returns', () => {
  const initial = createDemo('live', now);
  let target = apply(initial, { type: 'saveStoreSettings', settings: configureInventory(initial) }, now);
  target = apply(target, { type: 'stockAdjust', stockId: customId, quantity: 10, reason: '仕入れ' }, now);
  const ticketId = target.tickets.find((ticket) => ticket.tableIds.includes('a1')).id;
  target = apply(target, { type: 'order', ticketId, items: [{ menuId: 'highball', quantity: 1 }] }, now);
  const lineId = find(target.tickets, ticketId).lines.at(-1).id;
  const imported = apply(target, { type: 'importStoreConfiguration', configuration: portable(initial) }, now);
  assert.deepEqual(find(imported.stock, customId), find(target.stock, customId));
  assert.deepEqual(imported.movements, target.movements);

  const cancelled = apply(imported, { type: 'cancelLine', ticketId, lineId, returnStock: true }, now);
  assert.equal(find(cancelled.stock, customId).quantity, 10);
  assert.ok(cancelled.movements.some((entry) => entry.stockId === customId && entry.kind === 'return'));
});

test('legacy version 1 imports menu changes and retains local stock definitions', () => {
  const initial = createDemo('live', now);
  const target = apply(initial, { type: 'saveStoreSettings', settings: configureInventory(initial) }, now);
  const old = exportStoreConfiguration(initial);
  old.version = 1;
  old.settings.menu[0].price = 6_100;
  const parsed = parseStoreConfiguration(JSON.stringify(old));
  assert.equal(parsed.settings.stock, undefined);
  const imported = apply(target, { type: 'importStoreConfiguration', configuration: parsed }, now);
  assert.equal(imported.menu[0].price, 6_100);
  assert.deepEqual(imported.stock, target.stock);
});

test('invalid inventory definitions or recipes fail before changing any records', () => {
  const original = createDemo('closed', now);
  function rejectEdit(edit, message) {
    const settings = configureInventory(original);
    edit(settings);
    assert.throws(() => apply(original, { type: 'saveStoreSettings', settings }, now), message);
  }

  rejectEdit(({ stock }) => { stock.at(-1).name = '　'; }, /品目名/);
  rejectEdit(({ stock }) => { stock.at(-1).unit = ''; }, /単位/);
  rejectEdit(({ stock }) => { stock.at(-1).minimum = -0.25; }, /下限/);
  rejectEdit(({ stock }) => { stock.at(-1).minimum = 0.1234567; }, /下限/);
  rejectEdit(({ stock }) => { stock.at(-1).defaultUnitCost = '1.5'; }, /仕入原価/);
  rejectEdit(({ stock }) => { stock.at(-1).id = 'stock-unknown'; }, /無効なID/);
  rejectEdit(({ stock }) => { stock.push(stock.at(-1)); }, /在庫品目IDが重複/);
  rejectEdit(({ stock }) => { stock.pop(); }, /存在しない在庫品目/);

  const valid = apply(original, { type: 'saveStoreSettings', settings: configureInventory(original) }, now);
  const missing = exportStoreConfiguration(valid);
  missing.settings.stock = missing.settings.stock.filter(({ id }) => id !== customId);
  assert.throws(() => parseStoreConfiguration(JSON.stringify(missing)), /存在しない在庫品目/);
  delete missing.settings.stock;
  assert.throws(() => parseStoreConfiguration(JSON.stringify(missing)), /在庫品目の設定形式/);
  assert.deepEqual(original, createDemo('closed', now));
});
