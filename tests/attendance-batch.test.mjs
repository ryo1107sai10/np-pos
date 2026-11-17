import assert from 'node:assert/strict';
import test from 'node:test';
import { getAttendanceBatchRows, readAttendanceBatch, renderAttendanceBatchRows } from '../docs/attendance-batch-ui.mjs';
import { listCastAttendance } from '../docs/cast-self.mjs';
import { getCloseAttendanceReview, renderCloseReview } from '../docs/close-review.mjs';
import { apply, createDemo, summary, yen } from '../docs/engine.mjs';
import { getLaborReport } from '../docs/labor-report.mjs';
import { createCashDemo } from '../docs/phase-two-demo.mjs';
import { defaultRegisterSettings, getAttendanceTimeUnit } from '../docs/register-config.mjs';
import { validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-17';
const at = (time) => Date.parse(`${date}T${time}:00+09:00`);
const now = at('23:59');
const admin = {id:'admin-test',label:'管理者',role:'admin'};
const manager = {id:'manager-test',label:'承認担当',role:'manager'};
const castActor = {id:'cast-test',label:'キャスト本人',role:'cast'};
const record = (state,command,actor = admin) => apply(state,command,now,actor);

function fixture() {
  let state = apply(createDemo('closed',now),{type:'open',date,openingCash:10_000},at('20:00'),admin);
  state = record(state,{type:'saveStaffPerson',name:'勤務者',role:'staff',enabled:true});
  return state;
}

function withUnit(state,unit) {
  return record(state,{type:'saveControls',managerDiscountRateBps:1_000,register:{...defaultRegisterSettings,attendanceTimeUnit:unit}});
}

function bulk(state) {
  return {type:'saveAttendanceBatch',date,reason:'勤務記録照合',rows:[
    {kind:'staff',personId:state.staffLabor.people[0].id,clockInAt:at('21:07'),clockOutAt:at('23:58'),breakMinutes:8},
    {kind:'cast',personId:'cast1',clockInAt:at('21:02'),clockOutAt:at('22:58'),breakMinutes:5,classification:'worked'},
  ]};
}

test('bulk attendance records cast and staff atomically with raw clocks, audit rows and independent historical units', () => {
  const state = withUnit(fixture(),15);
  const action = bulk(state);
  assert.doesNotThrow(() => verifyCommand('manager',action,state));
  assert.throws(() => verifyCommand('staff',action,state),{code:'forbidden'});
  assert.throws(() => verifyCommand('manager',{...action,rows:[...action.rows,action.rows[0]]},state),{code:'invalid-command'});
  assert.throws(() => record(state,{...action,rows:[action.rows[0],{...action.rows[1],clockOutAt:at('20:00')}]},manager),/退勤/);
  assert.deepEqual(state.staffLabor.attendance,[]);
  assert.equal(state.castAttendance,undefined);

  let next = record(state,action,manager);
  const staff = next.staffLabor.attendance[0];
  const cast = next.castAttendance[0];
  assert.deepEqual([staff.minutes,staff.timeUnitMinutes,staff.clockInAt,staff.clockOutAt],[142,15,at('21:07'),at('23:58')]);
  assert.deepEqual([cast.minutes,cast.timeUnitMinutes,cast.clockInAt,cast.clockOutAt],[85,15,at('21:02'),at('22:58')]);
  assert.equal(next.attendances[0].minutes,85);
  assert.deepEqual(next.auditLog[0].before.rows.map(({record}) => record),[null,null]);
  assert.deepEqual(next.auditLog[0].after.rows.map(({record}) => record.id),[staff.id,cast.id]);
  assert.equal(next.auditLog[0].actor.id,manager.id);

  next = withUnit(next,30);
  next = record(next,{...action,rows:action.rows.map((row,index) => ({...row,attendanceId:[staff.id,cast.id][index],breakMinutes:0}))},manager);
  assert.deepEqual([next.staffLabor.attendance[0].minutes,next.castAttendance[0].minutes],[150,90]);
  assert.deepEqual(next.auditLog[0].before.rows.map(({record}) => record.minutes),[142,85]);
  const migrated = validateSnapshot(next);
  assert.equal(getAttendanceTimeUnit(migrated),30);
  assert.deepEqual(migrated.staffLabor.attendance,next.staffLabor.attendance);
  assert.deepEqual(migrated.castAttendance,listCastAttendance(next));
});

test('switching store attendance units leaves an open punch and older client control saves intact', () => {
  let state = withUnit(fixture(),15);
  state = record(state,{type:'bindCastAccount',memberUid:castActor.id,castId:'cast1'});
  state = apply(state,{type:'castClockIn'},at('21:07'),castActor);
  state = apply(state,{type:'saveControls',managerDiscountRateBps:1000,
    register:{...defaultRegisterSettings,attendanceTimeUnit:30}},at('22:00'),admin);
  state = apply(state,{type:'castClockOut',breakMinutes:0},at('23:58'),castActor);
  assert.equal(state.castAttendance[0].minutes,150);
  assert.equal(state.castAttendance[0].timeUnitMinutes,15);
  state = record(state,{type:'saveControls',managerDiscountRateBps:1000,register:defaultRegisterSettings});
  assert.equal(getAttendanceTimeUnit(state),30);
});

test('attendance review preserves register totals and identifies currently open records for both rosters', () => {
  const state = createCashDemo(now);
  const review = getCloseAttendanceReview(state);
  assert.equal(review.staffCount,1);
  assert.equal(review.castCount,1);
  assert.equal(review.open.length,2);
  assert.equal(review.open.find(({role}) => role === 'マネージャー').name,'佐伯');
  assert.equal(summary(state).expectedCash,29_000);
  const labor = getLaborReport(state,{start:date,end:date,role:'manager'});
  assert.deepEqual(labor.details,[]);
  assert.equal(labor.partial,true);
  assert.equal(validateSnapshot(state).staffLabor.attendance[0].clockOutAt,null);
  const preview = renderCloseReview(state,summary(state),{escape:String,yen,attendanceVisible:true,attendanceButton:'勤怠を開く'});
  assert.match(preview,/確定売上[\s\S]*来店客数[\s\S]*佐伯[\s\S]*勤怠を開く/);
  assert.doesNotMatch(renderCloseReview(state,summary(state),{escape:String,yen,attendanceVisible:false}),/佐伯|未退勤/);
  assert.doesNotThrow(() => record(state,{type:'close',actualCash:29_000}));
});

test('bulk entry selects one date and keeps input local until the checked rows are saved', () => {
  const state = fixture();
  const choices = getAttendanceBatchRows(state,date);
  const staff = choices.findIndex(({kind}) => kind === 'staff');
  assert.match(renderAttendanceBatchRows(date,choices,{escape:String}),/勤務者[\s\S]*一括記録・訂正の理由/);
  const form = new FormData();
  form.append('attendanceRow',String(staff));
  form.set('batchReason','勤務開始の確認');
  form.set(`batchIn${staff}`,`${date}T21:07`);
  form.set(`batchOut${staff}`,'');
  form.set(`batchBreak${staff}`,'0');
  const action = readAttendanceBatch(form,date,choices);
  const next = record(state,action,manager);
  assert.equal(next.staffLabor.attendance[0].clockOutAt,null);
  assert.equal(next.staffLabor.attendance[0].clockInAt,at('21:07'));
  assert.equal(getCloseAttendanceReview(next).open.length,1);
});
