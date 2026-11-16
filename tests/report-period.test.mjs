import assert from 'node:assert/strict';
import test from 'node:test';
import {apply, createDemo, quote, summary} from '../docs/engine.mjs';
import {getMonthlyReportSales, getReportDates, getReportDay, getReportPeriod, isReportDate} from '../docs/report-period.mjs';

const januaryDate = '2024-01-31';
const februaryDate = '2024-02-01';
const leapDate = '2024-02-29';
const time = (date) => Date.parse(`${date}T22:00:00+09:00`);
const run = (state, command) => apply(state, command, time(command.date ?? state.day.date));
const close = (state) => run(state, {type:'close', actualCash:summary(state).expectedCash});

function monthBoundaryFixture() {
  let state = run(createDemo('closed', time(januaryDate)), {type:'open', date:januaryDate, openingCash:20_000});
  state = run(state, {type:'saveCustomer', customer:{name:'集計サンプル', creditEnabled:true, creditLimit:20_000}});
  state = run(state, {type:'seat', tableIds:['a1'], guests:2, customerId:state.customers[0].id, setId:'set60'});
  const ticketId = state.tickets[0].id;
  state = run(state, {type:'deposit', ticketId, method:'cash', amount:1_000});
  state = run(state, {type:'settle', ticketId, creditDueDate:februaryDate, payments:[
    {method:'card', amount:2_200}, {method:'receivable', amount:10_000},
  ]});
  state = run(state, {type:'depart', ticketId});
  state = run(state, {type:'recordCashMovement', kind:'expense', amount:500, category:'purchase', reason:'仕入れ'});
  state = close(state);
  state = run(state, {type:'open', date:februaryDate, openingCash:30_000});
  const {id:receivableId} = state.receivables[0];
  state = run(state, {type:'recoverReceivable', receivableId, method:'cash', amount:4_000, date:februaryDate});
  state = run(state, {type:'recordCashMovement', kind:'expense', amount:800, category:'supplies', reason:'消耗品'});
  state = close(state);
  state = run(state, {type:'open', date:leapDate, openingCash:30_000});
  return run(state, {type:'recoverReceivable', receivableId, method:'card', amount:2_000, date:leapDate});
}

test('period dates are calendar dates and month and custom range include both boundaries', () => {
  const state = monthBoundaryFixture();
  assert.deepEqual(getReportDates(state), [januaryDate, februaryDate, leapDate]);
  assert.equal(isReportDate(leapDate), true);
  assert.equal(isReportDate('2025-02-29'), false);
  assert.equal(isReportDate('0000-02-29'), false);
  const month = getReportPeriod(state, {mode:'month', month:'2024-02'});
  assert.equal(month.valid, true);
  assert.equal(month.start, februaryDate);
  assert.equal(month.end, leapDate);
  assert.deepEqual(month.days.map(({date}) => date), [februaryDate, leapDate]);
  const range = getReportPeriod(state, {mode:'range', start:januaryDate, end:februaryDate});
  assert.deepEqual(range.days.map(({date}) => date), [januaryDate, februaryDate]);
  const invalid = getReportPeriod(state, {mode:'range', start:februaryDate, end:januaryDate});
  assert.equal(invalid.valid, false);
  assert.match(invalid.error, /開始日/);
  assert.deepEqual(invalid.days, []);
  const empty = getReportPeriod(state, {mode:'month', month:'2025-01'});
  assert.equal(empty.valid, true);
  assert.deepEqual(empty.days, []);
  assert.equal(empty.totals.sales, 0);
});

test('monthly and range totals separate prior sales, first deposits, recoveries and expenses', () => {
  const state = monthBoundaryFixture();
  const month = getReportPeriod(state, {mode:'month', month:'2024-02'});
  assert.equal(month.totals.sales, 0);
  assert.equal(month.totals.receivableSales, 0);
  assert.deepEqual(month.totals.recoveries, {cash:4_000, card:2_000, bank:0});
  assert.equal(month.totals.expenses, 800);

  const range = getReportPeriod(state, {mode:'range', start:januaryDate, end:leapDate});
  assert.equal(range.totals.sales, 13_200);
  assert.equal(range.totals.guests, 2);
  assert.equal(range.totals.tickets, 1);
  assert.deepEqual(range.totals.payments, {cash:1_000, card:2_200, qr:0});
  assert.deepEqual(range.totals.tenderPayments, {cash:0, card:2_200, qr:0});
  assert.deepEqual(range.totals.depositsReceived, {cash:1_000, card:0, qr:0});
  assert.equal(range.totals.depositsApplied, 1_000);
  assert.equal(range.totals.receivableSales, 10_000);
  assert.equal(range.totals.expenses, 1_300);
  assert.equal(range.totals.expectedCash, undefined);
  assert.equal(range.days[0].current.expectedCash, 20_500);
  assert.equal(range.days[1].current.expectedCash, 33_200);
  assert.equal(range.days[2].current.expectedCash, 30_000);
  assert.equal(getReportDay(state, '2024-02-05'), null);
  assert.equal(getReportDay(state).date, leapDate);
});

