import { normalizeEmployeeProfiles, payrollAttendanceItems, replaceAttendanceItems, saveEmployeeProfile } from './payroll-records.mjs';
import { advancedPayrollBases, calculateAdvancedPayrollRule, ensurePayrollVariableReferences, getPayrollVariables, getPayrollVariableValues,
  normalizeAdvancedPayrollRule, normalizeFormulaContext, normalizePayrollVariables, savePayrollVariables } from './payroll-formula.mjs';
import { getPayrollActualContext } from './payroll-actuals.mjs';

const dailyPayActions = new Set(['requestDailyPay', 'reviewDailyPay', 'payDailyPay']);
const payrollActions = new Set(['savePayrollDraft', 'finalizePayroll', 'savePayrollRate', 'savePayrollSettings',
  'savePayrollTemplate', 'assignPayrollTemplate', 'removePayrollTemplate', 'saveEmployeeProfile', 'saveAttendanceItems','savePayrollVariables', ...dailyPayActions]);
const paidStatuses = new Set(['paid', 'departed']);
const defaults = Object.freeze({ pointRate: 0, commissionRounding: 'nearest', commissionUnit: 1, dailyPayLimitBps: 8000 });
const statementBases = new Set(['fixed','hourlyPay','commission','pointPay','baseGross']);
const monthPattern = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/;
const maxYen = 100_000_000;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function isPayrollCommand(type) {
  return payrollActions.has(type);
}

export function isDailyPayCommand(type) {
  return dailyPayActions.has(type);
}

export function isPayrollMonth(month) {
  return typeof month === 'string' && monthPattern.test(month);
}

function isDate(date) {
  return typeof date === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date;
}

function integer(value, min, max, label) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, `${label}を${min}〜${max}の整数で入力してください。`);
  return value;
}

function money(value, label) {
  return integer(value, 0, maxYen, label);
}

function text(value, max, label) {
  check(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, `${label}を${max}文字以内で入力してください。`);
  return value.trim();
}

function castById(state, castId) {
  return typeof castId === 'string' && (state.cast.find(({ id }) => id === castId)
    ?? state.archivedCast?.find(({ id }) => id === castId));
}

export function getPayrollSettings(state) {
  const {statementRules = [], ...saved} = state.payroll?.settings ?? {};
  return { ...defaults, ...saved, statementRules:statementRules.map((row) => ({...row})) };
}

function normalizeStatementRules(rules) {
  check(Array.isArray(rules) && rules.length <= 20, '支給明細の計算項目は20件以内で登録してください。');
  return rules.map((row,index) => {
    check(isRecord(row) && ['allowance','deduction','intermediate'].includes(row.kind)
      && (statementBases.has(row.basis) || advancedPayrollBases.has(row.basis)),
      '支給明細の項目区分と計算方法を選択してください。');
    if (advancedPayrollBases.has(row.basis)) return {label:text(row.label,60,'支給明細の項目名'),kind:row.kind,basis:row.basis,
      ...normalizeAdvancedPayrollRule(row,index)};
    return {label:text(row.label,60,'支給明細の項目名'),kind:row.kind,basis:row.basis,
      value:row.basis === 'fixed' ? money(row.value,'支給明細の固定額') : integer(row.value,0,10_000,'支給明細の率の設定値')};
  });
}

export function getPayrollTemplates(state) {
  return state.payroll?.templates ?? [];
}

export function getPayrollTemplateAssignment(state, castId) {
  return (state.payroll?.templateAssignments ?? []).find((row) => row.castId === castId)?.templateId ?? null;
}

function normalizeTemplate(row) {
  check(isRecord(row), '計算テンプレートを確認してください。');
  return {id:text(row.id,128,'テンプレートID'), name:text(row.name,60,'テンプレート名'), rules:normalizeStatementRules(row.rules),
    ...(row.columns !== undefined && {columns:integer(row.columns,1,4,'支給明細の列数')}),
    ...(row.isDefault === true && {isDefault:true})};
}

function applyTemplateCommand(state, action, allocateId) {
  const templates = (state.payroll.templates ??= []);
  const assignments = (state.payroll.templateAssignments ??= []);
  const {templateId,castId} = action;
  const index = templates.findIndex(({id}) => id === templateId);
  if (action.type === 'assignPayrollTemplate') {
    check(castById(state,castId) && (templateId === null || index >= 0), 'キャストと計算テンプレートを選択してください。');
    state.payroll.templateAssignments = assignments.filter((row) => row.castId !== castId);
    if (templateId !== null) state.payroll.templateAssignments.push({castId,templateId});
    return;
  }
  check(templateId == null ? action.type === 'savePayrollTemplate' : index >= 0, '計算テンプレートが見つかりません。');
  if (action.type === 'removePayrollTemplate') {
    check(!assignments.some((row) => row.templateId === templateId), '使用中のテンプレートは、キャストの割り当てを変更してから削除してください。');
    templates.splice(index,1);
    return;
  }
  check(index >= 0 || templates.length < 20, '計算テンプレートは20件以内で登録してください。');
  const entry = normalizeTemplate({id:templateId ?? allocateId('pay-template'),name:action.name,rules:action.rules,
    columns:action.columns,isDefault:action.isDefault});
  ensurePayrollVariableReferences(entry.rules,getPayrollVariables(state));
  check(!templates.some((row) => row.id !== entry.id && row.name === entry.name), '同じ名前の計算テンプレートが登録されています。');
  if (entry.isDefault) for (const template of templates) delete template.isDefault;
  if (index >= 0) templates[index] = entry;
  else templates.push(entry);
}

