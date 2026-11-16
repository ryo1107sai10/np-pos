import { exportStoreConfiguration, maxOverdueExtensionCount, parseStoreConfiguration, quote, summary } from '../docs/engine.mjs';
import { isAutoExtensionPauseSource, isValidAutoExtensionSettings, isValidVisitAutoExtensionPause } from '../docs/auto-extension.mjs';
import { canWaivePaymentFee, depositGrossAmount, normalizeCardFeeSettings } from '../docs/card-fee.mjs';
import { getMonthlyReportSales } from '../docs/report-period.mjs';
import { customerWeekdays, isAssignedCustomer, isCustomerPhoto } from '../docs/customers.mjs';
import { getRecoveryRows, isValidCashMovement } from '../docs/cash-ledger.mjs';
import { getCashCountTotal, getCashPaymentAmount, isRegisterCashAmount } from '../docs/register-cash.mjs';
import { isValidPrintDocument, normalizePrintSettings } from '../docs/print-domain.mjs';
import { normalizeAccountingCsv } from '../docs/accounting-csv.mjs';
import { normalizeRegisterSettings } from '../docs/register-config.mjs';
import { validateShiftsSnapshot } from '../docs/shifts.mjs';
import { isValidInitialSetSchedule } from '../docs/set-schedule.mjs';
import { getDailyPayByDate, isDailyPayCommand, isPayrollCommand, isPayrollMonth, normalizeAttendanceSnapshot, normalizePayrollSnapshot } from '../docs/payroll.mjs';
import { getCastWorkspace, isCastSelfCommand, listCastAttendance, validateCastAttendanceSnapshot } from '../docs/cast-self.mjs';
import { isValidCalculationSettings, normalizeCalculationSettings, roundCalculationRate } from '../docs/calculation-settings.mjs';
import { normalizeAttendanceItems } from '../docs/payroll-records.mjs';
import { normalizeRolePolicy, roleAllowsCommand, roleGroupAllowed } from '../docs/role-policy.mjs';
import { normalizeCashAccounts, validCashAccountHistory } from '../docs/cash-accounts.mjs';

export const roles = new Set(['admin', 'manager', 'staff', 'cast', 'trainee']);
const staffCommands = ['seat', 'move', 'order', 'extend', 'extendOverdue', 'deposit', 'settle', 'depart', 'serve', 'issuePrintDocument', 'saveTicketNote',
  'syncAutoExtensions', 'setTableAutoExtension', 'pauseVisitAutoExtension', 'resumeVisitAutoExtension', 'setTicketCustomer','setTicketCompanion'];
const managerCommands = [...staffCommands, 'open', 'close', 'discount', 'stockAdjust', 'recordStockOperation', 'cancelDeposit', 'cancelLine', 'void', 'adjustTicketEnd',
  'saveCustomer', 'recoverReceivable', 'recordCashMovement', 'saveShift', 'removeShift', 'reviewCastAttendance', 'saveManagedAttendance', 'adjustTicketGuests',
  'editTicketLine', 'cancelTicketExtension', 'editCashMovement','voidCashMovement','editDeposit'];
const roleCommands = {
  cast: new Set(['castClockIn','castClockOut','castRequestShift','castRequestDailyPay']),
  staff: new Set(staffCommands),
  manager: new Set(managerCommands),
  admin: new Set([...managerCommands, 'saveLayout', 'importLayout', 'saveStoreSettings', 'importStoreConfiguration',
    'approveDiscount', 'rejectDiscount', 'saveControls', 'cancelSettlement', 'reopenTicket', 'correctSettledTicketPayments','correctSettledContents',
    'mergeCustomers', 'linkCustomer', 'correctSettledTicketCustomer', 'correctSettledTicketCompanion', 'importCustomers', 'savePrintSettings', 'saveAccountingCsv','correctRegisterCount',
    'saveAutoExtensionSettings', 'saveCardFeeSettings', 'savePayrollDraft', 'finalizePayroll', 'savePayrollRate', 'savePayrollSettings',
    'savePayrollTemplate', 'assignPayrollTemplate', 'removePayrollTemplate', 'saveEmployeeProfile', 'saveAttendanceItems','savePayrollVariables',
    'requestDailyPay', 'reviewDailyPay', 'payDailyPay', 'saveInitialSetSchedule', 'bindCastAccount', 'saveCalculationSettings','saveRolePolicy','saveCashAccounts']),
};
const reasonCommands = new Set(['discount', 'cancelSettlement', 'reopenTicket', 'cancelLine', 'recordCashMovement', 'recordStockOperation',
  'correctSettledTicketCustomer', 'correctSettledTicketCompanion', 'correctSettledTicketPayments', 'adjustTicketEnd', 'adjustTicketGuests', 'editTicketLine', 'cancelTicketExtension',
  'editDeposit','correctRegisterCount','correctSettledContents']);
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

