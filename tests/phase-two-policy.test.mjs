import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { getCustomerDetail } from '../docs/customers.mjs';
import { projectState, validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-16';
const at = Date.parse(`${date}T21:00:00+09:00`);
const admin = { id: 'admin-a', role: 'admin', label: '店舗管理者' };
const manager = { id: 'manager-a', role: 'manager', label: '担当マネージャー' };
const otherManager = { id: 'manager-b', role: 'manager', label: '別のマネージャー' };
const staff = { id: 'staff-a', role: 'staff', label: 'スタッフ' };
const run = (state, action, actor = admin) => apply(state, action, at, actor);

function operatingData() {
  let state = run(createDemo('closed', at), { type: 'open', date, openingCash: 10_000 });
  state = run(state, { type: 'saveCustomer', customer: { name: '担当の利用者', kana: 'たんとう',
    phone: '090-1234-5678', memo: '担当のみ', birthday: '2001-01-23' } }, manager);
  state = run(state, { type: 'saveCustomer', customer: { name: '別の利用者', kana: 'べつのりようしゃ',
    phone: '090-5555-2233', memo: '別の担当のみ', birthday: '2001-02-03' } }, otherManager);
  for (const [index, actor] of [manager, otherManager].entries()) {
    const { id: customerId } = state.customers[index];
    state = run(state, { type: 'saveCustomer', customerId, customer: { creditEnabled: true, creditLimit: 30_000 } });
    state = run(state, { type: 'seat', tableIds: [`a${index + 1}`], guests: 1, setId: 'set60', customerId }, actor);
    const { id: ticketId } = state.tickets.at(-1);
    state = run(state, { type: 'settle', ticketId, creditDueDate: '2026-11-21',
      payments: [{ method: 'receivable', amount: quote(state, ticketId).remaining }] }, actor);
    state = run(state, { type: 'depart', ticketId }, actor);
    state = run(state, { type: 'recoverReceivable', receivableId: state.receivables[0].id, date, method: 'cash', amount: 500 }, actor);
  }
  return run(state, { type: 'close', actualCash: summary(state).expectedCash });
}

test('cloud projections restrict customer detail, ticket links, receivables, and audit data by role and assignment', () => {
  const state = operatingData();
  const [mine, theirs] = state.customers;
  const full = projectState(state, 'admin', admin.id);
  assert.equal(full.customers[1].phone, theirs.phone);
  assert.equal(full.receivables.length, 2);
  assert.ok(full.auditLog.some(({ action }) => action === 'recoverReceivable'));

  for (const [actor, own, other] of [[manager, mine, theirs], [otherManager, theirs, mine]]) {
    const result = projectState(state, 'manager', actor.id);
    const ownView = result.customers.find(({ id }) => id === own.id);
    assert.equal(ownView.phone, own.phone);
    assert.equal(ownView.memo, own.memo);
    assert.equal(ownView.creditLimit, 30_000);
    assert.equal(ownView.createdByUid, undefined);
    assert.deepEqual(result.customers.find(({ id }) => id === other.id),
      { id: other.id, name: other.name, kana: other.kana, restricted: true });
    assert.deepEqual(result.receivables.map(({ customerId }) => customerId), [own.id]);
    for (const records of [result.tickets, result.closedDays[0].ticketSnapshots]) {
      assert.equal(records.filter(({ customerId }) => customerId === own.id).length, 1);
      assert.equal(records.filter(({ customer, customerId }) => !customer && !customerId).length, 1);
      assert.ok(records.every(({ seatedByUid }) => seatedByUid === undefined));
    }
    assert.equal(result.auditLog, undefined);
  }

  const unassigned = projectState(state, 'manager', 'unassigned');
  assert.ok(unassigned.customers.every(({ restricted }) => restricted));
  assert.deepEqual(unassigned.receivables, []);
  const limited = projectState(state, 'staff', staff.id);
  assert.deepEqual(limited.customers, state.customers.map(({ id, name }) => ({ id, name, restricted: true })));
  assert.ok(limited.tickets.every(({ customer, customerId }) => !customer && !customerId));
  assert.equal(limited.receivables, undefined);
  assert.equal(limited.auditLog, undefined);
  assert.deepEqual(limited.closedDays, []);
  assert.equal(projectState(state, 'cast', 'other-actor'), null);
  assert.equal(projectState(state, 'trainee', 'other-actor'), null);
  assert.equal(state.customers[0].createdByUid, manager.id);
});

test('cloud command policy permits floor enrollment and restricts receivables and customer administration', () => {
  for (const role of ['admin', 'manager', 'staff']) {
    assert.doesNotThrow(() => verifyCommand(role, { type: 'seat', newCustomer: { name: '来店登録' } }));
    assert.doesNotThrow(() => verifyCommand(role, { type: 'settle', payments: [{ method: 'cash', amount: 1_000 }] }));
  }
  assert.throws(() => verifyCommand('staff', { type: 'settle', payments: [{ method: 'receivable', amount: 1_000 }] }),
    { code: 'forbidden' });
  for (const type of ['saveCustomer', 'recoverReceivable']) {
    assert.throws(() => verifyCommand('staff', { type }), { code: 'forbidden' });
    assert.doesNotThrow(() => verifyCommand('manager', { type }));
  }
  for (const type of ['mergeCustomers', 'linkCustomer', 'importCustomers']) {
    for (const role of ['staff', 'manager', 'cast', 'trainee']) {
      assert.throws(() => verifyCommand(role, { type }), { code: 'forbidden' });
    }
    assert.doesNotThrow(() => verifyCommand('admin', { type }));
  }
});

test('seating a public customer alias does not grant a manager access to the profile or its balance', () => {
  let state = operatingData();
  const customerId = state.customers[1].id;
  const nextDate = '2026-11-17';
  state = run(state, { type: 'open', date: nextDate, openingCash: 10_000 });
  state = run(state, { type: 'seat', tableIds: ['a1'], guests: 1, setId: 'set60', customerId }, manager);
  const result = projectState(state, 'manager', manager.id);
  assert.equal(result.customers.find(({ id }) => id === customerId).restricted, true);
  assert.equal(result.receivables.some((entry) => entry.customerId === customerId), false);
  assert.equal(getCustomerDetail(result, customerId), null);
  const { id: ticketId } = state.tickets[0];
  assert.throws(() => run(state, { type: 'settle', ticketId, creditDueDate: nextDate,
    payments: [{ method: 'receivable', amount: quote(state, ticketId).remaining }] }, manager), /担当マネージャー/);
});

test('cloud migration retains customer, visit and collection relationships and removes browser actor assignments', () => {
  const state = operatingData();
  const migrated = validateSnapshot(state);
  const [first] = migrated.customers;
  assert.equal(first.createdByUid, undefined);
  assert.equal(migrated.tickets[0].seatedByUid, undefined);
  assert.equal(migrated.closedDays[0].ticketSnapshots[0].seatedByUid, undefined);
  assert.equal(migrated.tickets[0].customerId, first.id);
  assert.deepEqual(migrated.receivables, state.receivables);
  assert.equal(migrated.auditLog, undefined);
  assert.throws(() => validateSnapshot({ ...state, customers: [] }), { code: 'invalid-snapshot' });
  const legacy = createDemo('live', at);
  delete legacy.customers;
  delete legacy.receivables;
  assert.doesNotThrow(() => validateSnapshot(legacy));
});
