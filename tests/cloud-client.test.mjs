import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudClient } from '../docs/cloud-client.mjs';
import { createDemo } from '../docs/engine.mjs';
import { offlineWorkspaceLifetime } from '../docs/offline-snapshot.mjs';

const account = {
  uid: 'user-a',
  email: 'operator@example.test',
  emailVerified: true,
  async getIdToken() { return 'firebase-token'; },
};
const cloudConfig = { firebase: { apiKey: 'test-key', projectId: 'test-project' }, apiBase: 'https://api.example.test' };
const failure = (code, status) => Response.json({ error: { code, message: code } }, { status });

function testQueue() {
  const records = new Map();
  return {async update(key,change) {
    const before = structuredClone(records.get(key) ?? []);
    if (!change) return before;
    const after = change(before);
    records.set(key,structuredClone(after));
    return after;
  }};
}

function testOfflineCache() {
  const records = new Map();
  return {
    async read(key) { return structuredClone(records.get(key)); },
    async write(key,record) {
      if (record) records.set(key,structuredClone(record));
      else records.delete(key);
    },
  };
}

function service(t, { verified = true, role = 'admin', command, readState, project = (value) => value,
  queue = testQueue(), identity = account, offlineCache, offlineAccessAllowed, now } = {}) {
  let online = true;
  let revision = 0;
  let state = { revision: 0 };
  const calls = [];
  const snapshots = [];
  let watch;
  const auth = { currentUser: { ...identity, emailVerified: verified } };
  const sdk = {
    getApps: () => [],
    initializeApp: () => ({}),
    getAuth: () => auth,
    onAuthStateChanged: (_auth, observer) => {
      watch = observer;
      queueMicrotask(() => watch(auth.currentUser));
      return () => { watch = undefined; };
    },
    signOut: async () => {
      auth.currentUser = null;
      watch?.(null);
    },
    EmailAuthProvider: { credential: (email,password) => ({email,password}) },
    reauthenticateWithCredential: async (user, {email,password}) => {
      if (email !== user.email || password !== 'valid-password') throw Object.assign(new Error('Invalid credential'), {code:'auth/invalid-credential'});
      return {user};
    },
  };
  const client = createCloudClient(cloudConfig, {
    pollMs: 60_000,
    firebaseLoader: async () => sdk,
    isOnline: () => online,
    operationQueue:queue,
    offlineCache, offlineAccessAllowed, now,
    onChange: (snapshot) => snapshots.push(snapshot),
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      const query = new URL(url).searchParams;
      const payload = options.body ? JSON.parse(options.body) : undefined;
      assert.equal(options.headers.Authorization, 'Bearer firebase-token');
      calls.push({ path, query, payload });
      if (path === '/api/stores') {
        return Response.json({ stores: [{ id: 'shop', name: '店', role, hasState: revision > 0 }] });
      }
      if (path.endsWith('/state')) {
        const override = readState?.({role,revision,state,query});
        if (override) return override;
        if (['cast', 'trainee'].includes(role)) return Response.json({ revision, role, restricted: true });
        return Response.json(query.get('since') === String(revision)
          ? { revision, role, unchanged: true } : { state: project(state, role), revision, role });
      }
      if (path.endsWith('/commands')) {
        const override = command?.(payload, { setRevision, calls });
        if (override) return override;
        if (payload.expectedRevision !== revision) return failure('revision-conflict', 409);
      } else if (!path.endsWith('/migrate')) {
        return failure('not-found', 404);
      }
      setRevision(revision + 1, payload.snapshot);
      return Response.json({ state, revision, role });
    },
  });
  t.after(client.dispose);
  function setRevision(next, snapshot) {
    revision = next;
    state = snapshot ?? { revision: next };
  }
  return {
    client, calls, snapshots, setRevision,
    setOnline(next) { online = next; },
    setRole(next) { role = next; },
  };
}

