import { applyPayrollCommand, getDailyPayLimit, getPayrollDailyPays, getPayrollDraft, previewPayroll } from './payroll.mjs';
import { applyShiftCommand } from './shifts.mjs';
import { normalizeAttendanceItems, resolveAttendanceItems } from './payroll-records.mjs';
import { getCastPerformance } from './cast-performance.mjs';
import { operationBusinessDate, registerCutoff } from './register-config.mjs';

const minute = 60_000;
const day = 24 * 60 * minute;
const japanOffset = 9 * 60 * minute;
const selfCommands = new Set(['castClockIn','castClockOut','castRequestShift','castRequestDailyPay']);
const attendanceStatuses = new Set(['open','pending','approved','rejected','absent']);
const absenceTypes = new Set(['absent','no-show']);
const reviewerRoles = new Set(['admin','manager']);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000')
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
}

function boundedText(value, max) {
  return typeof value === 'string' && value.length <= max;
}

function optionalNote(value, label) {
  const note = value ?? '';
  check(boundedText(note,120), `${label}を120文字以内で入力してください。`);
  return note.trim();
}

function dateForPunch(state, at) {
  return operationBusinessDate(state,at);
}

function activeCast(state, castId) {
  return state.cast.find(({id,enabled}) => id === castId && enabled !== false);
}

export function linkedCastForActor(state, actorUid) {
  const link = typeof actorUid === 'string' && state.castAccounts?.find(({uid}) => uid === actorUid);
  return link ? activeCast(state,link.castId) : undefined;
}

export function bindCastAccount(state, {memberUid:uid,castId}, actor) {
  check(actor.role === 'admin', 'アカウントのひもづけは店舗管理者が行えます。');
  check(boundedText(uid,256) && uid.length > 0 && uid.trim() === uid, 'ひもづけるアカウントを選択してください。');
  const previous = state.castAccounts?.find((link) => link.uid === uid);
  if (previous?.castId === castId) return;
  if (castId !== null) {
    check(typeof castId === 'string' && activeCast(state,castId), '在籍中のキャストを選択してください。');
    check(!(state.castAccounts ?? []).some((link) => link.castId === castId), 'このキャストは別のアカウントにひもづいています。');
    check(!(state.castAttendance ?? []).some((row) => row.castId === castId && row.status === 'open'),
      'このキャストには未退勤の打刻があります。勤怠を確認してください。');
  }
  state.castAccounts = (state.castAccounts ?? []).filter((link) => link.uid !== uid);
  if (castId !== null) state.castAccounts.push({uid,castId});
}

export function isCastSelfCommand(type) {
  return selfCommands.has(type);
}

export function isCastAttendanceReview(type) {
  return type === 'reviewCastAttendance';
}

export function isManagedAttendanceCommand(type) {
  return type === 'saveManagedAttendance';
}

function listOwnRows(state, castId) {
  return (state.castAttendance ?? []).filter((row) => row.castId === castId);
}

export function listCastAttendance(state) {
  return (state.castAttendance ?? []).map(({id,castId,date,clockInAt,clockOutAt,status,minutes,breakMinutes,reviewedAt,reviewReason,
    breaks,classification,items}) =>
    ({id,castId,date,clockInAt,clockOutAt,status,minutes,breakMinutes,reviewedAt,reviewReason,
      ...(breaks && {breaks}),...(classification && {classification}),...(items && {items})}))
    .sort((first,second) => second.date.localeCompare(first.date) || (second.clockInAt ?? 0) - (first.clockInAt ?? 0));
}

function payrollAmounts(pay) {
  const {month,castName,work,minutes,hourlyPay,commission,commissionDetails,points,pointPay,
    allowances,deductions,allowanceTotal,deductionTotal,advance,net,statementItems,attendanceItems} = pay;
  return {month,castName,work,minutes,hourlyPay,commission,commissionDetails,points,pointPay,
    allowances,deductions,allowanceTotal,deductionTotal,advance,net,
    statementItems:statementItems?.filter(({kind}) => kind !== 'intermediate').map(({label,kind,amount}) => ({label,kind,amount})),
    ...(attendanceItems && {attendanceItems})};
}

