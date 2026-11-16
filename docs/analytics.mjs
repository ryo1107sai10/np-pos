import { encodeCsv } from './csv-file.mjs';
import { getTicketCommissionDetails, quote } from './engine.mjs';
import { getReportPeriod, isReportDate } from './report-period.mjs';

const methods = [['cash','現金'],['card','カード'],['qr','QR決済']];
const asYen = (amount) => Number.isFinite(amount) ? amount : 0;
const average = (total, count) => count ? Math.round(total / count) : 0;
const daysBetween = (start,end) => Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
const weekdayNames = ['日','月','火','水','木','金','土'];
const comparisons = {previous:'直前の同じ日数',day:'前日',week:'前週',month:'前月',year:'前年'};
const nominationLabels = {nominated:'指名あり',other:'指名なし'};
const minute = 60_000;

function relativeDate(date, days) {
  if (!isReportDate(date)) return null;
  const offset = new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0,10);
  return isReportDate(offset) ? offset : null;
}

function previousCalendarDate(date, months) {
  const target = new Date(date);
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() - months);
  const boundary = new Date(target);
  boundary.setUTCMonth(boundary.getUTCMonth() + 1,0);
  const last = boundary.getUTCDate();
  target.setUTCDate(Math.min(day,last));
  const result = target.toISOString().slice(0,10);
  return isReportDate(result) ? result : null;
}

function statusLabel(complete) {
  return complete ? '' : '会計明細が一部保存されていないため、明細別の数値は確認できる伝票分です。';
}

function emptyCohort() {
  return {groups:0,guests:0,missingGuests:0,sales:0,missingSales:0,measured:0,duration:0};
}

function emptyVisitStats() {
  return {expected:0,details:0,complete:true,measured:0,duration:0,awaitingDeparture:0,missingTimes:0,
    cohorts:{nominated:emptyCohort(),other:emptyCohort()}};
}

function observedVisitDuration(ticket) {
  const validTime = (value) => Number.isSafeInteger(value) && value > 0;
  return ticket.status === 'departed' && validTime(ticket.createdAt) && validTime(ticket.departedAt) && ticket.departedAt >= ticket.createdAt
    ? ticket.departedAt - ticket.createdAt : null;
}

function addVisit(stats,ticket,lines,sales) {
  stats.details++;
  const duration = observedVisitDuration(ticket);
  if (duration !== null) {
    stats.measured++;
    stats.duration += duration;
  } else if (ticket.status === 'paid') stats.awaitingDeparture++;
  else stats.missingTimes++;
  const nominated = lines.some(({category,menuId}) => category === '指名' || menuId === 'nominationExtra');
  if (!nominated && (!lines.length || lines.some(({category}) => typeof category !== 'string' || !category))) return;
  const row = stats.cohorts[nominated ? 'nominated' : 'other'];
  row.groups++;
  if (Number.isSafeInteger(ticket.guests) && ticket.guests > 0) row.guests += ticket.guests;
  else row.missingGuests++;
  if (Number.isSafeInteger(sales) && sales >= 0) row.sales += sales;
  else row.missingSales++;
  if (duration !== null) {
    row.measured++;
    row.duration += duration;
  }
}

function combineVisits(days) {
  const total = emptyVisitStats();
  for (const {visit} of days) {
    total.expected = total.expected === null || visit.expected === null ? null : total.expected + visit.expected;
    total.complete &&= visit.complete;
    for (const key of ['details','measured','duration','awaitingDeparture','missingTimes']) total[key] += visit[key];
    for (const key of Object.keys(nominationLabels)) {
      for (const field of Object.keys(total.cohorts[key])) total.cohorts[key][field] += visit.cohorts[key][field];
    }
  }
  return total;
}

function summarizeVisits(stats) {
  const classified = stats.cohorts.nominated.groups + stats.cohorts.other.groups;
  const absentDetails = stats.expected === null || stats.details > stats.expected ? null : stats.expected - stats.details;
  const unclassified = absentDetails === null ? null : stats.details - classified + absentDetails;
  const completeClassification = stats.complete && absentDetails === 0 && unclassified === 0;
  const cohorts = Object.fromEntries(Object.entries(stats.cohorts).map(([key,row]) => [key,{
    groups:classified || completeClassification ? row.groups : null,
    guests:row.missingGuests || (!classified && !completeClassification) ? null : row.guests,
    sales:row.missingSales || (!classified && !completeClassification) ? null : row.sales,
    averageSpend:row.guests && !row.missingGuests && !row.missingSales ? average(row.sales,row.guests) : null,
    measured:row.measured,
    averageMinutes:row.measured ? average(row.duration / minute,row.measured) : null,
  }]));
  return {expected:stats.expected,classified,unclassified,completeClassification,absentDetails,cohorts,
    measured:stats.measured,averageMinutes:stats.measured ? average(stats.duration / minute,stats.measured) : null,
    awaitingDeparture:stats.awaitingDeparture,missingTimes:stats.missingTimes,
    nominationRate:classified ? Number((stats.cohorts.nominated.groups / classified * 100).toFixed(1)) : null};
}

