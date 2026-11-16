import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { renderCompanionEditor, renderCompanionResults, renderCustomerNotices, renderSeatCustomer, renderSeatCustomerResults, renderSeatCustomerSelection } from '../docs/customer-ui.mjs';
import { projectState,validateSnapshot,verifyCommand } from '../server/policy.mjs';
import { findCustomer, findSettledCustomerTicket, getCustomerDetail, getCustomerNotices, getReturningCustomerCastSuggestions, isAssignedCustomer,
  listUnlinkedVisits, parseCustomersCsv, searchCustomers } from '../docs/customers.mjs';
import { writeDemoBackup, readDemoBackup } from '../docs/demo-backup.mjs';

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

test('customer notices cross New Year, include only bottles with remaining stock, and follow profile access', () => {
  const anniversaries = [{monthDay:'01-05',label:'節目'},{monthDay:'02-29',label:'閏日の記念日'}];
  const state = register(register(opened(),{name:'管理者が登録',birthday:'1990-12-29'}),{
    name:'担当顧客',birthday:'1996-12-29',anniversaries,bottleKeeps:[
      {name:'期限切れ',quantity:0.5,expiresAt:'2026-12-28'},
      {name:'境界日',quantity:1,expiresAt:'2027-01-05'},
      {name:'期限は先',quantity:1,expiresAt:'2027-01-06'},
      {name:'空瓶',quantity:0,expiresAt:'2026-12-28'},
    ],
  },manager);
  assert.deepEqual(getCustomerNotices(projectState(state,'manager',manager.id),'2026-12-29')
    .map(({label,daysUntil})=>[label,daysUntil]),[['誕生日',0],['節目',7],['境界日',7],['期限切れ',-1]]);
  assert.deepEqual(getCustomerNotices(projectState(state,'staff',staff.id),'2026-12-29'),[]);
  assert.equal(getCustomerNotices(state,'2027-02-27').some(({kind})=>kind === 'anniversary'),false);
  assert.equal(getCustomerNotices(state,'2028-02-27').find(({kind})=>kind === 'anniversary')?.date,'2028-02-29');
  const html = renderCustomerNotices(projectState(state,'manager',manager.id),{role:'manager',escape:String,icon:()=>'',businessDate:'2026-12-29'});
  assert.match(html,/節目/);
  assert.doesNotMatch(html,/管理者が登録|空瓶/);
});

test('anniversaries validate, survive snapshots and backup, deduplicate when merged, and can be removed', async () => {
  const anniversary = {monthDay:'11-16',label:'初来店'};
  let state = register(register(opened(),{name:'A',anniversaries:[anniversary]}),{name:'B',anniversaries:[anniversary]});
  const [source,target] = state.customers;
  assert.throws(()=>register(state,{name:'C',anniversaries:[{monthDay:'02-30',label:'無効な日付'}]}), /記念日/);
  assert.throws(()=>register(state,{name:'C',anniversaries:[anniversary,anniversary]}), /記念日/);
  state = run(state,{type:'mergeCustomers',sourceId:source.id,targetId:target.id,reason:'同じ顧客'});
  assert.deepEqual(validateSnapshot(state).customers[0].anniversaries,[anniversary]);
  const restored = (await readDemoBackup(await writeDemoBackup(state,now))).snapshot;
  assert.deepEqual(restored.customers[0].anniversaries,[anniversary]);
  state = run(restored,{type:'saveCustomer',customerId:target.id,customer:{anniversaries:[]}});
  assert.equal(state.customers[0].anniversaries,undefined);
  assert.deepEqual(state.auditLog[0].after.changedFields,['anniversaries']);
});

