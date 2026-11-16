export const receivableCollectionMethods = Object.freeze({ cash: '現金', card: 'カード', bank: '振込' });

export function getReceivableBalance(entry) {
  if (entry.cancelledAt != null) return 0;
  return entry.amount - entry.collections.reduce((total, collection) => total + collection.amount, 0);
}

export function getReceivableStatus(entry, businessDate) {
  if (entry.cancelledAt != null) return 'cancelled';
  const balance = getReceivableBalance(entry);
  if (balance === 0) return 'paid';
  if (entry.dueDate < businessDate) return 'overdue';
  return balance < entry.amount ? 'partial' : 'unpaid';
}

export function getCustomerReceivables(state, customerId) {
  return (state.receivables ?? []).filter((entry) => entry.customerId === customerId);
}

export function getCustomerReceivableBalance(state, customerId) {
  return getCustomerReceivables(state, customerId).reduce((total, entry) => total + getReceivableBalance(entry), 0);
}

export function getReceivableRecoveryTotals(state, date) {
  const totals = { cash: 0, card: 0, bank: 0 };
  for (const entry of state.receivables ?? []) {
    if (entry.cancelledAt != null) continue;
    for (const collection of entry.collections) {
      if (collection.date === date) totals[collection.method] += collection.amount;
    }
  }
  return totals;
}
