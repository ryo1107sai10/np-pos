import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAnalytics } from '../docs/analytics.mjs';
import { buildCashMovementCsv, getCashReport } from '../docs/cash-report.mjs';
import { renderCustomerDetail, renderCustomerForm, renderCustomers } from '../docs/customer-ui.mjs';
import { apply, createDemo, quote, summary, yen } from '../docs/engine.mjs';
import { renderAuditLog } from '../docs/operations-ui.mjs';
import { paymentCorrectionModel, readPaymentCorrection, renderPaymentCorrection } from '../docs/payment-correction-ui.mjs';
import { getPrintSettings } from '../docs/print-domain.mjs';
import { renderPrintPreview } from '../docs/print-ui.mjs';
import { renderCashReportPrint, renderReport } from '../docs/reports.mjs';
import { buildTicketHistoryCsv, getTicketHistory, renderTicketHistory } from '../docs/ticket-history.mjs';

const date = '2026-11-16';
const now = Date.parse(`${date}T22:00:00+09:00`);
const api = { escape:String, icon:() => '', quote, summary, yen, role:'admin' };
const hiddenText = /売掛|与信|回収|receivable|creditEnabled|creditLimit|creditOverride/i;
const run = (state, command) => apply(state, command, now);

function existingAccount() {
  let state = run(createDemo('closed', now), { type:'open', date, openingCash:10_000 });
  state = run(state, { type:'saveCustomer', customer:{ name:'既存のお客様', creditEnabled:true, creditLimit:5_000 } });
  const customerId = state.customers[0].id;
  state = run(state, { type:'seat', tableIds:['a1'], guests:2, setId:'set60', customerId });
  const {id:ticketId} = state.tickets[0];
  state = run(state, { type:'settle', ticketId, payments:[{ method:'cash', amount:3_200 }, { method:'receivable', amount:10_000 }],
    creditDueDate:date, creditOverrideReason:'与信上限の変更理由' });
  state = run(state, { type:'recoverReceivable', receivableId:state.receivables[0].id, amount:4_000, method:'cash', date });
  return {state, customerId, ticketId};
}

test('archived credit is omitted from presentation and remains accounted for in sales and the register', () => {
  const {state, customerId, ticketId} = existingAccount();
  const before = structuredClone(state);
  const [ticket] = state.tickets;
  const totals = quote(state, ticketId);
  const print = { ticket, totals, date, settings:getPrintSettings(state), recipient:'お客様', purpose:'ご飲食代として' };
  const invoice = renderPrintPreview({...print, kind:'invoice'}, api);
  assert.match(invoice, /領収金額[\s\S]*¥3,200/);
  const receipt = renderPrintPreview({...print, kind:'receipt'}, api);
  assert.match(receipt, /会計合計（税込）[\s\S]*¥13,200/);
  const cash = renderReport('cash', state, api);
  assert.match(cash, /理論残高[\s\S]*¥17,200/);
  assert.match(cash, /その他の入金[\s\S]*¥4,000/);

  const dateRange = {start:date, end:date};
  const cashReport = getCashReport(state,{mode:'range',...dateRange});
  const audit = renderAuditLog({ entries:state.auditLog }, api);
  assert.match(audit, /会計確定/);
  const screens = [
    invoice, receipt, cash, audit, renderReport('reports', state, api), renderCashReportPrint(cashReport,{...api,storeName:'テスト店'}),
    buildCashMovementCsv(cashReport,'テスト店'),
    renderCustomers(state, api), renderCustomerDetail(state, customerId, api), renderCustomerForm(state, customerId, api),
    renderAnalytics('analytics', state, {...api, range:dateRange}), renderTicketHistory(state, api),
    buildTicketHistoryCsv(getTicketHistory(state, dateRange, api)),
  ];
  for (const screen of screens) assert.doesNotMatch(screen, hiddenText);
  assert.deepEqual(state, before);
});

test('payment correction changes the visible tender without modifying the preserved balance or recovery dates', () => {
  const {state, ticketId} = existingAccount();
  const model = paymentCorrectionModel(state.tickets[0]);
  assert.equal(model.total, 3_200);
  assert.doesNotMatch(renderPaymentCorrection(model, api), hiddenText);
  const inputs = { 'correction-cash':0, 'correction-card':3_200, 'correction-qr':0 };
  const form = { elements:{ namedItem:(key) => ({valueAsNumber:inputs[key], validity:{valid:key in inputs}}) } };
  const {payments, changed, difference} = readPaymentCorrection(form, model);
  assert.equal(difference, 0);
  assert.equal(changed, true);
  assert.deepEqual(payments, [{method:'card', amount:3_200}, {method:'receivable', amount:10_000}]);
  const corrected = run(state, { type:'correctSettledTicketPayments', ticketId, payments, reason:'カード控えを確認' });
  assert.deepEqual(corrected.receivables, state.receivables);
  assert.equal(summary(corrected).expectedCash, 14_000);
  assert.equal(summary(corrected).sales, summary(state).sales);
});
