import { getPersonalSalesDiscountMode, maxPersonalSalesAdjustment, personalSalesDiscountModes } from './personal-sales.mjs';
import { castDutyModes } from './cast-duty.mjs';

const timestamp = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const japaneseNumber = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 6 });
const moneyFields = new Set(['amount', 'total', 'subtotal', 'discount', 'price', 'value', 'cost', 'unitCost', 'expectedCash', 'actualCash', 'discrepancy',
  'received', 'change', 'cardFee', 'grossAmount', 'net', 'manualAdvance', 'hourlyRate', 'pointRate', 'personalSales', 'adjustmentAmount']);
const omittedAuditFields = new Set(['receivable', 'receivableSales', 'recoveries', 'recoveryRows', 'creditLimit', 'creditEnabled', 'creditOverride']);
const roles = { admin: '店舗管理者', manager: 'マネージャー', staff: 'スタッフ', cast:'キャスト' };

const auditLabels = {
  discount: '値引き', discountRequest: '値引き申請', approveDiscount: '値引き承認', rejectDiscount: '値引き却下',
  adjustPersonalSales: '個人売上の調整',
  cancelLine: '注文取消', void: '伝票取消', settle: '会計確定', cancelSettlement: '会計取消', reopenTicket: '伝票の再オープン',
  correctSettledTicketPayments: '会計済み伝票の支払方法訂正',
  correctSettledContents:'会計済み伝票の注文・値引き訂正',
  deposit: '前受金の登録', editDeposit: '前受金の訂正', cancelDeposit: '前受金の取消', stockAdjust: '在庫調整', recordStockOperation: '在庫の入出庫・棚卸',
  saveStoreSettings: '店舗設定の変更', saveLayout: '卓レイアウトの変更', importStoreConfiguration: '店舗設定の読み込み',
  saveRolePolicy:'役職・権限の設定変更',
  saveCashAccounts:'金庫・出金先の設定変更',
  saveCustomer: '顧客情報の登録・変更', setTicketCustomer: '伝票の顧客設定', correctSettledTicketCustomer: '会計済み伝票の顧客訂正',
  setTicketCompanion: '伝票の同席者を変更', correctSettledTicketCompanion: '会計済み伝票の同席者訂正',
  mergeCustomers: '顧客の統合', linkCustomer: '来店と顧客の関連づけ',
  importCustomers: '顧客の一括登録',
  recordCashMovement: '入出金の記録', editCashMovement:'入出金の訂正', voidCashMovement:'入出金の取消',
  correctRegisterCount:'閉店時の実残高の訂正', saveAccountingCsv:'会計CSV設定の変更', close: '閉店・レジ締め',
  savePrintSettings: '印刷設定の変更', issuePrintDocument: '伝票・領収書の発行',
  saveAutoExtensionSettings: '自動延長設定の変更', setTableAutoExtension: '卓別の自動延長設定', syncAutoExtensions: '自動延長',
  pauseVisitAutoExtension: '来店単位の自動延長停止', resumeVisitAutoExtension: '来店単位の自動延長再開', saveCardFeeSettings: 'カード会計加算設定の変更',
  importLayout: '卓レイアウトの読み込み', saveControls: '運用設定の変更', migrate: '営業データの移行',
  savePayrollDraft: '給与の下書き保存', finalizePayroll: '給与の確定', savePayrollRate: '時給の変更', savePayrollSettings: '給与設定の変更',
  savePayrollTemplate: '給与テンプレートの保存', assignPayrollTemplate: '給与テンプレートの割り当て', removePayrollTemplate: '給与テンプレートの削除',
  savePayrollVariables:'給与の個人別変数の更新',
  saveEmployeeProfile:'従業員台帳の変更', saveAttendanceItems:'勤怠項目の変更', saveManagedAttendance:'勤怠の代理登録・訂正',
  saveStaffPerson:'勤務者台帳の変更',saveStaffRate:'勤務者の時給変更',saveStaffAttendance:'役職別勤怠の記録・訂正',voidStaffAttendance:'役職別勤怠の取消',
  requestDailyPay: '日払いの申請', reviewDailyPay: '日払いの審査', payDailyPay: '日払いの支給',
  saveTicketNote: '伝票メモの変更', adjustTicketEnd: '終了時刻の調整', adjustTicketGuests: '利用人数の変更',
  extendOverdue:'一括延長', seat:'来店登録', order:'注文登録', move:'卓移動・連結', extend:'延長登録',
  depart:'退店', serve:'提供済み', editTicketLine:'注文訂正', cancelTicketExtension:'延長の取消',
  bindCastAccount:'キャストアカウントの設定', castClockIn:'出勤打刻', castClockOut:'退勤打刻', reviewCastAttendance:'勤怠の確認',
  castRequestShift:'勤務希望の申請', castRequestDailyPay:'本人の日払い申請',
  saveCalculationSettings:'税とサービス料の計算設定',
  saveShift: 'シフトの登録・更新', removeShift: 'シフトの削除',
  saveInitialSetSchedule: '時間帯別セットの変更',
};

