import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, exportStoreConfiguration, getTicketCommissionDetails, quote, summary, yen } from '../docs/engine.mjs';
import { renderReport } from '../docs/reports.mjs';
import { buildCommissionCsv, getCommissionReport } from '../docs/commission-report.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';

const now = Date.parse('2026-11-16T20:00:00+09:00');
const date = '2026-11-16';
const nextDate = '2026-11-17';
const guestName = '履歴プライバシー確認';
const app = (state, action) => apply(state, action, now);
const report = (page, state, params = {}) => renderReport(page, state, {
  icon: () => '', escape: String, quote, summary, yen, ...params,
});

function opened() {
  return app(createDemo('closed', now), {type: 'open', date, openingCash: 10_000});
}

function seat(state, tableId, guests = 2) {
  return app(state, {type: 'seat', tableIds: [tableId], setId: 'set60', guests, customer: guestName});
}

function add(state, ticketId, menuId, castIds = []) {
  return app(state, {type: 'order', ticketId, items: [{menuId, castIds, quantity: 1}]});
}

function dayClosed() {
  let state = seat(opened(), 'a1');
  const ticketId = state.tickets[0].id;
  state = add(state, ticketId, 'castDrink', ['cast2']);
  state = add(state, ticketId, 'highball');
  state = app(state, {type: 'settle', ticketId, payments: [{method: 'cash', amount: 10_000}, {method: 'card', amount: 6_368}]});
  state = app(state, {type: 'depart', ticketId});
  return app(state, {type: 'close', actualCash: 20_000});
}

test('spec V-1 to V-3 preserve integer totals and split payments when commission becomes final', () => {
  let state = seat(opened(), 'a1');
  const ticketId = state.tickets[0].id;
  const totals = (current) => {
    const {subtotal, service, tax, total} = quote(current, ticketId);
    return [subtotal, service, tax, total];
  };
  assert.deepEqual(totals(state), [10_000, 2_000, 1_200, 13_200]);
  state = add(state, ticketId, 'castDrink', ['cast2']);
  state = add(state, ticketId, 'highball');
  assert.deepEqual(totals(state), [12_400, 2_480, 1_488, 16_368]);
  assert.deepEqual(summary(state).commission, []);
  assert.deepEqual(summary(state).pendingCommission, [{castId: 'cast2', sales: 1_500, amount: 300, points: 1}]);
  state = app(state, {type: 'settle', ticketId, payments: [{method: 'cash', amount: 10_000}, {method: 'card', amount: 6_368}]});
  assert.equal(quote(state, ticketId).remaining, 0);
  assert.deepEqual(summary(state).payments, {cash: 10_000, card: 6_368, qr: 0});
  assert.deepEqual(summary(state).commission, [{castId: 'cast2', sales: 1_500, amount: 300, points: 1}]);
  assert.deepEqual(summary(state).pendingCommission, []);
});

test('confirmed and pending commission reports enumerate the same source order amounts with a cast filter', () => {
  let state = seat(opened(), 'a1');
  const finalId = state.tickets[0].id;
  state = add(state, finalId, 'castDrink', ['cast2']);
  state = app(state, {type: 'settle', ticketId: finalId, payments: [{method: 'cash', amount: quote(state, finalId).remaining}]});
  state = seat(state, 'a2');
  const pendingId = state.tickets[1].id;
  state = add(state, pendingId, 'nomination', ['cast3']);
  state = add(state, pendingId, 'champagne', ['cast3', 'cast4']);
  const final = getTicketCommissionDetails(state, finalId);
  const pending = getTicketCommissionDetails(state, pendingId);
  const amount = (entries) => entries.reduce((sum, row) => sum + row.amount, 0);
  assert.equal(amount(final), amount(summary(state).commission));
  assert.equal(amount(pending), amount(summary(state).pendingCommission));
  assert.deepEqual(pending.map(({name}) => name), ['本指名', 'シャンパン ブリュット', 'シャンパン ブリュット']);
  const html = report('commission', state);
  assert.match(html, /確定歩合の明細[\s\S]*?キャストドリンク/);
  assert.match(html, /見込み歩合の明細[\s\S]*?本指名/);
  const settings = getStoreSettings(state);
  settings.cast.find(({id}) => id === 'cast2').enabled = false;
  settings.cast.find(({id}) => id === 'cast5').enabled = false;
  state = app(state, {type: 'saveStoreSettings', settings});
  const hidden = report('commission', state);
  assert.match(hidden, /data-action="commission-cast" data-id="cast2"/);
  assert.doesNotMatch(hidden, /data-action="commission-cast" data-id="cast5"/);
  const filtered = report('commission', state, {commissionCast: 'cast3'});
  assert.match(filtered, /結衣の明細/);
  assert.match(filtered, /本指名/);
  assert.doesNotMatch(filtered, /キャストドリンク/);
});