test('verified membership and cloud state remain separate from an offline pending operation', async (t) => {
  const { client, calls, setOnline } = service(t);
  await client.start();
  assert.equal(client.snapshot.status, 'ready');
  await client.enterStore('shop');
  setOnline(false);
  const outcome = await client.submit({ type: 'order', ticketId: 'tab' }, 0);
  assert.equal(outcome.queued, true);
  assert.equal(client.snapshot.status, 'offline');
  assert.equal(client.snapshot.pending, 1);
  assert.equal(client.snapshot.state.revision, 0);
  assert.equal(calls.filter(({ path }) => path.endsWith('/commands')).length, 0);
  await assert.rejects(client.submit({ type: 'settle', ticketId: 'tab', payments:[] }, 0), { code: 'sync-pending' });
  await assert.rejects(client.leaveStore(), { code: 'sync-pending' });
  setOnline(true);
  await client.retrySync();
  assert.equal(client.snapshot.revision, 1);
  assert.equal(client.snapshot.pending, 0);
  assert.equal(calls.at(-1).payload.operationId, outcome.operationId);
});

test('duty mode requests an updated staff projection at a time boundary and requires live assignment confirmation', async (t) => {
  const {client,calls,setOnline,setRevision} = service(t,{role:'staff'});
  setRevision(1,{controls:{castDutyMode:'shifts'},castDutyProjection:{ids:['cast1'],refreshAt:Date.now() - 1}});
  await client.start();
  await client.enterStore('shop');
  await client.retrySync();
  assert.equal(calls.at(-1).query.has('since'),false);
  setOnline(false);
  const order = {type:'order',ticketId:'tab',items:[{menuId:'castDrink',quantity:1,castIds:['cast1']}]};
  assert.throws(() => client.submit(order),{code:'offline-command'});
  assert.equal(client.snapshot.pending,0);
  const queued = await client.submit({...order,items:[{menuId:'highball',quantity:1,castIds:[]}]});
  assert.equal(queued.queued,true);
});

test('device lock pauses authenticated workspace requests and preserves queued orders through account verification', async (t) => {
  const {client, calls, setOnline} = service(t);
  await client.setWorkspaceLocked(true);
  await client.start();
  assert.equal(client.snapshot.userVerified,true);
  assert.equal(calls.length,0);
  await assert.rejects(client.listStores(),{code:'device-locked'});
  await client.setWorkspaceLocked(false);
  await client.enterStore('shop');
  setOnline(false);
  const queued = await client.submit({type:'order',ticketId:'tab',items:[{menuId:'highball',quantity:1}]});
  assert.equal(queued.queued,true);
  await client.setWorkspaceLocked(true);
  const previous = calls.length;
  setOnline(true);
  await assert.rejects(client.retrySync(),{code:'device-locked'});
  await assert.rejects(client.clearQueue(),{code:'device-locked'});
  await assert.rejects(client.verifyDeviceLockAccount('another',{method:'email',email:account.email,password:'valid-password'}),
    {code:'device-account-mismatch'});
  await assert.rejects(client.verifyDeviceLockAccount(account.uid,{method:'email',email:account.email,password:'incorrect'}),
    {code:'auth/invalid-credential'});
  assert.equal(await client.verifyDeviceLockAccount(account.uid,{method:'email',email:account.email,password:'valid-password'}),account.uid);
  assert.equal(calls.length,previous);
  assert.equal(client.snapshot.pending,1);
  assert.equal(client.snapshot.store.id,'shop');
  await client.setWorkspaceLocked(false);
  await client.retrySync();
  assert.equal(client.snapshot.pending,0);
  assert.equal(calls.at(-1).payload.operationId,queued.operationId);
});

