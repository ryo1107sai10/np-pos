import { getLayoutAreas, getLayoutTables, getTicketForTable, layoutGrid, removeLayoutArea } from './engine.mjs';
import { icon } from './icons.mjs';

const { columns, rows, tableWidth, tableHeight } = layoutGrid;
const maxX = columns - tableWidth;
const maxY = rows - tableHeight;
const nameLimit = 24;
const arrowSteps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function layoutAreaTabs(active, action, escape, areas) {
  return `<div class="layout-areas" role="group" aria-label="表示エリア">${areas.map((area) =>
    `<button class="layout-area-button" type="button" data-action="${action}" data-id="${escape(area)}" aria-pressed="${area === active}" title="${escape(area)}"><span>${escape(area)}</span></button>`).join('')}</div>`;
}

function gridPosition({ x, y }) {
  return `grid-column:${x + 1} / span ${tableWidth};grid-row:${y + 1} / span ${tableHeight}`;
}

export function floorLayoutStage(tables, area, { editing = false, selectedId, renderSeat, escape, locks } = {}) {
  const visible = tables.filter((table) => table.area === area);
  return `<div class="layout-stage-scroll" tabindex="0" role="region" aria-label="${escape(area)}の卓配置"><div class="layout-stage${editing ? ' editing' : ''}" ${editing ? 'id="layout-stage"' : ''}>
    ${visible.length ? visible.map((table) => {
      const name = escape(table.name);
      const lock = locks?.get(table.id);
      return `<div class="layout-tile" style="${gridPosition(table)}">${editing
        ? `<button type="button" class="layout-edit-tile" data-action="layout-editor-table" data-layout-tile data-id="${escape(table.id)}" aria-pressed="${table.id === selectedId}" aria-label="${name}、定員${table.capacity}名${lock ? '、' + lock : ''}"><strong class="layout-tile-label" title="${name}">${name}</strong><span class="layout-tile-capacity">定員 ${table.capacity}名</span>${lock ? `<span class="layout-tile-status">${lock}</span>` : ''}</button>`
        : renderSeat(table)}</div>`;
    }).join('') : '<p class="layout-empty">このエリアに卓はありません。</p>'}
  </div></div>`;
}

export function newLayoutDraft(state, preferredArea, preferredId) {
  const tables = getLayoutTables(state);
  const areas = getLayoutAreas(state);
  const selected = tables.find((table) => table.id === preferredId && (preferredArea == null || table.area === preferredArea));
  const area = selected?.area ?? (areas.includes(preferredArea) ? preferredArea : areas[0]) ?? null;
  const locks = new Map();
  for (const table of tables) {
    const ticket = getTicketForTable(state, table.id);
    if (ticket) locks.set(table.id, ticket.status === 'paid' ? '退店待ち' : '使用中');
  }
  return { tables, areas, area, locks, selectedId: selected?.id ?? tables.find((table) => table.area === area)?.id ?? null,
    drag: null, areaEditor: null, pendingDeleteId: null, pendingAreaDelete: null };
}

function selectedTable(layout) {
  return layout.tables.find((table) => table.id === layout.selectedId);
}

