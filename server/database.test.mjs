import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import worker from './index.mjs';
import {
  applyCommand, changeMember, createStore, inviteMember, listAudit, listMembers, listStores, migrateState, readState, revokeInvite,
} from './database.mjs';

const schema = readFileSync(new URL('schema.sql', import.meta.url), 'utf8');
const owner = { uid: 'owner-1', email: 'owner@example.test' };
const helper = { uid: 'helper-1', email: 'helper@example.test' };
const outsider = { uid: 'outsider-1', email: 'outsider@example.test' };

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  function query(sql, parameters) {
    const statement = sqlite.prepare(sql);
    const results = statement.all(...parameters);
    const { changes } = sqlite.prepare('SELECT changes() AS changes').get();
    return { results, meta: { changes } };
  }
  return {
    prepare(sql) {
      const bind = (...parameters) => ({
        query: () => query(sql, parameters),
        all: async () => query(sql, parameters),
        first: async () => query(sql, parameters).results[0] ?? null,
      });
      return { bind, ...bind() };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.query());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

async function store(db, user = owner) {
  return (await createStore(db, user, 'NP POS テスト店')).store.id;
}

const command = (db, actor, storeId, expectedRevision, operationId, action) =>
  applyCommand(db, actor, storeId, { expectedRevision, operationId, command: action });

test('store membership isolates accounts and only a verified matching invite gets claimed', async () => {
  const db = database();
  const tenant = await store(db);
  assert.deepEqual(await listStores(db, outsider), { stores: [] });
  await assert.rejects(readState(db, outsider, tenant, null), { code: 'store-access' });
  await assert.rejects(inviteMember(db, outsider, tenant, helper.email, 'staff'), { code: 'store-access' });
  const pending = await inviteMember(db, owner, tenant, helper.email.toUpperCase(), 'staff');
  assert.equal(pending.invite.email, helper.email);
  assert.equal((await listMembers(db, owner, tenant)).invites.length, 1);
  assert.equal((await listStores(db, outsider)).stores.length, 0);
  assert.equal((await listStores(db, helper)).stores[0].role, 'staff');
  assert.equal((await listMembers(db, owner, tenant)).invites.length, 0);
  await assert.rejects(listMembers(db, helper, tenant), { code: 'forbidden' });
  await assert.rejects(changeMember(db, owner, tenant, owner.uid, 'staff'), { code: 'primary-member' });
  await changeMember(db, owner, tenant, helper.uid, 'cast');
  const payload = await readState(db, helper, tenant, 0);
  assert.deepEqual(payload, { restricted: true, role: 'cast', revision: 0 });
  await changeMember(db, owner, tenant, helper.uid);
  await assert.rejects(readState(db, helper, tenant, null), { code: 'store-access' });
  const removed = await inviteMember(db, owner, tenant, outsider.email, 'manager');
  await revokeInvite(db, owner, tenant, removed.invite.id);
  assert.equal((await listStores(db, outsider)).stores.length, 0);
});

test('development engine rules execute server-side and only one conflicting seating commits', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'staff');
  await listStores(db, helper);
  await assert.rejects(command(db, helper, tenant, 0, 'disallowed-command-1', { type: 'open', openingCash: 1000 }),
    { code: 'forbidden' });
  const opened = await command(db, owner, tenant, 0, 'first-opening-op01', { type: 'open', openingCash: 1000 });
  assert.equal(opened.revision, 1);
  const seat = { type: 'seat', tableIds: ['a1'], guests: 2, setId: 'set60', customer: 'Confidential name' };
  const results = await Promise.allSettled([
    command(db, helper, tenant, 1, 'simultaneous-seat1', seat),
    command(db, owner, tenant, 1, 'simultaneous-seat2', seat),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'revision-conflict');
  const current = await readState(db, owner, tenant, null);
  assert.equal(current.state.tickets.length, 1);
  assert.equal(current.state.tickets[0].customer, 'Confidential name');
  const staffState = await readState(db, helper, tenant, null);
  assert.equal(staffState.state.tickets[0].customer, '');
  assert.equal(staffState.state.stock[0].unitCost, 0);
  assert.ok(staffState.state.menu.find((item) => item.id === 'castDrink').acceptsCast);
  assert.deepEqual(await readState(db, helper, tenant, 2), { unchanged: true, role: 'staff', revision: 2 });
  const retryActor = results[0].status === 'fulfilled' ? helper : owner;
  const retryKey = results[0].status === 'fulfilled' ? 'simultaneous-seat1' : 'simultaneous-seat2';
  assert.equal((await command(db, retryActor, tenant, 1, retryKey, seat)).state.tickets.length, 1);
  await assert.rejects(command(db, retryActor, tenant, 1, retryKey, { ...seat, guests: 1 }), { code: 'operation-reused' });
  await assert.rejects(command(db, owner, tenant, 2, 'duplicate-seat-at-2', seat), { code: 'rejected-command' });
  assert.equal((await readState(db, owner, tenant, null)).revision, 2);
});

test('offline-safe envelope protects one-time migration and returns complete chunked data', async () => {
  const db = database();
  const tenant = await store(db);
  const original = createDemo();
  original.movements.push(...Array.from({ length: 3500 }, (_, index) => ({
    id: `legacy-movement-${index}`, reason: '文字😀'.repeat(10), quantity: 0,
  })));
  await inviteMember(db, owner, tenant, helper.email, 'manager');
  await listStores(db, helper);
  await assert.rejects(migrateState(db, helper, tenant, { operationId: 'migration-blocked1', snapshot: original }), { code: 'forbidden' });
  await assert.rejects(migrateState(db, owner, tenant, { operationId: 'migration-invalid1', snapshot: {} }), { code: 'invalid-snapshot' });
  const applied = await migrateState(db, owner, tenant, { operationId: 'migration-confirm1', snapshot: original });
  assert.equal(applied.revision, 1);
  const expected = { ...original };
  delete expected.auditLog;
  assert.deepEqual(applied.state, expected);
  const retried = await migrateState(db, owner, tenant, { operationId: 'migration-confirm1', snapshot: original });
  assert.equal(retried.revision, 1);
  await assert.rejects(migrateState(db, owner, tenant, { operationId: 'migration-existing', snapshot: original }), { code: 'migration-not-empty' });
  const managerState = await readState(db, helper, tenant, null);
  assert.equal(managerState.state.movements.length, original.movements.length);
  const result = await command(db, helper, tenant, 1, 'adjust-after-upload', { type: 'stockAdjust', stockId: 'fruit', quantity: 1, reason: 'テスト' });
  assert.equal(result.revision, 2);
  assert.equal(result.state.movements.length, original.movements.length + 1);
});

