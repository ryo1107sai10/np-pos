import { getAutoExtensionSettings, getTableAutoExtensionEnabled, isVisitAutoExtensionPaused } from './auto-extension.mjs';
import { depositGrossAmount, getCardFeeSettings } from './card-fee.mjs';
import { findSettledCustomerTicket } from './customers.mjs';
import { getStoreSettings } from './store-settings.mjs';
import { getReceivableBalance, getReceivableStatus } from './receivables.mjs';
import { cashMovementCategories, cashMovementKinds, getCashMovement } from './cash-ledger.mjs';
import { getPrintSettings, printDocumentKinds } from './print-domain.mjs';
import { getPayrollDraft, getPayrollRates, getPayrollSettings, getPayrollTemplateAssignment, getPayrollTemplates, isDailyPayCommand, isPayrollCommand } from './payroll.mjs';
import { getStaffLabor, isStaffLaborCommand } from './labor-workspace.mjs';
import { isCastAttendanceReview, linkedCastForActor } from './cast-self.mjs';
import { getCalculationSettings } from './calculation-settings.mjs';
import { getOrderLineDiscountAmount } from './order-line-discount.mjs';
import { getEmployeeProfile } from './payroll-records.mjs';
import { getCastDutyMode } from './cast-duty.mjs';

const ticketActions = new Set([
  'discount', 'approveDiscount', 'rejectDiscount', 'settle', 'cancelSettlement', 'reopenTicket',
  'cancelLine', 'void', 'deposit','editDeposit','cancelDeposit', 'extendOverdue',
  'seat', 'order', 'move', 'extend', 'serve', 'depart', 'editTicketLine', 'cancelTicketExtension',
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
  const previousCalculation = getCalculationSettings(before);
  const nextCalculation = getCalculationSettings(after);
  if (!sameValue(previousCalculation,nextCalculation)) {
    beforeInfo.calculationSettings = previousCalculation;
    afterInfo.calculationSettings = nextCalculation;
  }
  if ((before.bulkExtensionEnabled !== false) !== (after.bulkExtensionEnabled !== false)) {
    beforeInfo.bulkExtensionEnabled = before.bulkExtensionEnabled !== false;
    afterInfo.bulkExtensionEnabled = after.bulkExtensionEnabled !== false;
  }
  if (!Object.keys(beforeInfo).length) return null;
  return {
    target: target('settings', null, '店舗設定'), before: beforeInfo, after: afterInfo,
    reason: textReason(action.reason) || (action.type.startsWith('import') ? '設定ファイルの読み込み' : '店舗設定を更新'),
  };
}

function auditPayments(rows = [], isDeposit = false) {
  return rows.map(({method,amount,brandName,feeWaived,waivedFeeRate,cardFee,cardFeeRateBps,memo}) => ({
    method,amount,...(brandName && {brandName}),...(feeWaived && {feeWaived,waivedFeeRate}),
    ...(cardFee && (brandName || isDeposit) && {cardFee,cardFeeRateBps}),
    ...(cardFee && isDeposit && {grossAmount:depositGrossAmount({amount,cardFee})}),...(memo && {memo}),
  }));
}

function ticketValues(ticket) {
  const result = {
    status: ticket.status, tableIds: ticket.tableIds, discount: ticket.discount,
    deposits: auditPayments(ticket.deposits,true), payments: auditPayments(ticket.payments),
  };
  if (ticket.cashTender) result.cashTender = ticket.cashTender;
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

function auditPurchaseCash(state, id) {
  const payment = getCashMovement(state,id);
  if (!payment) return null;
  const {amount,destination,voidedAt} = payment;
  return {cashMovementId:payment.id,amount,destination,...(voidedAt != null && {voidedAt})};
}

function auditLine({id,name,quantity,price,total,castIds,castNames,cancelledAt,providedAt,serviceExcluded,taxRate,originalTaxRate,lineDiscount}) {
  return {id,name,quantity,price,amount:total,castNames:castNames ?? castIds,
    ...(cancelledAt && {cancelledAt}),...(providedAt && {providedAt}),
    ...(originalTaxRate !== undefined && {taxRate,originalTaxRate}),
    ...(lineDiscount && {lineDiscount:{kind:lineDiscount.kind,amount:getOrderLineDiscountAmount({total,lineDiscount}),
      ...(lineDiscount.kind === 'percent' && {lineDiscountRateBps:lineDiscount.value})}}),
    ...(serviceExcluded === true && {serviceExcluded:true})};
}

function auditTicket(before, after, action) {
  if (action.type === 'seat') {
    const current = after.tickets.at(-1);
    return { target:target('ticket',current.id,`伝票 No. ${current.number}`),before:null,
      after:{guests:current.guests,tableIds:current.tableIds,arrivedAt:current.createdAt,endsAt:current.endsAt,
        lines:current.lines.map(auditLine)},reason:'来店を登録' };
  }
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
  if (action.type === 'order' || action.type === 'extend') {
    newValues.lines = current.lines.slice(previous.lines.length).map((line,index) => ({
      ...auditLine(line),
      ...(action.type === 'order' && line.originalTaxRate !== undefined
        && {taxOverrideReason:textReason(action.items[index].taxOverrideReason)}),
      ...(action.type === 'order' && line.serviceExcluded === true
        && {serviceExclusionReason:textReason(action.items[index].serviceExclusionReason)}),
      ...(action.type === 'order' && line.lineDiscount
        && {lineDiscountReason:textReason(action.items[index].lineDiscount.reason)}),
    }));
    if (action.type === 'extend') {
      oldValues.endsAt = previous.endsAt;
      newValues.endsAt = current.endsAt;
    }
  }
  if (action.type === 'editTicketLine' || action.type === 'serve') {
    const oldLine = previous.lines.find(({id}) => id === action.lineId);
    const newLine = current.lines.find(({id}) => id === action.lineId);
    oldValues.line = auditLine(oldLine);
    newValues.line = auditLine(newLine);
    if (action.type === 'editTicketLine' && oldLine.taxRate !== newLine.taxRate) {
      oldValues.line.taxRate = oldLine.taxRate;
      newValues.line.taxRate = newLine.taxRate;
    }
    if (action.type === 'editTicketLine' && oldValues.line.serviceExcluded !== newValues.line.serviceExcluded) {
      oldValues.line.serviceExcluded = oldValues.line.serviceExcluded === true;
      newValues.line.serviceExcluded = newValues.line.serviceExcluded === true;
    }
    if (action.type === 'editTicketLine' && !sameValue(oldValues.line.lineDiscount,newValues.line.lineDiscount)) {
      oldValues.line.lineDiscount ??= null;
      newValues.line.lineDiscount ??= null;
      newValues.line.lineDiscountReason = textReason(action.lineDiscount?.reason ?? action.reason);
    }
  }
  if (action.type === 'cancelTicketExtension') {
    const reversed = current.lines.filter((line,index) => line.cancelledAt !== previous.lines[index].cancelledAt);
    const ids = new Set(reversed.map(({id})=>id));
    oldValues.lines = previous.lines.filter(({id})=>ids.has(id)).map(auditLine);
    newValues.lines = reversed.map(auditLine);
    oldValues.endsAt = previous.endsAt;
    newValues.endsAt = current.endsAt;
  }
  if (action.type === 'extendOverdue') {
    oldValues.endsAt = previous.endsAt;
    newValues.endsAt = current.endsAt;
    newValues.extensionCount = action.expectedCount;
    newValues.extensionPlan = current.lines[previous.lines.length].name;
    if (action.plans !== undefined) newValues.lines = current.lines.slice(previous.lines.length).map(auditLine);
    reason = '超過時間の延長を一括登録';
  }
  const stock = auditMovements(before, after);
  if (stock.length) newValues.stockMovements = stock;
  return {
    action: auditAction, target: target('ticket', current.id, `伝票 No. ${current.number}`),
    before: oldValues, after: newValues, reason: reason || {
      settle: '会計を確定', deposit: '前受金を登録', cancelDeposit: '前受金を取り消し', void: '伝票を取り消し',
      order:'注文を登録',move:'使用卓を変更',extend:'延長を登録',serve:'提供済みに変更',depart:'退店を登録',
    }[action.type] || '',
  };
}

function auditTicketDetails(before, after, action) {
  const previous = before.tickets.find(({ id }) => id === action.ticketId);
  const current = after.tickets.find(({ id }) => id === action.ticketId);
  if (!previous || !current) return null;
  if (action.type === 'adjustPersonalSales') {
    const { id, castName, salesBefore, salesAfter, amount, reason } = current.personalSalesAdjustments.at(-1);
    return { target:target('ticket',current.id,`伝票 No. ${current.number}`),
      before:{castName,personalSales:salesBefore},
      after:{castName,personalSales:salesAfter,adjustmentAmount:amount,adjustmentId:id}, reason };
  }
  if (action.type === 'adjustTicketGuests') {
    return { target:target('ticket',current.id,`伝票 No. ${current.number}`),
      before:{guests:previous.guests,admittedGuests:previous.admittedGuests ?? previous.guests},
      after:{guests:current.guests,admittedGuests:current.admittedGuests,guestChangeMode:action.mode}, reason:textReason(action.reason) };
  }
  if (action.type === 'adjustTicketEnd' && action.startsAt !== undefined) {
    const beforeTimes = {startsAt:previous.setStartedAt ?? previous.createdAt,endsAt:previous.endsAt};
    const afterTimes = {startsAt:current.setStartedAt ?? current.createdAt,endsAt:current.endsAt};
    return sameValue(beforeTimes,afterTimes) ? null : {target:target('ticket',current.id,`伝票 No. ${current.number}`),
      before:beforeTimes,after:afterTimes,reason:textReason(action.reason)};
  }
  const memo = action.type === 'saveTicketNote';
  const key = memo ? 'note' : 'endsAt';
  const oldValue = previous[key] ?? null;
  const newValue = current[key] ?? null;
  if (oldValue === newValue) return null;
  return { target:target('ticket',current.id,`伝票 No. ${current.number}`), before:{[key]:oldValue}, after:{[key]:newValue},
    reason:memo ? (newValue ? '伝票メモを保存' : '伝票メモを解除') : textReason(action.reason) };
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
    'creditLimit', 'bottleKeeps','email','receiptRecipient','daysOff','tags','photo','anniversaries']
    .filter((key) => !sameValue(oldCustomer?.[key], newCustomer[key]));
  if (!changedFields.length) return null;
  const auditFields = ['name', 'castId', 'flagged', 'creditEnabled', 'creditLimit'].filter((key) => changedFields.includes(key));
  const auditProfile = (customer) => customer
    ? Object.fromEntries(auditFields.map((key) => [key, customer[key] ?? null])) : { present: false };
  return { action: 'saveCustomer', target: target('customer', newCustomer.id, newCustomer.name),
    before: auditProfile(oldCustomer), after: { ...auditProfile(newCustomer), changedFields },
    reason: oldCustomer ? '顧客情報を更新' : '顧客を登録' };
}

function auditTicketCustomer(before, after, action) {
  const { ticketId } = action;
  const correction = action.type === 'correctSettledTicketCustomer';
  const findVisit = (state) => correction ? findSettledCustomerTicket(state, ticketId)
    : { ticket: state.tickets.find(({ id }) => id === ticketId) };
  const previous = findVisit(before)?.ticket;
  const { ticket: current, date } = findVisit(after) ?? {};
  if (!previous || !current) return null;
  const customerLink = (ticket) => ({
    customerId: ticket.customerId ?? null,
    customerName: typeof ticket.customer === 'string' ? ticket.customer || null : null,
  });
  const oldLink = customerLink(previous);
  const newLink = customerLink(current);
  if (sameValue(oldLink, newLink)) return null;
  const entry = { target: target('ticket', current.id, `伝票 No. ${current.number}`), before: oldLink, after: newLink };
  if (correction) {
    const loan = before.receivables?.find((row) => row.ticketId === ticketId && row.cancelledAt == null);
    const updatedLoan = loan && after.receivables.find(({ id }) => id === loan.id);
    if (updatedLoan && updatedLoan.customerId !== loan.customerId) {
      const receivableDetails = (row) => ({ id: row.id, customerId: row.customerId, balance: getReceivableBalance(row) });
      oldLink.receivable = receivableDetails(loan);
      newLink.receivable = receivableDetails(updatedLoan);
    }
    return { ...entry, businessDate: date, reason: textReason(action.reason) };
  }
  const reason = !newLink.customerId ? '顧客のひもづけを解除'
    : oldLink.customerId || oldLink.customerName ? '顧客のひもづけを変更' : '顧客をひもづけ';
  return { ...entry, reason };
}

function auditPaymentCorrection(before, after, action) {
  const { ticketId } = action;
  const original = findSettledCustomerTicket(before, ticketId);
  const corrected = findSettledCustomerTicket(after, ticketId);
  if (!original || !corrected) return null;
  const { ticket, date } = corrected;
  const activeReceivable = (state) => state.receivables?.find((row) => row.ticketId === ticketId && row.cancelledAt == null);
  const oldReceivable = activeReceivable(before);
  const newReceivable = activeReceivable(after) ?? (oldReceivable && after.receivables?.find(({ id }) => id === oldReceivable.id));
  const values = (state, visit, loan) => {
    const { total, cardFee } = visit.settlement ?? ticket.settlement;
    const result = { total, payments: auditPayments(visit.payments) };
    if (visit.cashTender) result.cashTender = visit.cashTender;
    if (cardFee) result.cardFee = cardFee;
    if (oldReceivable || newReceivable) {
      result.receivable = loan ? {
        amount: loan.amount, balance: getReceivableBalance(loan),
        collected: loan.collections.reduce((sum, row) => sum + row.amount, 0),
        dueDate: loan.dueDate, status: getReceivableStatus(loan, state.day.date),
        ...(loan.creditOverride ? { creditOverride: loan.creditOverride } : {}),
      } : null;
    }
    const report = state.closedDays.find((day) => day.date === date);
    if (report) {
      const { expectedCash, actualCash, discrepancy } = report;
      Object.assign(result, { expectedCash, actualCash, discrepancy });
    }
    return result;
  };
  const oldValues = values(before, original.ticket, oldReceivable);
  const newValues = values(after, ticket, newReceivable);
  if (sameValue(oldValues, newValues)) return null;
  return {
    businessDate: date, target: target('ticket', ticket.id, `伝票 No. ${ticket.number}`),
    before: oldValues, after: newValues, reason: textReason(action.reason),
  };
}

function auditPayroll(before, after, action) {
  if (action.type === 'savePayrollVariables') {
    const previous = before.payroll?.variables ?? [];
    const next = after.payroll.variables;
    return sameValue(previous,next) ? null : {target:target('payroll',action.castId,'給与の個人別変数'),
      before:previous,after:next,reason:'給与計算に使う個人別変数を更新'};
  }
  if (action.type === 'saveEmployeeProfile') {
    const previous = getEmployeeProfile(before,action.castId);
    const next = getEmployeeProfile(after,action.castId);
    const updatedFields = Object.keys(next).filter((key)=>key !== 'castId' && next[key] !== (previous?.[key] ?? ''));
    return updatedFields.length ? {target:target('employee',action.castId,'従業員台帳'),before:null,after:{updatedFields},
      reason:'従業員台帳を更新'} : null;
  }
  if (action.type === 'saveAttendanceItems') {
    const previous = before.attendanceItems ?? [];
    const next = after.attendanceItems ?? [];
    return sameValue(previous,next) ? null : {target:target('settings',null,'勤怠項目'),before:previous,after:next,reason:'勤怠項目を更新'};
  }
  if (isDailyPayCommand(action.type)) {
    const rows = after.payroll.dailyPays;
    const next = action.type === 'requestDailyPay' ? rows.at(-1) : rows.find(({id}) => id === action.dailyPayId);
    const previous = before.payroll?.dailyPays?.find(({id}) => id === next.id) ?? null;
    const labels = { requested:'日払いを申請', approved:'日払いを承認', rejected:'日払いを却下', paid:'日払いを支給' };
    return { target:target('daily-pay',next.id,`${next.month} ${next.castName}`), before:previous, after:next,
      reason:textReason(action.reason) || labels[next.status] };
  }
  if (action.type === 'savePayrollSettings') {
    const previous = getPayrollSettings(before);
    const next = getPayrollSettings(after);
    if (!sameValue(previous,next)) return { target:target('settings',null,'給与設定'), before:previous, after:next, reason:'給与設定を更新' };
    return null;
  }
  if (action.type === 'savePayrollTemplate' || action.type === 'removePayrollTemplate') {
    const templateId = action.templateId ?? getPayrollTemplates(after).at(-1)?.id;
    const previous = getPayrollTemplates(before).find(({id}) => id === templateId) ?? null;
    const next = getPayrollTemplates(after).find(({id}) => id === templateId) ?? null;
    return sameValue(previous,next) ? null : { target:target('settings',templateId,(next ?? previous).name),before:previous,after:next,
      reason:next ? '給与テンプレートを保存' : '給与テンプレートを削除' };
  }
  const person = [...after.cast, ...(after.archivedCast ?? [])].find(({id}) => id === action.castId);
  if (action.type === 'assignPayrollTemplate') {
    const view = (state) => {
      const templateId = getPayrollTemplateAssignment(state,action.castId);
      return { template:getPayrollTemplates(state).find(({id}) => id === templateId)?.name ?? '店舗共通' };
    };
    const previous = view(before);
    const next = view(after);
    return sameValue(previous,next) ? null : { target:target('payroll',action.castId,person.name),before:previous,after:next,
      reason:'給与テンプレートの割り当てを変更' };
  }
  if (action.type === 'savePayrollRate') {
    const rate = (state) => getPayrollRates(state,action.castId).find(({effectiveDate}) => effectiveDate === action.effectiveDate) ?? null;
    const previous = rate(before);
    const next = rate(after);
    if (!sameValue(previous,next)) return { target:target('payroll',action.castId,`${person.name}の時給`), before:previous, after:next, reason:'適用開始日付きの時給を保存' };
    return null;
  }
  const view = (state) => {
    const record = getPayrollDraft(state,action.month,action.castId);
    if (!record) return null;
    const { status, work, allowances, deductions, manualAdvance, snapshot } = record;
    return { status, work, allowances, deductions, manualAdvance, ...(snapshot ? { net:snapshot.net } : {}) };
  };
  const previous = view(before);
  const next = view(after);
  return sameValue(previous,next) ? null : { target:target('payroll',action.castId,`${action.month} ${person.name}`),
    before:previous, after:next, reason:action.type === 'finalizePayroll' ? '給与を確定' : '給与の下書きを保存' };
}

function auditStaffLabor(before,after,action) {
  const previous = getStaffLabor(before);
  const current = getStaffLabor(after);
  if (action.type === 'saveStaffPerson') {
    const old = previous.people.find(({id})=>id === action.personId);
    const next = current.people.find(({id})=>id === (action.personId ?? current.people.at(-1)?.id));
    return !sameValue(old,next) && {target:target('payroll',next.id,next.name),before:old ?? null,after:next,reason:'勤務者台帳を更新'};
  }
  if (action.type === 'saveStaffRate') {
    const rate = ({personId,effectiveDate})=>personId === action.personId && effectiveDate === action.effectiveDate;
    const old = previous.rates.find(rate);
    const next = current.rates.find(rate);
    const name = current.people.find(({id})=>id === action.personId).name;
    return !sameValue(old,next) && {businessDate:next.effectiveDate,target:target('payroll',next.personId,`${name}の時給`),
      before:old ?? null,after:next,reason:'適用開始日付きの時給を保存'};
  }
  const old = previous.attendance.find(({id})=>id === action.attendanceId);
  const next = action.attendanceId ? current.attendance.find(({id})=>id === action.attendanceId) : current.attendance.at(-1);
  return !sameValue(old,next) && {businessDate:next.date,target:target('attendance',next.id,next.personName),
    before:old ?? null,after:next,reason:textReason(action.reason)};
}

export function buildOperationAudit(before, after, action, at, actor) {
  let details;
  if (ticketActions.has(action.type)) {
    details = auditTicket(before, after, action);
  } else if (['saveTicketNote','adjustTicketEnd','adjustTicketGuests','adjustPersonalSales'].includes(action.type)) {
    details = auditTicketDetails(before, after, action);
  } else if (settingActions.has(action.type)) {
    details = auditSettings(before, after, action);
  } else if (customerActions.has(action.type)) {
    details = auditCustomers(before, after, action);
  } else if (action.type === 'setTicketCustomer' || action.type === 'correctSettledTicketCustomer') {
    details = auditTicketCustomer(before, after, action);
  } else if (action.type === 'setTicketCompanion' || action.type === 'correctSettledTicketCompanion') {
    const find = (state) => action.type === 'correctSettledTicketCompanion' ? findSettledCustomerTicket(state,action.ticketId)
      : {ticket:state.tickets.find(({id})=>id === action.ticketId),date:state.day.date};
    const {ticket:previous} = find(before);
    const {ticket:next,date} = find(after);
    const reason = action.type === 'correctSettledTicketCompanion' ? textReason(action.reason)
      : action.mode === 'add' ? '同席者を追加' : '同席者を解除';
    details = {businessDate:date,target:target('ticket',next.id,`伝票 No. ${next.number}`),reason,
      before:{companionCustomerIds:previous.companionCustomerIds ?? []},after:{companionCustomerIds:next.companionCustomerIds ?? []}};
  } else if (action.type === 'correctSettledTicketPayments') {
    details = auditPaymentCorrection(before, after, action);
  } else if (action.type === 'correctSettledContents') {
    const old = findSettledCustomerTicket(before,action.ticketId);
    const current = findSettledCustomerTicket(after,action.ticketId);
    const oldLine = old.ticket.lines.find(({id})=>id === action.lineId);
    const newLine = current.ticket.lines.find(({id})=>id === action.lineId);
    details = {businessDate:old.date,target:target('ticket',action.ticketId,`伝票 No. ${old.ticket.number}`),
      before:{...ticketValues(old.ticket),...(oldLine && {line:auditLine(oldLine)})},
      after:{...ticketValues(current.ticket),...(newLine && {line:auditLine(newLine)}),stockMovements:auditMovements(before,after)},
      reason:textReason(action.reason)};
  } else if (isPayrollCommand(action.type) || action.type === 'castRequestDailyPay') {
    details = auditPayroll(before, after, action.type === 'castRequestDailyPay' ? {...action,type:'requestDailyPay'} : action);
  } else if (isStaffLaborCommand(action.type)) {
    details = auditStaffLabor(before,after,action);
  } else if (action.type === 'saveShift' || action.type === 'removeShift' || action.type === 'castRequestShift') {
    const previous = before.shifts?.find(({id}) => id === action.shiftId);
    const current = after.shifts?.find(({id}) => previous ? id === previous.id : !before.shifts?.some((entry) => entry.id === id));
    const shift = current ?? previous;
    if (shift && !sameValue(previous,current)) {
      const person = [...after.cast,...(after.archivedCast ?? [])].find(({id}) => id === shift.castId);
      details = {businessDate:shift.date,target:target('shift',shift.id,person?.name ?? shift.castId),
        before:previous ?? null,after:current ?? null,reason:action.type === 'removeShift' ? 'シフトの削除' : 'シフトの登録・更新'};
    }
  } else if (action.type === 'bindCastAccount') {
    const previous = before.castAccounts?.find(({uid}) => uid === action.memberUid) ?? null;
    const current = after.castAccounts?.find(({uid}) => uid === action.memberUid) ?? null;
    if (!sameValue(previous,current)) details = {target:target('cast-account',action.memberUid,'キャストアカウント'),
      before:previous,after:current,reason:current ? 'アカウントのひもづけ' : 'アカウントのひもづけ解除'};
  } else if (action.type === 'saveManagedAttendance') {
    const previous = before.castAttendance?.find(({id})=>id === action.attendanceId) ?? null;
    const current = after.castAttendance.at(-1);
    const cast = [...after.cast,...(after.archivedCast ?? [])].find(({id})=>id===current.castId);
    details = {businessDate:current.date,target:target('attendance',current.id,cast?.name ?? current.castId),
      before:previous,after:current,reason:current.reviewReason};
  } else if (['castClockIn','castClockOut'].includes(action.type) || isCastAttendanceReview(action.type)) {
    const person = linkedCastForActor(before,actor.id);
    const previous = (before.castAttendance ?? []).find((row) => action.attendanceId ? row.id === action.attendanceId
      : row.castId === person?.id && row.status === 'open');
    const current = (after.castAttendance ?? []).find((row) => previous ? row.id === previous.id
      : row.castId === person?.id && row.status === 'open');
    if (current && !sameValue(previous,current)) {
      const cast = [...after.cast,...(after.archivedCast ?? [])].find(({id}) => id === current.castId);
      details = {businessDate:current.date,target:target('attendance',current.id,cast?.name ?? current.castId),
        before:previous ?? null,after:current,reason:textReason(action.reason) || ({open:'出勤打刻',pending:'退勤打刻',approved:'勤怠を承認'})[current.status]};
    }
  } else if (action.type === 'saveInitialSetSchedule') {
    const previous = before.initialSetSchedule ?? [];
    const current = after.initialSetSchedule ?? [];
    if (!sameValue(previous,current)) details = {target:target('settings',null,'時間帯別セット'),
      before:previous,after:current,reason:'初回セットを提案する時間帯を更新'};
  } else if (action.type === 'saveRolePolicy') {
    const previous = before.rolePolicy ?? {};
    const current = after.rolePolicy;
    if (!sameValue(previous,current)) details = {target:target('settings',null,'役職・権限'),
      before:previous,after:current,reason:'役職名と利用できる機能を更新'};
  } else if (action.type === 'saveCashAccounts') {
    const previous = before.cashAccounts ?? [];
    const current = after.cashAccounts;
    if (!sameValue(previous,current)) details = {target:target('settings',null,'金庫・出金先'),
      before:previous,after:current,reason:'金庫と出金先を更新'};
  } else if (action.type === 'saveAccountingCsv') {
    const previous = before.accountingCsv?.[action.mode] ?? null;
    const current = after.accountingCsv[action.mode];
    if (!sameValue(previous,current)) details = {target:target('settings',null,'会計CSV設定'),
      before:previous,after:current,reason:'会計CSVの列と文字コードを更新'};
  } else if (action.type === 'saveCalculationSettings') {
    const previous = getCalculationSettings(before);
    const current = getCalculationSettings(after);
    if (!sameValue(previous,current)) details = {target:target('settings',null,'税とサービス料'),
      before:previous,after:current,reason:'新規来店の会計計算設定を更新'};
  } else if (action.type === 'stockAdjust' || action.type === 'recordStockOperation') {
    const previous = before.stock.find(({ id }) => id === action.stockId);
    const current = after.stock.find(({ id }) => id === action.stockId);
    const paymentId = action.voidPurchaseCash?.id ?? after.movements[0]?.cashMovementId;
    const cashBefore = auditPurchaseCash(before,paymentId);
    const cashAfter = auditPurchaseCash(after,paymentId);
    details = {
      businessDate: after.movements[0]?.date ?? after.day.date,
      target: target('stock', current.id, current.name),
      before: { quantity: previous.quantity, value: previous.value, ...(cashBefore && {cashPayment:cashBefore}) },
      after: { quantity: current.quantity, value: current.value, stockMovements: auditMovements(before, after),
        ...(action.type === 'recordStockOperation' && { kind: action.kind }),
        ...(action.type === 'recordStockOperation' && action.kind === 'purchase' && { unitCost: action.unitCost }),
        ...(cashAfter && {cashPayment:cashAfter}) },
      reason: textReason(action.reason),
    };
  } else if (action.type === 'saveControls') {
    const previous = before.controls?.managerDiscountRateBps ?? 1_000;
    const current = after.controls.managerDiscountRateBps;
    const registerBefore = before.controls?.register ?? null;
    const registerAfter = after.controls?.register ?? null;
    const castDutyBefore = getCastDutyMode(before);
    const castDutyAfter = getCastDutyMode(after);
    const castDutyChanged = castDutyBefore !== castDutyAfter;
    if (previous !== current || !sameValue(registerBefore,registerAfter) || castDutyChanged) {
      details = {
        target: target('settings', null, '営業の運用設定'),
        before: { managerDiscountRateBps: previous,...(registerBefore && {register:registerBefore}),...(castDutyChanged && {castDutyMode:castDutyBefore}) },
        after: { managerDiscountRateBps: current,...(registerAfter && {register:registerAfter}),...(castDutyChanged && {castDutyMode:castDutyAfter}) },
        reason: '営業・レジ運用の設定を更新',
      };
    }
  } else if (action.type === 'saveAutoExtensionSettings' || action.type === 'saveCardFeeSettings') {
    const auto = action.type === 'saveAutoExtensionSettings';
    const settings = auto ? getAutoExtensionSettings : getCardFeeSettings;
    const previous = {...settings(before),...(auto && action.bulkExtensionEnabled !== undefined
      && {bulkExtensionEnabled:before.bulkExtensionEnabled !== false})};
    const current = {...settings(after),...(auto && action.bulkExtensionEnabled !== undefined
      && {bulkExtensionEnabled:after.bulkExtensionEnabled !== false})};
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
  } else if (action.type === 'resumeVisitAutoExtension') {
    const previous = before.tickets.find(({id}) => id === action.ticketId);
    const current = after.tickets.find(({id}) => id === action.ticketId);
    if (isVisitAutoExtensionPaused(previous) && !isVisitAutoExtensionPaused(current)) {
      details = { target:target('ticket',current.id,`伝票 No. ${current.number}`),
        before:{paused:true,source:previous.autoExtensionPauseSource},
        after:{paused:false}, reason:'今回の来店の自動延長を再開' };
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
  } else if (['editCashMovement','voidCashMovement'].includes(action.type)) {
    const row = (state) => state.cashMovements?.find(({id}) => id === action.movementId)
      ?? state.closedDays.flatMap((day) => day.cashMovements ?? []).find(({id}) => id === action.movementId);
    const previous = row(before);
    const current = row(after);
    if (!sameValue(previous,current)) details = {businessDate:previous.date,target:target('cashMovement',previous.id,'入出金'),
      before:previous,after:current,reason:textReason(action.correctionReason)};
  } else if (action.type === 'correctRegisterCount') {
    const row = (state) => {
      const {actualCash,discrepancy,cashDenominations} = state.closedDays.find(({date}) => date === action.date);
      return {actualCash,discrepancy,cashDenominations};
    };
    details = {businessDate:action.date,target:target('day',action.date,'閉店時のレジ照合'),before:row(before),after:row(after),reason:textReason(action.reason)};
  } else if (action.type === 'recordCashMovement') {
    const { id, kind, category, amount, reason, destination, cashAccountId } = after.cashMovements.at(-1);
    const label = cashMovementKinds[kind];
    details = {
      target: target('cashMovement', id, label),
      before: null,
      after: { kind: label, category: cashMovementCategories[kind][category], amount, destination, ...(cashAccountId && {cashAccountId}) },
      reason,
    };
  } else if (action.type === 'close') {
    const { date, expectedCash, actualCash, discrepancy, reason, cashDenominations } = after.closedDays[0];
    details = {
      target: target('day', date, date),
      before: null,
      after: { expectedCash, actualCash, discrepancy, ...(cashDenominations ? {cashDenominations} : {}) },
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
