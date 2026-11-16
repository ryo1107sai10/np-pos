import { defaultItemTaxRateBps } from './calculation-settings.mjs';

const tabs = [
  { id: 'menu', label: 'メニュー', glyph: 'store' },
  { id: 'plans', label: 'セット・延長', glyph: 'clock' },
  { id: 'cast', label: 'キャスト歩合', glyph: 'users' },
  { id: 'stock', label: '在庫品目', glyph: 'box' },
];
const orderCategories = ['ドリンク', 'ボトル', 'フード', '指名'];
const surchargeId = 'nominationExtra';
const priceMax = 100_000_000;
const nameLimits = { menu: 60, cast: 24, stock: 60 };
const stockUnitLimit = 16;
const stockMinimumMax = 1_000_000;
const stockPrecision = 0.000001;
const stockNumber = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 6 });
const commissionFields = [
  { name: 'fixed', label: '固定額（円 / 点）', max: priceMax, step: 1 },
  { name: 'rate', label: '売上歩合（%）', max: 100, step: 0.01 },
  { name: 'points', label: 'ポイント（Pt / 点）', max: 10_000, step: 0.001 },
];
const removalActions = {
  stock: {
    open: 'store-editor-delete-stock', cancel: 'store-editor-cancel-stock-delete', confirm: 'store-editor-confirm-stock-delete',
  },
  catalog: {
    open: 'store-editor-delete-catalog', cancel: 'store-editor-cancel-catalog-delete', confirm: 'store-editor-confirm-catalog-delete',
  },
};
const removalKeys = { stock: 'removeStockIds', menu: 'removeMenuIds', cast: 'removeCastIds' };

function settingsKey(tab) {
  return tab === 'plans' ? 'menu' : tab;
}

function visibleItems(editor) {
  const { menu, cast, stock } = editor.settings;
  if (editor.tab === 'cast') return cast;
  if (editor.tab === 'stock') return stock;
  return menu.filter((entry) => editor.tab === 'plans'
    ? ['セット', '延長'].includes(entry.category)
    : orderCategories.includes(entry.category));
}

function selectedItem(editor, items = visibleItems(editor)) {
  return items.find((entry) => entry.id === editor.selected[editor.tab]) ?? items[0];
}

function rowSummary(item, { escape, yen }) {
  if (item.unit) {
    const cost = Number.isFinite(item.defaultUnitCost) ? `仕入原価 ¥${stockNumber.format(item.defaultUnitCost)}` : '原価未設定';
    return `${escape(item.unit)} · 下限 ${stockNumber.format(item.minimum)} · ${cost}`;
  }
  if (item.category) {
    return `${escape(item.category)}${Number.isFinite(item.duration) ? ` · ${item.duration}分` : ''} · ${Number.isFinite(item.price) ? yen(item.price) : '料金未設定'}`;
  }
  return Object.keys(item.commissionOverride ?? {}).length ? '個別歩合' : '商品設定に準拠';
}

function itemRow(item, selected, api) {
  const { escape, icon } = api;
  const status = item.hidden === true || item.enabled === false ? '非表示' : '';
  return `<li><button class="store-editor-row" type="button" data-action="store-editor-select" data-id="${escape(item.id)}" aria-pressed="${item === selected}">
    <span><strong>${escape(item.name)}</strong><small>${rowSummary(item, api)}</small></span>
    ${status ? `<span class="store-editor-off">${status}</span>` : ''}${icon('chevron-right', 14)}</button></li>`;
}

function addButton(kind, label, icon) {
  return `<button class="btn btn-secondary" type="button" data-action="store-editor-add" data-id="${kind}">${icon('plus', 14)}${label}</button>`;
}

