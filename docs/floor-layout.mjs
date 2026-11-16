import { getLayoutTables, layoutAreas, layoutGrid } from './engine.mjs';

const { columns, rows, tableWidth, tableHeight } = layoutGrid;
const maxX = columns - tableWidth;
const maxY = rows - tableHeight;
const arrowSteps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function layoutAreaTabs(active, action, escape) {
  return `<div class="layout-areas" role="group" aria-label="表示エリア">${layoutAreas.map((area) =>
    `<button class="layout-area-button" type="button" data-action="${action}" data-id="${escape(area)}" aria-pressed="${area === active}">${escape(area)}</button>`).join('')}</div>`;
}

function gridPosition({ x, y }) {
  return `grid-column:${x + 1} / span ${tableWidth};grid-row:${y + 1} / span ${tableHeight}`;
}

export function floorLayoutStage(tables, area, { editing = false, selectedId, renderSeat, escape } = {}) {
  const visible = tables.filter((table) => table.area === area);
  return `<div class="layout-stage-scroll" tabindex="0" role="region" aria-label="${escape(area)}の卓配置"><div class="layout-stage${editing ? ' editing' : ''}" ${editing ? 'id="layout-stage"' : ''}>
    ${visible.length ? visible.map((table) => `<div class="layout-tile" style="${gridPosition(table)}">${editing
      ? `<button type="button" class="layout-edit-tile" data-action="layout-editor-table" data-layout-tile data-id="${escape(table.id)}" aria-pressed="${table.id === selectedId}" aria-label="${escape(table.name)}、定員${table.capacity}名"><strong class="layout-tile-label">${escape(table.name)}</strong><span class="layout-tile-capacity">定員 ${table.capacity}名</span></button>`
      : renderSeat(table)}</div>`).join('') : '<p class="layout-empty">表示する卓はありません。</p>'}
  </div></div>`;
}

export function newLayoutDraft(state, preferredArea, preferredId) {
  const tables = getLayoutTables(state);
  const selected = tables.find((table) => table.id === preferredId && (preferredArea === 'all' || table.area === preferredArea));
  const area = selected?.area ?? (layoutAreas.includes(preferredArea) ? preferredArea : layoutAreas[0]);
  return { tables, area, selectedId: selected?.id ?? tables.find((table) => table.area === area)?.id ?? null, drag: null };
}

function selectedTable(layout) {
  return layout.tables.find((table) => table.id === layout.selectedId);
}

function inspector(layout, escape) {
  const table = selectedTable(layout);
  if (!table) return '<p class="layout-inspector-empty">このエリアに卓はありません。別のエリアから卓を移せます。</p>';
  return `<div class="layout-selected"><h3>${escape(table.name)}</h3><span>${escape(table.area)}</span></div>
    <label class="field"><span>エリア</span><select name="layout-area">${layoutAreas.map((area) => `<option value="${escape(area)}" ${area === table.area ? 'selected' : ''}>${escape(area)}</option>`).join('')}</select></label>
    <div class="layout-position"><label class="field"><span>横位置</span><input type="number" name="layout-x" aria-label="横位置" min="1" max="${maxX + 1}" step="1" required value="${table.x + 1}" inputmode="numeric"></label>
    <label class="field"><span>縦位置</span><input type="number" name="layout-y" aria-label="縦位置" min="1" max="${maxY + 1}" step="1" required value="${table.y + 1}" inputmode="numeric"></label></div>
    <label class="field"><span>定員（名）</span><input type="number" name="layout-capacity" aria-label="定員（名）" min="1" max="100" step="1" required value="${table.capacity}" inputmode="numeric"></label>
    <button type="button" class="btn btn-secondary" data-action="layout-editor-apply">卓に反映</button>`;
}

