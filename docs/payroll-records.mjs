const itemKinds = new Set(['allowance','deduction','points']);
const personFields = {number:32, legalName:80, postalCode:16, address:160, phone:32, memo:400};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max, required = false) {
  const result = value ?? '';
  check(typeof result === 'string' && result.trim().length <= max && (!required || result.trim()), '登録項目の文字数を確認してください。');
  return result.trim();
}

export function getEmployeeProfile(state, castId) {
  return (state.payroll?.employeeProfiles ?? []).find((row) => row.castId === castId);
}

export function normalizeEmployeeProfiles(state, profiles) {
  check(Array.isArray(profiles) && profiles.length <= 5000, '従業員台帳を確認してください。');
  const known = new Set([...state.cast,...(state.archivedCast ?? [])].map(({id})=>id));
  const ids = new Set();
  const numbers = new Set();
  return profiles.map((profile) => {
    check(record(profile) && known.has(profile.castId) && !ids.has(profile.castId), '台帳に登録する従業員を確認してください。');
    ids.add(profile.castId);
    const details = Object.fromEntries(Object.entries(personFields).map(([field,max]) => [field,text(profile[field],max)]));
    check(!details.number || !numbers.has(details.number.toLowerCase()), '従業員番号はすでに登録されています。');
    if (details.number) numbers.add(details.number.toLowerCase());
    return {castId:profile.castId,...details};
  });
}

export function saveEmployeeProfile(state, castId, profile) {
  check(record(profile), '従業員台帳の入力内容を確認してください。');
  const previous = state.payroll.employeeProfiles ?? [];
  const rows = previous.filter((entry) => entry.castId !== castId);
  rows.push({...profile,castId});
  state.payroll.employeeProfiles = normalizeEmployeeProfiles(state,rows);
}

function normalizeAttendanceItem(row) {
  check(record(row) && itemKinds.has(row.kind)
    && Number.isInteger(row.amount) && row.amount >= 0 && row.amount <= 1_000_000, '勤怠項目の種類と金額・ポイントを確認してください。');
  return {id:text(row.id,128,true),label:text(row.label,60,true),kind:row.kind,amount:row.amount};
}

export function normalizeAttendanceItems(rows) {
  check(Array.isArray(rows) && rows.length <= 50, '勤怠項目を50件以内で登録してください。');
  const entries = rows.map(normalizeAttendanceItem);
  check(new Set(entries.map(({id}) => id)).size === entries.length
    && new Set(entries.map(({kind,label}) => JSON.stringify([kind,label]))).size === entries.length, '勤怠項目が重複しています。');
  return entries;
}

export function replaceAttendanceItems(state, rows, allocateId) {
  check(Array.isArray(rows), '勤怠項目を確認してください。');
  const existingIds = new Set((state.attendanceItems ?? []).map(({id}) => id));
  state.attendanceItems = normalizeAttendanceItems(rows.map((row) => {
    check(record(row) && (row.id == null || existingIds.has(row.id)), '変更する勤怠項目を確認してください。');
    return {...row,id:row.id ?? allocateId('attendance-item')};
  }));
}

export function resolveAttendanceItems(state, ids, prior = []) {
  check(Array.isArray(ids) && ids.length <= 50 && new Set(ids).size === ids.length, '勤怠項目の選択を確認してください。');
  const byId = new Map([...(state.attendanceItems ?? []),...prior].map((entry)=>[entry.id,entry]));
  return ids.map((id) => {
    const item = byId.get(id);
    check(Boolean(item), '選択した勤怠項目が見つかりません。');
    return {...item};
  });
}

export function payrollAttendanceItems(state, month, castId) {
  const totals = new Map();
  for (const row of state.castAttendance ?? []) {
    if (row.castId !== castId || row.status !== 'approved' || row.date.slice(0,7) !== month) continue;
    for (const {kind,label,amount} of row.items ?? []) {
      const key = JSON.stringify([kind,label]);
      const item = totals.get(key) ?? {kind,label,amount:0};
      item.amount += amount;
      totals.set(key,item);
    }
  }
  return [...totals.values()];
}