function privatePayroll(state, month, castId) {
  const record = getPayrollDraft(state,month,castId);
  const finals = (state.payroll?.records ?? []).filter((row) => row.castId === castId && row.status === 'final')
    .map(({snapshot,finalizedAt}) => ({...payrollAmounts(snapshot),status:'final',finalizedAt}))
    .sort((first,second) => second.month.localeCompare(first.month));
  let draft = null;
  let dailyPayLimit = null;
  let previewPending = false;
  try {
    if (record?.status !== 'final') draft = {...payrollAmounts(previewPayroll(state,record ?? {month,castId})),status:'draft'};
    dailyPayLimit = getDailyPayLimit(state,month,castId);
  } catch {
    // Submissions can still be inspected while the manager has not set a wage for an approved day.
    previewPending = true;
  }
  return {payroll:{month,draft,finals,previewPending},dailyPayLimit};
}

export function getCastWorkspace(state, actorUid, now = Date.now()) {
  const person = linkedCastForActor(state,actorUid);
  if (!person) return null;
  const {id,name} = person;
  const date = dateForPunch(state,now);
  const month = date.slice(0,7);
  const attendances = listCastAttendance(state).filter(({castId}) => castId === id);
  const shifts = (state.shifts ?? []).filter(({castId}) => castId === id)
    .map(({id,date,startMinute,endMinute,status,note}) => ({id,date,startMinute,endMinute,status,note}));
  const dailyPays = getPayrollDailyPays(state,{castId:id}).map(({id,month,amount,status,reason,requestedAt,reviewedAt,reviewReason,
    paidAt,paidDate,method,exceededLimit}) => ({id,month,amount,status,reason,requestedAt,reviewedAt,reviewReason,
    paidAt,paidDate,method,exceededLimit}));
  return structuredClone({cast:{id,name},date,shifts,attendances,openClock:attendances.find(({status}) => status === 'open') ?? null,
    dailyPays,performance:getCastPerformance(state,id,date),...privatePayroll(state,month,id)});
}

function lastClockEnd(row) {
  return row.clockOutAt ?? (row.status === 'rejected' ? row.reviewedAt : null);
}

function clockIn(state, castId, now, allocateId) {
  const rows = listOwnRows(state,castId);
  check(!rows.some(({status}) => status === 'open'), 'すでに出勤しています。先に退勤を記録してください。');
  check(!rows.some((row) => lastClockEnd(row) > now), '直前の退勤時刻より後に出勤してください。');
  const date = dateForPunch(state,now);
  check(!rows.some((row) => row.date === date && row.status === 'absent'), 'この営業日は欠勤が登録されています。マネージャーに確認してください。');
  check(getPayrollDraft(state,date.slice(0,7),castId)?.status !== 'final', '給与を確定した期間には打刻できません。');
  (state.castAttendance ??= []).push({id:allocateId('attendance'),castId,date,clockInAt:now,clockOutAt:null,status:'open'});
}

function clockOut(state, castId, now, breakMinutes = 0) {
  const row = listOwnRows(state,castId).find(({status}) => status === 'open');
  check(row, '出勤打刻を確認してください。');
  const elapsed = now - row.clockInAt;
  check(elapsed > 0 && elapsed <= day, '出勤から24時間以内に退勤を記録してください。打刻については管理者に確認してください。');
  const elapsedMinutes = Math.floor(elapsed / minute);
  check(Number.isInteger(breakMinutes) && breakMinutes >= 0 && breakMinutes <= elapsedMinutes,
    '休憩時間は出勤から退勤までの分数以内で入力してください。');
  row.clockOutAt = now;
  row.breakMinutes = breakMinutes;
  row.minutes = elapsedMinutes - breakMinutes;
  row.status = 'pending';
}

function shiftBounds({date,startMinute,endMinute}) {
  const midnight = Date.parse(date);
  return [midnight + startMinute * minute, midnight + endMinute * minute];
}

function requestShift(state, castId, action, now, allocateId) {
  const {date,startMinute,endMinute} = action;
  check(isDate(date) && date >= dateForPunch(state,now), '当日以降のシフト希望日を選択してください。');
  const [start,end] = shiftBounds(action);
  check(!(state.shifts ?? []).some((row) => {
    if (row.castId !== castId) return false;
    const [existingStart,existingEnd] = shiftBounds(row);
    return start < existingEnd && existingStart < end;
  }), 'この時間帯にはすでにシフトがあります。');
  const note = optionalNote(action.note,'シフト希望のメモ');
  // Only the constrained new request is delegated. Casts cannot edit or confirm shifts.
  applyShiftCommand(state,{type:'saveShift',castId,date,startMinute,endMinute,status:'requested',note},
    {role:'manager'},now,() => allocateId('shift'));
}

