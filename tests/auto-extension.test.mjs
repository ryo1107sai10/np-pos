import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { getAutoExtensionPlans, getAutoExtensionSettings, getNextAutoExtensionAt, isValidAutoExtensionSettings } from '../docs/auto-extension.mjs';

const minute = 60_000;
const base = Date.parse('2026-11-16T19:00:00+09:00');
const admin = {id:'owner',label:'店舗管理者',role:'admin'};
const manager = {id:'manager',label:'マネージャー',role:'manager'};
const staff = {id:'staff',label:'スタッフ',role:'staff'};
const cast = {id:'cast',label:'キャスト',role:'cast'};
const run = (state, action, at = base, actor = admin) => apply(state, action, at, actor);
const open = () => run(createDemo('closed',base),{type:'open',openingCash:20_000});
const seat = (state,tableId = 'a1') => run(state,{type:'seat',tableIds:[tableId],guests:2,setId:'set60'});
const settings = (state,enabled,at = base,menuId = 'extend30',actor = admin) =>
  run(state,{type:'saveAutoExtensionSettings',enabled,menuId},at,actor);
const sync = (state,at) => run(state,{type:'syncAutoExtensions',now:base + 600 * minute},at,staff);
const automaticLines = (state,index = 0) => state.tickets[index].lines.filter(({autoExtension}) => autoExtension);

test('default off, only the owner can change a valid auto extension plan, and no timer comes from the action payload', () => {
  const state = seat(open());
  assert.deepEqual(getAutoExtensionSettings(state),{enabled:false,menuId:'',effectiveAt:null});
  assert.equal(getNextAutoExtensionAt(state),null);
  assert.deepEqual(sync(state,base + 80 * minute),state);
  assert.throws(() => settings(state,true,base,'extend30',manager),/店舗管理者/);
  assert.throws(() => settings(state,true,base,'extend30',staff),/店舗管理者/);
  assert.throws(() => settings(state,true,base,'nominationExtra'),/有効な延長プラン/);
  assert.throws(() => settings(state,true,base,'missing'),/有効な延長プラン/);
  assert.throws(() => run(state,{type:'syncAutoExtensions'},base,cast),/権限/);
  const enabled = settings(state,true);
  assert.equal(isValidAutoExtensionSettings(enabled.autoExtensionSettings),true);
  assert.deepEqual(sync(enabled,base + 59 * minute),enabled);
  assert.equal(getNextAutoExtensionAt(enabled),base + 60 * minute);
});

test('adds whole overdue intervals at their deadlines using the existing plan and nomination calculations exactly once', () => {
  let state = settings(seat(open()),true);
  const {id:ticketId} = state.tickets[0];
  state = run(state,{type:'order',ticketId,items:[{menuId:'nomination',quantity:1,castIds:['cast1']}]},base + minute);
  const last = base + 90 * minute;
  const extended = sync(state,last);
  const lines = automaticLines(extended);
  assert.deepEqual(lines.map(({menuId,quantity,createdAt}) => [menuId,quantity,createdAt]),[
    ['extend30',2,base + 60 * minute],['nominationExtra',1,base + 60 * minute],
    ['extend30',2,base + 90 * minute],['nominationExtra',1,base + 90 * minute],
  ]);
  assert.equal(extended.tickets[0].endsAt,base + 120 * minute);
  assert.deepEqual(sync(extended,last),extended);
  const first = run(state,{type:'extend',ticketId,menuId:'extend30'},base + 60 * minute);
  const second = run(first,{type:'extend',ticketId,menuId:'extend30'},last);
  assert.equal(automaticLines(second).length,0);
  assert.deepEqual(quote(extended,ticketId),quote(second,ticketId));
  assert.equal(getNextAutoExtensionAt(extended),base + 120 * minute);
});

test('enabling, changing and disabling a setting do not charge time before the change', () => {
  const activation = base + 95 * minute;
  const original = seat(open());
  const enabled = settings(original,true,activation);
  assert.equal(getNextAutoExtensionAt(enabled),activation + 30 * minute);
  assert.equal(getAutoExtensionSettings(settings(enabled,true,activation + minute)).effectiveAt,activation);
  assert.equal(automaticLines(sync(enabled,activation + 29 * minute)).length,0);
  const synced = sync(enabled,activation + 30 * minute);
  assert.deepEqual(automaticLines(synced).map(({createdAt}) => createdAt),[activation + 30 * minute]);
  assert.equal(synced.tickets[0].endsAt,activation + 60 * minute);
  const changed = settings(enabled,true,activation + minute,'extend60');
  assert.equal(getNextAutoExtensionAt(changed),activation + 61 * minute);
  const disabled = settings(enabled,false,activation + 15 * minute);
  assert.equal(getNextAutoExtensionAt(disabled),null);
  assert.equal(automaticLines(sync(disabled,activation + 120 * minute)).length,0);
  const unavailable = {...enabled,menu:enabled.menu.map((item) => item.id === 'extend30' ? {...item,enabled:false} : item)};
  assert.equal(getNextAutoExtensionAt(unavailable),null);
  assert.deepEqual(sync(unavailable,activation + 120 * minute),unavailable);
});

