import { encodeCsv } from './csv-file.mjs';
import { getTicketCommissionDetails, quote } from './engine.mjs';
import { getReportPeriod, isReportDate } from './report-period.mjs';

const methods = [['cash','現金'],['card','カード'],['qr','QR決済']];
const asYen = (amount) => Number.isFinite(amount) ? amount : 0;
const average = (total, count) => count ? Math.round(total / count) : 0;
const daysBetween = (start,end) => Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);

function relativeDate(date, days) {
  const offset = new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0,10);
  return isReportDate(offset) ? offset : null;
}

function statusLabel(complete) {
  return complete ? '' : '会計明細が一部保存されていないため、明細別の数値は確認できる伝票分です。';
}

export function getAnalytics(state, range = {}) {
  const start = range.start ?? `${state.day.date.slice(0,7)}-01`;
  const end = range.end ?? state.day.date;
  const period = getReportPeriod(state,{mode:'range',start,end});
  const products = new Map();
  const casts = new Map();
  let service = 0;
  let withNomination = 0;
  let complete = true;

  const days = period.days.map((day) => {
    const { date, current, settledTickets, ticketDataComplete } = day;
    if (!ticketDataComplete) complete = false;
    for (const ticket of settledTickets) {
      const lines = ticket.lines.filter(({cancelledAt}) => cancelledAt == null);
      service += asYen(quote(day.state,ticket.id).service);
      if (lines.some(({category}) => category === '指名')) withNomination++;
      for (const {menuId,name,category,quantity,total} of lines) {
        const key = JSON.stringify([menuId,name,category]);
        const item = products.get(key) ?? {name,category,quantity:0,sales:0,tickets:new Set()};
        item.quantity += quantity;
        item.sales += total;
        item.tickets.add(ticket.id);
        products.set(key,item);
      }
      for (const row of getTicketCommissionDetails(day.state,ticket.id)) {
        const label = row.castName ?? state.cast.find(({id}) => id === row.castId)?.name
          ?? state.archivedCast?.find(({id}) => id === row.castId)?.name ?? row.castId;
        const current = casts.get(row.castId) ?? {name:label,sales:0,commission:0,points:0};
        current.sales += row.sales;
        current.commission += row.amount;
        current.points += row.points;
        casts.set(row.castId,current);
      }
    }
    return {date,sales:current.sales,tickets:current.tickets,guests:current.guests,
      averageSpend:average(current.sales,current.guests)};
  });

  const { totals } = period;
  const previousEnd = period.valid ? relativeDate(period.start,-1) : null;
  const previousStart = previousEnd ? relativeDate(previousEnd,-daysBetween(period.start,period.end)) : null;
  const previous = previousStart ? getReportPeriod(state,{mode:'range',start:previousStart,end:previousEnd}) : null;
  const previousSales = previous?.days.length ? previous.totals.sales : null;
  return {start,end,period,days,service,withNomination,previousSales,previousStart,previousEnd,complete,
    averageSpend:average(totals.sales,totals.guests),
    products:[...products.values()].map(({tickets,...item}) => ({...item,tickets:tickets.size}))
      .sort((a,b) => b.sales - a.sales || a.name.localeCompare(b.name,'ja')),
    casts:[...casts.values()].sort((a,b) => b.sales - a.sales || a.name.localeCompare(b.name,'ja'))};
}

