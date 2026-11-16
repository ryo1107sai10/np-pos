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

function billedReceivable(ticket) {
  return ticket.payments.reduce((total, { method, amount }) => total + (method === 'receivable' ? amount : 0), 0);
}

function activeTicketReceivables(state, ticketId) {
  return (state.receivables ?? []).filter((entry) => entry.ticketId === ticketId && entry.cancelledAt == null);
}

export function ticketHasReceivable(state, ticket) {
  return billedReceivable(ticket) > 0 || activeTicketReceivables(state, ticket.id).length > 0;
}

export function reassignSettledTicketReceivable(state, ticket, date, customerId) {
  const amount = billedReceivable(ticket);
  const entries = activeTicketReceivables(state, ticket.id);
  if (!amount && !entries.length) return;
  const [entry] = entries;
  if (entries.length !== 1 || !amount || entry.amount !== amount || entry.date !== date
    || entry.ticketNumber !== ticket.number || entry.customerId !== ticket.customerId) {
    throw new Error('会計内容と売掛台帳が一致しません。売掛の記録を確認してください。');
  }
  if (!customerId) throw new Error('売掛のある伝票には登録済みの顧客を指定してください。');
  entry.customerId = customerId;
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
