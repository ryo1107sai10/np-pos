import assert from 'node:assert/strict';
import test from 'node:test';
import { getCashMovements, getDailyRecoveryRows, isValidCashMovement } from '../docs/cash-ledger.mjs';
import { buildCashMovementCsv, getCashReport } from '../docs/cash-report.mjs';
import { apply, createDemo, quote, summary, yen } from '../docs/engine.mjs';
import { renderCashReportPrint, renderReport } from '../docs/reports.mjs';

const today = '2026-11-16';
const tomorrow = '2026-11-17';
const at = Date.parse(`${today}T21:00:00+09:00`);
const owner = { id: 'owner', label: '店舗管理者', role: 'admin' };
const manager = { id: 'manager', label: 'マネージャー', role: 'manager' };
const staff = { id: 'staff', label: 'スタッフ', role: 'staff' };
const step = (state, command, actor = owner, time = at) => apply(state, command, time, actor);
const record = { type:'recordCashMovement', kind:'deposit', category:'float', amount:5_000, reason:'  釣銭を補充  ' };
const open = (openingCash = 20_000) => step(createDemo('closed', at), { type:'open', date:today, openingCash });

test('cash journal appends business-date entries with the authenticated operator and validates bad writes atomically', () => {
  const state = open();
  assert.equal(state.cashMovements, undefined);
  assert.throws(() => step(createDemo('closed', at), record), /営業中/);
  assert.throws(() => step(state, record, staff), /権限/);

  for (const [fields, error] of [
    [{kind:'__proto__'}, /種類/],
    [{category:'purchase'}, /理由区分/],
    [{amount:'5000'}, /円単位/],
    [{amount:0}, /円単位/],
    [{amount:0.5}, /円単位/],
    [{amount:100_000_001}, /円単位/],
    [{reason:'  '}, /入出金の理由/],
    [{reason:{value:'補充'}}, /入出金の理由/],
    [{reason:'あ'.repeat(121)}, /入出金の理由/],
    [{destination:'あ'.repeat(81)}, /移動先/],
  ]) assert.throws(() => step(state, {...record, ...fields}, manager), error);

  const next = step(state, {...record, date:tomorrow, at:0, actor:owner, destination:'  金庫  '}, manager);
  const [entry] = getCashMovements(next, today);
  assert.equal(entry.date, today);
  assert.equal(entry.at, at);
  assert.equal(entry.destination, '金庫');
  assert.equal(entry.reason, '釣銭を補充');
  assert.deepEqual(entry.actor, manager);
  assert.ok(isValidCashMovement(entry));
  assert.ok(!isValidCashMovement({...entry, date:'2026-02-30'}));
  assert.deepEqual(getCashMovements(next, tomorrow), []);
  assert.equal(state.cashMovements, undefined);
  assert.deepEqual(next.stock, state.stock);
  assert.equal(summary(next).sales, 0);
  assert.equal(summary(next).expectedCash, 25_000);
});

test('cash reconciliation counts advances and only cash recoveries without changing sales, and freezes the day', () => {
  let state = open();
  state = step(state, record, manager);
  state = step(state, {...record,kind:'withdrawal',category:'safe',amount:2_000,reason:'金庫へ移動'});
  state = step(state, {...record,kind:'expense',category:'purchase',amount:1_200,reason:'仕入れを現金で精算'});
  state = step(state, { type:'saveCustomer', customer:{name:'来店サンプル', creditEnabled:true, creditLimit:10_000} });
  state = step(state, { type:'seat', tableIds:['a1'], guests:2, setId:'set60', customerId:state.customers[0].id });
  const [{id:ticketId}] = state.tickets;
  state = step(state, {type:'deposit',ticketId,method:'card',amount:3_000});
  assert.deepEqual(summary(state).depositsReceived, {cash:0,card:3_000,qr:0});
  assert.equal(summary(state).depositsApplied, 0);
  assert.equal(quote(state,ticketId).remaining, 10_200);
  state = step(state, {type:'settle',ticketId,creditDueDate:tomorrow,payments:[{method:'cash',amount:2_200},
    {method:'receivable',amount:8_000}]});
  state = step(state, {type:'depart',ticketId});
  const [{ id:receivableId }] = state.receivables;
  for (const [method,amount] of [['cash',4_000],['bank',1_000],['card',500]]) {
    state = step(state, {type:'recoverReceivable',receivableId,amount,method,date:today}, owner, at + 60_000);
  }
  const totals = summary(state);
  assert.equal(totals.sales, 13_200);
  assert.equal(totals.receivableSales, 8_000);
  assert.equal(totals.expectedCash, 28_000);
  assert.deepEqual(totals.payments, {cash:2_200,card:3_000,qr:0});
  assert.deepEqual(totals.tenderPayments, {cash:2_200,card:0,qr:0});
  assert.deepEqual(totals.depositsReceived, {cash:0,card:3_000,qr:0});
  assert.equal(totals.depositsApplied, 3_000);
  assert.deepEqual(totals.recoveries, {cash:4_000,card:500,bank:1_000});
  assert.equal(totals.cashIn, 5_000);
  assert.equal(totals.cashOut, 3_200);
  assert.equal(totals.expenses, 1_200);
  assert.equal(totals.recoveryRows.length, 3);
  assert.deepEqual(Object.keys(totals.recoveryRows[0]), ['id','date','at','amount','method']);
  assert.deepEqual(getDailyRecoveryRows(state, today), totals.recoveryRows);
  assert.throws(() => step(state, {type:'close',actualCash:27_950,reason:'   '}), /差額の理由/);
  assert.throws(() => step(state, {type:'close',actualCash:27_950,reason:{}}), /差額の理由/);

  const closed = step(state, {type:'close',actualCash:27_950,reason:'  現金の実査差額  '});
  const [frozen] = closed.closedDays;
  assert.equal(frozen.expectedCash, 28_000);
  assert.equal(frozen.actualCash, 27_950);
  assert.equal(frozen.discrepancy, -50);
  assert.equal(frozen.reason, '現金の実査差額');
  assert.deepEqual(frozen.cashMovements, totals.cashMovements);
  assert.deepEqual(frozen.recoveryRows, totals.recoveryRows);
  assert.deepEqual(frozen.tenderPayments, totals.tenderPayments);
  assert.equal(frozen.depositsApplied, totals.depositsApplied);
  assert.throws(() => step(closed, record, manager), /営業中/);

  const nextDay = step(closed, {type:'open',date:tomorrow,openingCash:10_000});
  const later = step(nextDay, record, manager, at + 86_400_000);
  assert.equal(summary(later).expectedCash, 15_000);
  assert.equal(summary(later).cashMovements.length, 1);
  assert.equal(summary(later).recoveryRows.length, 0);
  assert.deepEqual(later.closedDays[0], frozen);
  assert.equal(later.cashMovements.length, 4);
});

