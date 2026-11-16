import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { getTeamPerformance } from '../docs/team-performance.mjs';
import worker from './index.mjs';
import {
  applyCommand, changeMember, createStore, getStoreOverview, inviteMember, listAudit, listMembers, listStores, migrateState, readState, revokeInvite,
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
  assert.deepEqual(payload, { state: null, restricted: true, scope:'cast', role: 'cast', revision: 0 });
  await changeMember(db, owner, tenant, helper.uid);
  await assert.rejects(readState(db, helper, tenant, null), { code: 'store-access' });
  assert.equal((await listStores(db,owner)).stores[0].hasState,false);
  const removed = await inviteMember(db, owner, tenant, outsider.email, 'manager');
  await revokeInvite(db, owner, tenant, removed.invite.id);
  assert.equal((await listStores(db, outsider)).stores.length, 0);
});

test('cast identity is linked by the store administrator and projected only for its authenticated owner', async (t) => {
  const db = database();
  const tenant = await store(db);
  const alice = {uid:'cast-alice',email:'alice@example.test'};
  const bob = {uid:'cast-bob',email:'bob@example.test'};
  for (const [person,role] of [[alice,'cast'],[bob,'cast'],[helper,'manager'],[outsider,'staff']]) {
    await inviteMember(db,owner,tenant,person.email,role);
    await listStores(db,person);
  }
  let now = Date.parse('2026-11-16T21:00:00+09:00');
  t.mock.method(Date,'now',() => now);
  const date = '2026-11-16';
  const read = (actor,revision = null) => readState(db,actor,tenant,revision);
  const run = (actor,revision,name,action) => command(db,actor,tenant,revision,`cast-scope-test-${name}`,action);
  const bind = (memberUid,castId) => ({type:'bindCastAccount',memberUid,castId});
  await assert.rejects(run(owner,0,'uninitialized',bind(alice.uid,'cast1')),{code:'store-not-initialized'});
  const source = createDemo('live',now);
  source.castAccounts = [{uid:alice.uid,castId:'cast2'}];
  const initialized = await migrateState(db,owner,tenant,{operationId:'cast-identity-import-01',snapshot:source});
  assert.equal(initialized.state.castAccounts,undefined);
  assert.deepEqual(await read(alice),{role:'cast',scope:'cast',revision:1,state:null,restricted:true});
  await assert.rejects(run(helper,1,'privileged',bind(alice.uid,'cast1')),{code:'forbidden'});
  await assert.rejects(run(owner,1,'manager-member',bind(helper.uid,'cast1')),{code:'invalid-cast-member'});
  await assert.rejects(run(owner,1,'external-member',bind('unaffiliated','cast1')),{code:'invalid-cast-member'});
  await run(owner,1,'bind-alice',bind(alice.uid,'cast1'));
  await assert.rejects(run(owner,2,'already-linked',bind(bob.uid,'cast1')),{code:'rejected-command'});
  await run(owner,2,'bind-bob',bind(bob.uid,'cast2'));
  const aliceRead = await read(alice,3);
  assert.equal(aliceRead.scope,'cast');
  assert.equal(aliceRead.revision,3);
  assert.equal(aliceRead.state.cast.id,'cast1');
  assert.equal((await read(bob)).state.cast.id,'cast2');
  for (const field of ['tables','tickets','customers','stock','auditLog','closedDays','castAccounts','cashMovements']) {
    assert.equal(aliceRead.state[field],undefined);
  }
  assert.equal((await read(helper)).state.castAccounts,undefined);
  assert.equal((await read(outsider)).state.castAccounts,undefined);
  await assert.rejects(listAudit(db,alice,tenant),{code:'forbidden'});
  await assert.rejects(listMembers(db,alice,tenant),{code:'forbidden'});
  await assert.rejects(run(alice,3,'forged-id',{type:'castClockIn',castId:'cast2'}),{code:'invalid-command'});
  await assert.rejects(run(alice,3,'operating-denied',{type:'open',openingCash:0}),{code:'forbidden'});

  const shift = await run(alice,3,'request-shift',{type:'castRequestShift',date,startMinute:1200,endMinute:1500,note:'本人の勤務希望'});
  assert.equal(shift.state.shifts[0].note,'本人の勤務希望');
  assert.deepEqual((await read(bob)).state.shifts,[]);
  assert.equal((await read(helper)).state.shifts[0].castId,'cast1');
  await assert.rejects(run(alice,3,'stale-punch',{type:'castClockIn'}),{code:'revision-conflict'});
  const punchedIn = await run(alice,4,'punch-in',{type:'castClockIn'});
  assert.equal(punchedIn.state.openClock.castId,'cast1');
  const clockInAt = punchedIn.state.openClock.clockInAt;
  assert.equal(clockInAt,now);
  assert.deepEqual((await read(bob)).state.attendances,[]);
  now += 90 * 60_000;
  const punchedOut = await run(alice,5,'punch-out',{type:'castClockOut'});
  const [attendance] = punchedOut.state.attendances;
  assert.equal(attendance.minutes,90);
  assert.equal(attendance.status,'pending');
  const review = {type:'reviewCastAttendance',attendanceId:attendance.id,decision:'approve'};
  await assert.rejects(run(outsider,6,'review-denied',review),{code:'forbidden'});
  const reviewed = await run(helper,6,'review-approved',review);
  assert.equal(reviewed.state.castAttendance[0].status,'approved');
  assert.equal((await read(outsider)).state.castAttendance,undefined);
  assert.equal((await read(alice)).state.attendances[0].status,'approved');
  assert.deepEqual((await read(owner)).state.attendances,[{castId:'cast1',date,minutes:90,status:'approved'}]);
  const rated = await run(owner,7,'own-rate',{type:'savePayrollRate',effectiveDate:date,hourlyRate:3500,castId:'cast1'});
  assert.equal(rated.revision,8);
  const dailyPay = await run(alice,8,'daily-pay',{type:'castRequestDailyPay',month:'2026-11',amount:1000,reason:'本人の日払い申請'});
  assert.equal(dailyPay.state.payroll.draft.hourlyPay,5250);
  assert.equal(dailyPay.state.dailyPays[0].amount,1000);
  assert.deepEqual((await read(bob)).state.dailyPays,[]);
  assert.ok((await listAudit(db,owner,tenant)).events.some(({actor}) => actor.id === alice.uid));
});

