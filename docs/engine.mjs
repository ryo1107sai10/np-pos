import { addCardFeeTax, canWaivePaymentFee, depositGrossAmount, getDepositPaymentTerms, getPaymentFeeGroups, normalizeCardFeeSettings } from './card-fee.mjs';
import { calculationTaxGroup, canApplyOrderLineDiscount, canExcludeOrderService, canOverrideOrderTax, defaultItemTaxRateBps, getCalculationSettings, getTicketCalculationSettings,
  normalizeCalculationSettings, roundCalculationRate } from './calculation-settings.mjs';
import { getOrderLineDiscountAmount, getTicketDiscountableSubtotal, isValidOrderLineDiscount } from './order-line-discount.mjs';
import { getStoreSettings, normalizeStoreSettings, replaceStoreSettings } from './store-settings.mjs';
import { buildOperationAudit } from './operational-audit.mjs';
import { assertCastOnDuty, normalizeCastDutyMode } from './cast-duty.mjs';
import { applyPayrollCommand, isPayrollCommand } from './payroll.mjs';
import { applyStaffLaborCommand, isStaffLaborCommand } from './labor-workspace.mjs';
import { applyCustomerCommand, customerForSeat, findCustomer, findSettledCustomerTicket, isAssignedCustomer, setTicketCompanion, setTicketCustomer } from './customers.mjs';
import { correctSettledTicketReceivable, getCustomerReceivableBalance, getReceivableBalance, getReceivableRecoveryTotals,
  receivableCollectionMethods } from './receivables.mjs';
import { createCashMovement, editableCashMovement, getCashMovements, getDailyRecoveryRows, totalCashMovements } from './cash-ledger.mjs';
import { calculateCashTender, getCashCountTotal } from './register-cash.mjs';
import { applyPrintCommand } from './print-domain.mjs';
import { applyAccountingCsv } from './accounting-csv.mjs';
import { normalizeRolePolicy, roleAllowsCommand } from './role-policy.mjs';
import { getPersonalSalesDiscountMode, isPersonalSalesDiscountMode, personalSalesAdjustmentDetails,
  recordPersonalSalesAdjustment } from './personal-sales.mjs';
import { saveCashAccounts } from './cash-accounts.mjs';
import { replayPurchaseCancellation } from './inventory-operations.mjs';
import { businessDate, normalizeRegisterSettings, openingCashSuggestion, operationBusinessDate, registerCutoff } from './register-config.mjs';
import { applyShiftCommand } from './shifts.mjs';
import { applySetSchedule, isValidInitialSetSchedule } from './set-schedule.mjs';
import { applyCastSelfCommand, bindCastAccount, isCastAttendanceReview, isCastSelfCommand, isManagedAttendanceCommand } from './cast-self.mjs';
import { getLinkedTablesAutoExtensionEnabled, pauseVisitAutoExtension, resumeVisitAutoExtension, saveAutoExtensionSettings,
  setTableAutoExtension, syncAutomaticExtensions } from './auto-extension.mjs';

const movementScale = 1_000_000;
const pointsScale = 1_000;
const minute = 60_000;
const methods = ['cash', 'card', 'qr'];
const methodLabel = { cash: '現金', card: 'カード', qr: 'QR決済', receivable: '売掛' };
const occupiedStatuses = new Set(['open', 'paid']);
const moneyFormatter = new Intl.NumberFormat('ja-JP');

export const layoutGrid = Object.freeze({ columns: 12, rows: 8, tableWidth: 3, tableHeight: 2 });
const layoutNameMaxLength = 24;
const newTableId = /^table-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const layoutFileFormat = 'np-pos.layout';
const layoutFileVersion = 1;
const storeFileFormat = 'np-pos.settings';
const storeFileVersion = 2;
const demoActor = Object.freeze({ id: 'demo-admin', label: 'デモ管理者', role: 'admin' });

export const discountReasonCodes = Object.freeze({
  service: 'サービス', coupon: 'クーポン', negotiation: '交渉', other: 'その他',
});

export const orderTaxOverrideRates = Object.freeze([1_000, 800, 0]);

export function isOrderTaxRateOverride(value) {
  return orderTaxOverrideRates.includes(value);
}

export function getManagerDiscountLimit(state) {
  const limit = state.controls?.managerDiscountRateBps;
  return Number.isInteger(limit) && limit >= 0 && limit <= 10_000 ? limit : 1_000;
}

function isLayoutPosition(x, y) {
  return Number.isInteger(x) && x >= 0 && x + layoutGrid.tableWidth <= layoutGrid.columns
    && Number.isInteger(y) && y >= 0 && y + layoutGrid.tableHeight <= layoutGrid.rows;
}

export function getLayoutTables(state) {
  const countByArea = new Map();
  const columnStep = layoutGrid.tableWidth + 1;
  const rowStep = layoutGrid.tableHeight + 1;
  const tablesPerRow = Math.floor(layoutGrid.columns / columnStep);
  return state.tables.map((table) => {
    const index = countByArea.get(table.area) ?? 0;
    countByArea.set(table.area, index + 1);
    if (isLayoutPosition(table.x, table.y)) return { ...table };
    return { ...table, x: (index % tablesPerRow) * columnStep, y: Math.floor(index / tablesPerRow) * rowStep };
  });
}

export function getLayoutAreas(state) {
  return state.layoutAreas?.slice() ?? [...new Set([...layoutAreas, ...state.tables.map((table) => table.area)])];
}

export function getTableLabel(state, id) {
  return state.tables.find((table) => table.id === id)?.name
    ?? state.archivedTables?.find((table) => table.id === id)?.name
    ?? id;
}

export function exportLayout(state) {
  return {
    format: layoutFileFormat,
    version: layoutFileVersion,
    areas: getLayoutAreas(state),
    tables: getLayoutTables(state).map(({ id, layoutSourceId, name, area, x, y, capacity }) => ({
      id: layoutSourceId ?? id, name, area, x, y, capacity,
    })),
  };
}

