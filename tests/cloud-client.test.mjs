import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudClient } from '../docs/cloud-client.mjs';

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

function service(t, { verified = true, role = 'admin', command, readState, project = (value) => value,
  queue = testQueue(), identity = account } = {}) {
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
  };
  const client = createCloudClient(cloudConfig, {
    pollMs: 60_000,
    firebaseLoader: async () => sdk,
    isOnline: () => online,
    operationQueue:queue,
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