test('changing or revoking cast membership atomically invalidates links and old workspace revisions', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db,owner,tenant,helper.email,'cast');
  await listStores(db,helper);
  const read = (actor) => readState(db,actor,tenant,null);
  const run = (actor,revision,name,action) => command(db,actor,tenant,revision,`cast-revoke-test-${name}`,action);
  await run(owner,0,'initialize',{type:'open',openingCash:0});
  const bind = {type:'bindCastAccount',memberUid:helper.uid,castId:'cast1'};
  await run(owner,1,'bind-cast',bind);
  await changeMember(db,owner,tenant,helper.uid,'staff');
  assert.equal((await read(owner)).revision,3);
  assert.deepEqual((await read(owner)).state.castAccounts,[]);
  assert.equal((await read(helper)).role,'staff');
  await changeMember(db,owner,tenant,helper.uid,'cast');
  assert.deepEqual(await read(helper),{state:null,scope:'cast',role:'cast',revision:3,restricted:true});
  await assert.rejects(run(owner,2,'stale-bind',bind),{code:'revision-conflict'});
  await run(owner,3,'bind-renewed',bind);
  await changeMember(db,owner,tenant,helper.uid);
  assert.equal((await read(owner)).revision,5);
  assert.deepEqual((await read(owner)).state.castAccounts,[]);
  await assert.rejects(read(helper),{code:'store-access'});
  await inviteMember(db,owner,tenant,helper.email,'cast');
  await listStores(db,helper);
  assert.deepEqual(await read(helper),{state:null,scope:'cast',role:'cast',revision:5,restricted:true});
  assert.equal((await listAudit(db,owner,tenant)).events.filter(({reason}) => /所属・権限変更/.test(reason)).length,2);
});

test('multi-store overview returns only administrator aggregates and caps the initial list', async (t) => {
  const db = database();
  const now = Date.parse('2026-11-16T21:00:00+09:00');
  t.mock.method(Date,'now',() => now);
  const date = '2026-11-16';
  const main = (await createStore(db,owner,'本店')).store.id;
  const invited = (await createStore(db,helper,'管理を委任された店舗')).store.id;
  const managerOnly = (await createStore(db,outsider,'マネージャーのみの店舗')).store.id;
  await inviteMember(db,helper,invited,owner.email,'admin');
  await listStores(db,owner);
  await inviteMember(db,outsider,managerOnly,owner.email,'manager');
  await inviteMember(db,owner,main,outsider.email,'manager');
  await listStores(db,owner);
  await listStores(db,outsider);
  const live = createDemo('live',now);
  await migrateState(db,owner,main,{operationId:'overview-migrate-12345',snapshot:live});
  const overview = await getStoreOverview(db,owner);
  assert.equal(overview.stores.length,2);
  assert.deepEqual(overview.stores.find(({id}) => id === main),{id:main,name:'本店',date,status:'open',
    dailySales:summary(live).sales,monthlySales:summary(live).sales,hasState:true});
  assert.deepEqual(overview.stores.find(({id}) => id === invited),{id:invited,name:'管理を委任された店舗',date,status:'closed',
    dailySales:0,monthlySales:0,hasState:false});
  assert.deepEqual((await getStoreOverview(db,outsider)).stores.map(({id}) => id),[managerOnly]);
  await changeMember(db,helper,invited,owner.uid,'staff');
  assert.deepEqual((await getStoreOverview(db,owner)).stores.map(({id}) => id),[main]);
  for (let index = 0; index < 20; index++) await createStore(db,owner,`店舗 ${index + 1}`);
  const limited = await getStoreOverview(db,owner);
  assert.equal(limited.stores.length,20);
  assert.equal(limited.truncated,true);
  const unauthorized = await worker.fetch(new Request('https://api.test/api/stores/overview'),{FIREBASE_PROJECT_ID:'test-project',DB:db});
  assert.equal(unauthorized.status,401);
  assert.equal((await unauthorized.json()).error.code,'unauthenticated');
});

test('calculation settings are admin-only and migration rejects invalid ticket settings', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db,owner,tenant,helper.email,'manager');
  await listStores(db,helper);
  const settings = {serviceRateBps:1200,serviceRounding:'ceil',taxRounding:'round',serviceBase:'beforeDiscount',priceMode:'inclusive'};
  const save = {type:'saveCalculationSettings',settings};
  const run = (actor,revision,name,action) => command(db,actor,tenant,revision,`calculation-policy-${name}`,action);
  await assert.rejects(run(helper,0,'manager-denied',save),{code:'forbidden'});
  await assert.rejects(run(owner,0,'wrong-mode',{...save,settings:{...settings,priceMode:'unknown'}}),{code:'invalid-command'});
  const saved = await run(owner,0,'saved-admin',save);
  assert.deepEqual(saved.state.calculationSettings,settings);

  const importTenant = await store(db);
  const badSnapshot = createDemo('live');
  badSnapshot.tickets[0].calculationSettings = {...settings,taxRounding:'invalid'};
  await assert.rejects(migrateState(db,owner,importTenant,{operationId:'invalid-settings-import-01',snapshot:badSnapshot}),{code:'invalid-snapshot'});
  assert.equal((await readState(db,owner,importTenant,null)).revision,0);
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
  const expected = structuredClone(original);
  delete expected.auditLog;
  for (const ticket of expected.tickets) delete ticket.settledBy;
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

