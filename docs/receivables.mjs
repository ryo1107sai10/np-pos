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

function matchingTicketReceivable(state, ticket, date) {
  const amount = billedReceivable(ticket);
  const entries = activeTicketReceivables(state, ticket.id);
  if (!amount && !entries.length) return null;
  const [entry] = entries;
  if (entries.length !== 1 || !amount || entry.amount !== amount || entry.date !== date
    || entry.ticketNumber !== ticket.number || entry.customerId !== ticket.customerId) {
    throw new Error('会計内容と売掛台帳が一致しません。売掛の記録を確認してください。');
  }
  return entry;
}

export function reassignSettledTicketReceivable(state, ticket, date, customerId) {
  const entry = matchingTicketReceivable(state, ticket, date);
  if (!entry) return;
  if (!customerId) throw new Error('売掛のある伝票には登録済みの顧客を指定してください。');
  entry.customerId = customerId;
}

function validDueDate(dueDate, date) {
  return typeof dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) && dueDate >= date
    && Number.isFinite(Date.parse(dueDate)) && new Date(dueDate).toISOString().slice(0, 10) === dueDate;
}

export function correctSettledTicketReceivable(state, ticket, action, { amount, date, now, actor, createId }) {
  const entry = matchingTicketReceivable(state, ticket, date);
  if (!entry && amount === 0) return;
  const collected = entry ? entry.amount - getReceivableBalance(entry) : 0;
  if (amount < collected) throw new Error('売掛額は回収済みの金額以上にしてください。');
  if (amount === 0) {
    entry.cancelledAt = now;
    return;
  }
  const dueDate = entry?.dueDate ?? action.creditDueDate;
  if (!validDueDate(dueDate, date)) throw new Error('営業日以降の有効な支払期日を入力してください。');
  if (entry && action.creditDueDate !== undefined && action.creditDueDate !== entry.dueDate) {
    throw new Error('支払方法の訂正時は既存の売掛の支払期日を変更できません。');
  }

  const customer = state.customers?.find(({ id }) => id === ticket.customerId);
  if (!customer) throw new Error('売掛会計には登録済みの顧客が必要です。');
  let creditOverride;
  const previousAmount = entry?.amount ?? 0;
  if (amount > previousAmount) {
    if (customer.creditEnabled !== true) throw new Error('この顧客の売掛利用を許可してください。');
    const {creditLimit} = customer;
    if (!Number.isSafeInteger(creditLimit) || creditLimit < 0 || creditLimit > 100_000_000) {
      throw new Error('与信上限を円単位で入力してください。');
    }
    const balanceBefore = getCustomerReceivableBalance(state, customer.id);
    if (balanceBefore + (amount - previousAmount) > creditLimit) {
      const reason = typeof action.reason === 'string' ? action.reason.trim() : '';
      if (actor?.role !== 'admin' || !reason || reason.length > 120) {
        throw new Error('与信上限の超過には店舗管理者の承認理由が必要です。');
      }
      creditOverride = { actorId: actor.id, reason, creditLimit, balanceBefore };
    }
  }

  if (entry) {
    entry.amount = amount;
    if (creditOverride) entry.creditOverride = creditOverride;
    return;
  }
  (state.receivables ??= []).unshift({ id: createId(), customerId: customer.id, ticketId: ticket.id,
    ticketNumber: ticket.number, issuedAt: ticket.settledAt ?? now, date, dueDate, amount, collections: [],
    cancelledAt: null, ...(creditOverride ? { creditOverride } : {}) });
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
