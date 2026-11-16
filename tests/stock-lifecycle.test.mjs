import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, createDemo, exportStoreConfiguration, parseStoreConfiguration } from '../docs/engine.mjs';
import { getStoreSettings, stockDeletionBlocker } from '../docs/store-settings.mjs';

const now = Date.parse('2026-11-16T14:41:00Z');
const syrupId = 'stock-343c2c93-de88-4a0b-854b-9f38ba5eecb1';
const syrupDefinition = { id: syrupId, name: 'シロップ', unit: 'mL', minimum: 0, defaultUnitCost: 3 };
const find = (items, id) => items.find((item) => item.id === id);
const save = (state, settings, removeStockIds) => apply(state, { type: 'saveStoreSettings', settings, removeStockIds }, now);

function addSyrup(state, linked = false) {
  const settings = getStoreSettings(state);
  settings.stock.push(syrupDefinition);
  if (linked) find(settings.menu, 'highball').recipe.push({ stockId: syrupId, quantity: 1 });
  return save(state, settings);
}

function adjust(state, quantity) {
  return apply(state, { type: 'stockAdjust', stockId: syrupId, quantity, reason: '入出庫の記録' }, now);
}

function withoutSyrup(state) {
  const settings = getStoreSettings(state);
  settings.stock = settings.stock.filter(({ id }) => id !== syrupId);
  const menuItem = find(settings.menu, 'highball');
  menuItem.recipe = menuItem.recipe.filter(({ stockId }) => stockId !== syrupId);
  return settings;
}

function importFile(state, file) {
  return apply(state, { type: 'importStoreConfiguration', configuration: parseStoreConfiguration(JSON.stringify(file)) }, now);
}

test('hidden linked stock still records deductions and returns after settings save', () => {
  const original = createDemo('live', now);
  const settings = getStoreSettings(original);
  find(settings.stock, 'soda').hidden = true;
  const hidden = save(original, settings);
  assert.equal(find(hidden.stock, 'soda').hidden, true);
  assert.deepEqual(hidden.movements, original.movements);
  const ticketId = hidden.tickets.find((ticket) => ticket.tableIds.includes('a1')).id;
  const ordered = apply(hidden, { type: 'order', ticketId, items: [{ menuId: 'highball', quantity: 1 }] }, now);
  assert.equal(find(ordered.stock, 'soda').quantity, find(hidden.stock, 'soda').quantity - 0.25);
  const lineId = find(ordered.tickets, ticketId).lines.at(-1).id;
  const returned = apply(ordered, { type: 'cancelLine', ticketId, lineId, returnStock: true, reason: '注文の変更' }, now);
  assert.equal(find(returned.stock, 'soda').quantity, find(hidden.stock, 'soda').quantity);
  assert.equal(find(returned.stock, 'soda').hidden, true);
});

test('visibility transfers in v2 and older files preserve visibility without inventory definitions', () => {
  const original = createDemo('closed', now);
  const settings = getStoreSettings(original);
  find(settings.stock, 'soda').hidden = true;
  const hidden = save(original, settings);
  const file = exportStoreConfiguration(hidden);
  assert.equal(find(file.settings.stock, 'soda').hidden, true);
  assert.equal(find(importFile(original, file).stock, 'soda').hidden, true);

  const oldFile = { ...exportStoreConfiguration(original), version: 1 };
  assert.equal(find(importFile(hidden, oldFile).stock, 'soda').hidden, true);
  const explicit = exportStoreConfiguration(original);
  assert.equal(find(importFile(hidden, explicit).stock, 'soda').hidden, undefined);
  find(explicit.settings.stock, 'soda').hidden = false;
  assert.equal(find(importFile(hidden, explicit).stock, 'soda').hidden, false);
  find(explicit.settings.stock, 'soda').hidden = 'false';
  assert.throws(() => importFile(hidden, explicit), /表示の設定/);
});