test('cloud resumes a paused visit without billing any elapsed stopped intervals', async (t) => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'staff');
  await inviteMember(db, owner, tenant, outsider.email, 'cast');
  await Promise.all([listStores(db, helper), listStores(db, outsider)]);

  const minute = 60_000;
  let now = Date.parse('2026-11-16T20:00:00+09:00');
  t.mock.method(Date, 'now', () => now);
  const run = (actor, revision, name, value) => command(db, actor, tenant, revision, `visit-resume-${name}`, value);

  await run(owner, 0, 'opening', {type:'open',openingCash:0});
  await run(owner, 1, 'store-on', {type:'saveAutoExtensionSettings',enabled:true,menuId:'extend30'});
  await run(owner, 2, 'other-table-off', {type:'setTableAutoExtension',tableId:'a3',enabled:false});
  const seated = await run(helper, 3, 'shared-seat', {type:'seat',tableIds:['a1','a2'],setId:'set60',guests:1});
  const [ticket] = seated.state.tickets;
  const resume = {type:'resumeVisitAutoExtension',ticketId:ticket.id};
  await assert.rejects(run(outsider, 4, 'cast-denied', resume), {code:'forbidden'});
  await assert.rejects(run(helper, 4, 'invalid-ticket', {...resume,ticketId:''}), {code:'invalid-command'});
  await assert.rejects(run(helper, 4, 'missing-ticket', {...resume,ticketId:'unknown'}), {code:'rejected-command'});

  now = ticket.endsAt;
  const extended = await readState(db, owner, tenant);
  assert.equal(extended.revision, 5);
  assert.equal(extended.state.tickets[0].lines.filter(({autoExtension})=>autoExtension).length, 1);
  const accrued = quote(extended.state, ticket.id).remaining;
  await run(helper, 5, 'checkout-pause', {type:'pauseVisitAutoExtension',ticketId:ticket.id,source:'checkout'});

  now += 120 * minute;
  const resumedAt = now;
  assert.equal((await readState(db, owner, tenant)).revision, 6);
  await assert.rejects(run(helper, 5, 'stale', resume), {code:'revision-conflict'});
  const resumed = await run(helper, 6, 'after-pause', resume);
  assert.equal(resumed.revision, 7);
  assert.equal(resumed.state.tickets[0].autoExtensionPausedAt, undefined);
  assert.equal(resumed.state.tickets[0].autoExtensionPauseSource, undefined);
  assert.equal(resumed.state.tickets[0].autoExtensionResumedAt, resumedAt);
  assert.equal(quote(resumed.state, ticket.id).remaining, accrued);
  assert.deepEqual(resumed.state.tableAutoExtension, {a3:false});
  assert.equal(resumed.state.autoExtensionSettings.enabled, true);

  now += 10 * minute;
  const replayed = await run(helper, 6, 'after-pause', resume);
  assert.equal(replayed.revision, 7);
  const repeated = await run(owner, 7, 'repeated', resume);
  assert.equal(repeated.state.tickets[0].autoExtensionResumedAt, resumedAt);
  now = resumedAt + 30 * minute - 1;
  assert.equal((await readState(db, owner, tenant)).revision, 8);
  assert.equal(quote(repeated.state, ticket.id).remaining, accrued);
  now++;
  const views = await Promise.all([readState(db, owner, tenant), readState(db, helper, tenant)]);
  for (const view of views) {
    assert.equal(view.revision, 9);
    assert.equal(view.state.tickets[0].lines.filter(({autoExtension})=>autoExtension).length, 2);
    assert.equal(quote(view.state, ticket.id).remaining - accrued, accrued - quote(seated.state, ticket.id).remaining);
  }

  const resumes = (await listAudit(db, owner, tenant)).events.filter(({action}) => action === 'resumeVisitAutoExtension');
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].target.id, ticket.id);
  assert.equal(resumes[0].actor.id, helper.uid);
  assert.deepEqual(resumes[0].before, {paused:true,source:'checkout'});
  assert.deepEqual(resumes[0].after, {paused:false});
});

test('cloud blocks inline customer registration while retaining existing-customer seating', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'staff');
  await listStores(db, helper);
  await command(db, owner, tenant, 0, 'customer-entry-opening', {type:'open',openingCash:0});
  const registered = await command(db, owner, tenant, 1, 'register-from-customers', {
    type:'saveCustomer',customer:{name:'登録済みテスト顧客'},
  });
  const [customer] = registered.state.customers;
  const seat = {type:'seat',tableIds:['a1'],setId:'set60',guests:1};
  for (const [actor, key] of [[owner, 'owner'], [helper, 'staff']]) {
    await assert.rejects(command(db, actor, tenant, 2, `inline-registration-${key}`,
      {...seat,newCustomer:{name:'来店からの登録'}}), {code:'invalid-command'});
  }
  const seated = await command(db, helper, tenant, 2, 'seat-registered-customer', {...seat,customerId:customer.id});
  assert.equal(seated.revision, 3);
  const current = (await readState(db, owner, tenant)).state;
  assert.equal(current.tickets[0].customerId, customer.id);
  assert.equal(current.tickets[0].customer, customer.name);
  assert.equal(current.customers.length, 1);
  const registrations = (await listAudit(db, owner, tenant)).events.filter(({action})=>action === 'saveCustomer');
  assert.equal(registrations.length, 1);
});