test('paid, cancelled and closed tickets stay unchanged, and reopening does not charge time spent closed', () => {
  const state = settings(seat(open()),true);
  const {id:ticketId} = state.tickets[0];
  const pay = run(state,{type:'settle',ticketId,payments:[{method:'cash',amount:quote(state,ticketId).total}]},base + 20 * minute);
  assert.equal(getNextAutoExtensionAt(pay),null);
  assert.deepEqual(sync(pay,base + 200 * minute),pay);
  const departed = run(pay,{type:'depart',ticketId},base + 21 * minute);
  const closed = run(departed,{type:'close',actualCash:summary(departed).expectedCash},base + 22 * minute);
  assert.deepEqual(sync(closed,base + 200 * minute),closed);
  const cancelled = run(pay,{type:'cancelSettlement',ticketId,reason:'訂正'},base + 130 * minute);
  assert.deepEqual(sync(cancelled,base + 200 * minute),cancelled);
  const reopenedAt = base + 150 * minute;
  const reopened = run(cancelled,{type:'reopenTicket',ticketId,tableIds:['a1'],reason:'入力訂正'},reopenedAt);
  assert.equal(getNextAutoExtensionAt(reopened),reopenedAt + 30 * minute);
  assert.equal(automaticLines(sync(reopened,reopenedAt + 29 * minute)).length,0);
  assert.equal(automaticLines(sync(reopened,reopenedAt + 30 * minute)).length,1);
});

test('large catch-up makes bounded progress and leaves an outstanding deadline until complete', () => {
  const state = settings(seat(open()),true);
  const firstDue = base + 60 * minute;
  const now = firstDue + 104 * 30 * minute;
  const partial = sync(state,now);
  assert.equal(automaticLines(partial).length,100);
  assert(getNextAutoExtensionAt(partial) <= now);
  const complete = sync(partial,now);
  assert.equal(automaticLines(complete).length,105);
  assert(getNextAutoExtensionAt(complete) > now);
  assert.deepEqual(sync(complete,now),complete);
});

test('a delayed automatic extension applies nomination eligibility as of each interval deadline', () => {
  let state = settings(seat(open()),true);
  const {id:ticketId} = state.tickets[0];
  state = run(state,{type:'order',ticketId,items:[{menuId:'nomination',quantity:1,castIds:['cast1']}]},base + minute);
  const firstNomination = state.tickets[0].lines.at(-1);
  state = run(state,{type:'cancelLine',ticketId,lineId:firstNomination.id,reason:'別担当に変更'},base + 65 * minute);
  state = run(state,{type:'order',ticketId,items:[{menuId:'nomination',quantity:1,castIds:['cast2']}]},base + 80 * minute);
  state = sync(state,base + 95 * minute);
  const surcharges = automaticLines(state).filter(({menuId}) => menuId === 'nominationExtra');
  assert.deepEqual(surcharges.map(({createdAt,castIds}) => [createdAt,castIds]),[
    [base + 60 * minute,['cast1']], [base + 90 * minute,['cast2']],
  ]);
});

test('legacy stock recipes pause automatic billing and keep the settings and manual extension usable', () => {
  let state = settings(seat(open()),true);
  const {id:ticketId} = state.tickets[0];
  state = run(state,{type:'order',ticketId,items:[{menuId:'nomination',quantity:1,castIds:['cast1']}]},base + minute);
  const due = base + 70 * minute;

  for (const menuId of ['extend30','nominationExtra']) {
    const withRecipe = {...state,menu:state.menu.map((item) => item.id === menuId
      ? {...item,recipe:[{stockId:'beer',quantity:1}]} : item)};
    assert.deepEqual(getAutoExtensionPlans(withRecipe).map(({id}) => id),menuId === 'extend30' ? ['extend60'] : []);
    assert.equal(getNextAutoExtensionAt(withRecipe),null);
    assert.deepEqual(sync(withRecipe,due),withRecipe);
    assert.throws(() => settings(withRecipe,true,due),/有効な延長プラン/);

    const disabled = settings(withRecipe,false,due);
    assert.deepEqual(getAutoExtensionSettings(disabled),{enabled:false,menuId:'extend30',effectiveAt:null});
    const manuallyExtended = run(disabled,{type:'extend',ticketId,menuId:'extend30'},due);
    const line = manuallyExtended.tickets[0].lines.find((item) => item.menuId === menuId);
    assert.equal(line.stockUses[0].stockId,'beer');
    assert.equal(automaticLines(manuallyExtended).length,0);
  }
});
