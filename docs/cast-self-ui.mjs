const timestamp = new Intl.DateTimeFormat('ja-JP',{
  timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
});
const attendanceNames = {open:'勤務中',pending:'確認待ち',approved:'承認済み',rejected:'却下'};
const dailyPayNames = {requested:'申請中',approved:'承認済み',rejected:'却下',paid:'支給済み'};
const displayTime = (at) => at == null ? '—' : timestamp.format(at);
const duration = (minutes) => Number.isInteger(minutes) ? `${Math.floor(minutes / 60)}時間 ${minutes % 60}分` : '—';

function button(label,action,{icon},glyph,{id,tone=''}={}) {
  return `<button type="button" class="btn ${tone}" data-action="${action}"${id ? ` data-id="${id}"` : ''}>${icon(glyph,16)}${label}</button>`;
}

function panel(title,body) {
  return `<section class="lr-panel"><div class="lr-panel-head"><h2>${title}</h2></div>${body}</section>`;
}

function shiftTime(minute) {
  const hour = String(Math.floor(minute / 60) % 24).padStart(2,'0');
  return `${minute >= 1440 ? '翌 ' : ''}${hour}:${String(minute % 60).padStart(2,'0')}`;
}

function attendanceList(entries,{escape},people) {
  return entries.length ? `<ul class="cast-self-list">${entries.map((entry) => `<li><div>
      <strong>${escape(people?.get(entry.castId) ?? entry.date)}</strong>
      <small>${people ? `${escape(entry.date)} ／ ` : ''}${escape(displayTime(entry.clockInAt))} ～ ${escape(displayTime(entry.clockOutAt))}</small>
      ${entry.reviewReason ? `<small>${escape(entry.reviewReason)}</small>` : ''}</div><div class="cast-self-status">
      <span class="lr-badge">${attendanceNames[entry.status]}</span><small>${duration(entry.minutes)}</small>
      ${entry.breakMinutes ? `<small>休憩 ${entry.breakMinutes}分</small>` : ''}</div></li>`).join('')}</ul>`
    : '<p class="field-help">勤怠の記録はありません。</p>';
}

export function renderCastAttendance(state,entries,api) {
  const {escape,yen} = api;
  const people = new Map([...state.cast,...(state.archivedCast ?? [])].map(({id,name})=>[id,name]));
  const pending = entries.filter(({status})=>['pending','open'].includes(status));
  const complete = entries.filter(({status})=>['approved','rejected'].includes(status));
  const reviewRows = pending.map((entry) => `<li><div><strong>${escape(people.get(entry.castId) ?? entry.castId)}</strong>
      <small>${escape(entry.date)} ／ ${escape(displayTime(entry.clockInAt))} ～ ${escape(displayTime(entry.clockOutAt))}</small></div>
      <div class="cast-self-status"><span class="lr-badge">${attendanceNames[entry.status]}</span>
      ${button('確認する','attendance-review',api,'check',{id:escape(entry.id)})}</div></li>`).join('');
  return `<div class="lr-view"><p class="form-copy">承認した実働時間は給与計算に反映されます。</p>
    ${panel('勤務中・確認待ち',reviewRows ? `<ul class="cast-self-list">${reviewRows}</ul>` : '<p class="field-help">確認が必要な勤怠はありません。</p>')}
    ${panel('確認済みの勤怠',attendanceList(complete,{escape,yen},people))}</div>`;
}

function payslip(pay,api,isFinal) {
  const {escape,yen} = api;
  const rows = [['時給分',pay.hourlyPay],['確定歩合',pay.commission],['ポイント換金',pay.pointPay],
    ['手当',pay.allowanceTotal],['控除',-pay.deductionTotal],['日払い済み',-pay.advance]];
  return `<details class="cast-payslip"${isFinal ? '' : ' open'}><summary>${escape(pay.month)} ${isFinal ? '確定明細' : '試算'} <strong>${yen(pay.net)}</strong></summary>
    <dl class="lr-money-list">${rows.map(([label,amount])=>`<div><dt>${label}</dt><dd>${yen(amount)}</dd></div>`).join('')}</dl>
    <p class="field-help">実働時間 ${duration(pay.minutes)}</p>
    ${isFinal ? `<div class="ops-actions">${button('明細を印刷・PDF保存','cast-payslip-print',api,'printer',{id:escape(pay.month)})}</div>` : ''}</details>`;
}