test('manager customer names are scoped to their own checkout records and legacy migration cannot assign an actor', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'manager');
  await listStores(db, helper);
  const original = createDemo('closed');
  await migrateState(db, owner, tenant, { operationId: 'migration-scope-01', snapshot: original });
  await command(db, owner, tenant, 1, 'manager-scope-open', { type: 'open', openingCash: 0 });
  let current = await command(db, owner, tenant, 2, 'manager-scope-seat1', {
    type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 1, customer: 'Owner reservation',
  });
  assert.equal(current.state.tickets[0].seatedByUid, owner.uid);
  current = await command(db, helper, tenant, 3, 'manager-scope-seat2', {
    type: 'seat', tableIds: ['a2'], setId: 'set60', guests: 1, customer: 'Manager reservation',
  });
  assert.deepEqual(current.state.tickets.map((ticket) => ticket.customer), ['', 'Manager reservation']);
  assert.ok(current.state.tickets.every((ticket) => ticket.seatedByUid === undefined));
  for (const [index, ticket] of current.state.tickets.entries()) {
    await command(db, helper, tenant, 4 + index * 2, `manager-scope-settle${index}`, {
      type: 'settle', ticketId: ticket.id, payments: [{ method: 'cash', amount: 6600 }],
    });
    await command(db, helper, tenant, 5 + index * 2, `manager-scope-depart${index}`, { type: 'depart', ticketId: ticket.id });
  }
  const closed = await command(db, helper, tenant, 8, 'manager-scope-close', { type: 'close', actualCash: 13200 });
  assert.deepEqual(closed.state.closedDays[0].ticketSnapshots.map((ticket) => ticket.customer), ['', 'Manager reservation']);
  const admin = await readState(db, owner, tenant, null);
  assert.deepEqual(admin.state.closedDays[0].ticketSnapshots.map((ticket) => ticket.customer),
    ['Owner reservation', 'Manager reservation']);

  const legacyTenant = await store(db);
  const incoming = createDemo('live');
  incoming.tickets[0].seatedByUid = helper.uid;
  const migrated = await migrateState(db, owner, legacyTenant, { operationId: 'migration-scope-02', snapshot: incoming });
  assert.equal(migrated.state.tickets[0].seatedByUid, undefined);
});

test('Worker rejects unauthenticated and disallowed cross-origin requests', async () => {
  const env = { DB: database(), FIREBASE_PROJECT_ID: 'testing-project' };
  const check = (path, options) => worker.fetch(new Request(`https://example.test${path}`, options), env);
  assert.deepEqual(await (await check('/api/health')).json(), { ok: true });
  const allowed = await check('/api/stores', { headers: { Origin: 'https://ryo1107sai10.github.io' } });
  assert.equal(allowed.status, 401);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://ryo1107sai10.github.io');
  assert.equal((await check('/api/stores', { headers: { Origin: 'https://unrelated.example.test' } })).status, 403);
  assert.equal((await check('/api/stores', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:8118' } })).status, 204);
  assert.equal((await check('/api/stores/test-store/audit')).status, 401);
});

test('cloud audits are separate from browser data, tenant-scoped, paged, and tied to one committed revision', async () => {
  const db = database();
  const tenant = await store(db);
  const otherTenant = await store(db);
  assert.deepEqual(await listAudit(db, owner, tenant), { events: [], nextBefore: null });
  await assert.rejects(listAudit(db, outsider, tenant), { code: 'store-access' });
  const incoming = createDemo('closed');
  incoming.auditLog = [{ id: 'forged-browser-log', action: 'discount' }];
  await migrateState(db, owner, tenant, { operationId: 'ops-audit-migrate', snapshot: incoming });
  await inviteMember(db, owner, tenant, helper.email, 'manager');
  await listStores(db, helper);
  const adjustment = { type: 'stockAdjust', stockId: 'fruit', quantity: 1, reason: '棚卸確認',
    actor: { id: owner.uid, label: '偽の管理者', role: 'admin' } };
  await command(db, helper, tenant, 1, 'ops-audit-stock01', adjustment);
  await command(db, helper, tenant, 1, 'ops-audit-stock01', adjustment);
  await assert.rejects(command(db, helper, tenant, 2, 'ops-audit-stock01', { ...adjustment, quantity: 2 }), { code: 'operation-reused' });
  await assert.rejects(listAudit(db, helper, tenant), { code: 'forbidden' });
  assert.equal((await readState(db, helper, tenant, null)).state.auditLog, undefined);
  assert.equal((await readState(db, owner, tenant, null)).state.auditLog, undefined);
  const first = await listAudit(db, owner, tenant, { limit: 1 });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].action, 'stockAdjust');
  assert.deepEqual(first.events[0].actor, { id: helper.uid, label: helper.email, role: 'manager' });
  assert.equal(first.events[0].reason, '棚卸確認');
  assert.equal(first.nextBefore, 2);
  const second = await listAudit(db, owner, tenant, { before: first.nextBefore, limit: 1 });
  assert.equal(second.events[0].action, 'migrate');
  assert.equal(second.nextBefore, null);
  assert.deepEqual(await listAudit(db, owner, tenant, { before: 1 }), { events: [], nextBefore: null });
  assert.deepEqual(await listAudit(db, owner, otherTenant), { events: [], nextBefore: null });
  await assert.rejects(listAudit(db, owner, tenant, { limit: 101 }), { code: 'invalid-audit-limit' });
  await assert.rejects(listAudit(db, owner, tenant, { before: 0 }), { code: 'invalid-audit-cursor' });
  await changeMember(db, owner, tenant, helper.uid, 'admin');
  assert.equal((await listAudit(db, helper, tenant)).events.length, 2);
  await changeMember(db, owner, tenant, helper.uid, 'manager');
  await assert.rejects(listAudit(db, helper, tenant), { code: 'forbidden' });
});

test('server controls limit manager discounts and require administrator decisions and corrections', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'manager');
  await listStores(db, helper);
  await inviteMember(db, owner, tenant, outsider.email, 'staff');
  await listStores(db, outsider);
  const opened = await command(db, owner, tenant, 0, 'ops-guard-opening', { type: 'open', openingCash: 0 });
  const seated = await command(db, outsider, tenant, opened.revision, 'ops-guard-seating', {
    type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 1,
  });
  const ticketId = seated.state.tickets[0].id;
  const discount = { type: 'discount', ticketId, mode: 'amount', value: 750, reasonCode: 'service', reason: '来店特典' };
  await assert.rejects(command(db, outsider, tenant, 2, 'ops-guard-by-staff', discount), { code: 'forbidden' });
  await assert.rejects(command(db, helper, tenant, 2, 'ops-guard-no-reason', { ...discount, reason: '' }), { code: 'reason-required' });
  const pending = await command(db, helper, tenant, 2, 'ops-guard-discount', {
    ...discount, actor: { id: owner.uid, label: owner.email, role: 'admin' },
  });
  assert.equal(pending.revision, 3);
  assert.equal(pending.state.tickets[0].discount, 0);
  const requestId = pending.state.tickets[0].discountRequest.id;
  assert.ok(requestId);
  const staffView = (await readState(db, outsider, tenant, null)).state.tickets[0];
  assert.deepEqual(staffView.discountRequest, { id: requestId });
  for (const type of ['approveDiscount', 'rejectDiscount', 'saveControls', 'cancelSettlement', 'reopenTicket']) {
    await assert.rejects(command(db, helper, tenant, 3, 'ops-guard-manager-' + type, { type, ticketId, requestId, reason: '権限確認' }),
      { code: 'forbidden' });
  }
  await assert.rejects(command(db, outsider, tenant, 3, 'ops-guard-pending', {
    type: 'settle', ticketId, payments: [{ method: 'cash', amount: 6600 }],
  }), { code: 'rejected-command' });
  const approved = await command(db, owner, tenant, 3, 'ops-guard-approved', { type: 'approveDiscount', ticketId, requestId });
  assert.equal(approved.state.tickets[0].discount, 750);
  const events = (await listAudit(db, owner, tenant)).events;
  assert.equal(events.find((event) => event.action === 'discountRequest').actor.id, helper.uid);
  assert.equal(events.find((event) => event.action === 'approveDiscount').actor.id, owner.uid);
});

