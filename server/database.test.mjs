import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDemo, quote, summary } from '../docs/engine.mjs';
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