test('operators update an unpaid ticket customer across devices without widening CRM access', async () => {
  const db = database();
  const tenant = await store(db);
  const cast = { uid: 'cast-1', email: 'cast@example.test' };
  for (const [person, role] of [[helper, 'manager'], [outsider, 'staff'], [cast, 'cast']]) {
    await inviteMember(db, owner, tenant, person.email, role);
    await listStores(db, person);
  }
  const run = (actor, revision, suffix, action) => command(db, actor, tenant, revision, `ticket-customer-${suffix}`, action);

  await run(owner, 0, 'opening', { type: 'open', openingCash: 0 });
  await run(owner, 1, 'first-customer', { type: 'saveCustomer', customer: { name: 'テスト顧客 A', phone: '09011112222' } });
  const registered = await run(owner, 2, 'second-customer', { type: 'saveCustomer', customer: { name: 'テスト顧客 B', memo: '非公開メモ' } });
  const [first, second] = registered.state.customers;
  const publicLink = ({ id, name }) => ({ id, name });
  const seated = await run(owner, 3, 'seating', { type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 1 });
  const { id: ticketId } = seated.state.tickets[0];
  const link = { type: 'setTicketCustomer', ticketId, customerId: first.id };
  await assert.rejects(run(cast, 4, 'cast-denied', link), { code: 'forbidden' });
  await assert.rejects(run(outsider, 4, 'missing-selection', { type: link.type, ticketId }), { code: 'invalid-command' });
  await assert.rejects(run(outsider, 4, 'missing-customer', { ...link, customerId: 'does-not-exist' }), { code: 'rejected-command' });
  await assert.rejects(run(outsider, 3, 'stale-selection', link), { code: 'revision-conflict' });

  const linked = await run(outsider, 4, 'linked', link);
  assert.equal(linked.revision, 5);
  assert.deepEqual(await run(outsider, 4, 'linked', link), linked);
  const managerView = (await readState(db, helper, tenant)).state;
  for (const view of [linked.state, managerView]) {
    const [ticket] = view.tickets;
    assert.deepEqual(ticket.activeCustomerLink, publicLink(first));
    assert.equal(ticket.customerId, undefined);
    assert.equal(ticket.customer, '');
    assert.equal(view.customers[0].phone, undefined);
    assert.equal(view.customers[1].memo, undefined);
  }
  const relink = { ...link, customerId: second.id };
  const changed = await run(helper, 5, 'changed', relink);
  assert.deepEqual(changed.state.tickets[0].activeCustomerLink, publicLink(second));
  const identical = await run(owner, 6, 'same-customer', relink);
  assert.equal(identical.state.tickets[0].customerId, second.id);
  const cleared = await run(outsider, 7, 'cleared', { ...link, customerId: null });
  assert.equal(cleared.state.tickets[0].activeCustomerLink, undefined);
  const guest = await readState(db, owner, tenant);
  assert.equal(guest.state.tickets[0].customerId, undefined);
  assert.equal(guest.state.tickets[0].customer, '');
  assert.equal(quote(guest.state, ticketId).total, quote(seated.state, ticketId).total);
  assert.deepEqual(guest.state.customers, registered.state.customers);

  const finalLink = await run(owner, 8, 'chosen-before-payment', relink);
  assert.equal(finalLink.state.tickets[0].activeCustomerLink, undefined);
  const remaining = quote(finalLink.state, ticketId).remaining;
  await run(outsider, 9, 'paid', { type: 'settle', ticketId, payments: [{ method: 'cash', amount: remaining }] });
  for (const person of [helper, outsider]) {
    const [ticket] = (await readState(db, person, tenant)).state.tickets;
    assert.equal(ticket.activeCustomerLink, undefined);
    assert.equal(ticket.customerId, undefined);
  }
  await assert.rejects(run(owner, 10, 'paid-protected', link), { code: 'rejected-command' });
  await run(outsider, 10, 'departed', { type: 'depart', ticketId });
  const closed = await run(owner, 11, 'closed', { type: 'close', actualCash: remaining });
  assert.equal(closed.state.closedDays[0].ticketSnapshots[0].customerId, second.id);
  assert.equal((await readState(db, helper, tenant)).state.closedDays[0].ticketSnapshots[0].activeCustomerLink, undefined);
  await assert.rejects(run(owner, 12, 'closed-protected', link), { code: 'rejected-command' });
  await assert.rejects(listAudit(db, outsider, tenant), { code: 'forbidden' });
  const edits = (await listAudit(db, owner, tenant)).events.filter(({ action }) => action === link.type).reverse();
  assert.deepEqual(edits.map(({ actor, target, before, after }) => [actor.id, target.id, before.customerId, after.customerId]), [
    [outsider.uid, ticketId, null, first.id], [helper.uid, ticketId, first.id, second.id],
    [outsider.uid, ticketId, second.id, null], [owner.uid, ticketId, null, second.id],
  ]);
  assert.equal(edits[1].before.customerName, first.name);
  assert.equal(edits[1].after.customerName, second.name);
});