function requestDailyPay(state, castId, action, now, allocateId) {
  const {month,amount,reason} = action;
  check(month === dateForPunch(state,now).slice(0,7), '現在の給与月を選択してください。');
  // The shared request maintains the same amount and approval-limit rules for both entry points.
  applyPayrollCommand(state,{type:'requestDailyPay',castId,month,amount,reason},now,
    {role:'admin'},{allocateId:() => allocateId('daily-pay')});
}

function updatePayrollAttendance(state, row) {
  const existing = (state.attendances ?? []).find(({castId,date}) => castId === row.castId && date === row.date);
  const approved = listOwnRows(state,row.castId).filter(({date,status}) => date === row.date && status === 'approved');
  const total = approved.reduce((sum,{minutes}) => sum + minutes,0);
  check(!existing || (approved.length && existing.status === 'approved' && existing.minutes === total),
    '同じ営業日に別の経路から登録した勤怠があります。給与の勤務記録を確認してください。');
  const minutes = total + row.minutes;
  check(minutes <= day / minute, '同じ営業日の勤務時間が24時間を超えます。');
  if (existing) existing.minutes = minutes;
  else (state.attendances ??= []).push({castId:row.castId,date:row.date,minutes,status:'approved'});
}

function calculateBreaks(breaks, clockInAt, clockOutAt) {
  check(Array.isArray(breaks) && breaks.length <= 12, '休憩は12件以内で入力してください。');
  const list = breaks.map(({startAt,endAt}) => {
    check(isTimestamp(startAt) && isTimestamp(endAt) && startAt >= clockInAt && endAt <= clockOutAt
      && endAt > startAt, '休憩の開始と終了は勤務時間内で指定してください。');
    return {startAt,endAt};
  }).sort((a,b) => a.startAt - b.startAt);
  check(list.every((row,i) => i === 0 || row.startAt >= list[i-1].endAt), '休憩時間が重複しています。');
  return {list,minutes:Math.floor(list.reduce((sum,row)=>sum + row.endAt - row.startAt,0) / minute)};
}

function attendanceMinutes(rows, castId, date) {
  return rows.filter((row)=>row.castId === castId && row.date === date && row.status === 'approved').reduce((sum,row)=>sum+row.minutes,0);
}

function updateManagedPayrollAttendance(state, oldRows, newRows, castId, date) {
  const previous = attendanceMinutes(oldRows,castId,date);
  const rows = state.attendances ?? [];
  const stored = rows.find((row)=>row.castId === castId && row.date === date);
  const approved = newRows.filter((row)=>row.castId === castId && row.date === date && row.status === 'approved');
  if (!stored && !approved.length) return;
  check(!stored || (stored.minutes === previous && stored.status === 'approved'
    && oldRows.some((row)=>row.castId === castId && row.date === date && row.status === 'approved')),
  '同じ営業日に別の経路から登録した勤怠があります。給与の勤務記録を確認してください。');
  const minutes = attendanceMinutes(newRows,castId,date);
  check(minutes <= day / minute, '同じ営業日の勤務時間が24時間を超えます。');
  state.attendances = rows.filter((row)=>row !== stored);
  if (approved.length) state.attendances.push({castId,date,minutes,status:'approved'});
}