test('server reversals and reopen are atomic, auditable, and retain the original receipt without leaking names', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'manager');
  await listStores(db, helper);
  await inviteMember(db, owner, tenant, outsider.email, 'staff');
  await listStores(db, outsider);
  const opened = await command(db, owner, tenant, 0, 'ops-reverse-opening', { type: 'open', openingCash: 1000 });
  const seated = await command(db, owner, tenant, 1, 'ops-reverse-seating', {
    type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 2, customer: 'Owner reservation',
  });
  const ticketId = seated.state.tickets[0].id;
  const ordered = await command(db, outsider, tenant, 2, 'ops-reverse-ordering', {
    type: 'order', ticketId, items: [{ menuId: 'castDrink', quantity: 1, castIds: ['cast2'] }, { menuId: 'highball', quantity: 1 }],
  });
  const stockAfterOrder = (await readState(db, owner, tenant, null)).state.stock;
  const total = quote(ordered.state, ticketId).total;
  assert.equal(total, 16_368);
  const settled = await command(db, outsider, tenant, 3, 'ops-reverse-settling', {
    type: 'settle', ticketId, payments: [{ method: 'cash', amount: 10_000 }, { method: 'card', amount: 6368 }],
  });
  assert.equal(summary(settled.state).sales, total);
  const cancel = { type: 'cancelSettlement', ticketId, reason: '支払い方法修正' };
  const cancelled = await command(db, owner, tenant, 4, 'ops-reverse-cancelling', cancel);
  const replay = await command(db, owner, tenant, 4, 'ops-reverse-cancelling', cancel);
  assert.deepEqual(replay, cancelled);
  assert.equal(cancelled.state.cancelledSettlements[0].receipt.settlement.total, total);
  assert.equal(summary(cancelled.state).sales, 0);
  assert.deepEqual(summary(cancelled.state).commission, []);
  assert.equal(summary(cancelled.state).expectedCash, opened.state.day.openingCash);
  assert.deepEqual(cancelled.state.stock, seated.state.stock);
  assert.equal((await readState(db, helper, tenant, null)).state.cancelledSettlements[0].receipt.customer, '');
  assert.equal((await readState(db, outsider, tenant, null)).state.cancelledSettlements, undefined);
  const reopened = await command(db, owner, tenant, 5, 'ops-reverse-reopening', {
    type: 'reopenTicket', ticketId, tableIds: ['a1'], reason: '支払いを再登録',
  });
  assert.equal(reopened.state.tickets[0].status, 'open');
  assert.deepEqual(reopened.state.tickets[0].payments, []);
  assert.deepEqual(reopened.state.stock, stockAfterOrder);
  assert.equal(reopened.state.cancelledSettlements[0].receipt.customer, 'Owner reservation');
  const events = (await listAudit(db, owner, tenant)).events;
  assert.equal(events[0].action, 'reopenTicket');
  assert.equal(events.filter((event) => event.action === 'cancelSettlement').length, 1);
  assert.equal(events.find((event) => event.action === 'cancelSettlement').before.total, total);
});

