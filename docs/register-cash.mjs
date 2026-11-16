export const cashEntryMaximum = 100_000_000;
export const cashDenominations = Object.freeze([10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1]);

export function isRegisterCashAmount(amount) {
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= cashEntryMaximum;
}

export function getCashPaymentAmount(payments) {
  return payments.reduce((sum, {method, amount}) => sum + (method === 'cash' ? amount : 0), 0);
}

export function calculateCashTender(payments, received) {
  if (received === undefined) return undefined;
  const cash = getCashPaymentAmount(payments);
  if (cash <= 0 || !isRegisterCashAmount(received) || received <= 0) {
    throw new Error('現金でお支払いいただく場合のみ、預かり額を1円以上の整数で入力できます。');
  }
  if (received < cash) throw new Error('現金の預かり額が現金でのお支払額を下回っています。');
  return {received, change:received - cash};
}

export function getCashCountTotal(counts) {
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) return null;
  let total = 0;
  for (const [key, count] of Object.entries(counts)) {
    const denomination = Number(key);
    if (String(denomination) !== key || !cashDenominations.includes(denomination) || !isRegisterCashAmount(count)) return null;
    total += denomination * count;
  }
  return isRegisterCashAmount(total) ? total : null;
}
