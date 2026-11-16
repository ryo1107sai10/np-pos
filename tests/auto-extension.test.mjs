import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, createDemo, getLayoutAreas, getLayoutTables, quote, summary } from '../docs/engine.mjs';
import { getAutoExtensionNotices, getAutoExtensionPlans, getAutoExtensionSettings, getNextAutoExtensionAt,
  getTableAutoExtensionEnabled, getTicketAutoExtensionAt, isValidAutoExtensionSettings } from '../docs/auto-extension.mjs';

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
const tableExtension = (state,tableId,enabled,at = base,actor = staff) =>
  run(state,{type:'setTableAutoExtension',tableId,enabled},at,actor);

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

test('the table preference persists between visits, follows operator permissions and remains subordinate to the store setting', () => {
  const state = open();
  assert.equal(getTableAutoExtensionEnabled(state,'a1'),true);
  assert.throws(() => tableExtension(state,'a1',false,base,cast),/権限/);
  assert.throws(() => tableExtension(state,'missing',false),/見つかりません/);
  assert.throws(() => tableExtension(state,'a1','false'),/自動延長の設定/);
  const off = settings(seat(tableExtension(state,'a1',false)),true);
  assert.deepEqual(off.tableAutoExtension,{a1:false});
  assert.equal(getTableAutoExtensionEnabled(off,'a1'),false);
  assert.equal(getNextAutoExtensionAt(off),null);
  assert.deepEqual(getAutoExtensionNotices(off,base + 59 * minute),[]);
  assert.deepEqual(sync(off,base + 60 * minute),off);

  const ticketId = off.tickets[0].id;
  const paid = run(off,{type:'settle',ticketId,payments:[{method:'cash',amount:quote(off,ticketId).total}]},base + 61 * minute);
  const left = run(paid,{type:'depart',ticketId},base + 62 * minute);
  const followingVisit = run(left,{type:'seat',tableIds:['a1'],guests:2,setId:'set60'},base + 63 * minute);
  assert.equal(getTicketAutoExtensionAt(followingVisit,followingVisit.tickets[1]),null);
  const masterOff = settings(followingVisit,false,base + 64 * minute);
  const tableOn = tableExtension(masterOff,'a1',true,base + 65 * minute,manager);
  assert.equal(getTableAutoExtensionEnabled(tableOn,'a1'),true);
  assert.equal(getNextAutoExtensionAt(tableOn),null);
});

test('a shared ticket remains paused until all linked tables are on and reports just one notice before its deadline', () => {
  let state = settings(open(),true);
  state = run(state,{type:'seat',tableIds:['a1','a2'],guests:5,setId:'set60'});
  const ticketId = state.tickets[0].id;
  state = tableExtension(state,'a1',false,base + 30 * minute);
  state = tableExtension(state,'a2',false,base + 31 * minute);
  state = tableExtension(state,'a1',true,base + 75 * minute);
  assert.equal(state.tickets[0].autoExtensionResumedAt,undefined);
  assert.equal(getNextAutoExtensionAt(state),null);
  const resumedAt = base + 80 * minute;
  state = tableExtension(state,'a2',true,resumedAt);
  assert.equal(state.tickets[0].autoExtensionResumedAt,resumedAt);
  const deadline = resumedAt + 30 * minute;
  assert.equal(getNextAutoExtensionAt(state),deadline);
  assert.deepEqual(getAutoExtensionNotices(state,deadline - minute - 1),[]);
  const expected = [{ticketId,tableIds:['a1','a2'],deadline}];
  assert.deepEqual(getAutoExtensionNotices(state,deadline - minute),expected);
  assert.deepEqual(getAutoExtensionNotices(state,deadline - 1),expected);
  assert.deepEqual(getAutoExtensionNotices(state,deadline),[]);
  assert.equal(tableExtension(state,'a2',true,resumedAt + minute).tickets[0].autoExtensionResumedAt,resumedAt);
  assert.deepEqual(automaticLines(sync(state,deadline)).map(({createdAt}) => createdAt),[deadline]);
});

test('switching from an off table to an on table restarts overdue grace without affecting other tables', () => {
  let state = settings(seat(open()),true);
  const ticketId = state.tickets[0].id;
  state = tableExtension(state,'a2',false,base + minute);
  state = run(state,{type:'move',ticketId,tableIds:['a2']},base + 30 * minute);
  assert.equal(getNextAutoExtensionAt(state),null);
  const resume = base + 95 * minute;
  state = run(state,{type:'move',ticketId,tableIds:['a3']},resume);
  assert.equal(getAutoExtensionNotices(state,resume).length,0);
  assert.equal(getNextAutoExtensionAt(state),resume + 30 * minute);
  assert.equal(automaticLines(sync(state,resume + 29 * minute)).length,0);
  assert.deepEqual(automaticLines(sync(state,resume + 30 * minute)).map(({createdAt}) => createdAt),[resume + 30 * minute]);

  const tables = getLayoutTables(state).filter(({id}) => id !== 'a2');
  const updated = run(state,{type:'saveLayout',areas:getLayoutAreas(state),tables},resume + minute);
  assert.equal(updated.tableAutoExtension,undefined);
});
