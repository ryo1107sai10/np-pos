export const maxPersonalSalesAdjustment = 100_000_000;
export const personalSalesDiscountModes = Object.freeze({
  reflect: '個人売上に反映する',
  keep: '値引き前の個人売上を維持する',
});

const roles = new Set(['admin', 'manager']);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function isPersonalSalesDiscountMode(value) {
  return typeof value === 'string' && Object.hasOwn(personalSalesDiscountModes, value);
}

export function getPersonalSalesDiscountMode(ticket) {
  return ticket.discountDetails?.personalSalesMode === 'keep' ? 'keep' : 'reflect';
}

export function isPersonalSalesAmount(amount) {
  return Number.isSafeInteger(amount) && amount !== 0 && Math.abs(amount) <= maxPersonalSalesAdjustment;
}

export function getAdjustablePersonalSalesPeople(state, ticket) {
  const people = new Map((state.cast ?? []).filter(({ enabled }) => enabled !== false)
    .map(({ id, name }) => [id, { id, name }]));
  const names = new Map([...(state.archivedCast ?? []), ...(state.cast ?? [])].map(({ id, name }) => [id, name]));
  for (const line of ticket.lines.filter(({ cancelledAt }) => cancelledAt == null)) {
    (line.castIds ?? []).forEach((id, index) => {
      if (!people.has(id)) people.set(id, { id, name: line.castNames?.[index] ?? names.get(id) ?? id });
    });
  }
  for (const { castId, castName } of ticket.personalSalesAdjustments ?? []) {
    if (!people.has(castId)) people.set(castId, { id: castId, name: castName });
  }
  return [...people.values()];
}

export function recordPersonalSalesAdjustment(state, ticket, action, { actor, at, before, createId }) {
  if (!roles.has(actor.role)) throw new Error('個人売上の調整にはマネージャー以上の権限が必要です。');
  const person = getAdjustablePersonalSalesPeople(state, ticket).find(({ id }) => id === action.castId);
  if (!person) throw new Error('個人売上を調整するキャストを選んでください。');
  const reason = typeof action.reason === 'string' ? action.reason.trim() : '';
  if (!validText(reason, 120)) throw new Error('個人売上を調整する理由を120文字以内で入力してください。');
  const amount = action.amount;
  if (!isPersonalSalesAmount(amount)) throw new Error('増減する金額を1円以上の整数で入力してください。');
  const after = before + amount;
  if (!Number.isSafeInteger(after)) throw new Error('調整後の個人売上額を確認してください。');
  const entry = { id: createId(), castId: person.id, castName: person.name, amount, reason, at, actor: { ...actor },
    salesBefore: before, salesAfter: after };
  (ticket.personalSalesAdjustments ??= []).push(entry);
}

export function isValidPersonalSalesHistory(ticket) {
  const adjustments = ticket.personalSalesAdjustments;
  if (![ticket.discountDetails, ticket.discountRequest].every((entry) => entry?.personalSalesMode === undefined
      || isPersonalSalesDiscountMode(entry.personalSalesMode))) return false;
  if (adjustments === undefined) return true;
  return Array.isArray(adjustments) && adjustments.every((entry) => record(entry) && validId(entry.id)
    && validId(entry.castId) && validText(entry.castName, 128) && isPersonalSalesAmount(entry.amount) && validText(entry.reason, 120)
    && Number.isSafeInteger(entry.at) && entry.at >= 0 && Number.isFinite(new Date(entry.at).getTime()) && record(entry.actor)
    && validText(entry.actor.id, 256) && validText(entry.actor.label, 320) && roles.has(entry.actor.role)
    && Number.isSafeInteger(entry.salesBefore) && Number.isSafeInteger(entry.salesAfter)
    && entry.salesAfter === entry.salesBefore + entry.amount)
    && new Set(adjustments.map(({ id }) => id)).size === adjustments.length;
}

export function personalSalesAdjustmentDetails(ticket) {
  return (ticket.personalSalesAdjustments ?? []).map(({ id, castId, castName, amount, reason, at }) => ({
    castId, castName, lineId: id, name: '個人売上の調整', adjustmentReason: reason, createdAt: at, sales: amount, amount: 0, points: 0,
  }));
}