function parseSettingsJson(text, label) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${label}を読み取れませんでした。JSON形式のファイルを選択してください。`);
  }
}

export function parseLayoutFile(text) {
  return normalizeLayoutFile(parseSettingsJson(text, '卓配置ファイル'));
}

function validatedStoreSettings(settings, state, requireStock = false) {
  return normalizeStoreSettings(settings, {
    menuIds: new Set(menu.map(({ id }) => id)),
    castIds: new Set(cast.map(({ id }) => id)),
    stockMasterIds: new Set(stockSeed.map(([id]) => id)),
    localStockIds: state ? new Set(state.stock.map(({ id }) => id)) : null,
    requireStock,
  });
}

export function exportStoreConfiguration(state) {
  return {
    format: storeFileFormat, version: storeFileVersion,
    layout: exportLayout(state), settings: getStoreSettings(state),
    ...(state.initialSetSchedule && {initialSetSchedule:state.initialSetSchedule.map(({start,end,setId})=>({start,end,setId}))}),
    ...(state.bulkExtensionEnabled !== undefined && {bulkExtensionEnabled:state.bulkExtensionEnabled}),
    ...(state.calculationSettings && {calculationSettings:getCalculationSettings(state)}),
  };
}

export function parseStoreConfiguration(text) {
  const file = parseSettingsJson(text, '店舗設定ファイル');
  if (file?.format === layoutFileFormat) return { layout: normalizeLayoutFile(file), settings: null };
  assert(file?.format === storeFileFormat, 'NP POSの店舗設定ファイルを選択してください。');
  const legacy = file.version === 1;
  assert(legacy || file.version === storeFileVersion, 'このバージョンの店舗設定ファイルには対応していません。');
  const input = legacy ? { menu: file.settings?.menu, cast: file.settings?.cast } : file.settings;
  const settings = validatedStoreSettings(input, null, !legacy);
  const rules = file.initialSetSchedule;
  assert(isValidInitialSetSchedule(rules), '時間帯別セットの設定を確認してください。');
  assert(file.bulkExtensionEnabled === undefined || typeof file.bulkExtensionEnabled === 'boolean', '一括延長の設定を確認してください。');
  return { layout: normalizeLayoutFile(file.layout), settings,
    ...(file.bulkExtensionEnabled !== undefined && {bulkExtensionEnabled:file.bulkExtensionEnabled}),
    ...(file.calculationSettings !== undefined && {calculationSettings:normalizeCalculationSettings(file.calculationSettings)}),
    ...(rules && {initialSetSchedule:rules.map(({start,end,setId})=>({start,end,setId}))}) };
}

export function yen(amount) {
  return `¥${moneyFormatter.format(amount)}`;
}

export { businessDate } from './register-config.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInteger(number, label, limit = 100) {
  assert(Number.isInteger(number) && number > 0 && number <= limit, `${label}を確認してください。`);
  return number;
}

function money(number, label, allowZero = true) {
  assert(Number.isSafeInteger(number) && number >= (allowZero ? 0 : 1) && number <= 100_000_000,
    `${label}を円単位で入力してください。`);
  return number;
}

function decimalUnits(number) {
  assert(Number.isFinite(number) && Math.abs(number) <= 1_000_000, '在庫数量を確認してください。');
  const units = Math.round(number * movementScale);
  assert(Math.abs(units / movementScale - number) < 0.00000001, '在庫数量は小数点以下6桁まで入力できます。');
  return units;
}

function totalOf(records) {
  return records.reduce((total, record) => total + record.amount, 0);
}

export function getSettledTicketPaymentTotal(ticket) {
  return totalOf(ticket?.payments ?? []);
}

function createId(state, prefix) {
  return `${prefix}-${state.nextId++}`;
}

function tableSet(state, tableIds, guests, exceptTicketId) {
  assert(Array.isArray(tableIds) && tableIds.length > 0 && new Set(tableIds).size === tableIds.length,
    '使用する卓を1つ以上選択してください。');
  const tables = tableIds.map((tableId) => {
    const table = state.tables.find((entry) => entry.id === tableId);
    assert(table, '指定された卓が見つかりません。');
    const current = getTicketForTable(state, tableId);
    assert(!current || current.id === exceptTicketId, `${table.name}は使用中です。`);
    return table;
  });
  assert(tables.reduce((capacity, table) => capacity + table.capacity, 0) >= guests,
    '人数が選択した卓の定員を超えています。');
  return tableIds.slice();
}

function recordTableAssignment(ticket, tableIds, now) {
  const history = ticket.tableHistory ?? ticket.tableIds.map((tableId) => ({
    tableId, attachedAt: ticket.createdAt, releasedAt: null,
  }));
  const assigned = new Set(tableIds);
  const active = new Set();
  for (const entry of history) {
    if (entry.releasedAt !== null) continue;
    if (assigned.has(entry.tableId)) active.add(entry.tableId);
    else entry.releasedAt = now;
  }
  for (const tableId of tableIds) {
    if (!active.has(tableId)) history.push({ tableId, attachedAt: now, releasedAt: null });
  }
  ticket.tableHistory = history;
}

export function getTicketForTable(state, tableId) {
  return state.tickets.find((ticket) => occupiedStatuses.has(ticket.status) && ticket.tableIds.includes(tableId)) ?? null;
}

export function tableStatus(state, tableId, now = Date.now()) {
  const ticket = getTicketForTable(state, tableId);
  if (!ticket) return 'available';
  if (ticket.status === 'paid') return 'paid';
  if (ticket.endsAt <= now) return 'overtime';
  return ticket.endsAt <= now + 10 * minute ? 'soon' : 'active';
}

function findTicket(state, ticketId) {
  const ticket = state.tickets.find((entry) => entry.id === ticketId);
  assert(ticket, '伝票が見つかりません。');
  return ticket;
}

function requireOrderable(ticket) {
  assert(ticket.status === 'open', '会計前の伝票で操作してください。');
}

function allocate(total, weights) {
  const divisor = weights.reduce((sum, weight) => sum + weight, 0);
  if (!divisor || !total) return weights.map(() => 0);
  const value = BigInt(total);
  const denominator = BigInt(divisor);
  const portions = weights.map((weight, index) => {
    const numerator = value * BigInt(weight);
    return { index, amount: Number(numerator / denominator), remainder: numerator % denominator };
  });
  let remaining = total - portions.reduce((sum, entry) => sum + entry.amount, 0);
  const ordered = portions.slice().sort((first, second) => {
    if (first.remainder === second.remainder) return first.index - second.index;
    return first.remainder > second.remainder ? -1 : 1;
  });
  for (const entry of ordered) {
    if (remaining === 0) break;
    entry.amount++;
    remaining--;
  }
  return portions.map((entry) => entry.amount);
}

export function getSettlementPaymentFees(state, payments) {
  const {metadata,groups} = getPaymentFeeGroups(state,payments);
  const fees = new Array(payments.length).fill(0);
  for (const {indexes,fee} of groups) {
    const shares = allocate(fee,indexes.map((index)=>payments[index].amount));
    indexes.forEach((index,offset)=>{fees[index] = shares[offset];});
  }
  return {metadata,fees,total:fees.reduce((sum,fee)=>sum+fee,0)};
}

function recordDepositPaymentTerms(state, action, actor, saved) {
  assert(action.waiveFee === undefined || typeof action.waiveFee === 'boolean','前受金の決済加算を確認してください。');
  assert(action.preservePaymentTerms === undefined || typeof action.preservePaymentTerms === 'boolean','前受金の決済設定を確認してください。');
  assert(canWaivePaymentFee(actor.role) || !action.waiveFee,'決済加算を免除するにはマネージャー以上の権限が必要です。');
  const hasPaymentSelection = action.expectedCardFee !== undefined || action.brandId !== undefined || action.waiveFee !== undefined;
  if (!hasPaymentSelection && action.preservePaymentTerms === undefined) {
    // Older clients recorded advances without a surcharge, even if checkout fees were enabled.
    return saved?.method === action.method ? getDepositPaymentTerms(state,{...action,preservePaymentTerms:true},saved) : {};
  }
  const terms = getDepositPaymentTerms(state, action, saved);
  const fee = terms.cardFee ?? 0;
  assert(action.expectedCardFee === fee,'前受金の決済加算が更新されています。金額を確認してください。');
  return terms;
}

function totalDepositsReceived(deposits) {
  return deposits.reduce((total,deposit) => total + depositGrossAmount(deposit), 0);
}

function exactRate(total, rate) {
  return roundCalculationRate(total, rate);
}

export function getItemCommission(item, person) {
  return { rate: 0, fixed: 0, points: 0, ...item.commission, ...person?.commissionOverride };
}

function equalShare(total, count, index) {
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
}

function addCommission(map, castId, sales, amount, pointsInUnits) {
  const current = map.get(castId) ?? { castId, sales: 0, amount: 0, pointsInUnits: 0 };
  current.sales += sales;
  current.amount += amount;
  current.pointsInUnits += pointsInUnits;
  map.set(castId, current);
}

function outputCommission(map) {
  return [...map.values()].map(({ pointsInUnits, ...entry }) => ({ ...entry, points: pointsInUnits / pointsScale }));
}

export function quote(state, ticketId) {
  const ticket = findTicket(state, ticketId);
  if (ticket.settlement) return structuredClone(ticket.settlement);
  return calculateQuote(ticket);
}

function removeEmbeddedItemTax(amounts, indices, rate, settings) {
  const gross = indices.map((index) => amounts[index]);
  const subtotal = gross.reduce((sum, amount) => sum + amount, 0);
  const taxByLine = allocate(calculationTaxGroup(subtotal, rate, settings).tax, gross);
  indices.forEach((index, offset) => { amounts[index] -= taxByLine[offset]; });
}

function calculateQuote(ticket, frozenFee = null) {
  const lines = ticket.lines.filter((line) => line.cancelledAt === null);
  const settings = getTicketCalculationSettings(ticket);
  const inclusive = settings.priceMode === 'inclusive';
  const listedAmounts = lines.map(({ total }) => total);
  const subtotal = listedAmounts.reduce((total, amount) => total + amount, 0);
  const lineDiscounts = lines.map(getOrderLineDiscountAmount);
  const lineDiscount = lineDiscounts.reduce((sum, amount) => sum + amount, 0);
  const afterLineDiscount = listedAmounts.map((amount, index) => amount - lineDiscounts[index]);
  const ticketDiscount = Math.min(ticket.discount, subtotal - lineDiscount);
  const discount = lineDiscount + ticketDiscount;
  const discountByLine = allocate(ticketDiscount, afterLineDiscount);
  const netByLine = afterLineDiscount.map((amount, index) => amount - discountByLine[index]);
  const serviceBase = settings.serviceBase === 'beforeDiscount' ? listedAmounts : netByLine;
  const serviceWeights = lines.map((line, index) => line.serviceEligible && line.serviceExcluded !== true ? serviceBase[index] : 0);
  const service = roundCalculationRate(serviceWeights.reduce((sum, weight) => sum + weight, 0),
    settings.serviceRateBps, settings.serviceRounding);
  const serviceByLine = allocate(service, serviceWeights);
  const byTaxRate = new Map();
  lines.forEach(({ taxRate }, index) => {
    const indices = byTaxRate.get(taxRate) ?? [];
    indices.push(index);
    byTaxRate.set(taxRate, indices);
  });
  const commissionSalesByLine = netByLine.slice();
  const keepPersonalSales = ticketDiscount > 0 && getPersonalSalesDiscountMode(ticket) === 'keep';
  const personalSalesByLine = keepPersonalSales ? afterLineDiscount.slice() : commissionSalesByLine;
  const itemTaxBreakdown = [...byTaxRate].sort(([first], [second]) => second - first).map(([rate, indices]) => {
    const taxable = indices.reduce((sum, index) => sum + netByLine[index] + serviceByLine[index], 0);
    if (inclusive && rate > 0) {
      // Commission uses discounted item sales before tax, without the separately charged service fee.
      removeEmbeddedItemTax(commissionSalesByLine, indices, rate, settings);
      if (keepPersonalSales) removeEmbeddedItemTax(personalSalesByLine, indices, rate, settings);
    }
    return calculationTaxGroup(taxable, rate, settings);
  });
  const commission = new Map();
  const commissionDetails = [];

  lines.forEach((line, index) => {
    if (line.castIds.length === 0) return;
    const count = line.castIds.length;
    line.castIds.forEach((castId, castIndex) => {
      const rule = line.castCommissions?.[castIndex] ?? line.commission;
      const commissionBase = equalShare(commissionSalesByLine[index], count, castIndex);
      const sales = keepPersonalSales ? equalShare(personalSalesByLine[index], count, castIndex) : commissionBase;
      const fixed = equalShare(rule.fixed * line.quantity, count, castIndex);
      const points = equalShare(Math.round(rule.points * pointsScale) * line.quantity, count, castIndex);
      const amount = fixed + exactRate(commissionBase, Math.round(rule.rate * 100));
      addCommission(commission, castId, sales, amount, points);
      commissionDetails.push({ castId, castName: line.castNames?.[castIndex] ?? null,
        lineId: line.id, name: line.name, createdAt: line.createdAt, sales, amount, points: points / pointsScale });
    });
  });
  for (const { castId, amount } of ticket.personalSalesAdjustments ?? []) {
    addCommission(commission, castId, amount, 0, 0);
  }

  const itemTax = itemTaxBreakdown.reduce((total, group) => total + group.tax, 0);
  const baseTotal = subtotal - discount + service + (inclusive ? 0 : itemTax);
  const tenders = [...ticket.payments, ...ticket.deposits];
  const depositPrincipal = totalOf(ticket.deposits);
  const deposit = totalDepositsReceived(ticket.deposits);
  const depositFee = deposit - depositPrincipal;
  const cardFeeRateBps = frozenFee ? frozenFee.cardFeeRateBps : tenders.find(({cardFee}) => cardFee > 0)?.cardFeeRateBps;
  const brandedFee = frozenFee ? frozenFee.brandedFee : tenders.some(({cardFee,brandId}) => cardFee > 0 && brandId);
  const cardFee = frozenFee ? frozenFee.cardFee ?? 0 : tenders.reduce((total, payment) => total + (payment.cardFee ?? 0), 0);
  const {breakdown:taxBreakdown, feeTax:cardFeeTax} = cardFee > 0
    ? addCardFeeTax(itemTaxBreakdown,cardFee,settings.taxRounding) : {breakdown:itemTaxBreakdown,feeTax:0};
  const tax = itemTax + cardFeeTax;
  const total = baseTotal + cardFee;
  const receivable = totalOf(ticket.payments.filter(({ method }) => method === 'receivable'));
  const paid = totalOf(ticket.payments) - receivable;
  return { subtotal, discount, service, tax, total, deposit, paid, ...(receivable > 0 ? { receivable } : {}),
    ...(lineDiscount > 0 && {lineDiscount}),
    ...(inclusive ? {priceMode:'inclusive'} : {}),
    ...(depositFee > 0 ? {depositFee} : {}),
    ...(cardFee > 0 ? {cardFee,cardFeeTax,baseTotal,cardFeeRateBps,...(brandedFee && {brandedFee:true})} : {}),
    remaining: Math.max(0, total - deposit - paid - receivable),
    commission: outputCommission(commission), commissionDetails, taxBreakdown };
}

export function getTicketCommissionDetails(state, ticketId) {
  const ticket = findTicket(state, ticketId);
  const adjustments = personalSalesAdjustmentDetails(ticket);
  if (!ticket.settlement) return [...calculateQuote(ticket).commissionDetails, ...adjustments];
  if (ticket.settlement.commissionDetails) return [...structuredClone(ticket.settlement.commissionDetails), ...adjustments];
  const calculated = calculateQuote(ticket);
  const stored = ticket.settlement.commission ?? [];
  const byCast = new Map(calculated.commission.map((entry) => [entry.castId, entry]));
  const matches = stored.length === byCast.size && stored.every(({castId, sales, amount, points}) => {
    const entry = byCast.get(castId);
    return entry && entry.sales === sales && entry.amount === amount && entry.points === points;
  });
  return matches ? [...calculated.commissionDetails, ...adjustments]
    : stored.map((entry) => ({ ...entry, castName: null, lineId: null, name: '伝票合計', createdAt: null }));
}

export function getTicketTableLabels(state, ticket) {
  if (ticket.tableLabels) return ticket.tableLabels;
  const ids = ticket.tableIds.length ? ticket.tableIds : (ticket.tableHistory ?? []).map(({tableId}) => tableId);
  return [...new Set(ids)].map((id) => getTableLabel(state, id));
}

function newStockMovement(state, stock, amount, kind, reason, now, ticketId = null, sourceLineId = null, unitCost = stock.unitCost) {
  const quantity = decimalUnits(stock.quantity) + decimalUnits(amount);
  assert(quantity >= 0, `${stock.name}の在庫が不足しています。`);
  const oldValue = stock.value;
  if (amount !== 0) {
    const newValue = quantity === 0 ? 0 : Math.max(0, oldValue + amount * unitCost);
    stock.quantity = quantity / movementScale;
    stock.value = Math.round(newValue * movementScale) / movementScale;
    stock.unitCost = quantity > 0 ? Math.round(stock.value / stock.quantity * movementScale) / movementScale : stock.unitCost;
  }
  const movement = { id: createId(state, 'stock'), stockId: stock.id, stockName: stock.name, quantity: amount,
    unit: stock.unit, unitCost, cost: Math.abs(oldValue - stock.value), valueChange: stock.value - oldValue,
    reason, kind, at: now, date: state.day.date, ticketId, sourceLineId };
  state.movements.unshift(movement);
  return movement;
}

function addLine(state, ticket, menu, quantity, castIds, now,
  { includeHistoricalCast = false, serviceExcluded = false, taxRateOverride } = {}) {
  const people = includeHistoricalCast
    ? [...(state.archivedCast ?? []), ...state.cast]
    : state.cast.filter((person) => person.enabled !== false);
  positiveInteger(quantity, '数量', includeHistoricalCast ? people.length : 100);
  const castById = new Map(people.map((person) => [person.id, person]));
  assert(Array.isArray(castIds) && new Set(castIds).size === castIds.length
    && castIds.every((id) => castById.has(id)), '歩合対象者を確認してください。');
  assert(!menu.requiresCast || castIds.length > 0, `${menu.name}の担当キャストを選択してください。`);
  if (!includeHistoricalCast) assertCastOnDuty(state,castIds,now);
  const catalogTaxRate = menu.taxRate ?? defaultItemTaxRateBps;
  const line = {
    id: createId(state, 'line'), menuId: menu.id, name: menu.name, category: menu.category, quantity, price: menu.price,
    ...(menu.printName && {printName:menu.printName}),
    ...(menu.hideReceiptLine === true && menu.price === 0 && {hideReceiptLine:true}),
    total: menu.price * quantity, castIds: castIds.slice(), createdAt: now, stockUses: [], cancelledAt: null,
    providedAt: null, taxRate: taxRateOverride ?? catalogTaxRate, serviceEligible: menu.serviceEligible !== false,
    ...(taxRateOverride !== undefined && taxRateOverride !== catalogTaxRate && { originalTaxRate: catalogTaxRate }),
    ...(serviceExcluded && {serviceExcluded:true}),
    commission: getItemCommission(menu), castNames: castIds.map((id) => castById.get(id).name),
    castCommissions: castIds.map((id) => getItemCommission(menu, castById.get(id))),
    ...(menu.requiresCast && { requiresCast: true }),
  };
  for (const use of menu.recipe ?? []) {
    const stock = state.stock.find((entry) => entry.id === use.stockId);
    const amount = decimalUnits(use.quantity) * quantity / movementScale;
    const unitCost = stock.unitCost;
    newStockMovement(state, stock, -amount, 'order', menu.name, now, ticket.id, line.id);
    line.stockUses.push({ stockId: stock.id, quantity: amount, unitCost });
  }
  ticket.lines.push(line);
  return line;
}

export function editTicketLineSnapshot(state, line, { quantity, castIds = line.castIds, price = line.price }, assignmentAt = line.createdAt) {
  positiveInteger(quantity, '数量');
  money(price, '単価');
  const currentMenu = state.menu.find(({ id }) => id === line.menuId);
  const requiresCast = line.requiresCast ?? currentMenu?.requiresCast ?? line.category === '指名';
  assert(Array.isArray(castIds) && new Set(castIds).size === castIds.length, '歩合対象者を確認してください。');
  assert(!requiresCast || castIds.length > 0, '担当キャストを選択してください。');
  const existing = new Map(line.castIds.map((id,index) => [id,index]));
  const people = new Map(state.cast.filter((person) => person.enabled !== false).map((person) => [person.id,person]));
  assert(castIds.every((id) => existing.has(id) || people.has(id)), '歩合対象者を確認してください。');
  assertCastOnDuty(state,castIds,assignmentAt,line.castIds);
  return { ...line, ...(price > 0 && line.hideReceiptLine === true && {hideReceiptLine:false}), quantity, price, total:quantity * price, castIds:[...castIds],
    castNames:castIds.map((id) => line.castNames?.[existing.get(id)] ?? people.get(id)?.name
      ?? state.archivedCast?.find((person) => person.id === id)?.name ?? id),
    castCommissions:castIds.map((id) => existing.has(id) ? line.castCommissions?.[existing.get(id)] ?? getItemCommission(line)
      : getItemCommission(line,people.get(id))) };
}

function reconcileEditedLineStock(state, ticket, original, updated, now) {
  const recipe = original.stockRecipe ?? original.stockUses.map((use) => ({
    stockId:use.stockId, unitsPerOrder:decimalUnits(use.quantity) / original.quantity,
  }));
  updated.stockRecipe = recipe;
  updated.stockUses = recipe.map(({ stockId, unitsPerOrder }) => {
    const use = original.stockUses.find((entry) => entry.stockId === stockId);
    const current = use ? decimalUnits(use.quantity) : 0;
    const billed = Math.round(unitsPerOrder * updated.quantity);
    const target = original.providedAt == null ? billed : Math.max(billed,current);
    if (current === target) return use;
    const stock = correctionStock(state,{stockId},false);
    const unitCost = target > current ? stock.unitCost : use.unitCost;
    newStockMovement(state,stock,(current - target) / movementScale,target > current ? 'order' : 'return',
      `${original.name}の数量訂正`,now,ticket.id,original.id,unitCost);
    const average = current && target > current ? (current * use.unitCost + (target - current) * unitCost) / target : unitCost;
    return {stockId,quantity:target / movementScale,unitCost:Math.round(average * movementScale) / movementScale};
  }).filter((use) => use?.quantity > 0);
}

function assertReducedTicketAmounts(state, ticket, actor, label) {
  const amounts = calculateQuote(ticket);
  const discountableSubtotal = getTicketDiscountableSubtotal(amounts);
  assert(discountableSubtotal >= ticket.discount, `${label}前に値引き額を調整してください。`);
  assert((amounts.baseTotal ?? amounts.total) >= totalOf(ticket.deposits), `${label}後の請求額が前受金を下回ります。`);
  if (actor.role === 'manager' && ticket.discountDetails?.managerLimitBps !== undefined) {
    assert(ticket.discount <= exactRate(discountableSubtotal,getManagerDiscountLimit(state)),
      `${label}後の値引きが承認上限を超えます。先に値引きを調整してください。`);
  }
}

function assertOrderLineDiscountFits(line) {
  assert(line.lineDiscount?.kind !== 'amount' || line.lineDiscount.value <= line.total, '明細値引きは明細の小計以下にしてください。');
}

function orderLineDiscount(state, actor, discount, reason) {
  assert(canApplyOrderLineDiscount(state,actor.role), '明細値引きには店舗設定と管理者権限が必要です。');
  assert(isValidOrderLineDiscount(discount), '明細値引きの金額または割合を確認してください。');
  operationalReason(discount.reason ?? reason,'明細値引きの理由');
  return {kind:discount.kind,value:discount.value};
}

function editLiveTicketLine(state, ticket, action, now, actor) {
  assert(['admin','manager'].includes(actor.role), '注文の訂正にはマネージャー以上の権限が必要です。');
  operationalReason(action.reason, '注文の訂正理由');
  const index = ticket.lines.findIndex((line) => line.id === action.lineId && line.cancelledAt === null);
  assert(index >= 0, '注文明細が見つかりません。');
  const line = ticket.lines[index];
  assert(line.category !== '延長', '延長の変更は一度取り消してから正しいプランを登録してください。');
  assert(line.category !== 'セット' || !action.castIds?.length, '初回セットには歩合対象者を指定できません。');
  const updated = editTicketLineSnapshot(state,line,action,now);
  if (action.taxRateOverride !== undefined) {
    assert(canOverrideOrderTax(state, actor.role), '明細の税率変更には店舗設定と管理者権限が必要です。');
    assert(action.taxRateOverride === null || isOrderTaxRateOverride(action.taxRateOverride), '明細の税率を確認してください。');
    const originalTaxRate = line.originalTaxRate ?? line.taxRate;
    updated.taxRate = action.taxRateOverride ?? originalTaxRate;
    if (updated.taxRate === originalTaxRate) delete updated.originalTaxRate;
    else updated.originalTaxRate = originalTaxRate;
  }
  const serviceChanged = action.serviceExcluded !== undefined && action.serviceExcluded !== (line.serviceExcluded === true);
  if (action.serviceExcluded !== undefined) assert(typeof action.serviceExcluded === 'boolean', 'サービス料の除外設定を確認してください。');
  if (serviceChanged) {
    assert(canExcludeOrderService(state, actor.role), 'サービス料の除外には店舗設定と管理者権限が必要です。');
    assert(line.serviceEligible === true, 'この明細はサービス料の対象外です。');
    if (action.serviceExcluded) updated.serviceExcluded = true;
    else delete updated.serviceExcluded;
  }
  if (action.lineDiscount === null) {
    assert(canApplyOrderLineDiscount(state,actor.role), '明細値引きには店舗設定と管理者権限が必要です。');
    delete updated.lineDiscount;
  } else if (action.lineDiscount !== undefined) {
    updated.lineDiscount = orderLineDiscount(state,actor,action.lineDiscount,action.reason);
  }
  assertOrderLineDiscountFits(updated);
  const oldDiscount = getOrderLineDiscountAmount(line);
  const newDiscount = getOrderLineDiscountAmount(updated);
  assert(oldDiscount === newDiscount || actor.role === 'admin', '明細値引き額が変わる訂正には管理者権限が必要です。');
  if (line.quantity !== updated.quantity) reconcileEditedLineStock(state,ticket,line,updated,now);
  ticket.lines[index] = updated;
  if (updated.total < line.total || newDiscount > oldDiscount || updated.taxRate !== line.taxRate || (serviceChanged && action.serviceExcluded)) {
    assertReducedTicketAmounts(state,ticket,actor,'訂正');
  }
}

function extendTicket(state, ticket, menu, now, automatic = false, assignments = [{menu,quantity:ticket.guests}]) {
  const surcharge = state.menu.find((entry) => entry.id === 'nominationExtra' && entry.enabled !== false);
  const relatedCast = [...new Set(ticket.lines.filter((line) => line.category === '指名'
    && (automatic ? line.createdAt <= now && (line.cancelledAt === null || line.cancelledAt > now) : line.cancelledAt === null))
    .flatMap((line) => line.castIds))];
  const added = assignments.map(({menu:plan,quantity}) => addLine(state, ticket, plan, quantity, [], now));
  if (surcharge && relatedCast.length) {
    added.push(addLine(state, ticket, surcharge, relatedCast.length, relatedCast, now, {includeHistoricalCast:true}));
  }
  for (const line of added) {
    if (line.menuId !== 'nominationExtra') line.extensionDuration = menu.duration;
    line.extensionGroupId = added[0].id;
  }
  if (automatic) {
    for (const line of added) line.autoExtension = true;
  }
  ticket.endsAt += menu.duration * minute;
}

function isSelectableExtension(plan) {
  return plan.category === '延長' && plan.enabled !== false && Number.isInteger(plan.duration);
}

function resolveExtensionAssignments(state, ticket, action) {
  if (action.plans === undefined) {
    const menu = state.menu.find((entry) => isSelectableExtension(entry)
      && (action.menuId === undefined ? entry.duration === Number(action.minutes) : entry.id === action.menuId));
    assert(menu, '延長時間を選択してください。');
    return [{menu,quantity:ticket.guests}];
  }
  assert(Array.isArray(action.plans) && action.plans.length > 0 && action.plans.length <= 24,
    '延長プランを選択してください。');
  const assignments = action.plans.map((plan) => {
    const menu = state.menu.find((entry) => isSelectableExtension(entry) && entry.id === plan?.menuId);
    assert(menu, '利用できる延長プランを選択してください。');
    return {menu,quantity:positiveInteger(plan.quantity,'延長する人数')};
  });
  assert(new Set(assignments.map(({menu}) => menu.id)).size === assignments.length, '同じ延長プランが重複しています。');
  assert(new Set(assignments.map(({menu}) => menu.duration)).size === 1, '組み合わせる延長プランは同じ延長時間にしてください。');
  assert(assignments.reduce((sum,{quantity}) => sum + quantity,0) === ticket.guests,
    'プラン別の人数合計を現在の利用人数と一致させてください。');
  return assignments;
}

function cancelTicketExtension(state, ticket, action, now, actor) {
  assert(['admin','manager'].includes(actor.role), '延長取消にはマネージャー以上の権限が必要です。');
  operationalReason(action.reason, '延長の取消理由');
  const index = ticket.lines.findIndex((line) => line.id === action.lineId && line.cancelledAt === null
    && line.category === '延長' && line.menuId !== 'nominationExtra');
  assert(index >= 0, '延長明細が見つかりません。');
  const line = ticket.lines[index];
  const nextLine = ticket.lines[index + 1];
  const group = line.extensionGroupId ? ticket.lines.filter((item) => item.extensionGroupId === line.extensionGroupId && item.cancelledAt === null)
    : [line, ...(nextLine?.menuId === 'nominationExtra' && nextLine.createdAt === line.createdAt && nextLine.cancelledAt === null ? [nextLine] : [])];
  for (const item of group) {
    for (const use of item.providedAt == null ? item.stockUses : []) {
      const stock = correctionStock(state,use,false);
      newStockMovement(state,stock,use.quantity,'return',`${item.name}の延長取消`,now,ticket.id,item.id,use.unitCost);
    }
    item.cancelledAt = now;
  }
  assertReducedTicketAmounts(state,ticket,actor,'取消');
  const duration = line.extensionDuration ?? state.menu.find(({ id }) => id === line.menuId)?.duration;
  if (Number.isInteger(duration) && duration > 0) ticket.endsAt = Math.max(ticket.setStartedAt ?? ticket.createdAt,ticket.endsAt - duration * minute);
  if (ticket.endsAt <= now) ticket.autoExtensionResumedAt = Math.max(ticket.autoExtensionResumedAt ?? 0,now);
}

export const maxOverdueExtensionCount = 100;

export function getOverdueExtensionCount(ticket, plan, now = Date.now()) {
  if (ticket?.status !== 'open' || !Number.isSafeInteger(ticket.endsAt)
    || !Number.isInteger(plan?.duration) || plan.duration <= 0) return 0;
  return Math.ceil(Math.max(0, now - ticket.endsAt) / (plan.duration * minute));
}

function currentDay(state) {
  assert(state.day.status === 'open', '最初に開店してください。');
}

function validateMethod(method, { allowReceivable = false } = {}) {
  assert(methods.includes(method) || (allowReceivable && method === 'receivable'), '支払方法を選択してください。');
}

function validBusinessDate(date) {
  return typeof date === 'string' && /^\d{4}-\d\d-\d\d$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date;
}

function requireReceivableAccess(state, customer, actor) {
  assert(actor.role === 'admin' || (actor.role === 'manager' && isAssignedCustomer(state, customer, actor.id)),
    '売掛は店舗管理者または担当マネージャーが処理できます。');
}

function issueReceivable(state, ticket, action, amount, now, actor) {
  const customer = findCustomer(state, ticket.customerId);
  assert(customer, '売掛会計には登録済みの顧客が必要です。');
  requireReceivableAccess(state, customer, actor);
  assert(customer.creditEnabled === true, 'この顧客の売掛利用を許可してください。');
  const dueDate = action.creditDueDate;
  assert(validBusinessDate(dueDate) && dueDate >= state.day.date, '営業日以降の有効な支払期日を入力してください。');
  const creditLimit = money(customer.creditLimit, '与信上限');
  const balance = getCustomerReceivableBalance(state, customer.id);
  let creditOverride;
  if (balance + amount > creditLimit) {
    assert(actor.role === 'admin', '与信上限の超過には店舗管理者の承認が必要です。');
    const reason = operationalReason(action.creditOverrideReason, '与信上限を超える理由');
    creditOverride = { actorId: actor.id, reason, creditLimit, balanceBefore: balance };
  }
  state.receivables ??= [];
  state.receivables.unshift({ id: createId(state, 'receivable'), customerId: customer.id, ticketId: ticket.id,
    ticketNumber: ticket.number, issuedAt: now, date: state.day.date, dueDate, amount, collections: [],
    cancelledAt: null, ...(creditOverride ? { creditOverride } : {}) });
}

function recoverReceivable(state, action, now, actor) {
  currentDay(state);
  const entry = state.receivables?.find(({ id }) => id === action.receivableId);
  assert(entry && entry.cancelledAt == null, '回収できる売掛伝票が見つかりません。');
  const customer = findCustomer(state, entry.customerId);
  assert(customer, '売掛先の顧客が見つかりません。');
  requireReceivableAccess(state, customer, actor);
  assert(action.date === state.day.date && action.date >= entry.date, '回収日は現在の営業日を指定してください。');
  assert(Object.hasOwn(receivableCollectionMethods, action.method), '回収方法を選択してください。');
  const amount = money(action.amount, '売掛回収額', false);
  assert(amount <= getReceivableBalance(entry), '回収額は売掛残高以下を入力してください。');
  entry.collections.push({ id: createId(state, 'collection'), amount, method: action.method, date: action.date, at: now });
}

function canCancel(ticket) {
  assert(totalOf(ticket.deposits) === 0, '先に前受金を取り消してください。');
}

function doOpen(state, action, now) {
  assert(state.day.status === 'closed', 'すでに営業中です。');
  const date = action.date ?? businessDate(now,registerCutoff(state));
  assert(validBusinessDate(date), '営業日を指定してください。');
  assert(!state.closedDays.some((day) => day.date === date), 'この営業日は締め済みです。次の営業日を入力してください。');
  const previous = state.closedDays.find((day) => day.date === state.day.date);
  if (previous && !previous.ticketSnapshots && state.tickets.length) {
    previous.ticketSnapshots = snapshotClosedTickets(state);
  }
  state.tickets = [];
  const openingCash = money(action.openingCash,'釣銭準備金');
  const openingExpected = openingCashSuggestion(state,date);
  state.day = { status: 'open', date, openingCash, openedAt: now,
    ...(state.controls?.register && {openingExpected,openingDifference:openingCash - openingExpected}),
    closedAt: null, closingCash: null };
}

function doSeat(state, action, now, actor) {
  currentDay(state);
  const guests = positiveInteger(action.guests, '来店人数');
  const tableIds = tableSet(state, action.tableIds, guests);
  const set = state.menu.find((entry) => entry.id === action.setId && entry.category === 'セット' && entry.enabled !== false);
  assert(set, '初回セットを選択してください。');
  const customer = customerForSeat(state, action);
  const calculationSettings = getCalculationSettings(state);
  const arrivedAt = action.arrivedAt ?? now;
  assert(Number.isSafeInteger(arrivedAt) && arrivedAt <= now && arrivedAt >= now - 24 * 60 * minute,
    '来店時刻は現在から24時間以内の過去を指定してください。');
  const ticket = {
    id: createId(state, 'ticket'), number: state.nextTicket++, tableIds, guests,
    tableHistory: tableIds.map((tableId) => ({ tableId, attachedAt: now, releasedAt: null })),
    ...customer, ...(customer.customerId ? { seatedByUid: actor.id } : {}), createdAt: arrivedAt, status: 'open',
    ...(arrivedAt !== now && { seatRecordedAt: now, autoExtensionResumedAt: now }),
    endsAt: arrivedAt + set.duration * minute, lines: [], discount: 0, deposits: [], payments: [], settledAt: null,
    departedAt: null, serviceRate: calculationSettings.serviceRateBps, calculationSettings, settlement: null,
  };
  state.tickets.push(ticket);
  addLine(state, ticket, set, guests, [], now);
}

function doClose(state, action, now) {
  currentDay(state);
  assert(!state.tickets.some((ticket) => occupiedStatuses.has(ticket.status)), '使用中または退店待ちの卓があります。');
  const actualCash = money(action.actualCash, '実残高');
  const cashDenominations = action.cashDenominations;
  assert(cashDenominations === undefined || getCashCountTotal(cashDenominations) === actualCash,
    '金種別に数えた合計をレジの実残高と一致させてください。');
  const totals = summary(state);
  const discrepancy = actualCash - totals.expectedCash;
  const reason = discrepancy ? operationalReason(action.reason, 'レジ差額の理由')
    : (typeof action.reason === 'string' ? action.reason.trim().slice(0, 120) : '');
  state.day = { ...state.day, status: 'closed', closedAt: now, closingCash: actualCash };
  state.closedDays.unshift({ date: state.day.date, openedAt: state.day.openedAt, closedAt: now,
    openingCash: state.day.openingCash, actualCash, expectedCash: totals.expectedCash, discrepancy, reason,
    sales: totals.sales, guests: totals.guests, tickets: totals.tickets, commission: totals.commission, payments: totals.payments,
    receivableSales: totals.receivableSales, recoveries: totals.recoveries, recoveryRows: structuredClone(totals.recoveryRows),
    tenderPayments: totals.tenderPayments, depositsReceived: totals.depositsReceived, depositsApplied: totals.depositsApplied,
    cashIn: totals.cashIn, cashOut: totals.cashOut, expenses: totals.expenses, cashMovements: structuredClone(totals.cashMovements),
    ...(cashDenominations === undefined ? {} : {cashDenominations:structuredClone(cashDenominations)}),
    ...(state.day.openingExpected !== undefined && {openingExpected:state.day.openingExpected,openingDifference:state.day.openingDifference}),
    ticketSnapshots: snapshotClosedTickets(state) });
}

function amendCashMovement(state, action, now, actor) {
  assert(actor.role === 'admin' || actor.role === 'manager', 'マネージャー以上の権限が必要です。');
  const original = editableCashMovement(state,action.movementId);
  assert(original, '訂正できる入出金を選択してください。');
  const archive = state.closedDays.find(({date}) => date === original.date);
  assert(archive ? actor.role === 'admin' : original.date === state.day.date && state.day.status === 'open',
    '締め後の訂正には店舗管理者の権限が必要です。');
  if (archive) assert(archive.cashMovements?.some(({id}) => id === original.id) && Number.isSafeInteger(archive.expectedCash)
    && Number.isSafeInteger(archive.actualCash), '締め日の入出金内訳が不足しています。');
  const why = operationalReason(action.correctionReason,'入出金の訂正理由');
  const replacement = action.type === 'voidCashMovement'
    ? {...original,voidedAt:now,voidReason:why}
    : createCashMovement({...state,day:{status:'open',date:original.date}},action,original.at,original.actor,() => original.id);
  assert(replacement.cashAccountKind !== 'vault','金庫移動は新しい入出金として登録してください。');
  const replace = (rows) => rows?.map((row) => row.id === original.id ? replacement : row);
  if (state.cashMovements) state.cashMovements = replace(state.cashMovements);
  if (archive) {
    const cashBefore = totalCashMovements([original]);
    const cashAfter = totalCashMovements([replacement]);
    archive.cashMovements = replace(archive.cashMovements);
    for (const key of ['cashIn','cashOut','expenses']) archive[key] = (archive[key] ?? 0) - cashBefore[key] + cashAfter[key];
    archive.expectedCash += cashAfter.cashIn - cashBefore.cashIn - cashAfter.cashOut + cashBefore.cashOut;
    archive.discrepancy = archive.actualCash - archive.expectedCash;
  }
}

function amendRegisterCount(state, action, actor) {
  assert(actor.role === 'admin', '閉店時の実残高を訂正できるのは店舗管理者です。');
  const close = state.closedDays.find(({date}) => date === action.date);
  assert(close && Number.isSafeInteger(close.expectedCash), '訂正する締め日報が見つかりません。');
  const reason = operationalReason(action.reason,'レジ実残高の訂正理由');
  const actualCash = money(action.actualCash,'実残高');
  const counts = action.cashDenominations;
  assert(counts === undefined || getCashCountTotal(counts) === actualCash,'金種別の合計と実残高を一致させてください。');
  Object.assign(close,{actualCash,discrepancy:actualCash - close.expectedCash,reason});
  if (counts) close.cashDenominations = structuredClone(counts);
  else delete close.cashDenominations;
  if (state.day.date === close.date && state.day.status === 'closed') state.day.closingCash = actualCash;
}

function castNamesById(state) {
  return new Map([...(state.archivedCast ?? []), ...state.cast].map(({id, name}) => [id, name]));
}

function snapshotSettledTicket(state, ticket, people) {
  const snapshot = structuredClone(ticket);
  snapshot.tableLabels = getTicketTableLabels(state, ticket).slice();
  for (const line of snapshot.lines) {
    line.castNames ??= line.castIds.map((id) => people.get(id) ?? id);
  }
  snapshot.settlement ??= quote(state, ticket.id);
  return snapshot;
}

function snapshotClosedTickets(state) {
  const people = castNamesById(state);
  return state.tickets.filter(({status}) => status === 'paid' || status === 'departed')
    .map((ticket) => snapshotSettledTicket(state, ticket, people));
}

function correctionReason(reason, actor) {
  assert(actor?.role === 'admin', '会計の取消と伝票の再オープンは店舗管理者が行えます。');
  const note = typeof reason === 'string' ? reason.trim() : '';
  assert(note.length > 0 && note.length <= 120, '理由を120字以内で入力してください。');
  return note;
}

function tallySettlementPayments(payments) {
  const totals = { cash: 0, card: 0, qr: 0, receivable: 0 };
  for (const { method, amount } of payments) {
    assert(Object.hasOwn(totals, method), '登録済みの支払方法を確認してください。');
    totals[method] += amount;
  }
  return totals;
}

function updateClosedPaymentTotals(state, day, difference) {
  // Older closing records may have combined tender and deposits only.
  for (const totals of [day.payments, day.tenderPayments]) {
    if (!totals) continue;
    for (const method of methods) {
      const amount = (totals[method] ?? 0) + difference[method];
      assert(Number.isSafeInteger(amount) && amount >= 0, '締め日の支払集計と伝票の支払額が一致しません。');
      totals[method] = amount;
    }
  }
  if (day.receivableSales != null) {
    const amount = day.receivableSales + difference.receivable;
    assert(Number.isSafeInteger(amount) && amount >= 0, '締め日の売掛集計と伝票の売掛額が一致しません。');
    day.receivableSales = amount;
  } else if (difference.receivable !== 0) {
    day.receivableSales = totalOf((state.receivables ?? []).filter((entry) => entry.date === day.date && entry.cancelledAt == null));
  }
  if (Number.isSafeInteger(day.expectedCash) && difference.cash !== 0) {
    day.expectedCash += difference.cash;
    if (Number.isSafeInteger(day.actualCash)) day.discrepancy = day.actualCash - day.expectedCash;
  }
}

function correctSettledTicketPayments(state, action, now, actor) {
  assert(actor.role === 'admin', '支払方法の訂正には店舗管理者の権限が必要です。');
  const reason = operationalReason(action.reason, '訂正理由');
  const entry = findSettledCustomerTicket(state, action.ticketId);
  assert(entry, '会計済みの伝票を選んでください。');
  const { ticket, date } = entry;
  const originalTotal = getSettledTicketPaymentTotal(ticket);
  assert(originalTotal > 0, '訂正できる会計時の支払記録がありません。');
  const settlement = ticket.settlement ?? calculateQuote(ticket);
  assert(Number.isSafeInteger(originalTotal) && settlement.total === originalTotal + totalDepositsReceived(ticket.deposits),
    '会計額と登録済みの支払額が一致しません。');
  assert(Array.isArray(action.payments) && action.payments.length > 0 && action.payments.length <= 10,
    '支払内容を確認してください。');
  for (const payment of action.payments) {
    validateMethod(payment?.method, { allowReceivable: true });
    assert(Number.isSafeInteger(payment.amount) && payment.amount > 0,
      `${methodLabel[payment.method]}の支払額を1円以上の整数で入力してください。`);
  }
  assert(totalOf(action.payments) === originalTotal, '支払額の合計を訂正前の支払額に一致させてください。');
  const previous = tallySettlementPayments(ticket.payments);
  const updated = tallySettlementPayments(action.payments);
  const difference = Object.fromEntries(Object.keys(previous).map((method) => [method, updated[method] - previous[method]]));
  assert(Object.values(difference).some((amount) => amount !== 0), '訂正する支払方法か金額を変更してください。');

  correctSettledTicketReceivable(state, ticket, { ...action, reason }, {
    amount: updated.receivable, date, now, actor, createId: () => createId(state, 'receivable'),
  });
  const paidAt = ticket.settledAt ?? ticket.payments[0].at ?? now;
  const payments = action.payments.map(({ method, amount }) => ({ id: createId(state, 'payment'), method, amount, at: paidAt }));
  const closed = state.closedDays.find((day) => day.date === date);
  const snapshot = closed?.ticketSnapshots?.find(({ id }) => id === ticket.id);
  // Keep the original bill and its surcharge, taxes and commission while replacing the tender breakdown.
  const applyToTicket = (record) => {
    record.payments = structuredClone(payments);
    if (difference.cash !== 0) delete record.cashTender;
    record.paymentsCorrectedAt = now;
    record.settlement ??= structuredClone(settlement);
    record.settlement.paid = originalTotal - updated.receivable;
    if (updated.receivable > 0) record.settlement.receivable = updated.receivable;
    else delete record.settlement.receivable;
  };
  applyToTicket(ticket);
  if (snapshot && snapshot !== ticket) applyToTicket(snapshot);
  if (closed) updateClosedPaymentTotals(state, closed, difference);
}

export function previewSettledContents(state, ticket, action) {
  const old = ticket.settlement ?? calculateQuote(ticket);
  const revised = {...ticket,lines:ticket.lines.slice(),discount:action.discount ?? ticket.discount,payments:[]};
  if (action.lineId) {
    const index = revised.lines.findIndex((line) => line.id === action.lineId && line.cancelledAt == null);
    assert(index >= 0, '訂正する注文明細が見つかりません。');
    const line = revised.lines[index];
    assert(line.category !== '延長' && (line.category !== 'セット' || !action.castIds?.length),
      'この明細は訂正できません。延長は会計取消後に訂正してください。');
    if (action.cancelLine) {
      assert(line.category !== 'セット', '初回セットは数量または単価で訂正してください。');
      revised.lines[index] = {...line,cancelledAt:action.at ?? ticket.settledAt};
    } else {
      revised.lines[index] = editTicketLineSnapshot(state,line,action);
      assertOrderLineDiscountFits(revised.lines[index]);
    }
  }
  money(revised.discount,'値引き');
  const totals = calculateQuote(revised,old);
  assert(revised.discount <= getTicketDiscountableSubtotal(totals),'値引き額を小計以下にしてください。');
  assert((totals.baseTotal ?? totals.total) >= totalOf(ticket.deposits),'訂正後の合計が前受金を下回っています。');
  return {revised,totals,old,change:totals.total - old.total};
}

function correctSettledContents(state, action, now, actor) {
  assert(actor.role === 'admin','会計後の明細訂正は店舗管理者が行えます。');
  const reason = operationalReason(action.reason,'会計後の訂正理由');
  const entry = findSettledCustomerTicket(state,action.ticketId);
  assert(entry,'会計済みの伝票を選んでください。');
  const {ticket,date} = entry;
  const {revised,totals,old,change} = previewSettledContents(state,ticket,{...action,at:now});
  assert(revised.discount !== ticket.discount || JSON.stringify(revised.lines) !== JSON.stringify(ticket.lines),
    '訂正する内容を入力してください。');
  assert((old.receivable ?? 0) === 0 && !ticket.payments.some(({method})=>method === 'receivable'),
    'この伝票は会計後の明細訂正の対象外です。');
  assert(action.expectedTotal === totals.total,'請求額が更新されました。最新の訂正内容を確認してください。');
  assert(totalOf(ticket.payments) + totalDepositsReceived(ticket.deposits) === old.total,'元の会計額と決済内訳を確認してください。');
  const previousCommission = new Map(old.commission.map((row) => [row.castId,JSON.stringify(row)]));
  const nextCommission = new Map(totals.commission.map((row) => [row.castId,JSON.stringify(row)]));
  assert(!(state.payroll?.records ?? []).some(({month,castId,status}) => status === 'final' && month === date.slice(0,7)
    && previousCommission.get(castId) !== nextCommission.get(castId)), '確定済み給与に影響するため、翌月の給与で調整してください。');

  const closed = state.closedDays.find((day) => day.date === date);
  const closedTicket = closed?.ticketSnapshots?.find(({id}) => id === ticket.id);
  assert(!closed || (closedTicket && closed.ticketSnapshots.length === closed.tickets && Number.isSafeInteger(closed.sales)),
    '締め日報の伝票明細が不足しています。');
  const original = ticket.lines.find(({id}) => id === action.lineId);
  const changed = revised.lines.find(({id}) => id === action.lineId);
  if (original && action.cancelLine && action.returnStock && original.providedAt == null) {
    for (const use of original.stockUses) {
      const stock = correctionStock(state,use,false);
      newStockMovement(state,stock,use.quantity,'return',reason,now,ticket.id,original.id,use.unitCost);
    }
  } else if (original && !action.cancelLine && original.quantity !== changed.quantity) {
    const preserveStock = action.returnStock !== true && changed.quantity < original.quantity;
    reconcileEditedLineStock(state,ticket,preserveStock ? {...original,providedAt:now} : original,changed,now);
  }
  let payments = ticket.payments;
  if (change) {
    validateMethod(action.adjustmentMethod);
    const allocations = tallySettlementPayments(ticket.payments);
    allocations[action.adjustmentMethod] += change;
    assert(allocations[action.adjustmentMethod] >= 0, '選んだ決済方法の返金額が元の支払額を超えます。');
    payments = methods.filter((method) => allocations[method] > 0).map((method) =>
      ({id:createId(state,'payment'),method,amount:allocations[method],at:ticket.settledAt ?? now}));
    assert((old.cardFee ?? 0) === (old.depositFee ?? 0) || payments.length > 0,'決済加算がある会計では、会計時の入金を残してください。');
  }
  const difference = Object.fromEntries([...methods,'receivable'].map((method) => [method,
    totalOf(payments.filter((row) => row.method === method)) - totalOf(ticket.payments.filter((row) => row.method === method))]));
  Object.assign(totals,{paid:totalOf(payments),remaining:0});
  const update = (row) => {
    row.lines = structuredClone(revised.lines);
    row.payments = structuredClone(payments);
    row.discount = revised.discount;
    if (revised.discount !== ticket.discount) delete row.discountDetails;
    row.settlement = structuredClone(totals);
    row.settlementRevision = (row.settlementRevision ?? 0) + 1;
    if (change && payments.length) row.paymentsCorrectedAt = now;
    if (change && !payments.length) delete row.paymentsCorrectedAt;
    if (difference.cash) delete row.cashTender;
  };
  if (revised.discount !== ticket.discount) {
    delete ticket.discountDetails;
    if (closedTicket) delete closedTicket.discountDetails;
  }
  update(ticket);
  if (closedTicket && closedTicket !== ticket) update(closedTicket);
  if (closed) {
    closed.sales += change;
    updateClosedPaymentTotals(state,closed,difference);
    const dayCommission = new Map();
    for (const row of closed.ticketSnapshots.flatMap(({settlement}) => settlement?.commission ?? [])) {
      addCommission(dayCommission,row.castId,row.sales,row.amount,Math.round(row.points * pointsScale));
    }
    closed.commission = outputCommission(dayCommission);
  }
}

function correctionStock(state, use, restoreArchived) {
  const stock = state.stock.find(({ id }) => id === use.stockId);
  if (stock) return stock;
  const archived = state.archivedStock?.find(({ id }) => id === use.stockId);
  assert(restoreArchived && archived, '注文明細に対応する在庫品目が見つかりません。在庫の設定を確認してください。');
  const restored = { ...archived, category: 'その他', quantity: 0, value: 0, minimum: 0,
    unitCost: use.unitCost, defaultUnitCost: use.unitCost, hidden: true };
  state.stock.push(restored);
  state.archivedStock = state.archivedStock.filter(({ id }) => id !== use.stockId);
  return restored;
}

function reverseSettlement(state, ticket, action, now, actor) {
  const reason = correctionReason(action.reason, actor);
  assert(ticket.status === 'paid' || ticket.status === 'departed', '確定した会計を選択してください。');
  const receivable = state.receivables?.find((entry) => entry.ticketId === ticket.id && entry.cancelledAt == null);
  assert(!ticket.payments.some(({ method }) => method === 'receivable') || receivable,
    '会計に対応する売掛記録が見つかりません。');
  assert(!receivable?.collections.length, '回収済みの金額がある売掛会計は取り消せません。');
  const receipt = snapshotSettledTicket(state, ticket, castNamesById(state));
  for (const line of ticket.lines.filter(({ cancelledAt }) => cancelledAt === null)) {
    for (const use of line.stockUses ?? []) {
      assert(use.quantity > 0 && Number.isFinite(use.unitCost) && use.unitCost >= 0, '出庫時の在庫記録を確認してください。');
      const stock = correctionStock(state, use, true);
      newStockMovement(state, stock, use.quantity, 'return', `${line.name}の会計取消`, now, ticket.id, line.id, use.unitCost);
    }
  }
  state.cancelledSettlements ??= [];
  state.cancelledSettlements.unshift({ id: createId(state, 'settlement-cancel'), ticketId: ticket.id,
    ticketNumber: ticket.number, date: state.day.date, at: now, reason, receipt });
  if (receivable) receivable.cancelledAt = now;
  recordTableAssignment(ticket, [], now);
  ticket.deposits = [];
  ticket.payments = [];
  delete ticket.cashTender;
  delete ticket.paymentsCorrectedAt;
  delete ticket.settledBy;
  ticket.settlement = null;
  ticket.settledAt = null;
  ticket.status = 'cancelled';
}

function reopenTicket(state, ticket, action, now, actor) {
  correctionReason(action.reason, actor);
  const wasVoid = ticket.status === 'void';
  assert(wasVoid || ticket.status === 'cancelled', '会計を取り消した伝票、または未会計で取り消した伝票を選択してください。');
  assert(wasVoid || state.cancelledSettlements?.some((entry) => entry.ticketId === ticket.id && entry.date === state.day.date),
    '会計の取消履歴を確認してください。');
  const tableIds = tableSet(state, action.tableIds, ticket.guests, ticket.id);
  const restocked = wasVoid ? new Set(ticket.voidRestockedLineIds ?? state.movements
    .filter(({kind,ticketId,reason}) => kind === 'return' && ticketId === ticket.id && reason?.endsWith('の伝票取消'))
    .map(({sourceLineId}) => sourceLineId)) : null;
  for (const line of ticket.lines.filter(({ id,cancelledAt }) => cancelledAt === null && (!restocked || restocked.has(id)))) {
    for (const use of line.stockUses ?? []) {
      const stock = correctionStock(state, use, false);
      use.unitCost = stock.unitCost;
      newStockMovement(state, stock, -use.quantity, 'order', `${line.name}の伝票再オープン`, now, ticket.id, line.id, use.unitCost);
    }
  }
  recordTableAssignment(ticket, tableIds, now);
  ticket.tableIds = tableIds;
  ticket.status = 'open';
  ticket.departedAt = null;
  ticket.autoExtensionResumedAt = now;
  delete ticket.voidRestockedLineIds;
}

function doStockAdjust(state, action, now, actor) {
  assert(['admin', 'manager'].includes(actor.role), '在庫の変更には管理者またはマネージャー権限が必要です。');
  const stock = state.stock.find((entry) => entry.id === action.stockId);
  assert(stock, '在庫品目が見つかりません。');
  const adjust = action.type === 'stockAdjust';
  const kind = adjust ? 'adjust' : action.kind;
  assert(adjust || ['purchase', 'purchaseCancellation', 'loss', 'usage', 'stocktake'].includes(kind), '在庫の操作区分を確認してください。');
  const reason = operationalReason(action.reason, '調整理由');

  if (kind === 'purchaseCancellation') {
    const purchase = state.movements.find(({id,stockId}) => id === action.purchaseId && stockId === stock.id);
    const {quantity,value,unitCost,valueChange} = replayPurchaseCancellation(state,stock,purchase);
    const amount = Math.round((quantity - stock.quantity) * movementScale) / movementScale;
    Object.assign(stock,{quantity,value,unitCost});
    const movement = {id:createId(state,'stock'),stockId:stock.id,stockName:stock.name,unit:stock.unit,kind,reason,
      quantity:amount,unitCost,cost:Math.abs(valueChange),valueChange,reversesId:purchase.id,at:now,date:operationBusinessDate(state,now),
      ticketId:null,sourceLineId:null};
    state.movements.unshift(movement);
    return;
  }

  if (kind === 'stocktake') {
    const bookQuantity = stock.quantity;
    const bookUnits = decimalUnits(bookQuantity);
    assert(decimalUnits(action.bookQuantity) === bookUnits, '帳簿在庫が更新されました。棚卸を開き直してください。');
    const actualUnits = decimalUnits(action.actualQuantity);
    assert(actualUnits >= 0, '実際に数えた在庫を0以上で入力してください。');
    const movement = newStockMovement(state, stock, (actualUnits - bookUnits) / movementScale, kind, reason, now);
    Object.assign(movement, { bookQuantity, actualQuantity: actualUnits / movementScale });
    return;
  }

  const inputUnits = decimalUnits(action.quantity);
  assert(adjust ? inputUnits !== 0 : inputUnits > 0, adjust ? '数量の増減を入力してください。' : '数量を正の数で入力してください。');
  const units = kind === 'loss' || kind === 'usage' ? -inputUnits : inputUnits;
  if (kind === 'purchase') {
    const price = action.unitCost;
    assert(Number.isFinite(price) && price >= 0 && price <= 100_000_000
      && Math.abs(Math.round(price * movementScale) / movementScale - price) < 0.00000001,
    '仕入単価を小数点以下6桁までの0以上の金額で入力してください。');
    assert(action.adoptUnitCost === undefined || typeof action.adoptUnitCost === 'boolean','参考単価の更新を確認してください。');
    const movement = newStockMovement(state, stock, units / movementScale, kind, reason, now, null, null, price);
    if (action.adoptUnitCost) {
      movement.previousReferenceUnitCost = stock.defaultUnitCost ?? stock.unitCost;
      stock.defaultUnitCost = price;
    }
    return;
  }
  const unitCost = units > 0 ? stock.defaultUnitCost ?? stock.unitCost : stock.unitCost;
  newStockMovement(state, stock, units / movementScale, kind, reason, now, null, null, unitCost);
}

function layoutName(value, label) {
  const name = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  assert(name.length > 0 && name.length <= layoutNameMaxLength && !/[\p{Cc}\u2028\u2029]/u.test(name),
    `${label}は1〜${layoutNameMaxLength}文字で入力してください。`);
  return name;
}

function layoutNameKey(name) {
  return name.normalize('NFKC').toLowerCase();
}

export function removeLayoutArea(areas, tables, area) {
  const target = typeof area === 'string' ? layoutNameKey(area.trim()) : '';
  const isTarget = (name) => typeof name === 'string' && layoutNameKey(name.trim()) === target;
  assert(target && areas.some(isTarget), '指定されたエリアが見つかりません。');
  assert(!tables.some((table) => isTarget(table.area)),
    '卓があるエリアは削除できません。先に卓を移動するか削除してください。');
  return areas.filter((name) => !isTarget(name));
}

function validateLayout(areas, tables, findCurrentTable) {
  assert(Array.isArray(tables), 'すべての卓の配置を指定してください。');
  assert(Array.isArray(areas) && (areas.length > 0 || tables.length === 0),
    '卓が残っている間は、エリアを1つ以上指定してください。');
  const areasByKey = new Map();
  for (const entry of areas) {
    const area = layoutName(entry, 'エリア名');
    const key = layoutNameKey(area);
    assert(!areasByKey.has(key), `エリア名「${area}」が重複しています。`);
    areasByKey.set(key, area);
  }

  const updatedById = new Map();
  const namesByArea = new Map();
  for (const placement of tables) {
    const id = placement?.id;
    assert(!updatedById.has(id), '卓の指定が重複しています。');
    const current = findCurrentTable(id);
    const { x, y, capacity } = placement;
    const name = layoutName(placement.name === undefined ? current?.name : placement.name, '卓名');
    const area = areasByKey.get(layoutNameKey(layoutName(placement.area, 'エリア名')));
    assert(area, `${name}のエリアを確認してください。`);
    assert(isLayoutPosition(x, y), `${name}をフロアの範囲内に配置してください。`);
    positiveInteger(capacity, `${name}の定員`);
    const names = namesByArea.get(area) ?? new Set();
    const nameKey = layoutNameKey(name);
    assert(!names.has(nameKey), `${area}の卓名「${name}」が重複しています。`);
    names.add(nameKey);
    namesByArea.set(area, names);
    for (const other of updatedById.values()) {
      const overlaps = area === other.area && Math.abs(x - other.x) < layoutGrid.tableWidth
        && Math.abs(y - other.y) < layoutGrid.tableHeight;
      assert(!overlaps, `${name}と${other.name}の配置が重なっています。`);
    }
    updatedById.set(id, { ...current, id, name, area, x, y, capacity });
  }
  return { areas: [...areasByKey.values()], tables: updatedById };
}

function doSaveLayout(state, { areas, tables }, allowSampleTableIds = false) {
  const legacySave = areas === undefined;
  assert(!legacySave || (Array.isArray(tables) && tables.length === state.tables.length),
    'すべての卓の配置を指定してください。');
  const existing = getLayoutTables(state);
  const tablesById = new Map(existing.map((table) => [table.id, table]));
  const archive = state.archivedTables ?? [];
  const archivedIds = new Set(archive.map((table) => table.id));
  const layout = validateLayout(legacySave ? getLayoutAreas(state) : areas, tables, (id) => {
    const current = tablesById.get(id);
    assert(current || (!legacySave && typeof id === 'string' && !archivedIds.has(id)
      && (newTableId.test(id) || (allowSampleTableIds && sampleTableIds.has(id)))), '卓IDが無効か、削除済みです。');
    return current;
  });
  const updatedById = layout.tables;
  for (const ticket of state.tickets) {
    if (!occupiedStatuses.has(ticket.status)) continue;
    let capacity = 0;
    for (const id of ticket.tableIds) {
      const table = updatedById.get(id);
      assert(table, `${getTableLabel(state, id)}は使用中か退店待ちのため削除できません。`);
      capacity += table.capacity;
    }
    assert(capacity >= ticket.guests, `伝票 No. ${ticket.number} の利用人数より合計定員が少なくなります。`);
  }

  state.layoutAreas = layout.areas;
  state.archivedTables = [...archive, ...existing.filter((table) => !updatedById.has(table.id))];
  state.tables = [...existing.map((table) => updatedById.get(table.id)).filter(Boolean),
    ...[...updatedById.values()].filter((table) => !tablesById.has(table.id))];
  if (state.tableAutoExtension) {
    const retained = Object.entries(state.tableAutoExtension).filter(([id]) => updatedById.has(id));
    if (retained.length) state.tableAutoExtension = Object.fromEntries(retained);
    else delete state.tableAutoExtension;
  }
}

function normalizeLayoutFile(file) {
  assert(file?.format === layoutFileFormat, 'NP POSの卓配置ファイルを選択してください。');
  assert(file.version === layoutFileVersion, 'このバージョンの卓配置ファイルには対応していません。');
  const layout = validateLayout(file.areas, file.tables, (id) => {
    assert(typeof id === 'string' && (newTableId.test(id) || sampleTableIds.has(id)),
      '卓配置ファイルに無効な卓IDが含まれています。');
  });
  return { format: layoutFileFormat, version: layoutFileVersion, areas: layout.areas, tables: [...layout.tables.values()] };
}

function allocateTableAlias(reservedIds) {
  assert(typeof globalThis.crypto?.randomUUID === 'function', 'この環境では新しい卓IDを発行できません。');
  let id;
  do { id = `table-${globalThis.crypto.randomUUID()}`; } while (reservedIds.has(id));
  reservedIds.add(id);
  return id;
}

function doImportLayout(state, file) {
  const layout = normalizeLayoutFile(file);
  const activeIds = new Set(state.tables.map((table) => table.id));
  const activeAliases = new Map(state.tables.filter((table) => table.layoutSourceId)
    .map((table) => [table.layoutSourceId, table.id]));
  const archivedIds = new Set((state.archivedTables ?? []).map((table) => table.id));
  const reservedIds = new Set([...activeIds, ...archivedIds, ...layout.tables.map((table) => table.id)]);
  const allocatedAliases = new Map();
  const tables = layout.tables.map((table) => {
    const sourceId = table.id;
    const activeAlias = activeAliases.get(sourceId);
    if (activeIds.has(sourceId)) return table;
    if (activeAlias) return { ...table, id: activeAlias };
    if (!archivedIds.has(sourceId)) return table;
    const id = allocateTableAlias(reservedIds);
    allocatedAliases.set(id, sourceId);
    return { ...table, id };
  });
  doSaveLayout(state, { areas: layout.areas, tables }, true);
  const tablesById = new Map(state.tables.map((table) => [table.id, table]));
  state.tables = tables.map(({ id }) => {
    const table = tablesById.get(id);
    const sourceId = allocatedAliases.get(id);
    return sourceId ? { ...table, layoutSourceId: sourceId } : table;
  });
}

function operationalReason(value, label) {
  const reason = typeof value === 'string' ? value.trim() : '';
  assert(reason.length > 0 && reason.length <= 120, `${label}を120文字以内で入力してください。`);
  return reason;
}

function saveTicketNote(ticket, note, actor) {
  assert(['admin','manager','staff'].includes(actor.role), '伝票メモを変更する権限がありません。');
  assert(typeof note === 'string' && note.trim().length <= 400, '伝票メモを400文字以内で入力してください。');
  const value = note.trim();
  if (value) ticket.note = value;
  else delete ticket.note;
}

function adjustTicketEnd(ticket, action, now, actor) {
  assert(['admin','manager'].includes(actor.role), '終了時刻の調整にはマネージャー以上の権限が必要です。');
  operationalReason(action.reason, '終了時刻を調整する理由');
  const {minutes, startsAt} = action;
  let endsAt = action.endsAt;
  const currentStart = ticket.setStartedAt ?? ticket.createdAt;
  const start = startsAt ?? currentStart;
  if (minutes !== undefined) {
    assert(Number.isInteger(minutes) && minutes !== 0 && Math.abs(minutes) <= 180, '調整は前後180分以内の整数で入力してください。');
    assert(startsAt === undefined && endsAt === undefined, '調整方法を選び直してください。');
    endsAt = ticket.endsAt + minutes * minute;
  }
  assert(Number.isSafeInteger(start) && start <= now && start >= ticket.createdAt - 24 * 60 * minute
    && Number.isSafeInteger(endsAt) && endsAt >= start && endsAt - start <= 48 * 60 * minute,
    '来店時刻以降の終了時刻を指定してください。');
  if (startsAt !== undefined && startsAt !== currentStart) ticket.setStartedAt = startsAt;
  if (endsAt === ticket.endsAt) return;
  ticket.endsAt = endsAt;
  // Shortening into overtime starts a new scheduling interval, so it cannot backdate automatic charges.
  if (endsAt <= now) ticket.autoExtensionResumedAt = Math.max(ticket.autoExtensionResumedAt ?? 0, now);
}

function adjustTicketGuests(state, ticket, { mode, count, reason }, actor) {
  assert(['admin','manager'].includes(actor.role), '人数の変更にはマネージャー以上の権限が必要です。');
  operationalReason(reason, '人数を変更する理由');
  assert(['correct','join','leave'].includes(mode), '人数の変更方法を選択してください。');
  positiveInteger(count, '人数');
  const current = ticket.guests;
  const guests = mode === 'join' ? current + count : mode === 'leave' ? current - count : count;
  assert(guests > 0, '全員が退店する場合は会計へ進んでください。');
  assert(guests !== current, '現在の人数と異なる人数を入力してください。');
  positiveInteger(guests, '変更後の人数');
  tableSet(state, ticket.tableIds, guests, ticket.id);
  const admitted = (ticket.admittedGuests ?? current) + (mode === 'leave' ? 0 : guests - current);
  assert(Number.isSafeInteger(admitted), '来店人数の合計を確認してください。');
  ticket.admittedGuests = admitted;
  ticket.guests = guests;
}

function validateDiscountAmount(ticket, amount, subtotal) {
  assert(amount <= subtotal, '値引きは小計以下を入力してください。');
  const changed = calculateQuote({ ...ticket, discount: amount });
  assert((changed.baseTotal ?? changed.total) >= totalOf(ticket.deposits), '値引き後の請求額が前受金を下回ります。');
}

function doDiscount(state, ticket, action, now, actor) {
  assert(['admin', 'manager'].includes(actor.role), '値引きの操作にはマネージャー以上の権限が必要です。');
  assert(typeof action.reasonCode === 'string' && Object.hasOwn(discountReasonCodes, action.reasonCode),
    '値引きの理由区分を選択してください。');
  const reason = operationalReason(action.reason, '値引き理由');
  const { mode, value, personalSalesMode } = action;
  assert(mode === 'amount' || mode === 'percent', '値引きの単位を選択してください。');
  assert(personalSalesMode === undefined || isPersonalSalesDiscountMode(personalSalesMode), '個人売上への反映方法を選択してください。');
  const subtotal = getTicketDiscountableSubtotal(calculateQuote(ticket));
  let amount;
  let rateBps;
  if (mode === 'percent') {
    rateBps = Math.round(value * 100);
    assert(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
      && Math.abs(rateBps / 100 - value) < 1e-9, '値引き率を0から100の範囲で小数点以下2桁まで入力してください。');
    amount = exactRate(subtotal, rateBps);
  } else {
    amount = money(value, '値引き額');
  }
  validateDiscountAmount(ticket, amount, subtotal);
  const request = { amount, subtotal, mode, value, reasonCode: action.reasonCode, reason, actor: { ...actor }, at: now,
    ...(personalSalesMode !== undefined && { personalSalesMode }) };
  const limit = getManagerDiscountLimit(state);
  if (actor.role === 'manager' && (amount > exactRate(subtotal, limit) || (subtotal > 0 && rateBps > limit))) {
    ticket.discountRequest = { ...request, id: createId(state, 'discount') };
    return;
  }
  ticket.discount = amount;
  ticket.discountDetails = { ...request, approvedBy: { ...actor }, approvedAt: now,
    ...(actor.role === 'manager' ? { managerLimitBps: limit } : {}) };
  ticket.discountRequest = null;
}

function decideDiscount(ticket, action, now, actor) {
  assert(actor.role === 'admin', '値引きの承認・却下には管理者権限が必要です。');
  const request = ticket.discountRequest;
  assert(request && request.id === action.requestId, '承認待ちの値引き申請が変わりました。再表示してください。');
  if (action.type === 'rejectDiscount') {
    operationalReason(action.reason, '却下理由');
    ticket.discountRequest = null;
    return;
  }
  const note = action.reason == null || (typeof action.reason === 'string' && !action.reason.trim())
    ? '' : operationalReason(action.reason, '承認メモ');
  const subtotal = getTicketDiscountableSubtotal(calculateQuote(ticket));
  assert(request.subtotal === subtotal, '申請時から小計が変わりました。値引きの申請を更新してください。');
  validateDiscountAmount(ticket, request.amount, subtotal);
  ticket.discount = request.amount;
  ticket.discountDetails = { ...request, approvedBy: { ...actor }, approvedAt: now, note };
  ticket.discountRequest = null;
}

export function apply(state, action, now = Date.now(), actor = demoActor) {
  assert(roleAllowsCommand(state,actor.role,action,actor.profileId),'店舗設定でこの役職には操作が許可されていません。');
  const authenticatedActor = { id: actor.id, label: actor.label, role: actor.role };
  const next = reduce(state, action, now, authenticatedActor);
  const addedMovements = next.movements.length - state.movements.length;
  for (const movement of next.movements.slice(0,addedMovements)) {
    movement.actorLabel = authenticatedActor.label;
    if (!movement.ticketId) movement.date = operationBusinessDate(next,now);
  }
  const audit = buildOperationAudit(state, next, action, now, authenticatedActor);
  if (audit) next.auditLog = [audit, ...(next.auditLog ?? [])];
  return next;
}

function reduce(state, action, now, actor) {
  const next = structuredClone(state);
  if (action.type === 'saveRolePolicy') {
    assert(actor.role === 'admin','役職・権限の設定には店舗管理者の権限が必要です。');
    next.rolePolicy = normalizeRolePolicy(action.policy);
    return next;
  }
  if (action.type === 'saveCashAccounts') {
    saveCashAccounts(next,action,actor);
    return next;
  }
  if (action.type === 'bindCastAccount') {
    bindCastAccount(next, action, actor);
    return next;
  }
  if (isCastSelfCommand(action.type) || isCastAttendanceReview(action.type) || isManagedAttendanceCommand(action.type)) {
    applyCastSelfCommand(next, action, now, actor, (prefix) => createId(next,prefix));
    return next;
  }
  if (action.type === 'saveInitialSetSchedule') {
    applySetSchedule(next, action, actor);
    return next;
  }
  if (action.type === 'saveShift' || action.type === 'removeShift') {
    applyShiftCommand(next, action, actor, now, () => createId(next, 'shift'));
    return next;
  }
  if (isPayrollCommand(action.type)) {
    applyPayrollCommand(next, action, now, actor, {
      allocateId: (prefix = 'daily-pay') => createId(next, prefix),
      recordCashPayout: (amount) => {
        assert(summary(next).expectedCash >= amount, '日払い額がレジの理論残高を超えています。');
        const movement = createCashMovement(next,{kind:'withdrawal',category:'other',amount,
          reason:'日払いの現金支給',destination:'給与前払い'},now,actor,() => createId(next,'cash'));
        (next.cashMovements ??= []).push(movement);
        return movement.id;
      },
    });
    return next;
  }
  if (isStaffLaborCommand(action.type)) {
    applyStaffLaborCommand(next,action,now,actor,(prefix)=>createId(next,prefix));
    return next;
  }
  if (action.type === 'saveAutoExtensionSettings') {
    saveAutoExtensionSettings(next, action, now, actor);
    return next;
  }
  if (action.type === 'setTableAutoExtension') {
    setTableAutoExtension(next, action, now, actor);
    return next;
  }
  if (action.type === 'syncAutoExtensions') {
    syncAutomaticExtensions(next, now, actor, extendTicket);
    return next;
  }
  if (action.type === 'savePrintSettings' || action.type === 'issuePrintDocument') {
    applyPrintCommand(next, action, actor, now, () => createId(next, 'print'));
    return next;
  }
  if (action.type === 'saveAccountingCsv') {
    applyAccountingCsv(next,action,actor);
    return next;
  }
  if (['saveCustomer', 'mergeCustomers', 'linkCustomer', 'correctSettledTicketCustomer', 'correctSettledTicketCompanion', 'importCustomers'].includes(action.type)) {
    applyCustomerCommand(next, action, actor, now, () => createId(next, 'customer'));
    return next;
  }
  if (action.type === 'saveControls') {
    assert(actor.role === 'admin', '値引き上限の変更には管理者権限が必要です。');
    const limit = action.managerDiscountRateBps;
    assert(Number.isInteger(limit) && limit >= 0 && limit <= 10_000, '値引き上限を0から100%の範囲で入力してください。');
    next.controls = { ...next.controls, managerDiscountRateBps: limit,
      ...(action.castDutyMode !== undefined && {castDutyMode:normalizeCastDutyMode(action.castDutyMode)}),
      ...(action.register !== undefined && {register:normalizeRegisterSettings(action.register)}) };
    return next;
  }
  if (action.type === 'saveCardFeeSettings') {
    assert(actor.role === 'admin', 'カード会計の加算設定は店舗管理者が変更できます。');
    const brands = action.settings?.brands;
    next.cardFeeSettings = normalizeCardFeeSettings({
      ...action.settings,brands:brands === undefined ? next.cardFeeSettings?.brands : brands,
    });
    return next;
  }
  if (action.type === 'saveCalculationSettings') {
    assert(actor.role === 'admin', '会計の計算設定は店舗管理者が変更できます。');
    next.calculationSettings = normalizeCalculationSettings(action.settings);
    return next;
  }
  if (action.type === 'saveLayout') {
    doSaveLayout(next, action);
    return next;
  }
  if (action.type === 'importLayout') {
    doImportLayout(next, action.layout);
    return next;
  }
  if (action.type === 'saveStoreSettings') {
    const { removeMenuIds, removeCastIds, removeStockIds } = action;
    replaceStoreSettings(next, validatedStoreSettings(action.settings, next), removeStockIds, { removeMenuIds, removeCastIds });
    return next;
  }
  if (action.type === 'importStoreConfiguration') {
    const { layout, settings, initialSetSchedule, calculationSettings, bulkExtensionEnabled } = action.configuration ?? {};
    const validated = settings === null ? null : validatedStoreSettings(settings, next);
    const calculation = calculationSettings === undefined ? null : normalizeCalculationSettings(calculationSettings);
    assert(isValidInitialSetSchedule(initialSetSchedule), '時間帯別セットの設定を確認してください。');
    assert(bulkExtensionEnabled === undefined || typeof bulkExtensionEnabled === 'boolean','一括延長の設定を確認してください。');
    doImportLayout(next, layout);
    if (validated) replaceStoreSettings(next, validated);
    if (calculation) next.calculationSettings = calculation;
    if (bulkExtensionEnabled !== undefined) next.bulkExtensionEnabled = bulkExtensionEnabled;
    if (initialSetSchedule) next.initialSetSchedule = initialSetSchedule.map(({start,end,setId})=>({start,end,setId}));
    return next;
  }
  if (action.type === 'open') {
    doOpen(next, action, now);
    return next;
  }
  if (action.type === 'close') {
    doClose(next, action, now);
    return next;
  }
  if (action.type === 'seat') {
    doSeat(next, action, now, actor);
    return next;
  }
  if (action.type === 'stockAdjust' || action.type === 'recordStockOperation') {
    doStockAdjust(next, action, now, actor);
    return next;
  }
  if (action.type === 'recordCashMovement') {
    const movement = createCashMovement(next, action, now, actor, () => createId(next, 'cash'));
    if (movement.cashAccountKind === 'vault' && movement.kind === 'withdrawal') {
      assert(summary(next).expectedCash >= movement.amount,'レジの理論残高を超えて金庫に移動できません。');
    }
    (next.cashMovements ??= []).push(movement);
    return next;
  }
  if (['editCashMovement','voidCashMovement'].includes(action.type)) {
    amendCashMovement(next,action,now,actor);
    return next;
  }
  if (action.type === 'correctRegisterCount') {
    amendRegisterCount(next,action,actor);
    return next;
  }
  if (action.type === 'recoverReceivable') {
    recoverReceivable(next, action, now, actor);
    return next;
  }
  if (action.type === 'correctSettledTicketPayments') {
    correctSettledTicketPayments(next, action, now, actor);
    return next;
  }
  if (action.type === 'correctSettledContents') {
    correctSettledContents(next,action,now,actor);
    return next;
  }

  currentDay(next);
  const ticket = findTicket(next, action.ticketId);
  if (action.type === 'cancelSettlement') {
    reverseSettlement(next, ticket, action, now, actor);
    return next;
  }
  if (action.type === 'reopenTicket') {
    reopenTicket(next, ticket, action, now, actor);
    return next;
  }
  if (action.type === 'depart') {
    assert(ticket.status === 'paid', '会計を確定してから退店してください。');
    recordTableAssignment(ticket, [], now);
    ticket.status = 'departed';
    ticket.departedAt = now;
    return next;
  }
  requireOrderable(ticket);
  switch (action.type) {
    case 'saveTicketNote':
      saveTicketNote(ticket, action.note, actor);
      break;
    case 'adjustTicketEnd':
      adjustTicketEnd(ticket, action, now, actor);
      break;
    case 'adjustTicketGuests':
      adjustTicketGuests(next, ticket, action, actor);
      break;
    case 'editTicketLine':
      editLiveTicketLine(next,ticket,action,now,actor);
      break;
    case 'cancelTicketExtension':
      cancelTicketExtension(next,ticket,action,now,actor);
      break;
    case 'setTicketCustomer':
      setTicketCustomer(next, ticket, action, actor);
      break;
    case 'setTicketCompanion':
      setTicketCompanion(next,ticket,action,actor);
      break;
    case 'pauseVisitAutoExtension':
      pauseVisitAutoExtension(next, ticket, action, now, actor);
      break;
    case 'resumeVisitAutoExtension':
      resumeVisitAutoExtension(ticket, now, actor);
      break;
    case 'move': {
      const tableIds = tableSet(next, action.tableIds, ticket.guests, ticket.id);
      if (!getLinkedTablesAutoExtensionEnabled(next, ticket.tableIds)
        && getLinkedTablesAutoExtensionEnabled(next, tableIds)) ticket.autoExtensionResumedAt = now;
      recordTableAssignment(ticket, tableIds, now);
      ticket.tableIds = tableIds;
      break;
    }
    case 'order':
      assert(Array.isArray(action.items) && action.items.length > 0 && action.items.length <= 100, '商品を100明細以内で追加してください。');
      for (const item of action.items) {
        const menu = next.menu.find((entry) => entry.id === item.menuId);
        assert(menu && !['セット', '延長'].includes(menu.category), '初回セットと延長は専用画面で登録してください。');
        assert(menu.enabled !== false, 'このメニューは提供を停止しています。');
        const {taxRateOverride,taxOverrideReason,serviceExcluded,serviceExclusionReason} = item;
        if (taxRateOverride !== undefined) {
          assert(canOverrideOrderTax(next, actor.role), '明細の税率変更には店舗設定と管理者権限が必要です。');
          assert(isOrderTaxRateOverride(taxRateOverride), '明細の税率を確認してください。');
          operationalReason(taxOverrideReason, '税率の変更理由');
        }
        if (serviceExcluded !== undefined) assert(typeof serviceExcluded === 'boolean', 'サービス料の除外設定を確認してください。');
        if (serviceExcluded) {
          assert(canExcludeOrderService(next, actor.role), 'サービス料の除外には店舗設定と管理者権限が必要です。');
          assert(menu.serviceEligible !== false, 'この商品はサービス料の対象外です。');
          operationalReason(serviceExclusionReason, 'サービス料の除外理由');
        }
        const lineDiscount = item.lineDiscount === undefined ? undefined : orderLineDiscount(next,actor,item.lineDiscount);
        const line = addLine(next, ticket, menu, item.quantity, item.castIds ?? [], now, {serviceExcluded,taxRateOverride});
        if (lineDiscount) {
          line.lineDiscount = lineDiscount;
          assertOrderLineDiscountFits(line);
        }
      }
      break;
    case 'extend':
    case 'extendOverdue': {
      const assignments = resolveExtensionAssignments(next,ticket,action);
      const [{menu}] = assignments;
      const count = action.type === 'extendOverdue' ? getOverdueExtensionCount(ticket, menu, now) : 1;
      if (action.type === 'extendOverdue') {
        assert(['admin','manager','staff'].includes(actor.role), '一括延長を行う権限がありません。');
        assert(next.bulkExtensionEnabled !== false, '店舗設定で一括延長がオフになっています。');
        assert(count > 0, 'セット終了時刻を過ぎた伝票が対象です。');
        assert(count <= maxOverdueExtensionCount, '一度に登録できる延長は100回までです。延長内容を確認してください。');
        assert(action.expectedCount === count, '超過時間が変わりました。一括延長を開き直して金額を確認してください。');
      }
      for (let interval = 0; interval < count; interval++) extendTicket(next, ticket, menu, now,false,assignments);
      if (action.expectedTotal !== undefined) {
        assert(action.expectedTotal === quote(next,ticket.id).total,'延長料金が変わりました。延長を開き直して金額を確認してください。');
      }
      break;
    }
    case 'deposit': {
      validateMethod(action.method);
      const amount = money(action.amount, '前受金', false);
      assert(quote(next, ticket.id).remaining >= amount, '前受金は現在の未収額以下を入力してください。');
      const memo = String(action.memo ?? '').trim();
      assert(memo.length <= 120, '前受金メモは120文字以内です。');
      const terms = recordDepositPaymentTerms(next,action,actor,null);
      ticket.deposits.push({ id: createId(next, 'deposit'), method: action.method, amount, at: now, ...terms, ...(memo && {memo}) });
      break;
    }
    case 'editDeposit': {
      assert(['admin','manager'].includes(actor.role),'前受金の訂正にはマネージャー以上の権限が必要です。');
      operationalReason(action.reason,'前受金の訂正理由');
      const index = ticket.deposits.findIndex(({id}) => id === action.depositId);
      const entry = ticket.deposits[index];
      assert(entry,'前受金が見つかりません。');
      validateMethod(action.method);
      const amount = money(action.amount,'前受金',false);
      assert(amount <= quote(next,ticket.id).remaining + entry.amount,'前受金は会計額の範囲で入力してください。');
      const memo = String(action.memo ?? '').trim();
      assert(memo.length <= 120,'前受金メモは120文字以内です。');
      const terms = recordDepositPaymentTerms(next,action,actor,entry);
      ticket.deposits[index] = {id:entry.id,at:entry.at,method:action.method,amount,memo,...terms};
      break;
    }
    case 'cancelDeposit': {
      const index = ticket.deposits.findIndex((entry) => entry.id === action.depositId);
      assert(index >= 0, '前受金が見つかりません。');
      ticket.deposits.splice(index, 1);
      break;
    }
    case 'discount': {
      doDiscount(next, ticket, action, now, actor);
      break;
    }
    case 'adjustPersonalSales': {
      const before = calculateQuote(ticket).commission.find(({castId}) => castId === action.castId)?.sales ?? 0;
      recordPersonalSalesAdjustment(next, ticket, action, { actor, at: now, before, createId: () => createId(next, 'sales-adjustment') });
      break;
    }
    case 'approveDiscount':
    case 'rejectDiscount': {
      decideDiscount(ticket, action, now, actor);
      break;
    }
    case 'settle': {
      assert(!ticket.discountRequest, '承認待ちの値引き申請を処理してから会計してください。');
      const due = quote(next, ticket.id).remaining;
      assert(Array.isArray(action.payments) && action.payments.length <= 10, '支払内容を確認してください。');
      for (const payment of action.payments) {
        validateMethod(payment.method, { allowReceivable: true });
        money(payment.amount, `${methodLabel[payment.method]}の支払額`, false);
      }
      assert(totalOf(action.payments) === due, '支払額の合計を未収額と一致させてください。');
      const cashTender = calculateCashTender(action.payments,action.cashReceived);
      assert(canWaivePaymentFee(actor.role) || !action.payments.some(({waiveFee}) => waiveFee),
        '決済加算を免除するにはマネージャー以上の権限が必要です。');
      const {metadata,fees,total:cardFee} = getSettlementPaymentFees(next,action.payments);
      if (cardFee > 0 || action.expectedCardFee !== undefined) {
        const label = metadata.some(({brandId})=>brandId) ? '決済加算額' : 'カード加算額';
        assert(action.expectedCardFee === cardFee, `${label}が更新されています。会計画面を開き直して金額を確認してください。`);
      }
      const creditAmount = totalOf(action.payments.filter(({ method }) => method === 'receivable'));
      if (creditAmount > 0) issueReceivable(next, ticket, action, creditAmount, now, actor);
      ticket.payments = action.payments.map(({method, amount},index) => {
        const fee = fees[index];
        const {rate,...snapshot} = metadata[index];
        return {id:createId(next,'payment'),method,amount:amount + fee,at:now,
          ...snapshot,...(fee ? {baseAmount:amount,cardFee:fee,cardFeeRateBps:rate} : {})};
      });
      if (cashTender) ticket.cashTender = cashTender;
      else delete ticket.cashTender;
      delete ticket.paymentsCorrectedAt;
      ticket.settlement = quote(next, ticket.id);
      ticket.status = 'paid';
      ticket.settledAt = now;
      ticket.settledBy = { ...actor };
      ticket.settlementRevision = (ticket.settlementRevision ?? 0) + 1;
      break;
    }
    case 'serve': {
      const line = ticket.lines.find((entry) => entry.id === action.lineId && entry.cancelledAt === null);
      assert(line, '注文明細が見つかりません。');
      line.providedAt = now;
      break;
    }
    case 'cancelLine': {
      assert(['admin', 'manager'].includes(actor.role), '注文取消にはマネージャー以上の権限が必要です。');
      operationalReason(action.reason, '注文の取消理由');
      const line = ticket.lines.find((entry) => entry.id === action.lineId && entry.cancelledAt === null);
      assert(line, '注文明細が見つかりません。');
      assert(!['セット', '延長'].includes(line.category) && line.menuId !== 'nominationExtra', 'この料金は伝票単位で取り消してください。');
      assert(!action.returnStock || line.providedAt === null, '提供済みの商品は在庫に戻せません。');
      line.cancelledAt = now;
      if (action.returnStock) {
        for (const use of line.stockUses) {
          const stock = next.stock.find((entry) => entry.id === use.stockId);
          newStockMovement(next, stock, use.quantity, 'return', `${line.name}の取消`, now, ticket.id, line.id, use.unitCost);
        }
      }
      assertReducedTicketAmounts(next,ticket,actor,'取消');
      break;
    }
    case 'void':
      canCancel(ticket);
      ticket.voidRestockedLineIds = [];
      if (action.returnStock) {
        for (const line of ticket.lines.filter((entry) => entry.cancelledAt === null && entry.providedAt === null)) {
          if (line.stockUses.length) ticket.voidRestockedLineIds.push(line.id);
          for (const use of line.stockUses) {
            const stock = next.stock.find((entry) => entry.id === use.stockId);
            newStockMovement(next, stock, use.quantity, 'return', `${line.name}の伝票取消`, now, ticket.id, line.id, use.unitCost);
          }
        }
      }
      recordTableAssignment(ticket, [], now);
      ticket.status = 'void';
      break;
    default:
      throw new Error('操作内容が見つかりません。');
  }
  return next;
}

export function summary(state) {
  const tenderPayments = { cash: 0, card: 0, qr: 0 };
  const depositsReceived = { ...tenderPayments };
  const recoveries = state.recoveryTotalsForDay ?? getReceivableRecoveryTotals(state, state.day.date);
  const recoveryRows = state.recoveryRowsForDay ?? getDailyRecoveryRows(state, state.day.date);
  const cashMovements = getCashMovements(state, state.day.date);
  const cashTotals = totalCashMovements(cashMovements);
  const earned = new Map();
  const pending = new Map();
  let sales = 0;
  let depositsApplied = 0;
  let receivableSales = 0;
  let guests = 0;
  let tickets = 0;
  let occupied = 0;
  let openTickets = 0;
  let paidTickets = 0;
  for (const ticket of state.tickets) {
    if (ticket.status === 'void' || ticket.status === 'cancelled') continue;
    if (occupiedStatuses.has(ticket.status)) occupied += ticket.tableIds.length;
    for (const payment of ticket.deposits) {
      if (Object.hasOwn(depositsReceived, payment.method)) depositsReceived[payment.method] += depositGrossAmount(payment);
    }
    for (const payment of ticket.payments) {
      if (Object.hasOwn(tenderPayments, payment.method)) tenderPayments[payment.method] += payment.amount;
    }
    const totals = quote(state, ticket.id);
    if (ticket.status === 'open') {
      openTickets++;
      totals.commission.forEach((entry) => addCommission(pending, entry.castId, entry.sales, entry.amount,
        Math.round(entry.points * pointsScale)));
      continue;
    }
    if (ticket.status === 'paid') paidTickets++;
    const isSettled = ticket.status === 'paid' || ticket.status === 'departed';
    if (isSettled) {
      tickets++;
      guests += ticket.admittedGuests ?? ticket.guests;
      sales += totals.total;
      depositsApplied += totalDepositsReceived(ticket.deposits);
      receivableSales += totals.receivable ?? 0;
      totals.commission.forEach((entry) => addCommission(earned, entry.castId, entry.sales, entry.amount,
        Math.round(entry.points * pointsScale)));
    }
  }
  const payments = Object.fromEntries(methods.map((method) => [method, tenderPayments[method] + depositsReceived[method]]));
  return { sales, receivableSales, recoveries, recoveryRows, guests, tickets, occupied, totalTables: state.tables.length,
    expectedCash: state.day.openingCash + payments.cash + recoveries.cash + cashTotals.cashIn - cashTotals.cashOut,
    tenderPayments, depositsReceived, depositsApplied, cashMovements, ...cashTotals,
    commission: outputCommission(earned), pendingCommission: outputCommission(pending), stockMovements: state.movements.length,
    payments, openTickets, paidTickets };
}

const rooms = [
  ['a', 'フロアA', [4, 4, 2, 6, 4, 2]],
  ['b', 'フロアB', [4, 6, 4, 2]],
  ['v', 'VIP', [8, 6]],
];
export const layoutAreas = Object.freeze(rooms.map(([, area]) => area));
const sampleTables = rooms.flatMap(([prefix, area, capacities]) => capacities.map((capacity, index) => ({
  id: `${prefix}${index + 1}`, name: `${prefix.toUpperCase()}-${String(index + 1).padStart(2, '0')}`, area, capacity,
})));
const sampleTableIds = new Set(sampleTables.map((table) => table.id));
const cast = [
  { id: 'cast1', name: '美月', initials: '美', color: 'violet' },
  { id: 'cast2', name: '凛', initials: '凛', color: 'rose' },
  { id: 'cast3', name: '結衣', initials: '結', color: 'sky' },
  { id: 'cast4', name: '葵', initials: '葵', color: 'green' },
  { id: 'cast5', name: '沙羅', initials: '沙', color: 'amber' },
  { id: 'cast6', name: '玲奈', initials: '玲', color: 'violet' },
];
const menu = [
  { id: 'set60', name: 'スタンダード 60分', category: 'セット', price: 5_000, duration: 60 },
  { id: 'set90', name: 'スタンダード 90分', category: 'セット', price: 7_000, duration: 90 },
  { id: 'vip60', name: 'VIP セット 60分', category: 'セット', price: 9_000, duration: 60 },
  { id: 'highball', name: 'ハイボール', category: 'ドリンク', price: 900, popular: true,
    recipe: [{ stockId: 'whisky', quantity: 0.05 }, { stockId: 'soda', quantity: 0.25 }] },
  { id: 'castDrink', name: 'キャストドリンク', category: 'ドリンク', price: 1_500, popular: true, requiresCast: true,
    commission: { fixed: 300, points: 1 }, recipe: [{ stockId: 'soda', quantity: 0.25 }] },
  { id: 'oolong', name: '烏龍茶', category: 'ドリンク', price: 750,
    recipe: [{ stockId: 'tea', quantity: 0.25 }] },
  { id: 'beer', name: '瓶ビール', category: 'ドリンク', price: 1_000,
    recipe: [{ stockId: 'beer', quantity: 1 }] },
  { id: 'champagne', name: 'シャンパン ブリュット', category: 'ボトル', price: 18_000, popular: true,
    commission: { rate: 12, points: 5 }, recipe: [{ stockId: 'champagne', quantity: 1 }] },
  { id: 'whiskyBottle', name: 'プレミアムウイスキー', category: 'ボトル', price: 12_000,
    commission: { rate: 10, points: 3 }, recipe: [{ stockId: 'whisky', quantity: 1 }] },
  { id: 'nuts', name: 'ミックスナッツ', category: 'フード', price: 800, popular: true,
    recipe: [{ stockId: 'nuts', quantity: 1 }] },
  { id: 'fruits', name: 'フルーツ盛り合わせ', category: 'フード', price: 3_500,
    recipe: [{ stockId: 'fruit', quantity: 1 }] },
  { id: 'nomination', name: '本指名', category: '指名', price: 2_000, requiresCast: true, popular: true,
    commission: { fixed: 700, points: 2 } },
  { id: 'inHouse', name: '場内指名', category: '指名', price: 1_500, requiresCast: true,
    commission: { fixed: 500, points: 1 } },
  { id: 'nominationExtra', name: '延長指名料', category: '延長', price: 1_000, requiresCast: true,
    commission: { fixed: 350, points: 1 } },
  { id: 'extend30', name: '延長 30分', category: '延長', price: 2_500, duration: 30 },
  { id: 'extend60', name: '延長 60分', category: '延長', price: 4_500, duration: 60 },
];
const stockSeed = [
  ['whisky', 'プレミアムウイスキー', 'ボトル', '本', 12, 3, 2_200],
  ['champagne', 'シャンパン ブリュット', 'ボトル', '本', 5, 3, 5_200],
  ['soda', 'クラブソーダ', 'ドリンク', '本', 24, 6, 125],
  ['tea', '烏龍茶', 'ドリンク', '本', 10, 3, 180],
  ['beer', '瓶ビール', 'ドリンク', '本', 18, 5, 260],
  ['nuts', 'ミックスナッツ', 'フード', '皿', 4, 5, 200],
  ['fruit', 'フルーツ盛り合わせ', 'フード', '皿', 6, 2, 800],
];

export function createDemo(mode = 'live', now = Date.now()) {
  let state = {
    day: { status: 'closed', date: businessDate(now), openingCash: 0, openedAt: null, closedAt: null, closingCash: null },
    tables: structuredClone(sampleTables),
    tickets: [], menu: structuredClone(menu), cast: structuredClone(cast),
    stock: stockSeed.map(([id, name, category, unit, quantity, minimum, unitCost]) => ({ id, name, category, unit, quantity,
      minimum, unitCost, value: quantity * unitCost, defaultUnitCost: unitCost })),
    movements: [], closedDays: [], nextId: 1, nextTicket: 101,
  };
  if (mode === 'closed') return state;
  const step = (action, time) => { state = apply(state, action, time); };
  const seat = (tableIds, guests, customer, setId, elapsed) => {
    step({ type: 'seat', tableIds, guests, customer, setId }, now - elapsed * minute);
    return state.tickets.at(-1).id;
  };
  const order = (ticketId, items, elapsed) => {
    step({ type: 'order', ticketId, items: items.map(([menuId, quantity, castIds]) => ({ menuId, quantity, castIds })) },
      now - elapsed * minute);
  };
  const settle = (ticketId, method, elapsed) => {
    step({ type: 'settle', ticketId, payments: [{ method, amount: quote(state, ticketId).remaining }] }, now - elapsed * minute);
  };
  step({ type: 'open', openingCash: 20_000, date: businessDate(now) }, now - 146 * minute);
  const past = seat(['b4'], 2, '伊藤様', 'set60', 105);
  order(past, [['castDrink', 2, ['cast2']], ['highball', 1, []]], 98);
  settle(past, 'card', 44);
  step({ type: 'depart', ticketId: past }, now - 42 * minute);
  const active = seat(['a1'], 2, '佐藤様', 'set60', 32);
  order(active, [['castDrink', 2, ['cast1']]], 25);
  step({ type: 'discount', ticketId: active, mode: 'amount', value: 1_300,
    reasonCode: 'service', reason: 'サンプルのサービス値引き' }, now - 21 * minute);
  step({ type: 'deposit', ticketId: active, method: 'cash', amount: 3_000 }, now - 20 * minute);
  const almost = seat(['a2'], 3, '鈴木様', 'set60', 54);
  order(almost, [['nomination', 1, ['cast3']], ['oolong', 1, []]], 22);
  const overtime = seat(['b1'], 2, '田中様', 'set60', 63);
  order(overtime, [['highball', 2, []], ['nuts', 1, []]], 47);
  const paid = seat(['b2'], 1, '渡辺様', 'set60', 57);
  order(paid, [['castDrink', 1, ['cast4']]], 49);
  settle(paid, 'cash', 3);
  const vip = seat(['v1', 'v2'], 6, '高橋様', 'vip60', 18);
  order(vip, [['champagne', 1, ['cast1', 'cast2']], ['fruits', 1, []]], 14);
  state.movements.sort((first, second) => second.at - first.at);
  return state;
}