test('settled ticket customer correction requires an admin and reason and audits the original business day', async (t) => {
  const db = database();
  const tenant = await store(db);
  for (const [person, role] of [[helper, 'manager'], [outsider, 'staff']]) {
    await inviteMember(db, owner, tenant, person.email, role);
    await listStores(db, person);
  }
  const businessDay = '2026-11-16';
  let now = Date.parse(`${businessDay}T20:00:00+09:00`);
  t.mock.method(Date, 'now', () => now);
  const run = (actor, revision, suffix, action) => command(db, actor, tenant, revision, `settled-customer-${suffix}`, action);

  await run(owner, 0, 'open', { type: 'open', date: businessDay, openingCash: 0 });
  const registered = await run(owner, 1, 'profile', { type: 'saveCustomer', customer: { name: '訂正先の顧客' } });
  const [{ id: customerId, name }] = registered.state.customers;
  const seated = await run(outsider, 2, 'seat', { type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 1 });
  const [{ id: ticketId }] = seated.state.tickets;
  const update = { type: 'correctSettledTicketCustomer', ticketId, customerId, reason: '  来店履歴を照合  ' };
  await assert.rejects(run(owner, 3, 'unpaid-rejected', update), { code: 'rejected-command' });
  const amount = quote(seated.state, ticketId).remaining;
  const paid = await run(owner, 3, 'settle', { type: 'settle', ticketId, payments: [{ method: 'cash', amount }] });
  for (const actor of [helper, outsider]) {
    await assert.rejects(run(actor, 4, 'role-denied', update), { code: 'forbidden' });
  }
  await assert.rejects(run(owner, 4, 'blank-reason', { ...update, reason: '  ' }), { code: 'reason-required' });
  await assert.rejects(run(owner, 4, 'no-selection', { ...update, customerId: undefined }), { code: 'invalid-command' });
  await assert.rejects(run(owner, 3, 'stale', update), { code: 'revision-conflict' });
  const attached = await run(owner, 4, 'attach', update);
  assert.deepEqual(await run(owner, 4, 'attach', update), attached);
  assert.deepEqual(attached.state.tickets[0], { ...paid.state.tickets[0], customerId, customer: name });
  assert.deepEqual(summary(attached.state), summary(paid.state));
  await run(owner, 5, 'same-again', update);
  await run(outsider, 6, 'depart', { type: 'depart', ticketId });
  await run(owner, 7, 'close', { type: 'close', actualCash: amount });

  const detached = await run(owner, 8, 'detach', { ...update, customerId: null, reason: '顧客登録を再確認' });
  for (const ticket of [detached.state.tickets[0], detached.state.closedDays[0].ticketSnapshots[0]]) {
    assert.equal(ticket.customerId, undefined);
    assert.equal(ticket.customer, '');
  }
  now = Date.parse('2026-11-17T20:00:00+09:00');
  await run(owner, 9, 'new-business-day', { type: 'open', date: '2026-11-17', openingCash: 0 });
  await assert.rejects(run(owner, 10, 'reason-bypass', { type: 'linkCustomer', ticketId, customerId }), { code: 'rejected-command' });
  const archived = await run(owner, 10, 'correct-archived', update);
  assert.equal(archived.state.tickets.length, 0);
  assert.equal(archived.state.closedDays[0].ticketSnapshots[0].customerId, customerId);
  assert.equal(archived.state.closedDays[0].sales, amount);
  assert.equal((await readState(db, helper, tenant)).state.closedDays[0].ticketSnapshots[0].customerId, undefined);

  const audits = (await listAudit(db, owner, tenant)).events.filter(({ action }) => action === update.type);
  assert.equal(audits.length, 3);
  assert.equal(audits[0].businessDate, businessDay);
  assert.equal(audits[0].at, now);
  assert.equal(audits[0].reason, '来店履歴を照合');
  assert.equal(audits[0].actor.id, owner.uid);
  assert.equal(audits[0].target.id, ticketId);
  assert.deepEqual(audits[0].before, { customerId: null, customerName: null });
  assert.deepEqual(audits[0].after, { customerId, customerName: name });
  await assert.rejects(listAudit(db, helper, tenant), { code: 'forbidden' });
});

test('settled ticket correction keeps receivable collections and reports intact when ownership changes', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'manager');
  await listStores(db, helper);
  const date = '2026-11-16';
  const run = (actor, revision, suffix, action) => command(db, actor, tenant, revision, `settled-credit-${suffix}`, action);
  await run(owner, 0, 'open', { type: 'open', date, openingCash: 0 });
  const registered = await run(owner, 1, 'source', { type: 'saveCustomer', customer: { name: '訂正元', creditEnabled: true, creditLimit: 10_000 } });
  const [{ id: sourceId }] = registered.state.customers;
  const added = await run(helper, 2, 'target', { type: 'saveCustomer', customer: { name: '訂正先' } });
  const [, { id: customerId, name: customer }] = added.state.customers;
  const seated = await run(owner, 3, 'seat', { type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 1, customerId: sourceId });
  const [{ id: ticketId }] = seated.state.tickets;
  const amount = quote(seated.state, ticketId).remaining;
  const paid = await run(owner, 4, 'settle', { type: 'settle', ticketId, creditDueDate: date, payments: [{ method: 'receivable', amount }] });
  const [{ id: receivableId }] = paid.state.receivables;
  await run(owner, 5, 'collect', { type: 'recoverReceivable', receivableId, method: 'cash', date, amount: 1_000 });
  await run(owner, 6, 'depart', { type: 'depart', ticketId });
  await run(owner, 7, 'close', { type: 'close', actualCash: 1_000 });
  const before = await run(owner, 8, 'next-day', { type: 'open', date: '2026-11-17', openingCash: 0 });
  const correction = { type: 'correctSettledTicketCustomer', ticketId, customerId, reason: '売掛の名義訂正' };
  await assert.rejects(run(owner, 9, 'unlinked-credit', { ...correction, customerId: null }), { code: 'rejected-command' });
  assert.deepEqual(await readState(db, owner, tenant), before);
  assert.deepEqual((await readState(db, helper, tenant)).state.receivables, []);
  const corrected = await run(owner, 9, 'correct-credit', correction);
  const [entry] = corrected.state.receivables;
  assert.deepEqual(entry, { ...before.state.receivables[0], customerId });
  const [earlier] = before.state.closedDays;
  assert.deepEqual(corrected.state.closedDays[0], { ...earlier,
    ticketSnapshots: [{ ...earlier.ticketSnapshots[0], customerId, customer }] });
  assert.deepEqual((await readState(db, helper, tenant)).state.receivables, [entry]);

  const [audit] = (await listAudit(db, owner, tenant)).events;
  assert.equal(audit.action, correction.type);
  assert.deepEqual(audit.before.receivable, { id: receivableId, customerId: sourceId, balance: amount - 1_000 });
  assert.deepEqual(audit.after.receivable, { id: receivableId, customerId, balance: amount - 1_000 });
  const migratedTenant = await store(db);
  const migrated = await migrateState(db, owner, migratedTenant, {
    operationId: 'migrate-corrected-receivable', snapshot: corrected.state,
  });
  assert.deepEqual(migrated.state.receivables, [entry]);
});