test('cold offline restores only the device-bound operational data and revalidates before replay', async (t) => {
  const offlineCache = testOfflineCache();
  const queue = testQueue();
  const fixedTime = Date.parse('2026-11-17T20:00:00+09:00');
  let time = fixedTime;
  const options = {offlineCache,queue,offlineAccessAllowed:(uid) => uid === account.uid,now:() => time};
  const {client:online,setRevision} = service(t,options);
  const state = createDemo('live',fixedTime);
  state.customers = [{id:'private-customer',name:'private-client-name'}];
  state.receivables = [{amount:1000,customerId:'private-customer'}];
  state.payroll = {salary:'private-salary'};
  state.auditLog = [{action:'private-audit'}];
  state.closedDays = [{date:'2026-11-15',sales:99_999,private:'private-day'}];
  state.stock[0].unitCost = 743;
  const ticket = state.tickets.find(({status}) => status === 'open');
  Object.assign(ticket,{customer:'private-client-name',customerId:'private-customer',note:'private-guest-note'});
  setRevision(7,state);
  await online.start();
  await online.enterStore('shop');
  online.dispose();

  const {client,calls,setOnline,setRevision: currentRevision} = service(t,options);
  currentRevision(7,state);
  setOnline(false);
  await client.start();
  assert.equal(client.snapshot.user,null);
  await assert.rejects(client.restoreOfflineStore({uid:'different-user',storeId:'shop'}),{code:'offline-snapshot-unavailable'});
  await assert.rejects(client.restoreOfflineStore({uid:account.uid,storeId:'different-store'}),{code:'offline-snapshot-unavailable'});
  await client.setWorkspaceLocked(true);
  await assert.rejects(client.restoreOfflineStore({uid:account.uid,storeId:'shop'}),{code:'device-locked'});
  await client.setWorkspaceLocked(false);
  await client.restoreOfflineStore({uid:account.uid,storeId:'shop'});
  assert.equal(client.snapshot.coldOffline,true);
  assert.equal(client.snapshot.userVerified,false);
  assert.deepEqual(client.snapshot.user,{uid:account.uid});
  assert.equal(client.snapshot.offlineSavedAt,time);
  assert.equal(client.snapshot.offlineExpiresAt,time + offlineWorkspaceLifetime);
  assert.equal(client.snapshot.state.stock[0].unitCost,0);
  assert.equal(client.snapshot.state.tickets.find(({id})=>id===ticket.id).customer,'');
  assert(!JSON.stringify(client.snapshot).includes('private-'));
  assert.equal(calls.length,0);
  assert.throws(()=>client.submit({type:'seat',tableIds:['a3'],customer:'offline-name'}),{code:'offline-command'});
  assert.throws(()=>client.submit({type:'settle',ticketId:ticket.id,payments:[{method:'receivable',amount:1000}]}),{code:'offline-command'});
  const order = {type:'order',ticketId:ticket.id,items:[{menuId:'highball',quantity:1}]};
  const queued = await client.submit(order);
  assert.equal(queued.queued,true);
  assert.equal(calls.length,0);
  assert.equal(client.snapshot.pending,1);
  setOnline(true);
  time += 60_000;
  await client.retrySync();
  assert.equal(client.snapshot.coldOffline,false);
  assert.equal(client.snapshot.userVerified,true);
  assert.equal(client.snapshot.revision,8);
  assert.equal(client.snapshot.pending,0);
  const readIndex = calls.findIndex(({path})=>path.endsWith('/state'));
  const writeIndex = calls.findIndex(({path})=>path.endsWith('/commands'));
  assert(readIndex >= 0 && readIndex < writeIndex);
  assert.equal(calls[readIndex].query.get('since'),null);
  assert.deepEqual(calls[writeIndex].payload,{command:order,operationId:queued.operationId,expectedRevision:7});
});

