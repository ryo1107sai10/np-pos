const minuteMs = 60_000;
const maxIntervalsPerSync = 100;
const operatorRoles = new Set(['admin', 'manager', 'staff']);
const defaults = Object.freeze({ enabled: false, menuId: '', effectiveAt: null });

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPlanId(value) {
  return typeof value === 'string' && value.length <= 100 && value.trim() === value;
}

export function isValidAutoExtensionSettings(settings) {
  return settings != null && typeof settings === 'object' && !Array.isArray(settings)
    && typeof settings.enabled === 'boolean' && isPlanId(settings.menuId)
    && (settings.enabled ? Boolean(settings.menuId) && isTimestamp(settings.effectiveAt) : settings.effectiveAt === null);
}

export function getAutoExtensionSettings(state) {
  const settings = state.autoExtensionSettings;
  return isValidAutoExtensionSettings(settings)
    ? {enabled: settings.enabled, menuId: settings.menuId, effectiveAt: settings.effectiveAt} : {...defaults};
}

function hasStockRecipe(item) {
  return item?.recipe != null && (!Array.isArray(item.recipe) || item.recipe.length > 0);
}

export function getAutoExtensionPlans(state) {
  const surcharge = state.menu.find((item) => item.id === 'nominationExtra' && item.enabled !== false);
  if (hasStockRecipe(surcharge)) return [];
  return state.menu.filter((item) => item.category === '延長' && item.enabled !== false && !item.requiresCast
    && Number.isInteger(item.duration) && item.duration > 0 && item.duration <= 1_440 && !hasStockRecipe(item));
}

function availablePlan(state, id) {
  return getAutoExtensionPlans(state).find((item) => item.id === id);
}

export function getAutomaticExtensionPlan(state) {
  const settings = getAutoExtensionSettings(state);
  return settings.enabled ? availablePlan(state, settings.menuId) : undefined;
}

function dueAt(ticket, effectiveAt, interval) {
  if (ticket.status !== 'open' || !isTimestamp(ticket.endsAt)) return null;
  const resumedAt = isTimestamp(ticket.autoExtensionResumedAt) ? ticket.autoExtensionResumedAt : 0;
  const activeSince = Math.max(effectiveAt, resumedAt);
  return ticket.endsAt <= activeSince ? activeSince + interval : ticket.endsAt;
}

export function getNextAutoExtensionAt(state) {
  if (state.day.status !== 'open') return null;
  const plan = getAutomaticExtensionPlan(state);
  if (!plan) return null;
  const {effectiveAt} = getAutoExtensionSettings(state);
  let next = null;
  for (const ticket of state.tickets) {
    const due = dueAt(ticket, effectiveAt, plan.duration * minuteMs);
    if (due !== null && (next === null || due < next)) next = due;
  }
  return next;
}

export function saveAutoExtensionSettings(state, action, now, actor) {
  if (actor.role !== 'admin') throw new Error('自動延長の変更には店舗管理者の権限が必要です。');
  if (typeof action.enabled !== 'boolean' || !isPlanId(action.menuId)) throw new Error('自動延長の設定を確認してください。');
  if (action.enabled && !availablePlan(state, action.menuId)) throw new Error('自動延長に使う有効な延長プランを選択してください。');
  const previous = getAutoExtensionSettings(state);
  const unchanged = previous.enabled && previous.menuId === action.menuId;
  const effectiveAt = action.enabled ? (unchanged ? previous.effectiveAt : now) : null;
  state.autoExtensionSettings = {enabled: action.enabled, menuId: action.menuId, effectiveAt};
}

export function syncAutomaticExtensions(state, now, actor, addExtension) {
  if (!operatorRoles.has(actor.role)) throw new Error('自動延長を反映する権限がありません。');
  if (state.day.status !== 'open') return;
  const plan = getAutomaticExtensionPlan(state);
  if (!plan) return;
  const {effectiveAt} = getAutoExtensionSettings(state);
  const interval = plan.duration * minuteMs;
  let available = maxIntervalsPerSync;
  for (const ticket of state.tickets) {
    let due = dueAt(ticket, effectiveAt, interval);
    if (due === null) continue;
    while (due <= now && available > 0) {
      // With existing overtime, advance from the new schedule instead of billing time before activation.
      ticket.endsAt = due;
      addExtension(state, ticket, plan, due, true);
      due = ticket.endsAt;
      available--;
    }
    if (available === 0) return;
  }
}
