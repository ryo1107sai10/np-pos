import assert from 'node:assert/strict';
import test from 'node:test';
import { getCalculationSettings } from '../docs/calculation-settings.mjs';
import { apply, createDemo, exportStoreConfiguration, parseStoreConfiguration, quote } from '../docs/engine.mjs';
import { buildFreeeCsv } from '../docs/freee-export.mjs';
import { getReportPeriod } from '../docs/report-period.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';
import { validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-16';
const now = Date.parse(`${date}T20:00:00+09:00`);
const admin = { id: 'owner', label: '店舗管理者', role: 'admin' };
const manager = { id: 'manager', label: 'マネージャー', role: 'manager' };
const staff = { id: 'staff', label: 'スタッフ', role: 'staff' };
const run = (state, action, actor = admin) => apply(state, action, now, actor);

function configure(state, settings) {
  return run(state, { type: 'saveCalculationSettings', settings: { ...getCalculationSettings(state), ...settings } });
}

function seated(settings = {}) {
  const opened = run(createDemo('closed', now), { type: 'open', date, openingCash: 0 });
  return run(configure(opened, settings), { type: 'seat', tableIds: ['a1'], guests: 1, setId: 'set60' });
}

function drinkOrder(state, fields = {}) {
  return { type: 'order', ticketId: state.tickets[0].id,
    items: [{ menuId: 'castDrink', quantity: 1, castIds: ['cast1'], ...fields }] };
}

function catalogTax(state, rate) {
  const settings = getStoreSettings(state);
  settings.menu.find(({ id }) => id === 'castDrink').taxRate = rate;
  return run(state, { type: 'saveStoreSettings', settings });
}

test('order tax overrides require a store opt-in, an administrator, and a reason', () => {
  const original = seated();
  const order = drinkOrder(original, { taxRateOverride: 0, taxOverrideReason: '  税区分を確認  ' });
  assert.throws(() => run(original, order), /店舗設定と管理者権限/);
  assert.throws(() => verifyCommand('admin', order, original), { code: 'forbidden' });
  const enabled = configure(original, { allowOrderTaxOverride: true });
  for (const actor of [manager, staff]) {
    assert.throws(() => run(enabled, order, actor), /店舗設定と管理者権限/);
    assert.throws(() => verifyCommand(actor.role, order, enabled), { code: 'forbidden' });
  }
  for (const rate of [null, 500, '800', -1]) {
    const malformed = drinkOrder(enabled, { taxRateOverride: rate, taxOverrideReason: order.items[0].taxOverrideReason });
    assert.throws(() => run(enabled, malformed), /税率を確認/);
    assert.throws(() => verifyCommand('admin', malformed, enabled), { code: 'invalid-command' });
  }
  const noReason = drinkOrder(enabled, { taxRateOverride: 800, taxOverrideReason: '  ' });
  assert.throws(() => run(enabled, noReason), /税率の変更理由/);
  assert.throws(() => verifyCommand('admin', noReason, enabled), { code: 'reason-required' });

  verifyCommand('admin', order, enabled);
  const ordinaryOrder = drinkOrder(enabled);
  verifyCommand('staff', ordinaryOrder, enabled);
  assert.equal(run(enabled, ordinaryOrder, staff).tickets[0].lines.at(-1).taxRate, 1_000);
  const ordinary = run(enabled, ordinaryOrder);
  const overridden = run(enabled, order);
  const { id: ticketId } = overridden.tickets[0];
  const regular = quote(ordinary, ticketId);
  const nonTaxable = quote(overridden, ticketId);
  assert.equal(regular.total - nonTaxable.total, 180);
  assert.equal(regular.service, nonTaxable.service);
  assert.deepEqual(regular.commission, nonTaxable.commission);
  assert.deepEqual(ordinary.stock, overridden.stock);
  assert.deepEqual(ordinary.movements, overridden.movements);
  const line = overridden.tickets[0].lines.at(-1);
  assert.equal(line.taxRate, 0);
  assert.equal(line.originalTaxRate, 1_000);
  assert.equal(line.taxOverrideReason, undefined);
  const audit = overridden.auditLog[0];
  assert.equal(audit.actor.id, admin.id);
  assert.equal(audit.at, now);
  assert.deepEqual(audit.after.lines.map(({ id, taxRate, originalTaxRate, taxOverrideReason }) =>
    ({ id, taxRate, originalTaxRate, taxOverrideReason })), [
    { id: line.id, taxRate: 0, originalTaxRate: 1_000, taxOverrideReason: '税区分を確認' },
  ]);
});

test('live corrections restore the original rate even after a menu change and protect advances', () => {
  const enabled = catalogTax(seated({ allowOrderTaxOverride: true }), 500);
  let state = run(enabled, drinkOrder(enabled, { taxRateOverride: 800, taxOverrideReason: '税区分の確認' }));
  state = catalogTax(state, 1_000);
  const { id: ticketId } = state.tickets[0];
  const { id: lineId } = state.tickets[0].lines.at(-1);
  const edit = { type: 'editTicketLine', ticketId, lineId, quantity: 1, reason: '注文時の区分に戻す' };
  const restore = { ...edit, taxRateOverride: null };
  const correctedWithoutTaxChange = run(state, { ...edit, quantity: 2 }, manager);
  assert.equal(correctedWithoutTaxChange.tickets[0].lines.at(-1).taxRate, 800);
  assert.throws(() => run(state, restore, manager), /店舗設定と管理者権限/);
  assert.throws(() => verifyCommand('manager', restore, state), { code: 'forbidden' });
  assert.throws(() => verifyCommand('admin', { ...edit, taxRateOverride: 500 }, state), { code: 'invalid-command' });
  verifyCommand('admin', restore, state);
  const frozen = configure(state, { allowOrderTaxOverride: false });
  assert.equal(frozen.tickets[0].lines.at(-1).taxRate, 800);
  assert.throws(() => run(frozen, restore), /店舗設定と管理者権限/);

  const prepaid = run(state, { type: 'deposit', ticketId, method: 'cash', amount: quote(state, ticketId).total });
  assert.throws(() => run(prepaid, restore), /前受金を下回ります/);
  const restored = run(state, restore);
  assert.equal(restored.tickets[0].lines.at(-1).taxRate, 500);
  assert.equal(restored.tickets[0].lines.at(-1).originalTaxRate, undefined);
  assert.equal(restored.auditLog[0].before.line.taxRate, 800);
  assert.equal(restored.auditLog[0].after.line.taxRate, 500);
  assert.equal(restored.auditLog[0].reason, edit.reason);
  assert.deepEqual(restored.movements, state.movements);
});

test('settled receipts and journal CSV keep the applied rates after opt-out and menu changes', () => {
  let state = seated({ allowOrderTaxOverride: true });
  for (const rate of [800, 0]) state = run(state, drinkOrder(state, { taxRateOverride: rate, taxOverrideReason: '税区分を指定' }));
  const { id: ticketId } = state.tickets[0];
  const mixed = quote(state, ticketId);
  assert.deepEqual(mixed.taxBreakdown, [
    { rate: 1_000, base: 6_000, tax: 600 },
    { rate: 800, base: 1_800, tax: 144 },
    { rate: 0, base: 1_800, tax: 0 },
  ]);
  state = run(state, { type: 'settle', ticketId, payments: [{ method: 'cash', amount: mixed.total }] });
  const settled = quote(state, ticketId);
  assert.throws(() => run(state, { type: 'editTicketLine', ticketId, lineId: state.tickets[0].lines.at(-1).id, quantity: 1,
    taxRateOverride: 1_000, reason: '税区分を確認' }), /会計済み|利用中|操作/);
  state = run(state, { type: 'depart', ticketId });
  state = run(state, { type: 'close', actualCash: mixed.total });
  state = configure(catalogTax(state, 800), { allowOrderTaxOverride: false, priceMode: 'inclusive' });
  assert.deepEqual(quote(state, ticketId), settled);
  assert.deepEqual(state.closedDays[0].ticketSnapshots[0].lines.slice(-2).map(({ taxRate }) => taxRate), [800, 0]);
  const report = getReportPeriod(state, { mode: 'day', date });
  const csv = buildFreeeCsv(report, { mode: 'tickets' });
  assert.equal(csv.salesTotal, settled.total);
  for (const category of ['課税売上10%', '課税売上8%（軽）', '非課売上']) assert(csv.csv.includes(category));
  assert.doesNotThrow(() => validateSnapshot(state));
  for (const [field, value] of [['taxRate', 500], ['originalTaxRate', 0], ['originalTaxRate', 10_001]]) {
    const malformed = structuredClone(state);
    malformed.closedDays[0].ticketSnapshots[0].lines.at(-1)[field] = value;
    assert.throws(() => validateSnapshot(malformed), { code: 'invalid-snapshot' });
  }
  const file = exportStoreConfiguration(configure(state, { allowOrderTaxOverride: true }));
  const imported = parseStoreConfiguration(JSON.stringify(file));
  assert.equal(imported.calculationSettings.allowOrderTaxOverride, true);
});

test('an override changes the tax breakdown of a tax-inclusive item without increasing its gross billing', () => {
  const started = seated({ allowOrderTaxOverride: true, priceMode: 'inclusive' });
  const { id: ticketId } = started.tickets[0];
  const original = quote(run(started, drinkOrder(started)), ticketId);
  const changed = quote(run(started, drinkOrder(started, { taxRateOverride: 800, taxOverrideReason: '軽減税率を適用' })), ticketId);
  assert.equal(changed.total, original.total);
  assert.equal(changed.service, original.service);
  assert(changed.tax < original.tax);
  assert.deepEqual(changed.taxBreakdown, [
    { rate: 1_000, base: 5_455, tax: 545 },
    { rate: 800, base: 1_667, tax: 133 },
  ]);
});
