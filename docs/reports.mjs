import { cashMovementCategories, cashMovementKinds } from './cash-ledger.mjs';
import { cashAccounts, vaultBalance } from './cash-accounts.mjs';
import { cashDenominations } from './register-cash.mjs';
import { businessDate, getTicketCommissionDetails, getTicketTableLabels } from './engine.mjs';
import { operationBusinessDate, registerCutoff } from './register-config.mjs';
import { getInventoryCostSummary, purchaseCancellationBlocker } from './inventory-operations.mjs';
import { getReportPeriod } from './report-period.mjs';
import { getDailyPayTotals } from './payroll.mjs';
import { barcodeScannerAvailable } from './barcode-scanner.mjs';

const formatDay = new Intl.DateTimeFormat('ja-JP', {
  month: 'short', day: 'numeric', weekday: 'short', timeZone: 'Asia/Tokyo',
});
const formatTime = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tokyo',
});
const movementTime = new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tokyo',
});
const number = new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 3});
const stockNumber = new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 6});
const asNumber = (value) => Number(value) || 0;
const byId = (items) => new Map(items.map((item) => [item.id, item]));
const total = (items, field) => items.reduce((sum, item) => sum + asNumber(item[field]), 0);
const cashMethods = [ ['cash', '現金'], ['card', 'カード'], ['qr', 'QR決済'] ];