export function renderLayoutEditor(layout, escape) {
  return `<div class="layout-editor"><div class="layout-editor-head"><p class="form-copy">卓をドラッグするか、入力欄で位置と定員を指定します。位置は左上から数えます。矢印キーでも卓を動かせます。</p></div>
    <div class="layout-toolbar" id="layout-editor-areas">${layoutAreaTabs(layout.area, 'layout-editor-area', escape)}</div>
    <div class="layout-editor-main"><div id="layout-editor-stage">${floorLayoutStage(layout.tables, layout.area, { editing: true, selectedId: layout.selectedId, escape })}</div>
    <section class="layout-inspector" aria-label="選択した卓の設定" id="layout-editor-inspector">${inspector(layout, escape)}</section></div>
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
  dialog.querySelector('#layout-editor-stage').innerHTML = floorLayoutStage(layout.tables, layout.area, { editing: true, selectedId: layout.selectedId, escape });
  dialog.querySelector('#layout-editor-areas').innerHTML = layoutAreaTabs(layout.area, 'layout-editor-area', escape);
  dialog.querySelector('#layout-editor-inspector').innerHTML = inspector(layout, escape);
  dialog.querySelector('.layout-stage-scroll').scrollLeft = scrollLeft;
  if (focusId) matchTile(dialog, focusId)?.focus({ preventScroll: true });
}

function selectTable(dialog, layout, id, escape) {
  layout.selectedId = id;
  for (const tile of dialog.querySelectorAll('[data-layout-tile]')) tile.setAttribute('aria-pressed', String(tile.dataset.id === id));
  dialog.querySelector('#layout-editor-inspector').innerHTML = inspector(layout, escape);
}

export function commitLayoutFields(dialog, layout) {
  const table = selectedTable(layout);
  if (!table) return { ok: true, changed: false };
  const field = (name) => dialog.querySelector(`[name="layout-${name}"]`).value;
  const candidate = { ...table, area: field('area'), x: Number(field('x')) - 1, y: Number(field('y')) - 1, capacity: Number(field('capacity')) };
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
  const changed = ['area', 'x', 'y', 'capacity'].some((key) => candidate[key] !== table[key]);
  if (changed) {
    Object.assign(table, candidate);
    layout.area = candidate.area;
  }
  return { ok: true, changed };
}

export function handleLayoutEditorAction(dialog, layout, target, escape) {
  if (layout.drag?.moved) return;
  const { action, id } = target.dataset;
  const result = commitLayoutFields(dialog, layout);
  if (!result.ok) return;
  showLayoutMessage(dialog);
  if (action === 'layout-editor-area') {
    const chosen = selectedTable(layout);
    layout.area = id;
    layout.selectedId = (chosen?.area === id ? chosen.id : layout.tables.find((table) => table.area === id)?.id) ?? null;
    refreshEditor(dialog, layout, escape);
    [...dialog.querySelectorAll('[data-action="layout-editor-area"]')].find((area) => area.dataset.id === id)?.focus();
  } else if (action === 'layout-editor-apply') {
    refreshEditor(dialog, layout, escape);
    dialog.querySelector('[data-action="layout-editor-apply"]')?.focus();
    showLayoutMessage(dialog, '卓の変更を反映しました。完了したらレイアウトを保存してください。');
  } else {
    layout.area = layout.tables.find((table) => table.id === id).area;
    if (result.changed) {
      layout.selectedId = id;
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
  dialog.addEventListener('pointerdown', (event) => {
    const layout = getLayout();
    const button = event.target.closest('[data-layout-tile]');
    if (!layout || !button || event.button !== 0 || layout.drag) return;
    const result = commitLayoutFields(dialog, layout);
    if (!result.ok) return;
    const table = layout.tables.find((entry) => entry.id === button.dataset.id);
    if (result.changed) {
      layout.area = table.area;
      layout.selectedId = table.id;
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
    const button = event.target.closest('[data-layout-tile]');
    if (!layout || !button || !Object.hasOwn(arrowSteps, event.key)) return;
    event.preventDefault();
    if (!commitLayoutFields(dialog, layout).ok) return;
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