const valueLabels = {
  personalSales:'個人売上', adjustmentAmount:'調整額', adjustmentId:'調整記録ID',
  personalSalesMode:'値引きの個人売上への反映', ...personalSalesDiscountModes,
  calculationSettings:'会計の計算設定', serviceRateBps:'サービス料率', serviceRounding:'サービス料の端数',
  taxRounding:'消費税の端数', serviceBase:'サービス料の計算基準', priceMode:'メニュー価格',
  allowOrderServiceExclusion:'注文明細ごとのサービス料除外', serviceExcluded:'サービス料対象外',
  serviceExclusionReason:'サービス料の除外理由',
  allowOrderTaxOverride:'注文明細ごとの税率変更', taxRate:'適用した消費税率', originalTaxRate:'注文時のメニュー税率',
  taxOverrideReason:'税率の変更理由',
  allowOrderLineDiscount:'注文明細ごとの値引き',lineDiscount:'明細値引き',lineDiscountReason:'明細値引きの理由',
  percent:'割合',lineDiscountRateBps:'値引き率',
  beforeDiscount:'値引き前',afterDiscount:'値引き後',exclusive:'税抜価格',inclusive:'税込価格',
  floor:'切り捨て',round:'四捨五入',ceil:'切り上げ',
  amount: '金額', total: '合計', subtotal: '小計', discount: '値引き額', status: '状態', payments: '支払い',
  deposits: '前受金', quantity: '数量', name: '名称', price: '単価', managerDiscountRateBps: '値引き上限',
  castDutyMode:'注文の担当キャストの候補',
  discountRequest: '値引き申請', discountDetails: '適用した値引き', commission: '歩合', stockMovements: '在庫の増減',
  menu: 'メニュー・プラン', cast: 'キャスト', stock: '在庫品目', tables: '卓', areas: 'エリア', tableIds: '使用卓',
  changedFields: '変更項目', customerId: '顧客ID', customerName: '顧客名',
  kind: '種類', category: '理由区分', destination: '相手先・移動先',
  stocktake: '棚卸', purchase: '仕入れ・入庫', loss: '廃棄・破損（ロス）', usage: '店舗消費', adjust: '数量調整', unitCost: '仕入単価',
  expectedCash: 'レジ理論残高', actualCash: 'レジ実残高', discrepancy: 'レジ差額',
  cashTender: '現金のお預かりとお釣り', received: '現金お預かり', change: 'お釣り', cashDenominations: '金種別の枚数',
  issueNumber: '発行回数', width: '用紙幅（mm）', storeName: '印字する店名', address: '住所', phone: '電話番号',
  registrationNumber: '登録番号', showItems: '明細を印字', autoReceipt: '会計時のレシート自動印刷',
  enabled: '有効', menuId: '延長プラン', rateBps: '加算率', cardFee: '決済加算', grossAmount: '受取額',
  brandName: '決済ブランド', cardFeeRateBps: '決済加算率', feeWaived: '加算を免除', waivedFeeRate: '免除した加算率',
  paused: '今回の停止', source: '操作', manual: '通知から停止', checkout: '通知から会計へ',
  method: '決済方法', reason: '理由', points: 'ポイント', cost: '原価', value: '評価額',
  request: '承認申請', approved: '承認', rejected: '却下', pending: '承認待ち', paid: '会計済み',
  cancelled: '取消済み', departed: '退店済み', open: '利用中', cash: '現金', card: 'カード', qr: 'QR決済', bank: '振込',
  hourlyRate: '時給', effectiveDate: '適用開始日', net: '支給額', work: '勤務', allowances: '手当', deductions: '控除', manualAdvance: '手入力の日払い済み額',
  pointRate: 'ポイント換金単価', commissionRounding: '歩合の端数処理', commissionUnit: '歩合の丸め単位', dailyPayLimitBps: '日払い上限率',
  draft: '下書き', final: '確定', requested: '申請中', castName: 'キャスト名', month: '給与対象月',
  reviewReason: '審査理由', paidDate: '支給営業日', cashMovementId: '入出金記録ID', floor: '切り捨て', nearest: '四捨五入',
  note: '伝票メモ', endsAt: '終了時刻', extensionCount:'延長回数', extensionPlan:'延長プラン',
  startsAt:'開始時刻', arrivedAt:'来店時刻', providedAt:'提供時刻', cancelledAt:'取消時刻', lines:'注文明細', castNames:'歩合対象者',
  guests:'滞在人数', admittedGuests:'来店人数の合計', guestChangeMode:'変更方法', correct:'人数の訂正', join:'途中合流', leave:'一部退店',
};