function normalizeSettings(settings) {
  check(isRecord(settings) && ['floor', 'nearest'].includes(settings.commissionRounding)
    && [1, 10, 100, 1000].includes(settings.commissionUnit), '歩合の端数処理を指定してください。');
  return { pointRate: money(settings.pointRate, '1ポイントあたりの換金額'),
    commissionRounding: settings.commissionRounding, commissionUnit: settings.commissionUnit,
    dailyPayLimitBps:integer(settings.dailyPayLimitBps ?? defaults.dailyPayLimitBps,0,10000,'日払い上限率の設定値'),
    statementRules:normalizeStatementRules(settings.statementRules === undefined ? [] : settings.statementRules) };
}

export function getPayrollRates(state, castId) {
  return (state.payroll?.rates ?? []).filter((row) => row.castId === castId)
    .sort((first, second) => first.effectiveDate.localeCompare(second.effectiveDate));
}

export function getPayrollDraft(state, month, castId) {
  return state.payroll?.records.find((row) => row.month === month && row.castId === castId) ?? null;
}

export function getPayrollDailyPays(state, { month, castId } = {}) {
  return (state.payroll?.dailyPays ?? []).filter((row) => (!month || row.month === month) && (!castId || row.castId === castId))
    .sort((first, second) => second.requestedAt - first.requestedAt);
}

export function getDailyPayByDate(state) {
  if (!state.payroll) return state.dailyPayByDate ?? {};
  const totals = Object.create(null);
  for (const record of state.payroll?.dailyPays ?? []) {
    if (record.status !== 'paid') continue;
    const row = (totals[record.paidDate] ??= {cash:0,bank:0});
    row[record.method] += record.amount;
  }
  return totals;
}

export function getDailyPayTotals(state, date) {
  return getDailyPayByDate(state)[date] ?? {cash:0,bank:0};
}

function normalizeWork(input, month) {
  check(Array.isArray(input) && input.length <= 31, '勤務日を31件以内で入力してください。');
  const seen = new Set();
  const work = input.map((row) => {
    check(isRecord(row) && isDate(row.date) && row.date.slice(0, 7) === month, '給与期間内の勤務日を指定してください。');
    check(!seen.has(row.date), '同じ勤務日が重複しています。');
    seen.add(row.date);
    return { date: row.date, minutes: integer(row.minutes, 0, 24 * 60, '1日の勤務分数') };
  });
  return work.sort((first, second) => first.date.localeCompare(second.date));
}

function normalizeItems(input, label) {
  check(Array.isArray(input) && input.length <= 20, `${label}を20件以内で入力してください。`);
  return input.map((row) => {
    check(isRecord(row), `${label}を確認してください。`);
    return { label: text(row.label, 60, `${label}の項目名`), amount: money(row.amount, `${label}の金額`) };
  });
}

function normalizeInputs(state, input) {
  const { month, castId, work = [], allowances = [], deductions = [], manualAdvance = 0 } = input;
  check(isPayrollMonth(month), '給与期間を指定してください。');
  check(castById(state, castId), '給与の対象キャストを選択してください。');
  return { month, castId, work: normalizeWork(work, month), allowances: normalizeItems(allowances, '手当'),
    deductions: normalizeItems(deductions, '控除'), manualAdvance: money(manualAdvance, '日払い済み額') };
}

function settledTickets(state, month, includes = () => true, unavailable = []) {
  const tickets = new Map();
  const legacy = [];
  for (const day of state.closedDays) {
    if (day.date.slice(0, 7) !== month || !includes(day.date)) continue;
    const current = day.date === state.day.date && state.tickets.length ? state.tickets : null;
    const snapshots = (current ?? day.ticketSnapshots)
      ?.filter(({status}) => paidStatuses.has(status));
    const incomplete = !snapshots || (day.tickets != null && snapshots.length !== day.tickets)
      || snapshots.some(({settlement}) => !Array.isArray(settlement?.commission));
    if (incomplete && Array.isArray(day.commission)) {
      legacy.push({ settlement:{ commission:day.commission },legacyDate:day.date,legacyTicketCount:day.tickets });
      continue;
    }
    if (incomplete && day.tickets !== 0) unavailable.push(day.date);
    for (const ticket of snapshots ?? []) tickets.set(ticket.id, ticket);
  }
  if (state.day.date.slice(0, 7) === month && includes(state.day.date)
    && !state.closedDays.some(({date}) => date === state.day.date)) {
    if (state.tickets.some(({status,settlement})=>paidStatuses.has(status) && !Array.isArray(settlement?.commission))) unavailable.push(state.day.date);
    for (const ticket of state.tickets) tickets.set(ticket.id, ticket);
  }
  return [...tickets.values()].filter(({status, settlement}) => paidStatuses.has(status)
    && Array.isArray(settlement?.commission)).concat(legacy);
}

