const dayMs = 86_400_000;
const minutesInDay = 1_440;
const allowedStatuses = new Set(['requested','confirmed']);

function validate(condition, message) {
  if (!condition) throw new Error(message);
}

function dayStart(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) return NaN;
  const stamp = Date.parse(date);
  return Number.isFinite(stamp) && dateOf(stamp) === date ? stamp : NaN;
}

function dateOf(stamp) { return new Date(stamp).toISOString().slice(0,10); }

export function shiftPeriod(date, mode = 'week') {
  const stamp = dayStart(date);
  validate(Number.isFinite(stamp), 'シフトの営業日を確認してください。');
  if (mode === 'day') return {start:date,end:date,previous:dateOf(stamp - dayMs),next:dateOf(stamp + dayMs)};
  if (mode === 'month') {
    const first = new Date(`${date.slice(0,7)}-01`);
    const next = new Date(first);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const previous = new Date(first);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    return {start:dateOf(first),end:dateOf(next.getTime() - dayMs),previous:dateOf(previous),next:dateOf(next)};
  }
  const monday = stamp - ((new Date(stamp).getUTCDay() + 6) % 7) * dayMs;
  return {start:dateOf(monday),end:dateOf(monday + 6 * dayMs),previous:dateOf(monday - 7 * dayMs),next:dateOf(monday + 7 * dayMs)};
}

export function listShifts(state,{start,end}) {
  return (state.shifts ?? []).filter(({date}) => date >= start && date <= end)
    .sort((a,b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute || a.id.localeCompare(b.id));
}

export function confirmedShiftCastIds(state,date) {
  return new Set(listShifts(state,{start:date,end:date}).filter(({status}) => status === 'confirmed').map(({castId}) => castId));
}

function validShift(shift) {
  const {date,startMinute,endMinute,status,note} = shift ?? {};
  return Number.isFinite(dayStart(date)) && Number.isInteger(startMinute) && startMinute >= 0 && startMinute < minutesInDay
    && Number.isInteger(endMinute) && endMinute > startMinute && endMinute - startMinute <= minutesInDay
    && allowedStatuses.has(status) && typeof note === 'string' && note.length <= 120;
}

function timeBounds({date,startMinute,endMinute}) {
  const midnight = dayStart(date);
  return {start:midnight + startMinute * 60_000,end:midnight + endMinute * 60_000};
}

function overlaps(first,second) {
  const one = timeBounds(first);
  const two = timeBounds(second);
  return one.start < two.end && two.start < one.end;
}

export function validateShiftsSnapshot(state) {
  if (state.shifts === undefined) return;
  validate(Array.isArray(state.shifts), 'シフトの保存形式を確認してください。');
  const people = new Set([...state.cast,...(state.archivedCast ?? [])].map(({id}) => id));
  const ids = new Set();
  const confirmed = new Map();
  for (const shift of state.shifts) {
    validate(validShift(shift) && typeof shift.id === 'string' && shift.id.length > 0 && shift.id.length <= 128
      && !ids.has(shift.id) && people.has(shift.castId), 'シフトの保存内容を確認してください。');
    ids.add(shift.id);
    if (shift.status === 'confirmed') {
      const group = confirmed.get(shift.castId) ?? [];
      group.push(shift);
      confirmed.set(shift.castId,group);
    }
  }
  for (const group of confirmed.values()) {
    group.sort((a,b) => timeBounds(a).start - timeBounds(b).start);
    validate(group.every((shift,index) => index === 0 || !overlaps(group[index - 1],shift)), '確定済みのシフトが重複しています。');
  }
}

export function applyShiftCommand(state, action, actor, _now, allocateId) {
  validate(['admin','manager'].includes(actor?.role), 'シフトを変更する権限がありません。');
  const shifts = state.shifts ?? [];
  const index = shifts.findIndex(({id}) => id === action.shiftId);
  if (action.shiftId !== undefined || action.type === 'removeShift') {
    validate(index >= 0, '指定したシフトが見つかりません。');
  }
  if (action.type === 'removeShift') {
    shifts.splice(index,1);
    return;
  }
  validate(action.type === 'saveShift', 'シフトの操作を確認してください。');
  const {castId,date,startMinute,endMinute,status,note = ''} = action;
  const previous = shifts[index];
  const people = castId === previous?.castId ? [...state.cast,...(state.archivedCast ?? [])] : state.cast.filter(({enabled}) => enabled !== false);
  validate(people.some(({id}) => id === castId), '有効なキャストを選択してください。');
  const shift = {castId,date,startMinute,endMinute,status,note:typeof note === 'string' ? note.trim() : note};
  validate(validShift(shift), '営業日、開始・終了時刻、状態、メモの内容を確認してください。');
  if (status === 'confirmed') validate(!shifts.some((existing) => existing.id !== action.shiftId && existing.castId === castId
    && existing.status === 'confirmed' && overlaps(existing,shift)), '同じキャストの確定済みシフトと重なっています。');
  const record = {id:previous?.id ?? allocateId(),...shift};
  state.shifts = shifts;
  if (previous) shifts[index] = record;
  else shifts.push(record);
}
