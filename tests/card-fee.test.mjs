import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { addCardFeeTax, getCardFee, getCardFeeSettings } from '../docs/card-fee.mjs';
import { buildFreeeCsv } from '../docs/freee-export.mjs';
import { getReportPeriod } from '../docs/report-period.mjs';
import { getPrintTenderReceived } from '../docs/print-domain.mjs';
import { validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-16';
const time = Date.parse(`${date}T20:00:00+09:00`);
const admin = {id:'owner',label:'販売店管理者',role:'admin'};
const manager = {id:'manager',label:'担当者',role:'manager'};

function run(state, action, actor = admin) {
  return apply(state,action,time,actor);
}

function openWithTicket(customer = false) {
  let state = run(createDemo('closed',time),{type:'open',date,openingCash:20_000});
  if (customer) {
    state = run(state,{type:'saveCustomer',customer:{name:'検証客',creditEnabled:true,creditLimit:20_000}});
  }
  return run(state,{type:'seat',tableIds:['a1'],guests:2,setId:'set60',customerId:state.customers?.[0]?.id});
}

test('card fee is disabled for legacy stores and settings are validated and restricted to store administrators', () => {
  const state = openWithTicket();
  const ticketId = state.tickets[0].id;
  assert.deepEqual(getCardFeeSettings(state),{enabled:false,rateBps:0});
  for (const settings of [{enabled:true,rateBps:10_001},{enabled:true,rateBps:50.5},{enabled:'yes',rateBps:100}]) {
    assert.throws(() => run(state,{type:'saveCardFeeSettings',settings}),/0〜100%/u);
  }
  assert.throws(() => run(state,{type:'saveCardFeeSettings',settings:{enabled:true,rateBps:100}},manager),/店舗管理者/u);
  const before = quote(state,ticketId);
  const settled = run(state,{type:'settle',ticketId,payments:[{method:'card',amount:before.total}]});
  assert.equal(quote(settled,ticketId).total,before.total);
  assert.equal(quote(settled,ticketId).cardFee,undefined);
});

test('split checkout applies once-rounded fee only to the card portion and posts the actual amounts to reports and export', () => {
  let state = openWithTicket(true);
  const ticketId = state.tickets[0].id;
  state = run(state,{type:'order',ticketId,items:[{menuId:'castDrink',quantity:1,castIds:['cast1']}]});
  state = run(state,{type:'saveCardFeeSettings',settings:{enabled:true,rateBps:275}});
  state = run(state,{type:'deposit',ticketId,method:'card',amount:1_000});
  const before = quote(state,ticketId);
  const payments = [{method:'card',amount:3_333},{method:'card',amount:1_667},
    {method:'receivable',amount:3_000},{method:'qr',amount:599},{method:'cash',amount:before.remaining - 8_599}];
  assert.equal(getCardFee(state,payments),138);
  assert.equal(getCardFee(state,[{method:'card',amount:NaN},{method:'card',amount:1.25},{method:'cash',amount:50_000}]),0);
  const next = run(state,{type:'settle',ticketId,payments,expectedCardFee:138,creditDueDate:'2026-11-30'});
  const ticket = next.tickets[0];
  const result = quote(next,ticketId);
  assert.equal(result.remaining,0);
  assert.equal(result.baseTotal,before.total);
  assert.equal(result.total,before.total + 138);
  assert.equal(result.cardFee,138);
  assert.equal(result.cardFeeRateBps,275);
  assert.equal(result.receivable,3_000);
  assert.deepEqual(result.commission,before.commission);
  assert.deepEqual(next.stock,state.stock);
  assert.deepEqual(ticket.payments.filter(({method}) => method === 'card')
    .map(({baseAmount,cardFee,amount}) => [baseAmount,cardFee,amount]),[[3_333,92,3_425],[1_667,46,1_713]]);
  assert.deepEqual(ticket.payments.filter(({method}) => method !== 'card').map(({amount}) => amount),payments.slice(2).map(({amount}) => amount));
  assert.equal(summary(next).payments.card,6_138);
  assert.equal(summary(next).expectedCash,20_000 + payments.at(-1).amount);
  assert.equal(getPrintTenderReceived(ticket),result.total - 3_000);
  assert.equal(result.taxBreakdown.reduce((gross,{base,tax}) => gross + base + tax,0),result.total);
  assert.equal(buildFreeeCsv(getReportPeriod(next,{mode:'day'}),{mode:'tickets'}).salesTotal,result.total);
});

test('the operator must confirm the card fee, with legacy commands allowed when the fee is zero', () => {
  let state = openWithTicket();
  const ticketId = state.tickets[0].id;
  state = run(state,{type:'saveCardFeeSettings',settings:{enabled:true,rateBps:5_000}});
  const remaining = quote(state,ticketId).remaining;
  const payments = [{method:'card',amount:1},{method:'card',amount:1},{method:'cash',amount:remaining - 2}];
  assert.equal(getCardFee(state,payments),1);
  const command = {type:'settle',ticketId,payments};
  assert.throws(() => run(state,command),/会計画面を開き直して/u);
  assert.throws(() => run(state,{...command,expectedCardFee:2}),/会計画面を開き直して/u);
  assert.equal(state.tickets[0].payments.length,0);
  const paid = run(state,{...command,expectedCardFee:1});
  assert.deepEqual(paid.tickets[0].payments.slice(0,2).map(({amount}) => amount),[2,1]);
  const disabled = run(state,{type:'saveCardFeeSettings',settings:{enabled:false,rateBps:5_000}});
  assert.throws(() => run(disabled,{...command,expectedCardFee:1}),/会計画面を開き直して/u);
  assert.doesNotThrow(() => run(disabled,command));
});

test('included standard-rate tax rounds once on the full standard-rate amount', () => {
  const amounts = [{rate:1000,base:109,tax:10},{rate:800,base:110,tax:8},{rate:0,base:70,tax:0}];
  const {breakdown,feeTax} = addCardFeeTax(amounts,2);
  assert.deepEqual(breakdown,[{rate:1000,base:110,tax:11},...amounts.slice(1)]);
  assert.equal(feeTax,1);
  assert.deepEqual(addCardFeeTax(amounts.slice(1),11).breakdown[0],{rate:1000,base:10,tax:1});
});

test('settings changes and reversal preserve the old fee while a reopened checkout uses the currently enabled rate', () => {
  let state = openWithTicket();
  const ticketId = state.tickets[0].id;
  const base = quote(state,ticketId).total;
  state = run(state,{type:'saveCardFeeSettings',settings:{enabled:true,rateBps:1_000}});
  state = run(state,{type:'settle',ticketId,payments:[{method:'card',amount:base}],expectedCardFee:1_320});
  state = run(state,{type:'saveCardFeeSettings',settings:{enabled:false,rateBps:1_000}});
  assert.equal(quote(state,ticketId).cardFee,1_320);
  assert.equal(summary(state).sales,14_520);
  state = run(state,{type:'cancelSettlement',ticketId,reason:'決済取消'});
  assert.equal(state.cancelledSettlements[0].receipt.settlement.cardFee,1_320);
  assert.equal(summary(state).sales,0);
  state = run(state,{type:'reopenTicket',ticketId,tableIds:['a1'],reason:'会計修正'});
  assert.equal(quote(state,ticketId).total,base);
  state = run(state,{type:'settle',ticketId,payments:[{method:'card',amount:base}],expectedCardFee:0});
  assert.equal(quote(state,ticketId).cardFee,undefined);
  assert.equal(summary(state).sales,base);
});

test('brand rates override the default, QR and card fees round independently, and frozen brand names survive renaming', () => {
  let state = openWithTicket();
  const ticketId = state.tickets[0].id;
  const settings = {enabled:true,rateBps:500,brands:[
    {id:'silver',name:'シルバーカード',method:'card',rateBps:125},
    {id:'phone',name:'スマホ決済',method:'qr',rateBps:300},
  ]};
  state = run(state,{type:'saveCardFeeSettings',settings});
  const paid = [
    {method:'card',amount:30,brandId:'silver'},
    {method:'card',amount:20,brandId:'silver'},
    {method:'card',amount:120},
    {method:'qr',amount:200,brandId:'phone'},
    {method:'cash',amount:quote(state,ticketId).total - 370},
  ];
  assert.equal(getCardFee(state,paid),13);
  assert.throws(() => run(state,{type:'settle',ticketId,payments:paid,expectedCardFee:12}),/決済加算額/);
  const mismatchedBrand = [{...paid[0],brandId:'phone'},...paid.slice(1)];
  assert.throws(() => run(state,{type:'settle',ticketId,payments:mismatchedBrand,expectedCardFee:13}),/決済ブランド/);
  state = run(state,{type:'settle',ticketId,payments:paid,expectedCardFee:13});
  assert.equal(quote(state,ticketId).brandedFee,true);
  assert.equal(quote(state,ticketId).total,13_213);
  assert.deepEqual(state.tickets[0].payments.map(({amount})=>amount),[31,20,126,206,12_830]);
  assert.equal(summary(state).payments.qr,206);
  assert.equal(summary(state).payments.card,177);
  assert.equal(summary(state).expectedCash,32_830);
  assert.equal(buildFreeeCsv(getReportPeriod(state,{mode:'day'}),{mode:'tickets'}).salesTotal,13_213);
  const audit = state.auditLog.find(({action})=>action === 'settle').after.payments;
  assert.equal(audit[0].brandName,'シルバーカード');
  const names = validateSnapshot(state).tickets[0].payments.map(({brandName})=>brandName);
  assert.deepEqual(names,['シルバーカード','シルバーカード',undefined,'スマホ決済',undefined]);

  state = run(state,{type:'saveCardFeeSettings',settings:{...settings,brands:[]}});
  assert.equal(quote(state,ticketId).total,13_213);
  assert.equal(quote(state,ticketId).brandedFee,true);
  assert.deepEqual(state.tickets[0].payments.map(({brandName})=>brandName),names);
});

test('fee waivers are restricted and audited, and an explicit zero-rate brand overrides the fallback', () => {
  let state = openWithTicket();
  const ticketId = state.tickets[0].id;
  const settings = {enabled:true,rateBps:500,brands:[
    {id:'free',name:'加算なしカード',method:'card',rateBps:0},
    {id:'mobile',name:'QRサービス',method:'qr',rateBps:100},
  ]};
  state = run(state,{type:'saveCardFeeSettings',settings});
  state = run(state,{type:'saveCardFeeSettings',settings:{enabled:true,rateBps:300}});
  assert.equal(getCardFeeSettings(state).brands.length,2);
  const payments = [{method:'card',amount:10_000,brandId:'free'},
    {method:'qr',amount:3_200,brandId:'mobile',waiveFee:true}];
  const command = {type:'settle',ticketId,payments,expectedCardFee:0};
  const staff = {...manager,role:'staff'};
  assert.throws(() => verifyCommand('staff',command),{code:'forbidden'});
  assert.throws(() => run(state,command,staff),/権限/);
  assert.throws(() => run(state,{...command,payments:[payments[0],{method:'cash',amount:3_200,waiveFee:true}]},manager),/加算がある/);
  const paid = run(state,command,manager);
  assert.equal(quote(paid,ticketId).total,13_200);
  assert.equal(quote(paid,ticketId).cardFee,undefined);
  assert.equal(paid.tickets[0].payments[1].feeWaived,true);
  assert.equal(paid.tickets[0].payments[1].waivedFeeRate,100);
  assert.equal(validateSnapshot(paid).tickets[0].payments[1].feeWaived,true);
  assert.throws(() => run(state,{type:'saveCardFeeSettings',settings:{...settings,brands:[settings.brands[0],settings.brands[0]]}}),/重複/);
});
