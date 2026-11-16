import { getDailyPayLimit, getPayrollDailyPays, getPayrollDraft, getPayrollRates, getPayrollSettings,
  getPayrollTemplateAssignment, getPayrollTemplates, isPayrollMonth, MissingPayrollRateError, previewPayroll } from './payroll.mjs';

const castMembers = (state) => [...state.cast, ...(state.archivedCast ?? [])];
const hours = (minutes) => `${Math.floor(minutes / 60)}時間 ${minutes % 60}分`;
const ruleBases = {fixed:'定額',hourlyPay:'時給分の割合',commission:'確定歩合の割合',pointPay:'ポイント換金分の割合',baseGross:'時給・歩合・ポイントの合計に対する割合'};

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

function ruleAmounts(pay,api) {
  return listAmounts((pay.statementItems ?? []).map(({label,kind,amount})=>[label,kind === 'deduction' ? -amount : amount]),api);
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
    ${rows.length ? `<ul class="payroll-advances">${rows.map(({id,amount,status,reason,paidDate,method}) =>
      `<li><div><strong>${yen(amount)}</strong> <span class="lr-badge">${labels[status]}</span>
        ${paidDate ? `<small>${escape(paidDate)} ／ ${method === 'cash' ? '現金' : '振込'}</small>` : ''}
        ${reason ? `<small>${escape(reason)}</small>` : ''}</div><div class="ops-actions">${!finalized && !missingRate && status === 'requested'
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
    <div class="lr-period-exports">${button('給与設定','payroll-settings',icon,'settings')}${button('計算テンプレート','payroll-templates',icon,'ticket')}${castId ? button('時給を登録','payroll-rate',icon,'wallet') : ''}</div></section>`;
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
    ${panel('日払い',dailyPayRows(state,selection,api,{finalized}))}
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

export function renderPayrollTemplateRows(rules,{escape,icon}) {
  return rules.map((row,index)=>`<div class="payroll-rule-row" data-payroll-rule>
    <div class="form-grid">
      ${input('項目名',`<input name="payrollRuleLabel" maxlength="60" value="${escape(row.label ?? '')}" required>`)}
      ${input('区分',`<select name="payrollRuleKind"><option value="allowance">手当</option><option value="deduction"${row.kind === 'deduction' ? ' selected' : ''}>控除</option></select>`)}
      ${input('計算方法',`<select name="payrollRuleBasis">${Object.entries(ruleBases).map(([basis,name])=>`<option value="${basis}"${row.basis === basis ? ' selected' : ''}>${name}</option>`).join('')}</select>`)}
      <label class="field"><span data-payroll-rule-unit>${row.basis && row.basis !== 'fixed' ? '割合（%）' : '金額（円）'}</span><input name="payrollRuleValue" type="number" min="0"
        max="${row.basis && row.basis !== 'fixed' ? '100' : '100000000'}" step="${row.basis && row.basis !== 'fixed' ? '0.01' : '1'}"
        value="${row.value == null ? '' : row.basis === 'fixed' ? row.value : row.value / 100}" inputmode="decimal" required></label>
    </div><button type="button" class="btn btn-quiet" data-action="payroll-remove-rule" data-id="${index}">${icon('x',16)}削除</button></div>`).join('');
}

export function readPayrollTemplateRows(form) {
  const data = new FormData(form);
  const labels = data.getAll('payrollRuleLabel');
  const kinds = data.getAll('payrollRuleKind');
  const bases = data.getAll('payrollRuleBasis');
  const values = data.getAll('payrollRuleValue');
  return labels.map((label,index)=>({label,kind:kinds[index],basis:bases[index],value:values[index] === '' ? null
    : bases[index] === 'fixed' ? Number(values[index]) : Math.round(Number(values[index]) * 100)}));
}

export function renderPayrollSettings(state,api) {
  const setting = getPayrollSettings(state);
  return `<div class="form-grid">${input('1ポイントあたりの換金額（円）',yenInput('payrollPointRate',setting.pointRate,true))}
    ${input('歩合の端数処理',`<select name="payrollRounding"><option value="floor"${setting.commissionRounding === 'floor' ? ' selected' : ''}>切り捨て</option><option value="nearest"${setting.commissionRounding === 'nearest' ? ' selected' : ''}>四捨五入</option></select>`)}
    ${input('歩合の丸め単位',`<select name="payrollUnit">${[1,10,100,1000].map((unit) => `<option value="${unit}"${setting.commissionUnit === unit ? ' selected' : ''}>${unit}円</option>`).join('')}</select>`)}
    ${input('日払い上限の目安（%）',`<input type="number" name="dailyPayLimit" min="0" max="100" step="0.01" value="${setting.dailyPayLimitBps / 100}" required inputmode="decimal">`)}</div>
    <section class="payroll-edit-section"><h3>店舗共通の計算項目</h3><p class="field-help">個別テンプレートを割り当てていないキャストの下書きに適用します。確定した明細は確定時点の金額で保存されます。</p>
      <div data-payroll-rules>${renderPayrollTemplateRows(setting.statementRules ?? [],api)}</div>
      ${button('計算項目を追加','payroll-add-rule',api.icon,'plus')}</section>`;
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
        const count = cast.filter((member) => getPayrollTemplateAssignment(state,member.id) === id).length;
        return `<li><div><strong>${escape(name)}</strong><small>計算項目 ${rules.length}件 ／ 使用中 ${count}名</small></div>
          <div class="ops-actions"><button type="button" class="btn" data-action="payroll-template-editor" data-id="${escape(id)}" aria-label="${escape(name)}を編集">編集</button>
          ${count ? '' : `<button type="button" class="btn" data-action="payroll-template-remove" data-id="${escape(id)}" aria-label="${escape(name)}を削除">削除</button>`}</div></li>`;
      }).join('')}</ul>` : '<p class="field-help">個別テンプレートは登録されていません。</p>'}
      ${templates.length < 20 ? button('テンプレートを追加','payroll-template-editor',icon,'plus') : ''}</section>`;
}

export function renderPayrollTemplateEditor(template, api) {
  return `${input('テンプレート名',`<input name="payrollTemplateName" value="${api.escape(template?.name ?? '')}" maxlength="60" required>`)}
    <p class="field-help">割り当てたキャストの未確定の給与に適用する手当・控除を指定します。</p>
    <section class="payroll-edit-section"><h3>計算項目</h3><div data-payroll-rules>
      ${renderPayrollTemplateRows(template?.rules ?? [],api)}</div>
      ${button('計算項目を追加','payroll-add-rule',api.icon,'plus')}</section>`;
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
    ${pay.statementItems?.length ? panel('計算テンプレートの内訳',ruleAmounts(pay,{escape,yen})) : ''}
    <p>店舗で登録した手当・控除を記載しています。源泉徴収・社会保険料の自動計算は対象外です。</p></div>`;
}
