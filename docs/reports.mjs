import { getTicketCommissionDetails, getTicketTableLabels } from './engine.mjs';

const formatDay = new Intl.DateTimeFormat('ja-JP', {
  month: 'short', day: 'numeric', weekday: 'short', timeZone: 'Asia/Tokyo',
});
const formatTime = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tokyo',
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
        <td><strong>${escape(entry.name)}</strong></td><td>${escape(entry.castName ?? castName(entry.castId))}</td>
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
  const {yen, escape, icon, showHiddenStock = false} = api;
  const names = byId([...(state.archivedStock ?? []), ...state.stock]);
  const tickets = byId(state.tickets);
  const low = state.stock.filter(({quantity, minimum}) => quantity <= minimum);
  const valuation = (item) => item.value ?? item.quantity * asNumber(item.unitCost);
  const shown = state.stock.filter((item) => item.hidden !== true);
  const hiddenCount = state.stock.length - shown.length;
  const rows = (showHiddenStock ? state.stock : shown).map((item) => {
    const isLow = item.quantity <= item.minimum;
    const status = item.quantity === 0 ? '在庫なし' : isLow ? '残りわずか' : '在庫あり';
    const restockCost = stockNumber.format(item.defaultUnitCost ?? item.unitCost);
    const unit = escape(item.unit);
    return `<tr><td><span class="lr-stock-name"><strong>${escape(item.name)}</strong>${item.hidden ? '<span class="lr-badge">非表示</span>' : ''}</span></td><td class="lr-numeric"><span class="lr-mobile-label" aria-hidden="true">現在庫</span><strong>${stockNumber.format(item.quantity)}</strong><span class="lr-unit"> ${unit}</span></td>
      <td class="lr-numeric lr-muted"><span class="lr-mobile-label" aria-hidden="true">下限</span>${stockNumber.format(item.minimum)} ${unit}</td>
      <td class="lr-numeric"><span class="lr-mobile-label" aria-hidden="true">仕入原価</span>¥${restockCost}<span class="lr-unit"> / ${unit}</span></td>
      <td class="lr-numeric"><span class="lr-mobile-label" aria-hidden="true">評価額</span>${yen(Math.round(valuation(item)))}</td>
      <td><span class="lr-badge${isLow ? ' lr-badge-warning' : ''}">${status}</span></td>
      <td><button class="lr-link lr-adjust" type="button" data-action="stock-adjust" data-id="${escape(item.id)}" aria-label="${escape(item.name)}の在庫を調整">${icon('plus', 15)}調整</button></td></tr>`;
  });
  const movements = (state.movements || []).slice().sort((a, b) => asNumber(b.at) - asNumber(a.at));
  const movementRows = movements.map((entry) => {
    const item = names.get(entry.stockId);
    const labels = {order: '注文出庫', return: '戻し入れ', adjust: '在庫調整'};
    return `<tr><td class="lr-muted lr-numeric">${timeLabel(entry.at)}</td><td><strong>${escape(entry.stockName ?? item?.name ?? entry.stockId)}</strong></td>
      <td>${escape(labels[entry.kind] || '入出庫')}${entry.reason ? `<span class="lr-row-note">${escape(entry.reason)}</span>` : ''}</td>
      <td class="lr-numeric ${entry.quantity > 0 ? 'lr-positive' : ''}">${signedQuantity(entry.quantity)}<span class="lr-unit"> ${escape(entry.unit ?? item?.unit ?? '')}</span></td>
      <td>${ticketLink(tickets.get(entry.ticketId), api)}</td></tr>`;
  });
  const stockValue = state.stock.reduce((sum, item) => sum + valuation(item), 0);
  const control = hiddenCount ? `<button type="button" class="btn lr-stock-filter" data-action="toggle-hidden-stock"
    aria-pressed="${showHiddenStock}" aria-label="非表示を含む">${icon('filter', 15)}非表示を含む${panelCount(hiddenCount, '件')}</button>` : '';
  const balance = rows.length ? table(api, ['品目', '現在庫', '下限', '仕入原価', '評価額', '在庫状態', '操作'], rows, 'lr-stock-table')
    : empty(api, 'box', hiddenCount ? '表示中の在庫品目はありません' : '在庫品目がありません',
      hiddenCount ? '「非表示を含む」で品目を確認できます。' : '「品目設定」から品目を追加できます。');
  return `<div class="lr-view"><div class="lr-stats">
    ${stat(api, 'box', '管理品目', `${state.stock.length}<small> 品目</small>`)}
    ${stat(api, 'alert', '下限に達した品目', `${low.length}<small> 品目</small>`, low.length ? 'warning' : '')}
    ${stat(api, 'wallet', '現在庫評価額', yen(Math.round(stockValue)), 'accent')}
    </div>${panel('在庫残高', balance, control)}
    ${panel('在庫の入出庫履歴', movementRows.length ? table(api, ['時刻', '品目', '種別', '増減', '伝票'], movementRows, 'lr-stock-history')
      : empty(api, 'history', '入出庫の記録はまだありません', '在庫連動のメニューを注文すると、出庫がここに表示されます。'), panelCount(movementRows.length, '件'))}</div>`;
}

