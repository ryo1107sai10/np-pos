import { encodeCsv } from './csv-file.mjs';
import { isAssignedCustomer } from './customers.mjs';
import { getTicketTableLabels, quote } from './engine.mjs';
import { getReportPeriod } from './report-period.mjs';

const methods = { cash:'現金', card:'カード', qr:'QR決済', receivable:'売掛' };
const statuses = { paid:'会計済み', departed:'退店済み', cancelled:'会計取消', void:'伝票取消' };
const time = new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
let remembered;

function defaults(state, {workspaceId,role}) {
  if (remembered && remembered.workspaceId === workspaceId && remembered.role === role && remembered.date === state.day.date) return remembered.filters;
  return { start:`${state.day.date.slice(0,7)}-01`,end:state.day.date,payment:'',status:'',query:'' };
}

function normalize(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/\s/gu,'');
}

function paymentKinds(ticket) {
  const kinds = new Set([...(ticket.payments ?? []),...(ticket.deposits ?? [])].map(({method}) => method));
  return Object.keys(methods).filter((method) => kinds.has(method));
}

function makeRow(state, date, ticket, canViewCustomer, cancelled) {
  const status = cancelled ? 'cancelled' : ticket.status;
  const at = cancelled ? cancelled.at : ticket.settledAt ?? ticket.createdAt;
  const room = getTicketTableLabels(state,ticket).join('・');
  return {
    id:cancelled?.id ?? ticket.id, number:ticket.number, date, at,
    time:Number.isFinite(at) ? time.format(at) : '', status,
    room, customer:canViewCustomer(ticket) && typeof ticket.customer === 'string' ? ticket.customer : '', guests:ticket.guests,
    methods:paymentKinds(ticket),
    total:status === 'void' ? null : ticket.settlement?.total ?? quote({...state,tickets:[ticket]},ticket.id).total,
  };
}

export function getTicketHistory(state, filters, { role,workspaceId } = {}) {
  const period = getReportPeriod(state,{...filters,mode:'range'});
  if (!period.valid) return { rows:[], total:0, count:0, error:period.error };
  const demoManager = !workspaceId && role === 'manager';
  const assigned = demoManager ? new Set((state.customers ?? [])
    .filter((customer) => isAssignedCustomer(state,customer,'demo-manager')).map(({id}) => id)) : null;
  const canViewCustomer = (ticket) => !assigned || assigned.has(ticket.customerId) || ticket.seatedByUid === 'demo-manager';
  const rows = period.days.flatMap(({date,settledTickets,tickets}) => [
    ...settledTickets.map((ticket) => makeRow(state,date,ticket,canViewCustomer)),
    ...tickets.filter(({status}) => status === 'void').map((ticket) => makeRow(state,date,ticket,canViewCustomer)),
  ]);
  for (const cancellation of state.cancelledSettlements ?? []) {
    if (cancellation.date >= period.start && cancellation.date <= period.end && cancellation.receipt) {
      rows.push(makeRow(state,cancellation.date,cancellation.receipt,canViewCustomer,cancellation));
    }
  }
  const query = normalize(filters.query ?? '');
  const filtered = rows.filter((row) => (!filters.status || row.status === filters.status)
    && (!filters.payment || row.methods.includes(filters.payment))
    && (!query || [row.customer,row.room,`No.${row.number}`].some((value) => normalize(value).includes(query))));
  filtered.sort((a,b) => b.date.localeCompare(a.date) || (b.at ?? 0) - (a.at ?? 0) || b.number - a.number);
  const settled = filtered.filter(({status}) => status === 'paid' || status === 'departed');
  return { rows:filtered,total:settled.reduce((sum,{total}) => sum + total,0),count:settled.length,error:'' };
}

function options(dictionary, selected, allLabel) {
  return `<option value="">${allLabel}</option>${Object.entries(dictionary).map(([value,label]) =>
    `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`).join('')}`;
}