test('only an admin can correct settled tenders, preserving the gross amount and updating the archived till', async (t) => {
  const db = database();
  const tenant = await store(db);
  for (const [person, role] of [[helper, 'manager'], [outsider, 'staff']]) {
    await inviteMember(db, owner, tenant, person.email, role);
    await listStores(db, person);
  }
  const date = '2026-11-16';
  let now = Date.parse(`${date}T20:00:00+09:00`);
  t.mock.method(Date, 'now', () => now);
  const run = (actor, revision, suffix, action) => command(db, actor, tenant, revision, `payments-correction-${suffix}`, action);
  await run(owner, 0, 'fee', { type: 'saveCardFeeSettings', settings: { enabled: true, rateBps: 1_000 } });
  await run(owner, 1, 'open', { type: 'open', date, openingCash: 500 });
  const seated = await run(outsider, 2, 'seat', { type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 1 });
  const [{ id: ticketId }] = seated.state.tickets;
  const correction = { type: 'correctSettledTicketPayments', ticketId, reason: '  端末の控えを照合  ',
    payments: [{ method: 'cash', amount: 3_700 }, { method: 'qr', amount: 2_900 }] };
  await assert.rejects(run(owner, 3, 'unpaid', correction), { code: 'rejected-command' });
  await run(outsider, 3, 'deposit', { type: 'deposit', ticketId, method: 'cash', amount: 600 });
  const settled = await run(outsider, 4, 'settle-card', { type: 'settle', ticketId,
    payments: [{ method: 'card', amount: 6_000 }], expectedCardFee: 600 });
  const [paid] = settled.state.tickets;
  assert.equal(paid.settlement.total, 7_200);
  for (const actor of [helper, outsider]) {
    await assert.rejects(run(actor, 5, 'denied', correction), { code: 'forbidden' });
  }
  await assert.rejects(run(owner, 5, 'missing-reason', { ...correction, reason: '  ' }), { code: 'reason-required' });
  for (const [name, changes] of [
    ['unrecognized-method', { payments: [{ method: 'wire', amount: 6_600 }] }],
    ['noninteger-amount', { payments: [{ method: 'cash', amount: 6_600.5 }] }],
    ['invalid-credit-date', { creditDueDate: '2026-02-30' }],
  ]) {
    await assert.rejects(run(owner, 5, name, { ...correction, ...changes }), { code: 'invalid-command' });
  }
  await assert.rejects(run(owner, 5, 'changed-total', {
    ...correction, payments: [{ method: 'cash', amount: 6_000 }],
  }), { code: 'rejected-command' });
  await run(owner, 5, 'receipt', { type: 'issuePrintDocument', ticketId, date, kind: 'receipt' });
  await run(outsider, 6, 'depart', { type: 'depart', ticketId });
  await run(owner, 7, 'close', { type: 'close', actualCash: 1_100 });
  now = Date.parse('2026-11-17T20:00:00+09:00');
  const before = await run(owner, 8, 'next-day', { type: 'open', date: '2026-11-17', openingCash: 250 });
  const [previous] = before.state.closedDays;
  assert.equal(previous.expectedCash, 1_100);
  await assert.rejects(run(owner, 8, 'stale', correction), { code: 'revision-conflict' });
  const corrected = await run(owner, 9, 'archived', correction);
  assert.deepEqual(await run(owner, 9, 'archived', correction), corrected);
  assert.deepEqual(summary(corrected.state), summary(before.state));
  assert.deepEqual(corrected.state.stock, before.state.stock);
  const [report] = corrected.state.closedDays;
  assert.deepEqual(report.payments, { cash: 4_300, card: 0, qr: 2_900 });
  assert.deepEqual(report.tenderPayments, { cash: 3_700, card: 0, qr: 2_900 });
  assert.equal(report.actualCash, previous.actualCash);
  assert.equal(report.expectedCash, 4_800);
  assert.equal(report.discrepancy, -3_700);
  assert.equal(report.sales, previous.sales);
  assert.deepEqual(report.commission, previous.commission);
  const [receipt] = report.ticketSnapshots;
  assert.equal(receipt.paymentsCorrectedAt, now);
  assert.deepEqual(receipt.settlement, paid.settlement);
  assert.equal(receipt.settlementRevision, paid.settlementRevision);
  assert.deepEqual(receipt.deposits, paid.deposits);
  assert.deepEqual(receipt.payments.map(({ method, amount }) => ({ method, amount })), correction.payments);
  assert.equal((await readState(db, helper, tenant)).state.closedDays[0].expectedCash, 4_800);
  const events = (await listAudit(db, owner, tenant)).events.filter(({ action }) => action === correction.type);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.businessDate, date);
  assert.equal(event.at, now);
  assert.equal(event.actor.id, owner.uid);
  assert.equal(event.target.id, ticketId);
  assert.equal(event.reason, '端末の控えを照合');
  assert.deepEqual(event.before, {
    total: 7_200, cardFee: 600, payments: [{ method: 'card', amount: 6_600 }],
    expectedCash: 1_100, actualCash: 1_100, discrepancy: 0,
  });
  assert.deepEqual(event.after, {
    total: 7_200, cardFee: 600, payments: correction.payments,
    expectedCash: 4_800, actualCash: 1_100, discrepancy: -3_700,
  });
  await assert.rejects(listAudit(db, helper, tenant), { code: 'forbidden' });
  const reprinted = await run(owner, 10, 'corrected-receipt', { type: 'issuePrintDocument', ticketId, date, kind: 'receipt' });
  assert.equal(reprinted.state.printDocuments.at(-1).number, 2);

  const newTenant = await store(db);
  for (const [suffix, tamper] of [
    ['without-marker', (row) => { delete row.paymentsCorrectedAt; }],
    ['wrong-total', (row) => { row.payments[0].amount += 1; }],
    ['wrong-paid', (row) => { row.settlement.paid -= 1; }],
    ['wrong-time', (row) => { row.paymentsCorrectedAt = row.settledAt - 1; }],
  ]) {
    const snapshot = structuredClone(corrected.state);
    tamper(snapshot.closedDays[0].ticketSnapshots[0]);
    await assert.rejects(migrateState(db, owner, newTenant, { operationId: `migration-corrected-${suffix}`, snapshot }),
      { code: 'invalid-snapshot' });
  }
  const migrated = await migrateState(db, owner, newTenant, { operationId: 'migration-corrected-payments', snapshot: corrected.state });
  const { seatedByUid: _seatedByUid, settledBy: _settledBy, ...migratableReceipt } = receipt;
  assert.deepEqual(migrated.state.closedDays[0].ticketSnapshots, [migratableReceipt]);

  const legacyTenant = await store(db);
  const legacySnapshot = structuredClone(corrected.state);
  delete legacySnapshot.closedDays[0].ticketSnapshots[0].settlementRevision;
  const legacy = await migrateState(db, owner, legacyTenant, { operationId: 'migration-corrected-legacy', snapshot: legacySnapshot });
  assert.equal(legacy.state.closedDays[0].ticketSnapshots[0].settlementRevision, undefined);
});