function saveManagedAttendance(state, action, now, actor, allocateId) {
  check(reviewerRoles.has(actor.role), '勤怠記録にはマネージャー以上の権限が必要です。');
  const rows = state.castAttendance ?? [];
  const prior = rows.find((row)=>row.id === action.attendanceId);
  check(action.attendanceId == null || prior, '訂正する勤怠が見つかりません。');
  const {castId,date,clockInAt,clockOutAt,classification} = action;
  check((prior ? prior.castId === castId : activeCast(state,castId))
    && isDate(date) && date <= dateForPunch(state,now), '勤務者と営業日を確認してください。');
  check([date,prior?.date].filter(Boolean).every((value)=>getPayrollDraft(state,value.slice(0,7),castId)?.status !== 'final'),
    '給与を確定した期間の勤怠は変更できません。');
  check(classification === 'worked' || classification === 'late' || absenceTypes.has(classification),'勤怠の区分を確認してください。');
  const reason = optionalNote(action.reason,'勤怠登録・訂正の理由');
  check(reason, '勤怠登録・訂正の理由を入力してください。');
  const castRows = rows.filter((row)=>row.castId === castId && row !== prior);
  const absent = absenceTypes.has(classification);
  const dateStart = Date.parse(date) - japanOffset;
  const row = {id:prior?.id ?? allocateId('attendance'),castId,date,classification,
    reviewedAt:now,reviewReason:reason};
  if (absent) {
    check(!castRows.some((entry)=>entry.date === date && entry.status !== 'rejected'), '同じ営業日に勤務または欠勤の記録があります。');
    Object.assign(row,{clockInAt:null,clockOutAt:null,status:'absent'});
  } else {
    check(!castRows.some((entry)=>entry.date === date && entry.status === 'absent'), 'この営業日は欠勤が登録されています。');
    const savedTime = prior?.date === date && prior.clockInAt === clockInAt;
    const lastPossibleStart = dateStart + day + registerCutoff(state) * minute;
    check(isTimestamp(clockInAt) && clockInAt >= dateStart && (savedTime || clockInAt < lastPossibleStart) && clockInAt <= now,
      '営業日と出勤時刻を確認してください。');
    check(clockOutAt === null || (isTimestamp(clockOutAt) && clockOutAt > clockInAt && clockOutAt <= now && clockOutAt - clockInAt <= day),
      '退勤時刻は出勤から24時間以内で指定してください。');
    const end = clockOutAt ?? Infinity;
    check(!castRows.some((entry)=>entry.status !== 'absent' && clockInAt < (lastClockEnd(entry) ?? Infinity) && entry.clockInAt < end),
      '同じ勤務者の打刻時間が重複しています。');
    Object.assign(row,{clockInAt,clockOutAt,status:clockOutAt === null ? 'open' : 'approved'});
    if (clockOutAt !== null) {
      const elapsedMinutes = Math.floor((clockOutAt - clockInAt) / minute);
      const breakData = calculateBreaks(action.breaks ?? [],clockInAt,clockOutAt);
      const breakMinutes = breakData.list.length ? breakData.minutes : (action.breakMinutes ?? 0);
      check(Number.isInteger(breakMinutes) && breakMinutes >= 0 && breakMinutes <= elapsedMinutes,'休憩時間を確認してください。');
      Object.assign(row,{breakMinutes,minutes:elapsedMinutes-breakMinutes,...(breakData.list.length && {breaks:breakData.list})});
    }
  }
  const items = absent ? [] : resolveAttendanceItems(state,action.itemIds ?? [],prior?.items);
  if (items.length) row.items = items;
  const next = [...rows.filter((entry)=>entry !== prior),row];
  for (const updatedDate of new Set([date,prior?.date].filter(Boolean))) updateManagedPayrollAttendance(state,rows,next,castId,updatedDate);
  state.castAttendance = next;
}

function reviewAttendance(state, action, now, actor) {
  check(reviewerRoles.has(actor.role), '勤怠承認にはマネージャー以上の権限が必要です。');
  const row = (state.castAttendance ?? []).find(({id}) => id === action.attendanceId);
  const approve = action.decision === 'approve';
  check(row && ((approve && row.status === 'pending') || (action.decision === 'reject' && ['pending','open'].includes(row.status))),
    '確認待ちの勤怠を選択してください。');
  check(getPayrollDraft(state,row.date.slice(0,7),row.castId)?.status !== 'final' || !approve,
    '給与を確定した期間の勤怠は承認できません。');
  check(now >= (row.clockOutAt ?? row.clockInAt), '打刻時刻を確認してください。');
  const reason = optionalNote(action.reason,'勤怠確認の理由');
  check(approve || reason, '勤怠を却下する理由を入力してください。');
  if (approve) updatePayrollAttendance(state,row);
  Object.assign(row,{status:approve ? 'approved' : 'rejected',reviewedAt:now,reviewReason:reason});
}