test('deletion rejects stock on hand and recipes even for disabled products', () => {
  const original = addSyrup(createDemo('closed', now), true);
  const stocked = adjust(original, 10);
  const prepared = withoutSyrup(stocked);
  assert.match(stockDeletionBlocker(stocked, syrupId, prepared.menu), /在庫が残って/);
  assert.throws(() => save(stocked, prepared, [syrupId]), /在庫が残って/);
  assert.equal(find(stocked.stock, syrupId).quantity, 10);
  const settings = withoutSyrup(original);
  const product = find(settings.menu, 'highball');
  product.enabled = false;
  product.recipe.push({ stockId: syrupId, quantity: 1 });
  assert.match(stockDeletionBlocker(original, syrupId, settings.menu), /メニューにひもづいて/);
  assert.throws(() => save(original, settings, [syrupId]), /メニューにひもづいて/);
});

test('an unsettled unserved line keeps stock available for returns after unlinking its recipe', () => {
  const stocked = adjust(addSyrup(createDemo('live', now), true), 1);
  const ticketId = stocked.tickets.find((ticket) => ticket.tableIds.includes('a1')).id;
  const ordered = apply(stocked, { type: 'order', ticketId, items: [{ menuId: 'highball', quantity: 1 }] }, now);
  assert.equal(find(ordered.stock, syrupId).quantity, 0);
  const settings = withoutSyrup(ordered);
  assert.match(stockDeletionBlocker(ordered, syrupId, settings.menu), /未提供の注文/);
  assert.throws(() => save(ordered, settings, [syrupId]), /未提供の注文/);
  const lineId = find(ordered.tickets, ticketId).lines.at(-1).id;
  const returned = apply(ordered, { type: 'cancelLine', ticketId, lineId, returnStock: true, reason: '注文の変更' }, now + 1);
  assert.equal(find(returned.stock, syrupId).quantity, 1);
  const served = apply(ordered, { type: 'serve', ticketId, lineId }, now + 1);
  const deleted = save(served, settings, [syrupId]);
  assert.equal(find(deleted.stock, syrupId), undefined);
  assert.deepEqual(deleted.movements, served.movements);
});

test('deletion archives identity, keeps movement history, and omits archived items from exports', () => {
  const original = adjust(adjust(addSyrup(createDemo('closed', now)), 1), -1);
  const settings = withoutSyrup(original);
  assert.equal(stockDeletionBlocker(original, syrupId, settings.menu), '');
  const deleted = save(original, settings, [syrupId]);
  assert.equal(find(deleted.stock, syrupId), undefined);
  assert.deepEqual(find(deleted.archivedStock, syrupId), { id: syrupId, name: 'シロップ', unit: 'mL' });
  assert.deepEqual(deleted.movements, original.movements);

  const edited = exportStoreConfiguration(deleted);
  assert.equal(find(edited.settings.stock, syrupId), undefined);
  assert.equal(Object.hasOwn(edited.settings, 'archivedStock'), false);
  const otherDevice = importFile(original, edited);
  assert.ok(find(otherDevice.stock, syrupId));
  assert.deepEqual(otherDevice.movements, original.movements);
  const restored = importFile(deleted, exportStoreConfiguration(original));
  assert.equal(find(restored.stock, syrupId).quantity, 0);
  assert.equal(find(restored.archivedStock, syrupId), undefined);
  assert.deepEqual(restored.movements, original.movements);
});

test('invalid removal requests fail atomically', () => {
  const original = addSyrup(createDemo('closed', now));
  const before = structuredClone(original);
  const settings = withoutSyrup(original);
  assert.throws(() => save(original, settings, syrupId), /削除する在庫品目の指定/);
  assert.throws(() => save(original, settings, [syrupId, syrupId]), /削除する在庫品目の指定/);
  assert.throws(() => save(original, settings, [syrupId, 'unknown']), /在庫品目が見つかりません/);
  assert.throws(() => save(original, getStoreSettings(original), [syrupId]), /更新と削除を同時/);
  assert.deepEqual(original, before);
});