test('cash records reconcile with AR recoveries once, persist in a closed day, and respect cloud roles', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'manager');
  await inviteMember(db, owner, tenant, outsider.email, 'staff');
  await listStores(db, helper);
  await listStores(db, outsider);
  const opened = await command(db, owner, tenant, 0, 'cash-test-opening01', { type: 'open', openingCash: 10_000 });
  const date = opened.state.day.date;
  const deposit = { type: 'recordCashMovement', kind: 'deposit', amount: 1_500, category: 'float', reason: '釣銭を補充' };
  await assert.rejects(command(db, outsider, tenant, 1, 'cash-test-staff0001', deposit), { code: 'forbidden' });
  await assert.rejects(command(db, helper, tenant, 1, 'cash-test-invalid01', { ...deposit, reason: '  ' }), { code: 'reason-required' });
  const deposited = await command(db, helper, tenant, 1, 'cash-test-deposit01', deposit);
  const repeated = await command(db, helper, tenant, 1, 'cash-test-deposit01', deposit);
  assert.equal(deposited.state.cashMovements.length, 1);
  assert.deepEqual(repeated, deposited);
  await assert.rejects(command(db, owner, tenant, 1, 'cash-test-stale0001', deposit), { code: 'revision-conflict' });

  const expense = { type: 'recordCashMovement', kind: 'expense', amount: 2_000, category: 'purchase', reason: '当日商品の仕入れ', destination: '仕入先' };
  await command(db, owner, tenant, 2, 'cash-test-expense01', expense);
  const customer = await command(db, owner, tenant, 3, 'cash-test-customer1', {
    type: 'saveCustomer', customer: { name: '顧客情報は非共有', creditEnabled: true, creditLimit: 10_000 },
  });
  const { id: customerId } = customer.state.customers[0];
  const visit = await command(db, owner, tenant, 4, 'cash-test-seating01', { type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 1, customerId });
  const { id: ticketId } = visit.state.tickets[0];
  const settled = await command(db, owner, tenant, 5, 'cash-test-settle001', { type: 'settle', ticketId, creditDueDate: date,
    payments: [{ method: 'receivable', amount: 6_600 }] });
  const { id: receivableId } = settled.state.receivables[0];
  await command(db, owner, tenant, 6, 'cash-test-depart001', { type: 'depart', ticketId });
  await command(db, owner, tenant, 7, 'cash-test-recover01', { type: 'recoverReceivable', receivableId, date, method: 'cash', amount: 1_000 });

  const manager = (await readState(db, helper, tenant, null)).state;
  assert.equal(manager.cashMovements[0].actor.id, helper.uid);
  assert.equal(manager.cashMovements[1].actor.id, undefined);
  assert.equal(manager.cashMovements[1].actor.label, owner.email);
  assert.deepEqual(manager.receivables, []);
  assert.equal(manager.recoveryRowsForDay.length, 1);
  assert.deepEqual(Object.keys(manager.recoveryRowsForDay[0]), ['id', 'date', 'at', 'amount', 'method']);
  assert.deepEqual(summary(manager).recoveries, { cash: 1_000, card: 0, bank: 0 });
  assert.equal(summary(manager).expectedCash, 10_500);

  await assert.rejects(command(db, helper, tenant, 8, 'cash-test-counting1', { type: 'close', actualCash: 10_480 }), { code: 'rejected-command' });
  const closed = await command(db, helper, tenant, 8, 'cash-test-counting2', { type: 'close', actualCash: 10_480, reason: 'レジ再集計で現金不足' });
  const report = closed.state.closedDays[0];
  assert.equal(report.expectedCash, 10_500);
  assert.equal(report.actualCash, 10_480);
  assert.equal(report.discrepancy, -20);
  assert.equal(report.sales, 6_600);
  assert.equal(report.cashMovements.length, 2);
  assert.equal(report.recoveryRows[0].amount, 1_000);
  const staff = (await readState(db, outsider, tenant, null)).state;
  assert.equal(staff.cashMovements, undefined);
  assert.equal(staff.recoveryRowsForDay, undefined);
  assert.equal(staff.day.openingCash, 0);
  assert.equal(staff.day.closingCash, null);
  assert.deepEqual(staff.closedDays, []);
  await assert.rejects(command(db, helper, tenant, 9, 'cash-test-nowclosed', expense), { code: 'rejected-command' });

  const [{ after, reason, actor, action }, ...events] = (await listAudit(db, owner, tenant)).events;
  assert.deepEqual({ after, reason, actor, action }, { after: { expectedCash: 10_500, actualCash: 10_480, discrepancy: -20 },
    reason: 'レジ再集計で現金不足', actor: { id: helper.uid, label: helper.email, role: 'manager' }, action: 'close' });
  const records = events.filter(({ action }) => action === 'recordCashMovement');
  assert.equal(records.length, 2);
  assert.equal(records[0].after.category, '仕入れ');
  assert.equal(records[0].after.destination, '仕入先');
  assert.equal(records[1].reason, '釣銭を補充');
});

test('browser cash migration keeps archival movement detail with verified import provenance and removes projected recoveries', async () => {
  const db = database();
  const tenant = await store(db);
  let browser = apply(createDemo('closed'), { type: 'open', openingCash: 10_000 });
  browser = apply(browser, { type: 'recordCashMovement', kind: 'withdrawal', amount: 1_000, category: 'safe', reason: '現金を金庫へ' },
    Date.now(), { id: owner.uid, label: owner.email, role: 'admin' });
  browser = apply(browser, { type: 'close', actualCash: 9_000 });
  browser.recoveryTotalsForDay = { cash: 100_000 };
  browser.recoveryRowsForDay = [{ amount: 100_000, customerId: 'bogus' }];
  browser.cashRecoveryRows = [{ amount: 100_000, customerId: 'bogus' }];
  browser.closedDays[0].recoveryRows = [{ amount: 100_000, customerId: 'bogus' }];
  const invalid = structuredClone(browser);
  invalid.cashMovements[0].category = 'transport';
  await assert.rejects(migrateState(db, owner, tenant, { operationId: 'cash-migrate-invalid', snapshot: invalid }), { code: 'invalid-snapshot' });
  const result = (await migrateState(db, owner, tenant, { operationId: 'cash-migrate-valid01', snapshot: browser })).state;
  assert.equal(result.cashMovements[0].actor.id, 'imported-browser');
  assert.match(result.cashMovements[0].actor.label, /^ブラウザー移行/);
  assert.deepEqual(result.closedDays[0].cashMovements, result.cashMovements);
  assert.deepEqual(result.closedDays[0].recoveryRows, []);
  assert.equal(result.recoveryRowsForDay, undefined);
  assert.equal(result.recoveryTotalsForDay, undefined);
  assert.equal(result.cashRecoveryRows, undefined);
  assert.equal(result.closedDays[0].expectedCash, 9_000);
});

const printing = {
  width: 80, storeName:'印刷テスト店', address:'東京都', phone:'03-1234-5678',
  registrationNumber:'T1234567890123', showItems:false, autoReceipt:true,
};

