import { findLinkedStaffPerson, getStaffLabor, isLaborDate } from './labor-workspace.mjs';
import { calculateStatementItems, getPayrollRates, getPayrollTemplates, isPayrollMonth, MissingPayrollRateError, normalizeStatementRules } from './payroll.mjs';
import { getPayrollVariableValues, normalizeFormulaContext, usedPayrollActualKeys } from './payroll-formula.mjs';
import { normalizePayrollStatementLayout } from './payroll-statement-layout.mjs';
import { canDelegatePayroll, roleLabel } from './role-policy.mjs';

export const staffPayrollMemberRoles = Object.freeze(['manager','staff']);
const commands = new Set(['saveStaffPayrollDraft','finalizeStaffPayroll','bindStaffPayrollAccount','assignStaffPayrollTemplate']);
const yenLimit = 100_000_000;
export const staffPayRangeNote = '勤務日と時給から算出した参考額です。月次の手当・控除と計算テンプレートの金額は、各月の支給明細で確認してください。';

function check(condition,message) {
  if (!condition) throw new Error(message);
}

const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value;
const validYen = (value) => Number.isSafeInteger(value) && value >= 0 && value <= yenLimit;

function text(value,limit) {
  check(typeof value === 'string' && value.trim() && value.trim().length <= limit && !/[\p{Cc}\u2028\u2029]/u.test(value),`項目名は${limit}文字以内で入力してください。`);
  return value.trim();
}

export function isStaffPayrollCommand(type) {
  return commands.has(type);
}

export function getStaffPayrollDraft(state,personId,month) {
  return (state.staffPayroll?.records ?? []).find((row) => row.personId === personId && row.month === month) ?? null;
}

function normalizeMoneyRows(rows) {
  check(Array.isArray(rows) && rows.length <= 20,'手当・控除はそれぞれ20件以内で指定してください。');
  return rows.map((row) => {
    check(row && validYen(row.amount),'手当・控除の金額は0円以上の整数で入力してください。');
    return {label:text(row.label,60),amount:row.amount};
  });
}

function normalizeDraft({personId,month,allowances = [],deductions = []}, people) {
  check(validId(personId) && people.some(({id}) => id === personId) && isPayrollMonth(month),'勤務者と給与月を確認してください。');
  return {personId,month,allowances:normalizeMoneyRows(allowances),deductions:normalizeMoneyRows(deductions)};
}

function hourlyTotals(work) {
  const minutes = work.reduce((sum,row) => sum + row.minutes,0);
  const hourlyPay = Math.round(work.reduce((sum,row) => sum + row.minutes * row.hourlyRate,0) / 60);
  return {minutes,hourlyPay};
}

function totals(work, allowances, deductions, statementItems = []) {
  const {minutes,hourlyPay} = hourlyTotals(work);
  const allowanceTotal = allowances.reduce((sum,row) => sum + row.amount,0)
    + statementItems.reduce((sum,row) => sum + (row.kind === 'allowance' ? row.amount : 0),0);
  const deductionTotal = deductions.reduce((sum,row) => sum + row.amount,0)
    + statementItems.reduce((sum,row) => sum + (row.kind === 'deduction' ? row.amount : 0),0);
  return {minutes,hourlyPay,allowanceTotal,deductionTotal,net:hourlyPay + allowanceTotal - deductionTotal};
}

