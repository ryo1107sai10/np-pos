import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCastSelfCommand, bindCastAccount, getCastWorkspace, listCastAttendance, validateCastAttendanceSnapshot } from '../docs/cast-self.mjs';
import { apply, createDemo, quote } from '../docs/engine.mjs';
import { getPayrollDraft, previewPayroll } from '../docs/payroll.mjs';
import { projectState, validateSnapshot, verifyCommand } from '../server/policy.mjs';

const day = '2026-11-30';
const month = day.slice(0,7);
const now = Date.parse(`${day}T23:30:00+09:00`);
const minute = 60_000;
const admin = {id:'owner',label:'管理者',role:'admin'};
const manager = {id:'manager',label:'マネージャー',role:'manager'};
const staff = {id:'staff',label:'ホール',role:'staff'};
const first = {id:'first-uid',label:'cast-first',role:'cast'};
const second = {id:'second-uid',label:'cast-second',role:'cast'};
const clockIn = {type:'castClockIn'};
const clockOut = {type:'castClockOut'};

function fixture() {
  const state = createDemo('closed',now);
  bindCastAccount(state,{memberUid:first.id,castId:'cast1'},admin);
  bindCastAccount(state,{memberUid:second.id,castId:'cast2'},admin);
  let id = 0;
  const command = (action,at = now,actor = first) => applyCastSelfCommand(state,action,at,actor,(prefix) => `${prefix}-${++id}`);
  return {state,command};
}

test('closed-store cast punches use the configured cutoff at a calendar month boundary', () => {
  const {state,command} = fixture();
  const early = Date.parse('2026-12-01T03:30:00+09:00');
  state.controls = {register:{cutoff:'03:00'}};
  command(clockIn,early);
  assert.equal(state.castAttendance[0].date,'2026-12-01');
  assert.equal(getCastWorkspace(state,first.id,early).date,'2026-12-01');
});

test('manager punches, corrected breaks and named attendance amounts are reflected in frozen payroll', () => {
  let state = createDemo('closed',now);
  const run = (action, at = now, actor = manager) => { state = apply(state,action,at,actor); };
  const date = '2026-11-30';
  const clock = (hhmm) => Date.parse(`${date}T${hhmm}:00+09:00`);
  const row = {type:'saveManagedAttendance',castId:'cast1',date,classification:'late',
    clockInAt:clock('20:00'),clockOutAt:clock('23:00'),reason:'出勤記録の確認'};
  run({type:'savePayrollRate',castId:'cast1',effectiveDate:date,hourlyRate:3000},now,admin);
  run({type:'savePayrollSettings',settings:{pointRate:50}},now,admin);
  run({type:'saveEmployeeProfile',castId:'cast1',profile:{number:'E01',legalName:'内部名',phone:'090-0000-0000'}},now,admin);
  assert.equal(state.payroll.employeeProfiles[0].number,'E01');
  assert.equal(projectState(state,'manager',manager.id).payroll,undefined);
  assert.doesNotMatch(JSON.stringify(state.auditLog),/内部名|090-0000-0000/);
  run({type:'saveAttendanceItems',items:[
    {label:'送迎',kind:'deduction',amount:600},{label:'手当',kind:'allowance',amount:700},{label:'勤務',kind:'points',amount:2}
  ]},now,admin);
  assert.equal(projectState(state,'staff',staff.id).attendanceItems,undefined);
  const itemIds = state.attendanceItems.map(({id})=>id);
  const breaks = [{startAt:clock('20:15'),endAt:clock('20:30')},{startAt:clock('21:45'),endAt:clock('22:15')}];
  assert.throws(()=>verifyCommand('staff',row),{code:'forbidden'});
  assert.throws(()=>run({...row,breaks:[breaks[0],{startAt:clock('20:25'),endAt:clock('20:32')}] }),/重複/);
  run({...row,breaks,itemIds});
  assert.equal(state.attendances[0].minutes,135);
  const {id:attendanceId} = state.castAttendance[0];
  assert.throws(()=>run(row),/重複/);
  run({...row,attendanceId,clockOutAt:clock('23:15'),breaks,itemIds,reason:'正しい退勤を確認'});
  assert.equal(state.attendances[0].minutes,150);
  assert.equal(state.auditLog[0].reason,'正しい退勤を確認');
  run({type:'saveManagedAttendance',castId:'cast2',date,classification:'no-show',reason:'欠勤確認'});
  assert.equal(state.castAttendance.find(({castId})=>castId==='cast2').status,'absent');
  const pay = previewPayroll(state,{month,castId:'cast1'});
  assert.equal(pay.hourlyPay,7500);
  assert.equal(pay.pointPay,100);
  assert.equal(pay.net,7700);
  run({type:'savePayrollDraft',month,castId:'cast1'},now,admin);
  run({type:'finalizePayroll',month,castId:'cast1'},now,admin);
  assert.throws(()=>run({...row,attendanceId}),/確定/);
  run({type:'saveAttendanceItems',items:[]},now,admin);
  assert.equal(validateSnapshot(state).payroll.records[0].snapshot.net,7700);
});