test('same-ticket companions have scoped visit history and primary-only sales attribution', () => {
  let state = register(register(register(opened(),{name:'代表客'}),{name:'同席客',phone:'070-1234-5678'}),{name:'別の顧客'});
  const [primary,companion,other] = state.customers;
  state = seat(state,{customerId:primary.id,guests:2},staff);
  const ticketId = state.tickets[0].id;
  const command = {type:'setTicketCompanion',ticketId,customerId:companion.id,mode:'add'};
  verifyCommand('staff',command);
  assert.throws(()=>verifyCommand('cast',command),{code:'forbidden'});
  const api = {escape:String,icon:()=>''};
  assert.doesNotMatch(renderCompanionEditor(state,state.tickets[0],primary,api),/同席客/);
  assert.match(renderCompanionResults(state,state.tickets[0],primary,'同席',api),/同席客/);
  state = run(state,command,staff);
  assert.throws(()=>run(state,{...command,customerId:other.id}),/来店人数/);
  assert.throws(()=>run(state,{type:'setTicketCustomer',ticketId,customerId:null}),/同席者/);
  assert.equal(getCustomerDetail(state,companion.id).visits[0].companion,true);
  assert.equal(state.auditLog[0].action,'setTicketCompanion');
  assert.deepEqual(validateSnapshot(state).tickets[0].companionCustomerIds,[companion.id]);
  const scope = projectState(state,'staff',staff.id);
  assert.deepEqual(scope.tickets[0].activeCompanionLinks,[{id:companion.id,name:'同席客'}]);
  assert.equal(scope.customers.find(({id})=>id===companion.id).phone,undefined);
  assert.equal(scope.tickets[0].companionCustomerIds,undefined);
  const removed = run(state,{...command,mode:'remove'},manager);
  assert.equal(getCustomerDetail(removed,companion.id).visits.length,0);
  const total = quote(state,ticketId).total;
  state = departPaid(state,ticketId);
  assert.equal(getCustomerDetail(state,primary.id).totalSales,total);
  assert.equal(getCustomerDetail(state,companion.id).totalSales,0);
  assert.equal(projectState(state,'manager',manager.id).tickets[0].companionCustomerIds.length,0);
});

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
  assert.equal(state.auditLog.find(({action}) => action === 'saveCustomer').actor.id, admin.id);
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