function moneyRows(values, {yen}) {
  return `<dl class="lr-money-list">${values.map(([label, amount]) =>
    `<div><dt>${label}</dt><dd>${yen(asNumber(amount))}</dd></div>`).join('')}</dl>`;
}

function renderDaily(state, api, period, current) {
  const {yen, icon, escape} = api;
  const currentClose = period.closed;
  const openingCash = currentClose ? currentClose.openingCash : state.day.openingCash;
  const settled = period.state.tickets.filter(({status}) => status === 'paid' || status === 'departed');
  const cancelled = (state.cancelledSettlements ?? []).filter((entry) => entry.date === period.date);
  const payment = current.payments || {};
  const history = [...state.closedDays].reverse().map((entry) =>
    `<details class="lr-day"><summary><span class="lr-day-icon" aria-hidden="true">${icon('calendar', 18)}</span>
       <strong>${dateLabel(entry.date)}</strong><span class="lr-muted lr-day-time">${timeLabel(entry.openedAt)} – ${timeLabel(entry.closedAt)}</span>
       <strong class="lr-day-sales">${yen(entry.sales)}</strong><span class="lr-day-chevron" aria-hidden="true">${icon('chevron-down', 17)}</span></summary>
       <div class="lr-day-details">${moneyRows([['釣銭準備金', entry.openingCash], ['理論残高', entry.expectedCash], ['実残高', entry.actualCash], ['差額', entry.discrepancy]], api)}
       ${entry.reason ? `<p class="lr-day-note">差額理由　${escape(entry.reason)}</p>` : ''}</div></details>`).join('');
  const cashRows = [['釣銭準備金', openingCash], ['レジ理論残高', current.expectedCash]];
  if (currentClose) cashRows.push(['レジ実残高', currentClose.actualCash], ['差額', currentClose.discrepancy]);
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
  return `<div class="lr-view">${dayPicker(state, period.date, api)}<div class="lr-stats">
    ${stat(api, 'chart', '確定売上', yen(asNumber(current.sales)), 'accent')}
    ${stat(api, 'users', '会計済みのお客様', `${asNumber(current.guests)}<small> 名</small>`)}
    ${stat(api, 'ticket', '会計済み伝票', `${asNumber(current.tickets)}<small> 件</small>`)}</div>
    <div class="lr-split">${panel('支払方法別の入金', moneyRows(cashMethods.map(([key, label]) => [label, payment[key]]), api), '<span class="lr-muted">前受金を含む</span>')}
    ${panel('レジ残高', moneyRows(cashRows, api), currentClose ? '<span class="lr-badge lr-badge-active">締め済み</span>' : '')}</div>
    ${panel('会計履歴', receiptRows.length ? table(api, ['伝票', '卓', '会計時刻', '税込金額'], receiptRows, 'lr-payment-table')
      : empty(api, 'ticket', period.legacy ? '集計の保存がある営業日です' : '会計履歴はまだありません',
        period.legacy ? 'この営業日の会計件数と売上を上の集計で確認できます。' : '会計を確定した伝票がここに表示されます。'), panelCount(receiptRows.length, '件'))}
    ${cancelledRows.length ? panel('会計取消の履歴', table(api,['取消済み伝票','取消時刻','元の会計額','取消理由'],cancelledRows,'ops-cancelled'),panelCount(cancelledRows.length,'件')) : ''}
    ${panel('締め履歴', history || empty(api, 'history', '締め履歴はまだありません', '閉店を確定すると、その営業日の実残高と売上を確認できます。'), panelCount(state.closedDays.length, '件'))}</div>`;
}

export function renderReport(page, state, api) {
  if (page === 'stock') return renderStock(state, api);
  const period = reportPeriod(state, api);
  const result = period.closed ?? api.summary(state);
  if (page === 'commission') return renderCommission(state, api, period, result);
  return renderDaily(state, api, period, result);
}