function inspector(layout, escape) {
  const table = selectedTable(layout);
  if (!table) return '<p class="layout-inspector-empty">「卓を追加」から配置を始められます。</p>';
  const lock = layout.locks.get(table.id);
  const pendingDelete = layout.pendingDeleteId === table.id;
  return `<div class="layout-selected"><h3>${escape(table.name)}</h3>${lock ? `<span class="layout-lock-chip">${lock}</span>` : ''}</div>
    <label class="field"><span>卓名</span><input type="text" name="layout-name" maxlength="${nameLimit}" value="${escape(table.name)}" required></label>
    <label class="field"><span>エリア</span><select name="layout-area">${layout.areas.map((area) => `<option value="${escape(area)}" ${area === table.area ? 'selected' : ''}>${escape(area)}</option>`).join('')}</select></label>
    <div class="layout-position"><label class="field"><span>横位置</span><input type="number" name="layout-x" aria-label="横位置" min="1" max="${maxX + 1}" step="1" required value="${table.x + 1}" inputmode="numeric"></label>
    <label class="field"><span>縦位置</span><input type="number" name="layout-y" aria-label="縦位置" min="1" max="${maxY + 1}" step="1" required value="${table.y + 1}" inputmode="numeric"></label></div>
    <label class="field"><span>定員（名）</span><input type="number" name="layout-capacity" aria-label="定員（名）" min="1" max="100" step="1" required value="${table.capacity}" inputmode="numeric"></label>
    <button type="button" class="btn btn-secondary" data-action="layout-editor-apply">卓に反映</button>
    <div class="layout-delete">
      ${pendingDelete ? `<p>${escape(table.name)}を配置から外しますか？ レイアウトを保存すると反映されます。</p>
        <div class="layout-delete-actions"><button type="button" class="btn" data-action="layout-editor-cancel-delete">戻る</button>
        <button type="button" class="btn btn-danger" data-action="layout-editor-confirm-delete">削除を確定</button></div>`
      : `<button type="button" class="btn btn-danger" data-action="layout-editor-delete-table"${lock ? ' disabled aria-describedby="layout-delete-reason"' : ''}>${icon('x', 14)}卓を削除</button>
        ${lock ? `<p id="layout-delete-reason">${lock}の卓は削除できません。</p>` : ''}`}
    </div>`;
}

function areaToolbar(layout, escape) {
  const editor = layout.areaEditor;
  const hasArea = layout.areas.includes(layout.area);
  const tableCount = hasArea ? layout.tables.filter((table) => table.area === layout.area).length : 0;
  const pending = layout.pendingAreaDelete;
  const target = hasArea ? escape(layout.area) : '';
  return `<div class="layout-toolbar">${layoutAreaTabs(layout.area, 'layout-editor-area', escape, layout.areas)}
    <div class="layout-toolbar-actions">
      <button type="button" class="btn" data-action="layout-editor-rename-area"${hasArea ? '' : ' disabled'}>${icon('edit', 14)}エリア名を変更</button>
      <button type="button" class="btn" data-action="layout-editor-add-area">${icon('plus', 14)}フロア・エリアを追加</button>
      <button type="button" class="btn btn-secondary" data-action="layout-editor-add-table"${hasArea ? '' : ' disabled'}>${icon('table', 14)}卓を追加</button>
      <button type="button" class="btn btn-danger" data-action="layout-editor-delete-area" data-id="${target}"${!hasArea || tableCount ? ' disabled' : ''}${tableCount ? ' aria-describedby="layout-area-delete-reason"' : ''}>${icon('x', 14)}エリアを削除</button>
    </div></div>
    ${tableCount ? `<p class="layout-area-delete-reason" id="layout-area-delete-reason">このエリアには${tableCount}卓あります。エリアを削除するには、すべての卓を別のエリアへ移動するか、卓を削除してください。</p>` : ''}
    ${editor ? `<div class="layout-area-editor"><label class="field"><span>${editor.original ? 'エリアの新しい名前' : '新しいエリア名'}</span>
      <input type="text" name="layout-area-name" maxlength="${nameLimit}" value="${escape(editor.value)}" autocomplete="off"></label>
      <div class="layout-editor-actions"><button type="button" class="btn" data-action="layout-editor-cancel-area">戻る</button>
      <button type="button" class="btn btn-secondary" data-action="layout-editor-apply-area">${editor.original ? '名前を変更' : '追加を確定'}</button></div></div>` : ''}
    ${pending ? `<div class="layout-area-confirm" role="group" aria-labelledby="layout-area-confirm-copy">
      <p id="layout-area-confirm-copy"><strong>「${escape(pending)}」を削除しますか？</strong><span>レイアウトを保存すると反映されます。</span></p>
      <div class="layout-editor-actions"><button type="button" class="btn" data-action="layout-editor-cancel-area-delete">戻る</button>
      <button type="button" class="btn btn-danger" data-action="layout-editor-confirm-area-delete" data-id="${escape(pending)}">エリアの削除を確定</button></div></div>` : ''}`;
}

