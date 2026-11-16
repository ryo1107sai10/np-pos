import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { getCustomerReceivableBalance, getReceivableBalance, getReceivableStatus } from '../docs/receivables.mjs';

const initialDate = '2026-11-16';
const nextDate = '2026-11-17';
const now = Date.parse(`${initialDate}T21:00:00+09:00`);
const admin = { id: 'admin-1', label: '管理者', role: 'admin' };
const manager = { id: 'manager-1', label: 'マネージャー', role: 'manager' };
const staff = { id: 'staff-1', label: 'スタッフ', role: 'staff' };
const run = (state, command, actor = admin, at = now) => apply(state, command, at, actor);

function fixture({ name = '山田様', creditEnabled = true, creditLimit = 20_000, owner = admin } = {}) {
  const opened = run(createDemo('closed', now), { type: 'open', date: initialDate, openingCash: 10_000 });
  const created = run(opened, { type: 'saveCustomer', customer: { name } }, owner);
  const customerId = created.customers.at(-1).id;
  const state = run(created, { type: 'saveCustomer', customerId, customer: { creditEnabled, creditLimit } });
  return { state, customerId };
}

function seat(state, customerId, tableId = 'a1', actor = admin) {
  const seated = run(state, { type: 'seat', tableIds: [tableId], guests: 2, setId: 'set60', customerId }, actor);
  return { state: seated, ticketId: seated.tickets.at(-1).id };
}

function creditSale(state, ticketId, amount, overrides = {}) {
  const tender = quote(state, ticketId).remaining - amount;
  return { type: 'settle', ticketId, creditDueDate: nextDate,
    payments: [...(tender ? [{ method: 'cash', amount: tender }] : []), { method: 'receivable', amount }], ...overrides };
}

function recovery(receivableId, amount, method = 'cash', date = initialDate) {
  return { type: 'recoverReceivable', receivableId, amount, method, date };
}

test('V-6 tracks ¥10,000 credit, ¥4,000 partial recovery, and closed-day accounting separately from sales', () => {
  const initial = fixture();
  const seated = seat(initial.state, initial.customerId);
  const { ticketId } = seated;
  const issued = run(seated.state, creditSale(seated.state, ticketId, 10_000));
  const [entry] = issued.receivables;
  assert.equal(entry.customerId, initial.customerId);
  assert.equal(entry.ticketId, ticketId);
  assert.equal(entry.date, initialDate);
  assert.equal(entry.dueDate, nextDate);
  assert.equal(getReceivableStatus(entry, initialDate), 'unpaid');
  assert.equal(quote(issued, ticketId).total, 13_200);
  assert.equal(quote(issued, ticketId).receivable, 10_000);
  assert.equal(quote(issued, ticketId).paid, 3_200);
  assert.equal(quote(issued, ticketId).remaining, 0);

  const partial = run(issued, recovery(entry.id, 4_000));
  assert.equal(getReceivableBalance(partial.receivables[0]), 6_000);
  assert.equal(getCustomerReceivableBalance(partial, initial.customerId), 6_000);
  assert.equal(getReceivableStatus(partial.receivables[0], initialDate), 'partial');
  assert.equal(getReceivableStatus(partial.receivables[0], nextDate), 'partial');
  assert.equal(getReceivableStatus(partial.receivables[0], '2026-11-18'), 'overdue');
  const { sales, receivableSales, expectedCash, payments, recoveries } = summary(partial);
  assert.equal(sales, 13_200);
  assert.equal(receivableSales, 10_000);
  assert.equal(expectedCash, 17_200);
  assert.deepEqual(payments, { cash: 3_200, card: 0, qr: 0 });
  assert.deepEqual(recoveries, { cash: 4_000, card: 0, bank: 0 });
  assert.equal(getReceivableBalance(entry), 10_000);
  const [audit] = partial.auditLog;
  assert.deepEqual(audit.actor, admin);
  assert.equal(audit.target.id, entry.id);
  assert.equal(audit.action, 'recoverReceivable');
  assert.equal(audit.before.balance, 10_000);
  assert.equal(audit.after.balance, 6_000);
  assert.deepEqual(audit.after.collection, partial.receivables[0].collections[0]);

  const departed = run(partial, { type: 'depart', ticketId });
  const closed = run(departed, { type: 'close', actualCash: expectedCash });
  assert.equal(closed.closedDays[0].receivableSales, 10_000);
  assert.deepEqual(closed.closedDays[0].recoveries, recoveries);
  const nextDay = run(closed, { type: 'open', date: nextDate, openingCash: 5_000 });
  const fullyRecovered = run(nextDay, recovery(entry.id, 6_000, 'bank', nextDate), admin, now + 86_400_000);
  assert.equal(getReceivableStatus(fullyRecovered.receivables[0], nextDate), 'paid');
  assert.equal(summary(fullyRecovered).sales, 0);
  assert.equal(summary(fullyRecovered).receivableSales, 0);
  assert.equal(summary(fullyRecovered).expectedCash, 5_000);
  assert.deepEqual(summary(fullyRecovered).recoveries, { cash: 0, card: 0, bank: 6_000 });
  assert.deepEqual(fullyRecovered.closedDays, closed.closedDays);
  assert.deepEqual(fullyRecovered.receivables[0].collections.map(({ amount, method, date }) => [amount, method, date]),
    [[4_000, 'cash', initialDate], [6_000, 'bank', nextDate]]);
  assert.throws(() => run(fullyRecovered, recovery(entry.id, 1, 'card', nextDate)), /売掛残高/);
});