function itemList(editor, items, selected, api) {
  const heading = { menu: '商品', plans: '料金プラン', cast: 'キャスト', stock: '在庫品目' }[editor.tab];
  let additions;
  switch (editor.tab) {
    case 'plans':
      additions = addButton('set', 'セットを追加', api.icon) + addButton('extension', '延長を追加', api.icon)
        + (items.some(({ id }) => id === surchargeId) || editor.removeMenuIds?.has(surchargeId)
          ? '' : addButton('surcharge', '延長指名料を追加', api.icon));
      break;
    case 'cast':
      additions = addButton('cast', 'キャストを追加', api.icon);
      break;
    case 'stock':
      additions = addButton('stock', '品目を追加', api.icon);
      break;
    default:
      additions = addButton('menu', '商品を追加', api.icon);
  }
  const list = editor.tab === 'plans'
    ? ['セット', '延長'].map((category) => {
      const group = items.filter((item) => item.category === category);
      if (!group.length) return '';
      return `<div class="store-editor-list-group"><h4>${category}</h4><ul>${group.map((item) => itemRow(item, selected, api)).join('')}</ul></div>`;
    }).join('')
    : `<ul>${items.map((item) => itemRow(item, selected, api)).join('')}</ul>`;
  return `<section class="store-editor-catalog" aria-labelledby="store-catalog-heading">
    <div class="store-editor-catalog-head"><h3 id="store-catalog-heading">${heading}<small>${items.length}件</small></h3>
    <div class="store-editor-add">${additions}</div></div>
    ${items.length ? `<div class="store-editor-list">${list}</div>` : `<p class="store-editor-empty">${heading}が登録されていません。</p>`}
  </section>`;
}

function textInput(label, value, limit, escape, name = 'name') {
  return `<label class="field"><span>${label}</span><input name="store-${name}" type="text" value="${escape(value)}" required maxlength="${limit}" autocomplete="off"></label>`;
}

function numberInput(label, name, value, { min = 0, max, step = 1, required = false, placeholder } = {}) {
  return `<label class="field"><span>${label}</span><input name="store-${name}" type="number" value="${Number.isFinite(value) ? value : ''}" min="${min}" max="${max}" step="${step}" inputmode="${step === 1 ? 'numeric' : 'decimal'}"${required ? ' required' : ''}${placeholder ? ` placeholder="${placeholder}"` : ''}></label>`;
}

function commissionInputs(values = {}, override = false) {
  return `<div class="store-editor-commission-grid">${commissionFields.map(({ name, label, max, step }) =>
    numberInput(label, name, values[name], { max, step, placeholder: override ? '商品設定' : '0' })).join('')}</div>`;
}

function toggle(label, name, checked) {
  return `<label class="store-editor-toggle"><input type="checkbox" name="store-${name}"${checked ? ' checked' : ''}><span>${label}</span></label>`;
}

function stockInputs(item, stock, { escape, icon }) {
  const recipe = new Map(item.recipe?.map(({ stockId, quantity }) => [stockId, quantity]));
  const choices = stock.filter((entry) => entry.hidden !== true || recipe.has(entry.id));
  if (!choices.length) return '';
  return `<details class="store-editor-advanced"><summary>${icon('box', 16)}<span>在庫連動</span>
    <small>${recipe.size}品目</small>${icon('chevron-down', 14)}</summary>
    <div class="store-editor-advanced-body"><p class="field-help">1点注文するごとに引き落とす数量を入力します。</p>
    <div class="store-editor-stock-grid">${choices.map((entry) => `<label class="field"><span>${escape(entry.name)}（${escape(entry.unit)}）${entry.hidden === true ? '［非表示］' : ''}</span>
      <input type="number" name="store-stock-quantity" data-stock-id="${escape(entry.id)}" value="${escape(recipe.get(entry.id) ?? '')}" min="0" max="1000000" step="0.000001" inputmode="decimal" placeholder="0"></label>`).join('')}</div></div>
  </details>`;
}

function castInspector(person, api) {
  return `<h3 id="store-inspector-heading">キャストの設定</h3>
    ${textInput('表示名', person.name, nameLimits.cast, api.escape)}
    <fieldset class="store-editor-group" aria-describedby="store-cast-rule">
      <legend>個別の歩合</legend><p id="store-cast-rule" class="field-help">空欄は商品ごとの設定を使います。0を入力するとその項目の歩合は0になります。</p>
      ${commissionInputs(person.commissionOverride, true)}
    </fieldset>
    ${toggle('注文の歩合対象に表示する', 'enabled', person.enabled !== false)}`;
}

function removalReason(item, editor, { stockDeletionBlocker, catalogDeletionBlocker }) {
  const kind = settingsKey(editor.tab);
  if (kind === 'stock') return stockDeletionBlocker?.(item.id, editor.settings.menu);
  return catalogDeletionBlocker?.(kind, item.id, editor.settings.menu);
}