test('expired, revoked and signed-out browser workspaces never reuse the offline lease', async (t) => {
  const offlineCache = testOfflineCache();
  let time = Date.parse('2026-11-17T20:00:00+09:00');
  let deviceUnlocked = true;
  const options = {offlineCache,offlineAccessAllowed:(uid)=>uid === account.uid && deviceUnlocked,now:() => time};
  const online = service(t,options);
  online.setRevision(4,createDemo('live',time));
  await online.client.start();
  await online.client.enterStore('shop');
  const offline = service(t,options);
  offline.setOnline(false);
  time += offlineWorkspaceLifetime;
  await assert.rejects(offline.client.restoreOfflineStore({uid:account.uid,storeId:'shop'}),{code:'offline-snapshot-unavailable'});
  await online.client.saveOfflineSnapshot();
  deviceUnlocked = false;
  await assert.rejects(offline.client.restoreOfflineStore({uid:account.uid,storeId:'shop'}),{code:'offline-snapshot-unavailable'});
  deviceUnlocked = true;
  await offline.client.restoreOfflineStore({uid:account.uid,storeId:'shop'});
  deviceUnlocked = false;
  offline.client.checkOfflineAccess();
  assert.equal(offline.client.snapshot.state,null);
  assert.equal(offline.client.snapshot.coldOffline,false);
  deviceUnlocked = true;
  time += 300_001;
  await online.client.saveOfflineSnapshot();
  await online.client.signOut();
  await assert.rejects(offline.client.restoreOfflineStore({uid:account.uid,storeId:'shop'}),{code:'offline-snapshot-unavailable'});
});

test('reconnect replaces cached permissions and does not replay orders after losing authorization', async (t) => {
  const offlineCache = testOfflineCache();
  const queue = testQueue();
  const options = {offlineCache,queue,offlineAccessAllowed:(uid)=>uid === account.uid};
  const online = service(t,options);
  const state = createDemo('live');
  online.setRevision(3,state);
  await online.client.start();
  await online.client.enterStore('shop');
  online.client.dispose();
  const {client,calls,setOnline,setRevision} = service(t,{...options,role:'trainee'});
  setRevision(3,state);
  setOnline(false);
  await client.restoreOfflineStore({uid:account.uid,storeId:'shop'});
  await client.submit({type:'order',ticketId:state.tickets.find(({status})=>status==='open').id,items:[{menuId:'highball',quantity:1}]});
  setOnline(true);
  await assert.rejects(client.retrySync(),{code:'forbidden'});
  assert.equal(client.snapshot.store.role,'trainee');
  assert.equal(client.snapshot.restricted,true);
  assert.equal(client.snapshot.state,null);
  assert.equal(client.snapshot.pending,1);
  assert.equal(calls.some(({path})=>path.endsWith('/commands')),false);
  const another = service(t,options);
  another.setOnline(false);
  await assert.rejects(another.client.restoreOfflineStore({uid:account.uid,storeId:'shop'}),{code:'offline-snapshot-unavailable'});
});

test('multiple queued orders survive a client restart and replay in the original order at successive revisions', async (t) => {
  const queue = testQueue();
  const one = service(t,{queue});
  await one.client.start();
  await one.client.enterStore('shop');
  one.setOnline(false);
  const firstOrder = {type:'order',ticketId:'tab',items:[{menuId:'highball',quantity:1}]};
  const secondOrder = {type:'order',ticketId:'tab',items:[{menuId:'cola',quantity:2}]};
  const first = await one.client.submit(firstOrder);
  const second = await one.client.submit(secondOrder);
  assert.equal(one.client.snapshot.pending,2);
  assert.deepEqual(one.client.snapshot.waiting.map(({type})=>type),['order','order']);
  assert.equal(one.calls.filter(({path})=>path.endsWith('/commands')).length,0);
  one.client.dispose();
  const other = service(t,{queue,identity:{...account,uid:'different-uid'}});
  await other.client.start();
  await other.client.enterStore('shop');
  assert.equal(other.client.snapshot.pending,0);
  other.client.dispose();
  const resumed = service(t,{queue});
  await resumed.client.start();
  resumed.setOnline(false);
  await resumed.client.enterStore('shop');
  assert.equal(resumed.client.snapshot.state,null);
  assert.equal(resumed.client.snapshot.pending,2);
  resumed.setOnline(true);
  await resumed.client.retrySync();
  await resumed.client.retrySync();
  const commands = resumed.calls.filter(({path})=>path.endsWith('/commands')).map(({payload})=>payload);
  assert.deepEqual(commands,[{command:firstOrder,operationId:first.operationId,expectedRevision:0},
    {command:secondOrder,operationId:second.operationId,expectedRevision:1}]);
  assert.equal(resumed.client.snapshot.pending,0);
  assert.equal(resumed.client.snapshot.revision,2);
});

