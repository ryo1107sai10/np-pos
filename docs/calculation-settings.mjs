import { isPersonalSalesDiscountMode } from './personal-sales.mjs';

const rateDivisor = 10_000;
export const defaultItemTaxRateBps = 1_000;
const roundingModes = new Set(['floor', 'round', 'ceil']);
const serviceBases = new Set(['afterDiscount', 'beforeDiscount']);
const priceModes = new Set(['exclusive', 'inclusive', 'serviceInclusive']);
export const castAllocationUnits = Object.freeze({
  amount:Object.freeze([1,10,100]), points:Object.freeze([1,10,100]),
  quantity:Object.freeze([10,100,1000]), sales:Object.freeze([1,10,100]), cost:Object.freeze([1,10,100]),
});
export const serviceRoundingUnits = Object.freeze([1,10,100]);
export const commissionQuantityScale = 10_000;
const defaults = Object.freeze({
  serviceRateBps: 2_000,
  serviceRounding: 'floor',
  taxRounding: 'floor',
  serviceBase: 'afterDiscount',
  priceMode: 'exclusive',
});

function projectSettings({ serviceRateBps, serviceRounding, serviceRoundingUnit, taxRounding, serviceBase, priceMode, personalSalesDiscountMode,
  allowOrderServiceExclusion, allowOrderTaxOverride, allowOrderLineDiscount, castAllocation }) {
  return { serviceRateBps, serviceRounding, taxRounding, serviceBase, priceMode,
    ...(serviceRoundingUnit !== undefined && {serviceRoundingUnit}),
    ...(personalSalesDiscountMode !== undefined && {personalSalesDiscountMode}),
    ...(castAllocation !== undefined && {castAllocation:Object.fromEntries(Object.entries(castAllocation)
      .map(([key,{unit,mode}]) => [key,{unit,mode}]))}),
    ...(allowOrderServiceExclusion !== undefined && {allowOrderServiceExclusion}),
    ...(allowOrderTaxOverride !== undefined && {allowOrderTaxOverride}),
    ...(allowOrderLineDiscount !== undefined && {allowOrderLineDiscount}) };
}

function validCastAllocation(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key,rule]) =>
    Object.hasOwn(castAllocationUnits,key) && rule && typeof rule === 'object' && !Array.isArray(rule)
    && castAllocationUnits[key].includes(rule.unit) && roundingModes.has(rule.mode));
}

export function isValidCalculationSettings(settings) {
  return settings !== null && typeof settings === 'object' && !Array.isArray(settings)
    && Number.isSafeInteger(settings.serviceRateBps) && settings.serviceRateBps >= 0 && settings.serviceRateBps <= rateDivisor
    && roundingModes.has(settings.serviceRounding) && roundingModes.has(settings.taxRounding)
    && serviceBases.has(settings.serviceBase) && priceModes.has(settings.priceMode)
    && (settings.serviceRoundingUnit === undefined || serviceRoundingUnits.includes(settings.serviceRoundingUnit))
    && (settings.personalSalesDiscountMode === undefined || isPersonalSalesDiscountMode(settings.personalSalesDiscountMode))
    && (settings.castAllocation === undefined || validCastAllocation(settings.castAllocation))
    && ['allowOrderServiceExclusion','allowOrderTaxOverride','allowOrderLineDiscount']
      .every((key) => settings[key] === undefined || typeof settings[key] === 'boolean');
}

export function normalizeCalculationSettings(settings) {
  if (!isValidCalculationSettings(settings)) {
    throw new Error('サービス料率、税、値引きと端数処理の設定を確認してください。');
  }
  return projectSettings(settings);
}

export function getCalculationSettings(state) {
  return isValidCalculationSettings(state.calculationSettings) ? projectSettings(state.calculationSettings) : { ...defaults };
}

export function canExcludeOrderService(state, role) {
  return role === 'admin' && getCalculationSettings(state).allowOrderServiceExclusion === true;
}

export function canOverrideOrderTax(state, role) {
  return role === 'admin' && getCalculationSettings(state).allowOrderTaxOverride === true;
}

export function canApplyOrderLineDiscount(state, role) {
  return role === 'admin' && getCalculationSettings(state).allowOrderLineDiscount === true;
}

export function getTicketCalculationSettings(ticket) {
  if (isValidCalculationSettings(ticket.calculationSettings)) return projectSettings(ticket.calculationSettings);
  const serviceRateBps = Number.isSafeInteger(ticket.serviceRate) && ticket.serviceRate >= 0
    ? ticket.serviceRate : defaults.serviceRateBps;
  return { ...defaults, serviceRateBps };
}

export function roundCalculationRate(amount, rate, rounding = 'floor', divisor = rateDivisor, unit = 1) {
  return roundRational(BigInt(amount) * BigInt(rate),BigInt(divisor),rounding,unit);
}

function roundRational(numerator, divisor, rounding, unit) {
  const denominator = divisor * BigInt(unit);
  if (rounding === 'ceil') return Number((numerator + denominator - 1n) / denominator) * unit;
  if (rounding === 'round') return Number((numerator * 2n + denominator) / (denominator * 2n)) * unit;
  return Number(numerator / denominator) * unit;
}

export function roundedCastIncentive(fixed, base, rate, count, {mode,unit}) {
  const scale = BigInt(rateDivisor);
  const people = BigInt(count);
  return roundRational(BigInt(fixed) * scale + BigInt(base) * BigInt(rate) * people,scale * people,mode,unit);
}

export function castAllocationShare(total, count, index, rule) {
  return rule && count > 1 ? roundCalculationRate(total,1,rule.mode,count,rule.unit)
    : Math.floor(total / count) + Number(index < total % count);
}

export function castLineCost(line, index, rule) {
  if (!Array.isArray(line.stockUses)) return undefined;
  const cost = Math.round(line.stockUses.reduce((sum,use) => sum + use.quantity * use.unitCost,0));
  if (!Number.isSafeInteger(cost) || cost < 0) return undefined;
  return castAllocationShare(cost,line.castIds.length,index,rule);
}

export function calculationTaxGroup(amount, rate, { priceMode, taxRounding }) {
  const inclusive = priceMode === 'inclusive' || priceMode === 'serviceInclusive';
  const tax = roundCalculationRate(amount, rate, taxRounding, inclusive ? rateDivisor + rate : rateDivisor);
  const base = inclusive ? Number(BigInt(amount) - BigInt(tax)) : Number(amount);
  return { rate, base, tax };
}
