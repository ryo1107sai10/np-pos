import { exportStoreConfiguration, parseStoreConfiguration, quote, summary } from '../docs/engine.mjs';
import { isAssignedCustomer } from '../docs/customers.mjs';
import { getRecoveryRows, isValidCashMovement } from '../docs/cash-ledger.mjs';
import { isValidPrintDocument, normalizePrintSettings } from '../docs/print-domain.mjs';

export const roles = new Set(['admin', 'manager', 'staff', 'cast', 'trainee']);
const staffCommands = ['seat', 'move', 'order', 'extend', 'deposit', 'settle', 'depart', 'serve', 'issuePrintDocument'];
const managerCommands = [...staffCommands, 'open', 'close', 'discount', 'stockAdjust', 'cancelDeposit', 'cancelLine', 'void',
  'saveCustomer', 'recoverReceivable', 'recordCashMovement'];
const roleCommands = {
  staff: new Set(staffCommands),
  manager: new Set(managerCommands),
  admin: new Set([...managerCommands, 'saveLayout', 'importLayout', 'saveStoreSettings', 'importStoreConfiguration',
    'approveDiscount', 'rejectDiscount', 'saveControls', 'cancelSettlement', 'reopenTicket',
    'mergeCustomers', 'linkCustomer', 'importCustomers', 'savePrintSettings']),
};
const reasonCommands = new Set(['discount', 'cancelSettlement', 'reopenTicket', 'cancelLine', 'recordCashMovement']);
const paymentMethods = new Set(['cash', 'card', 'qr']);
const ticketStatuses = new Set(['open', 'paid', 'departed', 'void', 'cancelled']);
const emptyCommission = { fixed: 0, rate: 0, points: 0 };

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireCondition(condition, status, code, message) {
  if (!condition) throw new ApiError(status, code, message);
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canOperate(role) {
  return Object.hasOwn(roleCommands, role);
}

export function verifyCommand(role, command) {
  requireCondition(isRecord(command) && typeof command.type === 'string', 400, 'invalid-command', '操作を確認してください。');
  requireCondition(canOperate(role) && roleCommands[role].has(command.type), 403, 'forbidden', 'この操作には権限が必要です。');
  if (reasonCommands.has(command.type)) {
    requireCondition(typeof command.reason === 'string' && command.reason.trim().length > 0,
      400, 'reason-required', '操作の理由を入力してください。');
  }
  if (command.type === 'order') {
    requireCondition(Array.isArray(command.items) && command.items.length <= 100 && command.items.every(isRecord),
      400, 'invalid-command', '注文内容を確認してください。');
  }
  if (command.type === 'settle') {
    requireCondition(Array.isArray(command.payments) && command.payments.length <= 10 && command.payments.every(isRecord),
      400, 'invalid-command', '支払内容を確認してください。');
    requireCondition(role !== 'staff' || command.payments.every(({ method }) => method !== 'receivable'),
      403, 'forbidden', '売掛での会計には管理者またはマネージャーの権限が必要です。');
  }
}

function acceptsCast(item, cast) {
  if (item.requiresCast) return true;
  return Object.values(item.commission ?? {}).some(Boolean)
    || cast.some((person) => person.enabled !== false && Object.values(person.commissionOverride ?? {}).some(Boolean));
}

function allSnapshotTickets(state) {
  return [...state.tickets, ...state.closedDays.flatMap((day) => day.ticketSnapshots ?? []),
    ...(state.cancelledSettlements ?? []).map(({ receipt }) => receipt)];
}

function recoveryRowsByDate(state) {
  const byDate = new Map();
  for (const row of getRecoveryRows(state)) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }
  return byDate;
}

function snapshotCashMovements(state) {
  return new Set([...(state.cashMovements ?? []), ...state.closedDays.flatMap((day) => day.cashMovements ?? [])]);
}

