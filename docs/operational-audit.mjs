import { getAutoExtensionSettings, getTableAutoExtensionEnabled, isVisitAutoExtensionPaused } from './auto-extension.mjs';
import { getCardFeeSettings } from './card-fee.mjs';
import { getStoreSettings } from './store-settings.mjs';
import { getReceivableBalance } from './receivables.mjs';
import { cashMovementCategories, cashMovementKinds } from './cash-ledger.mjs';
import { getPrintSettings, printDocumentKinds } from './print-domain.mjs';

const ticketActions = new Set([
  'discount', 'approveDiscount', 'rejectDiscount', 'settle', 'cancelSettlement', 'reopenTicket',
  'cancelLine', 'void', 'deposit', 'cancelDeposit',
]);
const settingActions = new Set(['saveLayout', 'importLayout', 'saveStoreSettings', 'importStoreConfiguration']);
const customerActions = new Set(['saveCustomer', 'linkCustomer', 'mergeCustomers', 'importCustomers']);

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
    if (ticket.settlement.cardFee) {
      const {cardFee, cardFeeTax, cardFeeRateBps} = ticket.settlement;
      Object.assign(result,{cardFee,cardFeeTax,cardFeeRateBps});
    }
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
  if (action.type === 'settle' || action.type === 'cancelSettlement') {
    const oldReceivable = before.receivables?.find(({ ticketId, cancelledAt }) => ticketId === current.id && cancelledAt == null);
    const receivable = action.type === 'settle'
      ? after.receivables?.find(({ ticketId, cancelledAt }) => ticketId === current.id && cancelledAt == null)
      : after.receivables?.find(({ id }) => id === oldReceivable?.id);
    if (receivable) {
      const { id, dueDate, amount, cancelledAt, creditOverride } = receivable;
      if (oldReceivable) oldValues.receivable = { id, dueDate, amount, cancelledAt: oldReceivable.cancelledAt };
      newValues.receivable = { id, dueDate, amount, cancelledAt };
      if (creditOverride) newValues.receivable.creditOverride = creditOverride;
      if (action.type === 'settle' && creditOverride) reason = creditOverride.reason;
    }
  }
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

function auditCustomers(before, after, action) {
  const previous = before.customers ?? [];
  const latest = after.customers ?? [];
  if (action.type === 'importCustomers') {
    return { target: target('customers', null, '顧客台帳'), before: { count: previous.length },
      after: { count: latest.length }, reason: '顧客CSVを取り込み' };
  }
  if (action.type === 'mergeCustomers') {
    const source = previous.find(({ id }) => id === action.sourceId);
    const destination = latest.find(({ id }) => id === action.targetId);
    return { target: target('customer', destination.id, destination.name),
      before: { sourceId: source.id, sourceName: source.name }, after: { destinationId: destination.id },
      reason: textReason(action.reason) };
  }
  if (action.type === 'linkCustomer') {
    const customer = latest.find(({ id }) => id === action.customerId);
    return { target: target('customer', customer.id, customer.name), before: { ticketId: action.ticketId, customerId: null },
      after: { ticketId: action.ticketId, customerId: customer.id }, reason: '過去の伝票を顧客に紐づけ' };
  }
  const oldCustomer = previous.find(({ id }) => id === action.customerId);
  const newCustomer = oldCustomer ? latest.find(({ id }) => id === oldCustomer.id) : latest.at(-1);
  const changedFields = ['name', 'kana', 'phone', 'birthday', 'castId', 'memo', 'flagged', 'creditEnabled',
    'creditLimit', 'bottleKeeps'].filter((key) => !sameValue(oldCustomer?.[key], newCustomer[key]));
  if (!changedFields.length) return null;
  const auditFields = ['name', 'castId', 'flagged', 'creditEnabled', 'creditLimit'].filter((key) => changedFields.includes(key));
  const auditProfile = (customer) => customer
    ? Object.fromEntries(auditFields.map((key) => [key, customer[key] ?? null])) : { present: false };
  return { action: 'saveCustomer', target: target('customer', newCustomer.id, newCustomer.name),
    before: auditProfile(oldCustomer), after: { ...auditProfile(newCustomer), changedFields },
    reason: oldCustomer ? '顧客情報を更新' : '顧客を登録' };
}