function editorStage(layout, escape) {
  if (layout.area === null) return `<div class="layout-no-areas"><span aria-hidden="true">${icon('grid', 23)}</span><strong>フロア・エリアがありません</strong><p>「フロア・エリアを追加」から配置を始められます。</p></div>`;
  const hint = layout.tables.some((table) => table.area === layout.area)
    ? `<p class="layout-pan-hint">${icon('move', 14)}図面の余白を左右にスワイプ</p>` : '';
  return hint + floorLayoutStage(layout.tables, layout.area, {
    editing: true, selectedId: layout.selectedId, escape, locks: layout.locks,
  });
}

export function renderLayoutEditor(layout, escape) {
  return `<div class="layout-editor"><div class="layout-editor-head"><p class="form-copy">卓をドラッグするか、矢印キーと座標入力で移動します。編集内容はレイアウトを保存すると反映されます。</p></div>
    <div class="layout-controls" id="layout-editor-areas">${areaToolbar(layout, escape)}</div>
    <div class="layout-editor-main${layout.area === null ? ' is-area-empty' : ''}"><div id="layout-editor-stage">${editorStage(layout, escape)}</div>
    <section class="layout-inspector" aria-label="選択した卓の設定" id="layout-editor-inspector"${layout.area === null ? ' hidden' : ''}>${layout.area === null ? '' : inspector(layout, escape)}</section></div>
    <p class="layout-msg" role="status" id="layout-msg" hidden></p></div>`;
}

function placementConflict(tables, target) {
  return tables.find((table) => table.id !== target.id && table.area === target.area
    && Math.abs(table.x - target.x) < tableWidth && Math.abs(table.y - target.y) < tableHeight);
}

function validPosition(value, maximum) {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}

function showLayoutMessage(dialog, message = '', error = false) {
  const node = dialog.querySelector('#layout-msg');
  node.textContent = message;
  node.classList.toggle('is-error', error);
  node.hidden = !message;
}

function matchTile(dialog, id) {
  return [...dialog.querySelectorAll('[data-layout-tile]')].find((tile) => tile.dataset.id === id);
}

function refreshEditor(dialog, layout, escape, focusId) {
  const previousScroll = dialog.querySelector('.layout-stage-scroll');
  const scrollLeft = previousScroll?.scrollLeft ?? 0;
  const activeTabScroll = dialog.querySelector('.layout-areas')?.scrollLeft ?? 0;
  dialog.querySelector('#layout-editor-stage').innerHTML = editorStage(layout, escape);
  dialog.querySelector('#layout-editor-areas').innerHTML = areaToolbar(layout, escape);
  const inspectorPane = dialog.querySelector('#layout-editor-inspector');
  const empty = layout.area === null;
  inspectorPane.hidden = empty;
  inspectorPane.innerHTML = empty ? '' : inspector(layout, escape);
  dialog.querySelector('.layout-editor-main').classList.toggle('is-area-empty', empty);
  const currentScroll = dialog.querySelector('.layout-stage-scroll');
  if (currentScroll) currentScroll.scrollLeft = scrollLeft;
  dialog.querySelector('.layout-areas').scrollLeft = activeTabScroll;
  if (focusId) matchTile(dialog, focusId)?.focus({ preventScroll: true });
}

function selectTable(dialog, layout, id, escape) {
  if (layout.selectedId !== id) layout.pendingDeleteId = null;
  layout.selectedId = id;
  for (const tile of dialog.querySelectorAll('[data-layout-tile]')) tile.setAttribute('aria-pressed', String(tile.dataset.id === id));
  dialog.querySelector('#layout-editor-inspector').innerHTML = inspector(layout, escape);
}

