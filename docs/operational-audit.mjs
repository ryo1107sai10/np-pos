import { getStoreSettings } from './store-settings.mjs';

const ticketActions = new Set([
  'discount', 'approveDiscount', 'rejectDiscount', 'settle', 'cancelSettlement', 'reopenTicket',
  'cancelLine', 'void', 'deposit', 'cancelDeposit',
]);
const settingActions = new Set(['saveLayout', 'importLayout', 'saveStoreSettings', 'importStoreConfiguration']);

const sameValue = (first, second) => JSON.stringify(first) === JSON.stringify(second);

function textReason(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function target(kind, id, label) {
  return { kind, id, label };
}

function changedRecords(previous, latest) {
  const before = [];
  const after = [];
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const latestById = new Map(latest.map((row) => [row.id, row]));
  for (const id of new Set([...previousById.keys(), ...latestById.keys()])) {
    const oldRow = previousById.get(id);
    const newRow = latestById.get(id);
    if (sameValue(oldRow, newRow)) continue;
    if (!oldRow || !newRow) {
      before.push(oldRow ?? { id, name: newRow.name, present: false });
      after.push(newRow ?? { id, name: oldRow.name, present: false });
      continue;
    }
    const oldChanges = { id, name: oldRow.name };
    const newChanges = { id, name: newRow.name };
    for (const field of new Set([...Object.keys(oldRow), ...Object.keys(newRow)])) {
      if (field === 'name' || sameValue(oldRow[field], newRow[field])) continue;
      oldChanges[field] = oldRow[field] ?? null;
      newChanges[field] = newRow[field] ?? null;
    }
    before.push(oldChanges);
    after.push(newChanges);
  }
  return { before, after };
}

function auditSettings(before, after, action) {
  const beforeInfo = {};
  const afterInfo = {};
  const oldSettings = getStoreSettings(before);
  const newSettings = getStoreSettings(after);
  for (const key of ['menu', 'cast', 'stock']) {
    const changes = changedRecords(oldSettings[key], newSettings[key]);
    if (changes.before.length) {
      beforeInfo[key] = changes.before;
      afterInfo[key] = changes.after;
    }
  }
  const tableFields = ({ id, name, area, capacity, x, y }) => ({ id, name, area, capacity, x, y });
  const tableChanges = changedRecords(before.tables.map(tableFields), after.tables.map(tableFields));
  if (tableChanges.before.length) {
    beforeInfo.tables = tableChanges.before;
    afterInfo.tables = tableChanges.after;
  }
  if (!sameValue(before.layoutAreas, after.layoutAreas)) {
    beforeInfo.areas = before.layoutAreas ?? [...new Set(before.tables.map(({ area }) => area))];
    afterInfo.areas = after.layoutAreas ?? [...new Set(after.tables.map(({ area }) => area))];
  }
  if (!Object.keys(beforeInfo).length) return null;
  return {
    target: target('settings', null, '店舗設定'), before: beforeInfo, after: afterInfo,
    reason: textReason(action.reason) || (action.type.startsWith('import') ? '設定ファイルの読み込み' : '店舗設定を更新'),
  };
}

function auditPayments(rows = []) {
  return rows.map(({ method, amount }) => ({ method, amount }));
}

function ticketValues(ticket) {
  const result = {
    status: ticket.status, tableIds: ticket.tableIds, discount: ticket.discount,
    deposits: auditPayments(ticket.deposits), payments: auditPayments(ticket.payments),
  };
  if (ticket.settlement) {
    result.total = ticket.settlement.total;
    result.commission = (ticket.settlement.commission ?? []).map(({ castId, amount, points }) => ({ castId, amount, points }));
  }
  return result;
}

function auditMovements(before, after) {
  const count = after.movements.length - before.movements.length;
  return after.movements.slice(0, count).map(({ stockId, stockName, quantity, unit, cost }) => ({
    stockId, name: stockName, quantity, unit, cost,
  }));
}

function auditTicket(before, after, action) {
  const previous = before.tickets.find(({ id }) => id === action.ticketId);
  const current = after.tickets.find(({ id }) => id === action.ticketId);
  if (!previous || !current) return null;
  const oldValues = ticketValues(previous);
  const newValues = ticketValues(current);
  let auditAction = action.type;
  let reason = textReason(action.reason);
  if (['discount', 'approveDiscount', 'rejectDiscount'].includes(action.type)) {
    oldValues.discountRequest = previous.discountRequest ?? null;
    newValues.discountRequest = current.discountRequest ?? null;
    oldValues.discountDetails = previous.discountDetails ?? null;
    newValues.discountDetails = current.discountDetails ?? null;
    if (action.type === 'discount' && current.discountRequest) auditAction = 'discountRequest';
    reason ||= previous.discountRequest?.reason ?? '';
  }
  if (action.type === 'cancelLine') {
    const line = previous.lines.find(({ id }) => id === action.lineId);
    oldValues.line = { id: line.id, name: line.name, quantity: line.quantity, amount: line.total };
    newValues.line = { ...oldValues.line, cancelled: true };
  }
  const stock = auditMovements(before, after);
  if (stock.length) newValues.stockMovements = stock;
  return {
    action: auditAction, target: target('ticket', current.id, `伝票 No. ${current.number}`),
    before: oldValues, after: newValues, reason: reason || {
      settle: '会計を確定', deposit: '前受金を登録', cancelDeposit: '前受金を取り消し', void: '伝票を取り消し',
    }[action.type] || '',
  };
}

export function buildOperationAudit(before, after, action, at, actor) {
  let details;
  if (ticketActions.has(action.type)) {
    details = auditTicket(before, after, action);
  } else if (settingActions.has(action.type)) {
    details = auditSettings(before, after, action);
  } else if (action.type === 'stockAdjust') {
    const previous = before.stock.find(({ id }) => id === action.stockId);
    const current = after.stock.find(({ id }) => id === action.stockId);
    details = {
      target: target('stock', current.id, current.name),
      before: { quantity: previous.quantity, value: previous.value },
      after: { quantity: current.quantity, value: current.value, stockMovements: auditMovements(before, after) },
      reason: textReason(action.reason),
    };
  } else if (action.type === 'saveControls') {
    const previous = before.controls?.managerDiscountRateBps ?? 1_000;
    const current = after.controls.managerDiscountRateBps;
    if (previous !== current) {
      details = {
        target: target('settings', null, '値引き承認設定'),
        before: { managerDiscountRateBps: previous }, after: { managerDiscountRateBps: current },
        reason: 'マネージャーの値引き上限を更新',
      };
    }
  }
  if (!details) return null;
  return structuredClone({
    id: globalThis.crypto.randomUUID(), at, actor, action: action.type, businessDate: after.day.date, ...details,
  });
}
