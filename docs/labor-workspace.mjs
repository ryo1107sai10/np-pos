import { attendanceTimeUnits, businessDate, getAttendanceMinutes, getAttendanceTimeUnit, operationBusinessDate, registerCutoff } from './register-config.mjs';
import * as roles from './role-policy.mjs';

export const staffRoles = ['admin','manager','staff','trainee'];
const minute = 60_000;
const day = 1440 * minute;
const commands = new Set(['saveStaffPerson','saveStaffRate','saveStaffAttendance','voidStaffAttendance']);
const noStaff = Object.freeze({people:[],rates:[],attendance:[]});

function check(condition,message) {
  if (!condition) throw new Error(message);
}

export function isLaborDate(value) {
  return typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0,10) === value;
}

function cleanText(value,max) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  check(normalized && normalized.length <= max && !/[\p{Cc}\u2028\u2029]/u.test(normalized),`入力は${max}文字以内で指定してください。`);
  return normalized;
}

export function getStaffLabor(state) {
  return state.staffLabor ?? noStaff;
}

export function isStaffLaborCommand(type) {
  return commands.has(type);
}

function staffRole(row) {
  check(staffRoles.includes(row.role),'勤務者の役職を選択してください。');
  const profileId = row.profileId ? cleanText(row.profileId,128) : undefined;
  check(!profileId || (roles.isCustomRoleId(profileId) && ['manager','staff'].includes(row.role)),'勤務者の役職を確認してください。');
  return {role:row.role,...(profileId && {profileId})};
}

function normalizePerson(row) {
  check(typeof row.enabled === 'boolean','勤務者の在籍状態を確認してください。');
  return {id:cleanText(row.id,128),name:cleanText(row.name,60),...staffRole(row),enabled:row.enabled};
}

function normalizeRate(row, people) {
  const {personId,effectiveDate,hourlyRate} = row;
  check(people.has(personId) && isLaborDate(effectiveDate) && Number.isSafeInteger(hourlyRate)
    && hourlyRate >= 0 && hourlyRate <= 100_000_000,'勤務者・適用日・時給（0円以上）を確認してください。');
  return {personId,effectiveDate,hourlyRate};
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}

function normalizeAttendance(row, people) {
  const {personId,date,clockInAt,clockOutAt,breakMinutes,voidedAt,timeUnitMinutes} = row;
  check(people.has(personId) && isLaborDate(date) && isTimestamp(clockInAt)
    && (clockOutAt === null || (isTimestamp(clockOutAt) && clockOutAt > clockInAt && clockOutAt - clockInAt <= day)),
    '営業日と出退勤時刻を確認してください。勤務は24時間以内で指定できます。');
  check(timeUnitMinutes === undefined || attendanceTimeUnits.includes(timeUnitMinutes),'勤怠の時間単位を確認してください。');
  const calendarStart = Date.parse(`${date}T00:00:00+09:00`);
  check(clockInAt >= calendarStart && clockInAt < calendarStart + 2 * day,'勤務開始が営業日の範囲を超えています。');
  const elapsed = clockOutAt === null ? 0 : Math.floor((clockOutAt - clockInAt) / minute);
  check(Number.isInteger(breakMinutes) && breakMinutes >= 0 && breakMinutes <= elapsed,'休憩分数は勤務時間の範囲で指定してください。');
  check(voidedAt === undefined || (isTimestamp(voidedAt) && voidedAt >= (clockOutAt ?? clockInAt)),'勤怠の取消日時を確認してください。');
  return {id:cleanText(row.id,128),personId,date,clockInAt,clockOutAt,breakMinutes,
    minutes:clockOutAt === null ? 0 : getAttendanceMinutes(clockInAt,clockOutAt,breakMinutes,timeUnitMinutes),...staffRole(row),
    ...(timeUnitMinutes !== undefined && {timeUnitMinutes}),
    personName:cleanText(row.personName,60),roleName:cleanText(row.roleName,60),reason:cleanText(row.reason,120),
    ...(voidedAt !== undefined && {voidedAt,voidReason:cleanText(row.voidReason,120)})};
}

function validateAttendanceList(attendance) {
  const ids = new Set();
  const byPerson = new Map();
  for (const row of attendance) {
    check(!ids.has(row.id),'勤怠の記録が重複しています。');
    ids.add(row.id);
    if (row.voidedAt !== undefined) continue;
    if (!byPerson.has(row.personId)) byPerson.set(row.personId,[]);
    byPerson.get(row.personId).push(row);
  }
  for (const rows of byPerson.values()) {
    rows.sort((a,b) => a.clockInAt-b.clockInAt);
    const dates = new Set();
    for (const [index,row] of rows.entries()) {
      check(!dates.has(row.date),'同じ勤務者には営業日ごとに1件の勤務を登録できます。既存の記録を訂正してください。');
      check(!index || (rows[index-1].clockOutAt ?? Infinity) <= row.clockInAt,'同じ勤務者の勤務時間が重複しています。');
      dates.add(row.date);
    }
  }
}

