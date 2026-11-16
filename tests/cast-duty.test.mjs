import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, previewSettledContents, quote } from '../docs/engine.mjs';
import { getAssignableCast, getCastDutyMode } from '../docs/cast-duty.mjs';
import { createCastDutyDemo } from '../docs/phase-two-demo.mjs';
import { projectState, validateSnapshot, verifyCommand } from '../server/policy.mjs';

const businessDate = '2026-11-16';
const now = Date.parse(`${businessDate}T21:00:00+09:00`);
const admin = {role:'admin',id:'admin',label:'管理者'};
const manager = {role:'manager',id:'manager',label:'マネージャー'};
const staff = {role:'staff',id:'staff',label:'スタッフ'};
const configure = (state,castDutyMode,at = now,actor = admin) => apply(state,{type:'saveControls',managerDiscountRateBps:1_000,castDutyMode},at,actor);
const eligible = (state,at) => getAssignableCast(state,at).map(({id}) => id);
const shift = (state,castId,status = 'confirmed') => apply(state,{type:'saveShift',castId,status,date:businessDate,
  startMinute:1_200,endMinute:1_500},now,manager);
const order = (ticketId,castIds,menuId = 'nomination') => ({type:'order',ticketId,items:[{menuId,quantity:1,castIds}]});

test('shift policy uses actual JST boundaries, scheduled overnight continuity and absence', () => {
  let state = createDemo('closed',now);
  assert.equal(getCastDutyMode(state),'all');
  assert.equal(eligible(state,now).length,6);
  assert.throws(() => configure(state,'attendance',now,manager),/管理者/);
  assert.throws(() => configure(state,'invalid'),/候補設定/);
  state = configure(state,'shifts');
  assert.equal(state.auditLog[0].before.castDutyMode,'all');
  assert.equal(state.auditLog[0].after.castDutyMode,'shifts');
  state = shift(state,'cast1');
  state = shift(state,'cast2');
  state = shift(state,'cast3','requested');
  state = apply(state,{type:'saveManagedAttendance',castId:'cast2',date:businessDate,classification:'no-show',reason:'欠勤確認'},now,manager);
  for (const [time,expected] of [['2026-11-16T19:59:59+09:00',[]],['2026-11-16T20:00:00+09:00',['cast1']],
    ['2026-11-17T00:59:59+09:00',['cast1']],['2026-11-17T01:00:00+09:00',[]]]) {
    assert.deepEqual(eligible(state,Date.parse(time)),expected);
  }
  assert.equal(validateSnapshot(state).controls.castDutyMode,'shifts');
  assert.throws(() => validateSnapshot({...state,controls:{castDutyMode:true}}),/移行|スナップショット|候補|営業データ/);
});

test('staff projection exposes eligibility and refresh deadline while preserving staffing privacy', (t) => {
  t.mock.method(Date,'now',() => now);
  const state = createCastDutyDemo(now);
  const filtered = projectState(state,'staff','staff');
  assert.deepEqual(Object.keys(filtered.castDutyProjection).sort(),['ids','refreshAt']);
  assert.deepEqual(eligible(filtered,now),['cast1']);
  assert.deepEqual(eligible(filtered,filtered.castDutyProjection.refreshAt),[]);
  for (const key of ['shifts','castAttendance','attendances','staffLabor','payroll']) assert.equal(filtered[key],undefined);
  const restricted = {...state,rolePolicy:{staff:{label:'閲覧のみ',disabled:['orders']}}};
  assert.equal(projectState(restricted,'staff','staff').castDutyProjection,undefined);
  assert.equal(validateSnapshot({...state,castDutyProjection:{ids:['cast6'],refreshAt:null}}).castDutyProjection,undefined);
});

test('new and edited assignments use duty; ordinary unassigned orders and extension attribution continue', () => {
  let state = createCastDutyDemo(now);
  const ticket = state.tickets.find(({tableIds}) => tableIds.includes('a1'));
  assert.doesNotThrow(() => verifyCommand('staff',order(ticket.id,['cast2']),state));
  assert.throws(() => apply(state,order(ticket.id,['cast2']),now,staff),/勤務条件/);
  assert.throws(() => apply({...state,day:{...state.day,date:'2026-11-15'}},order(ticket.id,['cast1']),now + 86_400_000,staff),/勤務条件/);
  state = apply(state,order(ticket.id,[],'highball'),now,staff);
  state = apply(state,order(ticket.id,['cast1']),now,staff);
  const added = state.tickets.find(({id}) => id === ticket.id).lines.at(-1);
  state = configure(state,'shifts');
  const correction = {type:'editTicketLine',ticketId:ticket.id,lineId:added.id,quantity:2,reason:'数量を訂正'};
  assert.throws(() => apply(state,{...correction,castIds:['cast1','cast3']},now,manager),/勤務条件/);
  state = apply(state,{...correction,castIds:['cast1','cast2']},now,manager);
  const after = state.tickets.find(({id}) => id === ticket.id).lines.at(-1);
  assert.deepEqual(after.castIds,['cast1','cast2']);
  assert.deepEqual(after.castCommissions[0],added.castCommissions[0]);
  state = apply(state,{type:'extend',ticketId:ticket.id,menuId:'extend30'},now,staff);
  const extended = state.tickets.find(({id}) => id === ticket.id).lines.at(-1);
  assert.equal(extended.menuId,'nominationExtra');
  assert.deepEqual(extended.castIds,['cast1','cast2']);
});

test('attendance uses completed approved intervals and explicit breaks for settled corrections', () => {
  let state = createCastDutyDemo(now);
  const ticket = state.tickets.find(({tableIds}) => tableIds.includes('a1'));
  state = apply(state,order(ticket.id,['cast1']),now,staff);
  const later = now + 50 * 60_000;
  const work = (castId,breaks) => apply(state,{type:'saveManagedAttendance',castId,date:businessDate,classification:'worked',
    clockInAt:now - 30 * 60_000,clockOutAt:later,breaks,reason:'勤務実績を確認'},later,manager);
  state = work('cast2',[{startAt:now,endAt:now + 60_000}]);
  state = work('cast3',[]);
  assert.deepEqual(eligible(state,later),['cast1']);
  assert.equal(eligible(state,now).includes('cast2'),false);
  assert.equal(eligible(state,now + 60_000).includes('cast2'),true);
  state = apply(state,{type:'settle',ticketId:ticket.id,payments:[{method:'cash',amount:quote(state,ticket.id).remaining}]},later,staff);
  const settled = state.tickets.find(({id}) => id === ticket.id);
  const line = settled.lines.at(-1);
  const correction = {type:'correctSettledContents',ticketId:ticket.id,lineId:line.id,quantity:1,price:line.price,
    adjustmentMethod:'cash',reason:'担当者の訂正',expectedTotal:settled.settlement.total};
  assert.throws(() => previewSettledContents(state,settled,{...correction,castIds:['cast1','cast2']}),/勤務条件/);
  const corrected = apply(state,{...correction,castIds:['cast1','cast3']},later,admin).tickets.find(({id}) => id === ticket.id);
  assert.deepEqual(corrected.lines.at(-1).castIds,['cast1','cast3']);
  assert.equal(corrected.settlement.total,settled.settlement.total);
});
