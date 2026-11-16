import { encodeCsv } from './csv-file.mjs';
import { isAssignedCustomer } from './customers.mjs';
import { getTableLabel, getTicketTableLabels, quote } from './engine.mjs';
import { getReportPeriod } from './report-period.mjs';

const methods = { cash:'現金', card:'カード', qr:'QR決済' };
const statuses = { paid:'会計済み', departed:'退店済み', cancelled:'会計取消', void:'伝票取消' };
const time = new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
let remembered;

function defaults(state, {workspaceId,role}) {
  if (remembered && remembered.workspaceId === workspaceId && remembered.role === role && remembered.date === state.day.date) return remembered.filters;
  return { start:`${state.day.date.slice(0,7)}-01`,end:state.day.date,payment:[],status:'',query:'',tableId:'' };
}

export function selectTicketHistoryTable(state, {workspaceId,role}, tableId) {
  const {date} = state.day;
  remembered = {workspaceId,role,date,filters:{start:`${date.slice(0,7)}-01`,end:date,payment:[],status:'',query:'',tableId}};
}

function normalize(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/\s/gu,'');
}

function paymentKinds(ticket) {
  const kinds = new Set([...(ticket.payments ?? []),...(ticket.deposits ?? [])].map(({method}) => method));
  return Object.keys(methods).filter((method) => kinds.has(method));
}

function makeRow(state, date, ticket, canViewCustomer, tableId, cancelled) {
  const status = cancelled ? 'cancelled' : ticket.status;
  let at = cancelled?.at ?? ticket.settledAt ?? ticket.createdAt;
  let tableLabels = getTicketTableLabels(state,ticket);
  if (tableId) {
    const assignments = ticket.tableHistory ?? [];
    const visitedTables = new Set([...assignments.map((entry) => entry.tableId), ...ticket.tableIds]);
    if (!visitedTables.has(tableId)) return null;
    const firstUse = assignments.find((entry) => entry.tableId === tableId && Number.isFinite(entry.attachedAt));
    at = firstUse?.attachedAt ?? ticket.createdAt;
    tableLabels = [...visitedTables].map((id) => getTableLabel(state,id));
  }
  return {
    id:cancelled?.id ?? ticket.id, number:ticket.number, date, at,
    time:Number.isFinite(at) ? time.format(at) : '', status,
    room:tableLabels.join('・'), customer:canViewCustomer(ticket) && typeof ticket.customer === 'string' ? ticket.customer : '',
    guests:ticket.admittedGuests ?? ticket.guests,
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
    ...settledTickets.map((ticket) => makeRow(state,date,ticket,canViewCustomer,filters.tableId)),
    ...tickets.filter(({status}) => status === 'void').map((ticket) => makeRow(state,date,ticket,canViewCustomer,filters.tableId)),
  ]);
  for (const cancellation of state.cancelledSettlements ?? []) {
    if (cancellation.date >= period.start && cancellation.date <= period.end && cancellation.receipt) {
      rows.push(makeRow(state,cancellation.date,cancellation.receipt,canViewCustomer,filters.tableId,cancellation));
    }
  }
  const query = normalize(filters.query ?? '');
  const payments = Array.isArray(filters.payment) ? filters.payment : filters.payment ? [filters.payment] : [];
  const filtered = rows.filter((row) => row && (!filters.status || row.status === filters.status)
    && (!payments.length || row.methods.some((method) => payments.includes(method)))
    && (!query || [row.customer,row.room,`No.${row.number}`].some((value) => normalize(value).includes(query))));
  filtered.sort((a,b) => b.date.localeCompare(a.date) || (b.at ?? 0) - (a.at ?? 0) || b.number - a.number);
  const settled = filtered.filter(({status}) => status === 'paid' || status === 'departed');
  const total = settled.reduce((sum,row) => sum + row.total,0);
  const guests = settled.reduce((sum,row) => sum + (row.guests ?? 0),0);
  return {rows:filtered,total,guests,averageSpend:guests ? Math.round(total/guests) : null,
    count:settled.length,tableId:filters.tableId,error:''};
}

function options(dictionary, selected, allLabel) {
  return `<option value="">${allLabel}</option>${Object.entries(dictionary).map(([value,label]) =>
    `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`).join('')}`;
}

