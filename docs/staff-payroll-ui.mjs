import { getStaffPayrollDraft, getStaffPayrollTemplateId, previewStaffPayroll, staffPayRangeNote } from './staff-payroll.mjs';
import { getPayrollTemplates } from './payroll.mjs';
import { payrollWorkRows } from './payroll-statement-layout.mjs';

const hours = (minutes) => `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
const field = (label,control) => `<label class="field"><span>${label}</span>${control}</label>`;
const time = new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'});

export function staffPayrollPrintRecord(record) {
  if (record.castId) return record;
  const pay = record.snapshot;
  return {...record,snapshot:{...pay,castName:pay.personName,commission:0,pointPay:0,commissionDetails:[],advance:0}};
}

function payResult(pay,api) {
  const {escape,yen} = api;
  const lines = [['実働時間',hours(pay.minutes)],['時給分',yen(pay.hourlyPay)],['手当',yen(pay.allowanceTotal)],['控除',yen(pay.deductionTotal)]];
  if (pay.commission) lines.push(['確定歩合',yen(pay.commission)]);
  if (pay.pointPay) lines.push(['ポイント換金',yen(pay.pointPay)]);
  if (pay.advance) lines.push(['日払い',yen(pay.advance)]);
  const adjustments = pay.statementItems?.filter(({kind}) => kind !== 'intermediate') ?? [];
  return `<dl class="lr-money-list">${lines.map(([item,value]) => `<div><dt>${item}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>
    ${adjustments.length ? `<h3>${escape(pay.templateName ?? '計算テンプレート')}</h3><dl class="lr-money-list">
      ${adjustments.map(({label,kind,amount}) => `<div><dt>${escape(label)}</dt><dd>${yen(kind === 'deduction' ? -amount : amount)}</dd></div>`).join('')}</dl>` : ''}
    <div class="result-bar"><span>支給合計</span><strong>${yen(pay.net)}</strong></div>`;
}

function outputButtons({button},scope,month = '') {
  return `<div class="ops-actions">${button('A4で印刷',`staff-payroll-${scope}-print`,{id:month,glyph:'printer'})}
    ${button('PDFを保存',`staff-payroll-${scope}-pdf`,{id:month,glyph:'download'})}</div>`;
}

export function renderOwnStaffPayroll(model, api,seenMonths = new Set()) {
  if (!model) return '<p class="notice">打刻と支給明細を使うには、店舗管理者に勤務者アカウントのひもづけを依頼してください。</p>';
  const {person,records,attendance = []} = model;
  const {escape,yen,icon,button} = api;
  const working = attendance[0]?.clockOutAt === null;
  const notices = records.filter(({month}) => !seenMonths.has(month)).sort((first,second) => second.month.localeCompare(first.month));
  return `<div class="lr-view"><section class="lr-panel"><div class="lr-panel-head"><h2>自分の打刻</h2>
    ${button(working ? '退勤する' : '出勤する',working ? 'staff-payroll-own-clock-out' : 'staff-payroll-own-clock-in',{glyph:'clock'})}</div>
    ${attendance.length ? `<ul class="cast-self-list">${attendance.map((row) => `<li><strong>${escape(row.date)}</strong><span>${time.format(row.clockInAt)} 〜 ${row.clockOutAt === null ? '勤務中' : time.format(row.clockOutAt)}</span></li>`).join('')}</ul>`
      : '<p class="lr-report-note">勤務の記録はまだありません。</p>'}</section>
    ${notices.length ? `<section class="lr-panel"><div class="lr-panel-head"><h2>給与のお知らせ</h2></div><ul class="cast-self-list" aria-live="polite">
      ${notices.map(({month}) => `<li><strong>${escape(month)}の給与が確定しました</strong>${button('明細を確認','staff-payroll-own-notice',{id:month,glyph:'ticket'})}</li>`).join('')}</ul></section>` : ''}
    <section class="lr-panel"><div class="lr-panel-head"><h2>${escape(person.name)}の支給明細</h2></div>
    ${records.length ? records.slice().sort((a,b) => b.month.localeCompare(a.month)).map((record) => `<details class="lr-day" id="staff-payslip-${escape(record.month)}">
      <summary><span class="lr-day-icon" aria-hidden="true">${icon('wallet',16)}</span><strong>${escape(record.month)}</strong>
        <strong class="lr-day-sales">${yen(record.snapshot.net)}</strong><span class="lr-day-chevron" aria-hidden="true">${icon('chevron-down',17)}</span></summary>
      <div class="lr-day-details">${payResult(record.snapshot,api)}${outputButtons(api,'own',record.month)}</div></details>`).join('')
      : '<p class="lr-report-note">確定済みの支給明細はまだありません。</p>'}</section></div>`;
}

export function getManagedPayrollOptions(model, admin) {
  if (!model) return [];
  return [...model.people.map(({id,name,enabled}) => ({key:`staff:${id}`,id,name,kind:'staff',enabled})),
    ...(admin ? [] : model.cast.map(({id,name}) => ({key:`cast:${id}`,id,name:`${name}（キャスト）`,kind:'cast',enabled:true})))];
}

export function findManagedPayrollRecord(state, model, person, month, admin) {
  if (!person) return null;
  if (admin && person.kind === 'staff') return getStaffPayrollDraft(state,person.id,month);
  return person.kind === 'cast' ? model?.castRecords.find(({castId,month:date}) => castId === person.id && date === month) ?? null
    : model?.records.find(({personId,month:date}) => personId === person.id && date === month) ?? null;
}

export function renderManagedStaffPayroll(state,model,{admin,person,month,viewPayslips,viewRates,editRates},api) {
  const {escape,yen,button} = api;
  const options = getManagedPayrollOptions(model,admin);
  const record = findManagedPayrollRecord(state,model,person,month,admin);
  const rates = (person?.kind === 'cast' ? model?.castRates?.filter(({castId}) => castId === person.id)
    : model?.rates?.filter(({personId}) => personId === person?.id)) ?? [];
  let result = '';
  if (person && viewPayslips) {
    const final = record?.snapshot;
    let pending;
    let error = '';
    if (admin && !final) {
      try { pending = previewStaffPayroll(state,record ?? {month,personId:person.id}); }
      catch (issue) { error = issue.message; }
    }
    result = `<section class="lr-panel"><div class="lr-panel-head"><h2>${escape(person.name)}の${final ? '確定明細' : '給与'}</h2></div>
      ${error ? `<p class="lr-report-note" role="status">${escape(error)}</p>` : ''}
      ${final || pending ? payResult(final ?? pending,api) : !error ? '<p class="lr-report-note">この月の確定明細はありません。</p>' : ''}
      ${final ? outputButtons(api,'managed',month) : admin ? `<div class="ops-actions">${button(record ? '下書きを編集' : '下書きを作成','staff-payroll-draft')}
        ${record && pending ? button('給与を確定','staff-payroll-finalize',{tone:'primary'}) : ''}</div>` : ''}</section>`;
  }
  const ratePanel = person && (viewRates || editRates) ? `<section class="lr-panel"><div class="lr-panel-head"><h2>適用開始日付きの時給</h2>
    ${editRates ? button('時給を登録・訂正','staff-payroll-rate',{glyph:'plus'}) : ''}</div>${viewRates ? rates.length
      ? `<dl class="lr-money-list">${rates.slice().sort((a,b) => b.effectiveDate.localeCompare(a.effectiveDate)).map((rate) => `<div><dt>${escape(rate.effectiveDate)}</dt><dd>${yen(rate.hourlyRate)}</dd></div>`).join('')}</dl>`
      : '<p class="lr-report-note">時給履歴はありません。</p>' : ''}</section>` : '';
  return `<div class="lr-view"><section class="lr-period-tools"><div class="form-grid">
    ${field('給与月',`<input type="month" data-staff-payroll-month value="${escape(month)}">`)}
    ${field('勤務者',`<select data-staff-payroll-person>${options.length ? options.map((entry) => `<option value="${escape(entry.key)}"${entry.key === person?.key ? ' selected' : ''}>${escape(entry.name)}${entry.enabled ? '' : '（退職済み）'}</option>`).join('') : '<option value="">未登録</option>'}</select>`)}</div>
    <div class="ops-actions">${admin && person ? button('計算テンプレート','staff-payroll-templates',{glyph:'settings'})
      + button('日付指定で集計','staff-payroll-range',{glyph:'calendar'}) : ''}
    ${viewPayslips ? button('従業員の確定明細を一括出力','staff-payroll-managed-batch',{glyph:'download'}) : ''}</div></section>
    ${!person ? '<p class="notice">勤怠・人件費で勤務者を登録してください。</p>' : ''}${result}${ratePanel}</div>`;
}

export function renderStaffPayrollTemplates(state,person,{escape,button}) {
  const assigned = getStaffPayrollTemplateId(state,person.id);
  const templates = getPayrollTemplates(state);
  const options = templates.map(({id,name}) => `<option value="${escape(id)}"${id === assigned ? ' selected' : ''}>${escape(name)}</option>`);
  return `${field(`${escape(person.name)}の計算テンプレート`,`<select name="staffPayrollTemplate"><option value="">指定なし</option>${options.join('')}</select>`)}
    <p class="field-help">割り当ては未確定の給与に適用します。勤務分数・勤務日数・時給分を利用できます。キャストの注文・指名・歩合に関する値は0として計算します。</p>
    <section class="payroll-edit-section"><h3>登録済みのテンプレート</h3><ul class="payroll-advances">
    ${templates.map(({id,name}) => `<li><strong>${escape(name)}</strong>${button('編集する','staff-payroll-template-editor',{id,glyph:'settings'})}</li>`).join('')}</ul>
    ${templates.length < 20 ? button('テンプレートを追加','staff-payroll-template-editor',{glyph:'plus'}) : ''}</section>`;
}

export function renderStaffPayrollBatch({model,person,month},{escape}) {
  const people = model.people.map(({id,name}) => `<option value="${escape(id)}"${person?.kind === 'staff' && person.id === id ? ' selected' : ''}>${escape(name)}</option>`);
  return `<div class="form-grid">${field('開始月',`<input name="staffPayrollStart" type="month" value="${escape(month)}" required>`)}
    ${field('終了月',`<input name="staffPayrollEnd" type="month" value="${escape(month)}" required>`)}
    ${field('対象',`<select name="staffPayrollPerson"><option value="">スタッフ・マネージャー全員</option>${people.join('')}</select>`)}</div>
    <p class="field-help">該当する確定済みの支給明細を、個別のPDFにしてZIPで保存します。</p>`;
}

export function renderStaffPayrollRange({person,month,range,result},{escape,yen,button}) {
  const endDate = new Date(`${month}-01T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1,0);
  return `<div class="form-grid">${field('開始営業日',`<input name="staffPayrollStart" type="date" value="${escape(range?.start ?? `${month}-01`)}" required>`)}
    ${field('終了営業日',`<input name="staffPayrollEnd" type="date" value="${escape(range?.end ?? endDate.toISOString().slice(0,10))}" required>`)}</div>
    <p class="field-help">${staffPayRangeNote}</p>
    ${result ? `<div class="ops-highlight"><strong>${escape(person.name)} ／ ${hours(result.snapshot.minutes)}</strong><strong>${yen(result.snapshot.hourlyPay)}</strong></div>
      <div class="ops-actions">${button('A4で印刷','staff-payroll-range-print',{glyph:'printer'})}${button('PDFを保存','staff-payroll-range-pdf',{glyph:'download'})}</div>` : ''}`;
}

export function renderStaffPayrollRangePrint({start,end,snapshot},{escape,yen,storeName}) {
  return `<div class="payroll-view"><header class="workspace-print-heading"><h1>従業員の給与期間参考明細</h1>
    <p>${escape(storeName)} ／ ${escape(snapshot.personName)} ／ ${escape(start)} 〜 ${escape(end)}</p></header>
    <p class="payroll-print-total"><strong>時給分　${yen(snapshot.hourlyPay)}</strong></p><dl class="lr-money-list">
    ${payrollWorkRows(snapshot.work,yen).map(([label,value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>
    <p>${staffPayRangeNote}</p></div>`;
}

export function renderStaffPayrollAdjustment(kind,row,{escape,icon}) {
  const title = kind === 'allowance' ? '手当' : '控除';
  return `<div class="payroll-edit-row" data-staff-payroll-adjustment>${field(`${title}の名前`, `<input name="${kind}Label" maxlength="60" value="${escape(row.label ?? '')}">`)}
    ${field('金額（円）',`<input type="number" name="${kind}Amount" min="0" max="100000000" step="1" inputmode="numeric" value="${escape(row.amount ?? '')}">`)}
    <button type="button" class="icon-btn" data-action="staff-payroll-remove-adjustment" aria-label="${title}の項目を削除">${icon('x',16)}</button></div>`;
}

export function renderStaffPayrollDraft(draft,api) {
  return `<p class="form-copy">記録済みの勤怠と適用開始日付きの時給から基本給を試算します。</p>
    ${[['allowance','手当',draft?.allowances],['deduction','控除',draft?.deductions]].map(([kind,title,rows]) => `<section class="payroll-edit-section"><h3>${title}</h3>
      <div data-staff-adjustments="${kind}">${(rows?.length ? rows : [{}]).map((row) => renderStaffPayrollAdjustment(kind,row,api)).join('')}</div>
      ${api.button(`${title}を追加`,'staff-payroll-add-adjustment',{id:kind,glyph:'plus'})}</section>`).join('')}`;
}

export function readStaffPayrollAdjustments(data,kind) {
  const amounts = data.getAll(`${kind}Amount`);
  return data.getAll(`${kind}Label`).flatMap((value,index) => {
    const label = String(value).trim();
    const amount = amounts[index];
    if (!label && amount === '') return [];
    if (!label || amount === '') throw new Error('手当・控除の名前と金額を入力してください。');
    return [{label,amount:Number(amount)}];
  });
}

export function renderStaffPayrollFinal(pay,api) {
  return `<p class="form-copy">${api.escape(pay.month)} ${api.escape(pay.personName)}の給与を確定します。確定時点の明細を保存します。</p>${payResult(pay,api)}`;
}
