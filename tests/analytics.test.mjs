import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnalyticsCsv, getAnalytics, renderAnalytics } from '../docs/analytics.mjs';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { createVisitAnalyticsDemo } from '../docs/phase-two-demo.mjs';
import { buildTeamPerformanceCsv, renderTeamPerformance } from '../docs/team-performance.mjs';

const date = '2026-11-17';
const before = '2026-11-16';
const base = Date.parse(`${date}T23:25:00+09:00`);
const minute = 60_000;
const range = {start:date,end:date};
const api = {escape:String,icon:() => '',yen:(value) => `¥${value}`};

function liveVisits() {
  let state = createDemo('closed',base);
  const run = (command,minutes) => { state = apply(state,command,base + minute * minutes); };
  const seat = (tableIds,guests,minutes) => {
    run({type:'seat',tableIds,guests,setId:'set60'},minutes);
    return state.tickets.at(-1).id;
  };
  const nominate = (ticketId,minutes) => run({type:'order',ticketId,items:[{menuId:'nomination',quantity:1,castIds:['cast1']}]},minutes);
  const settle = (ticketId,minutes) => {
    const amount = quote(state,ticketId).total;
    run({type:'settle',ticketId,payments:[{method:'cash',amount}]},minutes);
    return amount;
  };
  run({type:'open',date,openingCash:0},0);
  const nominated = seat(['a1'],2,0);
  nominate(nominated,1);
  const other = seat(['a2','a3'],3,2);
  nominate(other,3);
  run({type:'cancelLine',ticketId:other,lineId:state.tickets.at(-1).lines.at(-1).id,reason:'指名取り消し'},4);
  const pending = seat(['a4'],1,5);
  const nominatedSales = settle(nominated,6);
  const otherSales = settle(other,7);
  const pendingSales = settle(pending,8);
  run({type:'depart',ticketId:other},32);
  run({type:'depart',ticketId:nominated},60);
  return {state,nominated,other,pending,nominatedSales,otherSales,pendingSales};
}

function csvRows(state,interval) {
  const [header,...rows] = buildAnalyticsCsv('analytics',state,interval).slice(1).trim().split('\r\n').map((row) => row.split(','));
  return rows.map((row) => Object.fromEntries(header.map((column,index) => [column,row[index] ?? ''])));
}

test('the staff performance print uses the selected business dates and role', () => {
  const {state,nominated,other,nominatedSales} = liveVisits();
  state.tickets.find(({id})=>id === nominated).settledBy = {id:'manager',label:'佐伯',role:'manager'};
  state.tickets.find(({id})=>id === other).settledBy = {id:'staff',label:'望月',role:'staff'};
  const options = {...api,range,role:'manager',storeName:'検証店舗'};
  const screen = renderTeamPerformance(state,options);
  const print = renderTeamPerformance(state,{...options,print:true});
  assert.match(screen,/data-action="team-performance-print">印刷/);
  assert.match(print,/<h1>スタッフ成績<\/h1>[\s\S]*検証店舗 ／ 営業日 2026-11-17 ／ マネージャー/);
  assert.match(print,new RegExp(`佐伯[\\s\\S]*¥${nominatedSales}`));
  assert.doesNotMatch(print,/望月|<button|<select/);
  assert.match(buildTeamPerformanceCsv(state,range,'manager'),new RegExp(`佐伯,マネージャー,1,${nominatedSales}`));
  assert.equal(renderTeamPerformance(state,{...options,print:true,range:{start:date,end:before}}),'');
});

test('confirmed visit analytics use actual departure and compare nomination groups, not active or cancelled charges', () => {
  const {state,nominated,other,pending,nominatedSales,otherSales,pendingSales} = liveVisits();
  state.tickets.find(({id})=>id === nominated).setStartedAt = base - 120 * minute;
  assert.equal(state.tickets.find(({id})=>id === pending).departedAt,null);
  assert.equal(state.tickets.find(({id})=>id === other).departedAt,base + 32 * minute);
  const data = getAnalytics(state,range);
  assert.deepEqual(data.visits.cohorts.nominated,{
    groups:1,guests:2,sales:nominatedSales,averageSpend:Math.round(nominatedSales / 2),measured:1,averageMinutes:60,
  });
  assert.deepEqual(data.visits.cohorts.other,{
    groups:2,guests:4,sales:otherSales + pendingSales,averageSpend:Math.round((otherSales + pendingSales) / 4),
    measured:1,averageMinutes:30,
  });
  assert.equal(data.visits.averageMinutes,45);
  assert.equal(data.visits.awaitingDeparture,1);
  assert.equal(data.visits.measured,2);
  assert.equal(data.visits.nominationRate,33.3);
  assert.equal(data.visits.completeClassification,true);
  assert.equal(data.period.totals.sales,summary(state).sales);
  const [csv] = csvRows(state,range);
  assert.equal(csv.営業日,date);
  assert.equal(csv.確定売上,String(data.period.totals.sales));
  assert.equal(csv['平均滞在（分）'],'45');
  assert.equal(csv['滞在計測組数'],'2');
  assert.equal(csv['指名率（%）'],'33.3');
  assert.equal(csv['指名あり平均滞在（分）'],'60');
  assert.equal(csv['指名なし平均滞在（分）'],'30');
  const ui = renderAnalytics('analytics',state,{...api,range});
  assert.match(ui,/指名あり・なしの比較/);
  assert.match(ui,/33\.3%/);
  assert.match(ui,/平均滞在の推移[\s\S]*45分/);
  assert.match(ui,/会計済み・退店未記録 1組/);
});

