import assert from 'node:assert/strict';
import test from 'node:test';
import {apply, createDemo, quote, summary} from '../docs/engine.mjs';
import {getPrintTenderReceived} from '../docs/print-domain.mjs';
import {renderPrintPreview} from '../docs/print-ui.mjs';
import {getReportDay} from '../docs/report-period.mjs';
import {renderReport} from '../docs/reports.mjs';
import {validateSnapshot, verifyCommand} from '../server/policy.mjs';

const date = '2026-11-16';
const at = Date.parse(`${date}T21:00:00+09:00`);
const owner = {id:'owner',label:'店舗管理者',role:'admin'};
const manager = {id:'manager',label:'マネージャー',role:'manager'};
const step = (state, command, actor = owner) => apply(state,command,at,actor);
const open = () => step(createDemo('closed',at),{type:'open',date,openingCash:20_000});
const api = {yen:(amount) => `¥${amount.toLocaleString('ja-JP')}`,escape:String,icon:() => '', quote, summary};

test('cash tender records change against only the cash share after deposits and card fees', () => {
  let state = step(open(),{type:'seat',setId:'set60',tableIds:['a1'],guests:2});
  const [{id:ticketId}] = state.tickets;
  state = step(state,{type:'deposit',ticketId,method:'cash',amount:1_000});
  state = step(state,{type:'saveCardFeeSettings',settings:{enabled:true,rateBps:500}});
  const before = quote(state,ticketId);
  const settle = {type:'settle',ticketId,payments:[{method:'cash',amount:2_000},
    {method:'cash',amount:3_000},{method:'card',amount:before.remaining - 5_000}],expectedCardFee:360};

  assert.throws(() => step(state,{...settle,cashReceived:4_999}),/下回っています/);
  for (const cashReceived of [0,-1,10.25,'10000',100_000_001]) {
    assert.throws(() => step(state,{...settle,cashReceived}),/預かり額/);
    assert.throws(() => verifyCommand('staff',{...settle,cashReceived}),{code:'invalid-command'});
  }
  assert.throws(() => step(state,{...settle,payments:[{method:'card',amount:before.remaining}],cashReceived:10_000}),
    /現金でお支払いいただく場合のみ/);
  assert.equal(state.tickets[0].status,'open');
  assert.doesNotThrow(() => verifyCommand('staff',{...settle,cashReceived:10_000}));
  assert.equal(step(state,settle).tickets[0].cashTender,undefined);
  assert.deepEqual(step(state,{...settle,cashReceived:5_000}).tickets[0].cashTender,{received:5_000,change:0});

  const paid = step(state,{...settle,cashReceived:10_000});
  const [ticket] = paid.tickets;
  assert.deepEqual(ticket.cashTender,{received:10_000,change:5_000});
  assert.equal(quote(paid,ticketId).total,13_560);
  assert.equal(summary(paid).expectedCash,26_000);
  assert.equal(summary(paid).payments.cash,6_000);
  assert.equal(summary(paid).tenderPayments.cash,5_000);
  assert.equal(getPrintTenderReceived(ticket),13_560);
  assert.deepEqual(validateSnapshot(paid).tickets[0].cashTender,ticket.cashTender);
  const tampered = structuredClone(paid);
  tampered.tickets[0].cashTender.change += 1;
  assert.throws(() => validateSnapshot(tampered),{code:'invalid-snapshot'});
  assert.deepEqual(paid.auditLog.find(({action}) => action === 'settle').after.cashTender,ticket.cashTender);
  const receipt = renderPrintPreview({ticket,totals:quote(paid,ticketId),kind:'receipt',settings:{}},api);
  assert.match(receipt,/現金お預かり<\/dt><dd>¥10,000/);
  assert.match(receipt,/お釣り<\/dt><dd>¥5,000/);

  const cardAmount = ticket.payments.find(({method}) => method === 'card').amount;
  const qr = step(paid,{type:'correctSettledTicketPayments',ticketId,reason:'カードをQRに変更',
    payments:[{method:'cash',amount:5_000},{method:'qr',amount:cardAmount}]});
  assert.deepEqual(qr.tickets[0].cashTender,ticket.cashTender);
  const cancelled = step(qr,{type:'cancelSettlement',ticketId,reason:'会計をやり直す'});
  assert.equal(cancelled.tickets[0].cashTender,undefined);
  assert.deepEqual(cancelled.cancelledSettlements[0].receipt.cashTender,ticket.cashTender);
  assert.equal(step(cancelled,{type:'reopenTicket',ticketId,tableIds:['a1'],reason:'再会計'}).tickets[0].cashTender,undefined);

  const departed = step(paid,{type:'depart',ticketId});
  const closed = step(departed,{type:'close',actualCash:26_000});
  const corrected = step(closed,{type:'correctSettledTicketPayments',ticketId,reason:'現金をQRに訂正',
    payments:[{method:'qr',amount:5_000},{method:'card',amount:cardAmount}]});
  assert.equal(corrected.closedDays[0].ticketSnapshots[0].cashTender,undefined);
  assert.equal(corrected.tickets[0].cashTender,undefined);
  assert.equal(corrected.closedDays[0].expectedCash,21_000);
  const audit = corrected.auditLog.find(({action}) => action === 'correctSettledTicketPayments');
  assert.deepEqual(audit.before.cashTender,ticket.cashTender);
  assert.equal(audit.after.cashTender,undefined);
});

test('cash counts are validated and kept with the closed report, including zero cash', () => {
  const state = open();
  const cashDenominations = {10000:1,5000:1,2000:2,500:1,100:4,50:2};
  const command = {type:'close',actualCash:20_000,cashDenominations};
  assert.throws(() => verifyCommand('staff',command),{code:'forbidden'});
  assert.doesNotThrow(() => verifyCommand('manager',command));
  for (const fields of [
    {actualCash:19_999},
    {cashDenominations:{...cashDenominations,20:1}},
    {cashDenominations:{10000:1.5,5000:1}},
    {cashDenominations:{10000:3,5000:-2}},
    {cashDenominations:{10000:'2'}},
    {cashDenominations:null},
  ]) {
    assert.throws(() => step(state,{...command,...fields},manager),/金種別/);
    assert.throws(() => verifyCommand('manager',{...command,...fields}),{code:'invalid-command'});
  }
  const closed = step(state,command,manager);
  const report = getReportDay(closed,date).closed;
  assert.deepEqual(report.cashDenominations,cashDenominations);
  assert.equal(report.discrepancy,0);
  assert.deepEqual(closed.auditLog.find(({action}) => action === 'close').after.cashDenominations,cashDenominations);
  assert.deepEqual(validateSnapshot(closed).closedDays[0].cashDenominations,cashDenominations);
  assert.match(renderReport('reports',closed,api),/金種別の内訳<\/summary>[\s\S]*¥2,000<\/dt><dd>2枚/);
  const nextDay = step(closed,{type:'open',date:'2026-11-17',openingCash:0});
  const zero = step(nextDay,{type:'close',actualCash:0,cashDenominations:{}},manager);
  assert.deepEqual(zero.closedDays[0].cashDenominations,{});
  const tampered = structuredClone(zero);
  tampered.closedDays[0].cashDenominations[1] = 1;
  assert.throws(() => validateSnapshot(tampered),{code:'invalid-snapshot'});
});