function inputLabel(label, control) {
  return `<label class="field"><span>${label}</span>${control}</label>`;
}

export function operationReason({ title = '理由', required = true } = {}) {
  return inputLabel(title, `<textarea name="reason" rows="2" maxlength="120"${required ? ' required' : ''} placeholder="具体的な理由を入力"></textarea>`);
}

export function renderDiscountForm({ticket, subtotal, limit, role, reasonCodes, priceMode}, {escape, yen}) {
  const existing = ticket.discountRequest;
  const mode = existing?.mode ?? 'amount';
  const personalSales = existing?.personalSalesMode ?? getPersonalSalesDiscountMode(ticket);
  const subtotalLabel = priceMode === 'inclusive' ? '税込小計' : '税抜小計';
  return `<p class="form-copy">${subtotalLabel} ${yen(subtotal)} · 適用中の値引き ${yen(ticket.discount)}</p>
    ${existing ? `<p class="ops-highlight" role="status">${yen(existing.amount)}の承認待ちです。新しい申請で差し替えられます。</p>` : ''}
    <div class="form-grid">
      ${inputLabel('指定方法', `<select name="discountMode"><option value="amount"${mode === 'amount' ? ' selected' : ''}>金額（円）</option><option value="percent"${mode === 'percent' ? ' selected' : ''}>率（%）</option></select>`)}
      ${inputLabel(mode === 'percent' ? '値引き率（%）' : '値引き額（円）', `<input name="discountValue" type="number" min="0" max="${mode === 'percent' ? 100 : subtotal}" step="${mode === 'percent' ? '0.01' : '1'}" value="${existing?.value ?? ticket.discount}" inputmode="decimal" required>`)}
    </div>
    ${inputLabel('値引きの個人売上への反映', `<select name="personalSalesMode">${Object.entries(personalSalesDiscountModes).map(([key,text]) =>
      `<option value="${key}"${personalSales === key ? ' selected' : ''}>${text}</option>`).join('')}</select>`)}
    ${inputLabel('理由区分', `<select name="reasonCode" required><option value="">選択してください</option>${Object.entries(reasonCodes).map(([key,value]) => `<option value="${escape(key)}"${existing?.reasonCode === key ? ' selected' : ''}>${escape(value)}</option>`).join('')}</select>`)}
    ${inputLabel('理由の詳細', `<textarea name="reason" rows="2" maxlength="120" required placeholder="例　クーポンを受領したため">${escape(existing?.reason ?? '')}</textarea>`)}
    <p class="field-help" id="discount-preview" aria-live="polite">${role === 'manager' ? `小計の${limit / 100}%を超える場合は管理者の承認が必要です。` : `値引きは${subtotalLabel}に適用します。`}</p>`;
}

export function renderPersonalSalesAdjustment(ticket, people, commission, { escape, yen }) {
  const byCast = new Map(commission.map(({ castId, sales }) => [castId, sales]));
  const options = people.map(({ id, name }) => `<option value="${escape(id)}">${escape(name)} · ${yen(byCast.get(id) ?? 0)}</option>`).join('');
  const rows = (ticket.personalSalesAdjustments ?? []).slice().reverse().map((row) =>
    `<li><span><strong>${escape(row.castName)}</strong><br><small>${escape(row.reason)} · ${escape(row.actor.label)} · ${timestamp.format(row.at)}</small></span>
      <strong class="money">${row.amount > 0 ? '+' : '−'}${yen(Math.abs(row.amount))}</strong></li>`).join('');
  return `<p class="form-copy">キャスト別の個人売上だけを調整します。歩合・ポイントは注文に基づいて計算します。</p>
    ${people.length ? `${inputLabel('キャストと現在の個人売上', `<select name="personalSalesCast" required><option value="">選択してください</option>${options}</select>`)}
      <div class="form-grid">${inputLabel('増減', '<select name="personalSalesDirection"><option value="add">加算</option><option value="subtract">減算</option></select>')}
      ${inputLabel('金額（円）', `<input type="number" name="personalSalesAmount" min="1" max="${maxPersonalSalesAdjustment}" step="1" inputmode="numeric" required>`)}</div>
      ${operationReason({ title:'個人売上を調整する理由' })}` : '<p class="field-help">対象にできるキャストがいません。</p>'}
    ${rows ? `<section><h3>この伝票の調整履歴</h3><ul class="deposit-list">${rows}</ul></section>` : ''}`;
}

