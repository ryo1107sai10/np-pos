import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, summary, yen } from '../docs/engine.mjs';
import { renderReport } from '../docs/reports.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';

const now = Date.parse('2026-11-16T14:41:00Z');
const soda = (state) => state.stock.find((item) => item.id === 'soda');

function adjust(state, quantity) {
  return apply(state, { type: 'stockAdjust', stockId: 'soda', quantity, reason: '数量調整' }, now);
}

function editSoda(state, fields) {
  const settings = getStoreSettings(state);
  Object.assign(soda(settings), fields);
  return apply(state, { type: 'saveStoreSettings', settings }, now);
}

test('quantity increases use the configured acquisition cost and withdrawals use weighted stock cost', () => {
  const legacy = createDemo('closed', now);
  assert.equal(adjust(legacy, 1).movements[0].unitCost, 125);

  const configured = editSoda(legacy, { defaultUnitCost: 245 });
  assert.equal(soda(configured).unitCost, 125);
  assert.equal(soda(configured).value, 3000);
  assert.deepEqual(configured.movements, legacy.movements);

  const restocked = adjust(configured, 6);
  assert.deepEqual([soda(restocked).quantity, soda(restocked).value, soda(restocked).unitCost], [30, 4470, 149]);
  assert.deepEqual([restocked.movements[0].unitCost, restocked.movements[0].cost], [245, 1470]);

  const withdrawn = adjust(restocked, -4);
  assert.deepEqual([soda(withdrawn).quantity, soda(withdrawn).value, soda(withdrawn).unitCost], [26, 3874, 149]);
  assert.deepEqual([withdrawn.movements[0].unitCost, withdrawn.movements[0].cost], [149, 596]);

  const comped = adjust(editSoda(withdrawn, { defaultUnitCost: 0 }), 1);
  assert.equal(comped.movements[0].unitCost, 0);
  assert.equal(soda(comped).value, 3874);
  assert.equal(soda(adjust(comped, -27)).value, 0);
});

test('orders and returns retain historical costs while the inventory report preserves recorded names and units', () => {
  let state = apply(createDemo('closed', now), { type: 'open', openingCash: 0 }, now);
  state = apply(state, { type: 'seat', tableIds: ['a1'], guests: 1, setId: 'set60' }, now);
  const { id: ticketId } = state.tickets[0];
  state = apply(state, { type: 'order', ticketId, items: [{ menuId: 'castDrink', quantity: 1, castIds: ['cast1'] }] }, now);
  const line = state.tickets[0].lines.at(-1);
  const originalMovement = state.movements[0];
  assert.equal(line.stockUses[0].unitCost, 125);

  state = editSoda(state, { name: 'ソーダ新名称', unit: '袋', minimum: 0.000001, defaultUnitCost: 245 });
  assert.deepEqual(state.movements[0], originalMovement);
  state = adjust(state, 1.25);
  assert.equal(soda(state).unitCost, 131);
  state = apply(state, { type: 'cancelLine', ticketId, lineId: line.id, returnStock: true, reason: '注文の変更' }, now);
  assert.equal(soda(state).quantity, 25.25);
  assert.equal(soda(state).value, 3306.25);
  assert.equal(state.movements[0].unitCost, 125);
  assert.deepEqual(state.movements.at(-1), originalMovement);

  const html = renderReport('stock', state, { summary, yen, escape: String, icon: () => '' });
  assert.match(html, /仕入原価<\/span>¥245/);
  assert.match(html, /0\.000001 袋/);
  assert.match(html, /ソーダ新名称<\/strong>/);
  assert.match(html, /クラブソーダ<\/strong><\/td>\s*<td>注文出庫[\s\S]*?−0\.25<span class="lr-unit"> 本/);
});

const inventoryManager = { id: 'manager', label: '在庫担当', role: 'manager' };
function inventoryOperation(state, fields, actor = inventoryManager) {
  return apply(state, { type: 'recordStockOperation', stockId: 'soda', reason: '棚の現物を確認', ...fields }, now, actor);
}

test('receipts use actual purchase cost and loss and consumption preserve distinct movement types', () => {
  const initial = createDemo('closed', now);
  const purchased = inventoryOperation(initial, { kind: 'purchase', quantity: 6, unitCost: 245 });
  assert.deepEqual([soda(purchased).quantity, soda(purchased).unitCost, soda(purchased).value], [30, 149, 4470]);
  assert.equal(soda(purchased).defaultUnitCost, 125);
  assert.equal(purchased.auditLog[0].after.unitCost, 245);
  const discarded = inventoryOperation(purchased, { kind: 'loss', quantity: 1.5 });
  const consumed = inventoryOperation(discarded, { kind: 'usage', quantity: 0.5 });
  assert.equal(soda(consumed).quantity, 28);
  assert.equal(soda(consumed).value, 4172);
  assert.deepEqual(consumed.movements.map(({ kind, quantity }) => [kind, quantity]), [['usage', -0.5], ['loss', -1.5], ['purchase', 6]]);
  assert.throws(() => inventoryOperation(initial, { kind: 'loss', quantity: 25 }), /不足/);
  assert.throws(() => inventoryOperation(initial, { kind: 'usage', quantity: -1 }), /正の数/);
  assert.throws(() => inventoryOperation(initial, { kind: 'purchase', quantity: 1, unitCost: -1 }), /仕入単価/);
  assert.equal(soda(initial).quantity, 24);
});

test('stocktake records the book quantity and actual count even with no difference, and rejects stale or unauthorized counts', () => {
  const initial = createDemo('closed', now);
  const corrected = inventoryOperation(initial, { kind: 'stocktake', bookQuantity: 24, actualQuantity: 23.75 });
  const { bookQuantity, actualQuantity, quantity, kind } = corrected.movements[0];
  assert.deepEqual({ bookQuantity, actualQuantity, quantity, kind }, { bookQuantity: 24, actualQuantity: 23.75, quantity: -0.25, kind: 'stocktake' });
  assert.throws(() => inventoryOperation(corrected, { kind: 'stocktake', bookQuantity: 24, actualQuantity: 23.75 }), /帳簿在庫が更新/);
  assert.throws(() => inventoryOperation(corrected, { kind: 'stocktake', bookQuantity: 23.75, actualQuantity: -1 }), /0以上/);
  assert.throws(() => inventoryOperation(corrected, { kind: 'stocktake', bookQuantity: 23.75, actualQuantity: 23.75 },
    { ...inventoryManager, role: 'staff' }), /権限/);
  const verified = inventoryOperation(corrected, { kind: 'stocktake', bookQuantity: 23.75, actualQuantity: 23.75 });
  assert.deepEqual(soda(verified), soda(corrected));
  assert.deepEqual(verified.movements.map((row) => row.quantity), [0, -0.25]);
  assert.equal(verified.auditLog[0].after.kind, 'stocktake');
  assert.deepEqual(verified.auditLog[0].actor, inventoryManager);
  const api = { summary, yen, escape: String, icon: () => '' };
  const html = renderReport('stock', verified, api);
  assert.match(html, /data-action="stocktake"/);
  assert.match(html, /帳簿 24 本 → 実数 23\.75 本/);
  assert.doesNotMatch(renderReport('stock', verified, { ...api, canAdjustStock: false }), /data-action="stock(?:take|-adjust)"/);
});