test('returning-customer suggestions prefer the assigned cast and a previous completed nomination', () => {
  let state = register(opened(), {name:'再来店',castId:'cast3'}, manager);
  const [{id:customerId}] = state.customers;
  const at = (minute) => now + minute * 60_000;
  const anotherVisit = (minute) => {
    state = seat(state,{customerId},admin,at(minute));
    return state.tickets.at(-1).id;
  };
  const nominate = (ticketId,castIds,minute) => {
    state = run(state,{type:'order',ticketId,items:[{menuId:'nomination',quantity:1,castIds}]},admin,at(minute));
    return state.tickets.find(({id}) => id === ticketId).lines.at(-1).id;
  };

  const previous = anotherVisit(1);
  nominate(previous,['cast2'],2);
  const cancelledLine = nominate(previous,['cast1'],3);
  state = run(state,{type:'cancelLine',ticketId:previous,lineId:cancelledLine,reason:'指名を訂正'},admin,at(4));
  state = run(state,{type:'extend',ticketId:previous,menuId:'extend30'},admin,at(5));
  state = departPaid(state,previous,at(6));

  const cancelledVisit = anotherVisit(7);
  nominate(cancelledVisit,['cast1'],8);
  state = run(state,{type:'settle',ticketId:cancelledVisit,payments:[{method:'cash',amount:quote(state,cancelledVisit).remaining}]},admin,at(9));
  state = run(state,{type:'cancelSettlement',ticketId:cancelledVisit,reason:'二重会計を取り消す'},admin,at(10));

  const activeVisit = anotherVisit(11);
  nominate(activeVisit,['cast1'],12);
  const suggested = getReturningCustomerCastSuggestions(state,customerId,{before:at(11)});
  assert.deepEqual(suggested.map(({id,assigned,nominated}) => [id,assigned,nominated]), [
    ['cast3',true,false], ['cast2',false,true],
  ]);
  assert.deepEqual(getReturningCustomerCastSuggestions(state,customerId,{before:at(5)}),[suggested[0]]);
  const scoped = projectState(state,'manager',manager.id);
  assert.deepEqual(getReturningCustomerCastSuggestions(scoped,customerId),suggested);
  assert.deepEqual(getReturningCustomerCastSuggestions(projectState(state,'manager','other'),customerId),[]);
  assert.deepEqual(getReturningCustomerCastSuggestions(projectState(state,'staff',staff.id),customerId),[]);
  assert.deepEqual(getReturningCustomerCastSuggestions(state,customerId,{people:state.cast.filter(({id}) => id === 'cast2')}),[suggested[1]]);

  const api = {role:'admin',escape:String,icon:()=>''};
  const selection = renderSeatCustomerSelection(state,customerId,api);
  const assignedHint = selection.indexOf(`担当キャスト <strong>${suggested[0].name}`);
  const nominatedHint = selection.indexOf(`前回の指名 <strong>${suggested[1].name}`);
  assert.ok(assignedHint >= 0 && nominatedHint > assignedHint);
  assert.doesNotMatch(renderSeatCustomer(state,api),/再来店|前回の指名/);
  assert.doesNotMatch(renderSeatCustomerSelection(state,customerId,{...api,role:'staff'}),/担当キャスト|前回の指名/);
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

test('operators can attach, change, and clear an open ticket without changing its financials', () => {
  let state = register(opened(), { name: '登録済み A' });
  state = register(state, { name: '登録済み B' });
  const [first, second] = state.customers;
  state = seat(state, {}, staff);
  const ticketId = state.tickets[0].id;
  state = run(state, { type: 'order', ticketId, items: [
    { menuId: 'nomination', quantity: 1, castIds: ['cast3'] },
  ] }, staff);
  state = run(state, { type: 'deposit', ticketId, method: 'cash', amount: 1000 }, staff);
  const before = state;
  const setCustomer = (customerId, actor) => {
    state = run(state, { type: 'setTicketCustomer', ticketId, customerId }, actor);
  };

  setCustomer(first.id, staff);
  assert.equal(state.tickets[0].customerId, first.id);
  assert.equal(state.tickets[0].customer, first.name);
  assert.equal(getCustomerDetail(state, first.id).visits[0].id, ticketId);
  assert.equal(getCustomerDetail(state, first.id).nominations[0].castId, 'cast3');
  assert.equal(findCustomer(state, first.id).firstVisitDate, '2026-11-16');

  state = run(state, { type: 'saveCustomer', customerId: first.id, customer: { name: '変更後の氏名' } });
  const attached = state;
  setCustomer(first.id, manager);
  assert.deepEqual(state, attached);
  assert.equal(state.tickets[0].customer, first.name);

  setCustomer(second.id, manager);
  assert.equal(state.tickets[0].customerId, second.id);
  assert.equal(state.tickets[0].customer, second.name);
  assert.deepEqual(getCustomerDetail(state, first.id).visits, []);
  assert.deepEqual(getCustomerDetail(state, first.id).nominations, []);
  assert.equal(findCustomer(state, first.id).firstVisitDate, '');
  assert.equal(getCustomerDetail(state, second.id).nominations[0].ticketId, ticketId);
  assert.equal(isAssignedCustomer(state, second, manager.id), false);
  assert.equal(findCustomer(state, second.id).firstVisitDate, '2026-11-16');

  setCustomer(null, admin);
  assert.deepEqual(state.tickets, before.tickets);
  assert.deepEqual(state.stock, before.stock);
  assert.deepEqual(state.movements, before.movements);
  assert.deepEqual(quote(state, ticketId), quote(before, ticketId));
  assert.deepEqual(summary(state), summary(before));
  assert.deepEqual(getCustomerDetail(state, second.id).visits, []);
  assert.equal(findCustomer(state, second.id).firstVisitDate, '');
});

test('the ticket customer edit is limited to registered customers and current open visits', () => {
  let state = register(opened(), { name: '登録済み' });
  const [{ id: customerId }] = state.customers;
  state = seat(state, { customer: '旧伝票の表示名' });
  const ticketId = state.tickets[0].id;
  const action = { type: 'setTicketCustomer', ticketId };
  for (const role of ['cast', 'trainee']) {
    assert.throws(() => run(state, { ...action, customerId }, { id: role, label: role, role }), /権限/);
  }
  for (const invalid of [undefined, 123, {}, '', 'missing']) {
    assert.throws(() => run(state, { ...action, customerId: invalid }), /顧客/);
  }
  assert.throws(() => run(state, action), /顧客/);
  assert.throws(() => run(state, { ...action, ticketId: 'missing', customerId }), /伝票が見つかりません/);
  const cleared = run(state, { ...action, customerId: null }, staff);
  assert.equal(cleared.tickets[0].customer, '');
  assert.deepEqual(listUnlinkedVisits(cleared), []);

  const paid = run(state, { type: 'settle', ticketId,
    payments: [{ method: 'cash', amount: quote(state, ticketId).remaining }] });
  const departed = run(paid, { type: 'depart', ticketId });
  const cancelled = run(paid, { type: 'cancelSettlement', ticketId, reason: '確認' });
  const voided = run(state, { type: 'void', ticketId });
  for (const locked of [paid, departed, cancelled, voided]) {
    assert.throws(() => run(locked, { ...action, customerId }), /会計前の伝票/);
  }
  const closed = run(departed, { type: 'close', actualCash: summary(departed).expectedCash });
  assert.throws(() => run(closed, { ...action, customerId }), /開店/);
});

test('ticket correction preserves past customer visits and cancelled receipt snapshots', () => {
  let state = register(opened(), { name: '既存のお客様', creditEnabled: true, creditLimit: 30_000 });
  state = register(state, { name: '移動先のお客様' });
  const [previous, target] = state.customers;
  state = seat(state, { customerId: previous.id });
  const oldTicket = state.tickets[0].id;
  state = departPaid(state, oldTicket);
  state = run(state, { type: 'close', actualCash: summary(state).expectedCash });
  const tomorrow = now + 24 * 60 * 60_000;
  state = run(state, { type: 'open', date: '2026-11-17', openingCash: 20_000 }, admin, tomorrow);
  state = seat(state, { customerId: previous.id }, admin, tomorrow);
  const ticketId = state.tickets[0].id;
  state = run(state, { type: 'settle', ticketId, creditDueDate: '2026-11-25',
    payments: [{ method: 'receivable', amount: quote(state, ticketId).remaining }] }, admin, tomorrow);
  state = run(state, { type: 'cancelSettlement', ticketId, reason: '顧客の選択を訂正' }, admin, tomorrow);
  state = run(state, { type: 'reopenTicket', ticketId, tableIds: ['a1'], reason: '顧客の選択を訂正' }, admin, tomorrow);
  const next = run(state, { type: 'setTicketCustomer', ticketId, customerId: target.id }, staff, tomorrow);
  assert.deepEqual(next.closedDays, state.closedDays);
  assert.deepEqual(next.cancelledSettlements, state.cancelledSettlements);
  assert.deepEqual(next.receivables, state.receivables);
  assert.deepEqual(getCustomerDetail(next, previous.id).visits.map(({ id }) => id), [oldTicket]);
  assert.equal(findCustomer(next, previous.id).firstVisitDate, '2026-11-16');
  assert.deepEqual(getCustomerDetail(next, target.id).visits.map(({ id }) => id), [ticketId]);
  assert.equal(findCustomer(next, target.id).firstVisitDate, '2026-11-17');
});

test('clearing a customer keeps the first visit date when another ticket remains on the same day', () => {
  let state = register(opened(), { name: '本日のお客様' });
  const [{ id: customerId }] = state.customers;
  state = seat(state, { customerId });
  const firstTicket = state.tickets[0].id;
  state = departPaid(state, firstTicket);
  state = seat(state, { customerId });
  const secondTicket = state.tickets.at(-1).id;
  state = run(state, { type: 'setTicketCustomer', ticketId: secondTicket, customerId: null });
  assert.equal(findCustomer(state, customerId).firstVisitDate, '2026-11-16');
  assert.deepEqual(getCustomerDetail(state, customerId).visits.map(({ id }) => id), [firstTicket]);
});

test('settled customer correction adds, reassigns, and clears the visit without changing the settlement or invoice', () => {
  let state = register(opened(), { name: '最初の指定先' });
  state = register(state, { name: '正しい指定先' });
  const [first, second] = state.customers;
  state = seat(state, {});
  const ticketId = state.tickets[0].id;
  state = run(state, { type: 'order', ticketId, items: [
    { menuId: 'nomination', quantity: 1, castIds: ['cast3'] },
    { menuId: 'highball', quantity: 1 },
  ] });
  state = run(state, { type: 'settle', ticketId,
    payments: [{ method: 'cash', amount: quote(state, ticketId).remaining }] });
  state = run(state, { type: 'issuePrintDocument', ticketId, date: state.day.date,
    kind: 'invoice', recipient: '発行済みの宛名', purpose: '飲食代' });
  const paid = state;
  const correction = { type: 'correctSettledTicketCustomer', ticketId, reason: '指定漏れを確認' };
  state = run(state, { ...correction, customerId: first.id });
  assert.equal(state.tickets[0].customer, first.name);
  assert.equal(getCustomerDetail(state, first.id).totalSales, summary(paid).sales);
  assert.equal(getCustomerDetail(state, first.id).nominations[0].castId, 'cast3');
  assert.deepEqual(run(state, { ...correction, customerId: first.id }), state);

  state = run(state, { ...correction, customerId: second.id, reason: '顧客の選択を訂正' });
  assert.equal(state.tickets[0].customerId, second.id);
  assert.equal(getCustomerDetail(state, first.id).totalSales, 0);
  assert.equal(findCustomer(state, first.id).firstVisitDate, '');
  assert.equal(getCustomerDetail(state, second.id).totalSales, summary(paid).sales);
  assert.equal(getCustomerDetail(state, second.id).nominations[0].ticketId, ticketId);

  state = run(state, { ...correction, customerId: null, reason: '顧客の指定を解除' });
  assert.deepEqual(state.tickets, paid.tickets);
  assert.deepEqual(summary(state), summary(paid));
  assert.deepEqual(state.stock, paid.stock);
  assert.deepEqual(state.movements, paid.movements);
  assert.deepEqual(state.printDocuments, paid.printDocuments);
  assert.equal(getCustomerDetail(state, second.id).totalSales, 0);
});

test('settled customer correction checks admin, reason, customer, and status without allowing legacy bypass', () => {
  let state = register(opened(), { name: '登録済み' });
  const [{ id: customerId }] = state.customers;
  state = seat(state, { customer: '過去の自由入力' });
  const ticketId = state.tickets[0].id;
  const correction = { type: 'correctSettledTicketCustomer', ticketId, customerId, reason: '正しいお客様を確認' };
  assert.throws(() => run(state, correction), /会計済み/);
  const voided = run(state, { type: 'void', ticketId });
  assert.throws(() => run(voided, correction), /会計済み/);
  state = run(state, { type: 'settle', ticketId,
    payments: [{ method: 'cash', amount: quote(state, ticketId).remaining }] });
  assert.throws(() => run(state, { type: 'linkCustomer', ticketId, customerId }), /訂正理由/);
  for (const actor of [manager, staff]) {
    assert.throws(() => run(state, correction, actor), /店舗管理者/);
  }
  for (const reason of [undefined, ' ', '長'.repeat(121), 1]) {
    assert.throws(() => run(state, { ...correction, reason }), /訂正理由/);
  }
  for (const invalid of [undefined, 1, 'missing']) {
    assert.throws(() => run(state, { ...correction, customerId: invalid }), /顧客/);
  }
  const cancelled = run(state, { type: 'cancelSettlement', ticketId, reason: '取消済み' });
  assert.throws(() => run(cancelled, correction), /会計済み/);
  assert.equal(run(state, correction).tickets[0].customerId, customerId);
});

test('settled customer correction keeps the closed-day copy and reevaluates first visits by original business date', () => {
  let state = register(opened(), { name: '最初の顧客' });
  state = register(state, { name: '訂正先の顧客' });
  const [first, second] = state.customers;
  state = seat(state, { customerId: first.id });
  const oldTicket = state.tickets[0].id;
  state = departPaid(state, oldTicket);
  state = run(state, { type: 'close', actualCash: summary(state).expectedCash });
  const closed = state.closedDays[0];
  const correction = { type: 'correctSettledTicketCustomer', ticketId: oldTicket, reason: '担当者が確認' };
  state = run(state, { ...correction, customerId: second.id });
  assert.equal(state.tickets[0].customerId, second.id);
  assert.equal(state.closedDays[0].ticketSnapshots[0].customerId, second.id);

  const tomorrow = now + 24 * 60 * 60_000;
  state = run(state, { type: 'open', date: '2026-11-17', openingCash: 20_000 }, admin, tomorrow);
  state = seat(state, { customerId: second.id }, admin, tomorrow);
  const corrected = run(state, { ...correction, customerId: first.id }, admin, tomorrow);
  const { date, ticket } = findSettledCustomerTicket(corrected, oldTicket);
  assert.equal(date, '2026-11-16');
  assert.equal(ticket.customerId, first.id);
  assert.equal(ticket.customer, first.name);
  assert.deepEqual(corrected.closedDays[0], closed);
  assert.equal(findCustomer(corrected, first.id).firstVisitDate, '2026-11-16');
  assert.equal(findCustomer(corrected, second.id).firstVisitDate, '2026-11-17');
  assert.deepEqual(corrected.tickets, state.tickets);
});

test('settled companions can be added and removed without changing a closed sale', () => {
  let state = register(register(opened(),{name:'代表'}),{name:'同席者'});
  const [primary,companion] = state.customers;
  state = seat(state,{customerId:primary.id,guests:2});
  const {id:ticketId} = state.tickets[0];
  const action = {type:'correctSettledTicketCompanion',ticketId,primaryCustomerId:primary.id,
    customerId:companion.id,mode:'add',reason:'同席を確認'};
  for (const role of ['manager','staff','cast']) assert.throws(()=>verifyCommand(role,action,state),{code:'forbidden'});
  assert.doesNotThrow(()=>verifyCommand('admin',action,state));
  assert.throws(()=>run(state,action),/会計済み/);
  state = departPaid(state,ticketId);
  state = run(state,{type:'close',actualCash:summary(state).expectedCash});
  const original = state.tickets[0];
  assert.throws(()=>run(state,action,manager),/店舗管理者/);
  assert.throws(()=>run(state,{...action,reason:' '}),/訂正理由/);
  assert.throws(()=>run(state,{...action,primaryCustomerId:'other'}),/代表者/);
  state = run(state,action);
  assert.deepEqual(state.tickets[0],{...original,companionCustomerIds:[companion.id]});
  assert.deepEqual(state.closedDays[0].ticketSnapshots[0].companionCustomerIds,[companion.id]);
  assert.equal(getCustomerDetail(state,companion.id).visits[0].companion,true);
  assert.equal(getCustomerDetail(state,companion.id).totalSales,0);
  assert.equal(findCustomer(state,companion.id).firstVisitDate,'2026-11-16');
  const tomorrow = now + 86_400_000;
  state = run(state,{type:'open',date:'2026-11-17',openingCash:20000},admin,tomorrow);
  state = seat(state,{customerId:companion.id},admin,tomorrow);
  state = run(state,{...action,mode:'remove',reason:'予約名簿で訂正'},admin,tomorrow);
  const entry = findSettledCustomerTicket(state,ticketId);
  assert.deepEqual(entry.ticket.companionCustomerIds,[]);
  assert.deepEqual(entry.ticket.settlement,original.settlement);
  assert.deepEqual(entry.ticket.payments,original.payments);
  assert.equal(findCustomer(state,companion.id).firstVisitDate,'2026-11-17');
  assert.deepEqual(state.auditLog[0].before,{companionCustomerIds:[companion.id]});
  assert.deepEqual(state.auditLog[0].after,{companionCustomerIds:[]});
  assert.equal(state.auditLog[0].businessDate,'2026-11-16');
  assert.equal(state.auditLog[0].reason,'予約名簿で訂正');
  assert.doesNotThrow(()=>validateSnapshot(state));
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
  state = run(state, { type: 'linkCustomer', ticketId: legacyTicket, customerId: source.id });
  assert.equal(listUnlinkedVisits(state).length, 0);
  state = departPaid(state, legacyTicket);
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