test('recovery preserves unsent operations after the first definitive rejection and does not rebase other payment amounts', async (t) => {
  const {client,calls,setOnline} = service(t,{command:()=>failure('rejected-command',422)});
  await client.start();
  await client.enterStore('shop');
  setOnline(false);
  await client.submit({type:'order',ticketId:'tab',items:[{menuId:'cola',quantity:2}]});
  await client.submit({type:'settle',ticketId:'other',payments:[{method:'cash',amount:1500}]});
  setOnline(true);
  await assert.rejects(client.retrySync(),{code:'rejected-command'});
  assert.equal(client.snapshot.pending,2);
  assert.equal(client.snapshot.status,'conflict');
  await client.retrySync();
  assert.equal(calls.filter(({path})=>path.endsWith('/commands')).length,1);
  await client.clearQueue();
  assert.equal(client.snapshot.pending,0);
});

test('when device storage cannot be used, offline actions do not falsely report a saved order', async (t) => {
  const queue = {async update() { throw new Error('storage disabled'); }};
  const {client,setOnline} = service(t,{queue});
  await client.start();
  await client.enterStore('shop');
  setOnline(false);
  await assert.rejects(client.submit({type:'order',ticketId:'tab'}),{code:'queue-unavailable'});
  assert.equal(client.snapshot.pending,0);
  setOnline(true);
  await client.submit({type:'order',ticketId:'tab'});
  assert.equal(client.snapshot.revision,1);
});

test('an uncertain response retries the exact operation identifier and original revision', async (t) => {
  let applied;
  const { client, calls } = service(t, {
    command(payload, { setRevision }) {
      if (!applied) {
        applied = payload.operationId;
        setRevision(1);
        throw new TypeError('connection dropped after commit');
      }
      assert.equal(payload.operationId, applied);
      return Response.json({ state: { revision: 1 }, revision: 1, role: 'admin' });
    },
  });
  await client.start();
  await client.enterStore('shop');
  const outcome = await client.submit({ type: 'settle', ticketId: 'tab', payments: [] });
  assert.equal(outcome.queued, true);
  assert.equal(client.snapshot.revision, 0);
  await client.retrySync();
  assert.equal(client.snapshot.revision, 1);
  const commands = calls.filter(({ path }) => path.endsWith('/commands'));
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].payload, commands[1].payload);
});

test('server revision conflict refreshes the view without rebasing the queued operation', async (t) => {
  const { client, calls, setRevision } = service(t);
  await client.start();
  await client.enterStore('shop');
  setRevision(2);
  await assert.rejects(client.submit({ type: 'seat', tableIds: ['a1'] }, 0), { code: 'revision-conflict' });
  assert.equal(client.snapshot.status, 'conflict');
  assert.equal(client.snapshot.pending, 1);
  await client.retrySync();
  assert.equal(client.snapshot.state.revision, 2);
  assert.equal(calls.filter(({ path }) => path.endsWith('/commands')).length, 1);
  await client.clearQueue();
  assert.equal(client.snapshot.pending, 0);
  assert.equal(client.snapshot.conflict, '');
  assert.throws(() => client.submit({ type: 'seat' }, 0), { code: 'revision-conflict' });
});

test('restricted roles do not receive operational data and an upgraded role reloads the full snapshot', async (t) => {
  const { client, setRole } = service(t, { role: 'cast' });
  await client.start();
  await client.enterStore('shop');
  assert.equal(client.snapshot.restricted, true);
  assert.equal(client.snapshot.state, null);
  assert.throws(() => client.submit({ type: 'order' }, 0), { code: 'store-restricted' });
  setRole('staff');
  await client.retrySync();
  assert.equal(client.snapshot.restricted, false);
  assert.deepEqual(client.snapshot.state, { revision: 0 });
});