function confirmedCommission(tickets, castId) {
  const detailByName = new Map();
  let rawCommission = 0;
  let pointUnits = 0;
  for (const { settlement } of tickets) {
    const entry = settlement.commission.find((row) => row.castId === castId);
    if (!entry) continue;
    rawCommission += entry.amount;
    pointUnits += Math.round(entry.points * 1000);
    const details = (settlement.commissionDetails ?? []).filter((row) => row.castId === castId);
    if (!details.length && Array.isArray(settlement.commissionDetails) && entry.amount === 0 && entry.points === 0) continue;
    const hasCompleteDetail = details.length && details.reduce((sum, row) => sum + row.amount, 0) === entry.amount
      && details.reduce((sum, row) => sum + Math.round(row.points * 1000), 0) === Math.round(entry.points * 1000);
    for (const { name, amount, points } of hasCompleteDetail ? details : [{ name:'確定歩合（旧伝票）', ...entry }]) {
      const subtotal = detailByName.get(name) ?? { name, amount:0, pointUnits:0 };
      subtotal.amount += amount;
      subtotal.pointUnits += Math.round(points * 1000);
      detailByName.set(name, subtotal);
    }
  }
  const commissionDetails = [...detailByName.values()].map(({name, amount, pointUnits}) => ({ name, amount, points:pointUnits / 1000 }));
  return { rawCommission, pointUnits, commissionDetails };
}

function normalizeRate(state, rate) {
  check(isRecord(rate) && castById(state, rate.castId) && isDate(rate.effectiveDate), 'キャストと時給の適用開始日を指定してください。');
  return { castId:rate.castId, effectiveDate:rate.effectiveDate, hourlyRate:money(rate.hourlyRate,'時給') };
}

// Manual entries take precedence when an approved attendance entry exists for the same business date.
function attendanceWork(state, month, castId, manualWork) {
  const work = new Map();
  for (const row of state.attendances ?? []) {
    if (row.castId !== castId || row.status !== 'approved' || typeof row.date !== 'string' || row.date.slice(0, 7) !== month) continue;
    if (Number.isInteger(row.minutes) && row.minutes >= 0 && row.minutes <= 24 * 60) {
      work.set(row.date, { date:row.date, minutes:row.minutes, source:'attendance' });
    }
  }
  for (const entry of manualWork) work.set(entry.date, { ...entry, source:'manual' });
  return [...work.values()].sort((first, second) => first.date.localeCompare(second.date));
}

function calculateStatementItems(settings, hourlyPay, commission, pointPay, context = {}) {
  const baseGross = hourlyPay + commission + pointPay;
  check([hourlyPay,commission,pointPay,baseGross].every((amount) => Number.isSafeInteger(amount) && amount >= 0),
    '給与の計算範囲を超えています。');
  const bases = {hourlyPay,commission,pointPay,baseGross,...context};
  const computed = [];
  for (const rule of settings.statementRules) {
    const amount = advancedPayrollBases.has(rule.basis) ? calculateAdvancedPayrollRule(rule,computed,bases)
      : rule.basis === 'fixed' ? rule.value : Number((BigInt(bases[rule.basis]) * BigInt(rule.value) + 5_000n) / 10_000n);
    check(Number.isSafeInteger(amount) && (rule.kind === 'intermediate' || amount >= 0), '支給・控除項目の計算額を確認してください。');
    computed.push({...rule,amount});
  }
  return computed;
}

function adjustmentTotals(allowances, deductions, statementItems) {
  const allowanceTotal = allowances.reduce((sum,row) => sum + row.amount,0)
    + statementItems.reduce((sum,row) => sum + (row.kind === 'allowance' ? row.amount : 0),0);
  const deductionTotal = deductions.reduce((sum,row) => sum + row.amount,0)
    + statementItems.reduce((sum,row) => sum + (row.kind === 'deduction' ? row.amount : 0),0);
  check([allowanceTotal,deductionTotal].every(Number.isSafeInteger), '給与の計算範囲を超えています。');
  return {allowanceTotal,deductionTotal};
}

function netPay(hourlyPay, commission, pointPay, allowanceTotal, deductionTotal, advance) {
  check(Number.isSafeInteger(advance), '給与の計算範囲を超えています。');
  const net = Number(BigInt(hourlyPay) + BigInt(commission) + BigInt(pointPay)
    + BigInt(allowanceTotal) - BigInt(deductionTotal) - BigInt(advance));
  check(Number.isSafeInteger(net), '給与の計算範囲を超えています。');
  return net;
}

export class MissingPayrollRateError extends Error {
  constructor(dates) {
    super(`${dates[0]}に適用する時給を登録してください。`);
    this.dates = dates;
  }
}

