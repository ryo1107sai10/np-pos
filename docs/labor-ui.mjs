import { getStaffLabor, staffRoles } from './labor-workspace.mjs';
import { formatLaborHours, getLaborReport } from './labor-report.mjs';
import { roleLabel } from './role-policy.mjs';

const timestamp = new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const time = (value) => value ? timestamp.format(value) : '—';
const timeInput = (value) => value ? new Date(value + 32_400_000).toISOString().slice(0,16) : '';
const placeholder = '—';

function button(label,action,{escape,icon},{id,glyph = 'plus',tone = ''} = {}) {
  return `<button type="button" class="btn ${tone}" data-action="${action}"${id ? ` data-id="${escape(id)}"` : ''}>${icon(glyph,16)}${label}</button>`;
}

function field(label,control) {
  return `<label class="field"><span>${label}</span>${control}</label>`;
}

function panel(title,body) {
  return `<section class="lr-panel labor-panel"><div class="lr-panel-head"><h2>${title}</h2></div>${body}</section>`;
}

function table(columns,rows,{escape,print}) {
  return `<div class="analytics-table${print ? '' : ' labor-table'}"${print ? '' : ' tabindex="0"'}><table role="table">
    <thead><tr>${columns.map((title)=>`<th scope="col">${title}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((cells)=>`<tr><th scope="row">${escape(cells[0])}</th>${cells.slice(1).map((cell,index)=>
      `<td>${print ? '' : `<span class="labor-cell-label" aria-hidden="true">${columns[index+1]}</span>`}${escape(cell)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
}

function laborTotals(report,api) {
  const roleRows = report.roles.map((row)=>[row.roleName,`${row.people}名`,`${row.attendanceDays}人日`,formatLaborHours(row.minutes),
    row.hasKnownCost ? api.yen(row.knownCost) : placeholder,row.issues ? `要確認 ${row.issues}名` : '集計済み']);
  return roleRows.length ? table(['役職','出勤者','延べ出勤','勤務時間（時間）','人件費参考額（判明分）','集計状態'],roleRows,api)
    : '<p class="field-help">この条件の勤怠・人件費データはありません。</p>';
}

export function renderLaborHighlights(state,filters,api) {
  const report = getLaborReport(state,filters);
  if (!report.valid) return '';
  return panel('役職別の勤怠・人件費',`<p class="field-help">${api.escape(report.start)}${report.start === report.end ? '' : ` 〜 ${api.escape(report.end)}`}</p>
    ${laborTotals(report,api)}${report.partial ? '<p class="field-help">時給・勤怠・伝票の不足があるため、一部は参考額に反映されていません。</p>' : ''}
    ${report.castRatio === null ? '' : `<p class="field-help">キャスト人件費参考額 ÷ 確定売上　${report.castRatio.toFixed(1)}%</p>`}
    <div class="ops-actions"><button type="button" class="btn btn-secondary" data-action="labor-open" data-start="${report.start}" data-end="${report.end}">${api.icon('users',16)}個人別・営業日別を表示</button></div>`);
}

function renderRoster(state,api) {
  const {escape,yen} = api;
  const {people,rates} = getStaffLabor(state);
  return panel('勤務者台帳と時給',`<div class="ops-actions">${button('勤務者を登録','labor-person',api)}</div>
    <p class="field-help">管理者・マネージャー・スタッフ・体入を登録できます。キャストの時給は「給与・支給明細」で設定します。時給0円も登録できます。</p>
    ${people.length ? `<ul class="cast-self-list">${people.map((person)=>{
      const history = rates.filter(({personId})=>personId === person.id).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate));
      return `<li><div><strong>${escape(person.name)}</strong><small>${escape(roleLabel(state,person.role,person.profileId))}${person.enabled ? '' : ' ／ 停止中'}</small>
        ${history.length ? `<details><summary>時給の履歴</summary>${history.map(({effectiveDate,hourlyRate})=>`<small>${escape(effectiveDate)}から ${yen(hourlyRate)}</small>`).join('')}</details>` : '<small>時給未登録</small>'}</div>
        <div class="ops-actions">${button('勤務者を編集','labor-person',api,{id:person.id,glyph:'edit'})}
        ${button('時給を登録','labor-rate',api,{id:person.id,glyph:'wallet'})}</div></li>`;
    }).join('')}</ul>` : ''}`);
}

