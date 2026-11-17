import assert from 'node:assert/strict';
import test from 'node:test';
import { getCalculationSettings, roundCalculationRate } from '../docs/calculation-settings.mjs';
import { apply, createDemo, exportStoreConfiguration, parseStoreConfiguration, quote, summary } from '../docs/engine.mjs';
import { buildFreeeCsv } from '../docs/freee-export.mjs';
import { getReportPeriod } from '../docs/report-period.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';
import { projectState, validateSnapshot } from '../server/policy.mjs';

const date = '2026-11-16';
const now = Date.parse(`${date}T20:00:00+09:00`);
const admin = { id: 'owner', label: '店舗管理者', role: 'admin' };
const manager = { id: 'manager', label: 'マネージャー', role: 'manager' };
const run = (state, action, actor = admin) => apply(state, action, now, actor);

function open() {
  return run(createDemo('closed', now), { type: 'open', date, openingCash: 15_000 });
}

function configure(state, changes) {
  return run(state, { type: 'saveCalculationSettings', settings: { ...getCalculationSettings(state), ...changes } });
}

function menuPrices(state, changes) {
  const settings = getStoreSettings(state);
  for (const [id, change] of Object.entries(changes)) {
    Object.assign(settings.menu.find((item) => item.id === id), change);
  }
  return run(state, { type: 'saveStoreSettings', settings });
}

function seat(state, tableId = 'a1') {
  return run(state, { type: 'seat', tableIds: [tableId], guests: 1, setId: 'set60' });
}

function discount(state, ticketId, value) {
  return run(state, { type: 'discount', ticketId, mode: 'amount', value,
    reasonCode: 'service', reason: '設定の動作確認' });
}

test('service and tax rounding use integer money and distinguish below-half and exact-half amounts', () => {
  assert.deepEqual(['floor', 'round', 'ceil'].map((rounding) => roundCalculationRate(1_001, 500, rounding)), [50, 50, 51]);
  assert.deepEqual(['floor', 'round', 'ceil'].map((rounding) => roundCalculationRate(25, 1_000, rounding)), [2, 3, 3]);
  let state = menuPrices(open(), {
    set60: { price: 15, taxRate: 1_000 },
    highball: { price: 15, taxRate: 1_000 },
  });
  state = configure(state, { serviceRateBps: 0, taxRounding: 'round' });
  state = seat(state);
  const [{ id: ticketId }] = state.tickets;
  state = run(state, { type: 'order', ticketId, items: [{ menuId: 'highball', quantity: 1 }] });
  assert.deepEqual(quote(state, ticketId).taxBreakdown, [{ rate: 1_000, base: 30, tax: 3 }]);
});

test('snapshots keep coarse service rounding and independent cast allocations stable after configuration changes', () => {
  let state = menuPrices(open(),{set60:{price:12_347},highball:{price:10_003,commission:{fixed:1000,rate:0,points:1}}});
  state = configure(state,{serviceRoundingUnit:100,serviceRounding:'round',castAllocation:{
    amount:{unit:10,mode:'round'},points:{unit:10,mode:'floor'},quantity:{unit:1000,mode:'floor'},
    sales:{unit:100,mode:'ceil'},cost:{unit:10,mode:'ceil'},
  }});
  state = seat(state);
  const [visit] = state.tickets;
  assert.equal(quote(state,visit.id).service,2500);
  state = run(state,{type:'order',ticketId:visit.id,items:[{menuId:'highball',quantity:1,castIds:['cast1','cast2','cast3']}]});
  const {commissionDetails,total,service,discount,tax,subtotal} = quote(state,visit.id);
  assert.equal(service,4500);
  assert.equal(total,subtotal - discount + service + tax);
  const line = state.tickets[0].lines.at(-1);
  const cost = Math.round(line.stockUses.reduce((sum,use) => sum + use.quantity * use.unitCost,0));
  for (const detail of commissionDetails) {
    assert.equal(detail.sales,3400);
    assert.equal(detail.amount,330);
    assert.equal(detail.quantity,0.3);
    assert.equal(detail.points,0.33);
    assert.equal(detail.cost,Math.ceil(cost/30)*10);
  }
  state = run(state,{type:'settle',ticketId:visit.id,payments:[{method:'cash',amount:total}]});
  state = configure(state,{serviceRoundingUnit:1,castAllocation:{}});
  assert.deepEqual(quote(state,visit.id).commissionDetails,commissionDetails);
  assert.deepEqual(validateSnapshot(state).tickets[0].settlement.commissionDetails,commissionDetails);
  state.rolePolicy = {manager:{disabled:['inventory'],label:'マネージャー'}};
  assert.ok(projectState(state,'manager',manager.id).tickets[0].settlement.commissionDetails.every((row) => !Object.hasOwn(row,'cost')));
});

test('service basis respects eligible items and chooses either their price or discounted amount', () => {
  let state = menuPrices(open(), {
    set60: { price: 1_001, taxRate: 1_000 },
    highball: { price: 501, taxRate: 800, serviceEligible: false },
  });
  state = configure(state, { serviceRateBps: 1_000, serviceRounding: 'ceil',
    taxRounding: 'round', serviceBase: 'beforeDiscount' });
  state = seat(state);
  const [{ id: first }] = state.tickets;
  state = run(state, { type: 'order', ticketId: first, items: [{ menuId: 'highball', quantity: 1 }] });
  state = discount(state, first, 300);
  let result = quote(state, first);
  assert.equal(result.subtotal, 1_502);
  assert.equal(result.service, 101);
  assert.deepEqual(result.taxBreakdown, [{ rate: 1_000, base: 902, tax: 90 }, { rate: 800, base: 401, tax: 32 }]);
  assert.equal(result.total, 1_425);

  state = configure(state, { serviceBase: 'afterDiscount' });
  state = seat(state, 'a2');
  const { id: second } = state.tickets[1];
  state = run(state, { type: 'order', ticketId: second, items: [{ menuId: 'highball', quantity: 1 }] });
  state = discount(state, second, 300);
  result = quote(state, second);
  assert.equal(result.service, 81);
  assert.equal(result.total, 1_403);
  assert.equal(quote(state, first).total, 1_425);
});