test('credit requires a linked, enabled customer, a valid due date, and approval on top of total outstanding balance', () => {
  const initial = fixture({ creditLimit: 15_000, owner: manager });
  const legacy = seat(initial.state);
  assert.throws(() => run(legacy.state, creditSale(legacy.state, legacy.ticketId, 10_000)), /登録済みの顧客/);
  const disabled = fixture({ creditEnabled: false });
  const ineligible = seat(disabled.state, disabled.customerId);
  assert.throws(() => run(ineligible.state, creditSale(ineligible.state, ineligible.ticketId, 10_000)), /売掛利用を許可/);

  const first = seat(initial.state, initial.customerId, 'a1', manager);
  for (const creditDueDate of [undefined, '2026-02-31', '2026-11-15']) {
    assert.throws(() => run(first.state, creditSale(first.state, first.ticketId, 10_000, { creditDueDate })), /支払期日/);
  }
  const original = creditSale(first.state, first.ticketId, 10_000);
  assert.throws(() => run(first.state, original, staff), /店舗管理者または担当マネージャー/);
  assert.throws(() => run(first.state, { type: 'deposit', ticketId: first.ticketId, method: 'receivable', amount: 50 }), /支払方法/);
  const issued = run(first.state, original, manager);
  const second = seat(issued, initial.customerId, 'a2', manager);
  const excessSale = creditSale(second.state, second.ticketId, 7_000);
  const approvedSale = { ...excessSale, creditOverrideReason: '管理者が確認済み' };
  assert.throws(() => run(second.state, approvedSale, manager), /店舗管理者の承認/);
  assert.throws(() => run(second.state, excessSale), /与信上限を超える理由/);
  assert.equal(second.state.receivables.length, 1);
  const overridden = run(second.state, approvedSale);
  assert.equal(getCustomerReceivableBalance(overridden, initial.customerId), 17_000);
  assert.deepEqual(overridden.receivables[0].creditOverride, { actorId: admin.id, reason: '管理者が確認済み',
    creditLimit: 15_000, balanceBefore: 10_000 });
  assert.equal(overridden.auditLog[0].reason, '管理者が確認済み');
});

