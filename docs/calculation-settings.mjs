const rateDivisor = 10_000;
export const defaultItemTaxRateBps = 1_000;
const roundingModes = new Set(['floor', 'round', 'ceil']);
const serviceBases = new Set(['afterDiscount', 'beforeDiscount']);
const priceModes = new Set(['exclusive', 'inclusive']);
const defaults = Object.freeze({
  serviceRateBps: 2_000,
  serviceRounding: 'floor',
  taxRounding: 'floor',
  serviceBase: 'afterDiscount',
  priceMode: 'exclusive',
});

function projectSettings({ serviceRateBps, serviceRounding, taxRounding, serviceBase, priceMode, allowOrderServiceExclusion }) {
  return { serviceRateBps, serviceRounding, taxRounding, serviceBase, priceMode,
    ...(allowOrderServiceExclusion !== undefined && {allowOrderServiceExclusion}) };
}

export function isValidCalculationSettings(settings) {
  return settings !== null && typeof settings === 'object' && !Array.isArray(settings)
    && Number.isSafeInteger(settings.serviceRateBps) && settings.serviceRateBps >= 0 && settings.serviceRateBps <= rateDivisor
    && roundingModes.has(settings.serviceRounding) && roundingModes.has(settings.taxRounding)
    && serviceBases.has(settings.serviceBase) && priceModes.has(settings.priceMode)
    && (settings.allowOrderServiceExclusion === undefined || typeof settings.allowOrderServiceExclusion === 'boolean');
}

export function normalizeCalculationSettings(settings) {
  if (!isValidCalculationSettings(settings)) {
    throw new Error('サービス料率と端数処理、値引きの基準、税込・税抜の設定を確認してください。');
  }
  return projectSettings(settings);
}

export function getCalculationSettings(state) {
  return isValidCalculationSettings(state.calculationSettings) ? projectSettings(state.calculationSettings) : { ...defaults };
}

export function canExcludeOrderService(state, role) {
  return role === 'admin' && getCalculationSettings(state).allowOrderServiceExclusion === true;
}

export function getTicketCalculationSettings(ticket) {
  if (isValidCalculationSettings(ticket.calculationSettings)) return projectSettings(ticket.calculationSettings);
  const serviceRateBps = Number.isSafeInteger(ticket.serviceRate) && ticket.serviceRate >= 0
    ? ticket.serviceRate : defaults.serviceRateBps;
  return { ...defaults, serviceRateBps };
}

export function roundCalculationRate(amount, rate, rounding = 'floor', divisor = rateDivisor) {
  const numerator = BigInt(amount) * BigInt(rate);
  const denominator = BigInt(divisor);
  if (rounding === 'ceil') return Number((numerator + denominator - 1n) / denominator);
  if (rounding === 'round') return Number((numerator * 2n + denominator) / (denominator * 2n));
  return Number(numerator / denominator);
}

export function calculationTaxGroup(amount, rate, { priceMode, taxRounding }) {
  const inclusive = priceMode === 'inclusive';
  const tax = roundCalculationRate(amount, rate, taxRounding, inclusive ? rateDivisor + rate : rateDivisor);
  const base = inclusive ? Number(BigInt(amount) - BigInt(tax)) : Number(amount);
  return { rate, base, tax };
}