test('a negative theoretical balance records the discrepancy against the non-negative physical count', () => {
  const opened = open(100);
  const withdrawn = step(opened, {...record,kind:'withdrawal',category:'safe',amount:150,reason:'金庫へ移動'});
  assert.equal(summary(withdrawn).expectedCash, -50);
  assert.throws(() => step(withdrawn, {type:'close',actualCash:-50}), /実残高/);
  const closed = step(withdrawn, {type:'close',actualCash:0,reason:'途中に釣銭補充があったため'});
  assert.equal(closed.closedDays[0].expectedCash, -50);
  assert.equal(closed.closedDays[0].discrepancy, 50);
});

test('cancelling an advance updates the drawer without affecting settled revenue or manual cash movements', () => {
  let state = step(open(), record);
  state = step(state, {type:'seat',tableIds:['a1'],guests:1,setId:'set60'});
  const [{id:ticketId}] = state.tickets;
  state = step(state, {type:'deposit',ticketId,method:'cash',amount:1_000});
  assert.equal(summary(state).expectedCash, 26_000);
  const [{id:depositId}] = state.tickets[0].deposits;
  state = step(state, {type:'cancelDeposit',ticketId,depositId});
  const totals = summary(state);
  assert.equal(totals.expectedCash, 25_000);
  assert.equal(totals.sales, 0);
  assert.equal(totals.cashMovements.length, 1);
  assert.deepEqual(totals.depositsReceived, {cash:0,card:0,qr:0});
});

test('cash period detail uses business days, keeps voided rows out of totals, and shares screen, CSV and print data', () => {
  const afterMidnight = Date.parse('2026-11-17T00:09:00+09:00');
  let state = step(open(),record,manager);
  state = step(state,{type:'recordCashMovement',kind:'expense',category:'purchase',amount:800,
    reason:'備品を現金で購入',destination:'仕入店'},manager,afterMidnight);
  const {id:movementId} = state.cashMovements[1];
  state = step(state,{type:'voidCashMovement',movementId,correctionReason:'誤入力'},owner,afterMidnight + 60_000);
  state = step(state,{type:'close',actualCash:25_000},manager,afterMidnight + 120_000);
  state = step(state,{type:'open',date:tomorrow,openingCash:10_000},owner,at + 86_400_000);
  state = step(state,{type:'recordCashMovement',kind:'withdrawal',category:'bank',amount:1_000,reason:'銀行へ移動'},owner,at + 86_400_000);

  const filters = {mode:'range',start:today,end:tomorrow};
  const report = getCashReport(state,filters);
  const {period,ledger} = report;
  assert.equal(period.totals.cashIn,5_000);
  assert.equal(period.totals.cashOut,1_000);
  assert.equal(period.totals.expenses,0);
  assert.equal(period.days[0].closed.actualCash,25_000);
  assert.deepEqual(ledger.map(({date,postedAmount,voided}) => [date,postedAmount,voided]),[[tomorrow,-1000,false],[today,0,true],[today,5000,false]]);
  assert.equal(ledger[1].timestamp,'2026-11-17 00:09:00');
  const csv = buildCashMovementCsv(report,'テスト店');
  assert.match(csv,/2026-11-16,テスト店,2026-11-17 00:09:00,経費,仕入れ,-800,0,取消済み,備品を現金で購入,仕入店,マネージャー,,2026-11-17 00:10:00,誤入力/);
  const api = {escape:String,icon:() => '',yen,storeName:'テスト店',cashReportInterval:filters};
  const view = renderReport('cash',state,api);
  assert.match(view,/任意期間|営業日別の入出金・レジ照合/);
  assert.match(view,/2026-11-16の入出金を表示/);
  assert.match(view,/取消済み ／ 誤入力/);
  assert.doesNotMatch(view,/data-action="record-cash"/);
  const day = renderReport('cash',state,{...api,cashReportInterval:{mode:'day'}});
  assert.match(day,/data-action="record-cash"/);
  assert.doesNotMatch(day,/備品を現金で購入/);
  const print = renderCashReportPrint(report,api);
  assert.match(print,/入出金明細[\s\S]*テスト店[\s\S]*営業日別の入出金・レジ照合[\s\S]*備品を現金で購入/);
  assert.doesNotMatch(print,/data-action|<button/);
  const invalid = renderReport('cash',state,{...api,cashReportInterval:{...filters,start:tomorrow,end:today}});
  assert.match(invalid,/開始日と終了日/);
  assert.match(invalid,/data-id="csv" disabled/);
  assert.equal(getCashReport(state,{mode:'month',month:'2026-11'}).ledger.length,3);
});