function staffWork(state, personId, start, end) {
  const {rates,attendance} = getStaffLabor(state);
  const wageHistory = rates.filter((row) => row.personId === personId).sort((a,b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const attendanceRows = attendance.filter((row) => row.personId === personId && row.date >= start && row.date <= end && row.voidedAt === undefined)
    .sort((a,b) => a.date.localeCompare(b.date));
  check(!attendanceRows.some((row) => row.clockOutAt === null),'給与を確定する前に対象月の未退勤を確認してください。');
  const dailyMinutes = new Map();
  for (const row of attendanceRows) dailyMinutes.set(row.date,(dailyMinutes.get(row.date) ?? 0) + row.minutes);
  const missing = [];
  const work = [...dailyMinutes].map(([date,minutes]) => {
    const hourlyRate = wageHistory.findLast(({effectiveDate}) => effectiveDate <= date)?.hourlyRate;
    if (hourlyRate === undefined && minutes > 0) missing.push(date);
    return {date,minutes,hourlyRate:hourlyRate ?? 0,source:'attendance'};
  });
  if (missing.length) throw new MissingPayrollRateError(missing);
  return work;
}

export function getStaffPayrollTemplateId(state,personId) {
  return state.staffPayroll?.templateAssignments?.find((row) => row.personId === personId)?.templateId ?? null;
}

function templateItems(settings,work,formulaContext) {
  const {minutes,hourlyPay} = hourlyTotals(work);
  return calculateStatementItems(settings,hourlyPay,0,0,{...formulaContext,minutes,points:0});
}

export function previewStaffPayroll(state, input) {
  const {people} = getStaffLabor(state);
  const {personId,month,allowances,deductions} = normalizeDraft(input,people);
  const person = people.find(({id}) => id === personId);
  const work = staffWork(state,personId,`${month}-01`,`${month}-31`);
  const templateId = getStaffPayrollTemplateId(state,personId);
  const template = getPayrollTemplates(state).find(({id}) => id === templateId);
  const settings = template && {statementRules:template.rules,...(template.statementLayout && {statementLayout:template.statementLayout})};
  const keys = settings ? usedPayrollActualKeys(settings.statementRules) : [];
  const workdays = work.filter(({minutes}) => minutes > 0).length;
  const formulaContext = settings && {variables:getPayrollVariableValues(state),
    ...(keys.length && {actuals:Object.fromEntries(keys.map((key) => [key,key === 'workdays' ? workdays : 0])),
      actualLabels:Object.fromEntries(keys.map((key) => [key,key === 'workdays' ? '勤務日数' : 'スタッフ給与の対象外']))})};
  const statementItems = settings && templateItems(settings,work,formulaContext);
  return {personId,month,personName:person.name,roleName:roleLabel(state,person.role,person.profileId),work,allowances,deductions,
    ...(template && {settings,formulaContext,statementItems,templateName:template.name}),
    ...totals(work,allowances,deductions,statementItems ?? [])};
}

export function previewStaffPayrollRange(state,{personId,start,end}) {
  check(isLaborDate(start) && isLaborDate(end) && start <= end,'開始営業日と終了営業日を、日付の順に指定してください。');
  const person = getStaffLabor(state).people.find(({id}) => id === personId);
  check(person,'勤務者を選択してください。');
  const included = ({date}) => date >= start && date <= end;
  const frozen = new Map((state.staffPayroll?.records ?? []).filter((row) => row.personId === personId && row.status === 'final')
    .map(({month,snapshot}) => [month,snapshot.work.filter(included)]));
  const months = new Set(getStaffLabor(state).attendance.filter((row) => row.personId === personId && row.voidedAt === undefined && included(row))
    .map(({date}) => date.slice(0,7)));
  for (const [month,work] of frozen) if (work.length) months.add(month);
  const snapshot = {personId,personName:person.name,work:[],minutes:0,hourlyPay:0};
  for (const month of [...months].sort()) {
    const first = `${month}-01`;
    const last = `${month}-31`;
    const part = frozen.get(month) ?? staffWork(state,personId,start > first ? start : first,end < last ? end : last);
    const {minutes,hourlyPay} = hourlyTotals(part);
    snapshot.work.push(...part);
    snapshot.minutes += minutes;
    snapshot.hourlyPay += hourlyPay;
  }
  return {start,end,snapshot};
}

function bind(state, action) {
  const {memberUid:uid,personId} = action;
  check(validId(uid),'参加済みの従業員アカウントを選択してください。');
  const links = state.staffPayroll.links ?? [];
  if (personId !== null) {
    const person = getStaffLabor(state).people.find(({id}) => id === personId);
    check(person?.enabled && staffPayrollMemberRoles.includes(person.role),'在籍中のスタッフまたはマネージャーを選択してください。');
    check(!links.some((link) => link.uid !== uid && link.personId === personId),'この勤務者は別のアカウントに連携済みです。');
  }
  state.staffPayroll.links = links.filter((link) => link.uid !== uid);
  if (personId !== null) state.staffPayroll.links.push({uid,personId});
}

export function applyStaffPayrollCommand(state,action,now,actor) {
  check(actor.role === 'admin','給与の確定とアカウントのひもづけには管理者権限が必要です。');
  state.staffPayroll ??= {records:[]};
  if (action.type === 'bindStaffPayrollAccount') {
    bind(state,action);
    return;
  }
  if (action.type === 'assignStaffPayrollTemplate') {
    const {personId,templateId} = action;
    check(getStaffLabor(state).people.some(({id}) => id === personId)
      && (templateId === null || getPayrollTemplates(state).some(({id}) => id === templateId)),'勤務者と計算テンプレートを確認してください。');
    const assignments = (state.staffPayroll.templateAssignments ?? []).filter((row) => row.personId !== personId);
    if (templateId !== null) assignments.push({personId,templateId});
    state.staffPayroll.templateAssignments = assignments;
    return;
  }
  const records = state.staffPayroll.records;
  const previous = getStaffPayrollDraft(state,action.personId,action.month);
  check(previous?.status !== 'final','確定済みの支給明細は変更できません。');
  const draft = {...normalizeDraft(action,getStaffLabor(state).people),status:'draft'};
  if (action.type === 'finalizeStaffPayroll') {
    check(previous,'給与の下書きを保存してください。');
    const snapshot = previewStaffPayroll(state,previous);
    check(action.expectedNet === snapshot.net,'支給合計が更新されました。最新の試算を確認してください。');
    check(snapshot.net >= 0,'支給合計がマイナスです。手当・控除を確認してください。');
    Object.assign(draft,previous,{status:'final',snapshot,finalizedAt:now});
  }
  state.staffPayroll.records = records.filter((row) => row !== previous).concat(draft);
}

export function normalizeStaffPayrollSnapshot(state) {
  if (state.staffPayroll === undefined) return undefined;
  check(Array.isArray(state.staffPayroll?.records),'役職別給与データを確認してください。');
  const people = getStaffLabor(state).people;
  const records = state.staffPayroll.records.map((record) => {
    const draft = normalizeDraft(record,people);
    check(['draft','final'].includes(record.status),'給与の状態を確認してください。');
    if (record.status === 'draft') return {...draft,status:'draft'};
    const {snapshot,finalizedAt} = record;
    check(snapshot && Number.isSafeInteger(finalizedAt) && finalizedAt > 0 && Array.isArray(snapshot.work)
      && snapshot.work.length <= 31,'確定済み給与の明細を確認してください。');
    const work = snapshot.work.map(({date,minutes,hourlyRate}) => {
      check(isLaborDate(date) && date.startsWith(draft.month) && Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 1440
        && validYen(hourlyRate),'確定済み給与の勤務時間と時給を確認してください。');
      return {date,minutes,hourlyRate,source:'attendance'};
    });
    check(new Set(work.map(({date}) => date)).size === work.length,'給与明細の勤務日が重複しています。');
    let template = {};
    if (snapshot.settings !== undefined) {
      const statementRules = normalizeStatementRules(snapshot.settings.statementRules);
      const statementLayout = normalizePayrollStatementLayout(snapshot.settings.statementLayout);
      const settings = {statementRules,...(statementLayout && {statementLayout})};
      const formulaContext = normalizeFormulaContext(snapshot.formulaContext,statementRules);
      template = {settings,formulaContext,statementItems:templateItems(settings,work,formulaContext),templateName:text(snapshot.templateName,60)};
    }
    const calculated = totals(work,draft.allowances,draft.deductions,template.statementItems);
    check(Object.entries(calculated).every(([key,value]) => snapshot[key] === value),'確定済み給与の支給額を確認してください。');
    return {...draft,status:'final',finalizedAt,snapshot:{...draft,work,...calculated,...template,
      personName:text(snapshot.personName,60),roleName:text(snapshot.roleName,60)}};
  });
  check(new Set(records.map(({personId,month}) => JSON.stringify([personId,month]))).size === records.length,'同じ月の給与が重複しています。');
  // Browser backups never restore account bindings to another store.
  const {templateAssignments} = state.staffPayroll;
  if (templateAssignments === undefined) return {records};
  const templateIds = new Set(getPayrollTemplates(state).map(({id}) => id));
  const personIds = new Set(people.map(({id}) => id));
  check(Array.isArray(templateAssignments) && templateAssignments.every((entry) => personIds.has(entry?.personId) && templateIds.has(entry?.templateId))
    && new Set(templateAssignments.map(({personId}) => personId)).size === templateAssignments.length,'従業員の計算テンプレートの割り当てを確認してください。');
  return {records,templateAssignments:templateAssignments.map(({personId,templateId}) => ({personId,templateId}))};
}

export function getStaffOwnPayroll(state,uid,role) {
  if (!staffPayrollMemberRoles.includes(role)) return null;
  const person = findLinkedStaffPerson(state,uid,role);
  if (!person) return null;
  const records = state.staffPayroll.records.filter(({personId,status}) => personId === person.id && status === 'final')
    .map((record) => ({...record,snapshot:visibleStatement(record.snapshot,true)}));
  const attendance = getStaffLabor(state).attendance.filter(({personId,voidedAt}) => personId === person.id && voidedAt === undefined)
    .sort((first,second) => (second.clockOutAt === null) - (first.clockOutAt === null) || second.clockInAt - first.clockInAt)
    .slice(0,20).map(({date,clockInAt,clockOutAt}) => ({date,clockInAt,clockOutAt}));
  return {person:{id:person.id,name:person.name},records,attendance};
}

function visibleStatement({work,settings,formulaContext,statementItems,...snapshot},showRates) {
  return {...snapshot,work:showRates ? work : [],...(!showRates && {workWithheld:true}),
    ...(settings?.statementLayout && {settings:{statementLayout:settings.statementLayout}}),
    ...(statementItems && {statementItems:statementItems.filter(({kind}) => kind !== 'intermediate')
      .map(({label,kind,amount}) => ({label,kind,amount}))})};
}

export function getStaffPayrollDelegation(state,role,profileId) {
  const canRead = canDelegatePayroll(state,role,profileId,'viewPayslips');
  const canReadRates = canDelegatePayroll(state,role,profileId,'viewHourlyRates');
  const canEditRates = canDelegatePayroll(state,role,profileId,'editHourlyRates');
  if (!canRead && !canReadRates && !canEditRates) return null;
  const staff = getStaffLabor(state);
  const people = role === 'admin' ? staff.people : staff.people.filter(({role}) => role !== 'admin');
  const ids = new Set(people.map(({id}) => id));
  const cast = [...state.cast,...(state.archivedCast ?? [])];
  const records = canRead ? (state.staffPayroll?.records ?? []).filter(({status,personId}) => status === 'final' && ids.has(personId))
    .map(({month,personId,finalizedAt,snapshot}) => ({month,personId,finalizedAt,status:'final',snapshot:visibleStatement(snapshot,canReadRates)})) : [];
  const castRecords = canRead ? (state.payroll?.records ?? []).filter(({status}) => status === 'final')
    .map(({month,castId,finalizedAt,snapshot}) => {
      const {castName,work,minutes,hourlyPay,commission,commissionDetails,points,pointPay,allowances,deductions,allowanceTotal,deductionTotal,advance,net} = snapshot;
      return {month,castId,finalizedAt,snapshot:visibleStatement({castName,work,minutes,hourlyPay,commission,pointPay,
        commissionDetails,points,allowances,deductions,allowanceTotal,deductionTotal,advance,net},canReadRates)};
    }) : [];
  return {people:people.map(({id,name,role,profileId,enabled}) => ({id,name,role,profileId,enabled})),
    cast:cast.map(({id,name}) => ({id,name})),records,castRecords,
    ...(canReadRates && {rates:staff.rates.filter(({personId}) => ids.has(personId)),castRates:cast.flatMap(({id}) => getPayrollRates(state,id))})};
}