test('archived settlement retains order prices, table labels and cast names after reopening and catalog deletion', () => {
  let state = dayClosed();
  const ticketId = state.tickets[0].id;
  const settings = getStoreSettings(state);
  settings.cast.find(({id}) => id === 'cast2').name = '現在の表示名';
  state = app(state, {type: 'saveStoreSettings', settings});
  const remaining = getStoreSettings(state);
  remaining.cast = remaining.cast.filter(({id}) => id !== 'cast2');
  remaining.menu = remaining.menu.filter(({id}) => id !== 'castDrink');
  state = app(state, {type: 'saveStoreSettings', settings: remaining, removeMenuIds: ['castDrink'], removeCastIds: ['cast2']});
  state = app(state, {type: 'open', date: nextDate, openingCash: 0});
  assert.deepEqual(state.tickets, []);
  const [archived] = state.closedDays[0].ticketSnapshots;
  assert.equal(archived.id, ticketId);
  assert.equal(archived.settlement.total, 16_368);
  assert.deepEqual(archived.tableLabels, ['A-01']);
  const line = archived.lines.find(({menuId}) => menuId === 'castDrink');
  assert.equal(line.name, 'キャストドリンク');
  assert.equal(line.price, 1_500);
  assert.deepEqual(line.castNames, ['凛']);
  const daily = report('reports', state, {reportDate: date});
  assert.match(daily, /data-action="history-receipt"[^>]+data-date="2026-11-16"/);
  assert.match(daily, /A-01/);
  assert.match(daily, /16,368/);
  const commission = report('commission', state, {reportDate: date});
  assert.match(commission, /キャストドリンク[\s\S]*?凛/);
  assert.doesNotMatch(commission, /現在の表示名/);
  assert.doesNotMatch(JSON.stringify(exportStoreConfiguration(state)), /履歴プライバシー確認|ticketSnapshots|commissionDetails/);
});

test('older current closures archive still-resident receipts when reopening and older aggregate-only closures stay visible', () => {
  const prior = dayClosed();
  delete prior.closedDays[0].ticketSnapshots;
  for (const ticket of prior.tickets) {
    delete ticket.settlement.commissionDetails;
    for (const line of ticket.lines) delete line.castNames;
  }
  const next = app(prior, {type: 'open', date: nextDate, openingCash: 0});
  const [receipt] = next.closedDays[0].ticketSnapshots;
  assert.deepEqual(receipt.lines[1].castNames, ['凛']);
  const html = report('commission', next, {reportDate: date});
  assert.match(html, /キャストドリンク[\s\S]*?凛/);
  delete next.closedDays[0].ticketSnapshots;
  assert.match(report('reports', next, {reportDate: date}), /16,368[\s\S]*集計の保存がある営業日/);
  assert.match(report('commission', next, {reportDate: date}), /300[\s\S]*保存済み歩合/);
});

test('the detail of a legacy settled ticket uses its stored totals when recalculation differs', () => {
  const state = dayClosed();
  const [ticket] = state.tickets;
  delete ticket.settlement.commissionDetails;
  ticket.settlement.commission[0].amount += 10;
  const [row] = getTicketCommissionDetails(state, ticket.id);
  assert.equal(row.name, '伝票合計');
  assert.equal(row.amount, 310);
});

test('period commission reports add preserved daily totals and export open and confirmed lines separately', () => {
  let state = app(dayClosed(),{type:'open',date:nextDate,openingCash:0});
  state = seat(state,'a2');
  const pending = state.tickets[0].id;
  state = add(state,pending,'castDrink',['cast2']);
  state = add(state,pending,'nomination',['cast3']);
  state = seat(state,'b1');
  const second = state.tickets[1].id;
  state = add(state,second,'castDrink',['cast2']);
  state = app(state,{type:'settle',ticketId:second,payments:[{method:'card',amount:quote(state,second).remaining}]});
  const filters = {mode:'range',start:date,end:nextDate};
  const model = getCommissionReport(state,filters,'cast2');
  const p = model.roster.find(({id}) => id === 'cast2');
  assert.deepEqual(p.final,{sales:3000,amount:600,points:2});
  assert.deepEqual(p.estimate,{sales:1500,amount:300,points:1});
  assert.equal(model.details.filter(({isPending}) => isPending).length,1);
  assert.equal(model.details.filter(({isPending}) => !isPending).length,2);
  const csv = buildCommissionCsv(model,'details');
  assert.match(csv,/2026-11-16,確定,[^\n]*キャストドリンク,凛,1500,300,1/);
  assert.match(csv,/2026-11-17,見込み,[^\n]*キャストドリンク,凛,1500,300,1/);
  assert.match(buildCommissionCsv(model,'summary'),/2026-11-16,2026-11-17,凛,3000,600,300,2/);
  assert.doesNotMatch(csv,/本指名|結衣/);
  assert.equal(getCommissionReport(state,{mode:'month',month:'2026-11'}).period.days.length,2);
  const print = report('commission',state,{commissionPeriod:filters,commissionCast:'cast2',print:true});
  assert.match(print,/営業日 2026-11-16 〜 2026-11-17 · 凛/);
  assert.doesNotMatch(print,/<button|本指名/);
});
