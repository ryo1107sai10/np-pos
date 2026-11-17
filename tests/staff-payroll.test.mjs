import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createDemo } from '../docs/engine.mjs';
import { createLaborDemo } from '../docs/phase-two-demo.mjs';
import { getStaffOwnPayroll, getStaffPayrollDraft, previewStaffPayroll, previewStaffPayrollRange } from '../docs/staff-payroll.mjs';
import { renderOwnStaffPayroll, staffPayrollPrintRecord } from '../docs/staff-payroll-ui.mjs';
import { defaultPayrollStatementLayout } from '../docs/payroll-statement-layout.mjs';
import { renderPayrollPrint } from '../docs/payroll-ui.mjs';
import { getLaborReport } from '../docs/labor-report.mjs';
import { getAttendanceBatchRows } from '../docs/attendance-batch-ui.mjs';
import { projectState, validateSnapshot, verifyCommand } from '../server/policy.mjs';

const now = Date.parse('2026-11-16T23:00:00+09:00');
const month = '2026-11';
const profileId = 'role-39e5b50b-16c4-49ef-86bf-f96610166e78';
const delegated = {id:'delegate',label:'delegate',role:'manager',profileId};

function payrollFixture() {
  let state = createDemo('closed',now);
  const step = (action) => { state = apply(state,action,now); };
  for (const [name,role,hourlyRate] of [['スタッフA','staff',2400],['管理者B','admin',4837]]) {
    step({type:'saveStaffPerson',name,role,enabled:true});
    const personId = state.staffLabor.people.at(-1).id;
    step({type:'saveStaffRate',personId,effectiveDate:'2026-11-01',hourlyRate});
    const clockInAt = Date.parse('2026-11-15T20:00:00+09:00');
    step({type:'saveStaffAttendance',personId,date:'2026-11-15',clockInAt,clockOutAt:clockInAt + 9000000,
      breakMinutes:30,reason:'テスト勤務'});
    step({type:'saveStaffPayrollDraft',personId,month,allowances:[{label:'定額手当',amount:1000}],deductions:[{label:'調整控除',amount:300}]});
    step({type:'finalizeStaffPayroll',personId,month,expectedNet:hourlyRate * 2 + 700});
    if (role === 'staff') step({type:'bindStaffPayrollAccount',memberUid:'actual-staff',personId});
  }
  return state;
}

test('staff payroll snapshots retain work, effective rates and adjustments after later edits', () => {
  const fixture = payrollFixture();
  const personId = fixture.staffLabor.people[0].id;
  const original = getStaffPayrollDraft(fixture,personId,month);
  assert.equal(original.snapshot.net,5500);
  assert.equal(original.snapshot.work[0].hourlyRate,2400);
  assert.equal(original.snapshot.work[0].minutes,120);
  assert.equal(fixture.auditLog.find(({action}) => action === 'finalizeStaffPayroll').after.status,'final');
  const changed = apply(fixture,{type:'saveStaffRate',personId,effectiveDate:'2026-11-10',hourlyRate:3000},now);
  assert.equal(previewStaffPayroll(changed,original).net,6700);
  assert.deepEqual(getStaffPayrollDraft(changed,personId,month),original);
  assert.throws(() => apply(changed,{type:'saveStaffPayrollDraft',personId,month},now),/確定済み/);
  assert.deepEqual(getStaffPayrollDraft(validateSnapshot(changed),personId,month),original);
  assert.equal(validateSnapshot(changed).staffPayroll.links,undefined);
  const bad = structuredClone(changed);
  bad.staffPayroll.records[0].snapshot.net += 1;
  assert.throws(() => validateSnapshot(bad),{code:'invalid-snapshot'});
  assert.equal(staffPayrollPrintRecord(original).snapshot.castName,'スタッフA');
});

test('staff self view and payroll delegation expose only authorized amounts', () => {
  let state = payrollFixture();
  const [worker,owner] = state.staffLabor.people;
  const staff = projectState(state,'staff','actual-staff');
  assert.equal(staff.staffPayroll,undefined);
  assert.equal(staff.staffPayrollDelegation,undefined);
  assert.equal(staff.staffPayrollSelf.records[0].snapshot.hourlyPay,4800);
  assert.equal(staff.staffPayrollSelf.records[0].personId,worker.id);
  assert.equal(projectState(state,'staff','other-staff').staffPayrollSelf,undefined);
  assert.equal(getStaffOwnPayroll(state,'actual-staff','manager'),null);
  assert.throws(() => verifyCommand('manager',{type:'saveStaffRate',personId:worker.id,effectiveDate:'2026-11-14',hourlyRate:2000},state),{code:'forbidden'});
  const publish = (allowed) => {
    state = apply(state,{type:'saveRolePolicy',policy:{custom:{[profileId]:{base:'manager',label:'給与担当',allowed}}}},now);
    return projectState(state,'manager',delegated.id,profileId).staffPayrollDelegation;
  };
  const payslips = publish(['viewPayslips']);
  assert.equal(payslips.records.length,1);
  assert.deepEqual(payslips.records[0].snapshot.work,[]);
  assert.equal(payslips.rates,undefined);
  const wageView = publish(['viewHourlyRates']);
  assert.deepEqual(wageView.records,[]);
  assert.deepEqual(wageView.rates.map(({personId,hourlyRate}) => [personId,hourlyRate]),[[worker.id,2400]]);
  const wageEdit = publish(['editHourlyRates']);
  assert.equal(wageEdit.rates,undefined);
  const edit = {type:'saveStaffRate',personId:worker.id,effectiveDate:'2026-11-14',hourlyRate:2200};
  assert.doesNotThrow(() => verifyCommand('manager',edit,state,profileId));
  assert.throws(() => apply(state,{...edit,personId:owner.id},now,delegated),/管理者権限/);
  assert.equal(apply(state,edit,now,delegated).staffLabor.rates.find((rate) => rate.effectiveDate === edit.effectiveDate).hourlyRate,2200);
  assert.throws(() => apply(state,{type:'finalizeStaffPayroll',personId:worker.id,month,expectedNet:0},now,delegated),/許可|管理者権限/);
});

