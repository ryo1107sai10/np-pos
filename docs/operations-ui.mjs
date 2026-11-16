const timestamp = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const japaneseNumber = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 6 });
const moneyFields = new Set(['amount', 'total', 'subtotal', 'discount', 'price', 'value', 'cost', 'balance', 'creditLimit', 'balanceBefore', 'expectedCash', 'actualCash', 'discrepancy']);
const roles = { admin: '店舗管理者', manager: 'マネージャー', staff: 'スタッフ' };

const auditLabels = {
  discount: '値引き', discountRequest: '値引き申請', approveDiscount: '値引き承認', rejectDiscount: '値引き却下',
  cancelLine: '注文取消', void: '伝票取消', settle: '会計確定', cancelSettlement: '会計取消', reopenTicket: '伝票の再オープン',
  deposit: '前受金の登録', cancelDeposit: '前受金の取消', stockAdjust: '在庫調整',
  saveStoreSettings: '店舗設定の変更', saveLayout: '卓レイアウトの変更', importStoreConfiguration: '店舗設定の読み込み',
  saveCustomer: '顧客情報の登録・変更', mergeCustomers: '顧客の統合', linkCustomer: '来店と顧客の関連づけ',
  importCustomers: '顧客の一括登録', recoverReceivable: '売掛の回収',
  recordCashMovement: '入出金の記録', close: '閉店・レジ締め',
  importLayout: '卓レイアウトの読み込み', saveControls: '運用設定の変更', migrate: '営業データの移行',
};

const valueLabels = {
  amount: '金額', total: '合計', subtotal: '小計', discount: '値引き額', status: '状態', payments: '支払い',
  deposits: '前受金', quantity: '数量', name: '名称', price: '単価', managerDiscountRateBps: '値引き上限',
  discountRequest: '値引き申請', discountDetails: '適用した値引き', commission: '歩合', stockMovements: '在庫の増減',
  menu: 'メニュー・プラン', cast: 'キャスト', stock: '在庫品目', tables: '卓', areas: 'エリア', tableIds: '使用卓',
  balance: '売掛残高', creditLimit: '売掛上限', balanceBefore: '計上前の残高', dueDate: '支払期日',
  creditOverride: '上限超過の承認', collection: '回収', changedFields: '変更項目', creditEnabled: '売掛利用',
  kind: '種類', category: '理由区分', destination: '相手先・移動先',
  expectedCash: 'レジ理論残高', actualCash: 'レジ実残高', discrepancy: 'レジ差額',
  method: '決済方法', reason: '理由', points: 'ポイント', cost: '原価', value: '評価額',
  request: '承認申請', approved: '承認', rejected: '却下', pending: '承認待ち', paid: '会計済み',
  cancelled: '取消済み', departed: '退店済み', open: '利用中', cash: '現金', card: 'カード', qr: 'QR決済', bank: '振込', receivable: '売掛',
};

function inputLabel(label, control) {
  return `<label class="field"><span>${label}</span>${control}</label>`;
}

export function operationReason({ title = '理由', required = true } = {}) {
  return inputLabel(title, `<textarea name="reason" rows="2" maxlength="120"${required ? ' required' : ''} placeholder="具体的な理由を入力"></textarea>`);
}

export function renderDiscountForm({ticket, subtotal, limit, role, reasonCodes}, {escape, yen}) {
  const existing = ticket.discountRequest;
  const mode = existing?.mode ?? 'amount';
  return `<p class="form-copy">税抜小計 ${yen(subtotal)} · 適用中の値引き ${yen(ticket.discount)}</p>
    ${existing ? `<p class="ops-highlight" role="status">${yen(existing.amount)}の承認待ちです。新しい申請で差し替えられます。</p>` : ''}
    <div class="form-grid">
      ${inputLabel('指定方法', `<select name="discountMode"><option value="amount"${mode === 'amount' ? ' selected' : ''}>金額（円）</option><option value="percent"${mode === 'percent' ? ' selected' : ''}>率（%）</option></select>`)}
      ${inputLabel(mode === 'percent' ? '値引き率（%）' : '値引き額（円）', `<input name="discountValue" type="number" min="0" max="${mode === 'percent' ? 100 : subtotal}" step="${mode === 'percent' ? '0.01' : '1'}" value="${existing?.value ?? ticket.discount}" inputmode="decimal" required>`)}
    </div>
    ${inputLabel('理由区分', `<select name="reasonCode" required><option value="">選択してください</option>${Object.entries(reasonCodes).map(([key,value]) => `<option value="${escape(key)}"${existing?.reasonCode === key ? ' selected' : ''}>${escape(value)}</option>`).join('')}</select>`)}
    ${inputLabel('理由の詳細', `<textarea name="reason" rows="2" maxlength="120" required placeholder="例　クーポンを受領したため">${escape(existing?.reason ?? '')}</textarea>`)}
    <p class="field-help" id="discount-preview" aria-live="polite">${role === 'manager' ? `小計の${limit / 100}%を超える場合は管理者の承認が必要です。` : '値引きは税抜小計に適用します。'}</p>`;
}

function readableValue(value, key) {
  if (value == null) return value;
  if (key === 'managerDiscountRateBps') return `${value / 100}%`;
  if (typeof value === 'number' && moneyFields.has(key)) return `¥${japaneseNumber.format(value)}`;
  if (typeof value === 'string') return valueLabels[value] ?? value;
  if (Array.isArray(value)) return value.map((entry) => readableValue(entry));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, entry]) =>
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
  return `<div><h4>${title}</h4><dl>${Object.entries(value).map(([key, entry]) => `<div><dt>${escape(valueLabels[key] ?? key)}</dt><dd><pre>${escape(displayValue(entry,key))}</pre></dd></div>`).join('')}</dl></div>`;
}

export function renderAuditLog({entries, loading, more, failed}, {escape, icon}) {
  const rows = entries.map((entry) => {
    const at = new Date(entry.at);
    const date = Number.isFinite(at.getTime()) ? timestamp.format(at) : '—';
    const label = auditLabels[entry.action] ?? entry.action;
    return `<details class="ops-audit-row"><summary>
      <span class="ops-audit-header"><span class="ops-audit-action">${escape(label)}</span><span>${escape(auditTarget(entry.target))}</span></span>
      <span class="ops-audit-meta"><time>${escape(date)}</time><span>${escape(entry.actor?.label ?? entry.actor?.id ?? '—')}</span>
        ${roles[entry.actor?.role] ? `<span>${roles[entry.actor.role]}</span>` : ''}</span>
    </summary><div class="ops-audit-detail">${entry.reason ? `<p class="ops-audit-reason"><strong>理由</strong> ${escape(entry.reason)}</p>` : ''}
      <div class="ops-audit-compare">${auditValues('変更前', entry.before, escape)}${auditValues('変更後', entry.after, escape)}</div>
    </div></details>`;
  }).join('');
  return `<div class="ops-audit">
    ${failed ? `<p role="alert" class="form-error">${escape(failed)}</p>` : ''}
    ${rows || (loading || failed ? '' : '<p class="form-copy">監査ログはまだありません。値引きや在庫調整を記録すると表示されます。</p>')}
    ${loading ? '<p class="form-copy" role="status">監査ログを読み込んでいます。</p>' : ''}
    ${more || failed ? `<button type="button" class="btn btn-secondary" data-action="audit-more"${loading ? ' disabled' : ''}>${icon('history', 16)}${failed ? '読み込みを再試行' : '以前の記録を表示'}</button>` : ''}
    </div>`;
}
