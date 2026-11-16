const minuteMs = 60_000;
const maxIntervalsPerSync = 100;
const operatorRoles = new Set(['admin', 'manager', 'staff']);
const pauseSources = new Set(['manual', 'checkout']);
const defaults = Object.freeze({ enabled: false, menuId: '', effectiveAt: null });

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isAutoExtensionPauseSource(source) {
  return pauseSources.has(source);
}

export function isVisitAutoExtensionPaused(ticket) {
  return isTimestamp(ticket?.autoExtensionPausedAt);
}

export function isValidVisitAutoExtensionPause(ticket) {
  const {autoExtensionPausedAt, autoExtensionPauseSource} = ticket;
  return (autoExtensionPausedAt === undefined && autoExtensionPauseSource === undefined)
    || (isVisitAutoExtensionPaused(ticket) && isAutoExtensionPauseSource(autoExtensionPauseSource));
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

export function getTableAutoExtensionEnabled(state, tableId) {
  return state.tableAutoExtension?.[tableId] !== false;
}

export function getLinkedTablesAutoExtensionEnabled(state, tableIds) {
  return tableIds?.every((tableId) => getTableAutoExtensionEnabled(state, tableId)) ?? true;
}

function automaticSchedule(state) {
  if (state.day.status !== 'open') return null;
  const plan = getAutomaticExtensionPlan(state);
  if (!plan) return null;
  return {plan,effectiveAt:getAutoExtensionSettings(state).effectiveAt,interval:plan.duration * minuteMs};
}

function dueAt(state, ticket, {effectiveAt, interval}) {
  if (ticket.status !== 'open' || !isTimestamp(ticket.endsAt)
    || isVisitAutoExtensionPaused(ticket)
    || !getLinkedTablesAutoExtensionEnabled(state, ticket.tableIds)) return null;
  const resumedAt = isTimestamp(ticket.autoExtensionResumedAt) ? ticket.autoExtensionResumedAt : 0;
  const activeSince = Math.max(effectiveAt, resumedAt);
  return ticket.endsAt <= activeSince ? activeSince + interval : ticket.endsAt;
}

export function getTicketAutoExtensionAt(state, ticket) {
  const schedule = automaticSchedule(state);
  return schedule ? dueAt(state, ticket, schedule) : null;
}

export function getAutoExtensionNotices(state, now = Date.now(), leadMs = minuteMs) {
  const schedule = automaticSchedule(state);
  if (!schedule) return [];
  const notices = [];
  for (const ticket of state.tickets) {
    const deadline = dueAt(state, ticket, schedule);
    if (ticket.tableIds?.length && deadline != null && now < deadline && deadline - now <= leadMs) {
      notices.push({ticketId:ticket.id,tableIds:ticket.tableIds.slice(),deadline});
    }
  }
  return notices.sort((first, second) => first.deadline - second.deadline);
}

export function getNextAutoExtensionAt(state) {
  const schedule = automaticSchedule(state);
  if (!schedule) return null;
  let next = null;
  for (const ticket of state.tickets) {
    const due = dueAt(state, ticket, schedule);
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

export function setTableAutoExtension(state, {tableId, enabled}, now, actor) {
  if (!operatorRoles.has(actor.role)) throw new Error('卓の自動延長を変更する権限がありません。');
  if (typeof enabled !== 'boolean') throw new Error('卓の自動延長の設定を確認してください。');
  if (typeof tableId !== 'string' || !state.tables.some(({id}) => id === tableId)) {
    throw new Error('指定された卓が見つかりません。');
  }
  if (getTableAutoExtensionEnabled(state, tableId) === enabled) return;
  const entries = new Map(Object.entries(state.tableAutoExtension ?? {}));
  if (enabled) entries.delete(tableId);
  else entries.set(tableId, false);
  if (entries.size) state.tableAutoExtension = Object.fromEntries(entries);
  else delete state.tableAutoExtension;
  if (!enabled) return;
  for (const ticket of state.tickets) {
    if (ticket.status === 'open' && ticket.tableIds?.includes(tableId)
      && getLinkedTablesAutoExtensionEnabled(state, ticket.tableIds)) ticket.autoExtensionResumedAt = now;
  }
}

export function pauseVisitAutoExtension(state, ticket, {source}, now, actor) {
  if (!operatorRoles.has(actor.role)) throw new Error('来店中の自動延長を止める権限がありません。');
  if (!isAutoExtensionPauseSource(source)) throw new Error('自動延長を止める操作を確認してください。');
  if (isVisitAutoExtensionPaused(ticket)) return;
  const deadline = getTicketAutoExtensionAt(state, ticket);
  if (deadline !== null && deadline <= now) {
    throw new Error('自動延長の予定時刻を過ぎました。最新の伝票を確認してください。');
  }
  ticket.autoExtensionPausedAt = now;
  ticket.autoExtensionPauseSource = source;
}

export function syncAutomaticExtensions(state, now, actor, addExtension) {
  if (!operatorRoles.has(actor.role)) throw new Error('自動延長を反映する権限がありません。');
  const schedule = automaticSchedule(state);
  if (!schedule) return;
  let available = maxIntervalsPerSync;
  for (const ticket of state.tickets) {
    let due = dueAt(state, ticket, schedule);
    if (due === null) continue;
    while (due <= now && available > 0) {
      // With existing overtime, advance from the new schedule instead of billing time before activation.
      ticket.endsAt = due;
      addExtension(state, ticket, schedule.plan, due, true);
      due = ticket.endsAt;
      available--;
    }
    if (available === 0) return;
  }
}
