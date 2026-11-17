import { getDailyPayLimit, getPayrollDailyPays, getPayrollDraft, getPayrollRates, getPayrollSettings,
  getPayrollTemplateAssignment, getPayrollTemplates, isPayrollMonth, MissingPayrollRateError, previewPayroll } from './payroll.mjs';
import { advancedPayrollBases, getPayrollVariables, PayrollFormulaError } from './payroll-formula.mjs';
import { payrollActualOptionGroups } from './payroll-actuals.mjs';
import { getEmployeeProfile } from './payroll-records.mjs';
import { defaultPayrollStatementLayout, monthlyPayrollSections, payrollStatementLabels, payrollStatementNote,
  payrollSummaryAmounts } from './payroll-statement-layout.mjs';

const castMembers = (state) => [...state.cast, ...(state.archivedCast ?? [])];
const hours = (minutes) => `${Math.floor(minutes / 60)}時間 ${minutes % 60}分`;
const actualNumber = new Intl.NumberFormat('ja-JP',{maximumFractionDigits:4});
const ruleBases = {fixed:'定額',hourlyPay:'時給分の割合',commission:'確定歩合の割合',pointPay:'ポイント換金分の割合',
  baseGross:'時給・歩合・ポイントの合計に対する割合',formula:'四則演算',threshold:'条件分岐',progressive:'基準を超えた部分の割合'};

function button(text, action, icon, glyph, tone = '') {
  return `<button type="button" class="btn ${tone}" data-action="${action}">${icon(glyph,16)}${text}</button>`;
}

function listAmounts(rows, {escape,yen}) {
  return `<dl class="lr-money-list">${rows.map(([key,value]) => `<div><dt>${escape(key)}</dt><dd>${yen(value)}</dd></div>`).join('')}</dl>`;
}

function details(pay, api) {
  return listAmounts(payrollSummaryAmounts(pay),api);
}

function ruleAmounts(pay,api) {
  const rows = (pay.statementItems ?? []).filter(({kind}) => kind !== 'intermediate')
    .map(({label,kind,amount})=>[label,kind === 'deduction' ? -amount : amount]);
  return pay.templateColumns > 1
    ? `<div class="payroll-rule-layout" style="--payroll-columns:${pay.templateColumns}">${rows.map((row)=>listAmounts([row],api)).join('')}</div>`
    : listAmounts(rows,api);
}

function attendanceAmounts(items,api) {
  return `<dl class="lr-money-list">${items.map(({label,kind,amount})=>`<div><dt>${api.escape(label)}</dt>
    <dd>${kind === 'points' ? `${amount} pt` : api.yen(kind === 'deduction' ? -amount : amount)}</dd></div>`).join('')}</dl>`;
}

