const minute = 60_000;
const day = 1_440 * minute;
const japanOffset = 540 * minute;

export const castDutyModes = Object.freeze({all:'在籍キャスト全員',shifts:'確定シフトの時間帯',attendance:'勤怠で勤務中'});

export function normalizeCastDutyMode(mode) {
  if (typeof mode !== 'string' || !Object.hasOwn(castDutyModes,mode)) throw new Error('注文の担当キャストの候補設定を確認してください。');
  return mode;
}

export function getCastDutyMode(state) {
  return state.controls?.castDutyMode ?? 'all';
}

function eligibilityIntervals(state, mode) {
  if (mode === 'shifts') {
    const absences = new Set((state.castAttendance ?? []).filter(({status}) => status === 'absent')
      .map(({date,castId}) => JSON.stringify([date,castId])));
    return (state.shifts ?? []).filter(({status,date,castId}) => status === 'confirmed' && !absences.has(JSON.stringify([date,castId])))
      .map(({date,castId,startMinute,endMinute}) => {
        const midnight = Date.parse(date) - japanOffset;
        return {castId,start:midnight + startMinute * minute,end:midnight + endMinute * minute};
      });
  }
  return (state.castAttendance ?? []).flatMap(({castId,status,clockInAt,clockOutAt,breaks = [],minutes}) => {
    if (status === 'open') return [{castId,start:clockInAt,end:clockInAt + day}];
    if (status !== 'approved' || minutes <= 0) return [];
    const starts = [clockInAt,...breaks.map(({endAt}) => endAt)];
    const ends = [...breaks.map(({startAt}) => startAt),clockOutAt];
    return starts.map((start,index) => ({castId,start,end:ends[index]})).filter(({start,end}) => start < end);
  });
}

export function getCastDutyProjection(state, now) {
  const mode = getCastDutyMode(state);
  if (mode === 'all') return null;
  if (!Number.isFinite(now)) return {ids:[],refreshAt:null};
  const active = new Set(state.cast.filter(({enabled}) => enabled !== false).map(({id}) => id));
  const ids = new Set();
  let refreshAt = Infinity;
  for (const {castId,start,end} of eligibilityIntervals(state,mode)) {
    if (!active.has(castId)) continue;
    if (start <= now && now < end) ids.add(castId);
    if (start > now) refreshAt = Math.min(refreshAt,start);
    if (end > now) refreshAt = Math.min(refreshAt,end);
  }
  return {ids:[...ids],refreshAt:Number.isFinite(refreshAt) ? refreshAt : null};
}

export function getAssignableCast(state, now = Date.now(), existingIds = []) {
  const mode = getCastDutyMode(state);
  const projection = Number.isFinite(now) ? state.castDutyProjection ?? getCastDutyProjection(state,now) : null;
  const eligible = new Set(projection?.refreshAt != null && now >= projection.refreshAt ? [] : projection?.ids);
  const existing = new Set(existingIds);
  return [
    ...state.cast.filter(({id,enabled}) => existing.has(id) || (enabled !== false && (mode === 'all' || eligible.has(id)))),
    ...(state.archivedCast ?? []).filter(({id}) => existing.has(id)),
  ];
}

export function assertCastOnDuty(state, castIds, now, existingIds = []) {
  if (getCastDutyMode(state) === 'all' || !castIds.length) return;
  const eligible = new Set(getAssignableCast(state,now,existingIds).map(({id}) => id));
  if (!castIds.every((id) => eligible.has(id))) throw new Error('勤務条件を満たさないキャストがいます。担当キャストを選び直してください。');
}
