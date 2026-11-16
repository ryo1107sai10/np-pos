import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { findPrintableTicket, getPrintDocuments, getPrintSettings, getPrintTenderReceived,
  isValidPrintDocument } from '../docs/print-domain.mjs';

const date = '2026-11-16';
const now = Date.parse('2026-11-16T22:00+09:00');
const admin = { id: 'owner', label: '店舗管理者', role: 'admin' };
const manager = { id: 'manager', label: 'マネージャー', role: 'manager' };
const staff = { id: 'staff', label: 'スタッフ', role: 'staff' };
const cast = { id: 'cast', label: 'キャスト', role: 'cast' };
const step = (state, action, actor = admin) => apply(state, action, now, actor);

function operatingState(withCustomer) {
  let state = step(createDemo('closed', now), { type:'open', date, openingCash:20_000 });
  if (withCustomer) state = step(state, { type:'saveCustomer', customer:{name:'検証顧客', creditEnabled:true, creditLimit:50_000} });
  return step(state, { type:'seat', tableIds:['a1'], guests:2, setId:'set60', customerId:state.customers?.[0]?.id });
}

function print(state, kind, actor = admin, fields = {}, day = date) {
  return step(state, { type:'issuePrintDocument', ticketId:state.tickets[0]?.id ?? state.closedDays[0].ticketSnapshots[0].id,
    date:day, kind, ...fields }, actor);
}

function payCash(state) {
  const ticketId = state.tickets[0].id;
  return step(state, { type:'settle', ticketId, payments:[{method:'cash',amount:quote(state,ticketId).remaining}] }, staff);
}

test('print settings default on legacy states and allow only an owner to save normalized issuer details', () => {
  const state = createDemo('closed', now);
  assert.deepEqual(getPrintSettings(state),{width:58, storeName:'', address:'', phone:'', registrationNumber:'',
    showItems:true, autoReceipt:false});
  const settings = { width:80, storeName:' NP POS 銀座 ', address:'中央区', phone:'03-1234-5678', registrationNumber:'T1234567890000',
    showItems:false, autoReceipt:true };
  assert.throws(() => step(state,{type:'savePrintSettings',settings},manager), /店舗管理者/);
  assert.throws(() => step(state,{type:'savePrintSettings',settings:{...settings,width:57}}), /用紙幅/);
  assert.throws(() => step(state,{type:'savePrintSettings',settings:{...settings,showItems:'false'}}), /明細表示/);
  const changed = step(state,{type:'savePrintSettings',settings});
  assert.deepEqual(getPrintSettings(changed),{...settings,storeName:'NP POS 銀座'});
  assert.equal(state.printSettings,undefined);
});

test('confirmation and receipts keep separate counters without changing stock, sales or settlement amounts', () => {
  let state = operatingState();
  const ticketId = state.tickets[0].id;
  assert.throws(() => print(state,'receipt'), /会計確定済み/);
  assert.throws(() => print(state,'check',cast), /権限/);
  const before = summary(state);
  state = print(state,'check',staff);
  state = print(state,'check',manager);
  assert.deepEqual(summary(state),before);
  assert.deepEqual(getPrintDocuments(state,state.tickets[0],date,'check').map(({number}) => number),[1,2]);
  state = payCash(state);
  const settled = quote(state,ticketId);
  assert.throws(() => print(state,'check'), /未会計/);
  state = print(state,'receipt',staff);
  state = print(state,'receipt',staff);
  const receipts = getPrintDocuments(state,state.tickets[0],date,'receipt');
  assert.deepEqual(receipts.map(({number}) => number),[1,2]);
  assert.equal(receipts[0].actor.id,staff.id);
  assert.ok(state.printDocuments.every(isValidPrintDocument));
  assert.deepEqual(quote(state,ticketId),settled);
});

