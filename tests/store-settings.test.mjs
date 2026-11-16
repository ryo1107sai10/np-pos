import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, createDemo, exportLayout, exportStoreConfiguration, parseStoreConfiguration } from '../docs/engine.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';

const now = Date.parse('2026-11-16T14:41:00Z');
const customMenuId = 'menu-4dc50197-e42a-4e59-8def-0245f464894e';
const customCastId = 'cast-c9073d67-ac85-464c-ab26-d020c130190f';

function adjustedSettings(state) {
  const settings = getStoreSettings(state);
  Object.assign(settings.menu.find(({ id }) => id === 'set60'), { name: 'カウンターセット', price: 7200, duration: 75 });
  Object.assign(settings.menu.find(({ id }) => id === 'extend30'), { price: 3200, duration: 25 });
  settings.menu.push({ id: customMenuId, name: 'レモンサワー', category: 'ドリンク', price: 1100, popular: true,
    recipe: [{ stockId: 'soda', quantity: 0.2 }] });
  settings.cast.push({ id: customCastId, name: '朱音', commissionOverride: { fixed: 0, rate: 12.35, points: 0.125 } });
  return settings;
}

function operations(state) {
  const { day, tickets, stock, movements, closedDays, nextId, nextTicket } = state;
  return { day, tickets, stock, movements, closedDays, nextId, nextTicket };
}

test('portable settings serialize authorized setup fields and combine them with the table layout', () => {
  let source = createDemo('live', now);
  source = apply(source, { type: 'saveStoreSettings', settings: adjustedSettings(source) }, now);
  source.layoutAreas = ['フロアA', 'フロアB', 'VIP', 'ラウンジ'];
  source.tables.find(({ id }) => id === 'a1').name = '正面席';
  const item = source.menu.find(({ id }) => id === customMenuId);
  item.internalCost = 855;
  item.recipe[0].stockValue = 1000;
  const person = source.cast.find(({ id }) => id === customCastId);
  person.internalPayroll = 4500;
  person.commissionOverride.closedTotal = 5500;

  const file = exportStoreConfiguration(source);
  assert.deepEqual(Object.keys(file), ['format', 'version', 'layout', 'settings']);
  assert.equal(file.format, 'np-pos.settings');
  assert.equal(file.version, 2);
  assert.equal(file.layout.tables[0].name, '正面席');
  assert.ok(file.layout.areas.includes('ラウンジ'));
  assert.deepEqual(Object.keys(file.settings), ['menu', 'cast', 'stock']);
  const portable = JSON.stringify(file);
  assert.doesNotMatch(portable, /"(tickets|customer|cash|movements|openingCash|closedDays|internalCost|stockValue|internalPayroll|closedTotal)"\s*:/);
  assert.doesNotMatch(portable, /佐藤様|伊藤様/);
  assert.deepEqual(parseStoreConfiguration(`\uFEFF${portable}`), { layout: file.layout, settings: file.settings });

  const target = createDemo('closed', now);
  const updated = apply(target, { type: 'importStoreConfiguration', configuration: parseStoreConfiguration(portable) }, now);
  assert.deepEqual(exportStoreConfiguration(updated), file);
  assert.deepEqual(operations(updated), operations(target));
});

test('layout-only settings files continue to import without changing existing menu or cast rules', () => {
  const source = createDemo('closed', now);
  const updated = apply(source, { type: 'saveStoreSettings', settings: adjustedSettings(source) }, now);
  const layout = exportLayout(source);
  layout.tables[0].name = '入口の卓';
  const configuration = parseStoreConfiguration(JSON.stringify(layout));
  assert.equal(configuration.settings, null);
  const imported = apply(updated, { type: 'importStoreConfiguration', configuration }, now);
  assert.equal(imported.tables[0].name, '入口の卓');
  assert.deepEqual(getStoreSettings(imported), getStoreSettings(updated));
});