export function getAnalytics(state, range = {}) {
  const start = range.start ?? `${state.day.date.slice(0,7)}-01`;
  const end = range.end ?? state.day.date;
  const period = getReportPeriod(state,{mode:'range',start,end});
  const products = new Map();
  const casts = new Map();
  let service = 0;
  let complete = true;
  let cost = 0;

  const recordedDays = period.days.map((day) => {
    const { date, current, closed, settledTickets, ticketDataComplete } = day;
    if (!ticketDataComplete) complete = false;
    const visit = emptyVisitStats();
    visit.expected = (ticketDataComplete || closed?.tickets != null) && Number.isSafeInteger(current.tickets) && current.tickets >= 0
      ? current.tickets : null;
    visit.complete = ticketDataComplete;
    let discounts = 0;
    for (const ticket of settledTickets) {
      const lines = ticket.lines.filter(({cancelledAt}) => cancelledAt == null);
      const totals = quote(day.state,ticket.id);
      service += asYen(totals.service);
      discounts += asYen(totals.discount);
      cost += lines.flatMap(({stockUses}) => stockUses ?? []).reduce((sum,use) => sum + use.quantity * use.unitCost,0);
      addVisit(visit,ticket,lines,ticket.settlement?.total ?? (ticketDataComplete ? totals.total : null));
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
    if (visit.expected !== null && visit.details > visit.expected) visit.expected = null;
    return {date,sales:current.sales,tickets:current.tickets,guests:current.guests,discounts,visit,
      averageSpend:average(current.sales,current.guests)};
  });
  const visits = summarizeVisits(combineVisits(recordedDays));
  const days = recordedDays.map(({visit,...day}) => ({...day,visits:summarizeVisits(visit)}));

  const { totals } = period;
  const comparison = Object.hasOwn(comparisons,range.comparison) ? range.comparison : 'previous';
  let previousStart;
  let previousEnd;
  if (period.valid) {
    const shift = comparison === 'week' ? 7 : 1;
    if (comparison === 'day' || comparison === 'week') {
      previousStart = relativeDate(period.start,-shift);
      previousEnd = relativeDate(period.end,-shift);
    } else if (comparison === 'month' || comparison === 'year') {
      const months = comparison === 'month' ? 1 : 12;
      previousStart = previousCalendarDate(period.start,months);
      previousEnd = previousCalendarDate(period.end,months);
    } else {
      previousEnd = relativeDate(period.start,-1);
      previousStart = relativeDate(previousEnd,-daysBetween(period.start,period.end));
    }
  }
  const previous = previousStart ? getReportPeriod(state,{mode:'range',start:previousStart,end:previousEnd}) : null;
  const previousSales = previous?.days.length ? previous.totals.sales : null;
  const weekdays = weekdayNames.map((label,index) => {
    const samples = days.filter(({date}) => new Date(date).getUTCDay() === index);
    return {label,days:samples.length,sales:samples.length ? average(samples.reduce((sum,day)=>sum + day.sales,0),samples.length) : null};
  });
  return {start,end,period,days,service,withNomination:visits.cohorts.nominated.groups ?? 0,previousSales,previousStart,previousEnd,comparison,complete,weekdays,
    visits,
    orderCost:Math.round(cost),perGroup:average(totals.sales,totals.tickets),
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

const minutesLabel = (minutes) => minutes === null ? '—' : `${minutes}分`;
const rateLabel = (rate) => rate === null ? '—' : `${rate.toFixed(1)}%`;
const groupLabel = (count) => count === null ? '—' : `${count}組`;

function barChart(title, days, metric, api, format = api.yen) {
  const {escape} = api;
  const values = typeof metric === 'function' ? metric : (day) => day[metric];
  const visible = days.slice(-14);
  const max = Math.max(1,...visible.map((day) => values(day) ?? 0));
  return panel(title,`${days.length > 14 ? '<p class="lr-period-note">直近14営業日</p>' : ''}
    <ol class="analytics-chart" aria-label="${title}">${visible.map((day) =>
      `<li><time datetime="${escape(day.date)}">${escape(day.date.slice(5))}</time>
        <span aria-hidden="true"><i style="width:${Math.max(0,(values(day) ?? 0) / max * 100).toFixed(2)}%"></i></span>
        <strong>${format(values(day))}</strong></li>`).join('')}</ol>`);
}

function metrics(items) {
  return `<div class="analytics-metrics">${items.map(([label,value,note]) =>
    `<div class="lr-panel"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`).join('')}</div>`;
}

function nominationComparison(visits,{escape,yen}) {
  const money = (value) => value === null ? '—' : yen(value);
  const comparison = Object.entries(nominationLabels).map(([key,label]) => {
    const {groups,sales,guests,averageSpend,averageMinutes,measured} = visits.cohorts[key];
    return [label,groupLabel(groups),money(sales),guests === null ? '—' : `${guests}名`,money(averageSpend),minutesLabel(averageMinutes),
      groupLabel(measured)];
  });
  const coverage = !visits.completeClassification
    ? `<p class="lr-period-note">指名区分を確認できた${visits.classified}組の集計です。${visits.expected === null ? '旧データには伝票の総件数がない営業日があります。'
      : visits.unclassified ? `区分が不明な${visits.unclassified}組は比較に含めていません。` : '一部の営業日で会計明細と保存済み売上の照合ができません。'}</p>` : '';
  return panel('指名あり・なしの比較',`${coverage}
    ${rows(['区分','組数','確定売上','客数','客単価','平均滞在','計測組数'],comparison,escape)}
    <p class="lr-period-note">指名区分は、取消されていない指名・延長指名料の明細から判定します。</p>`);
}

function stayCoverage(visits) {
  const notMeasured = [
    visits.awaitingDeparture ? `会計済み・退店未記録 ${visits.awaitingDeparture}組` : '',
    visits.missingTimes ? `来店・退店時刻の記録不足 ${visits.missingTimes}組` : '',
    visits.absentDetails ? `会計明細の記録なし ${visits.absentDetails}組` : '',
  ].filter(Boolean);
  return `<p class="lr-period-note">平均滞在は来店から退店までを計測した組が対象です。${notMeasured.length
    ? `集計対象外は、${notMeasured.join('、')}です。` : ''}${visits.expected === null ? '旧データには伝票の総件数がない営業日があります。' : ''}</p>`;
}

export function renderAnalytics(page, state, api) {
  const {escape,icon,yen,print = false} = api;
  const data = getAnalytics(state,api.range);
  const {period,days,products,casts,start,end,complete,previousSales,averageSpend,visits} = data;
  const product = page === 'product-sales';
  const {totals} = period;
  const download = period.valid && days.length > 0;
  const controls = print ? `<header class="workspace-print-heading"><h1>${product ? '商品別集計' : '経営分析'}</h1><p>${escape(start)} 〜 ${escape(end)}</p></header>`
    : `<section class="lr-period-tools" aria-label="集計期間と出力"><div class="lr-period-controls"><div class="lr-period-dates">
      <label class="lr-period-field"><span>開始日</span><input type="date" data-analytics-start value="${escape(start)}"></label>
      <label class="lr-period-field"><span>終了日</span><input type="date" data-analytics-end value="${escape(end)}"></label>
      ${product ? '' : `<label class="lr-period-field"><span>比較</span><select data-analytics-comparison>${Object.entries(comparisons).map(([key,label]) =>
        `<option value="${key}"${key === data.comparison ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`}
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
      ${metrics([['商品小計',yen(itemTotal),'値引き・サービス料を加味する前の注文金額'],['商品数',products.length],['対象の営業日',days.length]])}
      ${panel('商品別の内訳',products.length ? productRows : '<p class="field-help">この期間に会計済みの商品はありません。</p>')}</div>`;
  }
  const comparison = previousSales == null ? '比較期間の営業データなし'
    : `${comparisons[data.comparison]} ${yen(previousSales)}`;
  const tender = totals.hasCombinedOnlyPayments ? totals.payments : totals.tenderPayments;
  const tenderTotal = methods.reduce((total,[key])=>total + asYen(tender[key]),0) + (totals.hasCombinedOnlyPayments ? 0 : totals.depositsApplied);
  const tenderRows = methods.map(([key,label]) => [label,yen(tender[key]),percent(tender[key],tenderTotal)]);
  if (!totals.hasCombinedOnlyPayments) tenderRows.push(['前受金の充当',yen(totals.depositsApplied),percent(totals.depositsApplied,tenderTotal)]);
  return `<div class="lr-view analytics-view">${controls}${caveat}
    ${metrics([['確定売上',yen(totals.sales),comparison],['客単価',yen(averageSpend),`${totals.guests}名`],
      ['指名率',rateLabel(visits.nominationRate),visits.classified ? `指名区分が確認できた ${visits.classified}組`
        : visits.completeClassification ? '会計済みの来店なし' : '指名区分の記録なし'],
      ['平均滞在',minutesLabel(visits.averageMinutes),visits.expected === null ? `${visits.measured}組を計測`
        : `${visits.expected}組中 ${visits.measured}組を計測`],
      ['サービス料比率',complete ? percent(data.service,totals.sales) : '—'],
      ['組単価',totals.tickets ? yen(data.perGroup) : '—',`${totals.tickets}組`],
      ['売上 − 注文原価',complete ? yen(totals.sales - data.orderCost) : '—',`注文原価 ${yen(data.orderCost)}`]])}
    <div class="lr-split">${barChart('売上の推移',days,'sales',api)}${barChart('客単価の推移',days,'averageSpend',api)}</div>
    <div class="lr-split">${barChart('平均滞在の推移',days,(day) => day.visits.averageMinutes,api,minutesLabel)}${nominationComparison(visits,api)}</div>
    ${stayCoverage(visits)}
    <div class="lr-split">${panel('曜日別の平均売上',rows(['曜日','営業日数','平均売上'],
      data.weekdays.map(({label,days,sales})=>[label,days,sales == null ? '—' : yen(sales)]),escape))}
      ${barChart('値引き額の推移',days,'discounts',api)}</div>
    <div class="lr-split">${panel(totals.hasCombinedOnlyPayments ? '決済別入金（前受金を含む）' : '決済別内訳',rows(['区分','金額','構成比'],tenderRows,escape))}
      ${panel('商品別売上 上位5件',products.length ? rows(['商品','数量','商品小計'],products.slice(0,5).map(({name,quantity,sales}) => [name,quantity,yen(sales)]),escape)
        : '<p class="field-help">この期間に会計済みの商品はありません。</p>')}</div>
    ${panel('営業日ごとの実績',rows(['営業日','確定売上','組数','客数','客単価','平均滞在','計測組数','指名率','指名区分を確認'],
    days.map(({date,sales,tickets,guests,averageSpend:spend,visits:dayVisits}) =>
      [date,yen(sales),tickets,guests,yen(spend),minutesLabel(dayVisits.averageMinutes),groupLabel(dayVisits.measured),
        rateLabel(dayVisits.nominationRate),groupLabel(dayVisits.classified)]),escape))}
    ${panel('キャスト成績',casts.length ? rows(['キャスト','個人売上','確定歩合','ポイント'],casts.map(({name,sales,commission,points}) =>
      [name,yen(sales),yen(commission),Math.round(points * 100) / 100]),escape) : '<p class="field-help">この期間の確定歩合はありません。</p>')}</div>`;
}

export function buildAnalyticsCsv(page,state,range) {
  const {period,days,products} = getAnalytics(state,range);
  if (!period.valid || !days.length) return '';
  if (page === 'product-sales') return encodeCsv([['開始日','終了日','商品','分類','数量','伝票数','商品小計'],
    ...products.map(({name,category,quantity,tickets,sales}) => [period.start,period.end,name,category,quantity,tickets,sales])]);
  const cohortLabels = Object.values(nominationLabels).flatMap((label) => ['組数','売上','客数','客単価','平均滞在（分）','計測組数']
    .map((column) => label + column));
  return encodeCsv([['営業日','確定売上','組数','客数','客単価','平均滞在（分）','滞在計測組数','退店未記録組数',
    '来店・退店時刻不足組数','会計明細の記録がない組数','指名区分確認組数','指名区分不明組数','指名率（%）',...cohortLabels],
    ...days.map(({date,sales,tickets,guests,averageSpend,visits}) => [
      date,sales,tickets,guests,averageSpend,visits.averageMinutes,visits.measured,visits.awaitingDeparture,visits.missingTimes,
      visits.absentDetails,visits.classified,visits.unclassified,visits.nominationRate,
      ...Object.keys(nominationLabels).flatMap((key) => {
        const row = visits.cohorts[key];
        return [row.groups,row.sales,row.guests,row.averageSpend,row.averageMinutes,row.measured];
      }),
    ])]);
}
