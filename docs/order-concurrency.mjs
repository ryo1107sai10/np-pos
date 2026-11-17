// A short reconciliation window keeps verification bounded at the store's write rate.
export const orderConcurrencyWindow = 24;

export function isConcurrentOrder(command) {
  // Item-level changes can include a preview of the entire bill, which becomes stale on another order.
  return command?.type === 'order' && Array.isArray(command.items) && command.items.length > 0
    && command.items.every((item) => item && item.serviceExcluded === undefined && item.taxRateOverride === undefined
      && item.lineDiscount === undefined);
}
