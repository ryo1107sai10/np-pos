import { roundCalculationRate } from './calculation-settings.mjs';

const maxAmount = 100_000_000;
const maxRate = 10_000;

export function isValidOrderLineDiscount(discount) {
  return discount !== null && typeof discount === 'object' && !Array.isArray(discount)
    && Number.isSafeInteger(discount.value) && discount.value > 0
    && ((discount.kind === 'amount' && discount.value <= maxAmount) || (discount.kind === 'percent' && discount.value <= maxRate));
}

export function isValidOrderLineDiscountSnapshot({lineDiscount,total,price,quantity}) {
  return lineDiscount === undefined || (isValidOrderLineDiscount(lineDiscount) && Number.isSafeInteger(total)
    && total >= 0 && total === price * quantity && (lineDiscount.kind !== 'amount' || lineDiscount.value <= total)
    && Object.keys(lineDiscount).every((key) => key === 'kind' || key === 'value'));
}

export function getOrderLineDiscountAmount({total,lineDiscount}) {
  if (!lineDiscount) return 0;
  return lineDiscount.kind === 'amount' ? lineDiscount.value : roundCalculationRate(total,lineDiscount.value);
}

export function getTicketDiscountableSubtotal({subtotal,lineDiscount = 0}) {
  return subtotal - lineDiscount;
}
