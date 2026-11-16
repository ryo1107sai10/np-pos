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

function service(t, { verified = true, role = 'admin', command, project = (value) => value } = {}) {
  let online = true;
  let revision = 0;
  let state = { revision: 0 };
  const calls = [];
  const snapshots = [];
  let watch;
  const auth = { currentUser: { ...account, emailVerified: verified } };
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
  await assert.rejects(client.submit({ type: 'order', ticketId: 'tab' }, 0), { code: 'sync-pending' });
  assert.throws(() => client.leaveStore(), { code: 'sync-pending' });
  setOnline(true);
  await client.retrySync();
  assert.equal(client.snapshot.revision, 1);
  assert.equal(client.snapshot.pending, 0);
  assert.equal(calls.at(-1).payload.operationId, outcome.operationId);
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
  client.clearQueue();
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