test('combined import preserves local orders, cash, stock and archived cast identity', () => {
  let target = createDemo('live', now);
  const targetSettings = adjustedSettings(target);
  targetSettings.cast.find(({ id }) => id === 'cast2').commissionOverride = { fixed: 920 };
  target = apply(target, { type: 'saveStoreSettings', settings: targetSettings }, now);
  const source = createDemo('closed', now);
  const file = exportStoreConfiguration(source);
  file.settings.cast = file.settings.cast.filter(({ id }) => id !== 'cast2');
  const imported = apply(target, {
    type: 'importStoreConfiguration', configuration: parseStoreConfiguration(JSON.stringify(file)),
  }, now);
  assert.deepEqual(operations(imported), operations(target));
  assert.equal(imported.cast.some(({ id }) => id === 'cast2'), false);
  assert.deepEqual(imported.archivedCast.find(({ id }) => id === 'cast2').commissionOverride, { fixed: 920 });
  assert.equal(imported.archivedCast.find(({ id }) => id === 'cast2').name, '凛');
  assert.equal(exportStoreConfiguration(imported).settings.cast.some(({ id }) => id === 'cast2'), false);
  const restored = apply(imported, { type: 'saveStoreSettings', settings: targetSettings }, now);
  assert.deepEqual(restored.archivedCast, []);
  assert.deepEqual(operations(restored), operations(target));
});

test('invalid settings files fail before changing destination configuration', () => {
  const target = createDemo('live', now);
  const untouched = structuredClone(target);
  const file = exportStoreConfiguration(target);
  assert.throws(() => parseStoreConfiguration('{invalid'), /JSON形式/);
  assert.throws(() => parseStoreConfiguration(JSON.stringify({ ...file, version: 3 })), /バージョン/);
  assert.throws(() => parseStoreConfiguration(JSON.stringify({ ...file, settings: {} })), /設定形式/);
  const removedTable = structuredClone(file);
  removedTable.layout.tables = removedTable.layout.tables.filter(({ id }) => id !== 'a1');
  removedTable.settings.menu[0].price = 6250;
  assert.throws(() => apply(target, {
    type: 'importStoreConfiguration', configuration: parseStoreConfiguration(JSON.stringify(removedTable)),
  }, now), /使用中/);
  assert.deepEqual(target, untouched);

  const badMapping = structuredClone(file);
  badMapping.layout.tables[0].name = '入口';
  badMapping.settings.menu.find(({ id }) => id === 'highball').recipe.push({ stockId: 'unavailable', quantity: 1 });
  assert.throws(() => apply(target, {
    type: 'importStoreConfiguration', configuration: parseStoreConfiguration(JSON.stringify(badMapping)),
  }, now), /存在しない在庫品目/);
  assert.deepEqual(target, untouched);
});

test('settings validation rejects unsafe identifiers, duplicate rows, impossible price/rules and unusable sets', () => {
  const state = createDemo('closed', now);
  const config = () => getStoreSettings(state);
  function rejects(edit, message) {
    const settings = config();
    edit(settings);
    assert.throws(() => apply(state, { type: 'saveStoreSettings', settings }, now), message);
  }

  rejects(({ menu }) => { menu[0].id = 'set60"'; }, /無効なID/);
  rejects(({ cast }) => { cast.push(cast[0]); }, /キャストIDが重複/);
  rejects(({ menu }) => { menu.push(menu[0]); }, /メニューIDが重複/);
  rejects(({ menu }) => { menu[0].name = '　'; }, /メニュー名/);
  rejects(({ menu }) => { menu[0].price = -1; }, /料金/);
  rejects(({ menu }) => { menu[0].price = 100.75; }, /料金/);
  rejects(({ menu }) => { menu[0].duration = 0; }, /時間/);
  rejects(({ menu }) => { menu[0].requiresCast = true; }, /キャストの選択を必須/);
  rejects(({ menu }) => { menu[0].taxRate = '1000'; }, /税率/);
  rejects(({ menu }) => { menu[0].category = 'その他'; }, /カテゴリ/);
  rejects(({ menu }) => { menu[0].recipe = [{ stockId: 'soda', quantity: 1 }]; }, /在庫連動/);
  rejects(({ cast }) => { cast[0].commissionOverride = { rate: 12.345 }; }, /歩合率/);
  rejects(({ cast }) => { cast[0].commissionOverride = { points: 0.1234 }; }, /ポイント/);
  rejects(({ cast }) => { cast[0].commissionOverride = { fixed: -1 }; }, /固定歩合/);
  rejects(({ menu }) => { menu.filter(({ category }) => category === 'セット').forEach((item) => { item.enabled = false; }); }, /初回セット/);

  const settings = config();
  settings.menu = settings.menu.filter(({ id }) => id !== 'nominationExtra');
  settings.menu.filter(({ category }) => category === '延長').forEach((item) => { item.enabled = false; });
  settings.cast = [];
  const saved = apply(state, { type: 'saveStoreSettings', settings }, now);
  assert.ok(saved.menu.every(({ id }) => id !== 'nominationExtra'));
  assert.equal(saved.cast.length, 0);
});
