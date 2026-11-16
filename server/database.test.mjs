import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDemo } from '../docs/engine.mjs';
import worker from './index.mjs';
import {
  applyCommand, changeMember, createStore, inviteMember, listMembers, listStores, migrateState, readState, revokeInvite,
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
  assert.deepEqual(applied.state, original);
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
});
