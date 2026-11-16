import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, exportStoreConfiguration, getItemCommission, parseStoreConfiguration, quote } from '../docs/engine.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';

const now = Date.parse('2026-11-16T14:00:00Z');
const minute = 60_000;

function openStore(state = createDemo('closed', now)) {
  return apply(state, { type: 'open', openingCash: 20_000 }, now);
}

function configure(state, update) {
  const settings = getStoreSettings(state);
  update(settings);
  return apply(state, { type: 'saveStoreSettings', settings }, now);
}

function seat(state, setId = 'set60', tableId = 'a1') {
  return apply(state, { type: 'seat', tableIds: [tableId], setId, guests: 2 }, now);
}

function order(state, ticketId, menuId, castIds, quantity = 1) {
  return apply(state, { type: 'order', ticketId, items: [{ menuId, castIds, quantity }] }, now);
}

function menuItem(state, id) {
  return state.menu.find((item) => item.id === id);
}

function castMember(state, id) {
  return state.cast.find((person) => person.id === id);
}

test('new lines snapshot cast-specific terms, including explicit zero and two-decimal rates', () => {
  let state = seat(openStore());
  const ticketId = state.tickets[0].id;
  state = configure(state, (settings) => {
    menuItem(settings, 'castDrink').price = 1_501;
    castMember(settings, 'cast1').commissionOverride = { fixed: 501, rate: 8.03, points: 1.25 };
    castMember(settings, 'cast2').commissionOverride = { fixed: 0, rate: 0 };
  });
  assert.deepEqual(getItemCommission(menuItem(state, 'castDrink'), castMember(state, 'cast2')),
    { fixed: 0, rate: 0, points: 1 });

  state = order(state, ticketId, 'castDrink', ['cast1', 'cast2'], 2);
  const firstQuote = quote(state, ticketId);
  assert.deepEqual(firstQuote.commission, [
    { castId: 'cast1', sales: 1_501, amount: 621, points: 1.25 },
    { castId: 'cast2', sales: 1_501, amount: 0, points: 1 },
  ]);
  const originalLine = structuredClone(state.tickets[0].lines.at(-1));
  const originalStock = structuredClone(state.stock);
  const originalMovements = structuredClone(state.movements);

  state = configure(state, (settings) => {
    Object.assign(menuItem(settings, 'castDrink'), { name: '新キャストドリンク', price: 1_701, commission: { fixed: 100, points: 2 } });
    castMember(settings, 'cast1').commissionOverride = { fixed: 0, rate: 20, points: 0 };
  });
  assert.deepEqual(quote(state, ticketId), firstQuote);
  assert.deepEqual(state.stock, originalStock);
  assert.deepEqual(state.movements, originalMovements);
  state = order(state, ticketId, 'castDrink', ['cast1']);
  assert.deepEqual(state.tickets[0].lines.at(-2), originalLine);
  assert.equal(state.tickets[0].lines.at(-1).total, 1_701);
  assert.equal(state.tickets[0].lines.at(-1).name, '新キャストドリンク');
  assert.deepEqual(quote(state, ticketId).commission, [
    { castId: 'cast1', sales: 3_202, amount: 961, points: 1.25 },
    { castId: 'cast2', sales: 1_501, amount: 0, points: 1 },
  ]);

  state = apply(state, { type: 'settle', ticketId, payments: [{ method: 'cash', amount: quote(state, ticketId).remaining }] }, now);
  const receipt = quote(state, ticketId);
  state = configure(state, (settings) => {
    castMember(settings, 'cast1').commissionOverride.fixed = 1_000;
    menuItem(settings, 'castDrink').price = 2_000;
  });
  assert.deepEqual(quote(state, ticketId), receipt);
});

test('legacy open lines keep their original rounding and ignore new cast rules', () => {
  let state = seat(openStore());
  const ticketId = state.tickets[0].id;
  const menu = menuItem(state, 'castDrink');
  Object.assign(menu, { price: 1_001, commission: { fixed: 301, rate: 8, points: 1.001 } });
  state = order(state, ticketId, 'castDrink', ['cast1', 'cast2']);
  delete state.tickets[0].lines.at(-1).castCommissions;
  castMember(state, 'cast1').commissionOverride = { fixed: 1_000, rate: 50, points: 2 };
  assert.deepEqual(quote(state, ticketId).commission, [
    { castId: 'cast1', sales: 501, amount: 191, points: 0.501 },
    { castId: 'cast2', sales: 500, amount: 190, points: 0.5 },
  ]);
});

