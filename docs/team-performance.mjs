import { encodeCsv, encodeTsv } from './csv-file.mjs';
import { quote } from './engine.mjs';
import { getReportPeriod } from './report-period.mjs';

const roles = {manager:'マネージャー', staff:'スタッフ'};
const allRoles = 'マネージャー・スタッフ';

export function getTeamPerformance(state, range = {}, role = 'all') {
  const start = range.start ?? `${state.day.date.slice(0,7)}-01`;
  const end = range.end ?? state.day.date;
  const period = getReportPeriod(state,{mode:'range',start,end});
  const operators = new Map();
  let unattributed = 0;

  for (const day of period.days) {
    unattributed += Math.max(0,day.current.tickets - day.settledTickets.length);
    for (const ticket of day.settledTickets) {
      const actor = ticket.settledBy;
      if (typeof actor?.id !== 'string' || !actor.id || typeof actor.label !== 'string' || !actor.label.trim()
        || (actor.role !== 'admin' && !Object.hasOwn(roles,actor.role))) {
        unattributed++;
        continue;
      }
      if (actor.role === 'admin' || (role !== 'all' && actor.role !== role)) continue;
      const key = JSON.stringify([actor.id,actor.role]);
      const row = operators.get(key) ?? {label:actor.label,role:actor.role,tickets:0,sales:0,at:0};
      const at = ticket.settledAt ?? 0;
      if (at >= row.at) { row.label = actor.label; row.at = at; }
      row.tickets++;
      row.sales += quote(day.state,ticket.id).total;
      operators.set(key,row);
    }
  }

  const rows = [...operators.values()].sort((a,b) => b.sales-a.sales || a.label.localeCompare(b.label,'ja'));
  return {start,end,period,rows,unattributed,
    tickets:rows.reduce((sum,row) => sum + row.tickets,0),
    sales:rows.reduce((sum,row) => sum + row.sales,0)};
}

export function buildTeamPerformanceCsv(state, range, role, {format = 'csv'} = {}) {
  const {start,end,period,rows,unattributed} = getTeamPerformance(state,range,role);
  if (!period.valid || !period.days.length) return '';
  const encode = format === 'tsv' ? encodeTsv : encodeCsv;
  return encode([['開始日','終了日','会計確定者','役割','件数','税込会計額'],
    ...rows.map((row) => [start,end,row.label,roles[row.role],row.tickets,row.sales]),
    ...(unattributed ? [[start,end,'確定者の記録なし','',unattributed,'']] : [])]);
}

export function renderTeamPerformance(state, {range,role = 'all',escape,icon,yen,print = false,storeName}) {
  const {start,end,period,rows,unattributed,tickets,sales} = getTeamPerformance(state,range,role);
  const hasData = period.valid && period.days.length > 0;
  if (print && !hasData) return '';
  const controls = print ? `<header class="workspace-print-heading"><h1>スタッフ成績</h1>
    <p>${storeName ? `${escape(storeName)} ／ ` : ''}営業日 ${escape(start)}${start === end ? '' : ` 〜 ${escape(end)}`} ／ ${roles[role] ?? allRoles}</p></header>`
    : `<section class="lr-period-tools" aria-label="集計条件と出力"><div class="lr-period-controls"><div class="lr-period-dates">
    <label class="lr-period-field"><span>開始日</span><input type="date" data-team-start value="${escape(start)}"></label>
    <label class="lr-period-field"><span>終了日</span><input type="date" data-team-end value="${escape(end)}"></label>
    <label class="lr-period-field field"><span>役割</span><select data-team-role><option value="all">${allRoles}</option>${Object.entries(roles).map(([id,label]) => `<option value="${id}"${id===role?' selected':''}>${label}</option>`).join('')}</select></label>
    </div></div><div class="lr-period-exports"><button type="button" class="btn btn-secondary" data-action="team-performance-csv"${hasData?'':' disabled'}>${icon('download',16)}CSV出力</button>
      <button type="button" class="btn btn-secondary" data-action="team-performance-tsv"${hasData?'':' disabled'}>${icon('download',16)}TSV出力</button>
      <button type="button" class="btn" data-action="team-performance-print"${hasData?'':' disabled'}>${icon('printer',16)}印刷</button></div></section>`;
  if (!hasData) return `<div class="lr-view">${controls}<p class="notice" role="status">${escape(period.error || 'この期間の営業データはありません。')}</p></div>`;
  const metrics = [['確定者数',`${rows.length}名`],['確定件数',`${tickets}件`],['税込会計額',yen(sales)],['確定者の記録なし',`${unattributed}件`]];
  return `<div class="lr-view analytics-view${print ? ' report-print' : ''}">${controls}
    <div class="analytics-metrics">${metrics.map(([label,value]) => `<div class="lr-panel"><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>
    <section class="lr-panel"><div class="lr-panel-head"><h2>確定者別の会計実績</h2></div>
    ${rows.length ? `<div class="analytics-table" tabindex="0"><table><thead><tr><th scope="col">会計確定者</th><th scope="col">役割</th><th scope="col">件数</th><th scope="col">税込会計額</th></tr></thead><tbody>
      ${rows.map((row) => `<tr><th scope="row">${escape(row.label)}</th><td>${roles[row.role]}</td><td>${row.tickets}</td><td>${yen(row.sales)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="field-help">この条件に一致する、確定者の記録がある会計はありません。</p>'}
    </section></div>`;
}