function removalPanel(item, editor, api) {
  if (editor.additions?.has(item.id)) return '';
  const { escape, icon } = api;
  const section = editor.tab === 'stock' ? 'stock' : 'catalog';
  const { open, cancel, confirm } = removalActions[section];
  const label = { stock: '品目', menu: '商品', cast: 'キャスト', plans: item.id === surchargeId ? '料金' : 'プラン' }[editor.tab];
  const history = section === 'stock' ? '入出庫履歴は残ります。' : '登録済みの会計と歩合の履歴は残ります。';
  const reasonId = `store-${section}-delete-reason`;
  const confirmId = `store-${section}-delete-confirmation`;
  const id = escape(item.id);
  const reason = removalReason(item, editor, api);
  if (editor.pendingRemoval === item.id && !reason) {
    return `<div class="store-editor-removal is-confirming" role="group" aria-labelledby="${confirmId}">
      <p id="${confirmId}"><strong>「${escape(item.name)}」を削除しますか？</strong><span>店舗設定を保存すると反映されます。${history}</span></p>
      <div class="store-editor-removal-actions">
        <button type="button" class="btn btn-quiet" data-action="${cancel}" data-id="${id}">削除をやめる</button>
        <button type="button" class="btn btn-danger" data-action="${confirm}" data-id="${id}">削除を確定</button>
      </div>
    </div>`;
  }
  return `<div class="store-editor-removal">
    <button type="button" class="btn btn-danger" data-action="${open}" data-id="${id}"${reason ? ` disabled aria-describedby="${reasonId}"` : ''}>${icon('x', 15)}${label}を削除</button>
    ${reason ? `<p class="field-help" id="${reasonId}">${escape(reason)}</p>` : ''}
  </div>`;
}

function stockInspector(item, api) {
  const { escape } = api;
  return `<h3 id="store-inspector-heading">在庫品目の設定</h3>
    ${textInput('品目名', item.name, nameLimits.stock, escape)}
    <div class="store-editor-basic-grid">
      ${textInput('単位', item.unit, stockUnitLimit, escape, 'unit')}
      ${numberInput('在庫の下限', 'minimum', item.minimum, { max: stockMinimumMax, step: stockPrecision, required: true })}
      ${numberInput('仕入原価（円 / 単位）', 'unit-cost', item.defaultUnitCost, { max: priceMax, step: stockPrecision, required: true })}
    </div>
    <p class="field-help">補充時は、設定した1単位あたりの原価を使います。単位の変更後も在庫数量やメニューの使用量は同じ数値を引き継ぎます。</p>
    <div class="store-editor-toggles">${toggle('在庫一覧に表示する', 'stock-visible', item.hidden !== true)}</div>`;
}

function menuCalculationInputs(item, icon) {
  const taxRate = (item.taxRate ?? defaultItemTaxRateBps) / 100;
  const serviceEligible = item.serviceEligible !== false;
  return `<details class="store-editor-advanced"><summary>${icon('cash', 16)}<span>税率・サービス料</span>
    <small>${taxRate}% · ${serviceEligible ? 'サービス料対象' : '対象外'}</small>${icon('chevron-down', 14)}</summary>
    <div class="store-editor-advanced-body">
      ${numberInput('消費税率（%）', 'tax-rate', taxRate, { max: 100, step: 0.01, required: true })}
      <div class="store-editor-toggles">${toggle('サービス料の対象にする', 'service-eligible', serviceEligible)}</div>
    </div>
  </details>`;
}

