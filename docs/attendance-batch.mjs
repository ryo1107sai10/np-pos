import { applyCastSelfCommand } from './cast-self.mjs';
import { applyStaffLaborCommand, getStaffLabor, isLaborDate } from './labor-workspace.mjs';

export const attendanceBatchLimit = 50;

const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 128;

export function isValidAttendanceBatch({date,reason,rows}) {
  if (!isLaborDate(date) || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 120
    || !Array.isArray(rows) || !rows.length || rows.length > attendanceBatchLimit) return false;
  const seen = new Set();
  for (const row of rows) {
    if (!row || !['cast','staff'].includes(row.kind) || !validId(row.personId)
      || (row.attendanceId != null && !validId(row.attendanceId))) return false;
    const person = JSON.stringify([row.kind,row.personId]);
    if (seen.has(person)) return false;
    seen.add(person);
  }
  return true;
}

function attendanceForKind(state,kind) {
  return kind === 'cast' ? state.castAttendance ?? [] : getStaffLabor(state).attendance;
}

export function attendanceBatchSnapshot(state,{date,rows},includeNew) {
  return rows.map(({kind,personId,attendanceId}) => {
    const entries = attendanceForKind(state,kind);
    const row = attendanceId ? entries.find(({id}) => id === attendanceId)
      : includeNew ? entries.findLast((entry) => entry.date === date && (entry.castId ?? entry.personId) === personId) : undefined;
    return {kind,personId,record:row ?? null};
  });
}

export function applyAttendanceBatch(state,action,now,actor,allocateId) {
  if (!isValidAttendanceBatch(action)) throw new Error(`対象者を1〜${attendanceBatchLimit}名選択し、勤務者ごとに1件の入力と理由を指定してください。`);
  const {date,reason,rows} = action;
  for (const {kind,personId,attendanceId,clockInAt,clockOutAt,breakMinutes,classification,breaks,itemIds} of rows) {
    if (attendanceId && !attendanceForKind(state,kind).some(({id,date:recordDate}) => id === attendanceId && recordDate === date)) {
      throw new Error('勤怠が更新されました。対象の営業日と記録を確認してください。');
    }
    const details = {attendanceId,date,clockInAt,clockOutAt,breakMinutes,reason};
    if (kind === 'cast') applyCastSelfCommand(state,{...details,type:'saveManagedAttendance',castId:personId,classification,breaks,itemIds},now,actor,allocateId);
    else applyStaffLaborCommand(state,{...details,type:'saveStaffAttendance',personId},now,actor,allocateId);
  }
}