test('reissued named receipts remember the latest recipient and purpose and exclude outstanding sales credit', () => {
  let state = operatingState(true);
  const ticketId = state.tickets[0].id;
  state = step(state,{type:'deposit',ticketId,method:'cash',amount:1_000});
  state = step(state,{type:'settle',ticketId,creditDueDate:date,payments:[
    {method:'card',amount:2_200},{method:'receivable',amount:10_000},
  ]});
  assert.equal(getPrintTenderReceived(state.tickets[0]),3_200);
  assert.throws(() => print(state,'invoice'), /宛名/);
  assert.throws(() => print(state,'invoice',staff,{recipient:' 株式会社テスト ',purpose:' '}), /但し書き/);
  state = print(state,'invoice',staff,{recipient:' 株式会社テスト ',purpose:' ご飲食代として '});
  state = print(state,'invoice',staff,{recipient:'合同会社テスト',purpose:'飲食代'});
  assert.throws(() => print(state,'invoice',manager), /宛名/);
  state = print(state,'invoice',staff);
  const invoices = getPrintDocuments(state,state.tickets[0],date,'invoice');
  assert.deepEqual(invoices.map(({number,recipient,purpose}) => [number,recipient,purpose]),[
    [1,'株式会社テスト','ご飲食代として'],[2,'合同会社テスト','飲食代'],[3,'合同会社テスト','飲食代'],
  ]);
  let allCredit = operatingState(true);
  const creditId = allCredit.tickets[0].id;
  allCredit = step(allCredit,{type:'settle',ticketId:creditId,creditDueDate:date,
    payments:[{method:'receivable',amount:quote(allCredit,creditId).remaining}]});
  assert.throws(() => print(allCredit,'invoice',admin,{recipient:'確認先',purpose:'飲食代'}), /受領した金額/);
  assert.doesNotThrow(() => print(allCredit,'receipt'));
});

test('cancellation and reopening create a fresh numbering sequence, including an identical settlement time', () => {
  let state = operatingState();
  const ticketId = state.tickets[0].id;
  state = print(state,'check');
  state = print(payCash(state),'receipt');
  state = step(state,{type:'cancelSettlement',ticketId,reason:'会計訂正'});
  assert.throws(() => print(state,'receipt'), /会計確定済み/);
  state = step(state,{type:'reopenTicket',ticketId,reason:'会計を修正',tableIds:['a1']});
  state = print(state,'check');
  assert.equal(state.printDocuments.at(-1).number,1);
  state = print(payCash(state),'receipt');
  assert.equal(state.printDocuments.at(-1).number,1);
  assert.notEqual(state.printDocuments[1].version,state.printDocuments[3].version);
  assert.equal(state.printDocuments[1].at,state.printDocuments[3].at);
});

test('past and legacy receipts retain their issue number for authorized archival reprints', () => {
  let state = payCash(operatingState());
  const ticketId = state.tickets[0].id;
  delete state.tickets[0].settlementRevision;
  state = print(state,'receipt');
  assert.match(state.printDocuments[0].version,/^legacy:/);
  state = step(state,{type:'depart',ticketId});
  state = step(state,{type:'close',actualCash:summary(state).expectedCash});
  state = step(state,{type:'open',date:'2026-11-17',openingCash:5_000});
  const past = findPrintableTicket(state,ticketId,date);
  assert.equal(past.status,'departed');
  assert.equal(getPrintDocuments(state,past,date,'receipt')[0].number,1);
  assert.throws(() => print(state,'receipt',staff), /過去の営業日/);
  assert.throws(() => print(state,'receipt',manager,{date:'2026-11-31'}), /伝票が見つかりません/);
  assert.throws(() => print(state,'receipt',manager,{date:'2026-11-17'}), /伝票が見つかりません/);
  state = print(state,'receipt',manager);
  assert.equal(state.printDocuments.at(-1).number,2);
  assert.equal(state.printDocuments.at(-1).version,state.printDocuments[0].version);
});
