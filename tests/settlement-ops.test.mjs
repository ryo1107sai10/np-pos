import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, getTicketForTable, quote, summary } from '../docs/engine.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';

const now = Date.parse('2026-11-16T21:00:00+09:00');
const admin = { id: 'admin-1', label: '店舗管理者', role: 'admin' };
const manager = { id: 'manager-1', label: 'マネージャー', role: 'manager' };
const run = (state, command, actor = admin) => apply(state, command, now, actor);

function seated() {
  const opened = run(createDemo('closed', now), { type: 'open', openingCash: 10_000 });
  return run(opened, { type: 'seat', tableIds: ['a1'], guests: 2, setId: 'set60' });
}

function ordered(state, ticketId) {
  return run(state, { type: 'order', ticketId, items: [
    { menuId: 'castDrink', quantity: 1, castIds: ['cast2'] },
    { menuId: 'highball', quantity: 1 },
  ] });
}

function settle(state, ticketId, payments = [{ method: 'cash', amount: quote(state, ticketId).remaining }]) {
  return run(state, { type: 'settle', ticketId, payments });
}

function cancellation(ticketId) {
  return { type: 'cancelSettlement', ticketId, reason: '支払方法を訂正するため' };
}

function reopening(ticketId, tableIds = ['a1']) {
  return { type: 'reopenTicket', ticketId, reason: '伝票を訂正するため', tableIds };
}

test('V-7 removes the split checkout and deposit from sales and commissions and restores inventory, retaining the original receipt', () => {
  const beforeOrder = seated();
  const [{ id: ticketId }] = beforeOrder.tickets;
  let state = ordered(beforeOrder, ticketId);
  const [, castDrink] = state.tickets[0].lines;
  state = run(state, { type: 'serve', ticketId, lineId: castDrink.id });
  state = run(state, { type: 'deposit', ticketId, method: 'cash', amount: 2_000 });
  state = settle(state, ticketId, [{ method: 'cash', amount: 8_000 }, { method: 'card', amount: 6_368 }]);
  assert.equal(summary(state).sales, 16_368);
  assert.equal(summary(state).commission[0].amount, 300);

  const reversed = run(state, cancellation(ticketId));
  const [archived] = reversed.cancelledSettlements;
  const [ticket] = reversed.tickets;
  const totals = summary(reversed);
  assert.equal(ticket.status, 'cancelled');
  assert.equal(ticket.settlement, null);
  assert.deepEqual([ticket.deposits, ticket.payments], [[], []]);
  assert.equal(totals.expectedCash, 10_000);
  assert.equal(totals.sales, 0);
  assert.equal(totals.tickets, 0);
  assert.deepEqual(totals.payments, { cash: 0, card: 0, qr: 0 });
  assert.deepEqual(totals.commission, []);
  assert.deepEqual(totals.pendingCommission, []);
  assert.deepEqual(reversed.stock, beforeOrder.stock);
  assert.deepEqual(reversed.movements.slice(3), state.movements);
  assert.equal(getTicketForTable(reversed, 'a1'), null);
  assert.equal(archived.reason, '支払方法を訂正するため');
  assert.equal(archived.date, beforeOrder.day.date);
  assert.deepEqual(archived.receipt, { ...state.tickets[0], tableLabels: ['A-01'] });
  assert.equal(state.tickets[0].status, 'paid');
  assert.throws(() => run(reversed, cancellation(ticketId)), /確定した会計/);
});

test('reopening keeps the ticket and orders, reserves stock once, and supports settling and reversing again without overwriting an earlier receipt', () => {
  const start = seated();
  const [{ id: ticketId, number: ticketNumber }] = start.tickets;
  const originalOrder = ordered(start, ticketId);
  const paid = settle(originalOrder, ticketId);
  const reversed = run(paid, cancellation(ticketId));
  const receipt = structuredClone(reversed.cancelledSettlements[0]);
  const reopened = run(reversed, reopening(ticketId));
  assert.equal(reopened.tickets[0].number, ticketNumber);
  assert.equal(reopened.tickets[0].status, 'open');
  assert.deepEqual(reopened.tickets[0].lines, originalOrder.tickets[0].lines);
  assert.deepEqual(reopened.stock, originalOrder.stock);
  assert.equal(quote(reopened, ticketId).remaining, 16_368);
  assert.equal(summary(reopened).sales, 0);
  assert.equal(summary(reopened).pendingCommission[0].amount, 300);
  assert.throws(() => run(reopened, reopening(ticketId)), /会計を取り消した伝票/);

  const paidAgain = settle(reopened, ticketId, [{ method: 'qr', amount: 16_368 }]);
  assert.equal(summary(paidAgain).sales, 16_368);
  assert.deepEqual(summary(paidAgain).payments, { cash: 0, card: 0, qr: 16_368 });
  const reversedAgain = run(paidAgain, cancellation(ticketId));
  assert.deepEqual(reversedAgain.stock, start.stock);
  assert.equal(reversedAgain.cancelledSettlements.length, 2);
  assert.notEqual(reversedAgain.cancelledSettlements[0].id, receipt.id);
  assert.deepEqual(reversedAgain.cancelledSettlements[1], receipt);
});