function ratedWork(state, month, castId, manualWork, includes = () => true) {
  const rates = getPayrollRates(state, castId);
  const missingDates = [];
  const work = attendanceWork(state, month, castId, manualWork).filter(({date}) => includes(date)).map(({ date, minutes, source }) => {
    const rate = rates.findLast((entry) => entry.effectiveDate <= date);
    if (minutes > 0 && !rate) missingDates.push(date);
    return { date, minutes, source, hourlyRate:rate?.hourlyRate ?? 0 };
  });
  return {work,missingDates};
}

function calculateDatedPay(work, {rawCommission,pointUnits}, attendanceItems, settings) {
  const minutes = work.reduce((sum, row) => sum + row.minutes, 0);
  const hourlyPay = Math.round(work.reduce((sum, row) => sum + row.minutes * row.hourlyRate, 0) / 60);
  const round = settings.commissionRounding === 'floor' ? Math.floor : Math.round;
  const commission = round(rawCommission / settings.commissionUnit) * settings.commissionUnit;
  const attendancePoints = attendanceItems.reduce((sum,row) => sum + (row.kind === 'points' ? row.amount : 0), 0);
  const totalPointUnits = pointUnits + attendancePoints * 1000;
  check(Number.isSafeInteger(totalPointUnits), 'ポイントの計算範囲を超えています。');
  const pointPay = Number((BigInt(totalPointUnits) * BigInt(settings.pointRate) + 500n) / 1000n);
  return {minutes,hourlyPay,commission,points:totalPointUnits / 1000,pointPay};
}

export function previewPayroll(state, input) {
  const record = normalizeInputs(state, input);
  const { month, castId, allowances, deductions, manualAdvance } = record;
  const {work,missingDates} = ratedWork(state,month,castId,record.work);
  if (missingDates.length) throw new MissingPayrollRateError(missingDates);
  const templateId = getPayrollTemplateAssignment(state,castId);
  const template = getPayrollTemplates(state).find(({id,isDefault}) => templateId ? id === templateId : isDefault);
  const settings = getPayrollSettings(state);
  if (template) settings.statementRules = template.rules.map((row) => ({...row}));
  const unavailableDates = [];
  const tickets = settledTickets(state,month,undefined,unavailableDates);
  const commissionData = confirmedCommission(tickets,castId);
  const {rawCommission,commissionDetails} = commissionData;
  const attendanceItems = payrollAttendanceItems(state,month,castId);
  const {minutes,hourlyPay,commission,points,pointPay} = calculateDatedPay(work,commissionData,attendanceItems,settings);
  const hasFormula = settings.statementRules.some(({basis}) => advancedPayrollBases.has(basis));
  const formulaContext = hasFormula ? {variables:getPayrollVariableValues(state,castId),
    ...getPayrollActualContext(state,{month,castId,work,tickets,unavailableDates,rules:settings.statementRules})} : null;
  const statementItems = calculateStatementItems(settings,hourlyPay,commission,pointPay,{...formulaContext,minutes,points});
  const {allowanceTotal,deductionTotal} = adjustmentTotals(allowances,deductions,[...statementItems,...attendanceItems]);
  const paidDailyPay = getPayrollDailyPays(state,{month,castId}).filter(({status}) => status === 'paid')
    .reduce((sum,row) => sum + row.amount, 0);
  const advance = manualAdvance + paidDailyPay;
  const net = netPay(hourlyPay,commission,pointPay,allowanceTotal,deductionTotal,advance);
  return { month, castId, castName:castById(state, castId).name, work, minutes, hourlyPay, rawCommission, commission,
    commissionDetails, points, pointPay, allowances, deductions, statementItems, allowanceTotal, deductionTotal, manualAdvance,
    paidDailyPay, advance, net, settings, ...(formulaContext && {formulaContext}),
    ...(attendanceItems.length && {attendanceItems}), ...(template && {templateName:template.name}),
    ...(template?.columns !== undefined && {templateColumns:template.columns}) };
}