export function applyCastSelfCommand(state, action, now, actor, allocateId) {
  check(isTimestamp(now), '打刻時刻を確認してください。');
  if (isManagedAttendanceCommand(action.type)) {
    saveManagedAttendance(state,action,now,actor,allocateId);
    return;
  }
  if (isCastAttendanceReview(action.type)) {
    reviewAttendance(state,action,now,actor);
    return;
  }
  check(actor.role === 'cast', 'この操作はキャスト本人が行えます。');
  const person = linkedCastForActor(state,actor.id);
  check(person, 'キャストアカウントのひもづけを店舗管理者に確認してください。');
  const castId = person.id;
  switch (action.type) {
    case 'castClockIn': clockIn(state,castId,now,allocateId); break;
    case 'castClockOut': clockOut(state,castId,now,action.breakMinutes); break;
    case 'castRequestShift': requestShift(state,castId,action,now,allocateId); break;
    case 'castRequestDailyPay': requestDailyPay(state,castId,action,now,allocateId); break;
    default: throw new Error('キャストの操作内容を確認してください。');
  }
}

function validAttendance(row, castIds) {
  if (!isRecord(row) || !boundedText(row.id,128) || !row.id || !castIds.has(row.castId) || !isDate(row.date)
    || !attendanceStatuses.has(row.status)) return false;
  if (row.items !== undefined) normalizeAttendanceItems(row.items);
  if (row.status === 'absent') return row.clockInAt === null && row.clockOutAt === null && absenceTypes.has(row.classification)
    && isTimestamp(row.reviewedAt) && boundedText(row.reviewReason,120) && Boolean(row.reviewReason.trim());
  if (!isTimestamp(row.clockInAt) || (row.classification !== undefined && !['worked','late'].includes(row.classification))) return false;
  if (row.clockOutAt !== null) {
    if (!isTimestamp(row.clockOutAt) || row.clockOutAt <= row.clockInAt || row.clockOutAt - row.clockInAt > day) return false;
    const elapsedMinutes = Math.floor((row.clockOutAt - row.clockInAt) / minute);
    const {breakMinutes = 0} = row;
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > elapsedMinutes
      || row.minutes !== elapsedMinutes - breakMinutes) return false;
    if (row.breaks !== undefined && calculateBreaks(row.breaks,row.clockInAt,row.clockOutAt).minutes !== breakMinutes) return false;
  } else if (row.minutes !== undefined || row.breakMinutes !== undefined) return false;
  if (row.status === 'open' || row.status === 'pending') return (row.status === 'open') === (row.clockOutAt === null);
  return (row.status !== 'approved' || row.clockOutAt !== null) && isTimestamp(row.reviewedAt)
    && row.reviewedAt >= (row.clockOutAt ?? row.clockInAt) && boundedText(row.reviewReason,120)
    && (row.status !== 'rejected' || Boolean(row.reviewReason.trim()));
}

export function validateCastAttendanceSnapshot(state) {
  if (state.castAttendance === undefined) return;
  const rows = state.castAttendance;
  const castIds = new Set([...state.cast,...(state.archivedCast ?? [])].map(({id}) => id));
  check(Array.isArray(rows) && rows.every((row) => validAttendance(row,castIds))
    && new Set(rows.map(({id}) => id)).size === rows.length, '勤怠打刻の保存内容を確認してください。');
  for (const castId of new Set(rows.map((row) => row.castId))) {
    const group = rows.filter((row) => row.castId === castId && row.status !== 'absent').sort((first,second) => first.clockInAt - second.clockInAt);
    check(group.every((row,index) => index === 0 || (lastClockEnd(group[index - 1]) ?? Infinity) <= row.clockInAt),
      '勤怠打刻が重複しています。');
  }
  const approved = new Map();
  for (const row of rows) {
    if (row.status !== 'approved') continue;
    const key = JSON.stringify([row.castId,row.date]);
    approved.set(key,(approved.get(key) ?? 0) + row.minutes);
  }
  for (const [key,minutes] of approved) {
    const [castId,date] = JSON.parse(key);
    const row = (state.attendances ?? []).find((entry) => entry.castId === castId && entry.date === date);
    check(row?.status === 'approved' && row.minutes === minutes, '打刻と給与の勤怠記録が一致しません。');
  }
}