function renderRows(result, api) {
  const { escape, icon, yen } = api;
  if (result.error) return `<p class="np-history-message" role="alert">${escape(result.error)}</p>`;
  const rows = result.rows.map((row) => {
    const {status,id,number,date,time:clock,room,customer,guests,methods:kinds,total} = row;
    const detail = status === 'void' ? `<strong>No. ${escape(number)}</strong>`
      : `<button class="np-history-link" type="button" data-action="${status === 'cancelled' ? 'cancelled-receipt' : 'history-receipt'}"
          data-id="${escape(id)}" data-date="${escape(date)}" aria-label="${status === 'cancelled' ? '会計取消' : '会計内容'} No. ${escape(number)} ${escape(date)}">
          No. ${escape(number)} ${icon('chevron-right',15)}</button>`;
    return `<tr>
      <td data-label="営業日">${escape(date)} ${escape(clock)}</td>
      <td data-label="伝票">${detail}</td><td data-label="卓・人数">${escape(room || '—')}${Number.isFinite(guests) ? ` · ${guests}名` : ''}</td>
      <td data-label="顧客">${escape(customer || '—')}</td><td data-label="支払方法">${kinds.map((method) => methods[method]).join('・') || '—'}</td>
      <td data-label="状態"><span class="np-history-status${status === 'cancelled' || status === 'void' ? ' np-history-status-cancelled' : ''}">${statuses[status]}</span></td>
      <td data-label="税込金額" class="np-history-amount">${total == null ? '—' : yen(total)}</td>
    </tr>`;
  });
  return `<div class="np-history-summary"><p role="status"><strong>${result.rows.length}件</strong>表示 <span>確定売上 ${yen(result.total)}（${result.count}件）</span></p>
      <button type="button" class="btn btn-secondary" data-history-export${rows.length ? '' : ' disabled'}>CSVを出力</button></div>
    ${rows.length ? `<table class="np-history-table"><thead><tr>${['営業日','伝票','卓・人数','顧客','支払方法','状態','税込金額'].map((label) => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
      : '<p class="np-history-message">条件に一致する伝票がありません。</p>'}`;
}

export function renderTicketHistory(state, api) {
  const filters = defaults(state,api);
  const { escape } = api;
  return `<section class="np-history" aria-label="伝票履歴">
    <form class="np-history-form" aria-label="伝票履歴を絞り込む">
      <label class="field"><span>開始日</span><input type="date" name="start" value="${escape(filters.start)}" required></label>
      <label class="field"><span>終了日</span><input type="date" name="end" value="${escape(filters.end)}" required></label>
      <label class="field"><span>支払方法</span><select name="payment">${options(methods,filters.payment,'すべて')}</select></label>
      <label class="field"><span>状態</span><select name="status">${options(statuses,filters.status,'すべて')}</select></label>
      <label class="field np-history-query"><span>顧客名・卓・伝票番号</span><input type="search" name="query" maxlength="100" value="${escape(filters.query)}" placeholder="例　A-03"></label>
      <button type="submit" class="btn btn-primary">検索</button>
    </form>
    <div class="np-history-results">${renderRows(getTicketHistory(state,filters,api),api)}</div>
  </section>`;
}

export function buildTicketHistoryCsv(result) {
  return encodeCsv([['営業日','時刻','伝票番号','卓','人数','顧客','支払方法','状態','税込金額'],
    ...result.rows.map((row) => [row.date,row.time,row.number,row.room,row.guests,row.customer,
      row.methods.map((method) => methods[method]).join('・'),statuses[row.status],row.total])]);
}

export function bindTicketHistory(root, state, api) {
  const history = root.querySelector('.np-history');
  if (!history) return;
  const form = history.querySelector('form');
  let filters = defaults(state,api);
  let result;
  form.addEventListener('submit',(event) => {
    event.preventDefault();
    filters = Object.fromEntries(new FormData(form));
    remembered = { workspaceId:api.workspaceId,role:api.role,date:state.day.date,filters };
    result = getTicketHistory(state,filters,api);
    history.querySelector('.np-history-results').innerHTML = renderRows(result,api);
  });
  history.addEventListener('click',(event) => {
    if (!event.target.closest('[data-history-export]')) return;
    result ??= getTicketHistory(state,filters,api);
    if (!result.rows.length) return;
    const url = URL.createObjectURL(new Blob([buildTicketHistoryCsv(result)],{type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = `np-pos-伝票履歴-${filters.start}_${filters.end}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),10_000);
  });
}