export function previewPayrollRange(state, {start,end,castId}) {
  check(isDate(start) && isDate(end) && start <= end, '開始日と終了日を、日付の順に指定してください。');
  check(!castId || castById(state,castId), '給与の対象キャストを選択してください。');
  const includes = (date) => date >= start && date <= end;
  const people = castId ? [castById(state,castId)] : [...state.cast,...(state.archivedCast ?? [])];
  const payouts = getPayrollDailyPays(state,{castId}).filter(({status,paidDate}) => status === 'paid' && includes(paidDate));
  const dates = [state.day,...state.closedDays,...(state.attendances ?? []),...(state.castAttendance ?? [])].map(({date}) => date);
  for (const record of state.payroll?.records ?? []) dates.push(...(record.snapshot?.work ?? record.work).map(({date}) => date));
  const months = [...new Set(dates.filter(includes).map((date) => date.slice(0,7)))].sort();
  const unavailableDates = [];
  const ticketsByMonth = new Map(months.map((month) => [month,settledTickets(state,month,includes,unavailableDates)]));
  const settings = getPayrollSettings(state);
  const fields = ['minutes','hourlyPay','rawCommission','commission','points','pointPay','allowanceTotal','deductionTotal'];
  const rows = people.map(({id,name}) => {
    const work = [];
    const missingDates = [];
    const commissionDetails = [];
    const attendanceDetails = [];
    const pendingDates = [...new Set([...(state.castAttendance ?? []),...(state.attendances ?? [])].filter(({castId,date,status}) =>
      castId === id && includes(date) && ['open','pending'].includes(status)).map(({date}) => date))].sort();
    let hasActivity = false;
    const totals = Object.fromEntries(fields.map((key) => [key,0]));
    for (const month of months) {
      const record = getPayrollDraft(state,month,id);
      const part = record?.snapshot
        ? {work:record.snapshot.work.filter(({date}) => includes(date)),missingDates:[]}
        : ratedWork(state,month,id,record?.work ?? [],includes);
      const commissionData = confirmedCommission(ticketsByMonth.get(month),id);
      const attendanceItems = payrollAttendanceItems(state,month,id,includes);
      hasActivity ||= Boolean(part.work.length || commissionData.commissionDetails.length || attendanceItems.length);
      const pay = {...calculateDatedPay(part.work,commissionData,attendanceItems,record?.snapshot?.settings ?? settings),
        ...adjustmentTotals([],[],attendanceItems),rawCommission:commissionData.rawCommission};
      for (const key of fields) totals[key] += pay[key];
      work.push(...part.work);
      missingDates.push(...part.missingDates);
      commissionDetails.push(...commissionData.commissionDetails.map((row) => ({...row,month})));
      attendanceDetails.push(...attendanceItems.map((row) => ({...row,month})));
    }
    const advances = payouts.filter((row) => row.castId === id).sort((a,b) => a.paidDate.localeCompare(b.paidDate) || a.paidAt - b.paidAt);
    const advance = advances.reduce((sum,{amount}) => sum + amount,0);
    const {hourlyPay,commission,pointPay,allowanceTotal,deductionTotal} = totals;
    const net = missingDates.length || unavailableDates.length ? null
      : netPay(hourlyPay,commission,pointPay,allowanceTotal,deductionTotal,advance);
    return {castId:id,castName:name,work,missingDates,pendingDates,commissionDetails,attendanceDetails,...totals,advances,advance,net,
      hasActivity:hasActivity || Boolean(advances.length || pendingDates.length)};
  });
  const summed = [...fields,'advance','net'];
  const totals = Object.fromEntries(summed.map((key) => [key,rows.reduce((sum,row) => sum + (row[key] ?? 0),0)]));
  if (rows.some(({net}) => net === null)) totals.net = null;
  return {start,end,unavailableDates,totals,rows:rows.filter((row) => castId || row.hasActivity)};
}

export function getPayrollRangeStatements(state,range,castIds) {
  check(Array.isArray(castIds) && castIds.length && castIds.length === new Set(castIds).size,
    '出力するキャストを選択してください。');
  const result = previewPayrollRange(state,range);
  check(!result.unavailableDates.length,'指定期間の歩合データが不足しているため、参考明細を出力できません。');
  const byId = new Map(result.rows.map((row) => [row.castId,row]));
  return castIds.map((castId) => {
    const snapshot = byId.get(castId);
    check(snapshot?.hasActivity,'この期間に集計データのあるキャストを選択してください。');
    check(!snapshot.missingDates.length,`${snapshot.castName}の時給を登録してから参考明細を出力してください。`);
    check(!snapshot.pendingDates.length,`${snapshot.castName}の勤怠を確認してから参考明細を出力してください。`);
    return {start:result.start,end:result.end,snapshot};
  });
}

export function getDailyPayLimit(state, month, castId) {
  const draft = getPayrollDraft(state,month,castId);
  const pay = draft?.snapshot ?? previewPayroll(state,draft ?? {month,castId});
  const rateBps = getPayrollSettings(state).dailyPayLimitBps;
  const limit = Number(BigInt(pay.commission + pay.hourlyPay) * BigInt(rateBps) / 10000n);
  const committed = getPayrollDailyPays(state,{month,castId}).filter(({status}) => status !== 'rejected')
    .reduce((sum,row) => sum + row.amount, 0);
  return { limit, committed, rateBps };
}

function personalizedPay(state, input) {
  const { month, castId } = input;
  check(isPayrollMonth(month), '給与期間を指定してください。');
  check(castById(state, castId), '給与の対象キャストを選択してください。');
  return getPayrollDraft(state, month, castId);
}

function optionalReason(value) {
  if (value == null || value === '') return '';
  check(typeof value === 'string' && value.trim().length <= 120, '理由を120文字以内で入力してください。');
  return value.trim();
}