test('recovery validates role, date, method, amount, and register totals during manager projection', () => {
  const initial = fixture();
  const seated = seat(initial.state, initial.customerId);
  const issued = run(seated.state, creditSale(seated.state, seated.ticketId, 10_000));
  const [{ id }] = issued.receivables;
  assert.throws(() => run(issued, recovery(id, 10_001)), /売掛残高/);
  assert.throws(() => run(issued, recovery(id, 1, 'cash', nextDate)), /営業日/);
  assert.throws(() => run(issued, recovery(id, 1, 'qr')), /回収方法/);
  assert.throws(() => run(issued, recovery(id, 0)), /円単位/);
  assert.throws(() => run(issued, recovery(id, 1), manager), /店舗管理者または担当マネージャー/);
  assert.throws(() => run(issued, recovery(id, 1), staff), /店舗管理者または担当マネージャー/);
  assert.deepEqual(issued.receivables[0].collections, []);
  const sameCustomerSeated = seat(issued, initial.customerId, 'a2', manager).state;
  assert.throws(() => run(sameCustomerSeated, recovery(id, 1), manager), /店舗管理者または担当マネージャー/);

  const assigned = fixture({ owner: manager });
  const next = seat(assigned.state, assigned.customerId);
  const assignedIssue = run(next.state, creditSale(next.state, next.ticketId, 10_000));
  const recovered = run(assignedIssue, recovery(assignedIssue.receivables[0].id, 1, 'card'), manager);
  assert.equal(getCustomerReceivableBalance(recovered, assigned.customerId), 9_999);
  assert.deepEqual(summary(recovered).recoveries, { cash: 0, card: 1, bank: 0 });
  assert.equal(summary(recovered).expectedCash, 13_200);
  const redacted = { ...recovered, receivables: [], recoveryTotalsForDay: { cash: 5_000, card: 1, bank: 0 } };
  assert.equal(summary(redacted).expectedCash, 18_200);
});

test('uncollected credit is reversed without erasing its history and a reopened receipt reissues a distinct entry', () => {
  const initial = fixture();
  const seated = seat(initial.state, initial.customerId);
  const { ticketId } = seated;
  const issued = run(seated.state, creditSale(seated.state, ticketId, 10_000));
  const [entry] = issued.receivables;
  const cancel = { type: 'cancelSettlement', ticketId, reason: '会計方法の訂正' };
  const collected = run(issued, recovery(entry.id, 100));
  assert.throws(() => run(collected, cancel), /回収済みの金額/);
  assert.equal(summary(collected).sales, 13_200);
  assert.equal(getReceivableBalance(collected.receivables[0]), 9_900);

  const cancelled = run(issued, cancel);
  assert.equal(getReceivableStatus(cancelled.receivables[0], initialDate), 'cancelled');
  assert.equal(cancelled.receivables[0].id, entry.id);
  assert.equal(cancelled.receivables[0].amount, 10_000);
  assert.equal(getCustomerReceivableBalance(cancelled, initial.customerId), 0);
  assert.equal(summary(cancelled).receivableSales, 0);
  assert.equal(summary(cancelled).expectedCash, 10_000);
  assert.equal(cancelled.cancelledSettlements[0].receipt.settlement.receivable, 10_000);
  assert.equal(cancelled.auditLog[0].after.receivable.cancelledAt, now);
  assert.throws(() => run(cancelled, recovery(entry.id, 1)), /回収できる売掛伝票/);

  const reopened = run(cancelled, { type: 'reopenTicket', ticketId, tableIds: ['a1'], reason: '伝票を再確定する' });
  const reissued = run(reopened, creditSale(reopened, ticketId, 7_500));
  assert.notEqual(reissued.receivables[0].id, entry.id);
  assert.deepEqual(reissued.receivables[1], cancelled.receivables[0]);
  assert.equal(getCustomerReceivableBalance(reissued, initial.customerId), 7_500);
  assert.equal(summary(reissued).sales, 13_200);
  assert.equal(summary(reissued).receivableSales, 7_500);
});
