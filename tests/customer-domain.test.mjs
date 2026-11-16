import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { renderSeatCustomer, renderSeatCustomerResults, renderSeatCustomerSelection } from '../docs/customer-ui.mjs';
import { findCustomer, getCustomerDetail, isAssignedCustomer, listUnlinkedVisits, parseCustomersCsv,
  searchCustomers } from '../docs/customers.mjs';

const now = Date.parse('2026-11-16T21:00:00+09:00');
const admin = { id: 'admin-1', label: '店舗管理者', role: 'admin' };
const manager = { id: 'manager-1', label: 'マネージャー', role: 'manager' };
const staff = { id: 'staff-1', label: 'スタッフ', role: 'staff' };
const run = (state, action, actor = admin, at = now) => apply(state, action, at, actor);

function opened() {
  return run(createDemo('closed', now), { type: 'open', date: '2026-11-16', openingCash: 20_000 });
}

function register(state, customer, actor = admin) {
  return run(state, { type: 'saveCustomer', customer }, actor);
}

function seat(state, customer, actor = admin, at = now) {
  return run(state, { type: 'seat', tableIds: ['a1'], guests: 1, setId: 'set60', ...customer }, actor, at);
}

function departPaid(state, ticketId, at = now) {
  const paid = run(state, { type: 'settle', ticketId,
    payments: [{ method: 'cash', amount: quote(state, ticketId).remaining }] }, admin, at);
  return run(paid, { type: 'depart', ticketId }, admin, at);
}

test('customer registration supports Japanese search, scopes profile edits, and omits contact details from audit snapshots', () => {
  const customer = { name: '佐藤 かな', kana: 'サトウ　カナ', phone: '０９０－１２３４－５６７８',
    memo: '来店時に確認', birthday: '2000-02-29', castId: 'cast1' };
  const state = register(opened(), customer, manager);
  const [profile] = state.customers;
  assert.deepEqual(searchCustomers(state, 'さとう 1234').map(({ id }) => id), [profile.id]);
  assert.deepEqual(searchCustomers(state, 'ｶﾅ ０９０１２３４').map(({ id }) => id), [profile.id]);
  assert.deepEqual(searchCustomers(state, 'さとう 2222'), []);
  assert.ok(isAssignedCustomer(state, profile, manager.id));
  assert.throws(() => run(state, { type: 'saveCustomer', customerId: profile.id, customer: { creditLimit: 30_000 } }, manager), /店舗管理者/);
  assert.throws(() => run(state, { type: 'saveCustomer', customerId: profile.id, customer: { name: '不正変更' } }, staff), /権限/);
  const next = run(state, { type: 'saveCustomer', customerId: profile.id,
    customer: { phone: '090-2222-2222', creditEnabled: true, creditLimit: 30_000 } });
  assert.equal(findCustomer(next, profile.id).memo, customer.memo);
  const [audit] = next.auditLog;
  assert.deepEqual(audit.before, { creditEnabled: false, creditLimit: 0 });
  assert.deepEqual(audit.after, { creditEnabled: true, creditLimit: 30_000, changedFields: ['phone', 'creditEnabled', 'creditLimit'] });
  assert.throws(() => register(state, { name: '無効日', birthday: '2026-02-29' }), /誕生日/);
});

test('selecting a customer from the floor stores the visit and appointment across business days', () => {
  let state = register(opened(), { name: '初来店', kana: 'はつらいてん' });
  const [customer] = state.customers;
  assert.equal(customer.firstVisitDate, '');
  state = seat(state, { customerId: customer.id }, staff);
  const [{ id: first, seatedByUid, customer: snapshotName }] = state.tickets;
  assert.equal(seatedByUid, staff.id);
  assert.equal(snapshotName, customer.name);
  assert.equal(findCustomer(state, customer.id).firstVisitDate, '2026-11-16');
  assert.equal(state.auditLog[0].actor.id, admin.id);
  state = run(state, { type: 'order', ticketId: first, items: [
    { menuId: 'nomination', quantity: 1, castIds: ['cast3'] },
  ] });
  state = departPaid(state, first);
  const totals = summary(state);
  state = run(state, { type: 'close', actualCash: totals.expectedCash });
  assert.equal(getCustomerDetail(state, customer.id).visits.length, 1);
  const tomorrow = now + 24 * 60 * 60_000;
  state = run(state, { type: 'open', date: '2026-11-17', openingCash: 20_000 }, admin, tomorrow);
  state = run(state, { type: 'saveCustomer', customerId: customer.id, customer: { castId: 'cast2' } });
  state = seat(state, { customerId: customer.id }, manager, tomorrow);
  const details = getCustomerDetail(state, customer.id);
  assert.deepEqual(details.visits.map(({ date, tableLabels }) => [date, tableLabels]), [
    ['2026-11-17', ['A-01']], ['2026-11-16', ['A-01']],
  ]);
  assert.equal(details.preferredCast.id, 'cast2');
  assert.equal(details.lastNomination.castId, 'cast3');
  assert.equal(details.lastNomination.ticketId, first);
  assert.equal(details.totalSales, totals.sales);
  assert.equal(isAssignedCustomer(state, details.customer, manager.id), false);
  assert.equal(isAssignedCustomer(state, details.customer, staff.id), false);
  assert.ok(isAssignedCustomer(state, details.customer, admin.id));
  assert.throws(() => run(state, { type: 'saveCustomer', customerId: customer.id, customer: { name: '担当外' } }, manager), /担当/);
});