function actualAmounts({actuals,actualLabels}, {escape}) {
  return `<dl class="lr-money-list">${Object.entries(actuals).map(([key,value]) =>
    `<div><dt>${escape(actualLabels[key])}</dt><dd>${actualNumber.format(value)}</dd></div>`).join('')}</dl>`;
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

function dailyPayRows(state, selection, {escape,icon,yen}, {finalized, missingRate = false}) {
  const rows = getPayrollDailyPays(state,selection);
  const labels = {requested:'申請中',approved:'承認済み',rejected:'却下',paid:'支給済み'};
  let guidance = '<p class="field-help">日払いの目安は時給登録後に表示します。</p>';
  if (!missingRate) {
    const {limit,committed} = getDailyPayLimit(state,selection.month,selection.castId);
    guidance = `<p class="field-help">日払い目安 ${yen(limit)} ／ 申請・支給の合計 ${yen(committed)}</p>`;
  }
  return `${finalized || missingRate ? '' : `<div class="ops-actions">${button('日払いを申請登録','payroll-request-pay',icon,'wallet')}</div>`}${guidance}
    ${rows.length ? `<ul class="payroll-advances">${rows.map(({id,amount,status,reason,paidDate,method,vaultName}) =>
      `<li><div><strong>${yen(amount)}</strong> <span class="lr-badge">${labels[status]}</span>
        ${paidDate ? `<small>${escape(paidDate)} ／ ${method === 'vault' ? `金庫 ${escape(vaultName)}` : method === 'cash' ? 'レジ現金' : '振込'}</small>` : ''}
        ${reason ? `<small>${escape(reason)}</small>` : ''}</div><div class="ops-actions">${!finalized && !missingRate && status === 'requested'
        ? `<button type="button" class="btn" data-id="${escape(id)}" data-action="payroll-review-pay">申請を確認</button>`
        : !finalized && status === 'approved' && state.day.status === 'open' ? `<button type="button" class="btn" data-id="${escape(id)}" data-action="payroll-pay">支給を記録</button>`
        : status === 'paid' ? `<button type="button" class="btn" data-id="${escape(id)}" data-action="payroll-pay-receipt">受領書を印刷</button>` : ''}</div></li>`).join('')}</ul>`
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
    <div class="lr-period-exports">${button('給与設定','payroll-settings',icon,'settings')}${button('計算テンプレート','payroll-templates',icon,'ticket')}
      ${button('給与の個人別変数','payroll-variables',icon,'settings')}
      ${button('日付指定で集計','payroll-range',icon,'calendar')}${button('確定明細を一括出力','payroll-batch',icon,'printer')}
      ${button('勤怠項目','payroll-attendance-items',icon,'clock')}${castId ? button('時給を登録','payroll-rate',icon,'wallet')
        + button('従業員台帳','payroll-employee',icon,'user') : ''}</div></section>`;
  if (!castId) return `<div class="lr-view">${filters}<p class="notice">給与を計算するキャストを店舗設定で登録してください。</p></div>`;
  const record = getPayrollDraft(state,month,castId);
  const finalized = record?.status === 'final';
  const rates = getPayrollRates(state,castId);
  const rateHistory = `<details class="payroll-rate-history"><summary>登録済みの時給</summary>${rates.length
    ? listAmounts(rates.map(({effectiveDate,hourlyRate}) => [effectiveDate,hourlyRate]),api)
    : '<p class="field-help">このキャストの時給は登録されていません。</p>'}</details>`;
  let pay;
  try {
    pay = finalized ? record.snapshot : previewPayroll(state,{...record,month,castId});
  } catch (error) {
    if (error instanceof PayrollFormulaError) return `<div class="lr-view payroll-view">${filters}
      <p class="ops-highlight" role="status">${escape(error.message)}</p></div>`;
    if (!(error instanceof MissingPayrollRateError)) throw error;
    const name = list.find(({id}) => id === castId).name;
    return `<div class="lr-view payroll-view">${filters}
      ${panel(`${escape(name)}の時給を確認`,`<p class="ops-highlight" role="status">適用できる時給が未登録の営業日があります。時給を登録すると給与の試算を表示します。</p>
      <p class="field-help">対象の営業日　${error.dates.map(escape).join('・')}</p>${rateHistory}
      ${record ? `<div class="ops-actions">${button('下書きを編集','payroll-draft',icon,'ticket','btn-secondary')}</div>` : ''}`)}
      ${panel('日払い',dailyPayRows(state,selection,api,{finalized,missingRate:true}))}</div>`;
  }
  const displayStatus = finalized ? '確定明細' : record ? '下書き' : '試算';
  const actions = finalized ? button('支給明細を印刷・PDF保存','payroll-print',icon,'printer','btn-secondary')
    : button(record ? '下書きを編集' : '下書きを作成','payroll-draft',icon,'ticket','btn-secondary')
      + (record ? button('給与を確定','payroll-finalize',icon,'check') : '');
  return `<div class="lr-view payroll-view">${filters}
    <section class="lr-panel payroll-total"><div><span class="lr-badge">${displayStatus}</span><h2>${escape(pay.castName)}</h2>${pay.templateName ? `<p>計算テンプレート　${escape(pay.templateName)}</p>` : ''}<p>支給合計</p><strong>${yen(pay.net)}</strong></div>
      <div class="ops-actions">${actions}</div></section>
    <div class="lr-split">${panel('支給内訳',details(pay,api))}${panel('勤務時間と時給',
    `<p class="field-help">承認済みの勤務時間 ${hours(pay.minutes)}</p>${pay.work.length ? workDetails(pay,api) : '<p class="field-help">勤務時間は給与の下書きで入力できます。</p>'}
    ${rateHistory}`)}</div>
    ${pay.commissionDetails.length ? panel('確定歩合の内訳', listAmounts(pay.commissionDetails.map(({name,amount}) => [name,amount]),api)) : ''}
    ${pay.statementItems?.length ? panel('計算テンプレートの内訳',ruleAmounts(pay,api)) : ''}
    ${pay.formulaContext?.actuals ? panel('給与の計算に使用した実績',actualAmounts(pay.formulaContext,api)) : ''}
    ${pay.attendanceItems?.length ? panel('勤怠項目の内訳',attendanceAmounts(pay.attendanceItems,api)) : ''}
    ${panel('日払い',dailyPayRows(state,selection,api,{finalized}))}
    <p class="field-help">店舗で登録した手当と控除を集計します。源泉徴収・社会保険料の自動計算は対象外です。</p></div>`;
}

function input(title, html) {
  return `<label class="field"><span>${title}</span>${html}</label>`;
}

function yenInput(name, value, required = false) {
  return `<input type="number" name="${name}" value="${value}" min="0" max="100000000" step="1" inputmode="numeric"${required ? ' required' : ''}>`;
}

const profileFields = [
  ['number','従業員番号',32],['legalName','本名',80],['postalCode','郵便番号',16],
  ['address','住所',160],['phone','電話番号',32],['memo','メモ',400],
];

export function renderEmployeeProfile(state,castId,{escape}) {
  const profile = getEmployeeProfile(state,castId) ?? {};
  const person = castMembers(state).find(({id})=>id===castId);
  return `<p class="form-copy">${escape(person?.name ?? '')}の従業員台帳。店舗管理者だけが閲覧できます。</p><div class="form-grid">
    ${profileFields.map(([key,name,max])=>input(name,`<input name="employee-${key}" value="${escape(profile[key] ?? '')}"
      maxlength="${max}" autocomplete="off"${key === 'phone' ? ' type="tel"' : ''}>`)).join('')}</div>`;
}

export function readEmployeeProfile(data) {
  return Object.fromEntries(profileFields.map(([key])=>[key,data.get(`employee-${key}`)]));
}

const attendanceItemKinds = {allowance:'手当',deduction:'控除',points:'勤怠ポイント'};

export function renderAttendanceItemRow(row,{escape,icon}) {
  return `<div class="payroll-rule-row" data-payroll-attendance-item>
    <input type="hidden" name="attendanceItemId" value="${escape(row.id ?? '')}">
    <div class="form-grid">${input('項目名',`<input name="attendanceItemLabel" value="${escape(row.label ?? '')}" maxlength="60" required>`)}
    ${input('種類',`<select name="attendanceItemKind">${Object.entries(attendanceItemKinds).map(([key,label])=>
      `<option value="${key}"${row.kind === key ? ' selected' : ''}>${label}</option>`).join('')}</select>`)}
    ${input('金額（円）・ポイント',`<input type="number" name="attendanceItemAmount" min="0" max="1000000" step="1"
      inputmode="numeric" value="${row.amount ?? ''}" required>`)}</div>
    ${button('項目を削除','payroll-attendance-item-remove',icon,'x','btn-quiet')}</div>`;
}

export function renderAttendanceItems(state,api) {
  return `<p class="form-copy">勤怠の代理登録・訂正で選ぶ、手当・控除・ポイントです。以前の勤怠は登録時の金額とポイントを保持します。</p>
    <div data-payroll-attendance-items>${(state.attendanceItems ?? []).map((row)=>renderAttendanceItemRow(row,api)).join('')}</div>
    ${button('項目を追加','payroll-attendance-item-add',api.icon,'plus')}`;
}

export function readAttendanceItems(data) {
  const names = data.getAll('attendanceItemLabel');
  const ids = data.getAll('attendanceItemId');
  const kinds = data.getAll('attendanceItemKind');
  const amounts = data.getAll('attendanceItemAmount');
  return names.map((label,index)=>({id:ids[index] || null,label,kind:kinds[index],amount:Number(amounts[index])}));
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

export function renderPayrollTemplateRows(rules,{escape,icon,variables = [],state}) {
  const actualGroups = state && rules.some(({basis})=>advancedPayrollBases.has(basis)) ? payrollActualOptionGroups(state,rules) : [];
  return rules.map((row,index)=>`<div class="payroll-rule-row" data-payroll-rule>
    <div class="form-grid">
      ${input('項目名',`<input name="payrollRuleLabel" maxlength="60" value="${escape(row.label ?? '')}" required>`)}
      ${input('区分',`<select name="payrollRuleKind"><option value="allowance">手当</option><option value="deduction"${row.kind === 'deduction' ? ' selected' : ''}>控除</option>
      <option value="intermediate"${row.kind === 'intermediate' ? ' selected' : ''}>中間計算（印字しない）</option></select>`)}
      ${input('計算方法',`<select name="payrollRuleBasis">${Object.entries(ruleBases).map(([basis,name])=>`<option value="${basis}"${row.basis === basis ? ' selected' : ''}>${name}</option>`).join('')}</select>`)}
      <label class="field"${advancedPayrollBases.has(row.basis) ? ' hidden' : ''}><span data-payroll-rule-unit>${row.basis && row.basis !== 'fixed' ? '割合（%）' : '金額（円）'}</span><input name="payrollRuleValue" type="number" min="0"
        max="${row.basis && row.basis !== 'fixed' ? '100' : '100000000'}" step="${row.basis && row.basis !== 'fixed' ? '0.01' : '1'}"
        value="${row.value == null ? '' : row.basis === 'fixed' ? row.value : row.value / 100}" inputmode="decimal"${advancedPayrollBases.has(row.basis) ? '' : ' required'}></label>
    </div>${renderAdvancedRule(row,index,rules,{escape,variables,actualGroups})}
    <button type="button" class="btn btn-quiet" data-action="payroll-remove-rule" data-id="${index}">${icon('x',16)}削除</button></div>`).join('');
}

const advancedFields = ['left','leftValue','operator','right','rightValue','threshold','below','above','rate'];

function renderAdvancedRule(row,index,rules,{escape,variables,actualGroups}) {
  if (!advancedPayrollBases.has(row.basis)) return '';
  const groups = [['',[['number','指定値'],['hourlyPay','時給分'],['commission','歩合'],['pointPay','ポイント換金'],
    ['baseGross','時給・歩合・ポイントの合計'],['minutes','勤務分数'],['points','ポイント']]],
    ...actualGroups,['個人別変数',variables.map(({id,name})=>['var:' + id,name])],
    ['上の計算項目',rules.slice(0,index).map(({label},i)=>['item:' + i,label || `${i+1}行目`])]];
  const select = (key,label,options = groups) => input(label,`<select data-payroll-advanced="${key}">${options.map(([group,choices]) => {
    if (!choices.length) return '';
    const rendered = choices.map(([value,caption]) =>
      `<option value="${escape(value)}"${value === row[key] ? ' selected' : ''}>${escape(caption)}</option>`).join('');
    return group ? `<optgroup label="${escape(group)}">${rendered}</optgroup>` : rendered;
  }).join('')}</select>`);
  const value = (key,label) => input(label,`<input data-payroll-advanced="${key}" type="number" inputmode="decimal"
    step="0.0001" value="${Number.isFinite(row[key]) ? row[key] : 0}" required>`);
  return `<div class="form-grid">${select('left','計算元')}${value('leftValue','計算元が指定値の場合')}
    ${row.basis === 'formula' ? select('operator','演算',[['',[['+','足す'],['-','引く'],['*','掛ける'],['/','割る']]]])
      + select('right','計算相手') + value('rightValue','計算相手が指定値の場合')
      : value('threshold','基準値') + (row.basis === 'threshold'
        ? value('below','基準未満の場合（円）') + value('above','基準以上の場合（円）') : value('rate','超過分に掛ける割合（%）'))}</div>`;
}

export function readPayrollTemplateRows(form) {
  return [...form.querySelectorAll('[data-payroll-rule]')].map((row) => {
    const get = (name) => row.querySelector(`[name=payrollRule${name}]`).value;
    const basis = get('Basis');
    const result = {label:get('Label'),kind:get('Kind'),basis};
    if (!advancedPayrollBases.has(basis)) {
      const value = get('Value');
      return {...result,value:value === '' ? null : basis === 'fixed' ? Number(value) : Math.round(Number(value)*100)};
    }
    for (const key of advancedFields) {
      const field = row.querySelector(`[data-payroll-advanced=${key}]`);
      if (field) result[key] = field.type === 'number' ? field.valueAsNumber : field.value;
    }
    return result;
  });
}

function renderStatementLayout(layout,{icon},template = false) {
  const rows = layout ?? defaultPayrollStatementLayout();
  return `<details class="payroll-rate-history"${layout ? ' open' : ''}><summary>支給明細の表示・並び順</summary>
    <label class="inline-check"><input type="checkbox" name="payrollStatementLayoutEnabled"${layout ? ' checked' : ''}>${template ? 'このテンプレートの表示設定を使う' : '店舗共通の表示設定を使う'}</label>
    <p class="field-help">確定する月次明細の印刷と個別PDFに反映します。支給合計と支給内訳は常に表示します。${template ? '未選択の場合は店舗共通の設定を使用します。' : ''}</p>
    <ol class="payroll-advances" data-payroll-statement-layout>${rows.map(({key,visible,columns},index) => {
      const title = payrollStatementLabels[key];
      return `<li><input type="hidden" name="payrollStatementSection" value="${key}"><label class="inline-check">
        <input type="checkbox" name="payrollStatementVisible" value="${key}"${visible ? ' checked' : ''}${key === 'summary' ? ' disabled' : ''}>${title}</label>
        <select name="payrollStatementColumns-${key}" aria-label="${title}の列数">
          ${[1,2,3,4].map((number) => `<option value="${number}"${(columns ?? 1) === number ? ' selected' : ''}>${number}列</option>`).join('')}</select>
        <div class="ops-actions"><button type="button" class="icon-btn" data-action="payroll-layout-up" aria-label="${title}を上へ"${index === 0 ? ' disabled' : ''}>${icon('chevron-up',16)}</button>
        <button type="button" class="icon-btn" data-action="payroll-layout-down" aria-label="${title}を下へ"${index === rows.length - 1 ? ' disabled' : ''}>${icon('chevron-down',16)}</button></div></li>`;
    }).join('')}</ol></details>`;
}

export function readPayrollStatementLayout(data) {
  if (!data.has('payrollStatementLayoutEnabled')) return null;
  const visible = new Set(data.getAll('payrollStatementVisible'));
  return data.getAll('payrollStatementSection').map((key) => {
    const columns = Number(data.get(`payrollStatementColumns-${key}`) ?? 1);
    return {key,visible:key === 'summary' || visible.has(key),...(columns !== 1 && {columns})};
  });
}

export function movePayrollStatementSection(target) {
  const row = target.closest('li');
  const list = row?.parentElement;
  if (!list?.hasAttribute('data-payroll-statement-layout')) return;
  if (target.dataset.action === 'payroll-layout-up') row.previousElementSibling?.before(row);
  else row.nextElementSibling?.after(row);
  for (const [index,entry] of [...list.children].entries()) {
    entry.querySelector('[data-action=payroll-layout-up]').disabled = index === 0;
    entry.querySelector('[data-action=payroll-layout-down]').disabled = index === list.children.length - 1;
  }
  (target.disabled ? row.querySelector('button:not(:disabled)') : target)?.focus();
}

export function renderPayrollSettings(state,api) {
  const setting = getPayrollSettings(state);
  return `<div class="form-grid">${input('1ポイントあたりの換金額（円）',yenInput('payrollPointRate',setting.pointRate,true))}
    ${input('歩合の端数処理',`<select name="payrollRounding"><option value="floor"${setting.commissionRounding === 'floor' ? ' selected' : ''}>切り捨て</option><option value="nearest"${setting.commissionRounding === 'nearest' ? ' selected' : ''}>四捨五入</option></select>`)}
    ${input('歩合の丸め単位',`<select name="payrollUnit">${[1,10,100,1000].map((unit) => `<option value="${unit}"${setting.commissionUnit === unit ? ' selected' : ''}>${unit}円</option>`).join('')}</select>`)}
    ${input('日払い上限の目安（%）',`<input type="number" name="dailyPayLimit" min="0" max="100" step="0.01" value="${setting.dailyPayLimitBps / 100}" required inputmode="decimal">`)}</div>
    <section class="payroll-edit-section"><h3>店舗共通の計算項目</h3><p class="field-help">個別テンプレートを割り当てていないキャストの下書きに適用します。確定した明細は確定時点の金額で保存されます。</p>
      <div data-payroll-rules>${renderPayrollTemplateRows(setting.statementRules ?? [],{...api,state,variables:getPayrollVariables(state)})}</div>
      ${button('計算項目を追加','payroll-add-rule',api.icon,'plus')}</section>${renderStatementLayout(setting.statementLayout,api)}`;
}

export function renderPayrollTemplates(state, {castId}, api) {
  const {escape,icon} = api;
  const templates = getPayrollTemplates(state);
  const cast = castMembers(state);
  const person = cast.find(({id}) => id === castId);
  const selected = getPayrollTemplateAssignment(state,castId);
  return `${person ? input(`${escape(person.name)}に適用するテンプレート`,`<select name="payrollTemplateId"><option value="">店舗共通</option>
      ${templates.map(({id,name})=>`<option value="${escape(id)}"${selected === id ? ' selected' : ''}>${escape(name)}</option>`).join('')}</select>`) : ''}
    <p class="field-help">割り当てを変更すると、選んだキャストの未確定の給与に適用します。</p>
    <section class="payroll-edit-section"><h3>登録済みのテンプレート</h3>
      ${templates.length ? `<ul class="payroll-advances">${templates.map(({id,name,rules}) => {
        const count = cast.filter((member) => getPayrollTemplateAssignment(state,member.id) === id).length
          + (state.staffPayroll?.templateAssignments ?? []).filter(({templateId}) => templateId === id).length;
        return `<li><div><strong>${escape(name)}</strong><small>計算項目 ${rules.length}件 ／ 使用中 ${count}名</small></div>
          <div class="ops-actions"><button type="button" class="btn" data-action="payroll-template-editor" data-id="${escape(id)}" aria-label="${escape(name)}を編集">編集</button>
          ${count ? '' : `<button type="button" class="btn" data-action="payroll-template-remove" data-id="${escape(id)}" aria-label="${escape(name)}を削除">削除</button>`}</div></li>`;
      }).join('')}</ul>` : '<p class="field-help">個別テンプレートは登録されていません。</p>'}
      ${templates.length < 20 ? button('テンプレートを追加','payroll-template-editor',icon,'plus') : ''}</section>`;
}

export function renderPayrollTemplateEditor(template, api) {
  return `${input('テンプレート名',`<input name="payrollTemplateName" value="${api.escape(template?.name ?? '')}" maxlength="60" required>`)}
    ${input('画面の計算内訳の列数',`<select name="payrollTemplateColumns">${[1,2,3,4].map((value)=>
      `<option value="${value}"${template?.columns === value ? ' selected' : ''}>${value}列</option>`).join('')}</select>`)}
    <label class="inline-check"><input type="checkbox" name="payrollTemplateDefault"${template?.isDefault ? ' checked' : ''}>店舗の既定にする</label>
    <p class="field-help">割り当てたキャストの未確定の給与に適用する手当・控除を指定します。</p>
    <section class="payroll-edit-section"><h3>計算項目</h3>
      <p class="field-help">商品・分類別は会計時の注文明細を集計します。複数人が担当した数量は人数で分け、売上調整は確定した個人売上の合計に反映します。</p><div data-payroll-rules>
      ${renderPayrollTemplateRows(template?.rules ?? [],api)}</div>
      ${button('計算項目を追加','payroll-add-rule',api.icon,'plus')}</section>${renderStatementLayout(template?.statementLayout,api,true)}`;
}

export function renderPayrollBatch(state,selection,{escape}) {
  const people = castMembers(state);
  return `<div class="form-grid payroll-period-fields">${input('開始月',`<input name="batchStart" type="month" value="${escape(selection.month)}" required>`)}
    ${input('終了月',`<input name="batchEnd" type="month" value="${escape(selection.month)}" required>`)}
    ${input('対象',`<select name="batchCast"><option value="">全キャスト</option>
      ${people.map(({id,name})=>`<option value="${escape(id)}">${escape(name)}</option>`).join('')}</select>`)}
    ${input('出力形式','<select name="batchOutput"><option value="print">一括印刷・PDF保存</option><option value="zip">個別PDFをZIPで保存</option></select>')}</div>
    <p class="field-help">指定した給与月の確定明細を出力します。ZIPにはキャスト・給与月ごとにPDFが入ります。</p>`;
}

export function payrollRangeDefaults(month) {
  const firstDay = `${month}-01`;
  const lastDay = new Date(firstDay);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1,0);
  return {start:firstDay,end:lastDay.toISOString().slice(0,10),castId:''};
}

function payrollRangeExport(result,api) {
  const {escape,icon} = api;
  if (result.unavailableDates.length) return '';
  const active = result.rows.filter(({hasActivity}) => hasActivity);
  if (!active.length) return '';
  const canExport = ({missingDates,pendingDates}) => !missingDates.length && !pendingDates.length;
  const eligible = active.filter(canExport);
  return `<fieldset class="choices payroll-range-export"><legend>参考明細を出力するキャスト</legend>
    <div class="choice-grid">${active.map((row) => {
      const available = canExport(row);
      return `<label class="choice"><input type="checkbox" name="rangeExportCast" value="${escape(row.castId)}"${available ? ' checked' : ' disabled'}>
        <span><strong>${escape(row.castName)}</strong>${available ? '' : '<small>集計データの確認が必要</small>'}</span></label>`;
    }).join('')}</div>
    ${eligible.length ? `<div class="ops-actions">${eligible.length > 1
      ? button('すべて選択','payroll-range-select-all',icon,'check') + button('選択を解除','payroll-range-select-none',icon,'x') : ''}
      ${button('期間参考明細PDFをZIP保存','payroll-range-export',icon,'download','btn-secondary')}</div>` : ''}
    <p class="field-help">営業日と支給日で集計した参考明細を、選んだキャストごとにPDFで保存します。確定明細は給与月を選んで出力できます。</p></fieldset>`;
}

export function readPayrollRange(data) {
  return {start:data.get('rangeStart'),end:data.get('rangeEnd'),castId:data.get('rangeCast')};
}

export function renderPayrollRange(state,{range,result},api) {
  const {escape,yen} = api;
  const filters = `<div class="form-grid payroll-period-fields">${input('開始営業日',`<input type="date" name="rangeStart" value="${escape(range.start)}" required>`)}
    ${input('終了営業日',`<input type="date" name="rangeEnd" value="${escape(range.end)}" required>`)}
    ${input('対象',`<select name="rangeCast"><option value="">全キャスト</option>${castMembers(state).map(({id,name}) =>
      `<option value="${escape(id)}"${id === range.castId ? ' selected' : ''}>${escape(name)}</option>`).join('')}</select>`)}</div>
    <p class="field-help">勤怠・確定歩合は営業日、日払いは実際の支給日で集計します。月次テンプレートと日付のない手当・控除・日払い調整は月次明細で確認できます。</p>`;
  if (!result) return filters;
  const columns = ['勤務時間','時給分','確定歩合','ポイント換金','勤怠手当','勤怠控除','日払い済み','差引額'];
  const unavailable = result.unavailableDates.length > 0;
  const cells = (row,missing) => {
    const values = [hours(row.minutes),missing ? '未集計' : yen(row.hourlyPay),unavailable ? '一部欠損' : yen(row.commission),
      unavailable ? '一部欠損' : yen(row.pointPay),yen(row.allowanceTotal),yen(0 - row.deductionTotal),yen(0 - row.advance),
      row.net === null ? '未集計' : yen(row.net)];
    return columns.map((label,index)=>`<td><span class="payroll-range-caption" aria-hidden="true">${label}</span>${values[index]}</td>`).join('');
  };
  const table = `<div class="analytics-table payroll-range-table" tabindex="0"><table role="table">
    <thead><tr><th scope="col">キャスト</th>${columns.map((label)=>`<th scope="col">${label}</th>`).join('')}</tr></thead>
    <tbody>${result.rows.map((row) => `<tr><th scope="row">${escape(row.castName)}</th>${cells(row,row.missingDates.length)}</tr>`).join('')}</tbody>
    ${!range.castId ? `<tfoot><tr><th scope="row">合計</th>${cells(result.totals,result.rows.some(({missingDates}) => missingDates.length))}</tr></tfoot>` : ''}
    </table></div>`;
  return `${filters}<h3>集計結果　${escape(result.start)} 〜 ${escape(result.end)}</h3>
    <p class="field-help">選択期間分の時給・歩合・ポイントは給与月ごとに丸めてから合算します。差引額は期間内の参考額です。</p>
    ${result.unavailableDates.length ? `<p class="ops-highlight">歩合の元データが不足しているため、参考明細は出力できません。${result.unavailableDates.map(escape).join('・')}</p>` : ''}
    ${result.rows.some((row) => row.hasActivity) ? table : '<p class="field-help">この期間に集計できる勤怠・確定歩合・支給済みの日払いはありません。</p>'}
    ${result.rows.filter((row) => row.missingDates.length).map((row) =>
      `<p class="ops-highlight">${escape(row.castName)}の時給未登録日　${row.missingDates.map(escape).join('・')}</p>`).join('')}
    ${result.rows.filter((row) => row.pendingDates.length).map((row) =>
      `<p class="ops-highlight">${escape(row.castName)}は勤怠を確認してから参考明細を出力できます。${row.pendingDates.map(escape).join('・')}</p>`).join('')}
    ${payrollRangeExport(result,api)}
    ${result.rows.filter((row) => row.work.length || row.advances.length).map((row) =>
      `<details class="payroll-rate-history"><summary>${escape(row.castName)}の勤怠・日払いの内訳</summary>
      ${row.work.length ? workDetails(row,api) : ''}
      ${row.advances.length ? listAmounts(row.advances.map(({paidDate,month,method,amount}) =>
        [`${paidDate} ／ ${method === 'cash' ? '現金' : '振込'} ／ ${month}分`,amount]),api) : ''}</details>`).join('')}`;
}

export function renderDailyPayRequest(state, selection, {yen}) {
  const {limit,committed} = getDailyPayLimit(state,selection.month,selection.castId);
  return `<p class="form-copy">対象月 ${selection.month} ／ 日払い目安 ${yen(limit)} ／ 申請・支給の合計 ${yen(committed)}</p>
    ${input('申請額（円）','<input type="number" name="dailyPayAmount" min="1" max="100000000" step="1" required inputmode="numeric">')}
    ${input('申請メモ','<textarea name="reason" maxlength="120" rows="2"></textarea>')}`;
}

export function payrollVariableRows(rows,{escape,icon},castId) {
  return rows.map(({id,name,defaultValue,value},index) => `<div class="payroll-rule-row" data-payroll-variable>
    <input type="hidden" name="variableId" value="${escape(id ?? '')}"><div class="form-grid">
    ${input('変数名',`<input name="variableName" maxlength="60" value="${escape(name ?? '')}" required>`)}
    ${input('未設定時の値',`<input name="variableDefault" type="number" step="0.0001" value="${defaultValue ?? 0}" required>`)}
    ${castId ? input('選択中のキャストの値（任意）',`<input name="variableValue" type="number" step="0.0001" value="${value ?? ''}">`) : ''}
    </div><button type="button" class="btn btn-quiet" data-action="payroll-variable-remove" data-id="${index}">${icon('x',16)}削除</button></div>`).join('');
}

export function renderPayrollVariables(state,castId,api) {
  const person = castMembers(state).find(({id}) => id === castId);
  const variables = getPayrollVariables(state).map((entry)=>({...entry,value:entry.overrides.find((row)=>row.castId === castId)?.value}));
  return `<p class="form-copy">${person ? escapeName(person,api) : '店舗共通の値'}を設定します。計算テンプレートから変数名で参照できます。</p>
    <div data-payroll-variables>${payrollVariableRows(variables,api,castId)}</div>
    ${button('変数を追加','payroll-variable-add',api.icon,'plus')}`;
}

function escapeName(person,{escape}) {
  return `${escape(person.name)}の値と店舗共通の値`;
}

export function readPayrollVariables(form) {
  const data = new FormData(form);
  const defaults = data.getAll('variableDefault');
  const values = data.getAll('variableValue');
  const ids = data.getAll('variableId');
  return data.getAll('variableName').map((name,i)=>({id:ids[i] || null,name,defaultValue:Number(defaults[i]),
    value:values[i] ? Number(values[i]) : null}));
}

export function renderPayrollRate(state, {month,castId}, {escape}) {
  const name = castMembers(state).find(({id}) => id === castId)?.name ?? '';
  return `<p class="form-copy">${escape(name)}の時給を、指定した営業日から適用します。</p><div class="form-grid">
    ${input('適用開始日',`<input type="date" name="payrollRateDate" value="${escape(month)}-01" required>`)}
    ${input('時給（円）',yenInput('payrollHourlyRate','',true))}</div>`;
}

export function renderPayrollPrint(record, {escape,yen,storeName}) {
  const pay = record.snapshot;
  const sections = pay.settings?.statementLayout ? monthlyPayrollSections(pay,yen).map(([title,rows,columns]) =>
    panel(title,`<dl class="lr-money-list payroll-statement-print-grid" data-columns="${columns}">${rows.map(([label,value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`)).join('')
    : `${panel('支給内訳',details(pay,{escape,yen}))}
    ${pay.workWithheld ? '' : panel('勤務の内訳',pay.work.length ? workDetails(pay,{escape,yen}) : '<p>勤務時間の登録なし</p>')}
    ${pay.allowances.length ? panel('手当',listAmounts(pay.allowances.map(({label,amount}) => [label,amount]),{escape,yen})) : ''}
    ${pay.deductions.length ? panel('控除',listAmounts(pay.deductions.map(({label,amount}) => [label,amount]),{escape,yen})) : ''}
    ${pay.statementItems?.length ? panel('計算テンプレートの内訳',ruleAmounts(pay,{escape,yen})) : ''}
    ${pay.attendanceItems?.length ? panel('勤怠項目の内訳',attendanceAmounts(pay.attendanceItems,{escape,yen})) : ''}`;
  return `<div class="payroll-view"><header class="workspace-print-heading"><h1>支給明細</h1>
    <p>${escape(storeName)} ／ ${escape(record.month)} ／ ${escape(pay.castName)}</p></header>
    <p class="payroll-print-total"><strong>支給合計　${yen(pay.net)}</strong></p>
    ${sections}<p>${payrollStatementNote}</p></div>`;
}