test('cast clients accept only scoped responses and discard a late privileged response after demotion', async (t) => {
  const personal = {cast:{id:'cast1',name:'本人'},date:'2026-11-16',shifts:[],attendances:[]};
  let blockAdminRead = false;
  let releaseAdmin;
  let sawAdminRead;
  let legacy = false;
  const adminRead = new Promise((resolve) => {sawAdminRead = resolve;});
  const {client,calls,snapshots,setRevision,setRole} = service(t,{
    readState({role,revision,state}) {
      if (role === 'admin' && blockAdminRead) {
        sawAdminRead();
        return new Promise((resolve) => { releaseAdmin = () => resolve(Response.json({revision,role,state})); });
      }
      if (role === 'cast') return Response.json(legacy ? {role,revision,state} : {role,revision,scope:'cast',state:personal});
    },
    command(payload,{setRevision}) {
      assert.deepEqual(payload.command,{type:'castClockIn'});
      assert.equal(payload.expectedRevision,1);
      setRevision(2,{confidential:'another privileged snapshot'});
      return Response.json({role:'cast',revision:2,scope:'cast',state:{...personal,openClock:{id:'clock1'}}});
    },
  });
  setRevision(1,{confidential:'administrator data'});
  await client.start();
  await client.enterStore('shop');
  assert.equal(client.snapshot.state.confidential,'administrator data');
  blockAdminRead = true;
  const older = client.retrySync();
  await adminRead;
  setRole('cast');
  await client.retrySync();
  assert.equal(client.snapshot.store.role,'cast');
  assert.equal(client.snapshot.restricted,false);
  assert.deepEqual(client.snapshot.state,personal);
  releaseAdmin();
  await older;
  assert.equal(client.snapshot.store.role,'cast');
  assert.deepEqual(client.snapshot.state,personal);

  await client.submit({type:'castClockIn'});
  assert.deepEqual(client.snapshot.state.openClock,{id:'clock1'});
  assert.equal(client.snapshot.revision,2);
  assert.equal(calls.filter(({path}) => path.endsWith('/commands')).length,1);
  legacy = true;
  await client.retrySync();
  assert.equal(client.snapshot.restricted,true);
  assert.equal(client.snapshot.state,null);
  assert.throws(() => client.submit({type:'castClockOut'}),{code:'store-restricted'});
  assert.ok(snapshots.filter(({store}) => store?.role === 'cast').every(({state}) => state?.confidential === undefined));
});

test('same-revision demotion removes privileged data before loading the staff projection', async (t) => {
  const { client, calls, snapshots, setRevision, setRole } = service(t, {
    role: 'manager',
    project: (value, role) => role === 'staff' ? { revision: value.revision } : value,
  });
  setRevision(3, { revision: 3, confidential: 'manager data' });
  await client.start();
  await client.enterStore('shop');
  assert.equal(client.snapshot.state.confidential, 'manager data');
  setRole('staff');
  await client.retrySync();
  assert.deepEqual(client.snapshot.state, { revision: 3 });
  assert.equal(client.snapshot.store.role, 'staff');
  const reads = calls.filter(({ path }) => path.endsWith('/state'));
  assert.deepEqual(reads.map(({ query }) => query.get('since')), [null, '3', null]);
  assert.ok(snapshots.some((value) => value.store?.role === 'staff' && value.state === null));
  assert.ok(snapshots.filter((value) => value.store?.role === 'staff').every((value) => !value.state?.confidential));
});