function visibleAuditFields(value) {
  return Object.entries(value).filter(([field]) => !omittedAuditFields.has(field));
}

function readableValue(value, key) {
  if (value == null) return value;
  if (key === 'castDutyMode') return castDutyModes[value] ?? value;
  if (['startsAt','endsAt','arrivedAt','providedAt','cancelledAt'].includes(key) && Number.isFinite(new Date(value).getTime())) return timestamp.format(value);
  if (['managerDiscountRateBps','rateBps','dailyPayLimitBps','serviceRateBps','cardFeeRateBps','waivedFeeRate',
    'taxRate','originalTaxRate','lineDiscountRateBps'].includes(key)) return `${value / 100}%`;
  if (typeof value === 'number' && moneyFields.has(key)) return `¥${japaneseNumber.format(value)}`;
  if (typeof value === 'string') return valueLabels[value] ?? value;
  if (Array.isArray(value)) return value.filter((entry) => entry?.method !== 'receivable'
    && (key !== 'changedFields' || !omittedAuditFields.has(entry))).map((entry) => readableValue(entry));
  if (typeof value === 'object') return Object.fromEntries(visibleAuditFields(value).map(([field, entry]) =>
    [valueLabels[field] ?? field, readableValue(entry, field)]));
  return value;
}

function displayValue(value, key) {
  const readable = readableValue(value, key);
  if (readable == null) return '—';
  return typeof readable === 'object' ? JSON.stringify(readable, null, 2) : String(readable);
}

function auditTarget(target) {
  if (!target || typeof target === 'string') return target ?? '';
  return target.label ?? target.name ?? (target.ticketNumber ? `伝票 No. ${target.ticketNumber}` : target.id ?? '');
}

function auditValues(title, value, escape) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return `<div><h4>${title}</h4><pre>${escape(displayValue(value))}</pre></div>`;
  return `<div><h4>${title}</h4><dl>${visibleAuditFields(value).map(([key, entry]) => `<div><dt>${escape(valueLabels[key] ?? key)}</dt><dd><pre>${escape(displayValue(entry,key))}</pre></dd></div>`).join('')}</dl></div>`;
}

export function renderAuditLog({entries, loading, more, failed}, {escape, icon}) {
  const visible = entries.filter((entry) => entry.action !== 'recoverReceivable' && entry.target?.kind !== 'receivable'
    && !(entry.action === 'saveCustomer' && entry.after?.changedFields?.length
      && entry.after.changedFields.every((field) => omittedAuditFields.has(field))));
  const rows = visible.map((entry) => {
    const at = new Date(entry.at);
    const date = Number.isFinite(at.getTime()) ? timestamp.format(at) : '—';
    const label = auditLabels[entry.action] ?? entry.action;
    const reason = entry.action === 'settle' && entry.after?.receivable?.creditOverride ? '会計を確定' : entry.reason;
    return `<details class="ops-audit-row"><summary>
      <span class="ops-audit-header"><span class="ops-audit-action">${escape(label)}</span><span>${escape(auditTarget(entry.target))}</span></span>
      <span class="ops-audit-meta"><time>${escape(date)}</time><span>${escape(entry.actor?.label ?? entry.actor?.id ?? '—')}</span>
        ${roles[entry.actor?.role] ? `<span>${roles[entry.actor.role]}</span>` : ''}</span>
    </summary><div class="ops-audit-detail">
      ${['correctSettledTicketCustomer', 'correctSettledTicketCompanion', 'correctSettledTicketPayments'].includes(entry.action) ? `<p class="ops-audit-reason"><strong>会計の営業日</strong> ${escape(entry.businessDate)}</p>` : ''}
      ${reason ? `<p class="ops-audit-reason"><strong>理由</strong> ${escape(reason)}</p>` : ''}
      <div class="ops-audit-compare">${auditValues('変更前', entry.before, escape)}${auditValues('変更後', entry.after, escape)}</div>
    </div></details>`;
  }).join('');
  return `<div class="ops-audit">
    ${failed ? `<p role="alert" class="form-error">${escape(failed)}</p>` : ''}
    ${rows || (loading || failed ? '' : '<p class="form-copy">表示できる監査記録がありません。</p>')}
    ${loading ? '<p class="form-copy" role="status">監査ログを読み込んでいます。</p>' : ''}
    ${more || failed ? `<button type="button" class="btn btn-secondary" data-action="audit-more"${loading ? ' disabled' : ''}>${icon('history', 16)}${failed ? '読み込みを再試行' : '以前の記録を表示'}</button>` : ''}
    </div>`;
}