function menuInspector(item, editor, api) {
  const ordinary = editor.tab === 'menu';
  const surcharge = item.id === surchargeId;
  const heading = ordinary ? '商品の設定' : surcharge ? '延長時の指名料' : `${item.category}の設定`;
  const category = ordinary ? `<label class="field"><span>カテゴリ</span><select name="store-category">${orderCategories.map((name) =>
    `<option${name === item.category ? ' selected' : ''}>${name}</option>`).join('')}</select></label>` : '';
  const taxMode = { exclusive: '・税抜', inclusive: '・税込' }[api.priceMode] ?? '';
  const priceLabel = ordinary ? `価格（円${taxMode}）` : `料金（円 / ${surcharge ? '指名' : '人'}${taxMode}）`;
  const visibility = ordinary ? '注文メニューに表示する' : surcharge ? '延長時に指名料を追加する' : '料金の選択肢に表示する';
  return `<h3 id="store-inspector-heading">${heading}</h3>
    ${textInput(ordinary ? '商品名' : '表示名', item.name, nameLimits.menu, api.escape)}
    <div class="store-editor-basic-grid">${category}${numberInput(priceLabel, 'price', item.price, { max: priceMax, required: true })}
    ${ordinary || surcharge ? '' : numberInput('時間（分）', 'duration', item.duration, { min: 1, max: 1440, required: true })}</div>
    <div class="store-editor-toggles">${toggle(visibility, 'enabled', item.enabled !== false)}
    ${ordinary ? toggle('「よく使う」に表示する', 'popular', item.popular) : ''}</div>
    ${item.category === 'セット' ? '<p class="field-help">来店登録に使う初回セットを1件以上残してください。</p>' : ''}
    ${menuCalculationInputs(item, api.icon)}
    ${ordinary || surcharge ? `<details class="store-editor-advanced"><summary>${api.icon('users', 16)}<span>商品の標準歩合</span>${api.icon('chevron-down', 14)}</summary>
    <div class="store-editor-advanced-body">${commissionInputs(item.commission)}
    ${ordinary ? toggle('注文時にキャストの選択を必須にする', 'required-cast', item.requiresCast) : ''}</div></details>` : ''}
    ${ordinary ? stockInputs(item, editor.settings.stock, api) : ''}`;
}

function itemInspector(selected, editor, api) {
  if (editor.tab === 'stock') return stockInspector(selected, api);
  if (editor.tab === 'cast') return castInspector(selected, api);
  return menuInspector(selected, editor, api);
}

export function renderStoreSettingsEditor(editor, api) {
  const items = visibleItems(editor);
  const selected = selectedItem(editor, items);
  const inspector = selected && itemInspector(selected, editor, api);
  const pendingCount = Object.values(removalKeys).reduce((sum, key) => sum + (editor[key]?.size ?? 0), 0);
  const note = editor.tab === 'stock' ? '品目を追加したら、メニューの「在庫連動」で1点あたりの使用量を指定できます。'
    : '料金と歩合は、保存後の新しい注文明細に適用されます。';
  const discard = selected && editor.additions?.has(selected.id) ? `<button type="button" class="btn btn-quiet store-editor-discard"
    data-action="store-editor-discard-new" data-id="${escape(selected.id)}">${api.icon('x', 15)}追加を取り消す</button>` : '';
  const linked = discard && editor.tab === 'stock'
    && editor.settings.menu.some((item) => item.recipe?.some(({ stockId }) => stockId === selected.id));
  return `<div class="store-editor">
    <div class="store-editor-tabs" role="group" aria-label="設定の種類">${tabs.map(({ id, label, glyph }) =>
      `<button type="button" data-action="store-editor-tab" data-id="${id}" aria-pressed="${id === editor.tab}">${api.icon(glyph, 15)}<span>${label}</span></button>`).join('')}</div>
    <p class="form-copy store-editor-note">${note}</p>
    ${pendingCount ? `<p class="field-help store-editor-removal-note" role="status">削除予定 ${pendingCount}件。店舗設定を保存すると反映されます。</p>` : ''}
    <div class="store-editor-main">
      ${itemList(editor, items, selected, api)}
      ${inspector ? `<section class="store-editor-inspector" aria-labelledby="store-inspector-heading">${inspector}${removalPanel(selected, editor, api)}${discard}
        ${linked ? '<p class="field-help">追加を取り消すと、この品目とのメニュー連動も取り消します。</p>' : ''}</section>` : ''}
    </div>
  </div>`;
}

function parseCommission(dialog) {
  const policy = {};
  for (const { name } of commissionFields) {
    const field = dialog.querySelector(`[name="store-${name}"]`);
    if (field && field.value !== '') policy[name] = field.valueAsNumber;
  }
  return policy;
}

