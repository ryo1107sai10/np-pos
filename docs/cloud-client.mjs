import { getNextAutoExtensionAt } from './auto-extension.mjs';

const authSDK = 'https://www.gstatic.com/firebasejs/13.3.0/';
const offlineCommands = new Set(['open', 'seat', 'order', 'extend', 'move', 'settle', 'depart', 'serve']);
const conflictMessage = '別の端末でデータが更新されました。最新の内容を確認し、操作をやり直してください。';
const lockedMessage = '送信結果を確認中の操作があります。同期状況を確認してください。';
const authMessages = {
  'auth/invalid-credential': 'メールアドレスまたはパスワードを確認してください。',
  'auth/wrong-password': 'メールアドレスまたはパスワードを確認してください。',
  'auth/user-not-found': 'メールアドレスまたはパスワードを確認してください。',
  'auth/email-already-in-use': 'このメールアドレスにはアカウントがあります。ログインしてください。',
  'auth/invalid-email': 'メールアドレスを確認してください。',
  'auth/weak-password': 'パスワードを6文字以上にしてください。',
  'auth/popup-closed-by-user': 'Googleログイン画面が閉じられました。',
  'auth/cancelled-popup-request': 'Googleログインをもう一度開いてください。',
  'auth/popup-blocked': 'ブラウザーのポップアップを許可するか、メールアドレスでログインしてください。',
  'auth/network-request-failed': '通信が切断されました。接続を確認してください。',
  'auth/too-many-requests': '時間をおいてからもう一度お試しください。',
  'auth/operation-not-allowed': 'この方法でのログインは現在利用できません。',
};

export class CloudError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.status = status;
  }
}

async function loadFirebase() {
  const [app, auth] = await Promise.all([
    import(`${authSDK}firebase-app.js`),
    import(`${authSDK}firebase-auth.js`),
  ]);
  return { ...app, ...auth };
}

function networkAvailable() {
  return globalThis.navigator?.onLine !== false;
}

function authError(error) {
  return error instanceof CloudError
    ? error
    : new CloudError(error.code || 'auth-unavailable', authMessages[error.code] || 'ログインを確認できませんでした。時間をおいてお試しください。');
}

function transient(error) {
  return error.code === 'network-unavailable' || error.status >= 500 || error.status === 429;
}

function summaryUser(user) {
  if (!user) return null;
  return { uid: user.uid, email: user.email, displayName: user.displayName, emailVerified: user.emailVerified === true };
}

function endpointFor(apiBase) {
  if (!apiBase) return '';
  const base = new URL(apiBase, globalThis.location?.href).href.replace(/\/$/, '');
  return base.endsWith('/api') ? base : `${base}/api`;
}