export function buildOperationAudit(before, after, action, at, actor) {
  let details;
  if (ticketActions.has(action.type)) {
    details = auditTicket(before, after, action);
  } else if (settingActions.has(action.type)) {
    details = auditSettings(before, after, action);
  } else if (customerActions.has(action.type) || (action.type === 'seat' && action.newCustomer)) {
    details = auditCustomers(before, after, action);
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
  } else if (action.type === 'saveAutoExtensionSettings' || action.type === 'saveCardFeeSettings') {
    const auto = action.type === 'saveAutoExtensionSettings';
    const settings = auto ? getAutoExtensionSettings : getCardFeeSettings;
    const previous = settings(before);
    const current = settings(after);
    const label = auto ? '自動延長設定' : 'カード会計加算設定';
    if (!sameValue(previous,current)) {
      details = { target:target('settings',null,label), before:previous, after:current, reason:`${label}を更新` };
    }
  } else if (action.type === 'setTableAutoExtension') {
    const previous = getTableAutoExtensionEnabled(before,action.tableId);
    const current = getTableAutoExtensionEnabled(after,action.tableId);
    if (previous !== current) {
      const table = after.tables.find(({id}) => id === action.tableId);
      details = { target:target('table',table.id,table.name), before:{enabled:previous}, after:{enabled:current},
        reason:'卓の自動延長設定を更新' };
    }
  } else if (action.type === 'pauseVisitAutoExtension') {
    const previous = before.tickets.find(({id}) => id === action.ticketId);
    const current = after.tickets.find(({id}) => id === action.ticketId);
    if (!isVisitAutoExtensionPaused(previous) && isVisitAutoExtensionPaused(current)) {
      const source = current.autoExtensionPauseSource;
      details = { target:target('ticket',current.id,`伝票 No. ${current.number}`), before:{paused:false}, after:{paused:true,source},
        reason:source === 'checkout' ? '会計へ進むため、今回の来店の自動延長を停止' : '今回の来店の自動延長を停止' };
    }
  } else if (action.type === 'syncAutoExtensions') {
    const previousById = new Map(before.tickets.map((ticket) => [ticket.id,ticket]));
    const changed = after.tickets.flatMap((ticket) => {
      const previous = previousById.get(ticket.id);
      if (!previous || previous.endsAt === ticket.endsAt) return [];
      const orders = ticket.lines.slice(previous.lines.length).filter((line) => line.autoExtension).map((line) =>
        ({name:line.name, amount:line.total, quantity:line.quantity}));
      return [{id:ticket.id, number:ticket.number, beforeEnd:previous.endsAt, afterEnd:ticket.endsAt, orders}];
    });
    if (changed.length) {
      details = { target:target('day',after.day.date,'自動延長'), before:null,
        after:{tickets:changed}, reason:'自動延長の期限に到達' };
    }
  } else if (action.type === 'savePrintSettings') {
    const previous = getPrintSettings(before);
    const current = getPrintSettings(after);
    if (!sameValue(previous, current)) {
      details = {
        target: target('settings', null, '印刷設定'),
        before: previous,
        after: current,
        reason: '印刷設定を更新',
      };
    }
  } else if (action.type === 'issuePrintDocument') {
    const {date, ticketId, ticketNumber, kind, number} = after.printDocuments.at(-1);
    details = {
      businessDate: date,
      target: target('ticket', ticketId, `伝票 No. ${ticketNumber}`),
      before: null,
      after: {kind:printDocumentKinds[kind], issueNumber:number},
      reason: number > 1 ? '再発行' : '発行',
    };
  } else if (action.type === 'recordCashMovement') {
    const { id, kind, category, amount, reason, destination } = after.cashMovements.at(-1);
    const label = cashMovementKinds[kind];
    details = {
      target: target('cashMovement', id, label),
      before: null,
      after: { kind: label, category: cashMovementCategories[kind][category], amount, destination },
      reason,
    };
  } else if (action.type === 'close') {
    const { date, expectedCash, actualCash, discrepancy, reason } = after.closedDays[0];
    details = {
      target: target('day', date, date),
      before: null,
      after: { expectedCash, actualCash, discrepancy },
      reason,
    };
  } else if (action.type === 'recoverReceivable') {
    const previous = before.receivables.find(({ id }) => id === action.receivableId);
    const current = after.receivables.find(({ id }) => id === action.receivableId);
    details = {
      target: target('receivable', current.id, `売掛 No. ${current.ticketNumber}`),
      before: { balance: getReceivableBalance(previous) },
      after: { balance: getReceivableBalance(current), collection: current.collections.at(-1) },
      reason: '売掛を回収',
    };
  }
  if (!details) return null;
  return structuredClone({
    id: globalThis.crypto.randomUUID(), at, actor, action: action.type, businessDate: after.day.date, ...details,
  });
}