function commitMenuFields(dialog, entry, read) {
  entry.price = read('price').valueAsNumber;
  const category = read('category');
  const duration = read('duration');
  const taxRate = Math.round(read('tax-rate').valueAsNumber * 100);
  const serviceEligible = read('service-eligible').checked;
  if (category) entry.category = category.value;
  if (duration) entry.duration = duration.valueAsNumber;
  if (taxRate !== (entry.taxRate ?? defaultItemTaxRateBps)) entry.taxRate = taxRate;
  if (serviceEligible !== (entry.serviceEligible !== false)) entry.serviceEligible = serviceEligible;
  if (read('fixed')) {
    const commission = parseCommission(dialog);
    if (Object.keys(commission).length) entry.commission = commission;
    else delete entry.commission;
  }
  if (!category) return;
  const popular = read('popular');
  if (popular.checked) entry.popular = true;
  else delete entry.popular;
  if (read('required-cast').checked) entry.requiresCast = true;
  else delete entry.requiresCast;
  const inventory = [...dialog.querySelectorAll('[name="store-stock-quantity"]')];
  if (inventory.length) {
    const recipe = inventory.filter((field) => field.valueAsNumber > 0).map((field) => ({
      stockId: field.dataset.stockId, quantity: field.valueAsNumber,
    }));
    if (recipe.length) entry.recipe = recipe;
    else delete entry.recipe;
  }
}

export function commitStoreSettingsEditor(dialog, editor) {
  const entry = selectedItem(editor);
  if (!entry) return true;
  const read = (field) => dialog.querySelector(`[name="store-${field}"]`);
  const name = read('name').value.trim().normalize('NFC');
  const unitInput = read('unit');
  const unit = unitInput?.value.trim().normalize('NFC');
  const error = dialog.querySelector('.form-error');
  error.hidden = true;
  const invalidText = !name || /[\p{Cc}\u2028\u2029]/u.test(name) ? read('name')
    : unitInput && (!unit || /[\p{Cc}\u2028\u2029]/u.test(unit)) ? unitInput : null;
  if (invalidText) {
    error.textContent = invalidText === unitInput ? '単位を入力してください。' : '名前を入力してください。';
    error.hidden = false;
    invalidText.focus();
    return false;
  }
  const invalid = dialog.querySelector('.store-editor-inspector input:invalid, .store-editor-inspector select:invalid');
  if (invalid) {
    const details = invalid.closest('details');
    if (details) details.open = true;
    invalid.reportValidity();
    return false;
  }
  if (editor.tab === 'stock') {
    entry.name = name;
    entry.unit = unit;
    entry.minimum = read('minimum').valueAsNumber;
    entry.defaultUnitCost = read('unit-cost').valueAsNumber;
    if (read('stock-visible').checked) delete entry.hidden;
    else entry.hidden = true;
    return true;
  }
  if (read('enabled').checked) delete entry.enabled;
  else entry.enabled = false;
  if (editor.tab === 'cast') {
    const commissionOverride = parseCommission(dialog);
    if (Object.keys(commissionOverride).length) entry.commissionOverride = commissionOverride;
    else delete entry.commissionOverride;
    if (name !== entry.name || !entry.initials) entry.initials = [...name][0];
  } else commitMenuFields(dialog, entry, read);
  entry.name = name;
  return true;
}

function availableName(base, entries) {
  const names = new Set(entries.map((entry) => entry.name));
  let name = base;
  for (let number = 2; names.has(name); number++) name = `${base} ${number}`;
  return name;
}

function newItem(editor, kind) {
  if (kind === 'cast') {
    const name = availableName('新しいキャスト', editor.settings.cast);
    const person = { id: `cast-${crypto.randomUUID()}`, name, initials: '新', color: 'violet' };
    editor.settings.cast.push(person);
    return person;
  }
  if (kind === 'stock') {
    const name = availableName('新しい在庫品目', editor.settings.stock);
    const item = { id: `stock-${crypto.randomUUID()}`, name, category: 'その他', unit: '個', minimum: 0 };
    editor.settings.stock.push(item);
    return item;
  }
  const defaults = {
    menu: { name: '新しい商品', category: 'ドリンク' },
    set: { name: '新しいセット', category: 'セット', duration: 60 },
    extension: { name: '新しい延長', category: '延長', duration: 30 },
    surcharge: { name: '延長指名料', category: '延長', requiresCast: true },
  };
  const item = { id: kind === 'surcharge' ? surchargeId : `menu-${crypto.randomUUID()}`, ...defaults[kind] };
  item.name = availableName(item.name, editor.settings.menu);
  editor.settings.menu.push(item);
  return item;
}