test('inclusive mixed-rate checkout charges entered amounts, computes commission on net sales and balances card tax and freee export', () => {
  let state = menuPrices(open(), {
    set60: { price: 1_100, taxRate: 1_000 },
    castDrink: { price: 1_080, taxRate: 800, commission: { rate: 10 } },
  });
  state = configure(state, { serviceRateBps: 1_000, priceMode: 'inclusive',
    serviceBase: 'beforeDiscount', taxRounding: 'round' });
  state = run(state, { type: 'saveCardFeeSettings', settings: { enabled: true, rateBps: 123 } });
  state = seat(state);
  const [{ id: ticketId }] = state.tickets;
  state = run(state, { type: 'order', ticketId, items: [{ menuId: 'castDrink', quantity: 1, castIds: ['cast1'] }] });
  state = discount(state, ticketId, 220);
  const interim = quote(state, ticketId);
  assert.equal(interim.priceMode, 'inclusive');
  assert.equal(interim.subtotal, 2_180);
  assert.equal(interim.service, 218);
  assert.equal(interim.tax, 180);
  assert.equal(interim.total, 2_178);
  assert.deepEqual(interim.taxBreakdown, [{ rate: 1_000, base: 999, tax: 100 }, { rate: 800, base: 999, tax: 80 }]);
  assert.deepEqual(interim.commission, [{ castId: 'cast1', sales: 899, amount: 89, points: 0 }]);

  state = run(state, { type: 'settle', ticketId, expectedCardFee: 12,
    payments: [{ method: 'card', amount: 1_000 }, { method: 'cash', amount: 1_178 }] });
  const receipt = quote(state, ticketId);
  assert.equal(receipt.total, 2_190);
  assert.equal(receipt.tax, 181);
  assert.equal(receipt.cardFeeTax, 1);
  assert.equal(receipt.baseTotal, 2_178);
  assert.equal(receipt.priceMode, 'inclusive');
  assert.deepEqual(receipt.commission, interim.commission);
  assert.deepEqual(receipt.taxBreakdown, [{ rate: 1_000, base: 1_010, tax: 101 }, { rate: 800, base: 999, tax: 80 }]);
  assert.deepEqual(summary(state).payments, { cash: 1_178, card: 1_012, qr: 0 });
  const exported = buildFreeeCsv(getReportPeriod(state, { mode: 'day' }), { mode: 'tickets' });
  assert.equal(exported.salesTotal, 2_190);
  assert.equal(exported.journalCount, 1);
});

test('settings transfer preserves old ticket policy, supports legacy settings files and validates the new policy', () => {
  const initial = seat(open());
  const [{ id: oldTicketId }] = initial.tickets;
  const baseline = quote(initial, oldTicketId);
  const source = configure(createDemo('closed', now), {
    serviceRateBps: 0, priceMode: 'inclusive', serviceRounding: 'ceil', taxRounding: 'ceil',
  });
  const file = exportStoreConfiguration(source);
  assert.deepEqual(file.calculationSettings, source.calculationSettings);
  const configuration = parseStoreConfiguration(JSON.stringify(file));
  let state = run(initial, { type: 'importStoreConfiguration', configuration });
  assert.deepEqual(quote(state, oldTicketId), baseline);
  assert.deepEqual(getCalculationSettings(state), source.calculationSettings);
  state = seat(state, 'a2');
  const { id: newTicketId } = state.tickets[1];
  assert.equal(quote(state, newTicketId).total, 5_000);
  assert.equal(quote(state, newTicketId).tax, 455);
  const legacyTicket = structuredClone(state);
  delete legacyTicket.tickets[0].calculationSettings;
  legacyTicket.tickets[0].serviceRate = 1_700;
  assert.equal(quote(legacyTicket, oldTicketId).total, 6_435);
  delete file.calculationSettings;
  const legacyConfiguration = parseStoreConfiguration(JSON.stringify(file));
  assert.equal(legacyConfiguration.calculationSettings, undefined);
  assert.deepEqual(run(state, { type: 'importStoreConfiguration', configuration: legacyConfiguration }).calculationSettings,
    state.calculationSettings);

  const settings = { ...getCalculationSettings(state), serviceRateBps: 1_234 };
  assert.throws(() => run(state, { type: 'saveCalculationSettings', settings }, manager), /店舗管理者/);
  for (const invalid of [{serviceRateBps:10_001}, {serviceRateBps:0.5}, {serviceRounding:'other'},
    {taxRounding:'other'}, {serviceBase:'other'}, {priceMode:'other'}]) {
    assert.throws(() => run(state, { type: 'saveCalculationSettings', settings: { ...settings, ...invalid } }), /設定を確認/);
  }
  assert.throws(() => parseStoreConfiguration(JSON.stringify({ ...file, calculationSettings: null })), /設定を確認/);
});