test('period reporting uses recorded snapshots and scoped store-wide recovery totals', () => {
  const state = monthBoundaryFixture();
  state.recoveryTotalsForDay = {cash:0, card:2_000, bank:600};
  state.recoveryRowsForDay = [{id:'projected', date:leapDate, method:'card', amount:2_000}];
  state.receivables = [];
  const range = getReportPeriod(state, {mode:'range', start:januaryDate, end:leapDate});
  assert.deepEqual(range.totals.recoveries, {cash:4_000, card:2_000, bank:600});
  assert.equal(range.days[0].settledTickets.length, 1);
  assert.equal(range.days[0].state.day.date, januaryDate);
  const saved = range.days[0].settledTickets[0];
  assert.equal(quote(range.days[0].state, saved.id).total, 13_200);
  assert.deepEqual(range.days[2].current.recoveryRows, state.recoveryRowsForDay);
});

test('legacy split is reconstructed only for dates with matching historical receipts', () => {
  const state = monthBoundaryFixture();
  const archive = state.closedDays.find(({date}) => date === januaryDate);
  delete archive.tenderPayments;
  delete archive.depositsReceived;
  delete archive.depositsApplied;
  const reconstructed = getReportDay(state, januaryDate);
  assert.equal(reconstructed.ticketDataComplete, true);
  assert.equal(reconstructed.current.tenderPayments.card, 2_200);
  assert.equal(reconstructed.current.depositsReceived.cash, 1_000);
  assert.equal(reconstructed.current.depositsApplied, 1_000);

  delete archive.ticketSnapshots;
  const period = getReportPeriod(state, {mode:'day', date:januaryDate});
  assert.equal(period.days[0].legacy, true);
  assert.equal(period.days[0].ticketDataComplete, false);
  assert.deepEqual(period.days[0].settledTickets, []);
  assert.equal(period.days[0].current.tenderPayments, null);
  assert.equal(period.totals.sales, 13_200);
  assert.equal(period.totals.payments.cash, 1_000);
  assert.equal(period.totals.hasCombinedOnlyPayments, true);
});

test('open advances remain period cash while cancellation stops sales and hides the receipt from export detail', () => {
  let state = run(createDemo('closed', time(leapDate)), {type:'open', date:leapDate, openingCash:20_000});
  state = run(state, {type:'seat', tableIds:['a1'], guests:2, setId:'set60'});
  const ticketId = state.tickets[0].id;
  state = run(state, {type:'deposit', ticketId, method:'cash', amount:1_000});
  const day = getReportDay(state);
  assert.equal(day.current.sales, 0);
  assert.equal(day.current.payments.cash, 1_000);
  assert.equal(day.current.depositsApplied, 0);
  state = run(state, {type:'settle', ticketId, payments:[{method:'cash', amount:12_200}]});
  state = run(state, {type:'cancelSettlement', ticketId, reason:'取消検証'});
  const cancelled = getReportDay(state);
  assert.equal(cancelled.current.sales, 0);
  assert.equal(cancelled.current.payments.cash, 0);
  assert.equal(cancelled.settledTickets.length, 0);
  assert.equal(cancelled.ticketDataComplete, true);
});

test('the floor monthly figure matches the period report across archived and current sales', () => {
  let state = monthBoundaryFixture();
  state = run(state, {type:'seat', tableIds:['a1'], guests:1, setId:'set60'});
  const ticketId = state.tickets[0].id;
  state = run(state, {type:'settle', ticketId, payments:[{method:'cash', amount:6_600}]});
  assert.equal(getMonthlyReportSales(state, '2024-01'), 13_200);
  assert.equal(getMonthlyReportSales(state), 6_600);
  assert.equal(getMonthlyReportSales(state, '2024-02', summary(state)),
    getReportPeriod(state, {mode:'month', month:'2024-02'}).totals.sales);
  assert.equal(getMonthlyReportSales(state, '2024-13'), 0);
  const oldArchive = state.closedDays.find(({date}) => date === januaryDate);
  delete oldArchive.sales;
  assert.equal(getMonthlyReportSales(state, '2024-01'),
    getReportPeriod(state, {mode:'month', month:'2024-01'}).totals.sales);
  assert.equal(getMonthlyReportSales(state, '2024-01'), 13_200);
});
