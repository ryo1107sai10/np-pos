const orderCategories = new Set(['ドリンク', 'ボトル', 'フード', '指名']);
const menuCategories = new Set(['セット', '延長', ...orderCategories]);
const castColors = new Set(['violet', 'rose', 'sky', 'green', 'amber']);
const generatedId = /^(menu|cast|stock)-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const stockIdPattern = /^[a-zA-Z0-9_-]+$/;
const menuFields = ['id', 'name', 'category', 'price', 'duration', 'enabled', 'popular', 'requiresCast',
  'taxRate', 'serviceEligible'];
const castFields = ['id', 'name', 'initials', 'color', 'enabled'];
const stockFields = ['id', 'name', 'category', 'unit', 'minimum'];
const commissionFields = ['fixed', 'rate', 'points'];

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

function normalizeMenu(item, { menuIds, stockIds }) {
  assert(isRecord(item), 'メニュー項目の形式を確認してください。');
  validateId(item.id, 'menu', menuIds, 'メニュー');
  const name = normalizeName(item.name, 60, 'メニュー名');
  const label = `「${name}」`;
  assert(menuCategories.has(item.category), `${label}のカテゴリを選択してください。`);
  assert(isAmount(item.price, 0, 100_000_000), `${label}の料金は0円以上の整数で入力してください。`);
  for (const key of ['enabled', 'popular', 'requiresCast', 'serviceEligible']) validateBoolean(item[key], label);
  assert(item.taxRate === undefined || isAmount(item.taxRate, 0, 10_000), `${label}の税率を確認してください。`);
  const supplement = item.id === 'nominationExtra';
  assert(!supplement || item.category === '延長', '延長指名料のカテゴリを確認してください。');
  const timed = item.category === 'セット' || (item.category === '延長' && !supplement);
  assert(timed ? isAmount(item.duration, 1, 1_440) : item.duration === undefined, `${label}の時間を確認してください。`);
  assert(!timed || !item.requiresCast, `${label}では担当キャストの選択を必須にできません。`);
  validateCommission(item.commission, label);
  validateRecipe(item.recipe, orderCategories.has(item.category), stockIds, label);
  return { ...projectMenu(item), name };
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
  return { id: item.id, name, category, unit, minimum: item.minimum, defaultUnitCost: item.defaultUnitCost };
}

export function normalizeStoreSettings(settings, { menuIds, castIds, stockMasterIds, localStockIds, requireStock }) {
  assert(isRecord(settings) && Array.isArray(settings.menu) && Array.isArray(settings.cast),
    'メニューとキャストの設定形式を確認してください。');
  assert(Array.isArray(settings.stock) || (!requireStock && settings.stock === undefined),
    '在庫品目の設定形式を確認してください。');
  const stock = settings.stock?.map((item) => normalizeStock(item, stockMasterIds));
  const importedIds = stock?.map(({ id }) => id) ?? [];
  assert(new Set(importedIds).size === importedIds.length, '同じ在庫品目IDが重複しています。');
  const stockIds = stock || localStockIds ? new Set([...(localStockIds ?? []), ...importedIds]) : null;
  const menu = settings.menu.map((item) => normalizeMenu(item, { menuIds, stockIds }));
  const cast = settings.cast.map((person) => normalizeCast(person, { castIds }));
  assert(new Set(menu.map(({ id }) => id)).size === menu.length, '同じメニューIDが重複しています。');
  assert(new Set(cast.map(({ id }) => id)).size === cast.length, '同じキャストIDが重複しています。');
  assert(menu.some((item) => item.category === 'セット' && item.enabled !== false),
    '利用できる初回セットを1件以上設定してください。');
  return stock ? { menu, cast, stock } : { menu, cast };
}

export function replaceStoreSettings(state, { menu, cast, stock }) {
  const archive = new Map((state.archivedCast ?? []).map((person) => [person.id, person]));
  for (const person of state.cast) archive.set(person.id, projectCast(person));
  for (const person of cast) archive.delete(person.id);
  if (archive.size || state.archivedCast) state.archivedCast = [...archive.values()];
  state.menu = menu;
  state.cast = cast;
  if (!stock) return;
  const existingStock = new Map(state.stock.map((item) => [item.id, item]));
  for (const item of stock) {
    const existing = existingStock.get(item.id);
    existingStock.set(item.id, existing ? { ...existing, ...item } : {
      ...item, quantity: 0, unitCost: item.defaultUnitCost, value: 0,
    });
  }
  state.stock = [...existingStock.values()];
}