test('cloud printing enforces settings permissions, shares reissue count and keeps invoice fields scoped', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'manager');
  await inviteMember(db, owner, tenant, outsider.email, 'staff');
  await listStores(db, helper);
  await listStores(db, outsider);

  const settings = {type:'savePrintSettings', settings:printing};
  await assert.rejects(command(db, helper, tenant, 0, 'print-manager-settings', settings), {code:'forbidden'});
  await assert.rejects(command(db, outsider, tenant, 0, 'print-staff-settings01', settings), {code:'forbidden'});
  const configured = await command(db, owner, tenant, 0, 'print-update-settings1', settings);
  assert.deepEqual(configured.state.printSettings, printing);
  const opened = await command(db, owner, tenant, 1, 'print-test-opening01', {type:'open', openingCash:1000});
  const date = opened.state.day.date;
  const seated = await command(db, outsider, tenant, 2, 'print-test-seating01', {
    type:'seat', tableIds:['a1'], guests:1, setId:'set60', customer:'顧客の非公開名',
  });
  const {id:ticketId} = seated.state.tickets.at(-1);
  const issue = (kind, extras = {}) => ({type:'issuePrintDocument', ticketId, date, kind, ...extras});

  await assert.rejects(command(db, outsider, tenant, 3, 'print-before-payment', issue('receipt')), {code:'rejected-command'});
  const check = await command(db, outsider, tenant, 3, 'print-confirmation01', issue('check'));
  assert.equal(check.state.printDocuments.at(-1).number, 1);
  assert.equal(check.state.printDocuments.at(-1).actor.id, outsider.uid);
  const retry = await command(db, outsider, tenant, 3, 'print-confirmation01', issue('check'));
  assert.equal(retry.revision, check.revision);
  assert.equal(retry.state.printDocuments.length, 1);

  const settled = await command(db, outsider, tenant, 4, 'print-test-settle001', {
    type:'settle', ticketId, payments:[{method:'cash', amount:6600}],
  });
  const invoice = await command(db, owner, tenant, 5, 'print-test-invoice01',
    issue('invoice', {recipient:'領収書の非公開名',purpose:'ご飲食代'}));
  assert.equal(invoice.state.printDocuments.at(-1).recipient, '領収書の非公開名');
  for (const user of [helper, outsider]) {
    const state = (await readState(db, user, tenant, null)).state;
    assert.deepEqual(state.printSettings, printing);
    const view = state.printDocuments.at(-1);
    assert.equal(view.number, 1);
    assert.equal(view.actor, undefined);
    assert.equal(view.recipient, undefined);
    assert.equal(view.purpose, undefined);
    assert.equal(state.tickets.at(-1).customer, '');
  }

  await assert.rejects(command(db, outsider, tenant, 6, 'print-protected-details', issue('invoice')),
    {code:'rejected-command'});

  const firstReceipt = await command(db, outsider, tenant, 6, 'print-test-receipt01', issue('receipt'));
  assert.equal(firstReceipt.state.printDocuments.at(-1).number, 1);
  const concurrent = await Promise.allSettled([
    command(db, owner, tenant, 7, 'print-concurrent-one1', issue('receipt')),
    command(db, helper, tenant, 7, 'print-concurrent-two2', issue('receipt')),
  ]);
  assert.equal(concurrent.filter(({status}) => status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(({status}) => status === 'rejected').reason.code, 'revision-conflict');
  await command(db, outsider, tenant, 8, 'print-test-depart001', {type:'depart', ticketId});
  await command(db, helper, tenant, 9, 'print-test-closing01', {type:'close', actualCash:7600});
  const nextDate = new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);
  await command(db, helper, tenant, 10, 'print-next-opening01', {type:'open', date:nextDate, openingCash:1000});
  const staff = (await readState(db, outsider, tenant, null)).state;
  assert.deepEqual(staff.printDocuments, []);
  await assert.rejects(command(db, outsider, tenant, 11, 'print-staff-archive01', issue('receipt')), {code:'rejected-command'});

  const historical = await command(db, helper, tenant, 11, 'print-archive-reissue', issue('receipt'));
  const archiveIssue = historical.state.printDocuments.at(-1);
  assert.equal(archiveIssue.number, 3);
  assert.equal(archiveIssue.date, date);
  assert.equal(archiveIssue.actor.id, helper.uid);
  assert.deepEqual(historical.state.closedDays[0].ticketSnapshots[0].settlement, settled.state.tickets.at(-1).settlement);

  const {events} = await listAudit(db, owner, tenant, {limit:100});
  const issues = events.filter(({action}) => action === 'issuePrintDocument');
  assert.equal(issues.length, 5);
  assert.equal(issues[0].businessDate, date);
  assert.deepEqual(issues[0].after, {kind:'レシート', issueNumber:3});
  assert.equal(issues[0].reason, '再発行');
  assert.equal(issues[0].actor.id, helper.uid);
  assert.equal(JSON.stringify(issues).includes('領収書の非公開名'), false);
  assert.equal(JSON.stringify(issues).includes('ご飲食代'), false);
});

test('browser printing migration validates issuance sequence and replaces local actor identity', async () => {
  const db = database();
  const tenant = await store(db);
  const now = Date.now();
  let sample = createDemo('live', now);
  sample = apply(sample, {type:'savePrintSettings', settings:printing}, now);
  const date = sample.day.date;
  const ticketId = sample.tickets.find(({status}) => status === 'departed').id;
  const issue = {type:'issuePrintDocument', ticketId, date, kind:'invoice', recipient:'ブラウザー宛名', purpose:'ご飲食代'};
  const browserActor = {id:outsider.uid, label:'ブラウザー担当', role:'manager'};
  sample = apply(sample, issue, now, browserActor);
  const invalid = structuredClone(sample);
  invalid.printDocuments[0].number = 2;
  await assert.rejects(migrateState(db, owner, tenant, {operationId:'print-migrate-invalid', snapshot:invalid}),
    {code:'invalid-snapshot'});
  const migrated = await migrateState(db, owner, tenant, {operationId:'print-migrate-browser', snapshot:sample});
  assert.deepEqual(migrated.state.printSettings, printing);
  const record = migrated.state.printDocuments[0];
  assert.equal(record.recipient, 'ブラウザー宛名');
  assert.equal(record.actor.id, 'imported-browser');
  assert.match(record.actor.label, /^ブラウザー移行/);
  await inviteMember(db, owner, tenant, outsider.email, 'staff');
  await listStores(db, outsider);
  const staffView = (await readState(db, outsider, tenant, null)).state.printDocuments[0];
  assert.equal(staffView.number, 1);
  assert.equal(staffView.actor, undefined);
  assert.equal(staffView.recipient, undefined);
});

