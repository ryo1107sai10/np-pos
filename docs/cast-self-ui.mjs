const timestamp = new Intl.DateTimeFormat('ja-JP',{
  timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
});
const attendanceNames = {open:'勤務中',pending:'確認待ち',approved:'承認済み',rejected:'却下',absent:'欠勤'};
const classes = {worked:'通常勤務',late:'遅刻',absent:'欠勤','no-show':'無断欠勤'};
const itemTypes = {allowance:'手当',deduction:'控除',points:'勤怠ポイント'};
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

function attendanceList(entries,api,people) {
  const {escape} = api;
  return entries.length ? `<ul class="cast-self-list">${entries.map((entry) => `<li><div>
      <strong>${escape(people?.get(entry.castId) ?? entry.date)}</strong>
      <small>${people ? `${escape(entry.date)} ／ ` : ''}${escape(displayTime(entry.clockInAt))} ～ ${escape(displayTime(entry.clockOutAt))}</small>
      ${entry.reviewReason ? `<small>${escape(entry.reviewReason)}</small>` : ''}</div><div class="cast-self-status">
      <span class="lr-badge">${attendanceNames[entry.status]}</span><small>${duration(entry.minutes)}</small>
      ${entry.classification && entry.classification !== 'worked' ? `<small>${classes[entry.classification]}</small>` : ''}
      ${entry.breakMinutes ? `<small>休憩 ${entry.breakMinutes}分</small>` : ''}
      ${people ? button('訂正する','attendance-editor',api,'clock',{id:escape(entry.id)}) : ''}</div></li>`).join('')}</ul>`
    : '<p class="field-help">勤怠の記録はありません。</p>';
}

export function renderCastAttendance(state,entries,api) {
  const {escape} = api;
  const people = new Map([...state.cast,...(state.archivedCast ?? [])].map(({id,name})=>[id,name]));
  const pending = entries.filter(({status})=>['pending','open'].includes(status));
  const complete = entries.filter(({status})=>['approved','rejected','absent'].includes(status));
  const reviewRows = pending.map((entry) => `<li><div><strong>${escape(people.get(entry.castId) ?? entry.castId)}</strong>
      <small>${escape(entry.date)} ／ ${escape(displayTime(entry.clockInAt))} ～ ${escape(displayTime(entry.clockOutAt))}</small></div>
      <div class="cast-self-status"><span class="lr-badge">${attendanceNames[entry.status]}</span>
      ${button('確認する','attendance-review',api,'check',{id:escape(entry.id)})}
      ${button('訂正する','attendance-editor',api,'clock',{id:escape(entry.id)})}</div></li>`).join('');
  return `<div class="lr-view"><p class="form-copy">承認した実働時間は給与計算に反映されます。</p>
    <div class="ops-actions">${button('勤怠を代理登録','attendance-editor',api,'plus')}</div>
    ${panel('勤務中・確認待ち',reviewRows ? `<ul class="cast-self-list">${reviewRows}</ul>` : '<p class="field-help">確認が必要な勤怠はありません。</p>')}
    ${panel('確認済みの勤怠',attendanceList(complete,api,people))}</div>`;
}

function jtValue(at) {
  return Number.isFinite(at) ? new Date(at + 9 * 60 * 60 * 1000).toISOString().slice(0,23) : '';
}

export function renderManagedBreakRow(row = {},api) {
  return `<div class="form-grid payroll-edit-section" data-attendance-break>
    <label class="field"><span>休憩開始</span><input type="datetime-local" step="0.001" name="breakStart" value="${jtValue(row.startAt)}"></label>
    <label class="field"><span>休憩終了</span><input type="datetime-local" step="0.001" name="breakEnd" value="${jtValue(row.endAt)}"></label>
    ${button('休憩を削除','attendance-break-remove',api,'x')}</div>`;
}

export function renderManagedAttendance(state,entry,api) {
  const {escape} = api;
  const people = entry ? [...state.cast,...(state.archivedCast ?? [])].filter(({id}) => id === entry.castId)
    : state.cast.filter(({enabled}) => enabled !== false);
  const previous = entry?.items ?? [];
  const items = new Map([...(state.attendanceItems ?? []),...previous].map((row)=>[row.id,row]));
  return `<div class="form-grid">
    <label class="field"><span>勤務者</span><select name="attendanceCast" required>${people.map(({id,name})=>`<option value="${escape(id)}">${escape(name)}</option>`).join('')}</select></label>
    <label class="field"><span>営業日</span><input type="date" name="attendanceDate" value="${escape(entry?.date ?? state.day.date)}" required></label>
    <label class="field"><span>区分</span><select name="attendanceClass">${Object.entries(classes).map(([value,title])=>`<option value="${value}"${entry?.classification === value ? ' selected' : ''}>${title}</option>`).join('')}</select></label>
    </div><div data-attendance-clock${entry?.status === 'absent' ? ' hidden' : ''}>
    <div class="form-grid">
    <label class="field"><span>出勤日時</span><input type="datetime-local" step="0.001" name="attendanceIn" value="${jtValue(entry?.clockInAt)}"></label>
    <label class="field"><span>退勤日時</span><input type="datetime-local" step="0.001" name="attendanceOut" value="${jtValue(entry?.clockOutAt)}"></label>
    <label class="field"><span>休憩合計（分）</span><input type="number" name="attendanceBreakMinutes" min="0" max="1440" value="${entry?.breakMinutes ?? 0}" inputmode="numeric"></label></div>
    <p class="field-help">代理出勤のときは退勤を空欄にします。休憩の時刻を入力した場合は時刻から集計します。</p>
    <div data-attendance-breaks>${(entry?.breaks ?? []).map((row)=>renderManagedBreakRow(row,api)).join('')}</div>
    ${button('休憩時刻を追加','attendance-break-add',api,'plus')}
    ${items.size ? `<fieldset class="choices"><legend>勤怠項目</legend>${[...items.values()].map(({id,label,kind,amount})=>
      `<label class="inline-check"><input type="checkbox" name="attendanceItems" value="${escape(id)}"${previous.some((row)=>row.id===id) ? ' checked' : ''}>
      ${escape(label)} ／ ${itemTypes[kind]} ${amount}${kind === 'points' ? ' pt' : '円'}</label>`).join('')}</fieldset>` : ''}</div>
    <label class="field"><span>記録・訂正の理由</span><textarea name="attendanceReason" maxlength="120" required></textarea></label>`;
}