function renderRows(result, api) {
  const { escape, icon, yen } = api;
  if (result.error) return `<p class="np-history-message" role="alert">${escape(result.error)}</p>`;
  const dateHeading = result.tableId ? '営業日・使用開始' : '営業日';
  const rows = result.rows.map((row) => {
    const {status,id,number,date,time:clock,room,customer,guests,methods:kinds,total} = row;
    const restore = status === 'void' && api.role === 'admin' && date === api.currentOpenDate;
    const detail = status === 'void' ? restore
      ? `<button type="button" class="np-history-link" data-action="reopen-ticket" data-id="${escape(id)}">No. ${escape(number)} を復元</button>`
      : `<strong>No. ${escape(number)}</strong>`
      : `<button class="np-history-link" type="button" data-action="${status === 'cancelled' ? 'cancelled-receipt' : 'history-receipt'}"
          data-id="${escape(id)}" data-date="${escape(date)}" aria-label="${status === 'cancelled' ? '会計取消' : '会計内容'} No. ${escape(number)} ${escape(date)}">
          No. ${escape(number)} ${icon('chevron-right',15)}</button>`;
    return `<tr>
      <td data-label="${dateHeading}">${escape(date)} ${escape(clock)}</td>
      <td data-label="伝票">${detail}</td><td data-label="卓・人数">${escape(room || '—')}${Number.isFinite(guests) ? ` · ${guests}名` : ''}</td>
      <td data-label="顧客">${escape(customer || '—')}</td><td data-label="支払方法">${kinds.map((method) => methods[method]).join('・') || '—'}</td>
      <td data-label="状態"><span class="np-history-status${status === 'cancelled' || status === 'void' ? ' np-history-status-cancelled' : ''}">${statuses[status]}</span></td>
      <td data-label="税込金額" class="np-history-amount">${total == null ? '—' : yen(total)}</td>
    </tr>`;
  });
  return `<div class="np-history-summary"><p role="status"><strong>${result.rows.length}件</strong>表示
    <span>確定売上 ${yen(result.total)}（${result.count}組・${result.guests}名）</span>
    <span>客単価 ${result.averageSpend == null ? '—' : yen(result.averageSpend)}</span></p>
      <button type="button" class="btn btn-secondary" data-history-export${rows.length ? '' : ' disabled'}>CSVを出力</button></div>
    ${result.tableId && rows.length ? `<p class="np-history-note">金額と人数は伝票全体の値です。卓移動・連結で同じ伝票が別の卓の履歴にも表示されます。</p>` : ''}
    ${rows.length ? `<table class="np-history-table"><thead><tr>${[dateHeading,'伝票','卓・人数','顧客','支払方法','状態','税込金額'].map((label) => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
      : '<p class="np-history-message">条件に一致する伝票がありません。</p>'}`;
}

export function renderTicketHistory(state, api) {
  api = {...api,currentOpenDate:state.day.status === 'open' ? state.day.date : null};
  const filters = defaults(state,api);
  const { escape } = api;
  const tableOptions = [...state.tables, ...(state.archivedTables ?? [])].map((table,index) => {
    const details = [table.area,index >= state.tables.length ? '削除済み' : ''].filter(Boolean).join('・');
    return `<option value="${escape(table.id)}"${filters.tableId === table.id ? ' selected' : ''}>${escape(table.name + (details ? `（${details}）` : ''))}</option>`;
  }).join('');
  return `<section class="np-history" aria-label="伝票履歴">
    <form class="np-history-form" aria-label="伝票履歴を絞り込む">
      <label class="field"><span>開始日</span><input type="date" name="start" value="${escape(filters.start)}" required></label>
      <label class="field"><span>終了日</span><input type="date" name="end" value="${escape(filters.end)}" required></label>
      <label class="field"><span>卓</span><select name="tableId"><option value="">すべての卓</option>${tableOptions}</select></label>
      <fieldset class="choices"><legend>支払方法（複数可）</legend><div class="payment-filter">
        ${Object.entries(methods).map(([method,label])=>`<label class="inline-check"><input type="checkbox" name="payment"
          value="${method}"${filters.payment.includes(method) ? ' checked' : ''}>${label}</label>`).join('')}</div></fieldset>
      <label class="field"><span>状態</span><select name="status">${options(statuses,filters.status,'すべて')}</select></label>
      <label class="field np-history-query"><span>顧客名・卓・伝票番号</span><input type="search" name="query" maxlength="100" value="${escape(filters.query)}" placeholder="例　A-03"></label>
      <button type="submit" class="btn btn-primary">検索</button>
    </form>
    <div class="np-history-results">${renderRows(getTicketHistory(state,filters,api),api)}</div>
  </section>`;
}

export function buildTicketHistoryCsv(result) {
  return encodeCsv([['営業日',result.tableId ? '使用開始時刻' : '時刻','伝票番号','卓','人数','顧客','支払方法','状態','税込金額'],
    ...result.rows.map((row) => [row.date,row.time,row.number,row.room,row.guests,row.customer,
      row.methods.map((method) => methods[method]).join('・'),statuses[row.status],row.total])]);
}

export function bindTicketHistory(root, state, api) {
  api = {...api,currentOpenDate:state.day.status === 'open' ? state.day.date : null};
  const history = root.querySelector('.np-history');
  if (!history) return;
  const form = history.querySelector('form');
  let filters = defaults(state,api);
  let result;
  form.addEventListener('submit',(event) => {
    event.preventDefault();
    const data = new FormData(form);
    filters = {...Object.fromEntries(data),payment:data.getAll('payment')};
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