export function verifyCommand(role, command, state) {
  requireCondition(isRecord(command) && typeof command.type === 'string', 400, 'invalid-command', '操作を確認してください。');
  requireCondition(canOperate(role) && roleCommands[role].has(command.type), 403, 'forbidden', 'この操作には権限が必要です。');
  requireCondition(roleAllowsCommand(state,role,command),403,'forbidden','店舗設定でこの役職には操作が許可されていません。');
  if (command.type === 'saveRolePolicy') {
    try { normalizeRolePolicy(command.policy); }
    catch (error) { throw new ApiError(400,'invalid-command',error.message); }
  }
  if (command.type === 'saveCashAccounts') {
    try { normalizeCashAccounts(command.accounts); }
    catch (error) { throw new ApiError(400,'invalid-command',error.message); }
  }
  if (reasonCommands.has(command.type)) {
    requireCondition(typeof command.reason === 'string' && command.reason.trim().length > 0,
      400, 'reason-required', '操作の理由を入力してください。');
  }
  if (command.type === 'bindCastAccount') {
    const {memberUid,castId} = command;
    requireCondition(typeof memberUid === 'string' && memberUid.length > 0 && memberUid.length <= 128 && memberUid === memberUid.trim()
      && (castId === null || (typeof castId === 'string' && castId.length > 0 && castId.length <= 128 && castId === castId.trim())),
    400,'invalid-command','キャストと連携するアカウントを選択してください。');
  }
  if (command.type === 'saveCalculationSettings') requireCondition(isValidCalculationSettings(command.settings),
    400,'invalid-command','会計ルールの入力内容を確認してください。');
  if (isCastSelfCommand(command.type)) {
    requireCondition(!['castId','uid','memberUid','actor'].some((field) => Object.hasOwn(command,field)),
      400,'invalid-command','ログイン中の本人アカウントで操作してください。');
  }
  if (command.type === 'reviewCastAttendance') {
    requireCondition(typeof command.attendanceId === 'string' && command.attendanceId.length > 0 && command.attendanceId.length <= 128
      && ['approve','reject'].includes(command.decision),400,'invalid-command','勤怠と確認結果を選択してください。');
  }
  if (command.type === 'saveManagedAttendance') {
    const {attendanceId,castId,date,classification,reason} = command;
    const validId = (id)=>typeof id === 'string' && id.length > 0 && id.length <= 128;
    requireCondition((attendanceId == null || validId(attendanceId)) && validId(castId) && isBusinessDate(date)
      && ['worked','late','absent','no-show'].includes(classification) && typeof reason === 'string' && reason.trim().length > 0
      && (command.breaks === undefined || (Array.isArray(command.breaks) && command.breaks.every(isRecord))),
    400,'invalid-command','勤怠の入力内容を確認してください。');
  }
  if (isPayrollCommand(command.type)) {
    let valid;
    const hasTemplateId = typeof command.templateId === 'string' && command.templateId.length > 0 && command.templateId.length <= 128;
    if (command.type === 'savePayrollSettings') valid = isRecord(command.settings);
    else if (command.type === 'saveEmployeeProfile') valid = typeof command.castId === 'string' && isRecord(command.profile);
    else if (command.type === 'saveAttendanceItems') valid = Array.isArray(command.items) && command.items.length <= 50;
    else if (command.type === 'savePayrollVariables') valid = Array.isArray(command.variables) && command.variables.length <= 30;
    else if (command.type === 'savePayrollTemplate') valid = (command.templateId == null || hasTemplateId)
      && typeof command.name === 'string' && Array.isArray(command.rules);
    else if (command.type === 'assignPayrollTemplate') valid = typeof command.castId === 'string' && (command.templateId === null || hasTemplateId);
    else if (command.type === 'removePayrollTemplate') valid = hasTemplateId;
    else if (command.type === 'savePayrollRate') valid = typeof command.castId === 'string'
      && isBusinessDate(command.effectiveDate) && validYen(command.hourlyRate);
    else if (command.type === 'requestDailyPay') valid = typeof command.castId === 'string' && isPayrollMonth(command.month)
      && validYen(command.amount) && command.amount > 0;
    else if (isDailyPayCommand(command.type)) valid = typeof command.dailyPayId === 'string' && command.dailyPayId.length <= 128
      && (command.type === 'reviewDailyPay' ? ['approve','reject'].includes(command.decision) : ['cash','bank'].includes(command.method));
    else valid = typeof command.castId === 'string' && isPayrollMonth(command.month);
    requireCondition(valid, 400, 'invalid-command', '給与の入力内容を確認してください。');
  }
  if (command.type === 'seat') {
    requireCondition(command.newCustomer == null, 400, 'invalid-command',
      '顧客の新規登録は顧客管理から行ってください。来店登録では登録済みの顧客を選べます。');
    requireCondition(command.arrivedAt === undefined || (Number.isSafeInteger(command.arrivedAt) && command.arrivedAt >= 0),
      400,'invalid-command','来店時刻を確認してください。');
  }
  if (command.type === 'saveTicketNote' || command.type === 'adjustTicketEnd') {
    const validTicketId = typeof command.ticketId === 'string' && command.ticketId.length > 0 && command.ticketId.length <= 128;
    const relativeTime = Number.isInteger(command.minutes) && command.minutes !== 0 && Math.abs(command.minutes) <= 180
      && command.startsAt === undefined && command.endsAt === undefined;
    const absoluteTime = command.minutes === undefined && Number.isSafeInteger(command.startsAt)
      && Number.isSafeInteger(command.endsAt) && command.startsAt >= 0 && command.endsAt >= command.startsAt;
    const validChange = command.type === 'saveTicketNote' ? typeof command.note === 'string' && command.note.trim().length <= 400
      : relativeTime || absoluteTime;
    requireCondition(validTicketId && validChange, 400, 'invalid-command', '伝票と入力内容を確認してください。');
  }
  if (command.type === 'adjustTicketGuests') {
    const {ticketId, mode, count} = command;
    requireCondition(typeof ticketId === 'string' && ticketId.length > 0 && ticketId.length <= 128
      && ['correct','join','leave'].includes(mode) && Number.isInteger(count) && count > 0 && count <= 100,
    400, 'invalid-command', '伝票と人数変更の内容を確認してください。');
  }
  if (command.type === 'editTicketLine' || command.type === 'cancelTicketExtension') {
    const {ticketId,lineId,quantity,castIds,price} = command;
    const validLine = [ticketId,lineId].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128);
    const validEdit = Number.isInteger(quantity) && quantity > 0 && quantity <= 100 && (price === undefined || validYen(price))
      && (castIds === undefined || (Array.isArray(castIds) && castIds.length <= 100
        && castIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)));
    requireCondition(validLine && (command.type === 'cancelTicketExtension' || validEdit),
      400,'invalid-command','訂正する明細を確認してください。');
  }
  if (command.type === 'extendOverdue' || (command.type === 'extend' && command.plans !== undefined)) {
    const {ticketId, menuId, plans, expectedCount, expectedTotal} = command;
    const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 128;
    const assignment = plans === undefined ? validId(menuId) : Array.isArray(plans) && plans.length > 0
      && plans.length <= 24 && plans.every((row) => isRecord(row) && validId(row.menuId)
        && Number.isInteger(row.quantity) && row.quantity > 0 && row.quantity <= 100);
    const validCount = command.type === 'extend' || (Number.isInteger(expectedCount) && expectedCount > 0 && expectedCount <= maxOverdueExtensionCount);
    requireCondition(validId(ticketId) && assignment && validCount && (expectedTotal === undefined || validYen(expectedTotal)),
      400, 'invalid-command', '伝票と延長の内容を確認してください。');
  }
  if (command.type === 'setTicketCustomer' || command.type === 'correctSettledTicketCustomer') {
    const { ticketId, customerId } = command;
    requireCondition(typeof ticketId === 'string' && ticketId.trim().length > 0
      && (customerId === null || (typeof customerId === 'string' && customerId.trim().length > 0)),
    400, 'invalid-command', '伝票と顧客の選択内容を確認してください。');
  }
  if (command.type === 'setTicketCompanion' || command.type === 'correctSettledTicketCompanion') {
    const {ticketId,customerId,mode,primaryCustomerId} = command;
    const ids = command.type === 'setTicketCompanion' ? [ticketId,customerId] : [ticketId,customerId,primaryCustomerId];
    requireCondition(ids.every((id)=>typeof id === 'string' && id.trim() && id.length <= 128)
      && ['add','remove'].includes(mode),400,'invalid-command','登録済みの同席者を選択してください。');
  }
  if (command.type === 'order') {
    requireCondition(Array.isArray(command.items) && command.items.length <= 100 && command.items.every(isRecord),
      400, 'invalid-command', '注文内容を確認してください。');
  }
  if (command.type === 'setTableAutoExtension') {
    requireCondition(typeof command.tableId === 'string' && command.tableId.length > 0 && command.tableId.length <= 100
      && command.tableId.trim() === command.tableId && typeof command.enabled === 'boolean',
    400, 'invalid-command', '卓と自動延長の設定を確認してください。');
  }
  if (command.type === 'pauseVisitAutoExtension' || command.type === 'resumeVisitAutoExtension') {
    requireCondition(typeof command.ticketId === 'string' && command.ticketId.length > 0 && command.ticketId.length <= 100
      && command.ticketId.trim() === command.ticketId
      && (command.type === 'resumeVisitAutoExtension' || isAutoExtensionPauseSource(command.source)),
    400, 'invalid-command', '伝票と自動延長の操作内容を確認してください。');
  }
  if (command.type === 'deposit' || command.type === 'editDeposit') {
    const {method,brandId,waiveFee,expectedCardFee,preservePaymentTerms} = command;
    requireCondition((brandId === undefined || (['card','qr'].includes(method) && validBrandId(brandId)))
      && (waiveFee === undefined || typeof waiveFee === 'boolean')
      && (expectedCardFee === undefined || validYen(expectedCardFee))
      && (preservePaymentTerms === undefined || (command.type === 'editDeposit' && typeof preservePaymentTerms === 'boolean')),
    400,'invalid-command','前受金の決済ブランドと加算設定を確認してください。');
    requireCondition(canWaivePaymentFee(role) || !waiveFee,
      403,'forbidden','決済加算を免除するにはマネージャー以上の権限が必要です。');
  }
  if (command.type === 'settle') {
    requireCondition(Array.isArray(command.payments) && command.payments.length <= 10 && command.payments.every(isRecord),
      400, 'invalid-command', '支払内容を確認してください。');
    requireCondition(command.payments.every(({method,brandId,waiveFee}) =>
      (brandId === undefined || (['card','qr'].includes(method) && validBrandId(brandId)))
      && (waiveFee === undefined || typeof waiveFee === 'boolean')),
    400,'invalid-command','決済ブランドと加算設定を確認してください。');
    requireCondition(canWaivePaymentFee(role) || !command.payments.some(({waiveFee}) => waiveFee),
      403,'forbidden','決済加算を免除するにはマネージャー以上の権限が必要です。');
    requireCondition(command.expectedCardFee === undefined || (Number.isSafeInteger(command.expectedCardFee) && command.expectedCardFee >= 0),
      400, 'invalid-command', 'カード会計加算額を確認してください。');
    requireCondition(command.cashReceived === undefined || (isRegisterCashAmount(command.cashReceived) && command.cashReceived > 0),
      400, 'invalid-command', '現金のお預かり額を確認してください。');
    requireCondition(role !== 'staff' || command.payments.every(({ method }) => method !== 'receivable'),
      403, 'forbidden', '売掛での会計には管理者またはマネージャーの権限が必要です。');
  }
  if (command.type === 'close' && command.cashDenominations !== undefined) {
    requireCondition(isRecord(command.cashDenominations) && isRegisterCashAmount(command.actualCash)
      && getCashCountTotal(command.cashDenominations) === command.actualCash,
    400, 'invalid-command', '金種別に数えた合計をレジの実残高と一致させてください。');
  }
  if (command.type === 'correctSettledTicketPayments') {
    const { ticketId, payments, creditDueDate, reason } = command;
    requireCondition(typeof ticketId === 'string' && ticketId.length > 0 && ticketId.length <= 128
      && ticketId === ticketId.trim() && reason.trim().length <= 120
      && (creditDueDate === undefined || isBusinessDate(creditDueDate))
      && Array.isArray(payments) && payments.length > 0 && payments.length <= 10 && payments.every((row) =>
        isRecord(row) && (paymentMethods.has(row.method) || row.method === 'receivable')
        && validYen(row.amount) && row.amount > 0),
    400, 'invalid-command', '伝票と訂正後の支払内容を確認してください。');
  }
  if (command.type === 'correctSettledContents') {
    requireCondition(typeof command.ticketId === 'string' && command.ticketId.length <= 128 && validYen(command.expectedTotal)
      && validYen(command.discount) && paymentMethods.has(command.adjustmentMethod)
      && (command.lineId === '' || (typeof command.lineId === 'string' && command.lineId.length <= 128
        && Number.isInteger(command.quantity) && command.quantity > 0 && command.quantity <= 100
        && validYen(command.price) && Array.isArray(command.castIds) && command.castIds.length <= 100
        && command.castIds.every((id) => typeof id === 'string' && id.length <= 128))),
    400,'invalid-command','訂正する明細と金額を確認してください。');
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

function clearCommissionDetails(state) {
  for (const ticket of allSnapshotTickets(state)) {
    for (const line of ticket.lines) {
      delete line.castCommissions;
      line.commission = emptyCommission;
    }
    if (ticket.settlement) {
      ticket.settlement.commission = [];
      ticket.settlement.commissionDetails = [];
    }
  }
  for (const item of state.menu) {
    item.acceptsCast = acceptsCast(item,state.cast);
    delete item.commission;
  }
  for (const person of [...state.cast,...(state.archivedCast ?? [])]) delete person.commissionOverride;
}

function restrictRoleData(next, role) {
  const allowed = (group) => roleGroupAllowed(next,role,group);
  if (!allowed('staffing')) {
    delete next.shifts;
    delete next.castAttendance;
    delete next.attendanceItems;
  }
  if (!allowed('reports')) {
    next.closedDays = [];
    next.day.openingCash = 0;
    next.day.closingCash = null;
    delete next.cancelledSettlements;
    delete next.cashMovements;
    delete next.cashAccounts;
    delete next.dailyPayByDate;
    delete next.floorMonthSales;
    delete next.accountingCsv;
    delete next.receivables;
    delete next.recoveryTotalsForDay;
    delete next.recoveryRowsForDay;
    delete next.cashRecoveryRows;
    next.printDocuments = next.printDocuments?.filter(({date}) => date === next.day.date);
    clearCommissionDetails(next);
  }
  if (!allowed('customers')) {
    next.customers = [];
    delete next.receivables;
    for (const ticket of allSnapshotTickets(next)) {
      ticket.customer = '';
      delete ticket.customerId;
      delete ticket.activeCustomerLink;
      delete ticket.companionCustomerIds;
      delete ticket.activeCompanionLinks;
    }
    next.printDocuments = next.printDocuments?.map(printDocumentMetadata);
  }
  if (!allowed('inventory')) {
    next.stock = [];
    next.archivedStock = [];
    next.movements = [];
    for (const item of next.menu) delete item.recipe;
    for (const ticket of allSnapshotTickets(next)) for (const line of ticket.lines) {
      line.stockUses = [];
      delete line.stockRecipe;
    }
  }
  if (!allowed('printing')) delete next.printDocuments;
  return next;
}

export function projectState(state, role, actorUid) {
  if (role === 'admin') return state;
  if (role === 'cast') return getCastWorkspace(state,actorUid);
  if (role !== 'manager' && role !== 'staff') return null;
  const next = structuredClone(state);
  delete next.auditLog;
  delete next.payroll;
  delete next.attendances;
  delete next.dailyPayByDate;
  delete next.castAccounts;
  if (role === 'staff') {
    delete next.shifts;
    delete next.castAttendance;
    delete next.attendanceItems;
  } else if (next.castAttendance !== undefined) next.castAttendance = listCastAttendance(state);
  for (const ticket of allSnapshotTickets(next)) delete ticket.settledBy;
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
  if (next.day.status === 'open') {
    const names = new Map(next.customers.map(({ id, name }) => [id, name]));
    for (const ticket of next.tickets) {
      if (ticket.status === 'open' && names.has(ticket.customerId)) {
        ticket.activeCustomerLink = { id: ticket.customerId, name: names.get(ticket.customerId) };
        if (ticket.companionCustomerIds?.length) ticket.activeCompanionLinks = ticket.companionCustomerIds
          .filter((id)=>names.has(id)).map((id)=>({id,name:names.get(id)}));
      }
    }
  }
  if (role === 'manager') {
    next.dailyPayByDate = getDailyPayByDate({payroll:state.payroll});
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
      if (ticket.companionCustomerIds) ticket.companionCustomerIds = ticket.companionCustomerIds.filter((id)=>assigned.has(id));
      for (const entry of [ticket.discountDetails, ticket.discountRequest]) {
        for (const field of ['actor', 'approvedBy']) {
          if (entry?.[field] && entry[field].id !== actorUid) delete entry[field];
        }
      }
    }
    return restrictRoleData(next,role);
  }
  next.floorMonthSales = getMonthlyReportSales(state);
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
  delete next.cashAccounts;
  for (const ticket of next.tickets) {
    ticket.customer = '';
    delete ticket.customerId;
    delete ticket.companionCustomerIds;
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
  return restrictRoleData(next,role);
}

function uniqueRecords(records) {
  return Array.isArray(records) && records.every((entry) => isRecord(entry)
    && typeof entry.id === 'string' && entry.id.length > 0)
    && new Set(records.map(({ id }) => id)).size === records.length;
}

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validYen(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validFeeRate(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
}

function validBrandId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}

function validCardPayment(row, isSettlement) {
  const hasBrand = row.brandId !== undefined || row.brandName !== undefined;
  if (hasBrand && (!['card','qr'].includes(row.method) || !validBrandId(row.brandId)
    || typeof row.brandName !== 'string' || !row.brandName.trim() || row.brandName.length > 40
    || /[\p{Cc}\u2028\u2029]/u.test(row.brandName))) return false;
  const waived = row.feeWaived !== undefined || row.waivedFeeRate !== undefined;
  if (waived && (row.feeWaived !== true || !['card','qr'].includes(row.method)
    || !validFeeRate(row.waivedFeeRate) || row.waivedFeeRate <= 0)) return false;
  const withFee = ['baseAmount', 'cardFee', 'cardFeeRateBps'].some((key) => row[key] !== undefined);
  if (!withFee) return true;
  if (waived || (row.method !== 'card' && (row.method !== 'qr' || !hasBrand))
    || !validYen(row.cardFee) || !validFeeRate(row.cardFeeRateBps) || row.cardFeeRateBps === 0) return false;
  return isSettlement ? validYen(row.baseAmount) && row.cardFee > 0 && row.cardFee <= row.baseAmount
      && row.amount === row.baseAmount + row.cardFee
    : row.baseAmount === undefined && validYen(row.amount) && validYen(depositGrossAmount(row))
      && row.cardFee === roundCalculationRate(row.amount,row.cardFeeRateBps,'round');
}

function validPayments(records, isSettlement = false) {
  return uniqueRecords(records) && records.every((row) =>
    (paymentMethods.has(row.method) || (isSettlement && row.method === 'receivable')) && nonnegative(row.amount)
    && optionalText(row.memo,120)
    && validCardPayment(row,isSettlement));
}

function validCardSettlement(ticket) {
  const settlement = ticket.settlement;
  const allocatedFees = ticket.payments.reduce((total, payment) => total + (payment.cardFee ?? 0), 0);
  const depositFees = ticket.deposits.reduce((total, deposit) => total + (deposit.cardFee ?? 0), 0);
  if (!settlement) return allocatedFees === 0;
  if (settlement.cardFee === undefined) return allocatedFees === 0 && depositFees === 0
    && settlement.depositFee === undefined && settlement.brandedFee === undefined;
  const {cardFee, cardFeeTax, cardFeeRateBps, baseTotal, brandedFee, depositFee} = settlement;
  if (brandedFee !== undefined && brandedFee !== true) return false;
  if (depositFees ? depositFee !== depositFees || settlement.deposit !== ticket.deposits.reduce((sum,row) => sum + depositGrossAmount(row),0)
    : depositFee !== undefined) return false;
  const tenders = [...ticket.payments,...ticket.deposits];
  const hasBrandedFee = tenders.some((payment)=>payment.cardFee > 0 && payment.brandId);
  const allocatedCorrectly = ticket.paymentsCorrectedAt === undefined
    ? cardFee === allocatedFees + depositFees : allocatedFees === 0 && cardFee >= depositFees;
  return validYen(cardFee) && cardFee > 0 && allocatedCorrectly && validYen(cardFeeTax) && cardFeeTax <= cardFee
    && validFeeRate(cardFeeRateBps) && validYen(baseTotal) && baseTotal + cardFee === settlement.total
    && (ticket.paymentsCorrectedAt !== undefined || Boolean(brandedFee) === hasBrandedFee)
    && (brandedFee || ticket.payments.every((payment) => payment.cardFee === undefined || payment.cardFeeRateBps === cardFeeRateBps));
}

function validCashTender(ticket) {
  if (ticket.cashTender === undefined) return true;
  if (!isRecord(ticket.cashTender) || !['paid', 'departed'].includes(ticket.status)) return false;
  const {received, change} = ticket.cashTender;
  const cash = getCashPaymentAmount(ticket.payments);
  return cash > 0 && isRegisterCashAmount(received) && isRegisterCashAmount(change) && received - cash === change;
}

function validPaymentCorrection(ticket) {
  if (ticket.paymentsCorrectedAt === undefined) return true;
  if (!validYen(ticket.paymentsCorrectedAt) || !['paid', 'departed'].includes(ticket.status)
    || (validYen(ticket.settledAt) && ticket.paymentsCorrectedAt < ticket.settledAt)
    || !validYen(ticket.settlement?.total)) return false;
  const deposits = ticket.deposits.reduce((sum, row) => sum + depositGrossAmount(row), 0);
  const total = ticket.payments.reduce((sum, row) => sum + row.amount, 0);
  const receivable = ticket.payments.reduce((sum, row) => sum + (row.method === 'receivable' ? row.amount : 0), 0);
  return validYen(deposits) && validYen(total) && total > 0 && total === ticket.settlement.total - deposits
    && ticket.settlement.paid === total - receivable && (ticket.settlement.receivable ?? 0) === receivable
    && ticket.payments.every((row) => validYen(row.amount) && row.amount > 0 && row.cardFee === undefined);
}

function validTicket(ticket) {
  return ticketStatuses.has(ticket.status) && Array.isArray(ticket.tableIds)
    && (ticket.admittedGuests === undefined || (Number.isInteger(ticket.guests) && ticket.guests > 0 && ticket.guests <= 100
      && Number.isSafeInteger(ticket.admittedGuests) && ticket.admittedGuests >= ticket.guests))
    && (ticket.calculationSettings === undefined || isValidCalculationSettings(ticket.calculationSettings))
    && (ticket.note === undefined || (typeof ticket.note === 'string' && ticket.note.length <= 400))
    && (ticket.settlementRevision === undefined || validYen(ticket.settlementRevision))
    && (ticket.autoExtensionResumedAt === undefined || validYen(ticket.autoExtensionResumedAt))
    && isValidVisitAutoExtensionPause(ticket)
    && uniqueRecords(ticket.lines) && ticket.lines.every((line) =>
      typeof line.name === 'string' && typeof line.menuId === 'string'
      && optionalText(line.printName,60)
      && (line.hideReceiptLine === undefined || (typeof line.hideReceiptLine === 'boolean' && (!line.hideReceiptLine || line.price === 0)))
      && Number.isInteger(line.quantity) && line.quantity > 0
      && nonnegative(line.price) && nonnegative(line.total) && nonnegative(line.taxRate)
      && (line.autoExtension === undefined || typeof line.autoExtension === 'boolean')
      && Array.isArray(line.castIds) && Array.isArray(line.stockUses)
      && (line.castIds.length === 0 || isRecord(line.commission)))
    && validPayments(ticket.deposits) && validPayments(ticket.payments, true) && validPaymentCorrection(ticket) && validCashTender(ticket)
    && nonnegative(ticket.discount) && nonnegative(ticket.serviceRate) && validCardSettlement(ticket)
    && (ticket.settlement == null || (isRecord(ticket.settlement) && nonnegative(ticket.settlement.total)
      && Array.isArray(ticket.settlement.commission) && Array.isArray(ticket.settlement.taxBreakdown)));
}

function validTableAutoExtension(state) {
  if (state.tableAutoExtension === undefined) return true;
  if (!isRecord(state.tableAutoExtension)) return false;
  const tableIds = new Set(state.tables.map(({ id }) => id));
  return Object.entries(state.tableAutoExtension).every(([id, enabled]) => tableIds.has(id) && enabled === false);
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
    && optionalText(customer.email, 254) && optionalText(customer.receiptRecipient, 80) && isCustomerPhoto(customer.photo)
    && (customer.daysOff === undefined || (Array.isArray(customer.daysOff) && customer.daysOff.every((day) => customerWeekdays.includes(day))
      && new Set(customer.daysOff).size === customer.daysOff.length))
    && (customer.tags === undefined || (Array.isArray(customer.tags) && customer.tags.length <= 15
      && customer.tags.every((tag) => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= 27)))
    && (customer.flagged === undefined || typeof customer.flagged === 'boolean')
    && (customer.creditEnabled === undefined || typeof customer.creditEnabled === 'boolean')
    && ((customer.creditLimit === undefined && !customer.creditEnabled) || (Number.isSafeInteger(customer.creditLimit)
      && customer.creditLimit >= 0 && customer.creditLimit <= 100_000_000))
    && (customer.bottleKeeps === undefined || (Array.isArray(customer.bottleKeeps) && customer.bottleKeeps.length <= 30
      && customer.bottleKeeps.every((bottle) => isRecord(bottle) && typeof bottle.name === 'string'
        && bottle.name.trim().length > 0 && bottle.name.length <= 60 && nonnegative(bottle.quantity) && bottle.quantity <= 1_000_000
        && optionalText(bottle.unit, 12) && optionalDate(bottle.expiresAt) && isCustomerPhoto(bottle.photo))));
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
      && (day.cashDenominations === undefined || (isRecord(day.cashDenominations) && isRegisterCashAmount(day.actualCash)
        && getCashCountTotal(day.cashDenominations) === day.actualCash))
      && (day.ticketSnapshots === undefined || (uniqueRecords(day.ticketSnapshots) && day.ticketSnapshots.every(validTicket))))
    && (state.cancelledSettlements === undefined || (uniqueRecords(state.cancelledSettlements)
      && state.cancelledSettlements.every(validCancelledSettlement)))
    && validControls(state.controls)
    && (state.autoExtensionSettings === undefined || isValidAutoExtensionSettings(state.autoExtensionSettings))
    && (state.bulkExtensionEnabled === undefined || typeof state.bulkExtensionEnabled === 'boolean')
    && validTableAutoExtension(state)
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
    && allSnapshotTickets(state).every((ticket) => (ticket.customerId == null || customerIds.has(ticket.customerId))
      && (ticket.companionCustomerIds === undefined || (Array.isArray(ticket.companionCustomerIds)
        && ticket.companionCustomerIds.length <= 20
        && new Set(ticket.companionCustomerIds).size === ticket.companionCustomerIds.length
        && (!ticket.companionCustomerIds.length || customerIds.has(ticket.customerId))
        && ticket.companionCustomerIds.every((id)=>id !== ticket.customerId && customerIds.has(id))))),
  400, 'invalid-snapshot', message);

  let normalizedPrintSettings;
  let normalizedCardFeeSettings;
  let normalizedPayroll;
  let normalizedAttendances;
  try {
    if (state.rolePolicy !== undefined) normalizeRolePolicy(state.rolePolicy);
    if (state.cashAccounts !== undefined) normalizeCashAccounts(state.cashAccounts);
    requireCondition(validCashAccountHistory(state),400,'invalid-snapshot','金庫と出金先の残高を確認してください。');
    validateShiftsSnapshot(state);
    if (state.controls?.register !== undefined) normalizeRegisterSettings(state.controls.register);
    if (state.accountingCsv !== undefined) {
      requireCondition(isRecord(state.accountingCsv) && Object.keys(state.accountingCsv).every((mode) => ['daily','tickets'].includes(mode)),400,'invalid-snapshot',message);
      for (const settings of Object.values(state.accountingCsv)) normalizeAccountingCsv(settings);
    }
    validateCastAttendanceSnapshot(state);
    if (state.attendanceItems !== undefined) normalizeAttendanceItems(state.attendanceItems);
    requireCondition(state.calculationSettings === undefined || isValidCalculationSettings(state.calculationSettings),400,'invalid-snapshot',message);
    requireCondition(isValidInitialSetSchedule(state.initialSetSchedule),400,'invalid-snapshot',message);
    normalizedPayroll = normalizePayrollSnapshot(state);
    normalizedAttendances = normalizeAttendanceSnapshot(state);
    if (state.cardFeeSettings !== undefined) normalizedCardFeeSettings = normalizeCardFeeSettings(state.cardFeeSettings);
    if (state.printSettings !== undefined) normalizedPrintSettings = normalizePrintSettings(state.printSettings);
    parseStoreConfiguration(JSON.stringify(exportStoreConfiguration(state)));
    for (const ticket of state.tickets) quote(state, ticket.id);
    summary({ ...state, recoveryTotalsForDay: undefined, recoveryRowsForDay: undefined });
  } catch {
    throw new ApiError(400, 'invalid-snapshot', message);
  }
  const migrated = structuredClone(state);
  if (migrated.rolePolicy !== undefined) migrated.rolePolicy = normalizeRolePolicy(migrated.rolePolicy);
  if (migrated.cashAccounts !== undefined) migrated.cashAccounts = normalizeCashAccounts(migrated.cashAccounts);
  if (migrated.calculationSettings !== undefined) migrated.calculationSettings = normalizeCalculationSettings(migrated.calculationSettings);
  if (normalizedPayroll !== undefined) migrated.payroll = normalizedPayroll;
  if (normalizedAttendances !== undefined) migrated.attendances = normalizedAttendances;
  if (migrated.castAttendance !== undefined) migrated.castAttendance = listCastAttendance(state);
  delete migrated.castAccounts;
  delete migrated.dailyPayByDate;
  delete migrated.auditLog;
  delete migrated.floorMonthSales;
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
  if (normalizedCardFeeSettings !== undefined) migrated.cardFeeSettings = normalizedCardFeeSettings;
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
    if (ticket.calculationSettings !== undefined) ticket.calculationSettings = normalizeCalculationSettings(ticket.calculationSettings);
    delete ticket.seatedByUid;
    delete ticket.activeCustomerLink;
    delete ticket.activeCompanionLinks;
    delete ticket.settledBy;
  }
  return migrated;
}