export function renderCastWorkspace(model,api) {
  if (!model) return '<p class="notice">店舗管理者に、キャスト登録とアカウントのひもづけを確認してください。</p>';
  const {escape,yen,icon} = api;
  const {cast,date,shifts,attendances,openClock,dailyPays,payroll,dailyPayLimit} = model;
  const nextShifts = shifts.filter((row)=>row.date >= date).slice().sort((a,b)=>a.date.localeCompare(b.date) || a.startMinute-b.startMinute);
  const schedule = nextShifts.length ? `<ul class="cast-self-list">${nextShifts.map((row)=>`<li><div><strong>${escape(row.date)}</strong>
    <small>${shiftTime(row.startMinute)} 〜 ${shiftTime(row.endMinute)}</small>${row.note ? `<small>${escape(row.note)}</small>` : ''}</div>
    <span class="lr-badge">${row.status === 'confirmed' ? '確定' : '勤務希望'}</span></li>`).join('')}</ul>` : '<p class="field-help">今後のシフトはありません。</p>';
  const recentPay = dailyPays.length ? `<ul class="cast-self-list">${dailyPays.map(({month,amount,status,reviewReason})=>
    `<li><div><strong>${yen(amount)}</strong><small>${escape(month)}</small>${reviewReason ? `<small>${escape(reviewReason)}</small>` : ''}</div>
    <span class="lr-badge">${dailyPayNames[status]}</span></li>`).join('')}</ul>` : '<p class="field-help">日払いの申請はありません。</p>';
  const draft = payroll.draft ? payslip(payroll.draft,api,false)
    : payroll.previewPending ? '<p class="field-help">時給設定を管理者が確認すると、試算を表示できます。</p>' : '';
  const statements = payroll.finals.map((row)=>payslip(row,api,true)).join('');
  const locked = payroll.finals.some(({month})=>month === payroll.month);
  return `<div class="lr-view cast-workspace">
    <section class="lr-panel payroll-total"><div><span class="lr-badge">${escape(date)}</span><h2>${escape(cast.name)}</h2>
      <p>${openClock ? `出勤 ${escape(displayTime(openClock.clockInAt))}` : '出勤前'}</p></div>
      ${button(openClock ? '退勤を打刻' : '出勤を打刻',openClock ? 'cast-clock-out' : 'cast-clock-in',{icon},'clock',{tone:'btn-primary'})}</section>
    <div class="lr-split">${panel('シフト',`<div class="ops-actions">${button('勤務希望を送る','cast-request-shift',api,'calendar')}</div>${schedule}`)}
    ${panel('日払い',`${locked ? '' : `<div class="ops-actions">${button('日払いを申請','cast-request-pay',api,'wallet')}</div>`}
      ${dailyPayLimit ? `<p class="field-help">申請目安 ${yen(dailyPayLimit.limit)} ／ 申請・支給済み ${yen(dailyPayLimit.committed)}</p>` : ''}${recentPay}`)}</div>
    ${panel('自分の給与・支給明細',draft + statements || '<p class="field-help">表示できる明細はありません。</p>')}
    ${panel('勤怠履歴',attendanceList(attendances,api))}</div>`;
}

export function renderCastShiftRequest(date,{escape}) {
  return `<div class="form-grid">
    <label class="field"><span>希望日</span><input type="date" name="shiftDate" min="${escape(date)}" value="${escape(date)}" required></label>
    <label class="field"><span>開始時刻</span><input type="time" name="shiftStart" value="20:00" required></label>
    <label class="field"><span>終了時刻</span><input type="time" name="shiftEnd" value="01:00" required></label></div>
    <label class="np-shift-overnight"><input type="checkbox" name="shiftOvernight" checked>終了は翌日</label>
    <label class="field"><span>メモ（任意）</span><input name="shiftNote" maxlength="120"></label>`;
}
