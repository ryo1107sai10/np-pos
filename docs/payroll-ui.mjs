import { getDailyPayLimit, getPayrollDailyPays, getPayrollDraft, getPayrollRates, getPayrollSettings, isPayrollMonth, previewPayroll } from './payroll.mjs';

const castMembers = (state) => [...state.cast, ...(state.archivedCast ?? [])];
const hours = (minutes) => `${Math.floor(minutes / 60)}時間 ${minutes % 60}分`;

function button(text, action, icon, glyph, tone = '') {
  return `<button type="button" class="btn ${tone}" data-action="${action}">${icon(glyph,16)}${text}</button>`;
}

function listAmounts(rows, {escape,yen}) {
  return `<dl class="lr-money-list">${rows.map(([key,value]) => `<div><dt>${escape(key)}</dt><dd>${yen(value)}</dd></div>`).join('')}</dl>`;
}

function details(pay, api) {
  return listAmounts([['時給分',pay.hourlyPay],['確定歩合',pay.commission],['ポイント換金',pay.pointPay],
    ['手当合計',pay.allowanceTotal],['控除合計',-pay.deductionTotal],['日払い済み',-pay.advance]],api);
}

function panel(title, content) {
  return `<section class="lr-panel"><div class="lr-panel-head"><h2>${title}</h2></div>${content}</section>`;
}

function workDetails(pay, {escape,yen}) {
  return `<div class="analytics-table" tabindex="0"><table><thead><tr><th scope="col">営業日</th><th scope="col">勤務時間</th>
    <th scope="col">時給</th><th scope="col">記録元</th></tr></thead><tbody>${pay.work.map(({date,minutes,hourlyRate,source}) =>
    `<tr><th scope="row">${escape(date)}</th><td>${hours(minutes)}</td><td>${yen(hourlyRate)}</td><td>${source === 'attendance' ? '勤怠' : '手入力'}</td></tr>`).join('')}</tbody></table></div>`;
}

export function getPayrollPageSelection(state, month, castId) {
  const list = castMembers(state);
  const selected = list.find(({id}) => id === castId) ?? list.find((person) => person.enabled !== false) ?? list[0];
  return {month:isPayrollMonth(month) ? month : state.day.date.slice(0,7),castId:selected?.id ?? '',list};
}

function dailyPayRows(state, selection, {escape,icon,yen}, finalized) {
  const rows = getPayrollDailyPays(state,selection);
  const labels = {requested:'申請中',approved:'承認済み',rejected:'却下',paid:'支給済み'};
  const { limit, committed } = getDailyPayLimit(state,selection.month,selection.castId);
  return `<div class="ops-actions">${finalized ? '' : button('日払いを申請登録','payroll-request-pay',icon,'wallet')}</div>
    <p class="field-help">日払い目安 ${yen(limit)} ／ 申請・支給の合計 ${yen(committed)}</p>
    ${rows.length ? `<ul class="payroll-advances">${rows.map(({id,amount,status,reason,paidDate,method}) =>
      `<li><div><strong>${yen(amount)}</strong> <span class="lr-badge">${labels[status]}</span>
        ${paidDate ? `<small>${escape(paidDate)} ／ ${method === 'cash' ? '現金' : '振込'}</small>` : ''}
        ${reason ? `<small>${escape(reason)}</small>` : ''}</div><div class="ops-actions">${!finalized && status === 'requested'
        ? `<button type="button" class="btn" data-id="${escape(id)}" data-action="payroll-review-pay">申請を確認</button>`
        : !finalized && status === 'approved' && state.day.status === 'open' ? `<button type="button" class="btn" data-id="${escape(id)}" data-action="payroll-pay">支給を記録</button>` : ''}</div></li>`).join('')}</ul>`
    : '<p class="field-help">登録された日払いはありません。</p>'}`;
}

