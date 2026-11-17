import assert from 'node:assert/strict';
import test from 'node:test';
import { getCalculationSettings } from '../docs/calculation-settings.mjs';
import { apply, createDemo, getTicketCommissionDetails, quote, summary } from '../docs/engine.mjs';
import { previewPayroll } from '../docs/payroll.mjs';
import { getReportDay } from '../docs/report-period.mjs';
import { projectState, validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-16';
const now = Date.parse(`${date}T21:00:00+09:00`);
const admin = { id: 'owner', label: '店舗管理者', role: 'admin' };
const manager = { id: 'manager', label: 'マネージャー', role: 'manager' };
const staff = { id: 'staff', label: 'スタッフ', role: 'staff' };
const run = (state, action, actor = admin, at = now) => apply(state, action, at, actor);

function fixture(inclusive = false) {
  let state = run(createDemo('closed', now), { type: 'open', date, openingCash: 20_000 });
  const product = state.menu.find(({ id }) => id === 'castDrink');
  product.commission = { rate: 10, points: 2 };
  if (inclusive) {
    product.price = 1_100;
    state.menu.find(({ id }) => id === 'set60').price = 5_500;
    state = run(state, { type: 'saveCalculationSettings',
      settings: { ...getCalculationSettings(state), priceMode: 'inclusive' } });
  }
  state = run(state, { type: 'seat', tableIds: ['a1'], guests: 1, setId: 'set60' });
  const [{ id: ticketId }] = state.tickets;
  return { ticketId, state: run(state, { type: 'order', ticketId,
    items: [{ menuId: 'castDrink', quantity: 1, castIds: ['cast1'] }] }) };
}

function adjust(ticketId, amount, castId = 'cast1') {
  return { type: 'adjustPersonalSales', ticketId, castId, amount, reason: '  指名先の確認  ' };
}

function discount(ticketId, value, personalSalesMode) {
  return { type: 'discount', ticketId, mode: 'amount', value, reasonCode: 'service', reason: '店舗のご案内',
    ...(personalSalesMode !== undefined && { personalSalesMode }) };
}

test('positive and negative adjustments affect only attributed sales and have individual audits', () => {
  const { state, ticketId } = fixture();
  const before = quote(state, ticketId);
  let adjusted = run(state, adjust(ticketId, 750), manager, now + 1_000);
  adjusted = run(adjusted, adjust(ticketId, -900), admin, now + 2_000);
  const { commission, ...quoteFields } = quote(adjusted, ticketId);
  const { commission: previousCommission, ...previousFields } = before;
  assert.deepEqual(quoteFields, previousFields);
  assert.deepEqual(commission, [{ ...previousCommission[0], sales: 1_350 }]);
  assert.deepEqual(adjusted.movements, state.movements);
  assert.deepEqual(adjusted.stock, state.stock);
  assert.deepEqual(adjusted.tickets[0].lines, state.tickets[0].lines);
  assert.equal(summary(adjusted).expectedCash, summary(state).expectedCash);
  assert.deepEqual(summary(adjusted).pendingCommission, commission);

  const history = adjusted.tickets[0].personalSalesAdjustments;
  assert.deepEqual(history.map(({ amount, actor, reason, at }) => ({ amount, actor, reason, at })), [
    { amount: 750, actor: manager, reason: '指名先の確認', at: now + 1_000 },
    { amount: -900, actor: admin, reason: '指名先の確認', at: now + 2_000 },
  ]);
  const events = adjusted.auditLog.filter(({ action }) => action === 'adjustPersonalSales');
  assert.deepEqual(events.map(({ before, after }) => [before.personalSales, after.personalSales]), [[2250,1350],[1500,2250]]);
  assert.equal(events[0].actor.id, admin.id);
  assert.deepEqual(getTicketCommissionDetails(adjusted, ticketId).map(({ name, sales, amount }) => [name, sales, amount]),
    [['キャストドリンク',1500,150],['個人売上の調整',750,0],['個人売上の調整',-900,0]]);
});

test('a saved discount mode survives approval without changing the monetary invoice or percentage payout', () => {
  const { state, ticketId } = fixture();
  const legacy = run(state, discount(ticketId, 1_300));
  const reflect = run(state, discount(ticketId, 1_300, 'reflect'));
  assert.deepEqual(quote(legacy, ticketId), quote(reflect, ticketId));
  let keep = run(state, discount(ticketId, 1_300, 'keep'), manager);
  assert.deepEqual(quote(keep, ticketId), quote(state, ticketId));
  const { discountRequest } = keep.tickets[0];
  assert.equal(discountRequest.personalSalesMode, 'keep');
  keep = run(keep, { type: 'approveDiscount', ticketId, requestId: discountRequest.id });
  const { commission, commissionDetails, ...keptInvoice } = quote(keep, ticketId);
  const { commission: reflectedCommission, commissionDetails: reflectedDetails, ...invoice } = quote(reflect, ticketId);
  assert.deepEqual(keptInvoice, invoice);
  assert.deepEqual(reflectedCommission, [{ castId: 'cast1', sales: 1_200, amount: 120, points: 2 }]);
  assert.deepEqual(commission, [{ ...reflectedCommission[0], sales: 1_500 }]);
  assert.deepEqual(commissionDetails, [{ ...reflectedDetails[0], sales: 1_500 }]);
  assert.equal(keep.tickets[0].discountDetails.personalSalesMode, 'keep');
  assert.equal(keep.auditLog[0].after.discountDetails.personalSalesMode, 'keep');
});

test('keeping inclusive attribution excludes embedded item tax and keeps the discount on paid commission', () => {
  const { state, ticketId } = fixture(true);
  const reflect = quote(run(state, discount(ticketId, 660, 'reflect')), ticketId);
  const retain = quote(run(state, discount(ticketId, 660, 'keep')), ticketId);
  assert.deepEqual(reflect.commission, [{ castId: 'cast1', sales: 900, amount: 90, points: 2 }]);
  assert.deepEqual(retain.commission, [{ castId: 'cast1', sales: 1_000, amount: 90, points: 2 }]);
  assert.equal(retain.total, reflect.total);
  assert.deepEqual(retain.taxBreakdown, reflect.taxBreakdown);
});

test('the store default allocates discounted pretax or full bill amounts while preserving checkout and payouts', () => {
  const {state,ticketId} = fixture();
  const settings = {...getCalculationSettings(state),personalSalesDiscountMode:'prorateNet'};
  let net = run(state,{type:'saveCalculationSettings',settings});
  net = run(net,discount(ticketId,1_000));
  let full = run(state,{type:'saveCalculationSettings',settings:{...settings,personalSalesDiscountMode:'prorateFull'}});
  full = run(full,discount(ticketId,1_000));
  const {commission:netRows,commissionDetails:netDetails,...netBill} = quote(net,ticketId);
  const {commission:fullRows,commissionDetails:fullDetails,...fullBill} = quote(full,ticketId);
  assert.deepEqual(fullBill,netBill);
  assert.equal(netRows[0].sales,500);
  assert.equal(fullRows[0].sales,180);
  assert.equal(netRows[0].amount,fullRows[0].amount);
  assert.equal(netDetails[0].sales,500);
  assert.equal(fullDetails[0].sales,180);
  assert.equal(full.tickets[0].discountDetails.personalSalesMode,'prorateFull');
  assert.ok(validateSnapshot(full));
});

test('personal attribution survives settlement, close and migration without changing payroll sums', () => {
  const { state, ticketId } = fixture();
  const before = run(state, { type: 'settle', ticketId, payments: [{ method: 'cash', amount: quote(state,ticketId).remaining }] });
  let changed = run(state, adjust(ticketId, 300), manager);
  changed = run(changed, adjust(ticketId, 400, 'cast2'), manager);
  changed = run(changed, { type: 'settle', ticketId, payments: [{ method: 'cash', amount: quote(changed,ticketId).remaining }] });
  assert.equal(summary(changed).sales, summary(before).sales);
  assert.deepEqual(summary(changed).payments, summary(before).payments);
  for (const castId of ['cast1','cast2']) {
    assert.deepEqual(previewPayroll(changed,{month:'2026-11',castId}), previewPayroll(before,{month:'2026-11',castId}));
  }
  assert.throws(() => run(changed, adjust(ticketId, 1)), /会計前/);
  changed = run(changed, { type: 'depart', ticketId });
  changed = run(changed, { type: 'close', actualCash: summary(changed).expectedCash });
  changed = run(changed, { type: 'open', date: '2026-11-17', openingCash: 20_000 }, admin, now + 24 * 60 * 60_000);
  const report = getReportDay(changed, date);
  assert.equal(report.current.sales, summary(before).sales);
  assert.deepEqual(report.current.commission, [
    { castId:'cast1', sales:1800, amount:150, points:2 }, { castId:'cast2', sales:400, amount:0, points:0 },
  ]);
  const historical = getTicketCommissionDetails(report.state, ticketId);
  assert.equal(historical.filter(({ name }) => name === '個人売上の調整').length, 2);
  const migrated = validateSnapshot(changed);
  assert.equal(migrated.closedDays[0].ticketSnapshots[0].personalSalesAdjustments[0].actor.id, 'imported-browser');
  const invalid = structuredClone(changed);
  invalid.closedDays[0].ticketSnapshots[0].personalSalesAdjustments[0].salesAfter++;
  assert.throws(() => validateSnapshot(invalid), { code:'invalid-snapshot' });
});

test('permissions, actor projection and safe money checks protect private adjustments and audit', () => {
  const { state, ticketId } = fixture();
  const action = adjust(ticketId, 100);
  assert.doesNotThrow(() => verifyCommand('manager', action));
  assert.throws(() => verifyCommand('staff', action), { code:'forbidden' });
  assert.throws(() => run(state, action, staff), /権限/);
  assert.throws(() => run(state, adjust(ticketId, 100, 'missing')), /キャスト/);
  assert.throws(() => run(state, { ...action, reason: '　' }), /理由/);
  assert.throws(() => verifyCommand('manager', { ...action, reason: 'あ'.repeat(121) }), { code:'invalid-command' });
  for (const invalid of [0, 1.25, '100', 100_000_001]) {
    assert.throws(() => verifyCommand('manager', adjust(ticketId, invalid)), { code:'invalid-command' });
    assert.throws(() => run(state, adjust(ticketId, invalid)), /金額/);
  }
  assert.throws(() => verifyCommand('manager', discount(ticketId, 0, 'unknown')), { code:'invalid-command' });
  const adjusted = run(state, action, manager);
  assert.equal(projectState(adjusted, 'staff', staff.id).tickets[0].personalSalesAdjustments, undefined);
  assert.equal(projectState(adjusted, 'manager', 'another-manager').tickets[0].personalSalesAdjustments[0].actor.id, undefined);
  const restricted = run(adjusted, { type:'saveRolePolicy', policy:{manager:{label:'店長',disabled:['reports']}} });
  assert.throws(() => verifyCommand('manager', action, restricted), { code:'forbidden' });
  assert.throws(() => run(restricted, action, manager), /店舗設定/);
  assert.equal(projectState(restricted, 'manager', manager.id).tickets[0].personalSalesAdjustments, undefined);
});