function applyDailyPayCommand(state, action, now, { allocateId, recordCashPayout }) {
  const dailyPays = (state.payroll.dailyPays ??= []);
  if (action.type === 'requestDailyPay') {
    const { castId, month } = action;
    check(personalizedPay(state,action)?.status !== 'final', '確定済みの給与期間では日払いを申請できません。');
    const amount = integer(action.amount,1,maxYen,'日払い申請額');
    const { limit, committed } = getDailyPayLimit(state,month,castId);
    const reason = optionalReason(action.reason);
    dailyPays.push({ id:allocateId(), castId, castName:castById(state,castId).name, month, amount,
      reason, requestedAt:now, status:'requested', exceededLimit:committed + amount > limit });
    return;
  }
  const record = dailyPays.find(({id}) => id === action.dailyPayId);
  check(record, '日払い申請が見つかりません。');
  check(getPayrollDraft(state,record.month,record.castId)?.status !== 'final', '確定済みの給与期間の日払いは変更できません。');
  if (action.type === 'reviewDailyPay') {
    const approve = action.decision === 'approve';
    check((approve && record.status === 'requested') || (action.decision === 'reject' && ['requested','approved'].includes(record.status)),
      '未支給の日払い申請を選択してください。');
    const { limit, committed } = getDailyPayLimit(state,record.month,record.castId);
    const needsReason = !approve || committed > limit;
    const reviewReason = optionalReason(action.reason);
    check(!needsReason || reviewReason, '却下または上限を超えて承認する理由を入力してください。');
    Object.assign(record,{status:approve ? 'approved' : 'rejected', reviewedAt:now, reviewReason});
    return;
  }
  check(record.status === 'approved', '承認済みの日払い申請を選択してください。');
  check(state.day.status === 'open', '営業中に日払いの支給を記録してください。');
  check(['cash','bank'].includes(action.method), '日払いの支給方法を選択してください。');
  const cashMovementId = action.method === 'cash' ? recordCashPayout(record.amount) : undefined;
  Object.assign(record,{status:'paid', paidAt:now, paidDate:state.day.date, method:action.method,
    ...(cashMovementId && {cashMovementId})});
}

export function applyPayrollCommand(state, action, now, actor, services) {
  check(actor.role === 'admin', '給与の操作には店舗管理者の権限が必要です。');
  state.payroll ??= { settings:getPayrollSettings(state), rates:[], records:[] };
  if (action.type === 'saveEmployeeProfile') {
    saveEmployeeProfile(state,action.castId,action.profile);
    return;
  }
  if (action.type === 'saveAttendanceItems') {
    replaceAttendanceItems(state,action.items,services.allocateId);
    return;
  }
  if (action.type === 'savePayrollVariables') {
    savePayrollVariables(state,action,services.allocateId);
    return;
  }
  if (isDailyPayCommand(action.type)) {
    applyDailyPayCommand(state,action,now,services);
    return;
  }
  if (action.type === 'savePayrollSettings') {
    const settings = normalizeSettings({ ...getPayrollSettings(state), ...action.settings });
    ensurePayrollVariableReferences(settings.statementRules,getPayrollVariables(state));
    state.payroll.settings = settings;
    return;
  }
  if (['savePayrollTemplate','assignPayrollTemplate','removePayrollTemplate'].includes(action.type)) {
    applyTemplateCommand(state,action,services.allocateId);
    return;
  }
  if (action.type === 'savePayrollRate') {
    const rate = normalizeRate(state, action);
    const index = state.payroll.rates.findIndex((row) => row.castId === rate.castId && row.effectiveDate === rate.effectiveDate);
    if (index >= 0) state.payroll.rates[index] = rate;
    else state.payroll.rates.push(rate);
    return;
  }
  const previous = personalizedPay(state, action);
  check(previous?.status !== 'final', '確定済みの給与は翌月の調整項目で訂正してください。');
  if (action.type === 'finalizePayroll') {
    check(previous, '給与の下書きを保存してから確定してください。');
    const {month,castId} = previous;
    check(!(state.castAttendance ?? []).some((row) => row.castId === castId && row.date.slice(0,7) === month
      && ['open','pending'].includes(row.status)), 'この給与期間に未確認の勤怠があります。退勤または勤怠確認を済ませてください。');
    check(!getPayrollDailyPays(state,{month,castId}).some(({status}) => ['requested','approved'].includes(status)),
      'この給与期間に未処理の日払いがあります。支給または却下を記録してください。');
    const snapshot = previewPayroll(state, previous);
    check(snapshot.net >= 0, '支給額がマイナスです。手当・控除・日払い済み額を確認してください。');
    Object.assign(previous, { status:'final', finalizedAt:now, snapshot });
    return;
  }
  const record = normalizeInputs(state, action);
  previewPayroll(state, record);
  const draft = { ...record, status:'draft', updatedAt:now };
  if (previous) state.payroll.records[state.payroll.records.indexOf(previous)] = draft;
  else state.payroll.records.push(draft);
}