function nameKey(value) {
  return value.normalize('NFKC').toLowerCase();
}

function validName(value) {
  return value.length > 0 && value.length <= nameLimit && !/[\p{Cc}\u2028\u2029]/u.test(value);
}

function commitTableFields(dialog, layout) {
  const table = selectedTable(layout);
  if (!table) return { ok: true, changed: false };
  const field = (name) => dialog.querySelector(`[name="layout-${name}"]`).value;
  const name = field('name').trim().normalize('NFC');
  const candidate = { ...table, name, area: field('area'), x: Number(field('x')) - 1, y: Number(field('y')) - 1, capacity: Number(field('capacity')) };
  if (!validName(name)) {
    showLayoutMessage(dialog, `卓名は1〜${nameLimit}文字で入力してください。`, true);
    return { ok: false };
  }
  if (layout.tables.some((other) => other.id !== candidate.id && other.area === candidate.area && nameKey(other.name) === nameKey(name))) {
    showLayoutMessage(dialog, `${candidate.area}に「${name}」という卓がすでにあります。`, true);
    return { ok: false };
  }
  if (!validPosition(candidate.x, maxX) || !validPosition(candidate.y, maxY)) {
    showLayoutMessage(dialog, `横は1〜${maxX + 1}、縦は1〜${maxY + 1}の整数を入力してください。`, true);
    return { ok: false };
  }
  if (!Number.isInteger(candidate.capacity) || candidate.capacity < 1 || candidate.capacity > 100) {
    showLayoutMessage(dialog, '定員は1〜100名の整数を入力してください。', true);
    return { ok: false };
  }
  const conflict = placementConflict(layout.tables, candidate);
  if (conflict) {
    showLayoutMessage(dialog, `${conflict.name}と配置が重なります。空いている位置を指定してください。`, true);
    return { ok: false };
  }
  const changed = ['name', 'area', 'x', 'y', 'capacity'].some((key) => candidate[key] !== table[key]);
  if (changed) {
    Object.assign(table, candidate);
    layout.area = candidate.area;
  }
  return { ok: true, changed };
}

function commitAreaFields(dialog, layout) {
  const editor = layout.areaEditor;
  if (!editor) return { ok: true, changed: false };
  const name = dialog.querySelector('[name="layout-area-name"]').value.trim().normalize('NFC');
  if (!validName(name)) {
    showLayoutMessage(dialog, `エリア名は1〜${nameLimit}文字で入力してください。`, true);
    return { ok: false };
  }
  if (layout.areas.some((area) => area !== editor.original && nameKey(area) === nameKey(name))) {
    showLayoutMessage(dialog, `「${name}」というエリアがすでにあります。`, true);
    return { ok: false };
  }
  if (editor.original) {
    layout.areas = layout.areas.map((area) => area === editor.original ? name : area);
    for (const table of layout.tables) {
      if (table.area === editor.original) table.area = name;
    }
  } else {
    layout.areas.push(name);
  }
  layout.area = name;
  if (selectedTable(layout)?.area !== name) layout.selectedId = layout.tables.find((table) => table.area === name)?.id ?? null;
  layout.pendingDeleteId = null;
  layout.pendingAreaDelete = null;
  layout.areaEditor = null;
  return { ok: true, changed: name !== editor.original };
}

export function commitLayoutFields(dialog, layout, escape) {
  if (layout.pendingAreaDelete) {
    showLayoutMessage(dialog, 'エリアの削除を確定するか、戻ってから保存してください。', true);
    dialog.querySelector('[data-action="layout-editor-confirm-area-delete"]')?.focus();
    return { ok: false };
  }
  if (layout.pendingDeleteId) {
    showLayoutMessage(dialog, '卓の削除を確定するか、戻ってから保存してください。', true);
    dialog.querySelector('[data-action="layout-editor-confirm-delete"]')?.focus();
    return { ok: false };
  }
  const tableResult = commitTableFields(dialog, layout);
  if (!tableResult.ok || !layout.areaEditor) return tableResult;
  const areaResult = commitAreaFields(dialog, layout);
  if (!areaResult.ok) {
    dialog.querySelector('[name="layout-area-name"]')?.focus();
    return areaResult;
  }
  refreshEditor(dialog, layout, escape);
  return { ok: true, changed: tableResult.changed || areaResult.changed };
}