test('cloud reconciles automatic extensions before a quote can be settled, once across concurrent readers', async (t) => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'staff');
  await listStores(db, helper);

  const minute = 60_000;
  let now = Date.parse('2026-11-16T20:00:00+09:00');
  t.mock.method(Date, 'now', () => now);
  const settings = {type:'saveAutoExtensionSettings',enabled:true,menuId:'extend30'};
  await command(db, owner, tenant, 0, 'auto-opening-test', {type:'open',openingCash:0});
  await assert.rejects(command(db, helper, tenant, 1, 'denied-auto-settings', settings), {code:'forbidden'});
  await command(db, owner, tenant, 1, 'owned-auto-settings', settings);
  const seated = await command(db, helper, tenant, 2, 'seated-auto-on-floor', {
    type:'seat',tableIds:['a1'],setId:'set60',guests:1,
  });
  const [ticket] = seated.state.tickets;
  const baseDue = quote(seated.state,ticket.id).remaining;
  assert.equal(ticket.endsAt,now + 60 * minute);

  now = ticket.endsAt;
  assert.deepEqual(await readState(db, helper, tenant, 3), {unchanged:true,role:'staff',revision:3});
  const [ownerRead, staffRead] = await Promise.all([readState(db, owner, tenant), readState(db, helper, tenant)]);
  for (const view of [ownerRead,staffRead]) {
    assert.equal(view.revision,4);
    assert.equal(view.state.tickets[0].lines.filter((line) => line.autoExtension).length,1);
    assert.equal(view.state.tickets[0].endsAt,ticket.endsAt + 30 * minute);
  }
  const noop = await command(db, helper, tenant, 4, 'noop-auto-reconcile', {type:'syncAutoExtensions'});
  assert.equal(noop.revision,4);

  now = ownerRead.state.tickets[0].endsAt;
  const staleDue = quote(ownerRead.state,ticket.id).remaining;
  assert(staleDue > baseDue);
  const payment = (amount) => ({type:'settle',ticketId:ticket.id,payments:[{method:'cash',amount}]});
  await assert.rejects(command(db, helper, tenant, 4, 'settle-at-auto-boundary', payment(staleDue)),
    {code:'auto-extension-updated', status:409});
  const extended = await readState(db, helper, tenant);
  assert.equal(extended.revision,5);
  assert.equal(extended.state.tickets[0].status,'open');
  assert.equal(extended.state.tickets[0].lines.filter((line)=>line.autoExtension).length,2);
  const paid = await command(db, helper, tenant, 5, 'settle-fresh-auto-quote', payment(quote(extended.state,ticket.id).remaining));
  assert.equal(paid.state.tickets[0].status,'paid');
  const events = (await listAudit(db, owner, tenant)).events;
  assert.equal(events.filter((event)=>event.action==='syncAutoExtensions').length,2);
  assert(events.some((event)=>event.action==='saveAutoExtensionSettings'));
  assert.equal(events.find((event)=>event.action==='syncAutoExtensions').after.tickets[0].orders[0].quantity,1);
});

test('table auto-extension overrides persist and use the authoritative deadline across operators', async (t) => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'staff');
  await inviteMember(db, owner, tenant, outsider.email, 'cast');
  await Promise.all([listStores(db, helper), listStores(db, outsider)]);

  const minute = 60_000;
  let now = Date.parse('2026-11-16T20:00:00+09:00');
  t.mock.method(Date, 'now', () => now);
  const tableSetting = (tableId, enabled) => ({type:'setTableAutoExtension',tableId,enabled});
  await command(db, owner, tenant, 0, 'table-auto-open-day', {type:'open',openingCash:0});
  await command(db, owner, tenant, 1, 'table-auto-store-on',
    {type:'saveAutoExtensionSettings',enabled:true,menuId:'extend30'});
  await assert.rejects(command(db, outsider, tenant, 2, 'table-setting-forbidden', tableSetting('a2',false)),
    {code:'forbidden'});
  await assert.rejects(command(db, helper, tenant, 2, 'table-setting-invalid', tableSetting('a2','false')),
    {code:'invalid-command'});
  await assert.rejects(command(db, helper, tenant, 2, 'table-setting-unknown', tableSetting('missing',false)),
    {code:'rejected-command'});
  const seat = (tableIds) => ({type:'seat',tableIds,setId:'set60',guests:1});
  await command(db, helper, tenant, 2, 'table-auto-linked-seat', seat(['a1','a2']));
  const seated = await command(db, helper, tenant, 3, 'table-auto-single-seat', seat(['a3']));
  const [linked, single] = seated.state.tickets;

  now = linked.endsAt - 1;
  const disable = tableSetting('a2',false);
  const off = await command(db, helper, tenant, 4, 'linked-table-auto-off', disable);
  assert.deepEqual(off.state.tableAutoExtension,{a2:false});
  assert.equal((await command(db, helper, tenant, 4, 'linked-table-auto-off', disable)).revision,5);
  await assert.rejects(command(db, owner, tenant, 4, 'stale-linked-table-on', tableSetting('a2',true)),
    {code:'revision-conflict'});

  now = linked.endsAt;
  const readings = await Promise.all([readState(db, owner, tenant), readState(db, helper, tenant)]);
  for (const view of readings) {
    assert.equal(view.revision,6);
    assert.deepEqual(view.state.tableAutoExtension,{a2:false});
    assert.equal(view.state.tickets.find(({id}) => id === linked.id).endsAt,linked.endsAt);
    assert.equal(view.state.tickets.find(({id}) => id === single.id).lines.filter(({autoExtension}) => autoExtension).length,1);
  }
  now += minute;
  await command(db, owner, tenant, 6, 'single-table-auto-off', tableSetting('a3',false));
  const on = await command(db, helper, tenant, 7, 'linked-table-auto-back-on', tableSetting('a2',true));
  assert.deepEqual(on.state.tableAutoExtension,{a3:false});
  assert.equal(on.state.tickets.find(({id}) => id === linked.id).autoExtensionResumedAt,now);
  const resumedDeadline = now + 30 * minute;
  now = resumedDeadline - 1;
  assert.equal((await readState(db, helper, tenant)).revision,8);

  now = resumedDeadline;
  await assert.rejects(command(db, helper, tenant, 8, 'auto-off-at-exact-deadline',disable),
    {code:'auto-extension-updated',status:409});
  const retry = await command(db, helper, tenant, 9, 'auto-off-after-deadline',disable);
  assert.deepEqual(retry.state.tableAutoExtension,{a3:false,a2:false});
  assert.equal(retry.state.tickets.find(({id}) => id === linked.id).lines.filter(({autoExtension})=>autoExtension).length,1);
  const events = (await listAudit(db, owner, tenant)).events;
  assert.equal(events.filter((event)=>event.action==='syncAutoExtensions').length,2);
  const toggles = events.filter((event)=>event.action==='setTableAutoExtension');
  assert.equal(toggles.length,4);
  assert.deepEqual(toggles[0].target,{kind:'table',id:'a2',label:retry.state.tables.find(({id})=>id==='a2').name});
  assert.deepEqual(toggles[0].before,{enabled:true});
  assert.deepEqual(toggles[0].after,{enabled:false});
  assert.equal(toggles[0].actor.id,helper.uid);
});