export function createCloudClient({ firebase, apiBase, authEmulatorUrl } = {}, {
  onChange = () => {},
  pollMs = 6500,
  firebaseLoader = loadFirebase,
  fetchImpl = globalThis.fetch,
  isOnline = networkAvailable,
} = {}) {
  const endpoint = endpointFor(apiBase);
  const configured = Boolean(endpoint && firebase?.apiKey && firebase.projectId);
  let current = {
    status: configured ? 'idle' : 'unavailable', cloudConfigured: configured,
    user: null, userVerified: false, stores: [], store: null, state: null, revision: null,
    restricted: false, pending: 0, conflict: '', error: '',
  };
  let sdk;
  let auth;
  let startPromise;
  let detachAuth;
  let timer;
  let activeScope;
  let pendingOperation;
  let takingOrder = false;
  let polling = false;
  let ended = false;

  const patch = (next) => {
    if (Object.keys(next).every((key) => current[key] === next[key])) return;
    current = { ...current, ...next };
    onChange(current);
  };

  function clearStore() {
    activeScope = undefined;
    pendingOperation = undefined;
    patch({ store: null, state: null, revision: null, restricted: false, pending: 0, conflict: '' });
  }

  function assertNoPending(discard = false) {
    if ((pendingOperation || takingOrder) && !discard) throw new CloudError('sync-pending', lockedMessage);
  }

  function requireActor() {
    const actor = auth?.currentUser;
    if (!actor || current.user?.uid !== actor.uid) throw new CloudError('auth-required', '店舗を使うにはログインしてください。');
    if (!actor.emailVerified) throw new CloudError('verification-required', '確認メールのリンクを開いてから操作してください。');
    return actor;
  }

  function assertScope(scope) {
    if (!scope || scope !== activeScope || current.user?.uid !== scope.uid) {
      throw new CloudError('store-changed', '操作中の店舗が変わりました。店舗を選び直してください。');
    }
  }

  async function request(path, { method = 'GET', body, actor = requireActor() } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      const idToken = await actor.getIdToken();
      if (auth?.currentUser?.uid !== actor.uid) throw new CloudError('auth-required', 'ログインし直してください。');
      response = await fetchImpl(`${endpoint}${path}`, {
        method,
        headers: { Authorization: `Bearer ${idToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) {
        const info = payload.error;
        throw new CloudError(info?.code || `http-${response.status}`,
          info?.message || 'クラウドに接続できませんでした。時間をおいてお試しください。', response.status);
      }
      return payload;
    } catch (error) {
      if (error instanceof CloudError) throw error;
      if (error.code && !['auth/network-request-failed', 'auth/timeout'].includes(error.code)) throw authError(error);
      throw new CloudError('network-unavailable', '通信が切断されました。接続を確認してください。');
    } finally {
      clearTimeout(timeout);
    }
  }

  const storePath = (scope = activeScope) => {
    assertScope(scope);
    return `/stores/${encodeURIComponent(scope.storeId)}`;
  };

  function acceptState(scope, result, serial) {
    assertScope(scope);
    if (!Number.isSafeInteger(result.revision) || result.revision < 0) throw new CloudError('invalid-response', 'クラウドの応答を確認できませんでした。');
    const role = result.role ?? current.store.role;
    const restricted = Boolean(result.restricted || role === 'trainee' || (role === 'cast' && result.scope !== 'cast'));
    let store = current.store;
    const changedRole = result.role && store.role !== result.role;
    if (changedRole && serial < scope.roleSerial) return false;
    if (changedRole) {
      scope.roleSerial = serial;
      store = { ...store, role: result.role };
      if (result.unchanged && !restricted) {
        patch({ store, state: null, revision: null, restricted, status: 'connecting' });
        return true;
      }
    }
    if (!changedRole && current.revision !== null && result.revision < current.revision) return false;
    if (store.hasState !== true && result.revision > 0) store = { ...store, hasState: true };
    patch({
      store,
      state: restricted ? null : result.unchanged ? current.state : (result.state ?? null),
      revision: result.revision,
      restricted,
      status: current.conflict ? 'conflict' : pendingOperation ? 'offline' : 'synced',
      error: '',
    });
    return false;
  }

  async function listStores() {
    const actor = requireActor();
    const { stores } = await request('/stores', { actor });
    if (current.user?.uid !== actor.uid) throw new CloudError('auth-required', 'ログインし直してください。');
    if (!Array.isArray(stores)) throw new CloudError('invalid-response', '店舗一覧を取得できませんでした。');
    patch({ stores, error: '', ...(!activeScope ? { status: 'ready' } : {}) });
    return stores;
  }

  async function handleAuth(user) {
    if (ended) return;
    const previous = current.user?.uid;
    const actor = summaryUser(user);
    if (!actor || actor.uid !== previous || !actor.emailVerified) clearStore();
    patch({
      user: actor, userVerified: actor?.emailVerified ?? false, error: '',
      ...(!activeScope && { status: !actor ? 'signed-out' : actor.emailVerified ? 'ready' : 'needs-verification' }),
      ...(actor?.uid !== previous && { stores: [] }),
    });
    if (!actor?.emailVerified) return;
    try { await listStores(); }
    catch (error) {
      if (current.user?.uid === actor.uid) patch({ error: error.message, status: transient(error) ? 'offline' : 'error' });
    }
  }

  async function start() {
    if (!configured || ended) return current;
    if (startPromise) return startPromise;
    patch({ status: 'connecting', error: '' });
    startPromise = (async () => {
      try {
        sdk = await firebaseLoader();
        if (ended) return current;
        const name = 'np-pos-cloud';
        const instance = sdk.getApps().find((app) => app.name === name) ?? sdk.initializeApp(firebase, name);
        auth = sdk.getAuth(instance);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(globalThis.location?.hostname);
        if (authEmulatorUrl && local && !auth.emulatorConfig) sdk.connectAuthEmulator(auth, authEmulatorUrl, { disableWarnings: true });
        auth.languageCode = 'ja';
        await new Promise((resolve) => {
          detachAuth = sdk.onAuthStateChanged(auth, (user) => {
            void handleAuth(user).finally(resolve);
          });
        });
        globalThis.addEventListener?.('online', onConnectivity);
        globalThis.addEventListener?.('offline', onConnectivity);
        globalThis.addEventListener?.('beforeunload', onPendingExit);
        globalThis.document?.addEventListener('visibilitychange', onConnectivity);
        return current;
      } catch (error) {
        startPromise = undefined;
        patch({ status: 'error', error: authError(error).message });
        return current;
      }
    })();
    return startPromise;
  }

  async function login(action) {
    await start();
    if (!auth) throw new CloudError('cloud-unavailable', current.error || 'クラウド接続は準備中です。');
    try { return await action(); }
    catch (error) { throw authError(error); }
  }

  async function refreshStore(scope = activeScope) {
    assertScope(scope);
    const serial = ++scope.sequence;
    const deadline = current.state?.day ? getNextAutoExtensionAt(current.state) : null;
    const autoDue = deadline != null && deadline <= Date.now();
    const since = current.revision === null || current.restricted || !current.state || autoDue ? '' : `?since=${current.revision}`;
    const result = await request(`${storePath(scope)}/state${since}`);
    if (acceptState(scope, result, serial)) return refreshStore(scope);
    return currentStoreResult();
  }

  function currentStoreResult() {
    return { state: current.state, revision: current.revision, role: current.store?.role, restricted: current.restricted };
  }

  function topicDenied(scope, error) {
    if (scope !== activeScope) return;
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      clearStore();
      patch({ status: 'ready', error: 'この店舗にアクセスできなくなりました。店舗を選び直してください。' });
      void listStores().catch(() => {});
      return;
    }
    patch({ status: current.conflict ? 'conflict' : transient(error) ? 'offline' : 'error', error: transient(error) ? '' : error.message });
  }

  function schedule(delay = pollMs) {
    clearTimeout(timer);
    if (!activeScope || ended || globalThis.document?.hidden || !isOnline()) return;
    timer = setTimeout(() => void tick(), delay);
  }

  async function tick() {
    const scope = activeScope;
    if (!scope || polling || takingOrder) { schedule(); return; }
    if (globalThis.document?.hidden || !isOnline()) return;
    polling = true;
    try {
      if (pendingOperation && !current.conflict) await sendPending(scope);
      else await refreshStore(scope);
    } catch (error) {
      if (error.code !== 'revision-conflict') topicDenied(scope, error);
    } finally {
      polling = false;
      schedule();
    }
  }

  function onConnectivity() {
    if (!activeScope) return;
    if (!isOnline()) patch({ status: current.conflict ? 'conflict' : 'offline' });
    schedule(isOnline() ? 0 : pollMs);
  }

  function onPendingExit(event) {
    if (!pendingOperation) return;
    event.preventDefault();
    event.returnValue = '';
  }

  async function enterStore(storeId) {
    const actor = requireActor();
    const store = current.stores.find(({ id }) => id === storeId);
    if (!store) throw new CloudError('store-unknown', '店舗一覧を更新してから選び直してください。');
    if (activeScope?.storeId === storeId && current.revision !== null) return current;
    assertNoPending();
    const scope = { uid: actor.uid, storeId, sequence: 0, roleSerial: 0 };
    activeScope = scope;
    patch({ store, state: null, revision: null, restricted: false, status: 'connecting', conflict: '', error: '' });
    try {
      await refreshStore(scope);
      return current;
    } catch (error) {
      topicDenied(scope, error);
      throw error;
    } finally {
      schedule();
    }
  }

  async function sendPending(scope) {
    assertScope(scope);
    const operation = pendingOperation;
    if (!operation || current.conflict) return null;
    if (takingOrder) throw new CloudError('sync-pending', lockedMessage);
    takingOrder = true;
    const serial = ++scope.sequence;
    try {
      const result = await request(`${storePath(scope)}/${operation.route}`, { method: 'POST', body: operation.body });
      assertScope(scope);
      acceptState(scope, result, serial);
      pendingOperation = undefined;
      patch({ pending: 0, status: 'synced', conflict: '', error: '' });
      return currentStoreResult();
    } catch (error) {
      if (scope !== activeScope) throw error;
      if (error.status === 409 && error.code === 'auto-extension-updated') {
        pendingOperation = undefined;
        patch({ pending: 0, status: 'synced', conflict: '', error: '' });
        void refreshStore(scope).catch(() => {});
        throw error;
      }
      if (error.status === 409 && error.code === 'revision-conflict') {
        patch({ status: 'conflict', conflict: conflictMessage, error: '' });
        void refreshStore(scope).catch(() => {});
        throw new CloudError(error.code, conflictMessage, error.status);
      }
      if (transient(error)) {
        patch({ status: 'offline', error: '' });
        return { queued: true, operationId: operation.body.operationId };
      }
      pendingOperation = undefined;
      patch({ pending: 0, status: 'synced', error: '' });
      throw error;
    } finally {
      takingOrder = false;
    }
  }

  async function queueOrSend(route, data) {
    const scope = activeScope;
    assertScope(scope);
    requireActor();
    assertNoPending();
    const operationId = globalThis.crypto.randomUUID();
    pendingOperation = { route, body: { ...data, operationId } };
    patch({ pending: 1, error: '' });
    try {
      if (!isOnline()) {
        patch({ status: 'offline' });
        return { queued: true, operationId };
      }
      return await sendPending(scope);
    } finally {
      schedule();
    }
  }

  function submit(command, expectedRevision = current.revision) {
    assertScope(activeScope);
    if (current.restricted || !current.state) throw new CloudError('store-restricted', 'この権限では営業データを変更できません。');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw new CloudError('revision-conflict', conflictMessage, 409);
    }
    if (!isOnline() && !offlineCommands.has(command?.type)) throw new CloudError('offline-command', 'この操作にはインターネット接続が必要です。');
    return queueOrSend('commands', { command: structuredClone(command), expectedRevision });
  }

  function migrate(snapshot) {
    assertScope(activeScope);
    if (current.store?.role !== 'admin' || current.store.hasState || current.revision !== 0) {
      throw new CloudError('migration-not-available', '管理者が未使用の店舗を選んでから移行してください。');
    }
    if (!isOnline()) throw new CloudError('offline-command', 'データの移行にはインターネット接続が必要です。');
    return queueOrSend('migrate', { snapshot: structuredClone(snapshot) });
  }

  function leaveStore({ discard = false } = {}) {
    assertNoPending(discard);
    clearTimeout(timer);
    clearStore();
    patch({ status: current.userVerified ? 'ready' : 'signed-out', error: '' });
  }

  function clearQueue() {
    if (takingOrder) throw new CloudError('sync-pending', lockedMessage);
    pendingOperation = undefined;
    patch({ pending: 0, conflict: '', error: '', status: isOnline() ? 'synced' : 'offline' });
    schedule(0);
  }

  function dispose() {
    ended = true;
    clearTimeout(timer);
    detachAuth?.();
    globalThis.removeEventListener?.('online', onConnectivity);
    globalThis.removeEventListener?.('offline', onConnectivity);
    globalThis.removeEventListener?.('beforeunload', onPendingExit);
    globalThis.document?.removeEventListener('visibilitychange', onConnectivity);
    clearStore();
    patch({ user: null, userVerified: false, stores: [] });
  }

  return {
    get snapshot() { return current; },
    start,
    dispose,
    async signInGoogle() {
      return login(async () => {
        const provider = new sdk.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        const { user } = await sdk.signInWithPopup(auth, provider);
        await handleAuth(user);
      });
    },
    async signInEmail(email, password) {
      return login(async () => {
        const { user } = await sdk.signInWithEmailAndPassword(auth, email.trim(), password);
        await handleAuth(user);
      });
    },
    async registerEmail(email, password) {
      return login(async () => {
        const { user } = await sdk.createUserWithEmailAndPassword(auth, email.trim(), password);
        await handleAuth(user);
        await sdk.sendEmailVerification(user);
      });
    },
    resetPassword(email) { return login(() => sdk.sendPasswordResetEmail(auth, email.trim())); },
    sendVerification() {
      return login(() => {
        if (!auth.currentUser) throw new CloudError('auth-required', 'ログインし直してください。');
        return sdk.sendEmailVerification(auth.currentUser);
      });
    },
    refreshAuth() {
      return login(async () => {
        const user = auth.currentUser;
        if (user) {
          await sdk.reload(user);
          await user.getIdToken(true);
        }
        await handleAuth(auth.currentUser);
      });
    },
    async signOut(options) {
      leaveStore(options);
      patch({ user: null, userVerified: false, stores: [], status: 'signed-out', error: '' });
      if (auth) await sdk.signOut(auth);
    },
    listStores,
    storeOverview() { return request('/stores/overview'); },
    async createStore(name) {
      const { store } = await request('/stores', { method: 'POST', body: { name } });
      await listStores();
      return store;
    },
    enterStore,
    leaveStore,
    submit,
    migrate,
    async listAudit({ before, limit } = {}) {
      const scope = activeScope;
      assertScope(scope);
      const roleSerial = scope.roleSerial;
      const assertAdmin = () => {
        if (current.store?.role !== 'admin' || roleSerial !== scope.roleSerial) {
          throw new CloudError('forbidden', '監査ログの表示には店舗管理者の権限が必要です。', 403);
        }
      };
      assertAdmin();
      const query = new URLSearchParams();
      if (before != null) query.set('before', before);
      if (limit != null) query.set('limit', limit);
      const suffix = query.size ? `?${query}` : '';
      const result = await request(`${storePath(scope)}/audit${suffix}`);
      assertScope(scope);
      assertAdmin();
      return result;
    },
    listMembers() { return request(`${storePath()}/members`); },
    inviteMember(email, role) { return request(`${storePath()}/members`, { method: 'POST', body: { email, role } }); },
    updateMember(uid, role) { return request(`${storePath()}/members/${encodeURIComponent(uid)}`, { method: 'PATCH', body: { role } }); },
    removeMember(uid) { return request(`${storePath()}/members/${encodeURIComponent(uid)}`, { method: 'DELETE' }); },
    cancelInvite(id) { return request(`${storePath()}/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    async retrySync() {
      const scope = activeScope;
      assertScope(scope);
      if (current.conflict) return refreshStore(scope);
      if (pendingOperation) return sendPending(scope);
      return refreshStore(scope);
    },
    clearQueue,
  };
}