function firstFreePosition(tables, area) {
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= maxX; x++) {
      const candidate = { area, x, y };
      if (!placementConflict(tables, candidate)) return candidate;
    }
  }
  return null;
}

function addTable(dialog, layout, escape) {
  const position = firstFreePosition(layout.tables, layout.area);
  if (!position) {
    showLayoutMessage(dialog, 'このエリアに卓を追加できる空きがありません。別のエリアを選んでください。', true);
    return;
  }
  const names = new Set(layout.tables.filter((table) => table.area === layout.area).map((table) => nameKey(table.name)));
  let index = 1;
  while (names.has(nameKey(`卓 ${index}`))) index++;
  const table = { id: `table-${crypto.randomUUID()}`, name: `卓 ${index}`, ...position, capacity: 4 };
  layout.tables.push(table);
  layout.selectedId = table.id;
  layout.pendingDeleteId = null;
  refreshEditor(dialog, layout, escape);
  const nameField = dialog.querySelector('[name="layout-name"]');
  nameField.focus();
  nameField.select();
  showLayoutMessage(dialog, '卓を追加しました。卓名と定員を確認してレイアウトを保存してください。');
}

function focusAreaTab(dialog, area) {
  [...dialog.querySelectorAll('[data-action="layout-editor-area"]')].find((button) => button.dataset.id === area)?.focus();
}

function updateAreaDeletion(dialog, layout, target, escape) {
  const { action, id } = target.dataset;
  if (action === 'layout-editor-delete-area') {
    if (id !== layout.area || !layout.areas.includes(id) || layout.tables.some((table) => table.area === id)) return;
    layout.pendingAreaDelete = id;
    refreshEditor(dialog, layout, escape);
    dialog.querySelector('[data-action="layout-editor-cancel-area-delete"]')?.focus();
    return;
  }
  if (action === 'layout-editor-cancel-area-delete') {
    layout.pendingAreaDelete = null;
    refreshEditor(dialog, layout, escape);
    dialog.querySelector('[data-action="layout-editor-delete-area"]')?.focus();
    return;
  }
  if (id !== layout.pendingAreaDelete) return;
  const position = layout.areas.indexOf(id);
  try {
    layout.areas = removeLayoutArea(layout.areas, layout.tables, id);
  } catch (error) {
    showLayoutMessage(dialog, error.message, true);
    return;
  }
  layout.area = layout.areas[position] ?? layout.areas[position - 1] ?? null;
  layout.selectedId = layout.tables.find((table) => table.area === layout.area)?.id ?? null;
  layout.pendingAreaDelete = null;
  layout.pendingDeleteId = null;
  if (layout.areaEditor?.original === id) layout.areaEditor = null;
  refreshEditor(dialog, layout, escape);
  if (layout.area === null) dialog.querySelector('[data-action="layout-editor-add-area"]')?.focus();
  else focusAreaTab(dialog, layout.area);
  showLayoutMessage(dialog, `「${id}」の削除を選択しました。保存すると反映されます。`);
}

