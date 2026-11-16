import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo } from '../docs/engine.mjs';
import { getPayrollDraft } from '../docs/payroll.mjs';
import { createLaborDemo } from '../docs/phase-two-demo.mjs';
import { buildLaborCsv, getLaborReport } from '../docs/labor-report.mjs';
import { projectState, validateSnapshot, verifyCommand } from '../server/policy.mjs';

const now = Date.parse('2026-11-16T21:00:00+09:00');
const admin = {id:'admin',label:'管理者',role:'admin'};
const manager = {id:'manager',label:'店長',role:'manager'};
const staff = {id:'staff',label:'担当',role:'staff'};
const businessDate = '2026-11-15';
const reportRange = {start:'2026-11-14',end:'2026-11-16'};
const command = (state,action,actor = admin) => apply(state,action,now,actor);

test('role-based labor counts use business dates and distinguish zero wages from missing rates', () => {
  const state = createLaborDemo(now);
  const report = getLaborReport(state,reportRange);
  assert.deepEqual(new Set(report.roles.map(({roleKey}) => roleKey)),new Set(['admin','manager','staff','cast','trainee']));
  assert.equal(report.partial,true);
  const owner = report.roles.find(({roleKey}) => roleKey === 'admin');
  const trainee = report.roles.find(({roleKey}) => roleKey === 'trainee');
  assert.deepEqual([owner.people,owner.attendanceDays,owner.knownCost,owner.hasKnownCost],[1,2,0,true]);
  assert.deepEqual([trainee.people,trainee.attendanceDays,trainee.hasKnownCost,trainee.issues],[1,1,false,1]);
  const records = report.details.filter((row)=>row.roleKey === 'manager');
  assert.equal(records[0].minutes,330);
  assert.equal(records[0].date,businessDate);
  assert.equal(records[0].clockOutAt,Date.parse('2026-11-16T02:00:00+09:00'));
  assert.equal(report.daily.find((row)=>row.roleKey==='manager' && row.date===businessDate).count,1);
  const monthlyClosed = getPayrollDraft(state,'2026-11','cast2').snapshot;
  assert.equal(monthlyClosed.net,12_600);
  const beforeCosts = report.roles.find(({roleKey})=>roleKey==='cast').knownCost;
  const advance = state.payroll.dailyPays.find(({status})=>status==='requested');
  const approved = command(state,{type:'reviewDailyPay',dailyPayId:advance.id,decision:'approve'});
  const paid = command(approved,{type:'payDailyPay',dailyPayId:advance.id,method:'cash'});
  assert.equal(getLaborReport(paid,reportRange).roles.find(({roleKey})=>roleKey==='cast').knownCost,beforeCosts);
  assert.deepEqual(getPayrollDraft(paid,'2026-11','cast2').snapshot,monthlyClosed);
  assert.match(buildLaborCsv(report,'daily'),/2026-11-15,マネージャー,佐伯,2026-11-15 20:00,2026-11-16 02:00,330,3000,勤怠/);
  assert.match(buildLaborCsv(report,'summary'),/体入,望月,1,450,,0,,時給未登録/);
  assert.match(buildLaborCsv(report,'summary'),/店舗管理者,高橋,2,540,0,0,0/);
});

test('rates follow effective business dates and attendance corrections preserve recorded names and roles', () => {
  let state = createLaborDemo(now);
  const person = state.staffLabor.people.find(({role})=>role==='manager');
  const {id:personId} = person;
  state = command(state,{type:'saveStaffRate',personId,effectiveDate:businessDate,hourlyRate:4_500});
  assert.equal(getLaborReport(state,{...reportRange,role:'manager'}).knownCost,41_250);
  state = command(state,{type:'saveStaffPerson',personId,name:'新しい表示名',role:'admin',enabled:false});
  let row = state.staffLabor.attendance.find((row)=>row.personId === personId && row.date === businessDate);
  const change = {type:'saveStaffAttendance',attendanceId:row.id,personId,date:row.date,
    clockInAt:row.clockInAt,clockOutAt:row.clockOutAt,breakMinutes:60,reason:'休憩記録の確認'};
  state = command(state,change,manager);
  row = state.staffLabor.attendance.find(({id})=>id === row.id);
  assert.deepEqual([row.roleName,row.personName,row.minutes],['マネージャー','佐伯',300]);
  assert.equal(state.auditLog[0].reason,'休憩記録の確認');
  assert.equal(getLaborReport(state,{...reportRange,role:'manager'}).knownCost,39_000);
  state = command(state,{type:'voidStaffAttendance',attendanceId:row.id,reason:'重複確認'},manager);
  assert.equal(getLaborReport(state,{...reportRange,role:'manager'}).knownCost,16_500);
  assert.match(projectState(state,'manager','id').staffLabor.attendance.find(({id})=>id === row.id).voidReason,/重複/);
  assert.deepEqual(validateSnapshot(state).staffLabor,state.staffLabor);
});