export function renderPayroll(state, api) {
  const {escape,icon,yen} = api;
  const selection = getPayrollPageSelection(state,api.month,api.castId);
  const {month,castId,list} = selection;
  const filters = `<section class="lr-period-tools" aria-label="給与の対象"><div class="lr-period-controls"><div class="lr-period-dates">
    <label class="lr-period-field"><span>給与月</span><input type="month" data-payroll-month value="${escape(month)}" required></label>
    <label class="lr-period-field"><span>キャスト</span><select data-payroll-cast>${list.map((person) =>
      `<option value="${escape(person.id)}"${person.id === castId ? ' selected' : ''}>${escape(person.name)}${person.enabled === false ? '（非表示）' : ''}</option>`).join('')}</select></label></div></div>
    <div class="lr-period-exports">${button('給与設定','payroll-settings',icon,'settings')}${castId ? button('時給を登録','payroll-rate',icon,'wallet') : ''}</div></section>`;
  if (!castId) return `<div class="lr-view">${filters}<p class="notice">給与を計算するキャストを店舗設定で登録してください。</p></div>`;
  const record = getPayrollDraft(state,month,castId);
  const finalized = record?.status === 'final';
  const pay = finalized ? record.snapshot : previewPayroll(state,{...record,month,castId});
  const displayStatus = finalized ? '確定明細' : record ? '下書き' : '試算';
  const rates = getPayrollRates(state,castId);
  const actions = finalized ? button('支給明細を印刷・PDF保存','payroll-print',icon,'printer','btn-secondary')
    : button(record ? '下書きを編集' : '下書きを作成','payroll-draft',icon,'ticket','btn-secondary')
      + (record ? button('給与を確定','payroll-finalize',icon,'check') : '');
  return `<div class="lr-view payroll-view">${filters}
    <section class="lr-panel payroll-total"><div><span class="lr-badge">${displayStatus}</span><h2>${escape(pay.castName)}</h2><p>支給合計</p><strong>${yen(pay.net)}</strong></div>
      <div class="ops-actions">${actions}</div></section>
    <div class="lr-split">${panel('支給内訳',details(pay,api))}${panel('勤務時間と時給',
    `<p class="field-help">承認済みの勤務時間 ${hours(pay.minutes)}</p>${pay.work.length ? workDetails(pay,api) : '<p class="field-help">勤務時間は給与の下書きで入力できます。</p>'}
    <details class="payroll-rate-history"><summary>登録済みの時給</summary>${rates.length ? listAmounts(rates.map(({effectiveDate,hourlyRate}) => [effectiveDate,hourlyRate]),api) : '<p class="field-help">このキャストの時給は登録されていません。</p>'}</details>`)}</div>
    ${pay.commissionDetails.length ? panel('確定歩合の内訳', listAmounts(pay.commissionDetails.map(({name,amount}) => [name,amount]),api)) : ''}
    ${panel('日払い',dailyPayRows(state,selection,api,finalized))}
    <p class="field-help">店舗で登録した手当と控除を集計します。源泉徴収・社会保険料の自動計算は対象外です。</p></div>`;
}

function input(title, html) {
  return `<label class="field"><span>${title}</span>${html}</label>`;
}

function yenInput(name, value, required = false) {
  return `<input type="number" name="${name}" value="${value}" min="0" max="100000000" step="1" inputmode="numeric"${required ? ' required' : ''}>`;
}

export function renderPayrollRows(kind, values, {escape,icon}, month) {
  const remove = (index) => `<button type="button" class="icon-btn" data-action="payroll-remove-row" data-kind="${kind}" data-id="${index}" aria-label="${kind === 'work' ? '勤務行' : '項目'}を削除">${icon('x',16)}</button>`;
  const last = new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate();
  return values.map((row,index) => `<div class="payroll-edit-row">${kind === 'work'
    ? input('営業日',`<input type="date" name="workDate" value="${escape(row.date ?? '')}" min="${escape(month)}-01" max="${escape(month)}-${last}">`)
      + input('勤務（分）',`<input type="number" name="workMinutes" min="1" max="1440" step="1" inputmode="numeric" value="${row.minutes ?? ''}">`)
    : input('項目名',`<input name="${kind}Label" maxlength="60" value="${escape(row.label ?? '')}">`)
      + input('金額（円）',yenInput(`${kind}Amount`,row.amount ?? ''))}${remove(index)}</div>`).join('');
}

export function renderPayrollDraft(draft, api) {
  const {month,work,allowances,deductions,manualAdvance} = draft;
  const sections = [['work','勤務時間',work],['allowance','手当',allowances],['deduction','控除',deductions]];
  return `<p class="form-copy">勤務時間は営業日ごとに入力します。確定した注文歩合は自動で集計します。</p>
    ${sections.map(([kind,title,rows]) => `<section class="payroll-edit-section"><h3>${title}</h3>
      <div data-payroll-rows="${kind}">${renderPayrollRows(kind,rows,api,month)}</div>
      <button type="button" class="btn" data-action="payroll-add-row" data-kind="${kind}">${api.icon('plus',16)}${title}を追加</button></section>`).join('')}
    ${input('別途支給済みの日払い（円）',yenInput('manualAdvance',manualAdvance ?? 0))}`;
}