test('visits cannot create customer profiles and can remain unlinked', () => {
  const state = opened();
  for (const actor of [admin, manager, staff]) {
    assert.throws(() => seat(state, { newCustomer: { name: '新規のお客様' } }, actor), /顧客管理/);
  }
  assert.throws(() => seat(state, { customerId: 'missing' }), /顧客が見つかりません/);
  const guest = seat(state, {}, staff);
  assert.equal(guest.tickets[0].customer, '');
  assert.equal(guest.tickets[0].customerId, undefined);
  assert.deepEqual(guest.customers ?? [], []);
});

test('the arrival picker displays candidates only when searched and keeps the chosen customer separate', () => {
  const state = register(opened(), { name: '山本 花子', kana: 'ヤマモト ハナコ', phone: '090-1111-2222' });
  const [{id}] = state.customers;
  const api = { role: 'admin', escape: String, icon: () => '' };
  const initial = renderSeatCustomer(state, api);
  assert.match(initial, /name="customerQuery"/);
  assert.doesNotMatch(initial, /山本 花子|name="customerId"|name="(customerMode|newCustomerName|customer)"/);
  assert.equal(renderSeatCustomerResults(state, '　 ', '', api), '');
  assert.match(renderSeatCustomerResults(state, 'やまもと', '', api), /山本 花子/);
  assert.match(renderSeatCustomerResults(state, '山本花子', '', api), /山本 花子/);
  assert.match(renderSeatCustomerResults(state, 'やまもとはなこ', '', api), /山本 花子/);
  assert.match(renderSeatCustomerResults(state, '1111', '', api), /山本 花子/);
  assert.doesNotMatch(renderSeatCustomerResults(state, '不一致', id, api), /山本 花子/);
  const seatStaff = { ...api, role: 'staff' };
  assert.doesNotMatch(renderSeatCustomerResults(state, 'やまもと', '', seatStaff), /山本 花子/);
  assert.match(renderSeatCustomerResults(state, '山本', '', seatStaff), /山本 花子/);
  assert.doesNotMatch(renderSeatCustomerResults(state, '山本', '', seatStaff), /ヤマモト|090/);
  const selected = renderSeatCustomerSelection(state, id, api);
  assert.match(selected, /山本 花子/);
  assert.match(selected, /data-action="seat-customer-clear"/);
});

test('legacy linking and duplicate merging retain receipt totals and redirect active receivables', () => {
  let state = register(opened(), { name: '旧顧客', creditEnabled: true, creditLimit: 30_000 });
  state = register(state, { name: '統合先' });
  const [source, destination] = state.customers;
  state = seat(state, { customer: '旧姓の伝票' });
  const [{ id: legacyTicket }] = state.tickets;
  assert.deepEqual(listUnlinkedVisits(state).map(({ id }) => id), [legacyTicket]);
  state = departPaid(state, legacyTicket);
  state = run(state, { type: 'linkCustomer', ticketId: legacyTicket, customerId: source.id });
  assert.equal(listUnlinkedVisits(state).length, 0);
  state = seat(state, { customerId: source.id });
  const lockedTicket = state.tickets.at(-1).id;
  state = run(state, { type: 'settle', ticketId: lockedTicket, creditDueDate: '2026-11-25',
    payments: [{ method: 'receivable', amount: quote(state, lockedTicket).remaining }] });
  state = run(state, { type: 'cancelSettlement', ticketId: lockedTicket, reason: '二重会計を整理' });
  state = seat(state, { customerId: source.id });
  const linkedTicket = state.tickets.at(-1).id;
  state = run(state, { type: 'settle', ticketId: linkedTicket, creditDueDate: '2026-11-25',
    payments: [{ method: 'receivable', amount: quote(state, linkedTicket).remaining }] });
  state = run(state, { type: 'depart', ticketId: linkedTicket });
  const totals = summary(state);
  state = run(state, { type: 'close', actualCash: totals.expectedCash });
  const merge = { type: 'mergeCustomers', sourceId: source.id, targetId: destination.id, reason: '重複登録' };
  assert.throws(() => run(state, merge, manager), /店舗管理者/);
  const next = run(state, merge);
  assert.equal(findCustomer(next, source.id), undefined);
  assert.equal(next.tickets[0].customer, '旧姓の伝票');
  assert.equal(next.closedDays[0].ticketSnapshots[0].customerId, destination.id);
  assert.equal(next.cancelledSettlements[0].receipt.customerId, destination.id);
  assert.equal(next.receivables[0].customerId, destination.id);
  assert.deepEqual(next.receivables.map(({ amount }) => amount), state.receivables.map(({ amount }) => amount));
  assert.equal(getCustomerDetail(next, destination.id).totalSales, totals.sales);
  assert.equal(next.auditLog[0].reason, merge.reason);
});

test('CSV handles quoted cells and supports atomic admin-only imports', () => {
  const state = opened();
  const cast = state.cast[0];
  const csv = `\uFEFF表示名,電話,担当,メモ\r\n"サンプル,一郎",090-1111-2222,${cast.name},"メモの1行目\nメモの""2行目"""\r\n`;
  const customers = parseCustomersCsv(csv, state.cast);
  assert.deepEqual(customers, [
    { name: 'サンプル,一郎', phone: '090-1111-2222', castId: cast.id, memo: 'メモの1行目\nメモの"2行目"' },
  ]);
  const action = { type: 'importCustomers', customers };
  assert.throws(() => run(state, action, manager), /店舗管理者/);
  assert.throws(() => run(state, { ...action, customers: [...customers, { name: '' }] }), /顧客名/);
  assert.deepEqual(state.customers ?? [], []);
  const imported = run(state, action);
  assert.equal(imported.customers[0].name, customers[0].name);
  assert.equal(imported.auditLog[0].after.count, 1);
  assert.throws(() => parseCustomersCsv('表示名,constructor\nテスト,1', state.cast), /項目名/);
});
