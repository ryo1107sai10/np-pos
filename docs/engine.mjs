import { getStoreSettings, normalizeStoreSettings, replaceStoreSettings } from './store-settings.mjs';

const movementScale = 1_000_000;
const pointsScale = 1_000;
const minute = 60_000;
const methods = ['cash', 'card', 'qr'];
const methodLabel = { cash: '現金', card: 'カード', qr: 'QR決済' };
const occupiedStatuses = new Set(['open', 'paid']);
const japanDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
});
const moneyFormatter = new Intl.NumberFormat('ja-JP');

export const layoutGrid = Object.freeze({ columns: 12, rows: 8, tableWidth: 3, tableHeight: 2 });
const layoutNameMaxLength = 24;
const newTableId = /^table-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const layoutFileFormat = 'np-pos.layout';
const layoutFileVersion = 1;
const storeFileFormat = 'np-pos.settings';
const storeFileVersion = 2;

function isLayoutPosition(x, y) {
  return Number.isInteger(x) && x >= 0 && x + layoutGrid.tableWidth <= layoutGrid.columns
    && Number.isInteger(y) && y >= 0 && y + layoutGrid.tableHeight <= layoutGrid.rows;
}

export function getLayoutTables(state) {
  const countByArea = new Map();
  const columnStep = layoutGrid.tableWidth + 1;
  const rowStep = layoutGrid.tableHeight + 1;
  const tablesPerRow = Math.floor(layoutGrid.columns / columnStep);
  return state.tables.map((table) => {
    const index = countByArea.get(table.area) ?? 0;
    countByArea.set(table.area, index + 1);
    if (isLayoutPosition(table.x, table.y)) return { ...table };
    return { ...table, x: (index % tablesPerRow) * columnStep, y: Math.floor(index / tablesPerRow) * rowStep };
  });
}

export function getLayoutAreas(state) {
  return state.layoutAreas?.slice() ?? [...new Set([...layoutAreas, ...state.tables.map((table) => table.area)])];
}

export function getTableLabel(state, id) {
  return state.tables.find((table) => table.id === id)?.name
    ?? state.archivedTables?.find((table) => table.id === id)?.name
    ?? id;
}

export function exportLayout(state) {
  return {
    format: layoutFileFormat,
    version: layoutFileVersion,
    areas: getLayoutAreas(state),
    tables: getLayoutTables(state).map(({ id, layoutSourceId, name, area, x, y, capacity }) => ({
      id: layoutSourceId ?? id, name, area, x, y, capacity,
    })),
  };
}