export function renderLaborReport(state,filters,api) {
  const {escape,yen,print = false,storeName} = api;
  const report = getLaborReport(state,filters);
  const canPrint = report.valid && Boolean(report.people.length || report.unavailableDates.length);
  if (print && !canPrint) return '';
  const availableRoles = new Map([...['cast',...staffRoles].map((role)=>[role,roleLabel(state,role)]),
    ...Object.entries(state.rolePolicy?.custom ?? {}).map(([id,{label}])=>[id,label]),...(report.allRoleNames ?? [])]);
  const options = [...availableRoles].map(([key,name]) =>
    `<option value="${escape(key)}"${key === report.selectedRole ? ' selected' : ''}>${escape(name)}</option>`).join('');
  const roleName = report.selectedRole ? availableRoles.get(report.selectedRole) ?? report.selectedRole : '全役職';
  const controls = print ? `<header class="workspace-print-heading"><h1>勤怠・人件費</h1>
    <p>${storeName ? `${escape(storeName)} ／ ` : ''}営業日 ${escape(report.start)}${report.start === report.end ? '' : ` 〜 ${escape(report.end)}`} ／ ${escape(roleName)}</p></header>`
    : `<section class="lr-period-tools" aria-label="勤怠・人件費の期間">
    <div class="lr-period-controls"><div class="lr-period-dates">
      ${field('開始営業日',`<input type="date" data-labor-filter="start" value="${escape(report.start)}" required>`)}
      ${field('終了営業日',`<input type="date" data-labor-filter="end" value="${escape(report.end)}" required>`)}
      ${field('役職',`<select data-labor-filter="role"><option value="">全役職</option>${options}</select>`)}
    </div></div>
    <div class="lr-period-exports">${report.valid && report.people.length ? button('人件費CSV','labor-export',api,{id:'summary',glyph:'download'}) : ''}
      ${report.valid && report.details.length ? button('日別勤怠CSV','labor-export',api,{id:'daily',glyph:'download'}) : ''}
      ${canPrint ? button('印刷','labor-print',api,{glyph:'printer'}) : ''}</div></section>`;
  if (!report.valid) return `<div class="lr-view">${controls}<p class="ops-highlight" role="status">${escape(report.error)}</p>${renderRoster(state,api)}</div>`;
  const peopleRows = report.people.map((row) => [row.personName,row.roleName,`${row.days}日`,formatLaborHours(row.minutes),
    row.hasKnownBase ? yen(row.hourlyPay) : placeholder,yen(row.extras),row.hasKnownCost ? yen(row.knownCost) : placeholder,row.issues.join('・') || '集計済み']);
  const daily = report.daily.map(({date,roleName,count,minutes})=>[date,roleName,`${count}名`,formatLaborHours(minutes)]);
  const attendance = report.details.map(({date,roleName,personName,minutes,hourlyRate,clockInAt,clockOutAt,source}) =>
    [date,roleName,personName,formatLaborHours(minutes),hourlyRate === null ? (minutes > 0 ? '未登録' : placeholder) : yen(hourlyRate),
      clockInAt ? `${time(clockInAt)} 〜 ${time(clockOutAt)}` : source === 'manual' ? '給与の勤務行' : '勤怠']);
  return `<div class="lr-view${print ? ' report-print' : ''}">${controls}
    ${panel('役職別の合計',`<p class="field-help">人件費参考額は時給分・確定歩合・ポイント換金・日付のある勤怠手当を合算します。「出勤者」は期間内に勤務を記録した人数です。日払いと月次の手当・控除は給与画面で確認できます。</p>
      ${report.roles.length ? `<div class="result-bar"><span>期間の人件費参考額${report.partial ? '（判明分）' : ''}</span>
        <strong>${report.hasKnownCost ? yen(report.knownCost) : placeholder}</strong></div>` : ''}
      ${report.partial ? '<p class="ops-highlight">未登録の時給や確認待ちの勤怠がある期間は、確認できた金額を表示します。</p>' : ''}
      ${report.unavailableDates.length ? `<p class="field-help">歩合データ不足　${report.unavailableDates.map(escape).join('・')}</p>` : ''}
      ${laborTotals(report,api)}`)}
    ${peopleRows.length ? panel('勤務者別',table(['勤務者','役職','出勤日','勤務時間（時間）','時給分（判明分）','歩合等','人件費参考額（判明分）','確認事項'],peopleRows,api)) : ''}
    ${daily.length ? panel('営業日・役職別',table(['営業日','役職','出勤者','勤務時間（時間）'],daily,api)) : ''}
    ${attendance.length ? panel('勤怠明細',table(['営業日','役職','勤務者','勤務時間（時間）','時給','出退勤・記録元'],attendance,api)) : ''}
    ${print ? '' : renderRoster(state,api)}</div>`;
}