function normalizeFinalSnapshot(state, record, snapshot) {
  check(isRecord(snapshot) && snapshot.month === record.month && snapshot.castId === record.castId,
    '給与の確定明細を確認してください。');
  const { work, hourlyPay, rawCommission, commission, commissionDetails, points, pointPay, advance, net } = snapshot;
  const settings = normalizeSettings(snapshot.settings);
  const templateName = snapshot.templateName === undefined ? undefined : text(snapshot.templateName,60,'テンプレート名');
  const templateColumns = snapshot.templateColumns === undefined ? undefined : integer(snapshot.templateColumns,1,4,'支給明細の列数');
  const castName = text(snapshot.castName, 60, 'キャスト名');
  const normalizedWork = normalizeWork(work,record.month).map((entry,index) => {
    // Stored rows are always sorted. Preserve the source and rate instead of using today's settings.
    const row = work[index];
    check(row.date === entry.date && ['manual','attendance'].includes(row.source), '確定済みの勤務を確認してください。');
    return { ...entry, source:row.source, hourlyRate:money(row.hourlyRate,'時給') };
  });
  const minutes = normalizedWork.reduce((sum, row) => sum + row.minutes, 0);
  const hasFormula = settings.statementRules.some(({basis}) => advancedPayrollBases.has(basis));
  const formulaContext = hasFormula ? normalizeFormulaContext(snapshot.formulaContext,settings.statementRules) : null;
  const statementItems = calculateStatementItems(settings,hourlyPay,commission,pointPay,{...formulaContext,minutes,points});
  const attendanceItems = snapshot.attendanceItems ?? [];
  check(Array.isArray(attendanceItems) && attendanceItems.length <= 1550,'確定済みの勤怠項目を確認してください。');
  const normalizedAttendanceItems = attendanceItems.map((row) => {
    check(isRecord(row) && ['allowance','deduction','points'].includes(row.kind),'確定済みの勤怠項目を確認してください。');
    return {kind:row.kind,label:text(row.label,60,'勤怠項目'),amount:integer(row.amount,0,Number.MAX_SAFE_INTEGER,'勤怠項目')};
  });
  const {allowanceTotal,deductionTotal} = adjustmentTotals(record.allowances,record.deductions,[...statementItems,...normalizedAttendanceItems]);
  const savedItems = snapshot.statementItems === undefined ? [] : snapshot.statementItems;
  check(Array.isArray(savedItems) && savedItems.length === statementItems.length
    && statementItems.every((expected,index) => isRecord(savedItems[index])
      && Object.entries(expected).every(([key,value]) => savedItems[index][key] === value)),
  '確定済みの支給明細の計算項目を確認してください。');
  const paidDailyPay = snapshot.paidDailyPay ?? 0;
  check([hourlyPay,rawCommission,commission,pointPay,advance,net].every((value) => Number.isSafeInteger(value) && value >= 0)
    && Number.isFinite(points) && points >= 0 && Array.isArray(commissionDetails)
    && snapshot.minutes === minutes
    && Number.isSafeInteger(paidDailyPay) && paidDailyPay >= 0 && advance === record.manualAdvance + paidDailyPay
    && net === netPay(hourlyPay,commission,pointPay,allowanceTotal,deductionTotal,advance), '確定済みの支給額を確認してください。');
  const detail = commissionDetails.map((row) => {
    check(isRecord(row) && Number.isSafeInteger(row.amount) && row.amount >= 0 && Number.isFinite(row.points) && row.points >= 0,
      '確定済みの歩合を確認してください。');
    return { name:text(row.name, 120,'歩合の項目'), amount:row.amount, points:row.points };
  });
  return { month:record.month, castId:record.castId, castName, work:normalizedWork, minutes, hourlyPay, rawCommission, commission,
    commissionDetails:detail, points, pointPay, allowances:record.allowances, deductions:record.deductions, statementItems,
    allowanceTotal, deductionTotal, manualAdvance:record.manualAdvance, paidDailyPay, advance, net, settings,
    ...(normalizedAttendanceItems.length && {attendanceItems:normalizedAttendanceItems}),
    ...(formulaContext && {formulaContext}),
    ...(templateName !== undefined && {templateName}), ...(templateColumns !== undefined && {templateColumns}) };
}

function normalizeDailyPay(state, row, cashById) {
  check(isRecord(row) && ['requested','approved','rejected','paid'].includes(row.status), '日払いの状態を確認してください。');
  personalizedPay(state,row);
  const { status, month, castId } = row;
  const requestedAt = integer(row.requestedAt,0,Number.MAX_SAFE_INTEGER,'申請日時');
  const record = { id:text(row.id,128,'申請ID'), castId, castName:text(row.castName,60,'キャスト名'),
    month, amount:integer(row.amount,1,maxYen,'日払い申請額'), reason:optionalReason(row.reason),
    requestedAt, status, exceededLimit:row.exceededLimit === true };
  if (status === 'requested') return record;
  record.reviewedAt = integer(row.reviewedAt,requestedAt,Number.MAX_SAFE_INTEGER,'審査日時');
  record.reviewReason = optionalReason(row.reviewReason);
  if (status === 'rejected') check(record.reviewReason, '却下理由を確認してください。');
  if (status !== 'paid') return record;

  check(isDate(row.paidDate) && ['cash','bank'].includes(row.method), '日払いの支給記録を確認してください。');
  record.method = row.method;
  record.paidAt = integer(row.paidAt,record.reviewedAt,Number.MAX_SAFE_INTEGER,'支給日時');
  record.paidDate = row.paidDate;
  if (row.method === 'cash') {
    const cash = cashById.get(row.cashMovementId);
    check(cash?.amount === record.amount && cash.date === record.paidDate && cash.kind === 'withdrawal' && cash.at === record.paidAt,
      '現金の日払いを入出金履歴で確認してください。');
    record.cashMovementId = cash.id;
  }
  return record;
}