test('role permissions protect wages and malformed/overlapping attendance cannot change reports', () => {
  let state = createLaborDemo(now);
  const entry = state.staffLabor.attendance[0];
  const newEntry = {type:'saveStaffAttendance',personId:entry.personId,date:entry.date,
    clockInAt:entry.clockInAt,clockOutAt:entry.clockOutAt,breakMinutes:30,reason:'記録'};
  assert.throws(() => command(state,newEntry,staff),/権限/);
  assert.throws(() => command(state,newEntry,manager),/同じ勤務者/);
  assert.throws(() => command(state,{...newEntry,date:businessDate},manager),/営業日/);
  assert.throws(() => command(state,{type:'saveStaffRate',personId:entry.personId,effectiveDate:entry.date,hourlyRate:1000},manager),/権限/);
  assert.doesNotThrow(() => verifyCommand('manager',newEntry,state));
  assert.throws(() => verifyCommand('staff',newEntry,state),{code:'forbidden'});
  assert.equal(projectState(state,'staff','id').staffLabor,undefined);
  assert.equal(projectState(state,'manager','id').staffLabor.rates,undefined);
  state = command(state,{type:'saveRolePolicy',policy:{manager:{label:'店長',disabled:['staffing']}}});
  assert.equal(projectState(state,'manager','id').staffLabor,undefined);
  assert.throws(() => verifyCommand('manager',newEntry,state),{code:'forbidden'});
  const broken = structuredClone(state);
  broken.staffLabor.attendance.push({...broken.staffLabor.attendance[0],id:'fake'});
  assert.throws(() => validateSnapshot(broken),{code:'invalid-snapshot'});
  assert.equal(validateSnapshot(createDemo('closed',now)).staffLabor,undefined);
});

test('custom role attendance keeps its recorded label and read-only staffing accounts cannot make changes', () => {
  const profileId = 'role-00000000-0000-4000-8000-000000000012';
  const profile = {base:'manager',label:'フロア責任者',allowed:['staffing']};
  let state = command(createDemo('closed',now),{type:'saveRolePolicy',policy:{custom:{[profileId]:profile}}});
  state = command(state,{type:'saveStaffPerson',name:'小林',role:'manager',profileId,enabled:true});
  const {id:personId} = state.staffLabor.people[0];
  const action = {type:'saveStaffAttendance',personId,date:businessDate,clockInAt:Date.parse('2026-11-15T22:00:00+09:00'),
    clockOutAt:Date.parse('2026-11-16T01:30:00+09:00'),breakMinutes:30,reason:'シフトを確認'};
  assert.throws(() => verifyCommand('manager',action,state,profileId),{code:'forbidden'});
  assert.equal(projectState(state,'manager','id',profileId).staffLabor.rates,undefined);
  state = command(state,action);
  state = command(state,{type:'saveRolePolicy',policy:{custom:{[profileId]:{...profile,label:'営業責任者',allowed:['staffing','editStaffing']}}}});
  assert.doesNotThrow(()=>verifyCommand('manager',action,state,profileId));
  const historical = getLaborReport(state,{...reportRange,role:profileId});
  assert.deepEqual(historical.roles.map(({roleKey,roleName,minutes})=>[roleKey,roleName,minutes]),[[profileId,'フロア責任者',180]]);
  assert.deepEqual(validateSnapshot(state).staffLabor,state.staffLabor);
});
