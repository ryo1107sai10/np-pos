import { exportStoreConfiguration, parseStoreConfiguration, quote, summary } from '../docs/engine.mjs';

export const roles = new Set(['admin', 'manager', 'staff', 'cast', 'trainee']);
const staffCommands = ['seat', 'move', 'order', 'extend', 'deposit', 'settle', 'depart', 'serve'];
const managerCommands = [...staffCommands, 'open', 'close', 'discount', 'stockAdjust', 'cancelDeposit', 'cancelLine', 'void'];
const roleCommands = {
  staff: new Set(staffCommands),
  manager: new Set(managerCommands),
  admin: new Set([...managerCommands, 'saveLayout', 'importLayout', 'saveStoreSettings', 'importStoreConfiguration',
    'approveDiscount', 'rejectDiscount', 'saveControls', 'cancelSettlement', 'reopenTicket']),
};
const reasonCommands = new Set(['discount', 'cancelSettlement', 'reopenTicket', 'cancelLine']);
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

export function projectState(state, role, actorUid) {
  if (role === 'admin') return state;
  if (role !== 'manager' && role !== 'staff') return null;
  const next = structuredClone(state);
  delete next.auditLog;
  if (role === 'manager') {
    for (const ticket of allSnapshotTickets(next)) {
      if (!actorUid || ticket.seatedByUid !== actorUid) ticket.customer = '';
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
  next.movements = [];
  delete next.cancelledSettlements;
  for (const ticket of next.tickets) {
    ticket.customer = '';
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

function validPayments(records) {
  return uniqueRecords(records) && records.every((row) => paymentMethods.has(row.method) && nonnegative(row.amount));
}

function validTicket(ticket) {
  return ticketStatuses.has(ticket.status) && Array.isArray(ticket.tableIds)
    && uniqueRecords(ticket.lines) && ticket.lines.every((line) =>
      typeof line.name === 'string' && typeof line.menuId === 'string'
      && Number.isInteger(line.quantity) && line.quantity > 0
      && nonnegative(line.price) && nonnegative(line.total) && nonnegative(line.taxRate)
      && Array.isArray(line.castIds) && Array.isArray(line.stockUses)
      && (line.castIds.length === 0 || isRecord(line.commission)))
    && validPayments(ticket.deposits) && validPayments(ticket.payments)
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

export function validateSnapshot(state) {
  const message = 'このブラウザーの営業データを読み取れません。';
  requireCondition(isRecord(state) && isRecord(state.day) && ['open', 'closed'].includes(state.day.status)
    && typeof state.day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.day.date)
    && nonnegative(state.day.openingCash)
    && ['tables', 'tickets', 'stock', 'menu', 'cast', 'movements'].every((key) => uniqueRecords(state[key]))
    && Array.isArray(state.closedDays) && state.closedDays.every((day) => isRecord(day) && typeof day.date === 'string'
      && (day.ticketSnapshots === undefined || (uniqueRecords(day.ticketSnapshots) && day.ticketSnapshots.every(validTicket))))
    && (state.cancelledSettlements === undefined || (uniqueRecords(state.cancelledSettlements)
      && state.cancelledSettlements.every(validCancelledSettlement)))
    && validControls(state.controls)
    && Number.isSafeInteger(state.nextId) && state.nextId > 0
    && Number.isSafeInteger(state.nextTicket) && state.nextTicket > 0
    && state.tickets.every(validTicket)
    && state.stock.every((item) => [item.quantity, item.unitCost, item.value].every(nonnegative)),
  400, 'invalid-snapshot', message);

  try {
    parseStoreConfiguration(JSON.stringify(exportStoreConfiguration(state)));
    for (const ticket of state.tickets) quote(state, ticket.id);
    summary(state);
  } catch {
    throw new ApiError(400, 'invalid-snapshot', message);
  }
  const migrated = structuredClone(state);
  delete migrated.auditLog;
  for (const ticket of allSnapshotTickets(migrated)) {
    delete ticket.seatedByUid;
  }
  return migrated;
}
