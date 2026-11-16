import { calculationTaxGroup, roundCalculationRate } from './calculation-settings.mjs';

const defaults = Object.freeze({enabled:false,rateBps:0});
const standardTaxRate = 1_000;
const brandsLimit = 20;
const brandIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;

function validRate(rateBps) {
  return Number.isInteger(rateBps) && rateBps >= 0 && rateBps <= 10_000;
}

export function getCardFeeSettings(state) {
  const settings = state.cardFeeSettings;
  if (!settings || typeof settings.enabled !== 'boolean' || !validRate(settings.rateBps)) return {...defaults};
  return {enabled:settings.enabled,rateBps:settings.rateBps,
    ...(Array.isArray(settings.brands) && {brands:settings.brands})};
}

export function normalizeCardFeeSettings(settings) {
  if (!settings || typeof settings.enabled !== 'boolean' || !validRate(settings.rateBps)) {
    throw new Error('カード会計の加算率を0〜100%で設定してください。');
  }
  const {enabled,rateBps,brands} = settings;
  if (brands === undefined) return {enabled,rateBps};
  if (!Array.isArray(brands) || brands.length > brandsLimit) throw new Error('決済ブランドは20件まで登録できます。');
  const normalized = brands.map((brand) => {
    const name = typeof brand?.name === 'string' ? brand.name.trim() : '';
    if (typeof brand?.id !== 'string' || !brandIdPattern.test(brand.id) || !['card','qr'].includes(brand?.method)
      || !name || name.length > 40 || /[\p{Cc}\u2028\u2029]/u.test(name) || !validRate(brand?.rateBps)
      || (brand.enabled !== undefined && typeof brand.enabled !== 'boolean')) {
      throw new Error('決済ブランドの名称・種類・加算率を確認してください。');
    }
    return {id:brand.id,name,method:brand.method,rateBps:brand.rateBps,enabled:brand.enabled !== false};
  });
  if (new Set(normalized.map(({id})=>id)).size !== normalized.length
    || new Set(normalized.map(({method,name})=>method+':'+name)).size !== normalized.length) {
    throw new Error('同じ決済ブランドが重複しています。');
  }
  return {enabled,rateBps,brands:normalized};
}

export function getCardFee(state, payments = []) {
  return getPaymentFeeGroups(state,payments).groups.reduce((total,{fee}) => total + fee,0);
}

export function canWaivePaymentFee(role) {
  return ['admin','manager'].includes(role);
}

export function getPaymentFeeGroups(state, payments) {
  const {enabled,rateBps,brands = []} = getCardFeeSettings(state);
  const active = new Map(brands.filter((brand)=>brand.enabled !== false).map((brand)=>[brand.id,brand]));
  const groups = new Map();
  const metadata = payments.map(({method,amount,brandId,waiveFee},index) => {
    const brand = brandId === undefined ? null : active.get(brandId);
    if (brandId !== undefined && (!brand || brand.method !== method)) {
      throw new Error('決済ブランドが更新されています。支払方法を選び直してください。');
    }
    const rate = brand?.rateBps ?? (method === 'card' && enabled ? rateBps : 0);
    if (waiveFee && (!['card','qr'].includes(method) || rate === 0)) throw new Error('加算がある支払方法を選択してください。');
    if (rate > 0 && !waiveFee && Number.isSafeInteger(amount) && amount > 0) {
      const key = brand ? 'brand:'+brand.id : 'card-default';
      const group = groups.get(key) ?? {rate,amount:0n,indexes:[]};
      group.amount += BigInt(amount);
      group.indexes.push(index);
      groups.set(key,group);
    }
    return {rate, ...(brand && {brandId:brand.id,brandName:brand.name}),
      ...(waiveFee && {feeWaived:true,waivedFeeRate:rate})};
  });
  return {metadata,groups:[...groups.values()].map(({rate,amount,indexes}) =>
    ({rate,indexes,fee:Number((amount * BigInt(rate) + 5_000n) / 10_000n)}))};
}

export function depositGrossAmount(deposit) {
  return deposit.amount + (deposit.cardFee ?? 0);
}

export function getDepositPaymentTerms(state, payment, saved = null) {
  const {amount, method, preservePaymentTerms} = payment;
  if (preservePaymentTerms && saved?.method !== method) throw new Error('前受金の支払方法を選び直してください。');
  const previous = preservePaymentTerms ? saved : null;
  const {rate, brandId, brandName, feeWaived, waivedFeeRate} = previous ? {
    ...previous, rate:previous.cardFeeRateBps ?? 0,
  } : getPaymentFeeGroups(state,[payment]).metadata[0];
  const cardFee = rate && !feeWaived && Number.isSafeInteger(amount) && amount > 0
    ? roundCalculationRate(amount,rate,'round') : 0;
  return {...(brandId && {brandId,brandName}),...(feeWaived && {feeWaived,waivedFeeRate}),
    ...(rate && !feeWaived ? {cardFee,cardFeeRateBps:rate} : {})};
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
