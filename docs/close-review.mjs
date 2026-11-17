import { getStaffLabor } from './labor-workspace.mjs';
import { roleLabel } from './role-policy.mjs';

export function getCloseAttendanceReview(state) {
  const people = new Map([...state.cast,...(state.archivedCast ?? [])].map(({id,name}) => [id,name]));
  const staff = getStaffLabor(state).attendance.filter(({voidedAt}) => voidedAt === undefined);
  const casts = state.castAttendance ?? [];
  const date = state.day.date;
  const presentCast = new Set(casts.filter((row) => row.date === date && ['open','pending','approved'].includes(row.status)).map(({castId}) => castId));
  const presentStaff = new Set(staff.filter((row) => row.date === date).map(({personId}) => personId));
  return {castCount:presentCast.size,staffCount:presentStaff.size,
    open:[...casts.filter(({status,date:rowDate}) => status === 'open' && rowDate <= date)
      .map(({castId,date}) => ({name:people.get(castId) ?? castId,role:'キャスト',date})),
    ...staff.filter(({clockOutAt,date:rowDate}) => clockOutAt === null && rowDate <= date)
      .map(({personName,roleName,role,profileId,date}) => ({name:personName,role:roleName ?? roleLabel(state,role,profileId),date}))],
    pending:casts.filter((row) => row.date <= date && row.status === 'pending').length};
}

export function renderCloseReview(state,totals,{escape,yen,attendanceVisible,attendanceButton}) {
  const attendance = attendanceVisible ? getCloseAttendanceReview(state) : state.offlineCloseSummary?.attendance;
  return `<p class="form-copy">営業日 ${escape(state.day.date)} の売上と退勤状況を確認します。</p>
    <dl class="lr-money-list"><div><dt>確定売上</dt><dd>${yen(totals.sales)}</dd></div>
      <div><dt>来店組数</dt><dd>${totals.tickets}組</dd></div><div><dt>来店客数</dt><dd>${totals.guests}名</dd></div>
      ${attendance ? `<div><dt>出勤記録</dt><dd>キャスト ${attendance.castCount}名 ／ スタッフ等 ${attendance.staffCount}名</dd></div>
        <div><dt>未退勤</dt><dd>${attendance.open?.length ?? attendance.openCount}名</dd></div><div><dt>勤怠の確認待ち</dt><dd>${attendance.pending}件</dd></div>` : ''}
    </dl>
    ${attendance?.open?.length ? `<section class="ops-highlight"><strong>未退勤の記録があります</strong>
      <ul>${attendance.open.map(({name,role,date}) => `<li>${escape(name)} ／ ${escape(role)} ／ ${escape(date)}</li>`).join('')}</ul></section>` : ''}
    ${attendanceVisible ? attendanceButton : attendance ? '<p class="field-help">最後に保存した勤怠の集計です。</p>'
      : '<p class="field-help">勤怠を確認できる役職に、退勤状況の確認を依頼してください。</p>'}`;
}