test('browser migration validates known table auto-extension overrides and keeps an off table disabled', async () => {
  const db = database();
  const tenant = await store(db);
  const original = createDemo('closed',Date.parse('2026-11-16T20:00:00+09:00'));
  for (const override of [null, [], {a1:true}, {a1:'false'}, {missing:false}, JSON.parse('{"__proto__":false}')]) {
    await assert.rejects(migrateState(db, owner, tenant, {operationId:'bad-table-extension',snapshot:{
      ...original,tableAutoExtension:override,
    }}),{code:'invalid-snapshot'});
  }
  const migrated = await migrateState(db, owner, tenant, {operationId:'valid-table-extension',snapshot:{
    ...original,tableAutoExtension:{a1:false},
  }});
  assert.deepEqual(migrated.state.tableAutoExtension,{a1:false});
});

test('a visit pause and checkout pause synchronize without resetting tables or the next visit', async (t) => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'staff');
  await inviteMember(db, owner, tenant, outsider.email, 'cast');
  await Promise.all([listStores(db, helper), listStores(db, outsider)]);

  let now = Date.parse('2026-11-16T20:00:00+09:00');
  t.mock.method(Date,'now',()=>now);
  const run = (actor, revision, name, value) => command(db, actor, tenant, revision, `visit-pause-${name}`, value);
  const seat = (tableIds) => ({type:'seat',tableIds,setId:'set60',guests:1});
  const pause = (ticketId,source) => ({type:'pauseVisitAutoExtension',ticketId,source});

  await run(owner,0,'opening',{type:'open',openingCash:0});
  await run(owner,1,'store-on',{type:'saveAutoExtensionSettings',enabled:true,menuId:'extend30'});
  await run(owner,2,'table-off',{type:'setTableAutoExtension',tableId:'a4',enabled:false});
  await run(helper,3,'shared-seat',seat(['a1','a2']));
  await run(helper,4,'checkout-seat',seat(['a3']));
  const open = await run(helper,5,'regular-seat',seat(['a5']));
  const [shared, checkout, regular] = open.state.tickets;
  await assert.rejects(run(outsider,6,'cast-denied',pause(shared.id,'manual')),{code:'forbidden'});
  await assert.rejects(run(helper,6,'source-invalid',pause(shared.id,'invalid')),{code:'invalid-command'});
  await assert.rejects(run(helper,6,'ticket-id-invalid',pause('','manual')),{code:'invalid-command'});
  await assert.rejects(run(helper,6,'ticket-unknown',pause('unknown','manual')),{code:'rejected-command'});

  now = shared.endsAt - 1_000;
  const sharedPause = await run(helper,6,'shared-off',pause(shared.id,'manual'));
  assert.equal(sharedPause.state.tickets[0].autoExtensionPausedAt,now);
  assert.equal(sharedPause.state.tickets[0].autoExtensionPauseSource,'manual');
  assert.equal((await run(helper,6,'shared-off',pause(shared.id,'manual'))).revision,7);
  const checkoutPause = await run(owner,7,'checkout-off',pause(checkout.id,'checkout'));
  assert.equal(checkoutPause.state.tickets[1].autoExtensionPausedAt,now);
  assert.equal(checkoutPause.state.tickets[1].autoExtensionPauseSource,'checkout');
  const repeated = await run(owner,8,'shared-repeated',pause(shared.id,'checkout'));
  assert.equal(repeated.state.tickets[0].autoExtensionPauseSource,'manual');

  now = shared.endsAt + 1_000;
  const synced = await Promise.all([readState(db, owner, tenant),readState(db, helper, tenant)]);
  for (const view of synced) {
    assert.equal(view.revision,10);
    assert.deepEqual(view.state.tableAutoExtension,{a4:false});
    assert.equal(view.state.autoExtensionSettings.enabled,true);
    const paused = (id) => view.state.tickets.find((ticket) => ticket.id === id);
    assert.deepEqual(paused(shared.id).tableIds,['a1','a2']);
    assert.equal(paused(shared.id).endsAt,shared.endsAt);
    assert.equal(paused(checkout.id).endsAt,checkout.endsAt);
    assert.equal(paused(regular.id).lines.filter(({autoExtension}) => autoExtension).length,1);
  }

  const payment = (ticket) => ({type:'settle',ticketId:ticket.id,payments:[{method:'cash',amount:quote(open.state,ticket.id).remaining}]});
  await run(helper,10,'checkout-paid',payment(checkout));
  await assert.rejects(run(helper,11,'paid-pause-denied',pause(checkout.id,'manual')),{code:'rejected-command'});
  await run(helper,11,'shared-paid',payment(shared));
  await run(helper,12,'shared-departed',{type:'depart',ticketId:shared.id});
  const next = await run(helper,13,'next-shared-visit',seat(['a1','a2']));
  const nextVisit = next.state.tickets.at(-1);
  assert.equal(nextVisit.autoExtensionPausedAt,undefined);
  assert.equal(nextVisit.autoExtensionPauseSource,undefined);
  now = nextVisit.endsAt;
  const extended = await readState(db, helper, tenant);
  assert.equal(extended.state.tickets.at(-1).lines.filter(({autoExtension}) => autoExtension).length,1);

  const pauses = (await listAudit(db, owner, tenant)).events.filter(({action}) => action === 'pauseVisitAutoExtension');
  assert.equal(pauses.length,2);
  assert.equal(pauses[0].target.id,checkout.id);
  assert.deepEqual(pauses[0].before,{paused:false});
  assert.deepEqual(pauses[0].after,{paused:true,source:'checkout'});
  assert.match(pauses[0].reason,/会計/);
  assert.equal(pauses[0].actor.id,owner.uid);
  assert.equal(pauses[1].target.id,shared.id);
  assert.deepEqual(pauses[1].after,{paused:true,source:'manual'});
  assert.equal(pauses[1].actor.id,helper.uid);
});