function parseSettingsJson(text, label) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${label}を読み取れませんでした。JSON形式のファイルを選択してください。`);
  }
}

export function parseLayoutFile(text) {
  return normalizeLayoutFile(parseSettingsJson(text, '卓配置ファイル'));
}

function validatedStoreSettings(settings, state, requireStock = false) {
  return normalizeStoreSettings(settings, {
    menuIds: new Set(menu.map(({ id }) => id)),
    castIds: new Set(cast.map(({ id }) => id)),
    stockMasterIds: new Set(stockSeed.map(([id]) => id)),
    localStockIds: state ? new Set(state.stock.map(({ id }) => id)) : null,
    requireStock,
  });
}

export function exportStoreConfiguration(state) {
  return {
    format: storeFileFormat, version: storeFileVersion,
    layout: exportLayout(state), settings: getStoreSettings(state),
  };
}

export function parseStoreConfiguration(text) {
  const file = parseSettingsJson(text, '店舗設定ファイル');
  if (file?.format === layoutFileFormat) return { layout: normalizeLayoutFile(file), settings: null };
  assert(file?.format === storeFileFormat, 'NP POSの店舗設定ファイルを選択してください。');
  const legacy = file.version === 1;
  assert(legacy || file.version === storeFileVersion, 'このバージョンの店舗設定ファイルには対応していません。');
  const input = legacy ? { menu: file.settings?.menu, cast: file.settings?.cast } : file.settings;
  const settings = validatedStoreSettings(input, null, !legacy);
  return { layout: normalizeLayoutFile(file.layout), settings };
}

export function yen(amount) {
  return `¥${moneyFormatter.format(amount)}`;
}

export function businessDate(now = Date.now()) {
  const parts = Object.fromEntries(japanDate.formatToParts(new Date(now - 6 * 60 * minute))
    .map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInteger(number, label, limit = 100) {
  assert(Number.isInteger(number) && number > 0 && number <= limit, `${label}を確認してください。`);
  return number;
}

function money(number, label, allowZero = true) {
  assert(Number.isSafeInteger(number) && number >= (allowZero ? 0 : 1) && number <= 100_000_000,
    `${label}を円単位で入力してください。`);
  return number;
}

function decimalUnits(number) {
  assert(Number.isFinite(number) && Math.abs(number) <= 1_000_000, '在庫数量を確認してください。');
  const units = Math.round(number * movementScale);
  assert(Math.abs(units / movementScale - number) < 0.00000001, '在庫数量は小数点以下6桁まで入力できます。');
  return units;
}

function totalOf(records) {
  return records.reduce((total, record) => total + record.amount, 0);
}

function createId(state, prefix) {
  return `${prefix}-${state.nextId++}`;
}

function tableSet(state, tableIds, guests, exceptTicketId) {
  assert(Array.isArray(tableIds) && tableIds.length > 0 && new Set(tableIds).size === tableIds.length,
    '使用する卓を1つ以上選択してください。');
  const tables = tableIds.map((tableId) => {
    const table = state.tables.find((entry) => entry.id === tableId);
    assert(table, '指定された卓が見つかりません。');
    const current = getTicketForTable(state, tableId);
    assert(!current || current.id === exceptTicketId, `${table.name}は使用中です。`);
    return table;
  });
  assert(tables.reduce((capacity, table) => capacity + table.capacity, 0) >= guests,
    '人数が選択した卓の定員を超えています。');
  return tableIds.slice();
}

function recordTableAssignment(ticket, tableIds, now) {
  const history = ticket.tableHistory ?? ticket.tableIds.map((tableId) => ({
    tableId, attachedAt: ticket.createdAt, releasedAt: null,
  }));
  const assigned = new Set(tableIds);
  const active = new Set();
  for (const entry of history) {
    if (entry.releasedAt !== null) continue;
    if (assigned.has(entry.tableId)) active.add(entry.tableId);
    else entry.releasedAt = now;
  }
  for (const tableId of tableIds) {
    if (!active.has(tableId)) history.push({ tableId, attachedAt: now, releasedAt: null });
  }
  ticket.tableHistory = history;
}

export function getTicketForTable(state, tableId) {
  return state.tickets.find((ticket) => occupiedStatuses.has(ticket.status) && ticket.tableIds.includes(tableId)) ?? null;
}

export function tableStatus(state, tableId, now = Date.now()) {
  const ticket = getTicketForTable(state, tableId);
  if (!ticket) return 'available';
  if (ticket.status === 'paid') return 'paid';
  if (ticket.endsAt <= now) return 'overtime';
  return ticket.endsAt <= now + 10 * minute ? 'soon' : 'active';
}

function findTicket(state, ticketId) {
  const ticket = state.tickets.find((entry) => entry.id === ticketId);
  assert(ticket, '伝票が見つかりません。');
  return ticket;
}

function requireOrderable(ticket) {
  assert(ticket.status === 'open', '会計前の伝票で操作してください。');
}

function allocate(total, weights) {
  const divisor = weights.reduce((sum, weight) => sum + weight, 0);
  if (!divisor || !total) return weights.map(() => 0);
  const value = BigInt(total);
  const denominator = BigInt(divisor);
  const portions = weights.map((weight, index) => {
    const numerator = value * BigInt(weight);
    return { index, amount: Number(numerator / denominator), remainder: numerator % denominator };
  });
  let remaining = total - portions.reduce((sum, entry) => sum + entry.amount, 0);
  const ordered = portions.slice().sort((first, second) => {
    if (first.remainder === second.remainder) return first.index - second.index;
    return first.remainder > second.remainder ? -1 : 1;
  });
  for (const entry of ordered) {
    if (remaining === 0) break;
    entry.amount++;
    remaining--;
  }
  return portions.map((entry) => entry.amount);
}

function exactRate(total, rate) {
  return Number(BigInt(total) * BigInt(rate) / 10_000n);
}

export function getItemCommission(item, person) {
  return { rate: 0, fixed: 0, points: 0, ...item.commission, ...person?.commissionOverride };
}

function equalShare(total, count, index) {
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
}

function addCommission(map, castId, sales, amount, pointsInUnits) {
  const current = map.get(castId) ?? { castId, sales: 0, amount: 0, pointsInUnits: 0 };
  current.sales += sales;
  current.amount += amount;
  current.pointsInUnits += pointsInUnits;
  map.set(castId, current);
}

function outputCommission(map) {
  return [...map.values()].map(({ pointsInUnits, ...entry }) => ({ ...entry, points: pointsInUnits / pointsScale }));
}

export function quote(state, ticketId) {
  const ticket = findTicket(state, ticketId);
  if (ticket.settlement) return structuredClone(ticket.settlement);
  const lines = ticket.lines.filter((line) => line.cancelledAt === null);
  const subtotal = lines.reduce((total, line) => total + line.total, 0);
  const discount = Math.min(ticket.discount, subtotal);
  const discountByLine = allocate(discount, lines.map((line) => line.total));
  const netByLine = lines.map((line, index) => line.total - discountByLine[index]);
  const serviceWeights = lines.map((line, index) => line.serviceEligible ? netByLine[index] : 0);
  const service = exactRate(serviceWeights.reduce((sum, weight) => sum + weight, 0), ticket.serviceRate);
  const serviceByLine = allocate(service, serviceWeights);
  const groupedTax = new Map();
  const commission = new Map();

  lines.forEach((line, index) => {
    groupedTax.set(line.taxRate, (groupedTax.get(line.taxRate) ?? 0) + netByLine[index] + serviceByLine[index]);
    if (line.castIds.length === 0) return;
    const count = line.castIds.length;
    line.castIds.forEach((castId, castIndex) => {
      const rule = line.castCommissions?.[castIndex] ?? line.commission;
      const sales = equalShare(netByLine[index], count, castIndex);
      const fixed = equalShare(rule.fixed * line.quantity, count, castIndex);
      const points = equalShare(Math.round(rule.points * pointsScale) * line.quantity, count, castIndex);
      addCommission(commission, castId, sales, fixed + exactRate(sales, Math.round(rule.rate * 100)), points);
    });
  });

  const taxBreakdown = [...groupedTax].sort(([first], [second]) => second - first)
    .map(([rate, base]) => ({ rate, base, tax: exactRate(base, rate) }));
  const tax = taxBreakdown.reduce((total, group) => total + group.tax, 0);
  const total = subtotal - discount + service + tax;
  const deposit = totalOf(ticket.deposits);
  const paid = totalOf(ticket.payments);
  return { subtotal, discount, service, tax, total, deposit, paid, remaining: Math.max(0, total - deposit - paid),
    commission: outputCommission(commission), taxBreakdown };
}

function newStockMovement(state, stock, amount, kind, reason, now, ticketId = null, sourceLineId = null, unitCost = stock.unitCost) {
  const quantity = decimalUnits(stock.quantity) + decimalUnits(amount);
  assert(quantity >= 0, `${stock.name}の在庫が不足しています。`);
  const oldValue = stock.value;
  const newValue = quantity === 0 ? 0 : Math.max(0, oldValue + amount * unitCost);
  stock.quantity = quantity / movementScale;
  stock.value = Math.round(newValue * movementScale) / movementScale;
  stock.unitCost = quantity > 0 ? Math.round(stock.value / stock.quantity * movementScale) / movementScale : stock.unitCost;
  state.movements.unshift({ id: createId(state, 'stock'), stockId: stock.id, stockName: stock.name, quantity: amount,
    unit: stock.unit, unitCost, cost: Math.abs(oldValue - stock.value), reason, kind, at: now, ticketId, sourceLineId });
}

function addLine(state, ticket, menu, quantity, castIds, now, { includeHistoricalCast = false } = {}) {
  const people = includeHistoricalCast
    ? [...(state.archivedCast ?? []), ...state.cast]
    : state.cast.filter((person) => person.enabled !== false);
  positiveInteger(quantity, '数量', includeHistoricalCast ? people.length : 100);
  const castById = new Map(people.map((person) => [person.id, person]));
  assert(Array.isArray(castIds) && new Set(castIds).size === castIds.length
    && castIds.every((id) => castById.has(id)), '歩合対象者を確認してください。');
  assert(!menu.requiresCast || castIds.length > 0, `${menu.name}の担当キャストを選択してください。`);
  const line = {
    id: createId(state, 'line'), menuId: menu.id, name: menu.name, category: menu.category, quantity, price: menu.price,
    total: menu.price * quantity, castIds: castIds.slice(), createdAt: now, stockUses: [], cancelledAt: null,
    providedAt: null, taxRate: menu.taxRate ?? 1_000, serviceEligible: menu.serviceEligible !== false,
    commission: getItemCommission(menu),
    castCommissions: castIds.map((id) => getItemCommission(menu, castById.get(id))),
  };
  for (const use of menu.recipe ?? []) {
    const stock = state.stock.find((entry) => entry.id === use.stockId);
    const amount = decimalUnits(use.quantity) * quantity / movementScale;
    const unitCost = stock.unitCost;
    newStockMovement(state, stock, -amount, 'order', menu.name, now, ticket.id, line.id);
    line.stockUses.push({ stockId: stock.id, quantity: amount, unitCost });
  }
  ticket.lines.push(line);
  return line;
}

function currentDay(state) {
  assert(state.day.status === 'open', '最初に開店してください。');
}

function validateMethod(method) {
  assert(methods.includes(method), '支払方法を選択してください。');
}

function canCancel(ticket) {
  assert(totalOf(ticket.deposits) === 0, '先に前受金を取り消してください。');
}

function doOpen(state, action, now) {
  assert(state.day.status === 'closed', 'すでに営業中です。');
  const date = action.date ?? businessDate(now);
  assert(typeof date === 'string' && /^\d{4}-\d\d-\d\d$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date, '営業日を指定してください。');
  assert(!state.closedDays.some((day) => day.date === date), 'この営業日は締め済みです。次の営業日を入力してください。');
  state.tickets = [];
  state.day = { status: 'open', date, openingCash: money(action.openingCash, '釣銭準備金'), openedAt: now,
    closedAt: null, closingCash: null };
}

function doSeat(state, action, now) {
  currentDay(state);
  const guests = positiveInteger(action.guests, '来店人数');
  const tableIds = tableSet(state, action.tableIds, guests);
  const set = state.menu.find((entry) => entry.id === action.setId && entry.category === 'セット' && entry.enabled !== false);
  assert(set, '初回セットを選択してください。');
  const ticket = {
    id: createId(state, 'ticket'), number: state.nextTicket++, tableIds, guests,
    tableHistory: tableIds.map((tableId) => ({ tableId, attachedAt: now, releasedAt: null })),
    customer: String(action.customer ?? '').trim().slice(0, 60), createdAt: now, status: 'open',
    endsAt: now + set.duration * minute, lines: [], discount: 0, deposits: [], payments: [], settledAt: null,
    departedAt: null, serviceRate: 2_000, settlement: null,
  };
  state.tickets.push(ticket);
  addLine(state, ticket, set, guests, [], now);
}

function doClose(state, action, now) {
  currentDay(state);
  assert(!state.tickets.some((ticket) => occupiedStatuses.has(ticket.status)), '使用中または退店待ちの卓があります。');
  const actualCash = money(action.actualCash, '実残高');
  const totals = summary(state);
  const discrepancy = actualCash - totals.expectedCash;
  const reason = String(action.reason ?? '').trim().slice(0, 120);
  assert(!discrepancy || reason.length > 0, 'レジ差額の理由を入力してください。');
  state.day = { ...state.day, status: 'closed', closedAt: now, closingCash: actualCash };
  state.closedDays.unshift({ date: state.day.date, openedAt: state.day.openedAt, closedAt: now,
    openingCash: state.day.openingCash, actualCash, expectedCash: totals.expectedCash, discrepancy, reason,
    sales: totals.sales, guests: totals.guests, tickets: totals.tickets, commission: totals.commission, payments: totals.payments });
}

function doStockAdjust(state, action, now) {
  const stock = state.stock.find((entry) => entry.id === action.stockId);
  assert(stock, '在庫品目が見つかりません。');
  const units = decimalUnits(action.quantity);
  assert(units !== 0, '数量の増減を入力してください。');
  const reason = String(action.reason ?? '').trim().slice(0, 120);
  assert(reason.length > 0, '調整理由を入力してください。');
  const unitCost = units > 0 ? stock.defaultUnitCost ?? stock.unitCost : stock.unitCost;
  newStockMovement(state, stock, units / movementScale, 'adjust', reason, now, null, null, unitCost);
}

function layoutName(value, label) {
  const name = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  assert(name.length > 0 && name.length <= layoutNameMaxLength && !/[\p{Cc}\u2028\u2029]/u.test(name),
    `${label}は1〜${layoutNameMaxLength}文字で入力してください。`);
  return name;
}

function layoutNameKey(name) {
  return name.normalize('NFKC').toLowerCase();
}

export function removeLayoutArea(areas, tables, area) {
  const target = typeof area === 'string' ? layoutNameKey(area.trim()) : '';
  const isTarget = (name) => typeof name === 'string' && layoutNameKey(name.trim()) === target;
  assert(target && areas.some(isTarget), '指定されたエリアが見つかりません。');
  assert(!tables.some((table) => isTarget(table.area)),
    '卓があるエリアは削除できません。先に卓を移動するか削除してください。');
  return areas.filter((name) => !isTarget(name));
}

function validateLayout(areas, tables, findCurrentTable) {
  assert(Array.isArray(tables), 'すべての卓の配置を指定してください。');
  assert(Array.isArray(areas) && (areas.length > 0 || tables.length === 0),
    '卓が残っている間は、エリアを1つ以上指定してください。');
  const areasByKey = new Map();
  for (const entry of areas) {
    const area = layoutName(entry, 'エリア名');
    const key = layoutNameKey(area);
    assert(!areasByKey.has(key), `エリア名「${area}」が重複しています。`);
    areasByKey.set(key, area);
  }

  const updatedById = new Map();
  const namesByArea = new Map();
  for (const placement of tables) {
    const id = placement?.id;
    assert(!updatedById.has(id), '卓の指定が重複しています。');
    const current = findCurrentTable(id);
    const { x, y, capacity } = placement;
    const name = layoutName(placement.name === undefined ? current?.name : placement.name, '卓名');
    const area = areasByKey.get(layoutNameKey(layoutName(placement.area, 'エリア名')));
    assert(area, `${name}のエリアを確認してください。`);
    assert(isLayoutPosition(x, y), `${name}をフロアの範囲内に配置してください。`);
    positiveInteger(capacity, `${name}の定員`);
    const names = namesByArea.get(area) ?? new Set();
    const nameKey = layoutNameKey(name);
    assert(!names.has(nameKey), `${area}の卓名「${name}」が重複しています。`);
    names.add(nameKey);
    namesByArea.set(area, names);
    for (const other of updatedById.values()) {
      const overlaps = area === other.area && Math.abs(x - other.x) < layoutGrid.tableWidth
        && Math.abs(y - other.y) < layoutGrid.tableHeight;
      assert(!overlaps, `${name}と${other.name}の配置が重なっています。`);
    }
    updatedById.set(id, { ...current, id, name, area, x, y, capacity });
  }
  return { areas: [...areasByKey.values()], tables: updatedById };
}

function doSaveLayout(state, { areas, tables }, allowSampleTableIds = false) {
  const legacySave = areas === undefined;
  assert(!legacySave || (Array.isArray(tables) && tables.length === state.tables.length),
    'すべての卓の配置を指定してください。');
  const existing = getLayoutTables(state);
  const tablesById = new Map(existing.map((table) => [table.id, table]));
  const archive = state.archivedTables ?? [];
  const archivedIds = new Set(archive.map((table) => table.id));
  const layout = validateLayout(legacySave ? getLayoutAreas(state) : areas, tables, (id) => {
    const current = tablesById.get(id);
    assert(current || (!legacySave && typeof id === 'string' && !archivedIds.has(id)
      && (newTableId.test(id) || (allowSampleTableIds && sampleTableIds.has(id)))), '卓IDが無効か、削除済みです。');
    return current;
  });
  const updatedById = layout.tables;
  for (const ticket of state.tickets) {
    if (!occupiedStatuses.has(ticket.status)) continue;
    let capacity = 0;
    for (const id of ticket.tableIds) {
      const table = updatedById.get(id);
      assert(table, `${getTableLabel(state, id)}は使用中か退店待ちのため削除できません。`);
      capacity += table.capacity;
    }
    assert(capacity >= ticket.guests, `伝票 No. ${ticket.number} の利用人数より合計定員が少なくなります。`);
  }

  state.layoutAreas = layout.areas;
  state.archivedTables = [...archive, ...existing.filter((table) => !updatedById.has(table.id))];
  state.tables = [...existing.map((table) => updatedById.get(table.id)).filter(Boolean),
    ...[...updatedById.values()].filter((table) => !tablesById.has(table.id))];
}

function normalizeLayoutFile(file) {
  assert(file?.format === layoutFileFormat, 'NP POSの卓配置ファイルを選択してください。');
  assert(file.version === layoutFileVersion, 'このバージョンの卓配置ファイルには対応していません。');
  const layout = validateLayout(file.areas, file.tables, (id) => {
    assert(typeof id === 'string' && (newTableId.test(id) || sampleTableIds.has(id)),
      '卓配置ファイルに無効な卓IDが含まれています。');
  });
  return { format: layoutFileFormat, version: layoutFileVersion, areas: layout.areas, tables: [...layout.tables.values()] };
}

function allocateTableAlias(reservedIds) {
  assert(typeof globalThis.crypto?.randomUUID === 'function', 'この環境では新しい卓IDを発行できません。');
  let id;
  do { id = `table-${globalThis.crypto.randomUUID()}`; } while (reservedIds.has(id));
  reservedIds.add(id);
  return id;
}

function doImportLayout(state, file) {
  const layout = normalizeLayoutFile(file);
  const activeIds = new Set(state.tables.map((table) => table.id));
  const activeAliases = new Map(state.tables.filter((table) => table.layoutSourceId)
    .map((table) => [table.layoutSourceId, table.id]));
  const archivedIds = new Set((state.archivedTables ?? []).map((table) => table.id));
  const reservedIds = new Set([...activeIds, ...archivedIds, ...layout.tables.map((table) => table.id)]);
  const allocatedAliases = new Map();
  const tables = layout.tables.map((table) => {
    const sourceId = table.id;
    const activeAlias = activeAliases.get(sourceId);
    if (activeIds.has(sourceId)) return table;
    if (activeAlias) return { ...table, id: activeAlias };
    if (!archivedIds.has(sourceId)) return table;
    const id = allocateTableAlias(reservedIds);
    allocatedAliases.set(id, sourceId);
    return { ...table, id };
  });
  doSaveLayout(state, { areas: layout.areas, tables }, true);
  const tablesById = new Map(state.tables.map((table) => [table.id, table]));
  state.tables = tables.map(({ id }) => {
    const table = tablesById.get(id);
    const sourceId = allocatedAliases.get(id);
    return sourceId ? { ...table, layoutSourceId: sourceId } : table;
  });
}

export function apply(state, action, now = Date.now()) {
  const next = structuredClone(state);
  if (action.type === 'saveLayout') {
    doSaveLayout(next, action);
    return next;
  }
  if (action.type === 'importLayout') {
    doImportLayout(next, action.layout);
    return next;
  }
  if (action.type === 'saveStoreSettings') {
    replaceStoreSettings(next, validatedStoreSettings(action.settings, next), action.removeStockIds);
    return next;
  }
  if (action.type === 'importStoreConfiguration') {
    const { layout, settings } = action.configuration ?? {};
    const validated = settings === null ? null : validatedStoreSettings(settings, next);
    doImportLayout(next, layout);
    if (validated) replaceStoreSettings(next, validated);
    return next;
  }
  if (action.type === 'open') {
    doOpen(next, action, now);
    return next;
  }
  if (action.type === 'close') {
    doClose(next, action, now);
    return next;
  }
  if (action.type === 'seat') {
    doSeat(next, action, now);
    return next;
  }
  if (action.type === 'stockAdjust') {
    doStockAdjust(next, action, now);
    return next;
  }

  currentDay(next);
  const ticket = findTicket(next, action.ticketId);
  if (action.type === 'depart') {
    assert(ticket.status === 'paid', '会計を確定してから退店してください。');
    recordTableAssignment(ticket, [], now);
    ticket.status = 'departed';
    ticket.departedAt = now;
    return next;
  }
  requireOrderable(ticket);
  switch (action.type) {
    case 'move': {
      const tableIds = tableSet(next, action.tableIds, ticket.guests, ticket.id);
      recordTableAssignment(ticket, tableIds, now);
      ticket.tableIds = tableIds;
      break;
    }
    case 'order':
      assert(Array.isArray(action.items) && action.items.length > 0, '商品を追加してください。');
      for (const item of action.items) {
        const menu = next.menu.find((entry) => entry.id === item.menuId);
        assert(menu && !['セット', '延長'].includes(menu.category), '初回セットと延長は専用画面で登録してください。');
        assert(menu.enabled !== false, 'このメニューは提供を停止しています。');
        addLine(next, ticket, menu, item.quantity, item.castIds ?? [], now);
      }
      break;
    case 'extend': {
      const menu = next.menu.find((entry) => entry.category === '延長' && entry.enabled !== false && Number.isInteger(entry.duration)
        && (action.menuId === undefined ? entry.duration === Number(action.minutes) : entry.id === action.menuId));
      assert(menu, '延長時間を選択してください。');
      const surcharge = next.menu.find((entry) => entry.id === 'nominationExtra' && entry.enabled !== false);
      const relatedCast = [...new Set(ticket.lines.filter((line) => line.category === '指名' && line.cancelledAt === null)
        .flatMap((line) => line.castIds))];
      addLine(next, ticket, menu, ticket.guests, [], now);
      if (surcharge && relatedCast.length) {
        addLine(next, ticket, surcharge, relatedCast.length, relatedCast, now, { includeHistoricalCast: true });
      }
      ticket.endsAt += menu.duration * minute;
      break;
    }
    case 'deposit': {
      validateMethod(action.method);
      const amount = money(action.amount, '前受金', false);
      assert(quote(next, ticket.id).remaining >= amount, '前受金は現在の未収額以下を入力してください。');
      ticket.deposits.push({ id: createId(next, 'deposit'), method: action.method, amount, at: now });
      break;
    }
    case 'cancelDeposit': {
      const index = ticket.deposits.findIndex((entry) => entry.id === action.depositId);
      assert(index >= 0, '前受金が見つかりません。');
      ticket.deposits.splice(index, 1);
      break;
    }
    case 'discount': {
      const amount = money(action.amount, '値引き額');
      assert(amount <= quote(next, ticket.id).subtotal, '値引きは小計以下を入力してください。');
      ticket.discount = amount;
      assert(quote(next, ticket.id).total >= totalOf(ticket.deposits), '値引き後の請求額が前受金を下回ります。');
      break;
    }
    case 'settle': {
      const due = quote(next, ticket.id).remaining;
      assert(Array.isArray(action.payments) && action.payments.length <= 10, '支払内容を確認してください。');
      for (const payment of action.payments) {
        validateMethod(payment.method);
        money(payment.amount, `${methodLabel[payment.method]}の支払額`, false);
      }
      assert(totalOf(action.payments) === due, '支払額の合計を未収額と一致させてください。');
      ticket.payments = action.payments.map((entry) => ({ id: createId(next, 'payment'), method: entry.method,
        amount: entry.amount, at: now }));
      ticket.settlement = quote(next, ticket.id);
      ticket.status = 'paid';
      ticket.settledAt = now;
      break;
    }
    case 'serve': {
      const line = ticket.lines.find((entry) => entry.id === action.lineId && entry.cancelledAt === null);
      assert(line, '注文明細が見つかりません。');
      line.providedAt = now;
      break;
    }
    case 'cancelLine': {
      const line = ticket.lines.find((entry) => entry.id === action.lineId && entry.cancelledAt === null);
      assert(line, '注文明細が見つかりません。');
      assert(!['セット', '延長'].includes(line.category) && line.menuId !== 'nominationExtra', 'この料金は伝票単位で取り消してください。');
      assert(!action.returnStock || line.providedAt === null, '提供済みの商品は在庫に戻せません。');
      line.cancelledAt = now;
      if (action.returnStock) {
        for (const use of line.stockUses) {
          const stock = next.stock.find((entry) => entry.id === use.stockId);
          newStockMovement(next, stock, use.quantity, 'return', `${line.name}の取消`, now, ticket.id, line.id, use.unitCost);
        }
      }
      const remaining = quote(next, ticket.id);
      assert(remaining.subtotal >= ticket.discount, '取り消す前に値引き額を調整してください。');
      assert(remaining.total >= totalOf(ticket.deposits), '取消後の請求額が前受金を下回ります。');
      break;
    }
    case 'void':
      canCancel(ticket);
      if (action.returnStock) {
        for (const line of ticket.lines.filter((entry) => entry.cancelledAt === null && entry.providedAt === null)) {
          for (const use of line.stockUses) {
            const stock = next.stock.find((entry) => entry.id === use.stockId);
            newStockMovement(next, stock, use.quantity, 'return', `${line.name}の伝票取消`, now, ticket.id, line.id, use.unitCost);
          }
        }
      }
      recordTableAssignment(ticket, [], now);
      ticket.status = 'void';
      break;
    default:
      throw new Error('操作内容が見つかりません。');
  }
  return next;
}

export function summary(state) {
  const payments = { cash: 0, card: 0, qr: 0 };
  const earned = new Map();
  const pending = new Map();
  let sales = 0;
  let guests = 0;
  let tickets = 0;
  let occupied = 0;
  let openTickets = 0;
  let paidTickets = 0;
  for (const ticket of state.tickets) {
    if (ticket.status === 'void') continue;
    if (occupiedStatuses.has(ticket.status)) occupied += ticket.tableIds.length;
    for (const payment of [...ticket.deposits, ...ticket.payments]) payments[payment.method] += payment.amount;
    const totals = quote(state, ticket.id);
    if (ticket.status === 'open') {
      openTickets++;
      totals.commission.forEach((entry) => addCommission(pending, entry.castId, entry.sales, entry.amount,
        Math.round(entry.points * pointsScale)));
      continue;
    }
    if (ticket.status === 'paid') paidTickets++;
    const isSettled = ticket.status === 'paid' || ticket.status === 'departed';
    if (isSettled) {
      tickets++;
      guests += ticket.guests;
      sales += totals.total;
      totals.commission.forEach((entry) => addCommission(earned, entry.castId, entry.sales, entry.amount,
        Math.round(entry.points * pointsScale)));
    }
  }
  return { sales, guests, tickets, occupied, totalTables: state.tables.length, expectedCash: state.day.openingCash + payments.cash,
    commission: outputCommission(earned), pendingCommission: outputCommission(pending), stockMovements: state.movements.length,
    payments, openTickets, paidTickets };
}

const rooms = [
  ['a', 'フロアA', [4, 4, 2, 6, 4, 2]],
  ['b', 'フロアB', [4, 6, 4, 2]],
  ['v', 'VIP', [8, 6]],
];
export const layoutAreas = Object.freeze(rooms.map(([, area]) => area));
const sampleTables = rooms.flatMap(([prefix, area, capacities]) => capacities.map((capacity, index) => ({
  id: `${prefix}${index + 1}`, name: `${prefix.toUpperCase()}-${String(index + 1).padStart(2, '0')}`, area, capacity,
})));
const sampleTableIds = new Set(sampleTables.map((table) => table.id));
const cast = [
  { id: 'cast1', name: '美月', initials: '美', color: 'violet' },
  { id: 'cast2', name: '凛', initials: '凛', color: 'rose' },
  { id: 'cast3', name: '結衣', initials: '結', color: 'sky' },
  { id: 'cast4', name: '葵', initials: '葵', color: 'green' },
  { id: 'cast5', name: '沙羅', initials: '沙', color: 'amber' },
  { id: 'cast6', name: '玲奈', initials: '玲', color: 'violet' },
];
const menu = [
  { id: 'set60', name: 'スタンダード 60分', category: 'セット', price: 5_000, duration: 60 },
  { id: 'set90', name: 'スタンダード 90分', category: 'セット', price: 7_000, duration: 90 },
  { id: 'vip60', name: 'VIP セット 60分', category: 'セット', price: 9_000, duration: 60 },
  { id: 'highball', name: 'ハイボール', category: 'ドリンク', price: 900, popular: true,
    recipe: [{ stockId: 'whisky', quantity: 0.05 }, { stockId: 'soda', quantity: 0.25 }] },
  { id: 'castDrink', name: 'キャストドリンク', category: 'ドリンク', price: 1_500, popular: true, requiresCast: true,
    commission: { fixed: 300, points: 1 }, recipe: [{ stockId: 'soda', quantity: 0.25 }] },
  { id: 'oolong', name: '烏龍茶', category: 'ドリンク', price: 750,
    recipe: [{ stockId: 'tea', quantity: 0.25 }] },
  { id: 'beer', name: '瓶ビール', category: 'ドリンク', price: 1_000,
    recipe: [{ stockId: 'beer', quantity: 1 }] },
  { id: 'champagne', name: 'シャンパン ブリュット', category: 'ボトル', price: 18_000, popular: true,
    commission: { rate: 12, points: 5 }, recipe: [{ stockId: 'champagne', quantity: 1 }] },
  { id: 'whiskyBottle', name: 'プレミアムウイスキー', category: 'ボトル', price: 12_000,
    commission: { rate: 10, points: 3 }, recipe: [{ stockId: 'whisky', quantity: 1 }] },
  { id: 'nuts', name: 'ミックスナッツ', category: 'フード', price: 800, popular: true,
    recipe: [{ stockId: 'nuts', quantity: 1 }] },
  { id: 'fruits', name: 'フルーツ盛り合わせ', category: 'フード', price: 3_500,
    recipe: [{ stockId: 'fruit', quantity: 1 }] },
  { id: 'nomination', name: '本指名', category: '指名', price: 2_000, requiresCast: true, popular: true,
    commission: { fixed: 700, points: 2 } },
  { id: 'inHouse', name: '場内指名', category: '指名', price: 1_500, requiresCast: true,
    commission: { fixed: 500, points: 1 } },
  { id: 'nominationExtra', name: '延長指名料', category: '延長', price: 1_000, requiresCast: true,
    commission: { fixed: 350, points: 1 } },
  { id: 'extend30', name: '延長 30分', category: '延長', price: 2_500, duration: 30 },
  { id: 'extend60', name: '延長 60分', category: '延長', price: 4_500, duration: 60 },
];
const stockSeed = [
  ['whisky', 'プレミアムウイスキー', 'ボトル', '本', 12, 3, 2_200],
  ['champagne', 'シャンパン ブリュット', 'ボトル', '本', 5, 3, 5_200],
  ['soda', 'クラブソーダ', 'ドリンク', '本', 24, 6, 125],
  ['tea', '烏龍茶', 'ドリンク', '本', 10, 3, 180],
  ['beer', '瓶ビール', 'ドリンク', '本', 18, 5, 260],
  ['nuts', 'ミックスナッツ', 'フード', '皿', 4, 5, 200],
  ['fruit', 'フルーツ盛り合わせ', 'フード', '皿', 6, 2, 800],
];

export function createDemo(mode = 'live', now = Date.now()) {
  let state = {
    day: { status: 'closed', date: businessDate(now), openingCash: 0, openedAt: null, closedAt: null, closingCash: null },
    tables: structuredClone(sampleTables),
    tickets: [], menu: structuredClone(menu), cast: structuredClone(cast),
    stock: stockSeed.map(([id, name, category, unit, quantity, minimum, unitCost]) => ({ id, name, category, unit, quantity,
      minimum, unitCost, value: quantity * unitCost, defaultUnitCost: unitCost })),
    movements: [], closedDays: [], nextId: 1, nextTicket: 101,
  };
  if (mode === 'closed') return state;
  const step = (action, time) => { state = apply(state, action, time); };
  const seat = (tableIds, guests, customer, setId, elapsed) => {
    step({ type: 'seat', tableIds, guests, customer, setId }, now - elapsed * minute);
    return state.tickets.at(-1).id;
  };
  const order = (ticketId, items, elapsed) => {
    step({ type: 'order', ticketId, items: items.map(([menuId, quantity, castIds]) => ({ menuId, quantity, castIds })) },
      now - elapsed * minute);
  };
  const settle = (ticketId, method, elapsed) => {
    step({ type: 'settle', ticketId, payments: [{ method, amount: quote(state, ticketId).remaining }] }, now - elapsed * minute);
  };
  step({ type: 'open', openingCash: 20_000, date: businessDate(now) }, now - 146 * minute);
  const past = seat(['b4'], 2, '伊藤様', 'set60', 105);
  order(past, [['castDrink', 2, ['cast2']], ['highball', 1, []]], 98);
  settle(past, 'card', 44);
  step({ type: 'depart', ticketId: past }, now - 42 * minute);
  const active = seat(['a1'], 2, '佐藤様', 'set60', 32);
  order(active, [['castDrink', 2, ['cast1']]], 25);
  step({ type: 'discount', ticketId: active, amount: 1_300 }, now - 21 * minute);
  step({ type: 'deposit', ticketId: active, method: 'cash', amount: 3_000 }, now - 20 * minute);
  const almost = seat(['a2'], 3, '鈴木様', 'set60', 54);
  order(almost, [['nomination', 1, ['cast3']], ['oolong', 1, []]], 22);
  const overtime = seat(['b1'], 2, '田中様', 'set60', 63);
  order(overtime, [['highball', 2, []], ['nuts', 1, []]], 47);
  const paid = seat(['b2'], 1, '渡辺様', 'set60', 57);
  order(paid, [['castDrink', 1, ['cast4']]], 49);
  settle(paid, 'cash', 3);
  const vip = seat(['v1', 'v2'], 6, '高橋様', 'vip60', 18);
  order(vip, [['champagne', 1, ['cast1', 'cast2']], ['fruits', 1, []]], 14);
  state.movements.sort((first, second) => second.at - first.at);
  return state;
}
