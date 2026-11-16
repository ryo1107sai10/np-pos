const orderCategories = new Set(['ドリンク', 'ボトル', 'フード', '指名']);
const menuCategories = new Set(['セット', '延長', ...orderCategories]);
export function getOrderCategories(state) {
  return [...orderCategories,...(state.customMenuCategories ?? [])];
}
const castColors = new Set(['violet', 'rose', 'sky', 'green', 'amber']);
const generatedId = /^(menu|cast|stock)-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const stockIdPattern = /^[a-zA-Z0-9_-]+$/;
const menuFields = ['id', 'name', 'category', 'price', 'duration', 'enabled', 'popular', 'requiresCast',
  'taxRate', 'serviceEligible', 'printName', 'hideReceiptLine'];
const castFields = ['id', 'name', 'initials', 'color', 'enabled'];
const stockFields = ['id', 'name', 'category', 'unit', 'minimum', 'hidden', 'maximum', 'itemCode', 'barcode'];
const commissionFields = ['fixed', 'rate', 'points'];
const inUseTicketStatuses = new Set(['open', 'paid']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pick(record, fields) {
  const output = {};
  for (const field of fields) {
    if (Object.hasOwn(record, field) && record[field] !== undefined) output[field] = record[field];
  }
  return output;
}

function projectMenu(item) {
  const output = pick(item, menuFields);
  if (item.commission !== undefined) output.commission = pick(item.commission, commissionFields);
  if (item.recipe !== undefined) output.recipe = item.recipe.map((entry) => pick(entry, ['stockId', 'quantity']));
  return output;
}

function projectCast(person) {
  const output = pick(person, castFields);
  if (person.commissionOverride !== undefined) output.commissionOverride = pick(person.commissionOverride, commissionFields);
  return output;
}

export function getStoreSettings(state) {
  return {
    menu: state.menu.map(projectMenu),
    cast: state.cast.map(projectCast),
    ...(state.customMenuCategories !== undefined && {customMenuCategories:[...state.customMenuCategories]}),
    stock: state.stock.map((item) => ({
      ...pick(item, stockFields),
      defaultUnitCost: item.defaultUnitCost ?? item.unitCost,
    })),
  };
}

function validateId(id, kind, builtIn, label) {
  assert(typeof id === 'string' && (builtIn.has(id) || generatedId.exec(id)?.[1] === kind),
    `${label}に無効なIDが含まれています。`);
}

function normalizeName(value, length, label) {
  const name = typeof value === 'string' ? value.trim() : '';
  assert(name && name.length <= length && !/[\x00-\x1F\x7F]/.test(name), `${label}は${length}文字以内で入力してください。`);
  return name;
}

function isAmount(value, lower, upper, scale = 1) {
  return Number.isFinite(value) && value >= lower && value <= upper
    && value === Math.round(value * scale) / scale;
}

function validateCommission(commission, label) {
  if (commission === undefined) return;
  assert(isRecord(commission), `${label}の歩合設定を確認してください。`);
  assert(commission.fixed === undefined || isAmount(commission.fixed, 0, 100_000_000),
    `${label}の固定歩合は0円以上の整数で入力してください。`);
  assert(commission.rate === undefined || isAmount(commission.rate, 0, 100, 100),
    `${label}の歩合率は0〜100%の範囲で小数第2位まで入力してください。`);
  assert(commission.points === undefined || isAmount(commission.points, 0, 10_000, 1_000),
    `${label}のポイントは0〜10,000の範囲で小数第3位まで入力してください。`);
}

function validateBoolean(value, label) {
  assert(value === undefined || typeof value === 'boolean', `${label}の設定を確認してください。`);
}

function validateRecipe(recipe, allowed, stockIds, label) {
  if (recipe === undefined) return;
  assert(Array.isArray(recipe) && (allowed || recipe.length === 0), `${label}の在庫連動を確認してください。`);
  const seen = new Set();
  for (const entry of recipe) {
    assert(isRecord(entry) && typeof entry.stockId === 'string' && stockIdPattern.test(entry.stockId)
      && (!stockIds || stockIds.has(entry.stockId)), `${label}に存在しない在庫品目が設定されています。`);
    assert(!seen.has(entry.stockId), `${label}で同じ在庫品目が重複しています。`);
    seen.add(entry.stockId);
    assert(isAmount(entry.quantity, 0.000001, 1_000_000, 1_000_000),
      `${label}の在庫使用量は0より大きい値を小数第6位まで入力してください。`);
  }
}

function normalizeMenu(item, { menuIds, stockIds, customMenuCategories }) {
  assert(isRecord(item), 'メニュー項目の形式を確認してください。');
  validateId(item.id, 'menu', menuIds, 'メニュー');
  const name = normalizeName(item.name, 60, 'メニュー名');
  const label = `「${name}」`;
  assert(menuCategories.has(item.category) || customMenuCategories.includes(item.category), `${label}のカテゴリを選択してください。`);
  assert(isAmount(item.price, 0, 100_000_000), `${label}の料金は0円以上の整数で入力してください。`);
  for (const key of ['enabled', 'popular', 'requiresCast', 'serviceEligible','hideReceiptLine']) validateBoolean(item[key], label);
  assert(item.hideReceiptLine !== true || (item.price === 0 && !['セット','延長'].includes(item.category)),
    '印字対象から外せるのは0円の注文商品です。');
  assert(item.taxRate === undefined || isAmount(item.taxRate, 0, 10_000), `${label}の税率を確認してください。`);
  const supplement = item.id === 'nominationExtra';
  assert(!supplement || item.category === '延長', '延長指名料のカテゴリを確認してください。');
  const timed = item.category === 'セット' || (item.category === '延長' && !supplement);
  assert(timed ? isAmount(item.duration, 1, 1_440) : item.duration === undefined, `${label}の時間を確認してください。`);
  assert(!timed || !item.requiresCast, `${label}では担当キャストの選択を必須にできません。`);
  validateCommission(item.commission, label);
  validateRecipe(item.recipe, !['セット','延長'].includes(item.category), stockIds, label);
  const output = { ...projectMenu(item), name };
  if (item.printName !== undefined) output.printName = normalizeName(item.printName,60,'帳票に印字する商品名');
  return output;
}

function normalizeCast(person, { castIds }) {
  assert(isRecord(person), 'キャスト項目の形式を確認してください。');
  validateId(person.id, 'cast', castIds, 'キャスト');
  const name = normalizeName(person.name, 24, 'キャスト名');
  const label = `「${name}」`;
  validateBoolean(person.enabled, label);
  assert(person.color === undefined || castColors.has(person.color), `${label}の表示色を確認してください。`);
  validateCommission(person.commissionOverride, label);
  return { ...projectCast(person), name, initials: [...name][0], color: person.color ?? 'violet' };
}

function normalizeStock(item, stockMasterIds) {
  assert(isRecord(item), '在庫品目の形式を確認してください。');
  validateId(item.id, 'stock', stockMasterIds, '在庫品目');
  const name = normalizeName(item.name, 60, '品目名');
  const category = normalizeName(item.category === undefined ? 'その他' : item.category, 24, `「${name}」の分類名`);
  const unit = normalizeName(item.unit, 16, `「${name}」の単位`);
  assert(isAmount(item.minimum, 0, 1_000_000, 1_000_000),
    `「${name}」の下限は0以上の数値を小数第6位まで入力してください。`);
  assert(isAmount(item.defaultUnitCost, 0, 100_000_000, 1_000_000),
    `「${name}」の仕入原価は0円以上の数値を小数第6位まで入力してください。`);
  validateBoolean(item.hidden, `「${name}」の表示`);
  const definition = { id: item.id, name, category, unit, minimum: item.minimum, defaultUnitCost: item.defaultUnitCost };
  if (item.maximum !== undefined) {
    assert(item.maximum === null || isAmount(item.maximum,item.minimum,1_000_000,1_000_000),
      `「${name}」の上限は下限以上の数値を入力してください。`);
    definition.maximum = item.maximum;
  }
  for (const [field,label] of [['itemCode','品目コード'],['barcode','バーコード']]) {
    if (item[field] === undefined) continue;
    const value = typeof item[field] === 'string' ? item[field].trim().normalize('NFKC') : null;
    assert(value !== null && value.length <= 64 && !/[\p{C}\r\n]/u.test(value),`「${name}」の${label}を確認してください。`);
    definition[field] = value;
  }
  if (item.hidden !== undefined) definition.hidden = item.hidden;
  return definition;
}

export function normalizeStoreSettings(settings, { menuIds, castIds, stockMasterIds, localStockIds, requireStock }) {
  assert(isRecord(settings) && Array.isArray(settings.menu) && Array.isArray(settings.cast),
    'メニューとキャストの設定形式を確認してください。');
  assert(Array.isArray(settings.stock) || (!requireStock && settings.stock === undefined),
    '在庫品目の設定形式を確認してください。');
  const stock = settings.stock?.map((item) => normalizeStock(item, stockMasterIds));
  const importedIds = stock?.map(({ id }) => id) ?? [];
  assert(new Set(importedIds).size === importedIds.length, '同じ在庫品目IDが重複しています。');
  for (const [field,label] of [['itemCode','品目コード'],['barcode','バーコード']]) {
    const codes = (stock ?? []).map((item) => item[field]?.toLowerCase()).filter(Boolean);
    assert(new Set(codes).size === codes.length,`${label}が重複しています。`);
  }
  const stockIds = stock || localStockIds ? new Set([...(localStockIds ?? []), ...importedIds]) : null;
  const categories = settings.customMenuCategories === undefined ? [] : settings.customMenuCategories;
  assert(Array.isArray(categories) && categories.length <= 24, '独自カテゴリは24件以内で設定してください。');
  const customMenuCategories = categories.map((name) => normalizeName(name,24,'カテゴリ名'));
  assert(new Set(customMenuCategories).size === customMenuCategories.length
    && customMenuCategories.every((name) => !menuCategories.has(name) && name !== 'よく使う'), 'カテゴリ名が重複しています。');
  const menu = settings.menu.map((item) => normalizeMenu(item, { menuIds, stockIds, customMenuCategories }));
  const cast = settings.cast.map((person) => normalizeCast(person, { castIds }));
  assert(new Set(menu.map(({ id }) => id)).size === menu.length, '同じメニューIDが重複しています。');
  assert(new Set(cast.map(({ id }) => id)).size === cast.length, '同じキャストIDが重複しています。');
  assert(menu.some((item) => item.category === 'セット' && item.enabled !== false),
    '利用できる初回セットを1件以上設定してください。');
  return {menu,cast,...(stock && {stock}),...(settings.customMenuCategories !== undefined && {customMenuCategories})};
}

export function stockDeletionBlocker(state, stockId, menu = state.menu) {
  const item = state.stock.find(({ id }) => id === stockId);
  if (!item) return '削除する在庫品目が見つかりません。';
  const label = `「${item.name}」`;
  if (item.quantity !== 0) return `${label}は在庫が残っているため削除できません。`;
  if (menu.some((product) => product.recipe?.some((use) => use.stockId === stockId))) {
    return `${label}はメニューにひもづいているため削除できません。`;
  }
  const hasPendingReturn = state.tickets.some((ticket) => ticket.status === 'open' && ticket.lines.some((line) =>
    line.cancelledAt === null && line.providedAt === null && line.stockUses?.some((use) => use.stockId === stockId)));
  if (hasPendingReturn) return `${label}は未提供の注文に使われているため削除できません。`;
  return '';
}

export function catalogDeletionBlocker(state, kind, id, menu = state.menu) {
  if (kind !== 'menu' && kind !== 'cast') return '削除する設定項目を確認してください。';
  const item = state[kind].find((entry) => entry.id === id);
  if (!item) return '削除する設定項目が見つかりません。';
  const inUse = (state.tickets ?? []).some((ticket) => inUseTicketStatuses.has(ticket.status)
    && (ticket.lines ?? []).some((line) => line.cancelledAt == null
      && (kind === 'menu' ? line.menuId === id : line.castIds?.includes(id))));
  if (inUse) return `「${item.name}」は利用中または退店待ちの伝票にひもづいているため削除できません。`;
  if (kind === 'menu' && item.category === 'セット'
    && !menu.some((entry) => entry.id !== id && entry.category === 'セット' && entry.enabled !== false)) {
    return '利用できる初回セットを1件以上残してください。';
  }
  return '';
}

function verifyCatalogRemovals(state, menu, cast, removeMenuIds, removeCastIds) {
  for (const [kind, next, requested] of [['menu', menu, removeMenuIds], ['cast', cast, removeCastIds]]) {
    const currentIds = new Set(state[kind].map(({ id }) => id));
    const retainedIds = new Set(next.map(({ id }) => id));
    assert(Array.isArray(requested) && requested.every((id) => currentIds.has(id) && !retainedIds.has(id))
      && new Set(requested).size === requested.length, '削除する設定項目の指定を確認してください。');
    for (const id of currentIds) {
      if (retainedIds.has(id)) continue;
      const blocker = catalogDeletionBlocker(state, kind, id, menu);
      assert(!blocker, blocker);
    }
  }
}

export function replaceStoreSettings(state, { menu, cast, stock, customMenuCategories }, removeStockIds = [], {
  removeMenuIds = [], removeCastIds = [],
} = {}) {
  assert(Array.isArray(removeStockIds) && removeStockIds.every((id) => typeof id === 'string')
    && new Set(removeStockIds).size === removeStockIds.length, '削除する在庫品目の指定を確認してください。');
  for (const id of removeStockIds) {
    const blocker = stockDeletionBlocker(state, id, menu);
    assert(!blocker, blocker);
    assert(!stock?.some((item) => item.id === id), '同じ在庫品目の更新と削除を同時に指定できません。');
  }
  verifyCatalogRemovals(state, menu, cast, removeMenuIds, removeCastIds);
  const archive = new Map((state.archivedCast ?? []).map((person) => [person.id, person]));
  for (const person of state.cast) archive.set(person.id, projectCast(person));
  for (const person of cast) archive.delete(person.id);
  if (archive.size || state.archivedCast) state.archivedCast = [...archive.values()];
  state.menu = menu;
  if (customMenuCategories !== undefined) state.customMenuCategories = customMenuCategories;
  else delete state.customMenuCategories;
  state.cast = cast;
  if (!stock && !removeStockIds.length) return;
  const existingStock = new Map(state.stock.map((item) => [item.id, item]));
  const archivedStock = new Map((state.archivedStock ?? []).map((item) => [item.id, item]));
  for (const item of stock ?? []) {
    const existing = existingStock.get(item.id);
    const updated = existing ? { ...existing, ...item } : {
      ...item, quantity: 0, unitCost: item.defaultUnitCost, value: 0,
    };
    if (item.hidden === undefined) delete updated.hidden;
    existingStock.set(item.id, updated);
    archivedStock.delete(item.id);
  }
  for (const id of removeStockIds) {
    const { name, unit } = existingStock.get(id);
    archivedStock.set(id, { id, name, unit });
    existingStock.delete(id);
  }
  state.stock = [...existingStock.values()];
  if (archivedStock.size || state.archivedStock) state.archivedStock = [...archivedStock.values()];
}