export function projectState(state, role, actorUid) {
  if (role === 'admin') return state;
  if (role !== 'manager' && role !== 'staff') return null;
  const next = structuredClone(state);
  delete next.auditLog;
  if (next.printDocuments) {
    next.printDocuments = next.printDocuments.filter(({ date }) => role === 'manager' || date === state.day.date)
      .map((document) => document.actor?.id === actorUid ? document : printDocumentMetadata(document));
  }
  const assigned = new Set(role === 'manager' ? (state.customers ?? [])
    .filter((customer) => isAssignedCustomer(state, customer, actorUid)).map(({id}) => id) : []);
  next.customers = (next.customers ?? []).map((customer) => {
    if (!assigned.has(customer.id)) return { id: customer.id, name: customer.name,
      ...(role === 'manager' ? {kana: customer.kana ?? ''} : {}), restricted: true };
    delete customer.createdByUid;
    return customer;
  });
  if (role === 'manager') {
    const recoveriesByDate = recoveryRowsByDate(state);
    next.recoveryTotalsForDay = summary(state).recoveries;
    next.recoveryRowsForDay = recoveriesByDate.get(state.day.date) ?? [];
    for (const day of next.closedDays) {
      day.recoveryRows ??= recoveriesByDate.get(day.date) ?? [];
    }
    for (const movement of snapshotCashMovements(next)) {
      if (movement.actor?.id !== actorUid) delete movement.actor?.id;
    }
    next.receivables = (next.receivables ?? []).filter((entry) => assigned.has(entry.customerId));
    for (const ticket of allSnapshotTickets(next)) {
      if (!assigned.has(ticket.customerId) && (!actorUid || ticket.seatedByUid !== actorUid)) {
        ticket.customer = '';
        delete ticket.customerId;
      }
      delete ticket.seatedByUid;
      for (const entry of [ticket.discountDetails, ticket.discountRequest]) {
        for (const field of ['actor', 'approvedBy']) {
          if (entry?.[field] && entry[field].id !== actorUid) delete entry[field];
        }
      }
    }
    return next;
  }
  next.closedDays = [];
  next.day.openingCash = 0;
  next.day.closingCash = null;
  next.movements = [];
  delete next.cancelledSettlements;
  delete next.receivables;
  delete next.recoveryTotalsForDay;
  delete next.recoveryRowsForDay;
  delete next.cashRecoveryRows;
  delete next.cashMovements;
  for (const ticket of next.tickets) {
    ticket.customer = '';
    delete ticket.customerId;
    delete ticket.seatedByUid;
    delete ticket.discountDetails;
    if (ticket.discountRequest) ticket.discountRequest = { id: ticket.discountRequest.id };
    for (const line of ticket.lines) {
      delete line.castCommissions;
      line.commission = emptyCommission;
      line.stockUses = [];
    }
    if (ticket.settlement) {
      ticket.settlement.commission = [];
      ticket.settlement.commissionDetails = [];
    }
  }
  for (const item of next.menu) {
    item.acceptsCast = acceptsCast(item, next.cast);
    delete item.commission;
  }
  for (const person of [...next.cast, ...(next.archivedCast ?? [])]) delete person.commissionOverride;
  for (const entry of next.stock) {
    entry.unitCost = 0;
    entry.defaultUnitCost = 0;
    entry.value = 0;
  }
  return next;
}

function uniqueRecords(records) {
  return Array.isArray(records) && records.every((entry) => isRecord(entry)
    && typeof entry.id === 'string' && entry.id.length > 0)
    && new Set(records.map(({ id }) => id)).size === records.length;
}

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validPayments(records, allowReceivable = false) {
  return uniqueRecords(records) && records.every((row) =>
    (paymentMethods.has(row.method) || (allowReceivable && row.method === 'receivable')) && nonnegative(row.amount));
}

function validTicket(ticket) {
  return ticketStatuses.has(ticket.status) && Array.isArray(ticket.tableIds)
    && (ticket.settlementRevision === undefined || (Number.isSafeInteger(ticket.settlementRevision) && ticket.settlementRevision >= 0))
    && uniqueRecords(ticket.lines) && ticket.lines.every((line) =>
      typeof line.name === 'string' && typeof line.menuId === 'string'
      && Number.isInteger(line.quantity) && line.quantity > 0
      && nonnegative(line.price) && nonnegative(line.total) && nonnegative(line.taxRate)
      && Array.isArray(line.castIds) && Array.isArray(line.stockUses)
      && (line.castIds.length === 0 || isRecord(line.commission)))
    && validPayments(ticket.deposits) && validPayments(ticket.payments, true)
    && nonnegative(ticket.discount) && nonnegative(ticket.serviceRate)
    && (ticket.settlement == null || (isRecord(ticket.settlement) && nonnegative(ticket.settlement.total)
      && Array.isArray(ticket.settlement.commission) && Array.isArray(ticket.settlement.taxBreakdown)));
}

function validCancelledSettlement(entry) {
  return typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && nonnegative(entry.at)
    && typeof entry.reason === 'string' && isRecord(entry.receipt) && validTicket(entry.receipt)
    && entry.ticketId === entry.receipt.id && entry.receipt.settlement != null;
}

function validControls(controls) {
  if (controls === undefined) return true;
  const limit = controls?.managerDiscountRateBps;
  return isRecord(controls) && (limit === undefined || (Number.isInteger(limit) && limit >= 0 && limit <= 10_000));
}

function isBusinessDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function optionalText(value, max) {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

function optionalDate(value) {
  return value === undefined || value === '' || isBusinessDate(value);
}

function validCustomer(customer) {
  return typeof customer.name === 'string' && customer.name.trim().length > 0 && customer.name.length <= 60
    && optionalText(customer.kana, 60) && optionalText(customer.phone, 32) && optionalText(customer.memo, 400)
    && optionalText(customer.castId, 100) && optionalDate(customer.birthday) && optionalDate(customer.firstVisitDate)
    && (customer.flagged === undefined || typeof customer.flagged === 'boolean')
    && (customer.creditEnabled === undefined || typeof customer.creditEnabled === 'boolean')
    && ((customer.creditLimit === undefined && !customer.creditEnabled) || (Number.isSafeInteger(customer.creditLimit)
      && customer.creditLimit >= 0 && customer.creditLimit <= 100_000_000))
    && (customer.bottleKeeps === undefined || (Array.isArray(customer.bottleKeeps) && customer.bottleKeeps.length <= 30
      && customer.bottleKeeps.every((bottle) => isRecord(bottle) && typeof bottle.name === 'string'
        && bottle.name.trim().length > 0 && bottle.name.length <= 60 && nonnegative(bottle.quantity) && bottle.quantity <= 1_000_000
        && optionalText(bottle.unit, 12) && optionalDate(bottle.expiresAt))));
}

function validReceivable(entry, customerIds) {
  const cancelled = entry.cancelledAt != null;
  return customerIds.has(entry.customerId) && typeof entry.ticketId === 'string'
    && Number.isSafeInteger(entry.ticketNumber) && entry.ticketNumber > 0 && nonnegative(entry.issuedAt)
    && Number.isSafeInteger(entry.amount) && entry.amount > 0
    && isBusinessDate(entry.date) && isBusinessDate(entry.dueDate) && entry.dueDate >= entry.date
    && (!cancelled || (nonnegative(entry.cancelledAt) && entry.cancelledAt >= entry.issuedAt))
    && uniqueRecords(entry.collections) && (!cancelled || entry.collections.length === 0)
    && entry.collections.every((payment) => Number.isSafeInteger(payment.amount) && payment.amount > 0
      && ['cash', 'card', 'bank'].includes(payment.method) && isBusinessDate(payment.date) && payment.date >= entry.date
      && nonnegative(payment.at) && payment.at >= entry.issuedAt)
    && entry.collections.reduce((total, payment) => total + payment.amount, 0) <= entry.amount;
}

function validReceivableLinks(state, receivables) {
  const active = receivables.filter((entry) => entry.cancelledAt == null);
  const byTicket = new Map(active.map((entry) => [entry.ticketId, entry]));
  if (byTicket.size !== active.length) return false;
  const visitById = new Map();
  for (const day of state.closedDays) {
    for (const ticket of day.ticketSnapshots ?? []) visitById.set(ticket.id, {ticket,date:day.date});
  }
  for (const ticket of state.tickets) visitById.set(ticket.id, {ticket,date:state.day.date});
  const matching = [...visitById.values()].every(({ticket,date}) => {
    const billed = ticket.payments.filter(({method}) => method === 'receivable').reduce((sum,entry) => sum + entry.amount,0);
    const row = byTicket.get(ticket.id);
    if (!billed) return !row;
    return row?.amount === billed && row.customerId === ticket.customerId && row.ticketNumber === ticket.number
      && row.date === date && ['paid','departed'].includes(ticket.status);
  });
  return matching && active.every(({ticketId}) => visitById.has(ticketId));
}

function validCashMovements(records, dates) {
  return uniqueRecords(records) && records.every((entry) => dates.has(entry.date) && isValidCashMovement(entry));
}

function validArchivedCash(day) {
  const totals = ['cashIn', 'cashOut', 'expenses', 'depositsApplied'];
  const methods = ['tenderPayments', 'depositsReceived'];
  const validTotal = (amount) => Number.isSafeInteger(amount) && amount >= 0;
  return (day.cashMovements === undefined || validCashMovements(day.cashMovements, new Set([day.date])))
    && totals.every((key) => day[key] === undefined || validTotal(day[key]))
    && methods.every((key) => day[key] === undefined || (isRecord(day[key])
      && ['cash', 'card', 'qr'].every((name) => validTotal(day[key][name]))));
}

function printDocumentMetadata({ id, ticketId, ticketNumber, date, kind, version, number, at }) {
  return { id, ticketId, ticketNumber, date, kind, version, number, at };
}

function validPrintDocuments(state, operatingDates) {
  const rows = state.printDocuments;
  if (rows === undefined) return true;
  if (!uniqueRecords(rows) || !rows.every((entry) => operatingDates.has(entry.date) && isValidPrintDocument(entry))) return false;
  const counts = new Map();
  for (const {ticketId, date, kind, version, number} of rows) {
    const key = JSON.stringify([ticketId, date, kind, version]);
    if ((counts.get(key) ?? 0) + 1 !== number) return false;
    counts.set(key, number);
  }
  return true;
}

export function validateSnapshot(state) {
  const message = 'このブラウザーの営業データを読み取れません。';
  requireCondition(isRecord(state) && isRecord(state.day) && ['open', 'closed'].includes(state.day.status)
    && typeof state.day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.day.date)
    && nonnegative(state.day.openingCash)
    && ['tables', 'tickets', 'stock', 'menu', 'cast', 'movements'].every((key) => uniqueRecords(state[key]))
    && Array.isArray(state.closedDays) && state.closedDays.every((day) => isRecord(day) && typeof day.date === 'string'
      && validArchivedCash(day)
      && (day.ticketSnapshots === undefined || (uniqueRecords(day.ticketSnapshots) && day.ticketSnapshots.every(validTicket))))
    && (state.cancelledSettlements === undefined || (uniqueRecords(state.cancelledSettlements)
      && state.cancelledSettlements.every(validCancelledSettlement)))
    && validControls(state.controls)
    && Number.isSafeInteger(state.nextId) && state.nextId > 0
    && Number.isSafeInteger(state.nextTicket) && state.nextTicket > 0
    && state.tickets.every(validTicket)
    && state.stock.every((item) => [item.quantity, item.unitCost, item.value].every(nonnegative)),
  400, 'invalid-snapshot', message);
  const customers = state.customers ?? [];
  const receivables = state.receivables ?? [];
  requireCondition(uniqueRecords(customers) && customers.every(validCustomer) && uniqueRecords(receivables),
    400, 'invalid-snapshot', message);
  const operatingDates = new Set([state.day.date, ...state.closedDays.map(({ date }) => date)]);
  requireCondition((state.cashMovements === undefined || validCashMovements(state.cashMovements, operatingDates))
    && validPrintDocuments(state, operatingDates), 400, 'invalid-snapshot', message);
  const customerIds = new Set(customers.map(({ id }) => id));
  requireCondition(receivables.every((entry) => validReceivable(entry, customerIds))
    && validReceivableLinks(state, receivables)
    && allSnapshotTickets(state).every((ticket) => ticket.customerId == null || customerIds.has(ticket.customerId)),
  400, 'invalid-snapshot', message);

  let normalizedPrintSettings;
  try {
    if (state.printSettings !== undefined) normalizedPrintSettings = normalizePrintSettings(state.printSettings);
    parseStoreConfiguration(JSON.stringify(exportStoreConfiguration(state)));
    for (const ticket of state.tickets) quote(state, ticket.id);
    summary({ ...state, recoveryTotalsForDay: undefined, recoveryRowsForDay: undefined });
  } catch {
    throw new ApiError(400, 'invalid-snapshot', message);
  }
  const migrated = structuredClone(state);
  delete migrated.auditLog;
  delete migrated.recoveryTotalsForDay;
  delete migrated.recoveryRowsForDay;
  delete migrated.cashRecoveryRows;
  const recoveriesByDate = recoveryRowsByDate(migrated);
  for (const day of migrated.closedDays) {
    if (day.recoveryRows !== undefined) day.recoveryRows = recoveriesByDate.get(day.date) ?? [];
  }
  for (const movement of snapshotCashMovements(migrated)) {
    const { label, role } = movement.actor;
    const source = 'ブラウザー移行 · ';
    movement.actor = { id: 'imported-browser', label: (label.startsWith(source) ? label : source + label).slice(0, 320), role };
  }
  if (normalizedPrintSettings !== undefined) migrated.printSettings = normalizedPrintSettings;
  if (migrated.printDocuments) {
    migrated.printDocuments = migrated.printDocuments.map((document) => {
      const {recipient, purpose, actor} = document;
      const source = 'ブラウザー移行 · ';
      const label = actor.label.startsWith(source) ? actor.label : source + actor.label;
      return {...printDocumentMetadata(document), recipient, purpose,
        actor:{id:'imported-browser',label:label.slice(0, 320),role:actor.role}};
    });
  }
  for (const customer of migrated.customers ?? []) delete customer.createdByUid;
  for (const ticket of allSnapshotTickets(migrated)) {
    delete ticket.seatedByUid;
  }
  return migrated;
}