test('cast clock hands off an overnight shift to approved payroll exactly once', () => {
  const {state,command} = fixture();
  const clockedOut = now + 180 * minute;
  assert.throws(() => command(clockOut),/出勤打刻/);
  command({...clockIn,castId:'cast2',clockInAt:0});
  assert.equal(getCastWorkspace(state,first.id,now).openClock.clockInAt,now);
  assert.equal(getCastWorkspace(state,second.id,now).openClock,null);
  assert.throws(() => command(clockIn),/すでに出勤/);
  assert.throws(() => command({...clockOut,breakMinutes:181},clockedOut),/休憩時間/);
  command({...clockOut,breakMinutes:30},clockedOut);
  const [record] = listCastAttendance(state);
  assert.equal(record.castId,'cast1');
  assert.equal(record.date,day);
  assert.equal(record.status,'pending');
  assert.equal(record.breakMinutes,30);
  assert.equal(record.minutes,150);
  assert.equal(state.attendances,undefined);
  const approval = {type:'reviewCastAttendance',attendanceId:record.id,decision:'approve'};
  assert.throws(() => command(approval,clockedOut,first),/勤怠承認/);
  assert.throws(() => command(approval,clockedOut,staff),/勤怠承認/);
  command(approval,clockedOut,manager);
  assert.throws(() => command(approval,clockedOut,manager),/確認待ち/);
  assert.deepEqual(state.attendances,[{castId:'cast1',date:day,minutes:150,status:'approved'}]);
  const waiting = getCastWorkspace(state,first.id,clockedOut);
  assert.equal(waiting.payroll.previewPending,true);
  assert.equal(waiting.payroll.draft,null);
  const rated = apply(state,{type:'savePayrollRate',castId:'cast1',effectiveDate:day,hourlyRate:3500},clockedOut,admin);
  const pay = previewPayroll(rated,{month,castId:'cast1'});
  assert.equal(pay.net,8750);
  assert.equal(pay.work[0].source,'attendance');
  assert.equal(getCastWorkspace(rated,first.id,clockedOut).payroll.draft.net,8750);
  assert.doesNotThrow(() => validateCastAttendanceSnapshot(rated));
  const inconsistent = structuredClone(rated);
  inconsistent.attendances[0].minutes += 1;
  assert.throws(() => validateCastAttendanceSnapshot(inconsistent),/一致しません/);
});

test('cast workspace projects only assigned schedules, advances, attendance and amounts', () => {
  const {state,command} = fixture();
  state.customers = [{name:'他人の顧客情報'}];
  state.shifts = [{id:'other-shift',castId:'cast2',date:day,startMinute:1200,endMinute:1380,status:'confirmed',note:'他人の予定'}];
  const shift = {type:'castRequestShift',date:day,startMinute:1200,endMinute:1380,note:'本人の希望',status:'confirmed',castId:'cast2'};
  command(shift);
  assert.throws(() => command(shift),/すでにシフト/);
  command({type:'castRequestDailyPay',month,amount:1000,reason:'本人の申請',castId:'cast2'});
  command({type:'castRequestDailyPay',month,amount:3000,reason:'他人の申請'},now,second);
  assert.throws(() => command({type:'castRequestDailyPay',month:'2026-12',amount:1000}),/現在の給与月/);
  let payroll = apply(state,{type:'savePayrollRate',castId:'cast1',effectiveDate:day,hourlyRate:3500},now,admin);
  payroll = apply(payroll,{type:'savePayrollDraft',month,castId:'cast1',work:[{date:day,minutes:120}]},now,admin);
  const view = getCastWorkspace(payroll,first.id,now);
  assert.deepEqual(view.cast,{id:'cast1',name:'美月'});
  assert.equal(view.shifts.length,1);
  assert.equal(view.shifts[0].status,'requested');
  assert.equal(view.dailyPays.length,1);
  assert.equal(view.dailyPays[0].amount,1000);
  assert.equal(view.payroll.draft.net,7000);
  assert.equal(view.payroll.draft.settings,undefined);
  assert.doesNotMatch(JSON.stringify(view),/他人|second-uid|owner/);
  assert.equal(getCastWorkspace(state,'unbound',now),null);
  assert.throws(() => bindCastAccount(state,{memberUid:'third',castId:'cast2'},admin),/別のアカウント/);
  assert.throws(() => bindCastAccount(state,{memberUid:first.id,castId:null},manager),/店舗管理者/);
  bindCastAccount(state,{memberUid:first.id,castId:null},admin);
  assert.equal(getCastWorkspace(state,first.id,now),null);
  assert.throws(() => command(clockIn),/ひもづけ/);
  state.cast.find(({id}) => id === 'cast2').enabled = false;
  assert.equal(getCastWorkspace(state,second.id,now),null);
});