test('a tender correction changes only receivable principal and retains original collection dates and entries', async (t) => {
  const db = database();
  const tenant = await store(db);
  const date = '2026-11-16';
  const nextDate = '2026-11-17';
  let now = Date.parse(`${date}T20:00:00+09:00`);
  t.mock.method(Date, 'now', () => now);
  const run = (revision, suffix, action) => command(db, owner, tenant, revision, `payments-credit-${suffix}`, action);
  await run(0, 'open', { type: 'open', date, openingCash: 0 });
  const registered = await run(1, 'customer', {
    type: 'saveCustomer', customer: { name: '振替のテスト顧客', creditEnabled: true, creditLimit: 2_000 },
  });
  const [customer] = registered.state.customers;
  const seated = await run(2, 'seat', { type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 1, customerId: customer.id });
  const [{ id: ticketId }] = seated.state.tickets;
  await run(3, 'settle', { type: 'settle', ticketId, payments: [{ method: 'cash', amount: 6_600 }] });
  await run(4, 'depart', { type: 'depart', ticketId });
  await run(5, 'close', { type: 'close', actualCash: 6_600 });
  now = Date.parse(`${nextDate}T20:00:00+09:00`);
  await run(6, 'next-day', { type: 'open', date: nextDate, openingCash: 0 });
  const action = (credit) => ({ type: 'correctSettledTicketPayments', ticketId, reason: '売掛額の訂正',
    payments: [{ method: 'cash', amount: 6_600 - credit }, ...(credit ? [{ method: 'receivable', amount: credit }] : [])],
  });
  const dueDate = '2026-11-30';
  const charged = await run(7, 'add', { ...action(3_000), creditDueDate: dueDate });
  const [issued] = charged.state.receivables;
  assert.equal(issued.date, date);
  assert.equal(issued.dueDate, dueDate);
  assert.equal(issued.amount, 3_000);
  assert.equal(issued.creditOverride.reason, '売掛額の訂正');
  assert.equal(charged.state.closedDays[0].receivableSales, 3_000);
  const recovered = await run(8, 'collect', { type: 'recoverReceivable', receivableId: issued.id, method: 'cash', date: nextDate, amount: 1_000 });
  const [withCollection] = recovered.state.receivables;
  await assert.rejects(run(9, 'deny-decrease-below-collected', action(999)), { code: 'rejected-command' });
  await assert.rejects(run(9, 'deny-removal', action(0)), { code: 'rejected-command' });
  assert.deepEqual(await readState(db, owner, tenant), recovered);
  const corrected = await run(9, 'reduce', action(1_500));
  const [loan] = corrected.state.receivables;
  assert.equal(loan.id, issued.id);
  assert.equal(loan.amount, 1_500);
  assert.equal(loan.dueDate, dueDate);
  assert.deepEqual(loan.collections, withCollection.collections);
  assert.equal(summary(corrected.state).expectedCash, 1_000);
  assert.equal(corrected.state.closedDays[0].receivableSales, 1_500);
  assert.equal(corrected.state.closedDays[0].expectedCash, 5_100);
  assert.equal(corrected.state.closedDays[0].actualCash, 6_600);
  const [event] = (await listAudit(db, owner, tenant)).events;
  assert.equal(event.businessDate, date);
  assert.equal(event.before.receivable.amount, 3_000);
  assert.equal(event.before.receivable.balance, 2_000);
  assert.equal(event.after.receivable.amount, 1_500);
  assert.equal(event.after.receivable.balance, 500);
  assert.equal(event.after.receivable.collected, 1_000);
  assert.equal(event.after.receivable.dueDate, dueDate);
});

test('migration strips forged customer links and settlement actors from every ticket view', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db, owner, tenant, helper.email, 'manager');
  await listStores(db, helper);
  const now = Date.parse('2026-11-16T20:00:00+09:00');
  const admin = { id: owner.uid, label: owner.email, role: 'admin' };
  let browser = createDemo('closed', now);
  const applyBrowser = (action) => { browser = apply(browser, action, now, admin); };
  const seat = { type: 'seat', tableIds: ['a1'], setId: 'set60', guests: 1 };
  applyBrowser({ type: 'open', date: '2026-11-16', openingCash: 0 });
  applyBrowser(seat);
  const { id: ticketId } = browser.tickets[0];
  const payment = { type: 'settle', ticketId, payments: [{ method: 'cash', amount: quote(browser, ticketId).remaining }] };
  applyBrowser(payment);
  applyBrowser({ type: 'cancelSettlement', ticketId, reason: '入力内容の修正' });
  applyBrowser({ type: 'reopenTicket', ticketId, tableIds: ['a1'], reason: '再会計' });
  applyBrowser(payment);
  applyBrowser({ type: 'depart', ticketId });
  applyBrowser({ type: 'close', actualCash: summary(browser).expectedCash });
  applyBrowser({ type: 'open', date: '2026-11-17', openingCash: 0 });
  applyBrowser(seat);
  const ticketViews = (state) => [state.tickets[0], state.closedDays[0].ticketSnapshots[0], state.cancelledSettlements[0].receipt];
  for (const ticket of ticketViews(browser)) {
    ticket.activeCustomerLink = { id: 'fake', name: '偽のリンク' };
    ticket.settledBy = { id: owner.uid, label: owner.email, role: 'staff' };
  }
  const migrated = await migrateState(db, owner, tenant, { operationId: 'forged-ticket-link-migration', snapshot: browser });
  for (const { state } of [migrated, await readState(db, helper, tenant)]) {
    assert.ok(ticketViews(state).every(({ activeCustomerLink, settledBy }) => activeCustomerLink === undefined && settledBy === undefined));
  }
});

