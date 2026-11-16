import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, getSettledTicketPaymentTotal, quote, summary } from '../docs/engine.mjs';
import { buildFreeeCsv } from '../docs/freee-export.mjs';
import { getPrintDocuments } from '../docs/print-domain.mjs';
import { getReportDay, getReportPeriod } from '../docs/report-period.mjs';

const date = '2026-11-16';
const nextDate = '2026-11-17';
const now = Date.parse(`${date}T21:00:00+09:00`);
const correctedAt = now + 60_000;
const admin = { id: 'owner', label: '店舗管理者', role: 'admin' };
const run = (state, action, at = now, actor = admin) => apply(state, action, at, actor);

function seat() {
  const opened = run(createDemo('closed', now), { type: 'open', date, openingCash: 20_000 });
  return run(opened, { type: 'seat', tableIds: ['a1'], guests: 2, setId: 'set60' });
}

function correct(ticketId, payments, reason = '決済端末の控えと照合') {
  return { type: 'correctSettledTicketPayments', ticketId, payments, reason };
}

test('split tender correction keeps the frozen bill, card surcharge, order, receipt revision and deposits', () => {
  let state = seat();
  const [{ id: ticketId }] = state.tickets;
  state = run(state, { type: 'order', ticketId, items: [{ menuId: 'castDrink', quantity: 1, castIds: ['cast1'] }] });
  state = run(state, { type: 'deposit', ticketId, method: 'qr', amount: 2_000 });
  state = run(state, { type: 'saveCardFeeSettings', settings: { enabled: true, rateBps: 500 } });
  const originalCash = quote(state, ticketId).remaining - 9_000;
  state = run(state, { type: 'settle', ticketId, expectedCardFee: 450, payments: [
    { method: 'cash', amount: originalCash }, { method: 'card', amount: 9_000 },
  ] });
  state = run(state, { type: 'issuePrintDocument', kind: 'receipt', date, ticketId });
  state = run(state, { type: 'saveCardFeeSettings', settings: { enabled: true, rateBps: 2_000 } });
  const [original] = state.tickets;
  const total = getSettledTicketPaymentTotal(original);
  const payments = [{ method: 'cash', amount: 8_000 }, { method: 'qr', amount: total - 8_000 }];
  const corrected = run(state, correct(ticketId, payments), correctedAt);
  const [ticket] = corrected.tickets;

  assert.deepEqual(ticket.payments.map(({ method, amount, at }) => ({ method, amount, at })),
    payments.map((payment) => ({ ...payment, at: original.settledAt })));
  assert.ok(ticket.payments.every((payment) => payment.cardFee === undefined));
  assert.equal(ticket.paymentsCorrectedAt, correctedAt);
  for (const field of ['lines', 'tableIds', 'deposits', 'tableHistory', 'settlementRevision', 'settledAt', 'status']) {
    assert.deepEqual(ticket[field], original[field]);
  }
  assert.deepEqual(quote(corrected, ticketId), quote(state, ticketId));
  assert.equal(ticket.settlement.cardFee, 450);
  assert.deepEqual(corrected.stock, state.stock);
  assert.deepEqual(corrected.movements, state.movements);
  assert.deepEqual(corrected.printDocuments, state.printDocuments);
  assert.equal(getPrintDocuments(corrected, ticket, date, 'receipt').length, 1);
  assert.equal(summary(corrected).sales, summary(state).sales);
  assert.equal(summary(corrected).expectedCash, 28_000);
  assert.deepEqual(summary(corrected).tenderPayments, { cash: 8_000, card: 0, qr: total - 8_000 });
  assert.deepEqual(summary(corrected).depositsReceived, { cash: 0, card: 0, qr: 2_000 });
  const exported = buildFreeeCsv(getReportPeriod(corrected, { mode: 'day' }), { mode: 'tickets' });
  assert.equal(exported.salesTotal, original.settlement.total);
  assert.match(exported.csv, /QR決済/);

  const event = corrected.auditLog[0];
  assert.equal(event.action, 'correctSettledTicketPayments');
  assert.equal(event.at, correctedAt);
  assert.deepEqual(event.actor, admin);
  assert.equal(event.businessDate, date);
  assert.equal(event.target.id, ticketId);
  assert.equal(event.reason, '決済端末の控えと照合');
  assert.deepEqual(event.before.payments, [{ method: 'cash', amount: originalCash }, { method: 'card', amount: 9_450 }]);
  assert.deepEqual(event.after.payments, payments);
});