test('transferred set and extension prices and durations drive new operations by item ID', () => {
  const source = configure(createDemo('closed', now), (settings) => {
    Object.assign(menuItem(settings, 'set60'), { name: '初回コース', price: 6_200, duration: 75 });
    Object.assign(menuItem(settings, 'extend30'), { name: '延長A', price: 3_300, duration: 45 });
    Object.assign(menuItem(settings, 'extend60'), { name: '延長B', price: 4_850, duration: 45 });
  });
  const configuration = parseStoreConfiguration(JSON.stringify(exportStoreConfiguration(source)));
  const destination = apply(createDemo('closed', now), { type: 'importStoreConfiguration', configuration }, now);
  let state = seat(openStore(destination));
  const ticketId = state.tickets[0].id;
  assert.equal(state.tickets[0].endsAt, now + 75 * minute);
  assert.equal(state.tickets[0].lines[0].total, 12_400);
  assert.equal(state.tickets[0].lines[0].name, '初回コース');
  state = apply(state, { type: 'extend', ticketId, menuId: 'extend60' }, now);
  assert.equal(state.tickets[0].endsAt, now + 120 * minute);
  assert.equal(state.tickets[0].lines.at(-1).total, 9_700);
  assert.equal(state.tickets[0].lines.at(-1).name, '延長B');
  state = apply(state, { type: 'extend', ticketId, minutes: 45 }, now);
  assert.equal(state.tickets[0].lines.at(-1).total, 6_600);
});

test('hidden items are unavailable and inactive cast cannot be newly assigned', () => {
  let state = configure(openStore(), (settings) => {
    menuItem(settings, 'set90').enabled = false;
    menuItem(settings, 'castDrink').enabled = false;
    castMember(settings, 'cast1').enabled = false;
    menuItem(settings, 'extend30').enabled = false;
  });
  assert.throws(() => seat(state, 'set90'), /初回セット/);
  state = seat(state);
  const ticketId = state.tickets[0].id;
  assert.throws(() => order(state, ticketId, 'castDrink', ['cast1']), /提供を停止/);
  assert.throws(() => order(state, ticketId, 'nomination', ['cast1']), /歩合対象者/);
  assert.throws(() => apply(state, { type: 'extend', ticketId, menuId: 'extend30' }, now), /延長時間/);
  assert.throws(() => apply(state, { type: 'extend', ticketId, menuId: 'nominationExtra' }, now), /延長時間/);
  assert.equal(state.tickets[0].lines.length, 1);
});

test('automatic nomination surcharge works for existing active tickets with an inactive or archived cast', () => {
  let state = seat(openStore());
  const ticketId = state.tickets[0].id;
  state = order(state, ticketId, 'nomination', ['cast1', 'cast2']);
  state = configure(state, (settings) => {
    castMember(settings, 'cast1').enabled = false;
    settings.cast = settings.cast.filter((person) => person.id !== 'cast2');
    menuItem(settings, 'nominationExtra').price = 1_250;
  });

  state = apply(state, { type: 'extend', ticketId, menuId: 'extend30' }, now);
  const line = state.tickets[0].lines.at(-1);
  assert.equal(line.menuId, 'nominationExtra');
  assert.equal(line.total, 2_500);
  assert.deepEqual(line.castIds, ['cast1', 'cast2']);

  state = configure(state, (settings) => { menuItem(settings, 'nominationExtra').enabled = false; });
  state = apply(state, { type: 'extend', ticketId, menuId: 'extend30' }, now);
  assert.equal(state.tickets[0].lines.at(-1).menuId, 'extend30');
  state = configure(state, (settings) => { settings.menu = settings.menu.filter((item) => item.id !== 'nominationExtra'); });
  state = apply(state, { type: 'extend', ticketId, menuId: 'extend30' }, now);
  assert.equal(state.tickets[0].lines.filter((item) => item.menuId === 'nominationExtra').length, 1);
});

test('an automatic surcharge covers all nominated cast even past the manual order quantity limit', () => {
  let state = configure(openStore(), (settings) => {
    settings.cast = Array.from({ length: 101 }, (_, index) => ({
      id: `cast-${crypto.randomUUID()}`, name: `キャスト${index + 1}`,
    }));
  });
  state = seat(state);
  const ticketId = state.tickets[0].id;
  const castIds = state.cast.map(({ id }) => id);
  assert.throws(() => order(state, ticketId, 'nomination', castIds, 101), /数量/);
  state = order(state, ticketId, 'nomination', castIds);
  state = apply(state, { type: 'extend', ticketId, menuId: 'extend30' }, now);
  assert.equal(state.tickets[0].lines.at(-1).quantity, 101);
});
