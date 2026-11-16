import { getCashMovements, getDailyRecoveryRows, totalCashMovements } from './cash-ledger.mjs';
import { quote, summary } from './engine.mjs';
import { getDailyPayByDate } from './payroll.mjs';

const tenderMethods = ['cash', 'card', 'qr'];
const recoveryMethods = ['cash', 'card', 'bank'];
const dailyPayMethods = ['cash', 'bank'];
const settledStatuses = new Set(['paid', 'departed']);
const additiveFields = ['sales', 'guests', 'tickets', 'receivableSales', 'depositsApplied', 'cashIn', 'cashOut', 'expenses'];

export function isReportDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000')
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function getReportDates(state) {
  return [...new Set([state.day.date, ...state.closedDays.map(({date}) => date)])].filter(isReportDate).sort();
}

function selectedDates({mode, date, month, start, end}, latest) {
  if (mode === 'day') {
    const day = date || latest;
    return isReportDate(day) ? {start:day, end:day} : {error:'営業日を指定してください。'};
  }
  if (mode === 'month') {
    const firstDay = `${month ?? latest.slice(0, 7)}-01`;
    if (!isReportDate(firstDay)) return {error:'集計する月を指定してください。'};
    const lastDay = new Date(firstDay);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
    return {start:firstDay, end:lastDay.toISOString().slice(0, 10)};
  }
  if (mode === 'range' && isReportDate(start) && isReportDate(end) && start <= end) return {start, end};
  return {error:'開始日と終了日を、日付の順に指定してください。'};
}

function amount(value) {
  return Number.isFinite(value) ? value : 0;
}

function methodTotals(methods, source) {
  return Object.fromEntries(methods.map((method) => [method, amount(source?.[method])]));
}

function recoveryTotals(rows) {
  const totals = methodTotals(recoveryMethods);
  for (const {method, amount:value} of rows) {
    if (Object.hasOwn(totals, method)) totals[method] += value;
  }
  return totals;
}

function hasCompleteTickets(closed, tickets, dayState) {
  if (closed.tickets != null && closed.tickets !== tickets.length) return false;
  if (!Number.isFinite(closed.sales)) return Array.isArray(closed.ticketSnapshots);
  return tickets.reduce((total, ticket) => total + quote(dayState, ticket.id).total, 0) === closed.sales;
}

function reportDay(state, date, closed, dayPayByDate) {
  const isLatest = state.day.date === date;
  if (!closed && !isLatest) return null;
  const tickets = closed?.ticketSnapshots ?? (isLatest ? state.tickets : []);
  const settledTickets = tickets.filter(({status}) => settledStatuses.has(status));
  const dayState = closed ? {
    ...state,
    day:{status:'closed', date, openingCash:closed.openingCash, openedAt:closed.openedAt, closedAt:closed.closedAt,
      closingCash:closed.actualCash},
    tickets,
    recoveryTotalsForDay:undefined,
    recoveryRowsForDay:undefined,
  } : state;
  const ticketDataComplete = !closed || hasCompleteTickets(closed, settledTickets, dayState);
  const dailyPayTotals = methodTotals(dailyPayMethods,dayPayByDate?.[date]);
  if (!closed) return {date, current:{...summary(dayState),dailyPayTotals}, tickets, settledTickets, state:dayState, closed, legacy:false, ticketDataComplete};

  const fieldsFromTickets = ['sales', 'guests', 'tickets', 'payments', 'tenderPayments', 'depositsReceived',
    'depositsApplied', 'receivableSales'];
  const derived = ticketDataComplete && fieldsFromTickets.some((field) => closed[field] == null) ? summary(dayState) : null;
  const recoveryRows = closed.recoveryRows ?? (isLatest ? state.recoveryRowsForDay : undefined)
    ?? getDailyRecoveryRows(state, date);
  const cashMovements = closed.cashMovements ?? getCashMovements(state, date);
  const cash = totalCashMovements(cashMovements);
  const current = {
    ...closed,
    sales:amount(closed.sales ?? derived?.sales),
    guests:amount(closed.guests ?? derived?.guests),
    tickets:amount(closed.tickets ?? derived?.tickets),
    tenderPayments:closed.tenderPayments ?? derived?.tenderPayments ?? null,
    depositsReceived:closed.depositsReceived ?? derived?.depositsReceived ?? null,
    depositsApplied:closed.depositsApplied ?? derived?.depositsApplied ?? null,
    payments:methodTotals(tenderMethods, closed.payments ?? derived?.payments),
    receivableSales:amount(closed.receivableSales ?? derived?.receivableSales),
    recoveries:methodTotals(recoveryMethods, closed.recoveries ?? recoveryTotals(recoveryRows)),
    recoveryRows,
    cashIn:amount(closed.cashIn ?? cash.cashIn),
    cashOut:amount(closed.cashOut ?? cash.cashOut),
    expenses:amount(closed.expenses ?? cash.expenses),
    dailyPayTotals,
    cashMovements,
  };
  return {date, current, tickets, settledTickets, state:dayState, closed, legacy:!ticketDataComplete, ticketDataComplete};
}

export function getReportDay(state, date = state.day.date) {
  if (!isReportDate(date)) return null;
  return reportDay(state, date, state.closedDays.find((day) => day.date === date), getDailyPayByDate(state));
}

function aggregateDays(days) {
  const totals = {
    ...Object.fromEntries(additiveFields.map((field) => [field, 0])),
    payments:methodTotals(tenderMethods), tenderPayments:methodTotals(tenderMethods),
    depositsReceived:methodTotals(tenderMethods), recoveries:methodTotals(recoveryMethods),
    dailyPayTotals:methodTotals(dailyPayMethods),
    hasCombinedOnlyPayments:false,
  };
  for (const {current} of days) {
    for (const field of additiveFields) totals[field] += amount(current[field]);
    for (const field of ['payments', 'tenderPayments', 'depositsReceived', 'recoveries', 'dailyPayTotals']) {
      for (const method of Object.keys(totals[field])) totals[field][method] += amount(current[field]?.[method]);
    }
    if (!current.tenderPayments || !current.depositsReceived) totals.hasCombinedOnlyPayments = true;
  }
  return totals;
}

export function getReportPeriod(state, filters = {}) {
  const mode = filters.mode ?? 'day';
  const bounds = selectedDates({...filters, mode}, state.day.date);
  const {error, start = '', end = ''} = bounds;
  if (error) return {mode, start, end, days:[], totals:aggregateDays([]), valid:false, error};
  const closedByDate = new Map(state.closedDays.map((day) => [day.date, day]));
  const dayPayByDate = getDailyPayByDate(state);
  const days = getReportDates(state).filter((date) => date >= start && date <= end)
    .map((date) => reportDay(state, date, closedByDate.get(date), dayPayByDate));
  return {mode, start, end, days, totals:aggregateDays(days), valid:true, error:''};
}

export function getMonthlyReportSales(state, month = state.day.date.slice(0, 7), currentSummary) {
  const {start, end, error} = selectedDates({mode:'month', month}, state.day.date);
  if (error) return 0;
  const closedByDate = new Map(state.closedDays.map((day) => [day.date, day]));
  let sales = 0;
  for (const date of getReportDates(state)) {
    if (date < start || date > end) continue;
    const closed = closedByDate.get(date);
    if (closed) sales += Number.isFinite(closed.sales) ? closed.sales : reportDay(state, date, closed).current.sales;
    else sales += amount(currentSummary?.sales ?? summary(state).sales);
  }
  return sales;
}
