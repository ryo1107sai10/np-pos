export const cashMovementKinds = Object.freeze({ deposit: '入金', withdrawal: '出金', expense: '経費' });

export const cashMovementCategories = Object.freeze({
  deposit: Object.freeze({ float: '釣銭の補充', safe: '金庫からの移動', other: 'その他' }),
  withdrawal: Object.freeze({ safe: '金庫への移動', bank: '銀行への預け入れ', other: 'その他' }),
  expense: Object.freeze({ supplies: '消耗品', purchase: '仕入れ', transport: '交通費', other: 'その他' }),
});

const cashOperators = new Set(['admin', 'manager']);
const currencyLimit = 100_000_000;

function validKind(kind) {
  return typeof kind === 'string' && Object.hasOwn(cashMovementKinds, kind);
}

function validCategory(kind, category) {
  return typeof category === 'string' && Object.hasOwn(cashMovementCategories[kind], category);
}

function validAmount(amount) {
  return Number.isSafeInteger(amount) && amount > 0 && amount <= currencyLimit;
}

function validText(value, maximum, required = false) {
  return typeof value === 'string' && value.length <= maximum && (!required || value.trim().length > 0);
}

function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date;
}

export function isValidCashMovement(entry) {
  return entry != null && validText(entry.id, 128, true) && validDate(entry.date) && Number.isSafeInteger(entry.at) && entry.at >= 0
    && validKind(entry.kind) && validCategory(entry.kind, entry.category) && validAmount(entry.amount)
    && validText(entry.reason, 120, true) && validText(entry.destination, 80)
    && validText(entry.actor?.id, 256, true) && validText(entry.actor?.label, 320, true) && cashOperators.has(entry.actor?.role);
}

export function createCashMovement(state, action, at, actor, allocateId) {
  if (!cashOperators.has(actor.role)) throw new Error('入出金の登録にはマネージャー以上の権限が必要です。');
  if (state.day.status !== 'open') throw new Error('営業中に入出金を登録できます。');
  if (!validKind(action.kind)) throw new Error('入出金の種類を選択してください。');
  if (!validCategory(action.kind, action.category)) throw new Error('理由区分を選択してください。');
  if (!validAmount(action.amount)) throw new Error('入出金額を1円以上の円単位で入力してください。');
  if (!validText(action.reason, 120, true)) throw new Error('入出金の理由を120文字以内で入力してください。');
  const destination = action.destination ?? '';
  if (!validText(destination, 80)) throw new Error('移動先・支払先は80文字以内で入力してください。');
  return { id: allocateId(), date: state.day.date, at, kind: action.kind, amount: action.amount,
    category: action.category, reason: action.reason.trim(), destination: destination.trim(), actor: { ...actor } };
}

export function getCashMovements(state, date) {
  return (state.cashMovements ?? []).filter((entry) => entry.date === date);
}

export function totalCashMovements(entries) {
  const totals = { cashIn: 0, cashOut: 0, expenses: 0 };
  for (const entry of entries) {
    if (entry.kind === 'deposit') totals.cashIn += entry.amount;
    else totals.cashOut += entry.amount;
    if (entry.kind === 'expense') totals.expenses += entry.amount;
  }
  return totals;
}

export function getRecoveryRows(state, businessDate) {
  const rows = [];
  for (const entry of state.receivables ?? []) {
    if (entry.cancelledAt != null) continue;
    for (const collection of entry.collections) {
      if (businessDate !== undefined && collection.date !== businessDate) continue;
      const { id, date, at, amount, method } = collection;
      rows.push({ id, date, at, amount, method });
    }
  }
  return rows;
}

export function getDailyRecoveryRows(state, date) {
  return getRecoveryRows(state, date);
}
