import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createDemo } from '../docs/engine.mjs';
import { createLaborDemo } from '../docs/phase-two-demo.mjs';
import { getStaffOwnPayroll, getStaffPayrollDraft, previewStaffPayroll } from '../docs/staff-payroll.mjs';
import { staffPayrollPrintRecord } from '../docs/staff-payroll-ui.mjs';
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
