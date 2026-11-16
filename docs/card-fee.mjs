import { calculationTaxGroup } from './calculation-settings.mjs';

const defaults = Object.freeze({enabled:false,rateBps:0});
const standardTaxRate = 1_000;

function validRate(rateBps) {
  return Number.isInteger(rateBps) && rateBps >= 0 && rateBps <= 10_000;
}

export function getCardFeeSettings(state) {
  const settings = state.cardFeeSettings;
  if (!settings || typeof settings.enabled !== 'boolean' || !validRate(settings.rateBps)) return {...defaults};
  return {enabled:settings.enabled,rateBps:settings.rateBps};
}

export function normalizeCardFeeSettings(settings) {
  if (!settings || typeof settings.enabled !== 'boolean' || !validRate(settings.rateBps)) {
    throw new Error('カード会計の加算率を0〜100%で設定してください。');
  }
  return {enabled:settings.enabled,rateBps:settings.rateBps};
}

export function getCardFee(state, payments = []) {
  const {enabled, rateBps} = getCardFeeSettings(state);
  if (!enabled || rateBps === 0) return 0;
  let cardAmount = 0n;
  for (const {method, amount} of payments) {
    if (method === 'card' && Number.isSafeInteger(amount) && amount > 0) cardAmount += BigInt(amount);
  }
  return Number((cardAmount * BigInt(rateBps) + 5_000n) / 10_000n);
}

export function addCardFeeTax(taxBreakdown, grossFee, taxRounding = 'floor') {
  const previousGroup = taxBreakdown.find(({rate}) => rate === standardTaxRate);
  const previousTax = previousGroup?.tax ?? 0;
  const gross = BigInt(previousGroup?.base ?? 0) + BigInt(previousTax) + BigInt(grossFee);
  // Combine the two standard-rate amounts before rounding the tax embedded in the gross total.
  const group = calculationTaxGroup(gross, standardTaxRate, { priceMode: 'inclusive', taxRounding });
  const breakdown = [...taxBreakdown.filter(({rate}) => rate !== standardTaxRate),group]
    .sort((first,second) => second.rate - first.rate);
  return {breakdown,feeTax:group.tax - previousTax};
}