function rows(headings, values, escape) {
  return `<div class="analytics-table" tabindex="0"><table>
    <thead><tr>${headings.map((label) => `<th scope="col">${escape(label)}</th>`).join('')}</tr></thead>
    <tbody>${values.map(([first,...rest]) => `<tr><th scope="row">${escape(first)}</th>${rest.map((value) => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function panel(title, content) {
  return `<section class="lr-panel"><div class="lr-panel-head"><h2>${title}</h2></div>${content}</section>`;
}

function percent(numerator, denominator) {
  return denominator > 0 ? `${(numerator / denominator * 100).toFixed(1)}%` : '—';
}

function barChart(title, days, key, api) {
  const {escape,yen} = api;
  const visible = days.slice(-14);
  const max = Math.max(1,...visible.map((day) => day[key]));
  return panel(title,`${days.length > 14 ? '<p class="lr-period-note">直近14営業日</p>' : ''}
    <ol class="analytics-chart" aria-label="${title}">${visible.map((day) =>
      `<li><time datetime="${escape(day.date)}">${escape(day.date.slice(5))}</time>
        <span aria-hidden="true"><i style="width:${Math.max(0,day[key] / max * 100).toFixed(2)}%"></i></span><strong>${yen(day[key])}</strong></li>`).join('')}</ol>`);
}

function metrics(items) {
  return `<div class="analytics-metrics">${items.map(([label,value,note]) =>
    `<div class="lr-panel"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`).join('')}</div>`;
}

export function renderAnalytics(page, state, api) {
  const {escape,icon,yen,print = false} = api;
  const data = getAnalytics(state,api.range);
  const {period,days,products,casts,start,end,complete,previousSales,averageSpend} = data;
  const product = page === 'product-sales';
  const {totals} = period;
  const download = period.valid && days.length > 0;
  const controls = print ? `<header class="workspace-print-heading"><h1>${product ? '商品別集計' : '経営分析'}</h1><p>${escape(start)} 〜 ${escape(end)}</p></header>`
    : `<section class="lr-period-tools" aria-label="集計期間と出力"><div class="lr-period-controls"><div class="lr-period-dates">
      <label class="lr-period-field"><span>開始日</span><input type="date" data-analytics-start value="${escape(start)}"></label>
      <label class="lr-period-field"><span>終了日</span><input type="date" data-analytics-end value="${escape(end)}"></label>
      </div></div><div class="lr-period-exports">
      <button type="button" class="btn btn-secondary" data-action="analytics-csv"${download ? '' : ' disabled'}>${icon('download',16)}CSV出力</button>
      <button type="button" class="btn" data-action="analytics-print"${download ? '' : ' disabled'}>${icon('printer',16)}印刷</button></div></section>`;
  if (!download) return `<div class="lr-view">${controls}<p class="notice" role="status">${escape(period.error || 'この期間の営業データはありません。')}</p></div>`;
  const caveat = complete ? '' : `<p class="notice">${statusLabel(complete)}</p>`;
  const productRows = rows(['商品','分類','数量','伝票数','商品小計'],
    products.map(({name,category,quantity,tickets,sales}) => [name,category,quantity,tickets,yen(sales)]),escape);
  if (product) {
    const itemTotal = products.reduce((total,{sales}) => total + sales,0);
    return `<div class="lr-view analytics-view">${controls}${caveat}
      ${metrics([['商品小計',yen(itemTotal),'値引き・サービス料・税の計算前'],['商品数',products.length],['対象の営業日',days.length]])}
      ${panel('商品別の内訳',products.length ? productRows : '<p class="field-help">この期間に会計済みの商品はありません。</p>')}</div>`;
  }
  const comparison = previousSales == null ? '比較期間の営業データなし'
    : `直前の同じ日数の期間 ${yen(previousSales)}`;
  const tender = totals.hasCombinedOnlyPayments ? totals.payments : totals.tenderPayments;
  const tenderRows = [...methods.map(([key,label]) => [label,yen(tender[key])]),['売掛',yen(totals.receivableSales)]];
  if (!totals.hasCombinedOnlyPayments) tenderRows.push(['前受金の充当',yen(totals.depositsApplied)]);
  return `<div class="lr-view analytics-view">${controls}${caveat}
    ${metrics([['確定売上',yen(totals.sales),comparison],['客単価',yen(averageSpend),`${totals.guests}名`],
      ['売掛比率',percent(totals.receivableSales,totals.sales)],['指名のある会計',complete ? percent(data.withNomination,totals.tickets) : '—'],
      ['サービス料比率',complete ? percent(data.service,totals.sales) : '—']])}
    <div class="lr-split">${barChart('売上の推移',days,'sales',api)}${barChart('客単価の推移',days,'averageSpend',api)}</div>
    <div class="lr-split">${panel(totals.hasCombinedOnlyPayments ? '決済別入金（前受金を含む）と売掛' : '決済別内訳',rows(['区分','金額'],tenderRows,escape))}
      ${panel('商品別売上 上位5件',products.length ? rows(['商品','数量','商品小計'],products.slice(0,5).map(({name,quantity,sales}) => [name,quantity,yen(sales)]),escape)
        : '<p class="field-help">この期間に会計済みの商品はありません。</p>')}</div>
    ${panel('営業日ごとの実績',rows(['営業日','確定売上','組数','客数','客単価'],days.map(({date,sales,tickets,guests,averageSpend:spend}) =>
    [date,yen(sales),tickets,guests,yen(spend)]),escape))}
    ${panel('キャスト成績',casts.length ? rows(['キャスト','個人売上','確定歩合','ポイント'],casts.map(({name,sales,commission,points}) =>
      [name,yen(sales),yen(commission),Math.round(points * 100) / 100]),escape) : '<p class="field-help">この期間の確定歩合はありません。</p>')}</div>`;
}

export function buildAnalyticsCsv(page,state,range) {
  const {period,days,products} = getAnalytics(state,range);
  if (!period.valid || !days.length) return '';
  if (page === 'product-sales') return encodeCsv([['開始日','終了日','商品','分類','数量','伝票数','商品小計'],
    ...products.map(({name,category,quantity,tickets,sales}) => [period.start,period.end,name,category,quantity,tickets,sales])]);
  return encodeCsv([['営業日','確定売上','組数','客数','客単価'],
    ...days.map(({date,sales,tickets,guests,averageSpend}) => [date,sales,tickets,guests,averageSpend])]);
}