export function handleLayoutEditorAction(dialog, layout, target, escape) {
  if (layout.drag?.moved) return;
  const { action, id } = target.dataset;
  if (['layout-editor-delete-area', 'layout-editor-cancel-area-delete', 'layout-editor-confirm-area-delete'].includes(action)) {
    updateAreaDeletion(dialog, layout, target, escape);
    return;
  }
  if (action === 'layout-editor-cancel-area') {
    const entry = layout.areaEditor;
    layout.areaEditor = null;
    dialog.querySelector('#layout-editor-areas').innerHTML = areaToolbar(layout, escape);
    const actionToFocus = entry?.original ? 'layout-editor-rename-area' : 'layout-editor-add-area';
    dialog.querySelector(`[data-action="${actionToFocus}"]`)?.focus();
    showLayoutMessage(dialog);
    return;
  }
  if (action === 'layout-editor-cancel-delete') {
    layout.pendingDeleteId = null;
    dialog.querySelector('#layout-editor-inspector').innerHTML = inspector(layout, escape);
    dialog.querySelector('[data-action="layout-editor-delete-table"]')?.focus();
    return;
  }
  if (action === 'layout-editor-confirm-delete') {
    const table = selectedTable(layout);
    if (!table || layout.pendingDeleteId !== table.id || layout.locks.has(table.id)) return;
    layout.tables = layout.tables.filter((item) => item.id !== table.id);
    layout.selectedId = layout.tables.find((item) => item.area === layout.area)?.id ?? null;
    layout.pendingDeleteId = null;
    refreshEditor(dialog, layout, escape);
    dialog.querySelector('[data-action="layout-editor-add-table"]')?.focus();
    showLayoutMessage(dialog, '卓の削除を選択しました。レイアウトを保存すると反映されます。');
    return;
  }
  const result = commitTableFields(dialog, layout);
  if (!result.ok) return;
  showLayoutMessage(dialog);
  if (action === 'layout-editor-area') {
    const chosen = selectedTable(layout);
    layout.area = id;
    layout.selectedId = (chosen?.area === id ? chosen.id : layout.tables.find((table) => table.area === id)?.id) ?? null;
    layout.pendingDeleteId = null;
    if (layout.pendingAreaDelete !== id) layout.pendingAreaDelete = null;
    refreshEditor(dialog, layout, escape);
    focusAreaTab(dialog, id);
  } else if (action === 'layout-editor-apply') {
    refreshEditor(dialog, layout, escape);
    dialog.querySelector('[data-action="layout-editor-apply"]')?.focus();
    showLayoutMessage(dialog, '卓の変更を反映しました。完了したらレイアウトを保存してください。');
  } else if (action === 'layout-editor-delete-table') {
    const table = selectedTable(layout);
    if (!table || layout.locks.has(table.id)) return;
    layout.pendingDeleteId = table.id;
    refreshEditor(dialog, layout, escape);
    dialog.querySelector('[data-action="layout-editor-cancel-delete"]')?.focus();
  } else if (action === 'layout-editor-add-table') {
    if (layout.area !== null) addTable(dialog, layout, escape);
  } else if (action === 'layout-editor-add-area' || action === 'layout-editor-rename-area') {
    if (action === 'layout-editor-rename-area' && layout.area === null) return;
    const original = action === 'layout-editor-rename-area' ? layout.area : null;
    layout.areaEditor = { original, value: original ?? '' };
    refreshEditor(dialog, layout, escape);
    const areaField = dialog.querySelector('[name="layout-area-name"]');
    areaField.focus();
    areaField.select();
  } else if (action === 'layout-editor-apply-area') {
    if (!commitAreaFields(dialog, layout).ok) return;
    refreshEditor(dialog, layout, escape);
    focusAreaTab(dialog, layout.area);
    showLayoutMessage(dialog, 'エリアの変更を反映しました。完了したらレイアウトを保存してください。');
  } else if (action === 'layout-editor-table') {
    layout.area = layout.tables.find((table) => table.id === id).area;
    if (result.changed) {
      layout.selectedId = id;
      layout.pendingDeleteId = null;
      refreshEditor(dialog, layout, escape, id);
    } else {
      selectTable(dialog, layout, id, escape);
    }
  }
}