test('a custom role change clears previous store data even if the base role and revision are unchanged', async (t) => {
  let profileId = 'role-a';
  const {client,calls,snapshots,setRevision} = service(t,{role:'manager',readState({role,revision,query}) {
    return Response.json(query.get('since') === String(revision)
      ? {revision,role,profileId,unchanged:true}
      : {revision,role,profileId,state:profileId === 'role-a' ? {reports:'visible'} : {orders:'visible'}});
  }});
  setRevision(3);
  await client.start();
  await client.enterStore('shop');
  assert.deepEqual(client.snapshot.state,{reports:'visible'});
  profileId = 'role-b';
  await client.retrySync();
  assert.equal(client.snapshot.store.role,'manager');
  assert.equal(client.snapshot.store.profileId,'role-b');
  assert.deepEqual(client.snapshot.state,{orders:'visible'});
  assert.ok(snapshots.some(({store,state})=>store?.profileId === 'role-b' && state === null));
  assert.ok(snapshots.filter(({store})=>store?.profileId === 'role-b').every(({state})=>!state?.reports));
  assert.deepEqual(calls.filter(({path})=>path.endsWith('/state')).map(({query})=>query.get('since')),[null,'3',null]);
});

test('migration is explicit and sign-out discards authenticated state', async (t) => {
  const { client, calls, setOnline } = service(t);
  await client.start();
  await client.enterStore('shop');
  const original = { name: 'previous local operations' };
  await client.migrate(original);
  assert.deepEqual(client.snapshot.state, original);
  assert.ok(calls.at(-1).payload.operationId);
  assert.throws(() => client.migrate({ name: 'another' }), { code: 'migration-not-available' });
  setOnline(false);
  assert.throws(() => client.submit({ type: 'saveLayout' }), { code: 'offline-command' });
  await client.submit({ type: 'order' });
  await assert.rejects(client.signOut(), { code: 'sync-pending' });
  await client.signOut({ discard: true });
  assert.equal(client.snapshot.user, null);
  assert.equal(client.snapshot.store, null);
  assert.equal(client.snapshot.state, null);
  assert.equal(client.snapshot.pending, 0);
});

test('unverified authentication cannot list stores or expose a store', async (t) => {
  const { client, calls } = service(t, { verified: false });
  await client.start();
  assert.equal(client.snapshot.status, 'needs-verification');
  assert.equal(client.snapshot.userVerified, false);
  await assert.rejects(client.listStores(), { code: 'verification-required' });
  assert.equal(calls.length, 0);
});

test('a completed network response cannot restore store data after logout', async (t) => {
  let finish;
  let startSending;
  const sent = new Promise((resolve) => { startSending = resolve; });
  const { client } = service(t, {
    command() {
      startSending();
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  await client.start();
  await client.enterStore('shop');
  const operation = client.submit({ type: 'order', ticketId: 'tab' });
  await sent;
  await client.signOut({ discard: true });
  finish(Response.json({ state: { private: 'store data' }, revision: 1, role: 'admin' }));
  await assert.rejects(operation, { code: 'store-changed' });
  assert.equal(client.snapshot.user, null);
  assert.equal(client.snapshot.state, null);
  assert.equal(client.snapshot.pending, 0);
});

test('an automatic deadline requests a full snapshot and a changed checkout is released without rebasing', async (t) => {
  const now = Date.now();
  const initial = {
    day: {status:'open'},
    autoExtensionSettings: {enabled:true,menuId:'extend30',effectiveAt:now-60_000},
    menu: [{id:'extend30',category:'延長',duration:30}],
    tickets: [{id:'tab',status:'open',endsAt:now-5_000}],
  };
  const updated = {...initial,tickets:[{...initial.tickets[0],endsAt:now+30*60_000}]};
  const {client,calls,setRevision} = service(t,{
    command(_payload, storage) {
      storage.setRevision(2,updated);
      return failure('auto-extension-updated',409);
    },
  });
  setRevision(1,initial);
  await client.start();
  await client.enterStore('shop');
  await client.retrySync();
  assert.equal(calls.at(-1).query.has('since'),false);
  await assert.rejects(client.submit({type:'settle',ticketId:'tab',payments:[]},1),{code:'auto-extension-updated'});
  assert.equal(client.snapshot.pending,0);
  assert.equal(client.snapshot.conflict,'');
  await client.retrySync();
  assert.equal(client.snapshot.revision,2);
  assert.equal(calls.filter(({path})=>path.endsWith('/commands')).length,1);
});