test('a pause at the exact deadline retains the already accrued extension', async (t) => {
  const db = database();
  const tenant = await store(db);
  let now = Date.parse('2026-11-16T20:00:00+09:00');
  t.mock.method(Date,'now',()=>now);
  await command(db, owner, tenant, 0, 'boundary-visit-opening', {type:'open',openingCash:0});
  await command(db, owner, tenant, 1, 'boundary-visit-start-auto', {type:'saveAutoExtensionSettings',enabled:true,menuId:'extend30'});
  const opening = await command(db, owner, tenant, 2, 'boundary-visit-seated', {type:'seat',tableIds:['a1'],setId:'set60',guests:1});
  const [ticket] = opening.state.tickets;
  now = ticket.endsAt;
  const pause = {type:'pauseVisitAutoExtension',ticketId:ticket.id,source:'checkout'};
  await assert.rejects(command(db,owner,tenant,3,'boundary-visit-pause-at',pause),{code:'auto-extension-updated',status:409});
  const refreshed = await readState(db, owner, tenant);
  assert.equal(refreshed.revision,4);
  assert.equal(refreshed.state.tickets[0].autoExtensionPausedAt,undefined);
  const extendedAmount = quote(refreshed.state,ticket.id).remaining;
  assert(extendedAmount > quote(opening.state,ticket.id).remaining);
  const paused = await command(db,owner,tenant,4,'boundary-visit-pause-later',pause);
  assert.equal(paused.state.tickets[0].autoExtensionPausedAt,now);

  now = paused.state.tickets[0].endsAt + 1;
  const paid = await command(db,owner,tenant,5,'boundary-visit-paid',{
    type:'settle',ticketId:ticket.id,payments:[{method:'cash',amount:extendedAmount}],
  });
  assert.equal(paid.state.tickets[0].settlement.total,extendedAmount);
  assert.equal(paid.state.tickets[0].lines.filter(({autoExtension})=>autoExtension).length,1);
});

test('browser migration validates a visit pause timestamp and source as a pair', async () => {
  const db = database();
  const tenant = await store(db);
  const now = Date.parse('2026-11-16T20:00:00+09:00');
  const original = createDemo('live',now);
  for (const pause of [
    {autoExtensionPausedAt:now}, {autoExtensionPauseSource:'manual'},
    {autoExtensionPausedAt:'0',autoExtensionPauseSource:'manual'},
    {autoExtensionPausedAt:now,autoExtensionPauseSource:'invalid'},
  ]) {
    const snapshot = structuredClone(original);
    Object.assign(snapshot.tickets[0],pause);
    await assert.rejects(migrateState(db,owner,tenant,{operationId:'invalid-visit-pause',snapshot}),{code:'invalid-snapshot'});
  }
  const snapshot = structuredClone(original);
  Object.assign(snapshot.tickets[0],{autoExtensionPausedAt:now,autoExtensionPauseSource:'manual'});
  const migrated = await migrateState(db,owner,tenant,{operationId:'valid-visit-pause',snapshot});
  assert.equal(migrated.state.tickets[0].autoExtensionPausedAt,now);
  assert.equal(migrated.state.tickets[0].autoExtensionPauseSource,'manual');
});

test('cloud honors card surcharge settings only for owners and freezes exact card receipts', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'staff');
  await listStores(db, helper);
  await command(db, owner, tenant, 0, 'card-opening-test', {type:'open',openingCash:0});
  const settings = {type:'saveCardFeeSettings',settings:{enabled:true,rateBps:1000}};
  await assert.rejects(command(db, helper, tenant, 1, 'card-settings-forbidden', settings), {code:'forbidden'});
  const configured = await command(db, owner, tenant, 1, 'card-settings-allowed', settings);
  assert.deepEqual(configured.state.cardFeeSettings,settings.settings);
  const seated = await command(db, helper, tenant, 2, 'seated-for-card-fee', {
    type:'seat',tableIds:['a1'],setId:'set60',guests:1,
  });
  const action = {type:'settle',ticketId:seated.state.tickets[0].id,payments:[
    {method:'cash',amount:2000},{method:'card',amount:4600},
  ]};
  await assert.rejects(command(db, helper, tenant, 3, 'invalid-card-fee-type', {...action,expectedCardFee:'460'}),
    {code:'invalid-command'});
  await assert.rejects(command(db, helper, tenant, 3, 'incorrect-card-fee-preview', {...action,expectedCardFee:0}),
    {code:'rejected-command'});
  const paid = await command(db, helper, tenant, 3, 'accepted-card-fee-preview', {...action,expectedCardFee:460});
  assert.equal(paid.state.tickets[0].settlement.total,7060);
  assert.equal(paid.state.tickets[0].settlement.cardFee,460);
  assert.equal(paid.state.tickets[0].payments.find(({method}) => method === 'card').amount,5060);
  assert.equal(paid.state.floorMonthSales,7060);
  const full = await readState(db, owner, tenant);
  assert.equal(summary(full.state).payments.cash,2000);
  assert.equal(summary(full.state).payments.card,5060);
  const events = (await listAudit(db, owner, tenant)).events;
  assert.equal(events.find((event)=>event.action==='settle').after.cardFee,460);
  assert(events.some((event)=>event.action==='saveCardFeeSettings'));

  const migratedTenant = await store(db);
  const invalid = structuredClone(full.state);
  invalid.tickets[0].settlement.cardFee = 500;
  await assert.rejects(migrateState(db, owner, migratedTenant, {operationId:'invalid-fee-migration',snapshot:invalid}),
    {code:'invalid-snapshot'});
  const migrated = await migrateState(db, owner, migratedTenant, {operationId:'correct-fee-migration',snapshot:full.state});
  assert.equal(migrated.state.tickets[0].settlement.cardFee,460);
});