test('the labor sample has a viewable personal statement in the staff role', () => {
  const state = createLaborDemo(now);
  const own = getStaffOwnPayroll(state,'demo-staff','staff');
  assert.equal(own.person.name,'森');
  assert.equal(own.records[0].snapshot.net,23900);
});

test('linked workers punch distinct intervals and reports count the business day once', () => {
  let state = payrollFixture();
  const actor = {id:'actual-staff',role:'staff',label:'スタッフA'};
  const personId = state.staffLabor.people[0].id;
  const clockIn = {type:'staffClockIn'};
  const clockOut = {type:'staffClockOut'};
  const first = Date.parse('2026-11-16T20:00:00+09:00');
  assert.throws(() => apply(state,clockIn,first,{...actor,id:'someone-else'}),/本人/);
  const before = state.staffLabor.attendance.length;
  state = apply(state,clockIn,first,actor);
  assert.throws(() => apply(state,clockIn,first + 10000,actor),/先に退勤/);
  assert.equal(state.auditLog[0].reason,'本人の出勤打刻');
  assert.equal(getStaffOwnPayroll(state,actor.id,actor.role).attendance[0].clockOutAt,null);
  state = apply(state,clockOut,first + 60 * 60_000,actor);
  assert.equal(state.auditLog[0].before.clockOutAt,null);
  assert.equal(state.auditLog[0].reason,'本人の退勤打刻');
  state = apply(state,clockIn,first + 90 * 60_000,actor);
  state = apply(state,clockOut,first + 120 * 60_000,actor);
  assert.equal(state.staffLabor.attendance.length,before + 2);
  assert.equal(getAttendanceBatchRows(state,'2026-11-16').filter((row) => row.personId === personId && row.prior).length,2);
  const report = getLaborReport(state,{start:'2026-11-16',end:'2026-11-16',role:'staff'});
  assert.deepEqual(report.daily.map(({count,minutes}) => [count,minutes]),[[1,90]]);
  assert.deepEqual(report.people.map(({days,hourlyPay}) => [days,hourlyPay]),[[1,3600]]);
  assert.equal(previewStaffPayroll(state,{personId,month}).work.find(({date}) => date === '2026-11-16').minutes,90);
  assert.equal(getStaffOwnPayroll(state,'someone-else','staff'),null);
  assert.equal(validateSnapshot(state).staffLabor.attendance.length,before + 2);
});

test('a staff template uses worked days, freezes calculations and supports four-column printing', () => {
  let state = payrollFixture();
  const personId = state.staffLabor.people[0].id;
  const period = '2026-12';
  const at = Date.parse('2026-12-02T23:00:00+09:00');
  const applyCommand = (command) => {state = apply(state,command,at);};
  const clockInAt = Date.parse('2026-12-01T20:00:00+09:00');
  applyCommand({type:'saveStaffAttendance',personId,date:'2026-12-01',clockInAt,clockOutAt:clockInAt + 120 * 60_000,breakMinutes:0,reason:'勤務'});
  const statementLayout = defaultPayrollStatementLayout().map((row) => row.key === 'summary' ? {...row,columns:4} : row);
  applyCommand({type:'savePayrollTemplate',name:'スタッフの計算',statementLayout,rules:[
    {label:'出勤手当',kind:'allowance',basis:'formula',left:'workdays',operator:'*',right:'number',rightValue:500},
    {label:'積立',kind:'deduction',basis:'hourlyPay',value:1000},
  ]});
  const templateId = state.payroll.templates.at(-1).id;
  applyCommand({type:'assignStaffPayrollTemplate',personId,templateId});
  applyCommand({type:'saveStaffPayrollDraft',personId,month:period});
  const pay = previewStaffPayroll(state,{personId,month:period});
  assert.deepEqual(pay.statementItems.map(({amount}) => amount),[500,480]);
  assert.equal(pay.net,4820);
  applyCommand({type:'finalizeStaffPayroll',personId,month:period,expectedNet:pay.net});
  const frozen = getStaffPayrollDraft(state,personId,period);
  assert.deepEqual(getStaffPayrollDraft(validateSnapshot(state),personId,period),frozen);
  assert.throws(() => apply(state,{type:'removePayrollTemplate',templateId},at),/使用中/);
  applyCommand({type:'assignStaffPayrollTemplate',personId,templateId:null});
  applyCommand({type:'saveStaffRate',personId,effectiveDate:'2026-12-01',hourlyRate:6000});
  assert.equal(previewStaffPayrollRange(state,{personId,start:'2026-11-15',end:'2026-12-01'}).snapshot.hourlyPay,9600);
  const own = getStaffOwnPayroll(state,'actual-staff','staff');
  const statement = own.records.find(({month}) => month === period);
  assert.equal(statement.snapshot.formulaContext,undefined);
  assert.deepEqual(statement.snapshot.settings,{statementLayout});
  assert.equal(statement.snapshot.net,4820);
  const api = {escape:String,yen:String,storeName:'テスト',icon:()=>'',button:String};
  const html = renderPayrollPrint(staffPayrollPrintRecord(statement),api);
  assert.match(html,/data-columns="4"/);
  assert.match(html,/出勤手当/);
  assert.match(renderOwnStaffPayroll(own,api),/2026-12の給与が確定しました/);
  assert.doesNotMatch(renderOwnStaffPayroll(own,api,new Set([period])),/2026-12の給与が確定しました/);
});