test('added analysis indicators use recorded departures, valid sales and permission-scoped wage estimates', () => {
  const {state,nominated,other} = liveVisits();
  const overdue = state.tickets.find(({id}) => id === nominated);
  overdue.endsAt = overdue.departedAt - 12 * minute;
  const onTime = state.tickets.find(({id}) => id === other);
  onTime.endsAt = onTime.departedAt + 9 * minute;
  overdue.settlement.discount = 1_000;
  const data = getAnalytics(state,range);
  assert.equal(data.partySize,2);
  assert.equal(data.visits.averageOvertime,6);
  assert.equal(data.visits.overtimeMeasured,2);
  assert.equal(data.discountRate,Number((100_000 / data.days[0].subtotal).toFixed(1)));
  const [csv] = csvRows(state,range);
  assert.equal(csv['平均ロスタイム（分）'],'6');
  assert.doesNotMatch(renderAnalytics('analytics',state,{...api,range}),/概算給率/);
  const laborReport = {valid:true,hasKnownCost:true,partial:false,knownCost:data.period.totals.sales / 4};
  assert.match(renderAnalytics('analytics',state,{...api,range,laborReport}),/概算給率（全体）[\s\S]*25\.0%/);
  assert.doesNotMatch(renderAnalytics('analytics',state,{...api,range,laborReport:{...laborReport,partial:true}}),/25\.0%/);
});

test('legacy summaries preserve sales but do not invent a rate, duration, or cohort sales', () => {
  const {state} = liveVisits();
  state.closedDays.push({date:before,tickets:5,guests:8,sales:37_800});
  const interval = {start:before,end:date};
  const data = getAnalytics(state,interval);
  assert.equal(data.period.totals.sales,37_800 + summary(state).sales);
  assert.equal(data.days[0].visits.averageMinutes,null);
  assert.equal(data.days[0].visits.nominationRate,null);
  assert.equal(data.days[0].visits.cohorts.nominated.sales,null);
  assert.equal(data.visits.measured,2);
  assert.equal(data.visits.unclassified,5);
  assert.equal(data.visits.absentDetails,5);
  assert.equal(data.visits.nominationRate,33.3);
  assert.equal(data.visits.completeClassification,false);
  const [legacy,modern] = csvRows(state,interval);
  assert.equal(legacy.確定売上,'37800');
  assert.equal(legacy['平均滞在（分）'],'');
  assert.equal(legacy['指名率（%）'],'');
  assert.equal(legacy['指名なし売上'],'');
  assert.equal(legacy['指名区分不明組数'],'5');
  assert.equal(modern['平均滞在（分）'],'45');
  assert.match(renderAnalytics('analytics',state,{...api,range:interval}),/区分が不明な5組/);
  delete state.closedDays[0].tickets;
  const unknown = getAnalytics(state,{start:before,end:before});
  assert.equal(unknown.visits.expected,null);
  assert.equal(unknown.visits.unclassified,null);
  assert.match(renderAnalytics('analytics',state,{...api,range:{start:before,end:before}}),/伝票の総件数がない営業日/);
});

test('missing archived timestamps and a true zero stay are distinguished without browser-clock estimates', () => {
  const {state,nominated,other} = liveVisits();
  const tickets = structuredClone(state.tickets);
  const first = tickets.find(({id})=>id === nominated);
  first.departedAt = first.createdAt;
  const second = tickets.find(({id})=>id === other);
  second.departedAt = second.createdAt - 1;
  state.closedDays.push({...summary(state),date, ticketSnapshots:tickets});
  const data = getAnalytics(state,range);
  assert.equal(data.visits.measured,1);
  assert.equal(data.visits.averageMinutes,0);
  assert.equal(data.visits.missingTimes,1);
  assert.equal(data.visits.cohorts.nominated.averageMinutes,0);
  assert.equal(data.visits.cohorts.other.averageMinutes,null);
  const [csv] = csvRows(state,range);
  assert.equal(csv['平均滞在（分）'],'0');
  assert.equal(csv['指名なし平均滞在（分）'],'');
});

test('the sample contains both cohorts across days and weights duration by measured visits', () => {
  const state = createVisitAnalyticsDemo(Date.parse('2026-12-01T21:00:00+09:00'));
  const result = getAnalytics(state,{start:'2026-11-30',end:'2026-12-01'});
  assert.deepEqual(result.days.map(({visits})=>visits.averageMinutes),[45,60]);
  assert.equal(result.visits.averageMinutes,53);
  assert.equal(result.visits.cohorts.nominated.averageMinutes,65);
  assert.equal(result.visits.cohorts.other.averageMinutes,40);
  assert.equal(result.visits.cohorts.nominated.groups,2);
  assert.equal(result.visits.cohorts.other.groups,3);
  assert.equal(result.visits.awaitingDeparture,1);
  assert.equal(result.visits.nominationRate,40);
});