function dateLabel(value) {
  if (!value) return '—';
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00+09:00`) : new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : formatDay.format(date);
}

function timeLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : formatTime.format(date);
}

function signedQuantity(value) {
  const quantity = asNumber(value);
  return `${quantity > 0 ? '+' : quantity < 0 ? '−' : ''}${stockNumber.format(Math.abs(quantity))}`;
}

function stat({icon}, glyph, label, value, tone = '') {
  return `<article class="lr-stat${tone ? ' lr-stat-' + tone : ''}"><span class="lr-stat-icon" aria-hidden="true">${icon(glyph, 18)}</span>
    <span class="lr-stat-label">${label}</span><strong>${value}</strong></article>`;
}

function panel(label, body, control = '') {
  return `<section class="lr-panel"><div class="lr-panel-head"><h2>${label}</h2>${control}</div>${body}</section>`;
}

function panelCount(count, suffix) {
  return `<span class="lr-count">${number.format(count)}${suffix}</span>`;
}

function empty({icon}, glyph, label, detail) {
  return `<div class="lr-empty"><span aria-hidden="true">${icon(glyph, 23)}</span><strong>${label}</strong><p>${detail}</p></div>`;
}

function table({escape}, headers, rows, variant = '') {
  return `<div class="lr-scroll"><table class="lr-table${variant ? ' ' + variant : ''}"><thead><tr>${headers.map((heading) =>
    `<th scope="col">${escape(heading)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function ticketLink(ticket, {escape, icon}) {
  if (!ticket) return '—';
  return `<button class="lr-link" type="button" data-action="open-ticket" data-id="${escape(ticket.id)}">${escape(ticket.number || ticket.id)}${icon('chevron-right', 14)}</button>`;
}

function commissionOverview(api, earned, pending) {
  const {yen, icon} = api;
  const earnedAmount = total(earned, 'amount');
  const pendingAmount = total(pending, 'amount');
  return `<section class="lr-commission-overview" aria-label="歩合の集計">
    <div class="lr-spotlight">
      <div class="lr-spotlight-cap"><span>確定歩合</span><span class="lr-spotlight-symbol" aria-hidden="true">${icon('wallet', 20)}</span></div>
      <strong class="lr-spotlight-value">${yen(earnedAmount)}</strong>
      <span class="lr-spotlight-note">${icon('check', 14)}会計済みの伝票から集計</span>
    </div>
    <div class="lr-commission-companion">
      <div class="lr-commission-secondary">
        <div><span>見込み歩合</span><strong>${yen(pendingAmount)}</strong></div>
        <div><span>個人売上の合計</span><strong>${yen(total(earned, 'sales'))}</strong></div>
      </div>
      <div class="lr-share">
        <div class="lr-share-track" role="img" aria-label="歩合の内訳。確定 ${yen(earnedAmount)}、見込み ${yen(pendingAmount)}">
          <span style="flex-grow:${Math.max(earnedAmount, 0)}"></span><span style="flex-grow:${Math.max(pendingAmount, 0)}"></span>
        </div>
        <div class="lr-share-legend"><span>確定</span><span>見込み</span></div>
      </div>
    </div>
  </section>`;
}

function reportPeriod(state, {reportDate}) {
  const closed = state.closedDays.find((entry) => entry.date === reportDate)
    ?? state.closedDays.find((entry) => entry.date === state.day.date);
  const date = closed?.date ?? state.day.date;
  const tickets = closed?.ticketSnapshots ?? (date === state.day.date ? state.tickets : []);
  return { date, closed, state: { ...state, tickets },
    legacy: Boolean(closed && date !== state.day.date && !closed.ticketSnapshots && closed.tickets) };
}

function dayPicker(state, date, {escape, icon}) {
  const past = state.closedDays.filter((entry) => entry.date !== state.day.date);
  return `<div class="lr-day-picker"><label for="report-day">${icon('calendar', 17)}営業日</label>
    <select id="report-day" data-report-date>
      <option value=""${date === state.day.date ? ' selected' : ''}>${escape(state.day.date)}（最新）</option>
      ${past.map((entry) => `<option value="${escape(entry.date)}"${date === entry.date ? ' selected' : ''}>${escape(entry.date)}</option>`).join('')}
    </select></div>`;
}

function receiptLink(ticket, date, {escape, icon}) {
  return `<button class="lr-link" type="button" data-action="history-receipt" data-id="${escape(ticket.id)}" data-date="${escape(date)}"
    aria-label="会計内容 No. ${escape(ticket.number || ticket.id)}">${escape(ticket.number || ticket.id)}${icon('chevron-right', 14)}</button>`;
}

function renderCommission(state, api, period, result) {
  const {yen, escape} = api;
  const earned = result.commission ?? [];
  const pending = result.pendingCommission ?? [];
  const earnedByCast = new Map(earned.map((item) => [item.castId, item]));
  const pendingByCast = new Map(pending.map((item) => [item.castId, item]));
  const names = new Map([...(state.archivedCast ?? []), ...state.cast].map(({id, name}) => [id, name]));
  const details = period.state.tickets
    .filter(({status}) => ['open', 'paid', 'departed'].includes(status))
    .sort((a, b) => asNumber(b.settledAt ?? b.createdAt) - asNumber(a.settledAt ?? a.createdAt))
    .flatMap((ticket) => getTicketCommissionDetails(period.state, ticket.id).map((entry) => ({ ticket, entry })));
  const historicalNames = new Map();
  for (const {entry} of details) {
    if (entry.castName && !historicalNames.has(entry.castId)) historicalNames.set(entry.castId, entry.castName);
  }
  const castName = (id) => (period.closed ? historicalNames.get(id) : names.get(id))
    ?? names.get(id) ?? historicalNames.get(id) ?? id;
  const activeCastIds = period.closed ? [] : state.cast.filter((person) => person.enabled !== false).map(({id}) => id);
  const ids = new Set([...activeCastIds, ...earnedByCast.keys(), ...pendingByCast.keys()]);
  const selected = ids.has(api.commissionCast) ? api.commissionCast : null;
  const castRows = [...ids].map((id) => {
    const name = castName(id);
    const final = earnedByCast.get(id) ?? {};
    const estimate = pendingByCast.get(id) ?? {};
    return `<tr><td><button type="button" class="lr-person lr-link lr-cast-filter" data-action="commission-cast" data-id="${escape(id)}"
      aria-label="${escape(name)}の明細" aria-pressed="${id === selected}"><span class="lr-avatar" aria-hidden="true">${escape(Array.from(name).at(0) ?? '')}</span>${escape(name)}</button></td>
      <td class="lr-numeric">${yen(asNumber(final.sales))}</td><td class="lr-numeric"><strong class="${final.amount ? 'lr-positive' : 'lr-quiet-value'}">${yen(asNumber(final.amount))}</strong></td>
      <td class="lr-numeric ${estimate.amount ? 'lr-estimate' : 'lr-quiet-value'}">${yen(asNumber(estimate.amount))}</td><td class="lr-numeric">${number.format(asNumber(final.points))}<span class="lr-unit"> pt</span></td></tr>`;
  });
  const detailSets = [
    { name: '確定歩合の明細', pending: false, empty: '会計を確定すると、対象の注文明細がここに表示されます。' },
    { name: '見込み歩合の明細', pending: true, empty: '未会計の注文にキャストを割り当てると、見込み歩合が表示されます。' },
  ];
  const detailPanels = detailSets.filter((set) => !set.pending || !period.closed).map((set) => {
    const rows = details
      .filter(({ticket, entry}) => (ticket.status === 'open') === set.pending && (!selected || selected === entry.castId))
      .map(({ticket, entry}) => `<tr><td>${set.pending ? ticketLink(ticket, api) : receiptLink(ticket, period.date, api)}</td>
        <td><strong>${escape(entry.name)}</strong>${entry.adjustmentReason ? `<span class="lr-row-note">${escape(entry.adjustmentReason)}</span>` : ''}</td><td>${escape(entry.castName ?? castName(entry.castId))}</td>
        <td class="lr-muted">${timeLabel(set.pending ? (entry.createdAt ?? ticket.createdAt) : ticket.settledAt)}</td>
        <td class="lr-numeric"><span class="lr-mobile-label" aria-hidden="true">個人売上</span>${yen(entry.sales)}</td>
        <td class="lr-numeric"><span class="lr-mobile-label" aria-hidden="true">歩合</span><strong class="${set.pending ? 'lr-estimate' : 'lr-positive'}">${yen(entry.amount)}</strong>
        <span class="lr-unit"> · ${number.format(entry.points)} pt</span></td></tr>`);
    return panel(set.name, rows.length ? table(api, ['伝票', '注文明細', 'キャスト', set.pending ? '注文時刻' : '会計時刻', '個人売上', '歩合'],
      rows, 'lr-payment-table lr-commission-detail') : empty(api, 'ticket', '該当する明細はありません',
      period.legacy ? 'この営業日の保存済み歩合はキャスト別成績で確認できます。' : set.empty), panelCount(rows.length, '件'));
  }).join('');
  const selectedControl = selected ? `<div class="lr-commission-filter"><strong>${escape(castName(selected))}の明細</strong>
    <button type="button" class="btn btn-secondary" data-action="commission-cast" data-id="">すべてのキャスト</button></div>` : '';
  return `<div class="lr-view lr-commission">${dayPicker(state, period.date, api)}${commissionOverview(api, earned, pending)}
    ${panel('キャスト別成績', castRows.length
      ? table(api, ['キャスト', '個人売上', '確定歩合', '見込み歩合', '確定ポイント'], castRows, 'lr-commission-roster')
      : empty(api, 'users', '該当する成績はありません', 'キャストの歩合が計上された営業日を選べます。'), panelCount(castRows.length, '名'))}
    ${selectedControl}${detailPanels}</div>`;
}

function renderStock(state, api) {
  const {yen, escape, icon, showHiddenStock = false, canAdjustStock = true} = api;
  const names = byId([...(state.archivedStock ?? []), ...state.stock]);
  const tickets = byId(state.tickets);
  const archivedTickets = new Map(state.closedDays.flatMap((day) => (day.ticketSnapshots ?? [])
    .map((ticket) => [ticket.id,{date:day.date,ticket}])));
  const low = state.stock.filter(({quantity, minimum}) => quantity <= minimum);
  const valuation = (item) => item.value ?? item.quantity * asNumber(item.unitCost);
  const shown = state.stock.filter((item) => item.hidden !== true);
  const hiddenCount = state.stock.length - shown.length;
  const query = (api.stockSearch ?? '').trim().normalize('NFKC').toLowerCase();
  const rows = (showHiddenStock ? state.stock : shown).filter((item) => (!api.stockLowOnly || item.quantity <= item.minimum)
    && (api.stockBarcodeExact
      ? item.barcode?.toLowerCase() === query
      : [item.name,item.itemCode,item.barcode].some((value) => String(value ?? '').normalize('NFKC').toLowerCase().includes(query)))).map((item) => {
    const isLow = item.quantity <= item.minimum;
    const status = item.quantity === 0 ? '在庫なし' : isLow ? '残りわずか' : '在庫あり';
    const restockCost = stockNumber.format(item.defaultUnitCost ?? item.unitCost);
    const unit = escape(item.unit);
    const reorder = item.maximum == null ? '' : `<small class="lr-row-note">発注目安 ${stockNumber.format(Math.max(0,item.maximum - item.quantity))}${unit}</small>`;
    return `<tr><td><span class="lr-stock-name"><strong>${escape(item.name)}</strong>${item.hidden ? '<span class="lr-badge">非表示</span>' : ''}</span>
      ${item.itemCode || item.barcode ? `<small class="lr-row-note">${escape([item.itemCode,item.barcode].filter(Boolean).join(' ／ '))}</small>` : ''}</td><td class="lr-numeric"><span class="lr-mobile-label" aria-hidden="true">現在庫</span><strong>${stockNumber.format(item.quantity)}</strong><span class="lr-unit"> ${unit}</span>${reorder}</td>
      <td class="lr-numeric lr-muted"><span class="lr-mobile-label" aria-hidden="true">下限</span>${stockNumber.format(item.minimum)} ${unit}</td>
      <td class="lr-numeric"><span class="lr-mobile-label" aria-hidden="true">仕入原価</span>¥${restockCost}<span class="lr-unit"> / ${unit}</span></td>
      <td class="lr-numeric"><span class="lr-mobile-label" aria-hidden="true">評価額</span>${yen(Math.round(valuation(item)))}</td>
      <td><span class="lr-badge${isLow ? ' lr-badge-warning' : ''}">${status}</span></td>
      ${canAdjustStock ? `<td><div class="lr-stock-actions">
        <button class="lr-link" type="button" data-action="stock-adjust" data-id="${escape(item.id)}" aria-label="${escape(item.name)}の入出庫">${icon('plus', 15)}入出庫</button>
        <button class="lr-link" type="button" data-action="stocktake" data-id="${escape(item.id)}" aria-label="${escape(item.name)}の棚卸">棚卸</button>
        </div></td>` : ''}</tr>`;
  });
  const movements = (state.movements || []).filter(({stockId}) => !api.stockHistoryId || api.stockHistoryId === stockId)
    .sort((a, b) => asNumber(b.at) - asNumber(a.at));
  const movementRows = movements.map((entry) => {
    const item = names.get(entry.stockId);
    const labels = {order: '注文出庫', return: '戻し入れ', adjust: '在庫調整', purchase: '仕入れ・入庫',
      loss: '廃棄・破損（ロス）', usage: '店舗消費', stocktake: '棚卸',purchaseCancellation:'入庫取消'};
    const unit = escape(entry.unit ?? item?.unit ?? '');
    const detail = entry.kind === 'stocktake' && Number.isFinite(entry.bookQuantity) && Number.isFinite(entry.actualQuantity)
      ? `<span class="lr-row-note">帳簿 ${stockNumber.format(entry.bookQuantity)} ${unit} → 実数 ${stockNumber.format(entry.actualQuantity)} ${unit}</span>`
      : entry.kind === 'purchase' && Number.isFinite(entry.unitCost) ? `<span class="lr-row-note">仕入単価 ¥${stockNumber.format(entry.unitCost)} / ${unit}</span>` : '';
    const date = new Date(entry.at);
    const time = entry.at && Number.isFinite(date.valueOf()) ? movementTime.format(date) : '—';
    const archive = archivedTickets.get(entry.ticketId);
    const linked = tickets.get(entry.ticketId);
    const receipt = archive ? `<button type="button" class="lr-link" data-action="history-receipt" data-id="${escape(archive.ticket.id)}" data-date="${escape(archive.date)}">No. ${escape(archive.ticket.number)}</button>`
      : ticketLink(linked,api);
    return `<tr><td class="lr-muted lr-numeric">${time}${entry.actorLabel ? `<small class="lr-row-note">${escape(entry.actorLabel)}</small>` : ''}</td><td><strong>${escape(entry.stockName ?? item?.name ?? entry.stockId)}</strong></td>
      <td>${escape(labels[entry.kind] || '入出庫')}${detail}${entry.reason ? `<span class="lr-row-note">${escape(entry.reason)}</span>` : ''}</td>
      <td class="lr-numeric ${entry.quantity > 0 ? 'lr-positive' : ''}">${signedQuantity(entry.quantity)}<span class="lr-unit"> ${unit}</span></td>
      <td>${receipt}${canAdjustStock && entry.kind === 'purchase' && !purchaseCancellationBlocker(state,entry)
        ? `<button type="button" class="lr-link" data-action="stock-cancel-purchase" data-id="${escape(entry.id)}">入庫を取消</button>` : ''}</td></tr>`;
  });
  const stockValue = state.stock.reduce((sum, item) => sum + valuation(item), 0);
  const visibility = hiddenCount ? `<button type="button" class="btn lr-stock-filter" data-action="toggle-hidden-stock"
    aria-pressed="${showHiddenStock}" aria-label="非表示を含む">${icon('filter', 15)}非表示を含む${panelCount(hiddenCount, '件')}</button>` : '';
  const control = `<div class="ops-actions"><label class="field"><span>品目検索</span><input name="stockSearch" type="search" value="${escape(api.stockSearch ?? '')}" placeholder="品目名・コード・バーコード"></label>
    ${barcodeScannerAvailable() ? '<button type="button" class="btn btn-secondary" data-action="stock-barcode-search">カメラでバーコードを読む</button>' : ''}
    <label class="inline-check"><input name="stockLowOnly" type="checkbox"${api.stockLowOnly ? ' checked' : ''}>在庫不足のみ</label>${visibility}</div>`;
  const historyPicker = `<label class="field"><span>品目別の履歴</span><select name="stockHistoryId"><option value="">すべて</option>
    ${[...names.values()].map(({id,name}) => `<option value="${escape(id)}"${id === api.stockHistoryId ? ' selected' : ''}>${escape(name)}</option>`).join('')}</select></label>`;
  const cutoff = registerCutoff(state);
  const costs = getInventoryCostSummary(state.movements,operationBusinessDate(state).slice(0,7),(at)=>businessDate(at,cutoff));
  const balanceColumns = ['品目', '現在庫', '下限', '仕入原価', '評価額', '在庫状態'];
  if (canAdjustStock) balanceColumns.push('操作');
  const balance = rows.length ? table(api, balanceColumns, rows, 'lr-stock-table')
    : query ? empty(api,'search','検索条件に一致する品目がありません','品目名・コード・バーコードを確認してください。')
      : empty(api, 'box', hiddenCount ? '表示中の在庫品目はありません' : '在庫品目がありません',
        hiddenCount ? '「非表示を含む」で品目を確認できます。' : '「品目設定」から品目を追加できます。');
  return `<div class="lr-view"><div class="lr-stats">
    ${stat(api, 'box', '管理品目', `${state.stock.length}<small> 品目</small>`)}
    ${stat(api, 'alert', '下限に達した品目', `${low.length}<small> 品目</small>`, low.length ? 'warning' : '')}
    ${stat(api, 'wallet', '現在庫評価額', yen(Math.round(stockValue)), 'accent')}
    ${stat(api,'box','今月の消費原価',yen(Math.round(costs.consumption)))}
    ${stat(api,'alert','今月のロス原価',yen(Math.round(costs.losses)))}
    </div>${panel('在庫残高', balance, control)}
    ${panel('在庫の入出庫履歴', movementRows.length ? table(api, ['時刻', '品目', '種別', '増減', '伝票'], movementRows, 'lr-stock-history')
      : empty(api, 'history', '入出庫の記録はまだありません', '在庫連動のメニューを注文すると、出庫がここに表示されます。'), historyPicker + panelCount(movementRows.length, '件'))}</div>`;
}

function signedYen(amount, yen, showPlus = false) {
  const prefix = amount < 0 ? '−' : showPlus && amount > 0 ? '+' : '';
  return prefix + yen(Math.abs(amount));
}

function moneyRows(values, {yen}) {
  return `<dl class="lr-money-list">${values.map(([label, amount]) =>
    `<div><dt>${label}</dt><dd>${amount == null ? '—' : signedYen(asNumber(amount),yen)}</dd></div>`).join('')}</dl>`;
}

function describeClosing(period, current, api) {
  const {icon, yen, escape} = api;
  const close = period.closed;
  const discrepancy = close?.discrepancy;
  const status = close ? '<span class="lr-badge lr-badge-active">締め済み</span>' : '';
  const variance = discrepancy == null ? '—' : signedYen(discrepancy,yen,true);
  const countDetails = close?.cashDenominations;
  const countRows = countDetails && cashDenominations.filter((denomination) => countDetails[denomination] > 0)
    .map((denomination) => `<div><dt>${yen(denomination)}</dt><dd>${number.format(countDetails[denomination])}枚</dd></div>`).join('');
  return `<section class="lr-panel lr-register" aria-label="レジ照合"><div class="lr-panel-head">
    <h2>${icon('wallet',18)} レジ照合</h2>${status}</div>
    <dl class="lr-register-values">
      <div><dt>理論残高</dt><dd>${yen(asNumber(current.expectedCash))}</dd></div>
      <div><dt>実残高</dt><dd>${close?.actualCash == null ? '—' : yen(asNumber(close.actualCash))}</dd></div>
      <div${discrepancy ? ' class="lr-variance"' : ''}><dt>差額</dt><dd>${variance}</dd></div>
    </dl>${close?.reason ? `<p class="lr-report-note"><strong>差額理由</strong> ${escape(close.reason)}</p>` : ''}
    ${countDetails ? `<details class="lr-cash-count"><summary>金種別の内訳</summary>${countRows
      ? `<dl class="lr-money-list">${countRows}</dl>` : '<p>現金なし</p>'}</details>` : ''}
    ${close && api.canCorrectRegister ? `<button type="button" class="btn" data-action="correct-register-count" data-id="${escape(close.date)}">実残高を訂正</button>` : ''}</section>`;
}

function registerBreakdown(state, period, current, api) {
  const recorded = period.closed ?? state.day;
  return panel('レジの内訳', moneyRows([
    ['釣銭準備金', period.closed?.openingCash ?? state.day.openingCash],
    ['会計・前受金の現金受取', current.payments?.cash ?? 0],
    ['その他の入金', asNumber(current.cashIn) + asNumber(current.recoveries?.cash)],
    ['出金・経費', -asNumber(current.cashOut)],
  ], api) + (recorded.openingExpected === undefined ? '' : moneyRows([
    ['開店時の想定残高',recorded.openingExpected],['開店時の現金過不足',recorded.openingDifference],
  ],api)));
}

function tenderBreakdown(current, api, multiple = false) {
  const {yen} = api;
  const combinedOnly = current.hasCombinedOnlyPayments || !current.tenderPayments || !current.depositsReceived;
  const rows = cashMethods.map(([method,label]) => `<tr><th scope="row">${label}</th>
    <td>${yen(asNumber((combinedOnly ? current.payments : current.tenderPayments)?.[method]))}</td>
    ${combinedOnly ? '' : `<td>${yen(asNumber(current.depositsReceived?.[method]))}</td>`}</tr>`);
  const columns = combinedOnly ? ['方法','受取合計'] : ['方法','会計時の受取','前受金の受取'];
  const breakdown = table(api,columns,rows,'lr-tender-table');
  const applied = combinedOnly ? '' : moneyRows([['会計に充当した前受金', current.depositsApplied ?? 0]], api);
  const note = `${multiple ? 'この期間には' : 'この営業日には'}、会計と前受金を合算した受取額が含まれます。`;
  return panel('支払方法別の入金', `${breakdown}${applied}<p class="lr-report-note">${combinedOnly ? note : '前受金は、決済加算がある場合は加算を含む受取額で集計します。'}</p>`);
}

function cashLedgerHistory(current, api) {
  const {escape, icon, yen} = api;
  const ledger = [...(current.cashMovements ?? [])].sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
  const rows = ledger.map((item) => {
    const {kind, actor} = item;
    const inflow = kind === 'deposit';
    const title = cashMovementCategories[kind]?.[item.category] ?? 'その他';
    const type = cashMovementKinds[kind] ?? '入出金';
    const when = item.at != null && Number.isFinite(item.at) && Number.isFinite(new Date(item.at).valueOf())
      ? `<time datetime="${new Date(item.at).toISOString()}">${movementTime.format(item.at)}</time>` : '<span>当日合計</span>';
    return `<li class="lr-cash-entry">
      <div class="lr-cash-entry-label"><span class="lr-day-icon ${inflow ? 'lr-cash-in' : 'lr-cash-out'}" aria-hidden="true">${icon(inflow ? 'plus' : 'minus', 16)}</span>
        <div><strong>${escape(title)}</strong><small>${escape(type)} · ${when}</small></div></div>
      <strong class="lr-cash-entry-amount ${inflow ? 'lr-positive' : ''}">${signedYen(inflow ? item.amount : -item.amount,yen,true)}</strong>
      <div class="lr-cash-entry-extra">${item.reason ? `<p>${escape(item.reason)}</p>` : ''}
        <small>${[item.destination ? `相手先 ${item.destination}` : '', actor?.label ? `担当 ${actor.label}` : ''].filter(Boolean).map(escape).join(' · ')}</small>
        ${item.voidedAt != null ? `<p>取消済み ／ ${escape(item.voidReason)}</p>` : ''}
        ${api.canEditCash?.(item) ? `<div class="ops-actions"><button type="button" class="btn" data-action="edit-cash-movement" data-id="${escape(item.id)}">訂正</button>
          <button type="button" class="btn" data-action="void-cash-movement" data-id="${escape(item.id)}">入出金を取消</button></div>` : ''}</div>
    </li>`;
  });
  return panel('入出金履歴', rows.length ? `<ul class="lr-cash-entries">${rows.join('')}</ul>`
    : empty(api, 'wallet', '入出金の記録はありません'), panelCount(rows.length, '件'));
}

function cashTotals(current, api) {
  const dailyCash = asNumber(current.dailyPayTotals?.cash);
  return panel('入出金と日払い', moneyRows([
    ['入金', current.cashIn ?? 0],
    ['その他の出金', asNumber(current.cashOut) - asNumber(current.expenses) - dailyCash],
    ['経費', current.expenses ?? 0],
    ['日払い支給（現金）', dailyCash],
    ['日払い支給（振込）', asNumber(current.dailyPayTotals?.bank)],
  ], api));
}

function renderCash(state, api, period, current) {
  const {icon,escape,yen} = api;
  const canRecord = period.date === state.day.date && state.day.status === 'open' && !period.closed;
  const vaults = cashAccounts(state,'vault');
  const vaultPanel = vaults.length ? panel('金庫の現在残高',
    `<dl class="lr-money-list">${vaults.map((vault)=>`<div><dt>${escape(vault.name)}${vault.enabled ? '' : '（停止中）'}</dt>
      <dd>${yen(vaultBalance(state,vault))}</dd></div>`).join('')}</dl>`) : '';
  return `<div class="lr-view">
    <div class="lr-report-toolbar">${dayPicker(state, period.date, api)}
      ${canRecord ? `<button type="button" class="btn btn-primary" data-action="record-cash">${icon('plus',16)}入出金を記録</button>` : ''}</div>
    ${describeClosing(period, current, api)}
    <div class="lr-split">${registerBreakdown(state, period, current, api)}${cashTotals({...current,dailyPayTotals:getDailyPayTotals(state,period.date)}, api)}</div>
    ${vaultPanel}
    ${cashLedgerHistory(current, api)}</div>`;
}

function renderDaily(state, api, period, current, controls) {
  const {yen, icon, escape} = api;
  const settled = period.settledTickets;
  const cancelled = (state.cancelledSettlements ?? []).filter((entry) => entry.date === period.date);
  const history = [...state.closedDays].reverse().map((entry) =>
    `<details class="lr-day"><summary><span class="lr-day-icon" aria-hidden="true">${icon('calendar', 18)}</span>
       <strong>${dateLabel(entry.date)}</strong><span class="lr-muted lr-day-time">${timeLabel(entry.openedAt)} – ${timeLabel(entry.closedAt)}</span>
       <strong class="lr-day-sales">${yen(entry.sales)}</strong><span class="lr-day-chevron" aria-hidden="true">${icon('chevron-down', 17)}</span></summary>
       <div class="lr-day-details">${moneyRows([['釣銭準備金', entry.openingCash], ['理論残高', entry.expectedCash], ['実残高', entry.actualCash], ['差額', entry.discrepancy]], api)}
       ${entry.reason ? `<p class="lr-day-note">差額理由　${escape(entry.reason)}</p>` : ''}</div></details>`).join('');
  const receiptRows = settled.slice().sort((a, b) => asNumber(b.settledAt) - asNumber(a.settledAt)).map((ticket) => {
    const amount = typeof api.quote === 'function' ? api.quote(period.state, ticket.id).total : 0;
    const seats = getTicketTableLabels(state, ticket).join('・');
    return `<tr><td>${receiptLink(ticket, period.date, api)}</td><td>${escape(seats)}</td><td class="lr-muted">${timeLabel(ticket.settledAt)}</td>
      <td class="lr-numeric"><strong>${yen(amount)}</strong></td></tr>`;
  });
  const cancelledRows = cancelled.map((entry) => `<tr><td><button class="lr-link" type="button" data-action="cancelled-receipt"
    data-id="${escape(entry.id)}" aria-label="取消済みの会計 No. ${escape(entry.ticketNumber)}">${escape(entry.ticketNumber)}${icon('chevron-right',14)}</button></td>
    <td class="lr-muted">${timeLabel(entry.at)}</td>
    <td class="lr-numeric">${yen(entry.receipt.settlement.total)}</td>
    <td>${escape(entry.reason)}</td></tr>`);
  const guests = asNumber(current.guests);
  return `<div class="lr-view">
    ${controls}
    <div class="lr-stats lr-stats-daily">
    ${stat(api, 'chart', '確定売上', yen(asNumber(current.sales)), 'accent')}
    ${stat(api, 'ticket', '会計済みの組数', `${asNumber(current.tickets)}<small> 組</small>`)}
    ${stat(api, 'users', '会計済みの客数', `${guests}<small> 名</small>`)}
    ${stat(api, 'wallet', '客単価', guests ? yen(Math.round(asNumber(current.sales) / guests)) : '—')}</div>
    ${describeClosing(period, current, api)}
    ${tenderBreakdown(current, api)}
    <div class="lr-split">${registerBreakdown(state, period, current, api)}${cashTotals(current, api)}</div>
    ${panel('会計履歴', receiptRows.length ? table(api, ['伝票', '卓', '会計時刻', '税込金額'], receiptRows, 'lr-payment-table')
      : empty(api, 'ticket', period.legacy ? '集計の保存がある営業日です' : '会計履歴はまだありません',
        period.legacy ? 'この営業日の会計件数と売上を上の集計で確認できます。' : '会計を確定した伝票がここに表示されます。'), panelCount(receiptRows.length, '件'))}
    ${cancelledRows.length ? panel('会計取消の履歴', table(api,['取消済み伝票','取消時刻','元の会計額','取消理由'],cancelledRows,'ops-cancelled'),panelCount(cancelledRows.length,'件')) : ''}
    ${panel('締め履歴', history || empty(api, 'history', '締め履歴はまだありません', '閉店を確定すると、その営業日の実残高と売上を確認できます。'), panelCount(state.closedDays.length, '件'))}</div>`;
}

const reportModes = [
  ['day', '日別'],
  ['month', '月別'],
  ['range', '任意期間'],
];

function reportDateFields(state, interval, period, api) {
  const {escape} = api;
  if (period.mode === 'day') return dayPicker(state, period.start ?? state.day.date, api);
  if (period.mode === 'month') {
    const month = interval.month ?? state.day.date.slice(0,7);
    return `<label class="lr-period-field"><span>対象月</span>
      <input type="month" data-report-month value="${escape(month)}" placeholder="YYYY-MM"></label>`;
  }
  const start = interval.start ?? `${state.day.date.slice(0,7)}-01`;
  const end = interval.end ?? state.day.date;
  return `<div class="lr-period-dates">
    <label class="lr-period-field"><span>開始日</span><input type="date" data-report-start value="${escape(start)}"></label>
    <label class="lr-period-field"><span>終了日</span><input type="date" data-report-end value="${escape(end)}"></label>
  </div>`;
}

function renderReportControls(state, interval, period, api) {
  const {escape, icon} = api;
  const salesDays = period.days.filter(({current}) => asNumber(current.sales) > 0);
  const needsDetails = salesDays.some(({ticketDataComplete}) => !ticketDataComplete);
  const canExportSales = period.valid && salesDays.length > 0 && !needsDetails;
  const canExportReport = period.valid && period.days.length > 0;
  const exportButton = (id, label, enabled) => `<button type="button" class="btn btn-secondary" data-action="report-export"
    data-id="${id}"${enabled ? '' : ' disabled'}>${icon('download',16)}${label}</button>`;
  return `<section class="lr-period-tools" aria-label="日報の期間とCSV出力">
    <div class="lr-period-controls">
      <div class="lr-period-modes" role="group" aria-label="集計単位">
        ${reportModes.map(([id,label]) => `<button type="button" data-action="report-mode" data-report-mode="${id}"
          data-id="${id}" aria-pressed="${period.mode === id}">${label}</button>`).join('')}
      </div>
      ${reportDateFields(state, interval, period, api)}
    </div>
    <div class="lr-period-exports">
      ${exportButton('report','日報CSV',canExportReport)}
      <div class="lr-period-freee" role="group" aria-label="freee向けCSV">
        <span>freee向け</span>
        ${exportButton('daily','日次集計CSV',canExportSales)}
        ${exportButton('tickets','伝票別CSV',canExportSales)}
      </div>
      <div class="lr-period-freee" role="group" aria-label="設定した会計CSV">
        <span>カスタム会計CSV</span>
        ${exportButton('custom-daily','日次CSV',canExportSales)}
        ${exportButton('custom-tickets','伝票CSV',canExportSales)}
      </div>
    </div>
    ${api.reportExportError ? `<p class="lr-period-note lr-period-error" data-report-export-error role="alert"
      tabindex="-1">${escape(api.reportExportError)}</p>` : ''}
    ${!period.valid ? `<p class="lr-period-note lr-period-error" role="status">${escape(period.error || '集計期間を確認してください。')}</p>`
      : needsDetails ? '<p class="lr-period-note lr-period-error">会計明細が保存されていない営業日が含まれるため、freee向けCSVを出力できません。</p>'
      : canExportSales ? `<p class="lr-period-note">同じ期間の売上をfreeeに取り込む際は、日次集計と伝票別のどちらか一方を使います。
        <a href="https://support.freee.co.jp/hc/ja/articles/204847430" target="_blank" rel="noopener noreferrer">freeeの取込手順</a></p>`
      : canExportReport ? '<p class="lr-period-note">freee向けCSVは、会計確定済みの売上がある期間に出力できます。</p>' : ''}
  </section>`;
}

function totalMethods(amounts) {
  return Object.values(amounts ?? {}).reduce((value, amount) => value + asNumber(amount), 0);
}

function renderPeriodDays(period, api) {
  const {yen, escape, icon} = api;
  const headings = ['営業日', '確定売上', '決済入金', '経費', '日払い支給'];
  const rows = period.days.slice().reverse().map(({date, current}) => {
    const amounts = [current.sales,totalMethods(current.payments),current.expenses,totalMethods(current.dailyPayTotals)];
    return `<tr>
      <td><button type="button" class="lr-link" data-action="report-day" data-id="${escape(date)}"
        aria-label="${escape(date)}の日報を表示"><time datetime="${escape(date)}">${escape(date)}</time>${icon('chevron-right',14)}</button></td>
      ${amounts.map((amount,index) => `<td class="lr-numeric"><span class="lr-mobile-label" aria-hidden="true">${headings[index+1]}</span>
        <strong>${yen(asNumber(amount))}</strong></td>`).join('')}
    </tr>`;
  });
  return panel('営業日別の明細',table(api,headings,rows,'lr-period-table'),panelCount(rows.length,'営業日'));
}

function renderMultipleDays(period, api, controls) {
  const {yen, escape} = api;
  const {totals} = period;
  if (!period.valid || !period.days.length) {
    return `<div class="lr-view">${controls}${period.valid ? panel('期間の集計', empty(api,'calendar',
      'この期間の営業データはありません','別の月または期間を選ぶと、該当する営業日を確認できます。')) : ''}</div>`;
  }
  return `<div class="lr-view">${controls}
    <p class="lr-period-caption"><time datetime="${escape(period.start)}">${escape(period.start)}</time>
      〜 <time datetime="${escape(period.end)}">${escape(period.end)}</time></p>
    <div class="lr-stats lr-stats-daily">
      ${stat(api, 'chart', '確定売上', yen(asNumber(totals.sales)), 'accent')}
      ${stat(api, 'wallet', '決済入金', yen(totalMethods(totals.payments)))}
      ${stat(api, 'ticket', '経費', yen(asNumber(totals.expenses)))}
    </div>
    <div class="lr-split">${tenderBreakdown(totals, api, true)}${cashTotals(totals,api)}</div>
    ${renderPeriodDays(period,api)}
  </div>`;
}

export function renderReport(page, state, api) {
  if (page === 'stock') return renderStock(state, api);
  if (page === 'commission' || page === 'cash') {
    const period = reportPeriod(state, api);
    const result = period.closed ?? api.summary(state);
    return page === 'commission' ? renderCommission(state, api, period, result) : renderCash(state, api, period, result);
  }
  const currentMonth = state.day.date.slice(0,7);
  const interval = {mode:'day',month:currentMonth,start:`${currentMonth}-01`,end:state.day.date,...api.reportInterval};
  const period = getReportPeriod(state,{...interval,date:api.reportDate});
  const controls = renderReportControls(state,interval,period,api);
  const day = period.mode === 'day' ? period.days[0] : null;
  return day ? renderDaily(state, api, day, day.current, controls) : renderMultipleDays(period, api, controls);
}
