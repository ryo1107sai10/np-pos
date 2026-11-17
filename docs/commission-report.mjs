import { encodeCsv } from './csv-file.mjs';
import { getTicketCommissionDetails } from './engine.mjs';
import { getReportPeriod } from './report-period.mjs';

const time = new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

function addTotals(target, entries) {
  for (const {castId,sales,amount,points} of entries ?? []) {
    const row = target.get(castId) ?? {sales:0,amount:0,points:0};
    row.sales += sales ?? 0;
    row.amount += amount ?? 0;
    row.points = Math.round((row.points + (points ?? 0)) * 1000) / 1000;
    target.set(castId,row);
  }
}

export function getCommissionReport(state, filters = {}, castId = '') {
  const period = getReportPeriod(state,{start:`${state.day.date.slice(0,7)}-01`,end:state.day.date,...filters});
  const earned = new Map();
  const pending = new Map();
  const details = [];
  const includesOpenDay = state.day.status === 'open' && period.days.some(({date}) => date === state.day.date);
  for (const day of period.days) {
    addTotals(earned,day.current.commission);
    if (!day.closed) addTotals(pending,day.current.pendingCommission);
    for (const ticket of day.tickets) {
      const isPending = ticket.status === 'open' && !day.closed;
      if (!isPending && ticket.status !== 'paid' && ticket.status !== 'departed') continue;
      for (const entry of getTicketCommissionDetails(day.state,ticket.id)) {
        details.push({date:day.date,ticket,entry,isPending,
          at:isPending ? entry.createdAt ?? ticket.createdAt : ticket.settledAt});
      }
    }
  }
  details.sort((a,b) => b.date.localeCompare(a.date) || (b.at ?? 0) - (a.at ?? 0));
  const names = new Map([...(state.archivedCast ?? []), ...state.cast].map(({id,name}) => [id,name]));
  const recordedNames = new Map();
  for (const {entry} of details) {
    if (entry.castName && !recordedNames.has(entry.castId)) recordedNames.set(entry.castId,entry.castName);
  }
  const name = (id) => (includesOpenDay ? names.get(id) : recordedNames.get(id)) ?? names.get(id) ?? recordedNames.get(id) ?? id;
  const activeCast = includesOpenDay ? state.cast.filter((person) => person.enabled !== false).map(({id}) => id) : [];
  const castIds = new Set([...activeCast, ...earned.keys(), ...pending.keys(), ...details.map(({entry}) => entry.castId)]);
  const selected = castIds.has(castId) ? castId : '';
  const roster = [...castIds].map((id) => ({id,name:name(id),final:earned.get(id),estimate:pending.get(id)}));
  return {period,roster,earned:[...earned.values()],pending:[...pending.values()],selected,includesOpenDay,
    hasMissingDetails:period.days.some(({legacy}) => legacy),
    selectedName:selected ? name(selected) : '',
    details:details.filter(({entry}) => !selected || entry.castId === selected)
      .map((row) => ({...row,name:row.entry.castName ?? name(row.entry.castId)}))};
}

export function buildCommissionCsv(report, kind) {
  const {period,roster,details,selected} = report;
  if (!period.valid || !period.days.length) return '';
  if (kind === 'summary') {
    return encodeCsv([['開始日','終了日','キャスト','個人売上','確定歩合','見込み歩合','確定ポイント'],
      ...roster.filter(({id}) => !selected || id === selected).map(({name,final,estimate}) =>
        [period.start,period.end,name,final?.sales ?? 0,final?.amount ?? 0,estimate?.amount ?? 0,final?.points ?? 0])]);
  }
  return encodeCsv([['営業日','区分','時刻（日本時間）','伝票番号','注文明細','キャスト','個人売上','歩合','ポイント','調整理由'],
    ...details.map(({date,ticket,entry,isPending,at,name}) => [date,isPending ? '見込み' : '確定',
      Number.isFinite(at) ? time.format(at) : '',ticket.number,entry.name,name,entry.sales,entry.amount,entry.points,entry.adjustmentReason])]);
}