export function normalizeStaffLabor(snapshot) {
  check(snapshot && ['people','rates','attendance'].every((key)=>Array.isArray(snapshot[key])),'役職別勤怠データを確認してください。');
  const people = snapshot.people.map(normalizePerson);
  const personIds = new Set(people.map(({id})=>id));
  check(personIds.size === people.length,'勤務者の記録が重複しています。');
  const rates = snapshot.rates.map((row)=>normalizeRate(row,personIds));
  check(new Set(rates.map(({personId,effectiveDate})=>JSON.stringify([personId,effectiveDate]))).size === rates.length,
    '時給の適用日が重複しています。');
  const attendance = snapshot.attendance.map((row)=>normalizeAttendance(row,personIds));
  validateAttendanceList(attendance);
  return {people,rates,attendance};
}

export function applyStaffLaborCommand(state, action, now, actor, allocateId) {
  const attendanceCommand = ['saveStaffAttendance','voidStaffAttendance'].includes(action.type);
  check(actor.role === 'admin' || (attendanceCommand && actor.role === 'manager')
    || (action.type === 'saveStaffRate' && roles.canDelegatePayroll(state,actor.role,actor.profileId,'editHourlyRates')),'この操作には権限が必要です。');
  const labor = (state.staffLabor ??= {people:[],rates:[],attendance:[]});
  const personIds = new Set(labor.people.map(({id})=>id));
  if (action.type === 'saveStaffPerson') {
    const personId = action.personId ?? allocateId('staff-person');
    check(action.personId == null || personIds.has(personId),'勤務者が見つかりません。');
    const person = normalizePerson({id:personId,name:action.name,role:action.role,profileId:action.profileId,enabled:action.enabled});
    if (person.profileId) check(roles.getCustomRole(state,person.profileId)?.base === person.role,'カスタム役職を確認してください。');
    labor.people = labor.people.filter(({id})=>id !== personId).concat(person);
    return;
  }
  if (action.type === 'saveStaffRate') {
    const rate = normalizeRate(action,personIds);
    check(actor.role === 'admin' || labor.people.find(({id}) => id === rate.personId)?.role !== 'admin',
      '店舗管理者の時給を変更するには管理者権限が必要です。');
    labor.rates = labor.rates.filter((row)=>row.personId !== rate.personId || row.effectiveDate !== rate.effectiveDate).concat(rate);
    return;
  }
  const previous = labor.attendance.find(({id})=>id === action.attendanceId);
  check(action.attendanceId == null || (previous && previous.voidedAt === undefined),'訂正する勤怠が見つかりません。');
  if (action.type === 'voidStaffAttendance') {
    check(previous && (previous.clockOutAt ?? previous.clockInAt) <= now,'取り消す勤怠を確認してください。');
    previous.voidReason = cleanText(action.reason,120);
    previous.voidedAt = now;
    return;
  }
  const person = labor.people.find(({id})=>id === action.personId);
  check(person && (previous?.personId === person.id || (!previous && person.enabled)),'在籍中の勤務者を選択してください。');
  const sameDay = previous?.date === action.date;
  const previousStart = sameDay && previous.clockInAt === action.clockInAt;
  check(action.clockInAt <= now && (action.clockOutAt === null || action.clockOutAt <= now) && (previousStart || (isTimestamp(action.clockInAt)
    && action.date <= operationBusinessDate(state,now)
    && businessDate(action.clockInAt,registerCutoff(state)) === action.date)),
  '出勤時刻が指定した営業日に属することと、退勤が現在より前であることを確認してください。');
  const roleSnapshot = sameDay ? previous : {...staffRole(person),
    roleName:roles.roleLabel(state,person.role,person.profileId),personName:person.name};
  const {date,clockInAt,clockOutAt,breakMinutes,reason} = action;
  const timeUnitMinutes = previous ? previous.timeUnitMinutes ?? 1 : getAttendanceTimeUnit(state);
  const attendance = normalizeAttendance({personId:person.id,date,clockInAt,clockOutAt,breakMinutes,reason,...staffRole(roleSnapshot),
    personName:roleSnapshot.personName,roleName:roleSnapshot.roleName,id:previous?.id ?? allocateId('staff-attendance'),timeUnitMinutes},personIds);
  const updated = labor.attendance.filter(({id})=>id !== attendance.id).concat(attendance);
  validateAttendanceList(updated);
  labor.attendance = updated;
}