test('verified operators remain attributed across corrections and archives only in the administrator report', async (t) => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db,owner,tenant,helper.email,'manager');
  await inviteMember(db,owner,tenant,outsider.email,'staff');
  await Promise.all([listStores(db,helper),listStores(db,outsider)]);
  const date = '2026-11-16';
  let now = Date.parse(`${date}T21:00:00+09:00`);
  t.mock.method(Date,'now',() => now);
  const run = (actor,revision,suffix,action) => command(db,actor,tenant,revision,`team-attribution-${suffix}`,action);
  const seat = {type:'seat',tableIds:['a1'],setId:'set60',guests:1};
  const settle = (ticketId) => ({type:'settle',ticketId,payments:[{method:'cash',amount:6600}],
    settledBy:{id:owner.uid,label:owner.email,role:'manager'}});
  await run(owner,0,'opening',{type:'open',date,openingCash:0});
  const seated = await run(helper,1,'manager-seat',seat);
  const [first] = seated.state.tickets;
  const managed = await run(helper,2,'manager-settle',settle(first.id));
  assert.equal(managed.state.tickets[0].settledBy,undefined);
  await run(helper,3,'manager-depart',{type:'depart',ticketId:first.id});
  const next = await run(outsider,4,'staff-seat',seat);
  const second = next.state.tickets.at(-1);
  const staffPaid = await run(outsider,5,'staff-settle',settle(second.id));
  assert.ok(staffPaid.state.tickets.every(({settledBy}) => settledBy === undefined));
  const originals = (await readState(db,owner,tenant)).state.tickets.map(({settledBy}) => settledBy);
  assert.deepEqual(originals,[{id:helper.uid,label:helper.email,role:'manager'},{id:outsider.uid,label:outsider.email,role:'staff'}]);
  const corrected = await run(owner,6,'payment-correction',{type:'correctSettledTicketPayments',ticketId:second.id,
    payments:[{method:'card',amount:6600}],reason:'カード利用控えを確認'});
  assert.deepEqual(corrected.state.tickets.map(({settledBy}) => settledBy),originals);
  const inService = getTeamPerformance(corrected.state,{start:date,end:date});
  assert.equal(inService.sales,13200);
  assert.equal(inService.tickets,2);
  assert.equal(inService.unattributed,0);
  await run(outsider,7,'staff-depart',{type:'depart',ticketId:second.id});
  await run(owner,8,'close',{type:'close',actualCash:6600});
  now += 86_400_000;
  const after = await run(owner,9,'following-day',{type:'open',date:'2026-11-17',openingCash:0});
  assert.deepEqual(after.state.closedDays[0].ticketSnapshots.map(({settledBy}) => settledBy),originals);
  assert.deepEqual(getTeamPerformance(after.state,{start:date,end:date}).rows,inService.rows);
  const onlyStaff = getTeamPerformance(after.state,{start:date,end:date},'staff');
  assert.deepEqual(onlyStaff.rows.map(({label,sales}) => ({label,sales})),[{label:outsider.email,sales:6600}]);
  const managerState = (await readState(db,helper,tenant)).state;
  assert.ok(managerState.closedDays[0].ticketSnapshots.every(({settledBy}) => settledBy === undefined));
});

test('managers maintain shifts, administrators see audit, and malformed migrated shifts are rejected', async () => {
  const db = database();
  const tenant = await store(db);
  await inviteMember(db,owner,tenant,helper.email,'manager');
  await inviteMember(db,owner,tenant,outsider.email,'staff');
  await Promise.all([listStores(db,helper),listStores(db,outsider)]);
  const run = (actor,revision,suffix,action) => command(db,actor,tenant,revision,`cloud-shifts-${suffix}`,action);
  const shift = {type:'saveShift',castId:'cast1',date:'2026-11-16',status:'requested',startMinute:1260,endMinute:1560,note:'夜シフト'};
  await assert.rejects(run(outsider,0,'denied-save',shift),{code:'forbidden'});
  const request = await run(helper,0,'request',shift);
  const [saved] = request.state.shifts;
  const accepted = await run(helper,1,'confirm',{...shift,shiftId:saved.id,status:'confirmed'});
  const [confirmed] = accepted.state.shifts;
  assert.equal(confirmed.status,'confirmed');
  assert.equal((await readState(db,outsider,tenant)).state.shifts,undefined);
  await assert.rejects(listAudit(db,helper,tenant),{code:'forbidden'});
  const events = (await listAudit(db,owner,tenant)).events.filter(({action}) => action === 'saveShift');
  assert.deepEqual(events.map(({actor,businessDate,before,after}) => [actor.id,businessDate,before?.status,after.status]),
    [[helper.uid,shift.date,'requested','confirmed'],[helper.uid,shift.date,undefined,'requested']]);

  const destination = await store(db);
  const malformed = structuredClone((await readState(db,owner,tenant)).state);
  malformed.shifts.push({...confirmed,id:'overlapping-shift',startMinute:1300});
  await assert.rejects(migrateState(db,owner,destination,{operationId:'cloud-shift-overlap-migration',snapshot:malformed}),{code:'invalid-snapshot'});
  const migrated = await migrateState(db,owner,destination,{operationId:'cloud-shift-valid-migration',snapshot:(await readState(db,owner,tenant)).state});
  assert.deepEqual(migrated.state.shifts,[confirmed]);
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