test('pending attendance blocks payroll finalization until the manager records a decision', () => {
  const {state,command} = fixture();
  command(clockIn);
  const [initial] = state.castAttendance;
  const reject = {type:'reviewCastAttendance',attendanceId:initial.id,decision:'reject'};
  assert.throws(() => command(reject,now + minute,manager),/理由/);
  command({...reject,reason:'打刻し直し'},now + minute,manager);
  assert.throws(() => command(clockIn),/直前/);
  command(clockIn,now + 2 * minute);
  command(clockOut,now + 32 * minute);
  const next = state.castAttendance.at(-1);
  let payroll = apply(state,{type:'savePayrollDraft',month,castId:'cast1'},now,admin);
  const finalize = {type:'finalizePayroll',month,castId:'cast1'};
  assert.throws(() => apply(payroll,finalize,now + 32 * minute,admin),/未確認の勤怠/);
  applyCastSelfCommand(payroll,{...reject,attendanceId:next.id,reason:'誤打刻のため除外'},now + 33 * minute,manager);
  payroll = apply(payroll,finalize,now + 33 * minute,admin);
  assert.throws(() => applyCastSelfCommand(payroll,clockIn,now + 34 * minute,first,()=>'new'),/給与を確定/);
  const final = getPayrollDraft(payroll,month,'cast1');
  assert.deepEqual(final.snapshot.work,[]);
  assert.equal(getCastWorkspace(payroll,first.id,now).payroll.finals[0].net,0);
  assert.doesNotThrow(() => validateCastAttendanceSnapshot(payroll));
  delete payroll.castAttendance[1].breakMinutes;
  assert.doesNotThrow(() => validateCastAttendanceSnapshot(payroll));
});
test('cast sales performance includes only own confirmed and open order figures without receipt data', () => {
  const now = Date.parse('2026-11-17T20:30:00+09:00');
  let state = createDemo('closed',now);
  const run = (action) => { state = apply(state,action,now); };
  run({type:'open',date:'2026-11-17',openingCash:1000});
  run({type:'bindCastAccount',memberUid:'performance-actor',castId:'cast1'});
  run({type:'seat',tableIds:['a1'],setId:'set60',guests:1});
  const settledId = state.tickets.at(-1).id;
  run({type:'order',ticketId:settledId,items:[{menuId:'nomination',quantity:1,castIds:['cast1']},
    {menuId:'castDrink',quantity:2,castIds:['cast1','cast2']}]});
  run({type:'settle',ticketId:settledId,payments:[{method:'cash',amount:quote(state,settledId).remaining}]});
  run({type:'seat',tableIds:['a2'],setId:'set60',guests:1});
  const pendingId = state.tickets.at(-1).id;
  run({type:'order',ticketId:pendingId,items:[{menuId:'castDrink',quantity:3,castIds:['cast1']},
    {menuId:'castDrink',quantity:7,castIds:['cast2']}]});
  const projected = getCastWorkspace(state,'performance-actor',now);
  assert.equal(projected.performance.month,'2026-11');
  assert.equal(projected.performance.confirmed.nominations,1);
  assert.equal(projected.performance.confirmed.drinkQuantity,1);
  assert.equal(projected.performance.forecast.drinkQuantity,3);
  assert.equal(projected.performance.confirmed.commission,quote(state,settledId).commission.find(({castId})=>castId==='cast1').amount);
  assert.equal(projected.performance.forecast.sales,quote(state,pendingId).commission.find(({castId})=>castId==='cast1').sales);
  assert.ok(!JSON.stringify(projected.performance).includes(settledId));
  assert.ok(!JSON.stringify(projected.performance).includes('cast2'));
});