export function readManagedAttendance(data) {
  function parse(value) {
    if (!value) return null;
    const timestamp = Date.parse(value + '+09:00');
    if (!Number.isFinite(timestamp)) throw new Error('勤怠の日時を確認してください。');
    return timestamp;
  }
  const starts = data.getAll('breakStart');
  const ends = data.getAll('breakEnd');
  return {castId:data.get('attendanceCast'),date:data.get('attendanceDate'),classification:data.get('attendanceClass'),
    clockInAt:parse(data.get('attendanceIn')),clockOutAt:parse(data.get('attendanceOut')),breakMinutes:Number(data.get('attendanceBreakMinutes') ?? 0),
    breaks:starts.map((value,index)=>({startAt:parse(value),endAt:parse(ends[index])})).filter((row)=>row.startAt !== null || row.endAt !== null),
    itemIds:data.getAll('attendanceItems'),reason:data.get('attendanceReason')};
}

function payslip(pay,api,isFinal) {
  const {escape,yen} = api;
  const rows = [['時給分',pay.hourlyPay],['確定歩合',pay.commission],['ポイント換金',pay.pointPay],
    ['手当',pay.allowanceTotal],['控除',-pay.deductionTotal],['日払い済み',-pay.advance]];
  return `<details class="cast-payslip"${isFinal ? ` id="cast-payslip-${escape(pay.month)}"` : ' open'}><summary>${escape(pay.month)} ${isFinal ? '確定明細' : '試算'} <strong>${yen(pay.net)}</strong></summary>
    <dl class="lr-money-list">${rows.map(([label,amount])=>`<div><dt>${label}</dt><dd>${yen(amount)}</dd></div>`).join('')}</dl>
    <p class="field-help">実働時間 ${duration(pay.minutes)}</p>
    ${isFinal ? `<div class="ops-actions">${button('明細を印刷・PDF保存','cast-payslip-print',api,'printer',{id:escape(pay.month)})}</div>` : ''}</details>`;
}

function payrollNotices(payroll,seenPayrollMonths,api) {
  const unseen = payroll.finals.filter(({month})=>!seenPayrollMonths.has(month));
  if (!unseen.length) return '';
  return panel(`給与のお知らせ <span class="lr-badge">${unseen.length}件</span>`,
    `<ul class="cast-self-list" aria-live="polite">${unseen.map(({month,finalizedAt})=>`<li>
      <div><strong>${api.escape(month)} の給与が確定しました</strong><small>${api.escape(displayTime(finalizedAt))}</small></div>
      ${button('明細を確認','cast-payroll-notice',api,'ticket',{id:api.escape(month)})}</li>`).join('')}</ul>`);
}

function castPerformance(performance,api) {
  if (!performance) return '';
  const {escape,yen} = api;
  const {month,confirmed,forecast,incomplete} = performance;
  const metrics = [
    ['個人売上',yen(confirmed.sales),yen(forecast.sales)],
    ['歩合',yen(confirmed.commission),yen(forecast.commission)],
    ['指名',confirmed.nominations + '件',forecast.nominations + '件'],
    ['担当ドリンク',confirmed.drinkQuantity + '点',forecast.drinkQuantity + '点'],
    ['注文ポイント',confirmed.points + ' pt',forecast.points + ' pt'],
  ];
  return panel('自分の営業成績',`<p class="field-help">${escape(month)} ／ 会計済みを確定、未会計を見込みとして集計します。</p>
    <div class="analytics-table"><table><thead><tr><th scope="col">項目</th><th scope="col">確定</th><th scope="col">見込み</th></tr></thead>
      <tbody>${metrics.map(([label,actual,expected])=>`<tr><th scope="row">${label}</th><td>${actual}</td><td>${expected}</td></tr>`).join('')}</tbody></table></div>
    ${incomplete ? '<p class="field-help">一部の過去伝票で内訳がなく、指名・ドリンクは明細を確認できた分を表示しています。</p>' : ''}`);
}

export function renderCastWorkspace(model,api,{seenPayrollMonths = new Set()} = {}) {
  if (!model) return '<p class="notice">店舗管理者に、キャスト登録とアカウントのひもづけを確認してください。</p>';
  const {escape,yen,icon} = api;
  const {cast,date,shifts,attendances,openClock,dailyPays,payroll,dailyPayLimit,performance} = model;
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
    ${payrollNotices(payroll,seenPayrollMonths,api)}
    ${castPerformance(performance,api)}
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