test('a closed payment correction updates matching ticket snapshots and historical reports, keeping counted cash', () => {
  let state = seat();
  const [{ id: ticketId }] = state.tickets;
  const amount = quote(state, ticketId).remaining;
  state = run(state, { type: 'settle', ticketId, payments: [{ method: 'cash', amount }] });
  state = run(state, { type: 'depart', ticketId });
  state = run(state, { type: 'close', actualCash: 20_000 + amount });
  const originalClose = structuredClone(state.closedDays[0]);
  state = run(state, correct(ticketId, [{ method: 'card', amount }]), correctedAt);
  assert.deepEqual(state.tickets[0].payments, state.closedDays[0].ticketSnapshots[0].payments);
  assert.deepEqual(state.closedDays[0].payments, { cash: 0, card: amount, qr: 0 });
  assert.equal(state.closedDays[0].expectedCash, 20_000);
  assert.equal(state.closedDays[0].discrepancy, amount);
  assert.equal(state.closedDays[0].actualCash, originalClose.actualCash);
  assert.equal(state.day.closingCash, originalClose.actualCash);
  assert.equal(state.closedDays[0].closedAt, originalClose.closedAt);

  const reopenedAt = Date.parse(`${nextDate}T20:00:00+09:00`);
  state = run(state, { type: 'open', date: nextDate, openingCash: 30_000 }, reopenedAt);
  // Older reports only store tender combined with deposits, and derive the missing breakdown from receipts.
  delete state.closedDays[0].tenderPayments;
  const payments = [{ method: 'qr', amount: 9_000 }, { method: 'cash', amount: amount - 9_000 }];
  const history = run(state, correct(ticketId, payments), reopenedAt + 60_000);
  const report = getReportDay(history, date);
  assert.equal(summary(history).expectedCash, 30_000);
  assert.equal(summary(history).sales, 0);
  assert.equal(report.current.expectedCash, 20_000 + amount - 9_000);
  assert.equal(report.current.actualCash, originalClose.actualCash);
  assert.equal(report.current.discrepancy, 9_000);
  assert.equal(report.current.sales, amount);
  assert.deepEqual(report.current.tenderPayments, { cash: amount - 9_000, card: 0, qr: 9_000 });
  assert.deepEqual(report.current.payments, report.current.tenderPayments);
  assert.deepEqual(report.settledTickets[0].payments.map(({ method, amount: value }) => ({ method, amount: value })), payments);
  assert.equal(report.ticketDataComplete, true);
  assert.equal(history.auditLog[0].businessDate, date);
  assert.equal(history.auditLog[0].after.expectedCash, report.current.expectedCash);
  assert.equal(history.auditLog[0].before.expectedCash, 20_000);
});

test('payment correction rejects non-admin, empty reasons, invalid rows, unchanged totals and prepayment-only tickets', () => {
  const open = seat();
  const [{ id: ticketId }] = open.tickets;
  const amount = quote(open, ticketId).total;
  const command = correct(ticketId, [{ method: 'card', amount }]);
  assert.throws(() => run(open, command), /会計済み/);
  const paid = run(open, { type: 'settle', ticketId, payments: [{ method: 'cash', amount }] });
  const snapshot = structuredClone(paid);
  const manager = { id: 'manager', label: '管理担当者', role: 'manager' };
  assert.throws(() => run(paid, command, correctedAt, manager), /権限/);
  assert.throws(() => run(paid, { ...command, reason: '　' }), /訂正理由/);
  assert.throws(() => run(paid, { ...command, reason: 'あ'.repeat(121) }), /訂正理由/);
  assert.throws(() => run(paid, { ...command, payments: [] }), /支払内容/);
  assert.throws(() => run(paid, { ...command, payments: [null] }), /支払方法/);
  assert.throws(() => run(paid, correct(ticketId, [{ method: 'card', amount: 0.5 }])), /整数/);
  assert.throws(() => run(paid, correct(ticketId, [{ method: 'card', amount: amount + 1 }])), /訂正前の支払額/);
  assert.throws(() => run(paid, correct(ticketId, [
    { method: 'cash', amount: 1_000 }, { method: 'cash', amount: amount - 1_000 },
  ])), /変更してください/);
  assert.deepEqual(paid, snapshot);

  const deposited = run(open, { type: 'deposit', ticketId, method: 'cash', amount });
  const zero = run(deposited, { type: 'settle', ticketId, payments: [] });
  assert.equal(getSettledTicketPaymentTotal(zero.tickets[0]), 0);
  assert.throws(() => run(zero, command), /支払記録/);
});

test('corrects older saved receipts whose original bill can be recovered from the lines', () => {
  const open = seat();
  const [{ id: ticketId }] = open.tickets;
  const amount = quote(open, ticketId).total;
  const paid = run(open, { type: 'settle', ticketId, payments: [{ method: 'cash', amount }] });
  const initialQuote = quote(paid, ticketId);
  paid.tickets[0].settlement = null;
  delete paid.tickets[0].settlementRevision;
  const command = correct(ticketId, [{ method: 'card', amount }]);
  const corrected = run(paid, command, correctedAt);
  assert.deepEqual(corrected.tickets[0].settlement, initialQuote);
  assert.equal(corrected.tickets[0].settlementRevision, undefined);
  assert.equal(corrected.auditLog[0].before.total, amount);
  assert.equal(corrected.auditLog[0].after.total, amount);
  paid.tickets[0].payments[0].amount += 1;
  assert.throws(() => run(paid, command, correctedAt), /会計額と登録済みの支払額/);
});

test('cancellation retains the corrected receipt and subsequent checkout starts a fresh card fee allocation', () => {
  let state = seat();
  const [{ id: ticketId }] = state.tickets;
  const amount = quote(state, ticketId).remaining;
  state = run(state, { type: 'saveCardFeeSettings', settings: { enabled: true, rateBps: 1_000 } });
  const card = { type: 'settle', ticketId, payments: [{ method: 'card', amount }], expectedCardFee: 1_320 };
  state = run(state, card);
  state = run(state, correct(ticketId, [{ method: 'cash', amount: amount + 1_320 }]), correctedAt);
  state = run(state, { type: 'cancelSettlement', ticketId, reason: '誤った伝票の取消' }, correctedAt + 60_000);
  assert.equal(state.cancelledSettlements[0].receipt.paymentsCorrectedAt, correctedAt);
  assert.equal(state.cancelledSettlements[0].receipt.settlement.cardFee, 1_320);
  assert.equal(state.tickets[0].paymentsCorrectedAt, undefined);
  state = run(state, { type: 'reopenTicket', ticketId, tableIds: ['a1'], reason: '伝票内容の入力を再開' });
  state = run(state, card);
  assert.equal(state.tickets[0].paymentsCorrectedAt, undefined);
  assert.equal(state.tickets[0].payments[0].cardFee, 1_320);
});
