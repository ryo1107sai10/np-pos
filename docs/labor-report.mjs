import { encodeCsv } from './csv-file.mjs';
import { getStaffLabor, isLaborDate } from './labor-workspace.mjs';
import { previewPayrollRange } from './payroll.mjs';
import { getReportPeriod } from './report-period.mjs';

const roleKey = (row) => row.profileId ?? row.role;
const duration = new Intl.NumberFormat('ja-JP',{maximumFractionDigits:2});
const localTime = (at) => at ? new Date(at + 32_400_000).toISOString().slice(0,16).replace('T',' ') : '';

function staffWork(state,start,end) {
  const {attendance,rates} = getStaffLabor(state);
  const sorted = rates.slice().sort((a,b) => a.effectiveDate.localeCompare(b.effectiveDate));
  return attendance.filter(({date,voidedAt,clockOutAt})=>voidedAt === undefined && clockOutAt !== null && date >= start && date <= end).map((row)=>{
    const {date,personId,minutes} = row;
    const rate = sorted.findLast((entry)=>entry.personId === personId && entry.effectiveDate <= date)?.hourlyRate;
    return {...row,source:'staff',roleKey:roleKey(row),hourlyRate:rate ?? null,baseNumerator:rate == null && minutes > 0 ? null : minutes * (rate ?? 0)};
  });
}

function castWork(state,start,end) {
  const pay = previewPayrollRange(state,{start,end});
  const punches = new Map();
  for (const row of state.castAttendance ?? []) {
    if (row.status !== 'approved' || row.date < start || row.date > end || !row.clockOutAt) continue;
    const key = JSON.stringify([row.castId,row.date]);
    const existing = punches.get(key);
    punches.set(key,{clockInAt:Math.min(existing?.clockInAt ?? Infinity,row.clockInAt),
      clockOutAt:Math.max(existing?.clockOutAt ?? 0,row.clockOutAt)});
  }
  const details = pay.rows.flatMap(({castId,castName,work,missingDates}) => work.map(({date,minutes,hourlyRate,source}) => ({
    date,personId:castId,personName:castName,role:'cast',roleKey:'cast',roleName:'キャスト',minutes,
    hourlyRate:missingDates.includes(date) ? null : hourlyRate,source,
    ...(source === 'attendance' && punches.get(JSON.stringify([castId,date]))),
  })));
  const costs = pay.rows.filter((row) => row.work.length || row.commissionDetails.length || row.attendanceDetails.length || row.pendingDates.length).map((row) => ({
    personId:row.castId,personName:row.castName,roleKey:'cast',roleName:'キャスト',dates:new Set(row.work.map(({date})=>date)),minutes:row.minutes,
    hourlyPay:row.hourlyPay,extras:row.commission + row.pointPay + row.allowanceTotal,
    hasKnownBase:row.work.some(({date})=>!row.missingDates.includes(date)) || (!row.missingDates.length && !row.pendingDates.length),
    issues:[...(row.missingDates.length ? ['時給未登録'] : []),...(row.pendingDates.length ? ['勤怠の確認待ち'] : []),
      ...(pay.unavailableDates.length ? ['過去の歩合データ不足'] : [])],
  }));
  return {details,costs,unavailableDates:pay.unavailableDates};
}

function collectCosts(staffRows,castCosts) {
  const staff = new Map();
  for (const row of staffRows) {
    const key = JSON.stringify([row.personId,row.roleKey]);
    const cost = staff.get(key) ?? {personId:row.personId,personName:row.personName,roleKey:row.roleKey,roleName:row.roleName,
      dates:new Set(),numerators:new Map(),minutes:0,hourlyPay:0,extras:0,issues:[],hasKnownBase:false};
    cost.dates.add(row.date);
    cost.minutes += row.minutes;
    if (row.baseNumerator !== null) cost.numerators.set(row.date,(cost.numerators.get(row.date) ?? 0) + row.baseNumerator);
    cost.hasKnownBase ||= row.baseNumerator !== null;
    if (row.baseNumerator === null && !cost.issues.length) cost.issues.push('時給未登録');
    staff.set(key,cost);
  }
  return [...castCosts,...staff.values()].map(({dates,numerators,...row}) => {
    const hourlyPay = numerators ? [...numerators.values()].reduce((sum,value) => sum + Math.round(value / 60),0) : row.hourlyPay;
    return {...row,days:dates.size,hourlyPay,knownCost:hourlyPay + row.extras,hasKnownCost:row.hasKnownBase || row.extras > 0};
  })
    .sort((a,b)=>a.roleName.localeCompare(b.roleName,'ja') || a.personName.localeCompare(b.personName,'ja'));
}

