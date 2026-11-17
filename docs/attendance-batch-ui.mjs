import { attendanceBatchLimit, isValidAttendanceBatch } from './attendance-batch.mjs';
import { getStaffLabor } from './labor-workspace.mjs';
import { roleLabel } from './role-policy.mjs';

const classes = {worked:'通常勤務',late:'遅刻',absent:'欠勤','no-show':'無断欠勤'};
const timeValue = (at) => Number.isFinite(at) ? new Date(at + 32_400_000).toISOString().slice(0,23) : '';

export function getAttendanceBatchRows(state,date) {
  const staff = getStaffLabor(state);
  const existingStaff = staff.attendance.filter((row) => row.date === date && !row.voidedAt);
  const existingCast = (state.castAttendance ?? []).filter((row) => row.date === date && row.status !== 'rejected');
  const staffRows = staff.people.flatMap((person) => {
    const prior = existingStaff.find(({personId}) => personId === person.id);
    return !person.enabled && !prior ? [] : [{kind:'staff',personId:person.id,name:prior?.personName ?? person.name,
      role:prior?.roleName ?? roleLabel(state,person.role,person.profileId),prior}];
  });
  const castRows = [...state.cast,...(state.archivedCast ?? [])].flatMap((person) => {
    const existing = existingCast.filter(({castId}) => castId === person.id);
    if (!existing.length && (person.enabled === false || !state.cast.includes(person))) return [];
    return (existing.length ? existing : [undefined]).map((prior) => ({kind:'cast',personId:person.id,name:person.name,role:'キャスト',prior}));
  });
  return [...staffRows,...castRows].sort((a,b) => a.role.localeCompare(b.role,'ja') || a.name.localeCompare(b.name,'ja'));
}

export function renderAttendanceBatchRows(date,rows,{escape}) {
  return `<p class="form-copy">営業日 ${escape(date)} ／ 変更を保存する行だけ選択してください。1人1件、最大${attendanceBatchLimit}人まで保存できます。</p>
    <p class="field-help">出勤のみを記録する場合は退勤を空欄にします。休憩を時刻で登録済みの行は、個別訂正で休憩を変更できます。</p>
    ${rows.map(({kind,name,role,prior},index) => `<fieldset class="choices payroll-edit-section" data-attendance-batch-row>
      <legend>${escape(name)} ／ ${escape(role)}${prior ? ' · 記録あり' : ''}</legend>
      <label class="inline-check"><input type="checkbox" name="attendanceRow" value="${index}">この行を保存する</label>
      <fieldset class="form-grid" data-attendance-batch-fields disabled>
        ${kind === 'cast' ? `<label class="field"><span>区分</span><select name="batchClass${index}">${Object.entries(classes).map(([id,label]) =>
          `<option value="${id}"${prior?.classification === id ? ' selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}
        <label class="field"><span>出勤日時</span><input type="datetime-local" step="0.001" name="batchIn${index}" value="${timeValue(prior?.clockInAt)}"></label>
        <label class="field"><span>退勤日時</span><input type="datetime-local" step="0.001" name="batchOut${index}" value="${timeValue(prior?.clockOutAt)}"></label>
        <label class="field"><span>休憩（分）</span><input type="number" name="batchBreak${index}" min="0" max="1440" value="${prior?.breakMinutes ?? 0}"${prior?.breaks?.length ? ' readonly' : ''}></label>
      </fieldset></fieldset>`).join('')}
    <label class="field"><span>一括記録・訂正の理由</span><textarea name="batchReason" maxlength="120" required></textarea></label>`;
}

export function readAttendanceTime(value) {
  if (!value) return null;
  const at = Date.parse(`${value}+09:00`);
  if (!Number.isFinite(at)) throw new Error('出退勤の日時を確認してください。');
  return at;
}

export function readAttendanceBatch(data,date,choices) {
  const rows = data.getAll('attendanceRow').map((value) => {
    const index = Number(value);
    const selected = choices[index];
    if (!Number.isInteger(index) || !selected) throw new Error('保存する勤務者を確認してください。');
    const {kind,personId,prior,name} = selected;
    const classification = data.get(`batchClass${index}`);
    const absent = kind === 'cast' && ['absent','no-show'].includes(classification);
    const clockInAt = absent ? null : readAttendanceTime(data.get(`batchIn${index}`));
    const clockOutAt = absent ? null : readAttendanceTime(data.get(`batchOut${index}`));
    const breakMinutes = absent ? 0 : Number(data.get(`batchBreak${index}`) ?? 0);
    if ((!absent && clockInAt === null) || (clockOutAt === null && breakMinutes !== 0)) {
      throw new Error(`${name}の出勤日時と休憩時間を確認してください。`);
    }
    return {kind,personId,attendanceId:prior?.id,clockInAt,clockOutAt,breakMinutes,
      ...(kind === 'cast' && {classification,breaks:prior?.breaks,itemIds:prior?.items?.map(({id}) => id)})};
  });
  const action = {type:'saveAttendanceBatch',date,reason:data.get('batchReason'),rows};
  if (!isValidAttendanceBatch(action)) throw new Error(`対象者を1〜${attendanceBatchLimit}名選び、勤務者ごとに1件の入力と理由を指定してください。`);
  return action;
}