function dragPreview(event, layout) {
  const drag = layout.drag;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  drag.moved = true;
  const x = Math.min(maxX, Math.max(0, drag.table.x + Math.round(dx / drag.cellWidth)));
  const y = Math.min(maxY, Math.max(0, drag.table.y + Math.round(dy / drag.cellHeight)));
  drag.candidate = { ...drag.table, x, y };
  drag.conflict = placementConflict(layout.tables, drag.candidate);
  drag.tile.style.cssText = gridPosition(drag.candidate);
  drag.tile.classList.add('is-dragging');
  drag.tile.classList.toggle('is-collision', Boolean(drag.conflict));
}

export function bindLayoutEditor(dialog, getLayout, escape) {
  dialog.addEventListener('input', (event) => {
    const layout = getLayout();
    if (layout?.areaEditor && event.target.name === 'layout-area-name') layout.areaEditor.value = event.target.value;
  });
  dialog.addEventListener('pointerdown', (event) => {
    const layout = getLayout();
    const button = event.target.closest('[data-layout-tile]');
    if (!layout || !button || event.button !== 0 || layout.drag) return;
    const result = commitTableFields(dialog, layout);
    if (!result.ok) return;
    const table = layout.tables.find((entry) => entry.id === button.dataset.id);
    if (result.changed) {
      layout.area = table.area;
      layout.selectedId = table.id;
      layout.pendingDeleteId = null;
      refreshEditor(dialog, layout, escape, table.id);
      return;
    }
    const stage = dialog.querySelector('#layout-stage');
    const bounds = stage.getBoundingClientRect();
    selectTable(dialog, layout, table.id, escape);
    showLayoutMessage(dialog);
    button.setPointerCapture(event.pointerId);
    layout.drag = { pointerId: event.pointerId, table, tile: button.closest('.layout-tile'),
      startX: event.clientX, startY: event.clientY, cellWidth: bounds.width / columns, cellHeight: bounds.height / rows,
      moved: false, candidate: null, conflict: null };
  });
  dialog.addEventListener('pointermove', (event) => {
    const layout = getLayout();
    if (layout?.drag?.pointerId === event.pointerId) dragPreview(event, layout);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    dialog.addEventListener(type, (event) => {
      const layout = getLayout();
      const drag = layout?.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      layout.drag = null;
      if (!drag.moved) return;
      if (type === 'pointerup' && !drag.conflict && drag.candidate) Object.assign(drag.table, drag.candidate);
      refreshEditor(dialog, layout, escape, drag.table.id);
      if (type === 'pointerup' && drag.conflict) {
        showLayoutMessage(dialog, `${drag.conflict.name}と配置が重なります。空いている位置を選んでください。`, true);
      }
    });
  }
  dialog.addEventListener('keydown', (event) => {
    const layout = getLayout();
    if (layout?.areaEditor && event.target.name === 'layout-area-name' && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      handleLayoutEditorAction(dialog, layout, dialog.querySelector('[data-action="layout-editor-apply-area"]'), escape);
      return;
    }
    const button = event.target.closest('[data-layout-tile]');
    if (!layout || !button || !Object.hasOwn(arrowSteps, event.key)) return;
    event.preventDefault();
    if (!commitTableFields(dialog, layout).ok) return;
    const table = layout.tables.find((entry) => entry.id === button.dataset.id);
    const [dx, dy] = arrowSteps[event.key];
    const candidate = { ...table, x: table.x + dx, y: table.y + dy };
    if (!validPosition(candidate.x, maxX) || !validPosition(candidate.y, maxY)) {
      showLayoutMessage(dialog, 'この方向にはこれ以上移動できません。', true);
      return;
    }
    const conflict = placementConflict(layout.tables, candidate);
    if (conflict) {
      showLayoutMessage(dialog, `${conflict.name}と配置が重なります。`, true);
      return;
    }
    Object.assign(table, candidate);
    layout.area = table.area;
    layout.selectedId = table.id;
    refreshEditor(dialog, layout, escape, table.id);
    showLayoutMessage(dialog, `${table.name}を 横${table.x + 1}・縦${table.y + 1} に移動しました。`);
  });
}