export function getLaborReport(state,filters = {}) {
  const start = filters.start ?? `${state.day.date.slice(0,7)}-01`;
  const end = filters.end ?? state.day.date;
  const selectedRole = filters.role ?? '';
  if (!isLaborDate(start) || !isLaborDate(end) || start > end) {
    return {start,end,selectedRole,valid:false,error:'開始営業日と終了営業日を、日付の順に指定してください。'};
  }
  const staff = staffWork(state,start,end).sort((a,b)=>b.date.localeCompare(a.date));
  const cast = castWork(state,start,end);
  const allPeople = collectCosts(staff,cast.costs);
  const allRoleNames = new Map();
  for (const {roleKey,roleName} of allPeople) if (!allRoleNames.has(roleKey)) allRoleNames.set(roleKey,roleName);
  const includesRole = (row) => !selectedRole || row.roleKey === selectedRole;
  const people = allPeople.filter(includesRole);
  const details = [...staff,...cast.details].filter(includesRole)
    .sort((a,b)=>b.date.localeCompare(a.date) || a.roleName.localeCompare(b.roleName,'ja') || a.personName.localeCompare(b.personName,'ja'));
  const dailyGroups = new Map();
  for (const row of details) {
    const key = JSON.stringify([row.date,row.roleKey]);
    const group = dailyGroups.get(key) ?? {date:row.date,roleKey:row.roleKey,roleName:row.roleName,people:new Set(),minutes:0};
    group.people.add(row.personId);
    group.minutes += row.minutes;
    dailyGroups.set(key,group);
  }
  const roles = new Map();
  for (const person of people) {
    const key = person.roleKey;
    const group = roles.get(key) ?? {roleKey:key,roleName:person.roleName,people:0,attendanceDays:0,minutes:0,hourlyPay:0,extras:0,knownCost:0,
      hasKnownCost:false,issues:0};
    group.people += Number(person.days > 0);
    group.attendanceDays += person.days;
    for (const field of ['minutes','hourlyPay','extras','knownCost']) group[field] += person[field];
    group.issues += Number(person.issues.length > 0);
    group.hasKnownCost ||= person.hasKnownCost;
    roles.set(key,group);
  }
  const castUncertain = (!selectedRole || selectedRole === 'cast') && cast.unavailableDates.length > 0;
  const staffPending = getStaffLabor(state).attendance.some((row) => row.voidedAt === undefined && row.clockOutAt === null
    && row.date >= start && row.date <= end && includesRole({roleKey:roleKey(row)}));
  const partial = castUncertain || staffPending || people.some(({issues})=>issues.length > 0);
  const knownCost = people.reduce((sum,row)=>sum+row.knownCost,0);
  const sales = getReportPeriod(state,{mode:'range',start,end}).totals.sales;
  const castRow = roles.get('cast');
  const castRatio = !castUncertain && castRow?.issues === 0 && sales > 0 ? 100 * castRow.knownCost / sales : null;
  return {start,end,selectedRole,valid:true,allRoleNames:[...allRoleNames],people,details,
    daily:[...dailyGroups.values()].map(({people,...row}) => ({...row,count:people.size})),roles:[...roles.values()],
    partial,knownCost,castRatio,hasKnownCost:people.some(({hasKnownCost})=>hasKnownCost),
    unavailableDates:castUncertain ? cast.unavailableDates : [],sales};
}

export function formatLaborHours(minutes) {
  return duration.format(minutes / 60);
}

export function buildLaborCsv(report,mode) {
  const {start,end,people,details,unavailableDates} = report;
  if (!report.valid) return '';
  if (mode === 'daily') return encodeCsv([
    ['営業日','役職','勤務者','始業（日本時間）','終業（日本時間）','労働分数','時給（円）','記録元'],
    ...details.map(({date,roleName,personName,minutes,hourlyRate,source,clockInAt,clockOutAt}) => [date,roleName,personName,
      localTime(clockInAt),localTime(clockOutAt),minutes,
      hourlyRate ?? (minutes > 0 ? '未登録' : ''),source === 'manual' ? '給与の勤務行' : '勤怠']),
  ]);
  return encodeCsv([
    ['開始営業日','終了営業日','役職','勤務者','出勤日数','労働分数','時給分（判明分・円）','歩合・ポイント換金・勤怠手当（円）','人件費参考額（判明分・円）','確認事項'],
    ...people.map((row) => [start,end,row.roleName,row.personName,row.days,row.minutes,row.hasKnownBase ? row.hourlyPay : '',row.extras,
      row.hasKnownCost ? row.knownCost : '',row.issues.join('・')]),
    ...(unavailableDates.length ? [[start,end,'キャスト','','','','','','',`過去の歩合データ不足 ${unavailableDates.join('・')}`]] : []),
  ]);
}