export function normalizePayrollSnapshot(state) {
  const payroll = state.payroll;
  if (payroll === undefined) return undefined;
  check(isRecord(payroll) && Array.isArray(payroll.rates) && Array.isArray(payroll.records)
    && (payroll.dailyPays === undefined || Array.isArray(payroll.dailyPays)), '給与データを読み込めません。');
  const rates = payroll.rates.map((row) => normalizeRate(state, row));
  const records = payroll.records.map((row) => {
    check(isRecord(row) && ['draft','final'].includes(row.status), '給与の状態を確認してください。');
    const record = { ...normalizeInputs(state, row), status:row.status,
      updatedAt:integer(row.updatedAt,0,Number.MAX_SAFE_INTEGER,'保存日時') };
    if (row.status === 'final') {
      record.finalizedAt = integer(row.finalizedAt,record.updatedAt,Number.MAX_SAFE_INTEGER,'確定日時');
      record.snapshot = normalizeFinalSnapshot(state,record,row.snapshot);
    }
    return record;
  });
  const cashById = new Map(state.closedDays.flatMap((day) => day.cashMovements ?? []).concat(state.cashMovements ?? [])
    .map((row) => [row.id,row]));
  const dailyPays = (payroll.dailyPays ?? []).map((row) => normalizeDailyPay(state,row,cashById));
  const cashIds = dailyPays.flatMap((row) => row.cashMovementId ? [row.cashMovementId] : []);
  check(new Set(dailyPays.map(({id}) => id)).size === dailyPays.length && new Set(cashIds).size === cashIds.length,
    '日払いの申請または出金が重複しています。');
  for (const {month,castId,snapshot} of records) {
    if (!snapshot) continue;
    const linked = dailyPays.filter((row) => row.month === month && row.castId === castId && row.status !== 'rejected');
    check(linked.every((row) => row.status === 'paid') && linked.reduce((sum,row) => sum + row.amount,0) === snapshot.paidDailyPay,
      '確定済み給与と日払い支給の合計を確認してください。');
  }
  check(new Set(rates.map(({castId,effectiveDate}) => JSON.stringify([castId,effectiveDate]))).size === rates.length
    && new Set(records.map(({castId,month}) => JSON.stringify([castId,month]))).size === records.length,
  '給与の期間または時給の適用日が重複しています。');
  const templates = payroll.templates === undefined ? [] : payroll.templates;
  const assignments = payroll.templateAssignments === undefined ? [] : payroll.templateAssignments;
  check(Array.isArray(templates) && templates.length <= 20 && Array.isArray(assignments), '給与テンプレートを確認してください。');
  const normalizedTemplates = templates.map(normalizeTemplate);
  const templateIds = new Set(normalizedTemplates.map(({id}) => id));
  check(templateIds.size === templates.length && new Set(normalizedTemplates.map(({name}) => name)).size === templates.length,
    '給与テンプレートの名前またはIDが重複しています。');
  const templateAssignments = assignments.map((row) => {
    check(isRecord(row) && castById(state,row.castId) && templateIds.has(row.templateId), '給与テンプレートの割り当てを確認してください。');
    return {castId:row.castId,templateId:row.templateId};
  });
  check(new Set(templateAssignments.map(({castId}) => castId)).size === assignments.length, '同じキャストに複数の給与テンプレートが割り当てられています。');
  return { settings:normalizeSettings(payroll.settings), rates, records, dailyPays,
    ...(payroll.variables !== undefined && {variables:normalizePayrollVariables(state,payroll.variables)}),
    ...(payroll.employeeProfiles !== undefined && {employeeProfiles:normalizeEmployeeProfiles(state,payroll.employeeProfiles)}),
    ...(payroll.templates !== undefined && {templates:normalizedTemplates}),
    ...(payroll.templateAssignments !== undefined && {templateAssignments}) };
}

export function normalizeAttendanceSnapshot(state) {
  if (state.attendances === undefined) return undefined;
  check(Array.isArray(state.attendances), '勤怠データを読み込めません。');
  const records = state.attendances.map((row) => {
    check(isRecord(row) && castById(state,row.castId) && isDate(row.date) && ['pending','approved'].includes(row.status),
      '勤怠のキャスト・営業日・承認状態を確認してください。');
    return { castId:row.castId, date:row.date, minutes:integer(row.minutes,0,24 * 60,'1日の勤務分数'), status:row.status };
  });
  check(new Set(records.map(({castId,date}) => JSON.stringify([castId,date]))).size === records.length,
    '同じキャストの勤怠が同じ営業日に重複しています。');
  return records;
}
