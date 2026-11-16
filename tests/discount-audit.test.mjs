import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createDemo, getManagerDiscountLimit, quote } from '../docs/engine.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';

const now = Date.UTC(2026, 10, 16, 12);
const admin = { id: 'owner', label: '管理者', role: 'admin' };
const manager = { id: 'manager-1', label: 'マネージャー', role: 'manager' };
const staff = { id: 'staff-1', label: 'ホール担当', role: 'staff' };

function setup() {
  let state = apply(createDemo('closed', now), { type: 'open', openingCash: 0 }, now, admin);
  state = apply(state, { type: 'seat', tableIds: ['a1'], guests: 1, setId: 'set60', customer: '顧客名' }, now, staff);
  return state;
}

function act(state, operation, actor = admin, at = now) {
  return apply(state, { ticketId: state.tickets[0]?.id, ...operation }, at, actor);
}

const discount = (value, mode = 'amount') => ({
  type: 'discount', mode, value, reasonCode: 'coupon', reason: '開店記念クーポン',
});
const addDrink = (state) => act(state, { type: 'order', items: [{ menuId: 'highball', quantity: 1 }] }, staff);
const totals = (state) => quote(state, state.tickets[0].id);
const latest = (state) => state.auditLog[0];

test('manager limit supports exact percent and yen while staff and missing reasons are rejected', () => {
  const initial = addDrink(setup());
  assert.equal(getManagerDiscountLimit(initial), 1_000);
  assert.throws(() => act(initial, discount(200), staff), /権限/);
  assert.throws(() => act(initial, { ...discount(200), reason: '  ' }, manager), /値引き理由/);
  assert.throws(() => act(initial, { ...discount(200), reasonCode: 'unknown' }, manager), /理由区分/);
  assert.throws(() => act(initial, discount(10.001, 'percent'), manager), /小数点以下2桁/);
  assert.throws(() => act(initial, discount(1.5), manager), /円単位/);
  const applied = act(initial, discount(9.99, 'percent'), manager);
  assert.equal(totals(applied).discount, 589);
  assert.equal(applied.tickets[0].discountRequest, null);
  assert.equal(applied.tickets[0].discountDetails.subtotal, 5_900);
  assert.equal(latest(applied).action, 'discount');
  assert.deepEqual(latest(applied).actor, manager);
  const staged = act(initial, discount(10.01, 'percent'), manager);
  assert.equal(totals(staged).discount, 0);
  assert.equal(staged.tickets[0].discountRequest.amount, 590);
  assert.equal(latest(staged).action, 'discountRequest');
});

test('over-limit request requires administrator approval before settlement and retains both actors', () => {
  const requestState = act(setup(), discount(1_200), manager);
  const { id: requestId } = requestState.tickets[0].discountRequest;
  const approve = { type: 'approveDiscount', requestId, reason: '会員特典を確認' };
  assert.throws(() => act(requestState, approve, manager), /管理者権限/);
  assert.throws(() => act(requestState, { ...approve, requestId: 'expired' }), /再表示/);
  assert.throws(() => act(requestState, { type: 'settle', payments: [{ method: 'cash', amount: 6_600 }] }, staff), /承認待ち/);
  assert.equal(totals(requestState).total, 6_600);
  const approved = act(requestState, approve, admin, now + 100);
  assert.equal(approved.tickets[0].discountRequest, null);
  assert.equal(totals(approved).discount, 1_200);
  assert.deepEqual(approved.tickets[0].discountDetails.actor, manager);
  assert.deepEqual(approved.tickets[0].discountDetails.approvedBy, admin);
  assert.deepEqual(latest(approved).actor, admin);
  assert.equal(latest(approved).at, now + 100);
  assert.equal(latest(approved).reason, '会員特典を確認');
  assert.equal(latest(approved).before.discount, 0);
  assert.equal(latest(approved).after.discount, 1_200);
  assert.equal(latest(approved).after.discountRequest, null);
  const settled = act(approved, { type: 'settle', payments: [{ method: 'cash', amount: totals(approved).total }] }, staff);
  assert.equal(settled.tickets[0].status, 'paid');
});

test('stale requests and newly applied deposits cannot create an invalid balance', () => {
  const pending = act(setup(), discount(50, 'percent'), manager);
  const { id: requestId } = pending.tickets[0].discountRequest;
  assert.throws(() => act(addDrink(pending), { type: 'approveDiscount', requestId }), /小計/);
  const deposited = act(pending, { type: 'deposit', amount: 4_000, method: 'cash' }, staff);
  assert.throws(() => act(deposited, { type: 'approveDiscount', requestId }), /前受金/);
  assert.throws(() => act(deposited, { type: 'rejectDiscount', requestId }), /却下理由/);
  const rejected = act(deposited, { type: 'rejectDiscount', requestId, reason: '前受金を考慮して再申請' });
  assert.equal(rejected.tickets[0].discountRequest, null);
  assert.equal(totals(rejected).discount, 0);
  assert.equal(latest(rejected).action, 'rejectDiscount');
  assert.equal(latest(rejected).reason, '前受金を考慮して再申請');
  assert.ok(deposited.tickets[0].discountRequest);
});

test('manager cannot use order cancellation to exceed a configured discount ceiling', () => {
  const initial = addDrink(setup());
  const controls = { type: 'saveControls', managerDiscountRateBps: 2_000 };
  assert.throws(() => act(initial, controls, manager), /管理者権限/);
  const configured = act(initial, controls);
  assert.equal(getManagerDiscountLimit(configured), 2_000);
  assert.deepEqual(latest(configured).before, { managerDiscountRateBps: 1_000 });
  assert.deepEqual(latest(configured).after, { managerDiscountRateBps: 2_000 });
  const applied = act(configured, discount(1_180), manager);
  assert.equal(totals(applied).discount, 1_180);
  const lineId = applied.tickets[0].lines.at(-1).id;
  const cancel = { type: 'cancelLine', lineId, reason: '提供前の注文変更', returnStock: true };
  assert.throws(() => act(applied, cancel, manager), /承認上限/);
  assert.equal(applied.tickets[0].lines.at(-1).cancelledAt, null);
  assert.equal(act(applied, cancel).tickets[0].lines.at(-1).cancelledAt, now);
});

test('audit records meaningful before and after changes without customer names', () => {
  let state = addDrink(setup());
  const lineId = state.tickets[0].lines.at(-1).id;
  assert.throws(() => act(state, { type: 'cancelLine', lineId }, manager), /取消理由/);
  state = act(state, { type: 'cancelLine', lineId, returnStock: true, reason: '注文を取り消し' }, manager);
  assert.equal(latest(state).before.line.name, 'ハイボール');
  assert.equal(latest(state).after.line.cancelled, true);
  assert.ok(latest(state).after.stockMovements.some(({ stockId, quantity }) => stockId === 'soda' && quantity === 0.25));
  assert.ok(!JSON.stringify(latest(state)).includes('顧客名'));

  state = act(state, { type: 'stockAdjust', stockId: 'soda', quantity: 2, reason: '棚卸差異' }, manager);
  assert.deepEqual([latest(state).before.quantity, latest(state).after.quantity], [24, 26]);
  assert.equal(latest(state).reason, '棚卸差異');
  const settings = getStoreSettings(state);
  settings.menu.find(({ id }) => id === 'highball').price = 1_000;
  state = act(state, { type: 'saveStoreSettings', settings });
  assert.deepEqual(latest(state).before.menu, [{ id: 'highball', name: 'ハイボール', price: 900 }]);
  assert.deepEqual(latest(state).after.menu, [{ id: 'highball', name: 'ハイボール', price: 1_000 }]);
});