test('reopening rejects occupied tables, inadequate capacity, and insufficient stock atomically', () => {
  const start = seated();
  const [{ id: ticketId }] = start.tickets;
  const paid = settle(ordered(start, ticketId), ticketId);
  const departed = run(paid, { type: 'depart', ticketId });
  const reversed = run(departed, cancellation(ticketId));
  const occupied = run(reversed, { type: 'seat', tableIds: ['a1'], guests: 1, setId: 'set60' });
  assert.throws(() => run(occupied, reopening(ticketId)), /使用中/);

  const small = structuredClone(occupied);
  small.tables.find(({ id }) => id === 'a2').capacity = 1;
  assert.throws(() => run(small, reopening(ticketId, ['a2'])), /定員/);

  const remainingWhisky = occupied.stock.find(({ id }) => id === 'whisky').quantity;
  const depleted = run(occupied, { type: 'stockAdjust', stockId: 'whisky', quantity: -remainingWhisky, reason: '棚卸で調整' });
  const beforeReopen = structuredClone(depleted);
  assert.throws(() => run(depleted, reopening(ticketId, ['a2'])), /在庫が不足/);
  assert.deepEqual(depleted, beforeReopen);

  const moved = run(occupied, reopening(ticketId, ['a2']));
  assert.equal(getTicketForTable(moved, 'a2').id, ticketId);
  assert.deepEqual(moved.tickets[0].tableHistory.map(({ tableId }) => tableId), ['a1', 'a2']);
});

test('correction requires admin and a reason, and closed-day reversal records remain when opening a new day', () => {
  const start = seated();
  const [{ id: ticketId }] = start.tickets;
  const paid = settle(start, ticketId);
  assert.throws(() => run(paid, cancellation(ticketId), manager), /店舗管理者/);
  assert.throws(() => run(paid, { ...cancellation(ticketId), reason: ' ' }), /理由/);
  const reversed = run(paid, cancellation(ticketId));
  assert.throws(() => run(reversed, reopening(ticketId), manager), /店舗管理者/);
  assert.throws(() => run(reversed, { ...reopening(ticketId), reason: 'x'.repeat(121) }), /理由/);

  const closed = run(reversed, { type: 'close', actualCash: 10_000 });
  assert.throws(() => run(closed, reopening(ticketId)), /開店/);
  const nextDay = run(closed, { type: 'open', date: '2026-11-17', openingCash: 10_000 });
  assert.deepEqual(nextDay.tickets, []);
  assert.equal(nextDay.closedDays[0].sales, 0);
  assert.deepEqual(nextDay.cancelledSettlements, reversed.cancelledSettlements);
  assert.throws(() => run(nextDay, reopening(ticketId)), /伝票が見つかりません/);
});

test('cancelling an unmodified sale can restore a legitimately archived stock item with its original unit and cost', () => {
  let state = seated();
  const ticketId = state.tickets[0].id;
  const before = state.stock.find(({ id }) => id === 'champagne');
  state = run(state, { type: 'stockAdjust', stockId: 'champagne', quantity: 1 - before.quantity, reason: '在庫を試験調整' });
  state = run(state, { type: 'order', ticketId, items: [{ menuId: 'champagne', quantity: 1 }] });
  state = settle(state, ticketId);
  const settings = getStoreSettings(state);
  delete settings.menu.find(({ id }) => id === 'champagne').recipe;
  settings.stock = settings.stock.filter(({ id }) => id !== 'champagne');
  state = run(state, { type: 'saveStoreSettings', settings, removeStockIds: ['champagne'] });
  assert.equal(state.stock.some(({ id }) => id === 'champagne'), false);

  const reversed = run(state, cancellation(ticketId));
  const restored = reversed.stock.find(({ id }) => id === 'champagne');
  assert.equal(restored.hidden, true);
  assert.equal(restored.quantity, 1);
  assert.equal(restored.unit, before.unit);
  assert.equal(restored.value, before.unitCost);
  assert.equal(reversed.archivedStock.some(({ id }) => id === 'champagne'), false);
  const reopened = run(reversed, reopening(ticketId));
  const restocked = reopened.stock.find(({ id }) => id === 'champagne');
  assert.equal(restocked.quantity, 0);
});

test('previously cancelled order lines are excluded from both stock reversal and reopening', () => {
  const start = seated();
  const ticketId = start.tickets[0].id;
  let state = ordered(start, ticketId);
  const highball = state.tickets[0].lines.find(({ menuId }) => menuId === 'highball');
  state = run(state, { type: 'cancelLine', ticketId, lineId: highball.id, returnStock: true, reason: '注文の取り違え' });
  const paid = settle(state, ticketId);
  const reversed = run(paid, cancellation(ticketId));
  assert.deepEqual(reversed.stock, start.stock);
  const reopened = run(reversed, reopening(ticketId));
  assert.deepEqual(reopened.stock, state.stock);
  assert.equal(reopened.tickets[0].lines.find(({ id }) => id === highball.id).cancelledAt, now);
});