export function renderStaffAttendance(state,api) {
  const {escape,canEdit} = api;
  const {people,attendance} = getStaffLabor(state);
  const rows = attendance.slice().sort((a,b)=>b.date.localeCompare(a.date) || b.clockInAt-a.clockInAt);
  return `<div class="lr-view">${panel('管理者・マネージャー・スタッフ・体入の勤怠',`
    <div class="ops-actions">${canEdit && people.some(({enabled})=>enabled) ? button('勤務を記録','attendance-staff-editor',api) : ''}</div>
    ${!people.length ? '<p class="field-help">店舗管理者が「勤怠・人件費」で勤務者を登録すると、ここで勤怠を記録できます。</p>' : ''}
    ${rows.length ? `<ul class="cast-self-list">${rows.map((row)=>`<li><div><strong>${escape(row.personName)}</strong>
      <small>${escape(row.roleName)} ／ ${escape(row.date)}</small><small>${time(row.clockInAt)} 〜 ${time(row.clockOutAt)} ／ 休憩 ${row.breakMinutes}分</small>
      ${row.voidedAt ? `<small>取消済み　${escape(row.voidReason)}</small>` : ''}</div>
      ${canEdit && !row.voidedAt ? `<div class="ops-actions">${button('勤務を訂正','attendance-staff-editor',api,{id:row.id,glyph:'edit'})}
        ${button('勤務を取消','attendance-staff-void',api,{id:row.id,glyph:'x'})}</div>` : ''}</li>`).join('')}</ul>` : ''}`)}</div>`;
}

export function renderStaffPersonForm(state,person,api) {
  const {escape} = api;
  const options = staffRoles.map((role)=>[role,roleLabel(state,role)]);
  for (const [profileId,{base,label}] of Object.entries(state.rolePolicy?.custom ?? {})) options.push([`${base}/${profileId}`,label]);
  const role = person?.profileId ? `${person.role}/${person.profileId}` : person?.role ?? 'staff';
  if (!options.some(([key])=>key === role)) options.push([role,roleLabel(state,person.role)]);
  return `<div class="form-grid">${field('勤務者名',`<input name="staffName" value="${escape(person?.name ?? '')}" maxlength="60" required>`)}
    ${field('役職',`<select name="staffRole">${options.map(([id,name])=>`<option value="${escape(id)}"${role === id ? ' selected' : ''}>${escape(name)}</option>`).join('')}</select>`)}</div>
    <label class="inline-check"><input type="checkbox" name="staffEnabled"${person?.enabled === false ? '' : ' checked'}>在籍中</label>`;
}

export function renderStaffRateForm(state,person,api) {
  const prior = getStaffLabor(state).rates.filter(({personId,effectiveDate})=>personId === person.id && effectiveDate <= state.day.date)
    .sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate))[0];
  return `<p class="field-help">${api.escape(person.name)}の時給は適用開始日を基準に集計します。</p><div class="form-grid">
    ${field('適用開始日',`<input name="staffRateDate" type="date" value="${api.escape(state.day.date)}" required>`)}
    ${field('時給（円）',`<input name="staffHourlyRate" type="number" min="0" max="100000000" inputmode="numeric" step="1" value="${prior?.hourlyRate ?? ''}" required>`)}
    </div>`;
}

export function renderStaffAttendanceForm(state,row,{escape}) {
  const choices = getStaffLabor(state).people.filter(({id,enabled})=>row ? id === row.personId : enabled);
  return `<div class="form-grid">${field('勤務者',`<select name="staffAttendancePerson" required>${choices.map((person)=>
    `<option value="${escape(person.id)}">${escape(person.name)} ／ ${escape(roleLabel(state,person.role,person.profileId))}</option>`).join('')}</select>`)}
    ${field('営業日',`<input name="staffAttendanceDate" type="date" value="${escape(row?.date ?? state.day.date)}" required>`)}
    ${field('出勤日時',`<input name="staffClockIn" type="datetime-local" value="${timeInput(row?.clockInAt)}" required>`)}
    ${field('退勤日時',`<input name="staffClockOut" type="datetime-local" value="${timeInput(row?.clockOutAt)}" required>`)}
    ${field('休憩分数',`<input name="staffBreak" type="number" min="0" max="1440" step="1" inputmode="numeric" value="${row?.breakMinutes ?? 0}" required>`)}</div>
    ${field('記録・訂正の理由','<textarea name="staffAttendanceReason" maxlength="120" rows="2" required></textarea>')}`;
}