function restoreNavigation(dialog, action, id, listTop) {
  queueMicrotask(() => {
    if (!dialog.open) return;
    const list = dialog.querySelector('.store-editor-list');
    if (list) {
      list.scrollTop = listTop;
      const current = list.querySelector('[aria-pressed="true"]');
      if (current) {
        const viewport = list.getBoundingClientRect();
        const bounds = current.getBoundingClientRect();
        if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom;
        if (bounds.top < viewport.top) list.scrollTop += bounds.top - viewport.top;
      }
    }
    if (action === 'store-editor-add') {
      const name = dialog.querySelector('[name="store-name"]');
      name?.focus();
      name?.select();
    } else if (action === removalActions.stock.open || action === removalActions.catalog.open) {
      dialog.querySelector('.store-editor-removal-actions .btn-quiet')?.focus();
    } else if (action === removalActions.stock.cancel || action === removalActions.catalog.cancel) {
      dialog.querySelector('.store-editor-removal .btn-danger')?.focus();
    } else if (action === 'store-editor-select' || action === 'store-editor-discard-new'
      || action === removalActions.stock.confirm || action === removalActions.catalog.confirm) {
      const focus = list?.querySelector('[aria-pressed="true"]') ?? dialog.querySelector('.store-editor-add button');
      focus?.focus({ preventScroll: true });
    } else {
      dialog.querySelector(`[data-action="store-editor-tab"][data-id="${id}"]`)?.focus({ preventScroll: true });
    }
  });
}

function changeRemoval(dialog, editor, action, id, api) {
  const item = selectedItem(editor);
  const kind = settingsKey(editor.tab);
  const { open, cancel, confirm } = removalActions[kind === 'stock' ? 'stock' : 'catalog'];
  if (item?.id !== id || editor.additions?.has(id)) return false;
  if (action === cancel) {
    editor.pendingRemoval = null;
    return true;
  }
  const reason = removalReason(item, editor, api);
  if (reason) {
    const error = dialog.querySelector('.form-error');
    error.textContent = reason;
    error.hidden = false;
    return false;
  }
  if (action === open) {
    editor.pendingRemoval = id;
    return true;
  }
  if (action !== confirm || editor.pendingRemoval !== id) return false;
  editor.settings[kind] = editor.settings[kind].filter((entry) => entry.id !== id);
  (editor[removalKeys[kind]] ??= new Set()).add(id);
  delete editor.selected[editor.tab];
  editor.pendingRemoval = null;
  return true;
}

export function handleStoreSettingsEditorAction(dialog, editor, target, api = {}) {
  const { action, id } = target.dataset;
  if (action !== 'store-editor-discard-new' && !commitStoreSettingsEditor(dialog, editor)) return false;
  const listTop = dialog.querySelector('.store-editor-list')?.scrollTop ?? 0;
  switch (action) {
    case 'store-editor-tab':
      if (editor.tab === id) return false;
      editor.tab = id;
      editor.pendingRemoval = null;
      break;
    case 'store-editor-select':
      editor.selected[editor.tab] = id;
      editor.pendingRemoval = null;
      break;
    case 'store-editor-add': {
      const item = newItem(editor, id);
      editor.selected[editor.tab] = item.id;
      (editor.additions ??= new Set()).add(item.id);
      editor.pendingRemoval = null;
      break;
    }
    case 'store-editor-discard-new': {
      if (!editor.additions?.delete(id)) return false;
      const key = settingsKey(editor.tab);
      editor.settings[key] = editor.settings[key].filter((item) => item.id !== id);
      if (key === 'stock') {
        for (const item of editor.settings.menu) {
          if (!item.recipe?.some(({ stockId }) => stockId === id)) continue;
          const recipe = item.recipe.filter(({ stockId }) => stockId !== id);
          if (recipe.length) item.recipe = recipe;
          else delete item.recipe;
        }
      }
      delete editor.selected[editor.tab];
      break;
    }
    case removalActions.stock.open:
    case removalActions.stock.cancel:
    case removalActions.stock.confirm:
    case removalActions.catalog.open:
    case removalActions.catalog.cancel:
    case removalActions.catalog.confirm:
      if (!changeRemoval(dialog, editor, action, id, api)) return false;
      break;
    default:
      return false;
  }
  restoreNavigation(dialog, action, id, action === 'store-editor-tab' ? 0 : listTop);
  return true;
}