export function readPayrollRows(form, kind) {
  const data = new FormData(form);
  const work = kind === 'work';
  const numeric = data.getAll(work ? 'workMinutes' : `${kind}Amount`);
  return data.getAll(work ? 'workDate' : `${kind}Label`).map((value,index) => ({
    [work ? 'date' : 'label']:value, [work ? 'minutes' : 'amount']:numeric[index] === '' ? null : Number(numeric[index]),
  }));
}

export function readPayrollDraft(form, selection) {
  const work = readPayrollRows(form,'work').filter(({date,minutes}) => date || minutes != null);
  const allowances = readPayrollRows(form,'allowance').filter(({label,amount}) => label || amount != null);
  const deductions = readPayrollRows(form,'deduction').filter(({label,amount}) => label || amount != null);
  return {month:selection.month,castId:selection.castId,work,allowances,deductions,
    manualAdvance:Number(new FormData(form).get('manualAdvance'))};
}

export function renderPayrollSettings(state) {
  const setting = getPayrollSettings(state);
  return `<div class="form-grid">${input('1ポイントあたりの換金額（円）',yenInput('payrollPointRate',setting.pointRate,true))}
    ${input('歩合の端数処理',`<select name="payrollRounding"><option value="floor"${setting.commissionRounding === 'floor' ? ' selected' : ''}>切り捨て</option><option value="nearest"${setting.commissionRounding === 'nearest' ? ' selected' : ''}>四捨五入</option></select>`)}
    ${input('歩合の丸め単位',`<select name="payrollUnit">${[1,10,100,1000].map((unit) => `<option value="${unit}"${setting.commissionUnit === unit ? ' selected' : ''}>${unit}円</option>`).join('')}</select>`)}
    ${input('日払い上限の目安（%）',`<input type="number" name="dailyPayLimit" min="0" max="100" step="0.01" value="${setting.dailyPayLimitBps / 100}" required inputmode="decimal">`)}</div>`;
}

export function renderDailyPayRequest(state, selection, {yen}) {
  const {limit,committed} = getDailyPayLimit(state,selection.month,selection.castId);
  return `<p class="form-copy">対象月 ${selection.month} ／ 日払い目安 ${yen(limit)} ／ 申請・支給の合計 ${yen(committed)}</p>
    ${input('申請額（円）','<input type="number" name="dailyPayAmount" min="1" max="100000000" step="1" required inputmode="numeric">')}
    ${input('申請メモ','<textarea name="reason" maxlength="120" rows="2"></textarea>')}`;
}

export function renderPayrollRate(state, {month,castId}, {escape}) {
  const name = castMembers(state).find(({id}) => id === castId)?.name ?? '';
  return `<p class="form-copy">${escape(name)}の時給を、指定した営業日から適用します。</p><div class="form-grid">
    ${input('適用開始日',`<input type="date" name="payrollRateDate" value="${escape(month)}-01" required>`)}
    ${input('時給（円）',yenInput('payrollHourlyRate','',true))}</div>`;
}

export function renderPayrollPrint(record, {escape,yen,storeName}) {
  const pay = record.snapshot;
  return `<div class="payroll-view"><header class="workspace-print-heading"><h1>支給明細</h1>
    <p>${escape(storeName)} ／ ${escape(record.month)} ／ ${escape(pay.castName)}</p></header>
    <p class="payroll-print-total"><strong>支給合計　${yen(pay.net)}</strong></p>
    ${panel('支給内訳',details(pay,{escape,yen}))}
    ${panel('勤務の内訳',pay.work.length ? workDetails(pay,{escape,yen}) : '<p>勤務時間の登録なし</p>')}
    ${pay.allowances.length ? panel('手当',listAmounts(pay.allowances.map(({label,amount}) => [label,amount]),{escape,yen})) : ''}
    ${pay.deductions.length ? panel('控除',listAmounts(pay.deductions.map(({label,amount}) => [label,amount]),{escape,yen})) : ''}
    <p>店舗で登録した手当・控除を記載しています。源泉徴収・社会保険料の自動計算は対象外です。</p></div>`;
}
