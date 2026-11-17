import { getNextAutoExtensionAt } from './auto-extension.mjs';
import { offlineCommands, offlineLimit, openOperationQueue, orderCanWait } from './offline-operations.mjs';
import { getCastDutyMode } from './cast-duty.mjs';
import { createOfflineWorkspace, offlineWorkspaceLifetime, openOfflineWorkspaceCache, usableOfflineWorkspace } from './offline-snapshot.mjs';
import { roleAllowsCommand } from './role-policy.mjs';
import { isConcurrentOrder, orderConcurrencyWindow } from './order-concurrency.mjs';

const authSDK = 'https://www.gstatic.com/firebasejs/13.3.0/';
const conflictMessage = '別の端末でデータが更新されました。最新の内容を確認し、操作をやり直してください。';
const lockedMessage = '送信結果を確認中の操作があります。同期状況を確認してください。';
const offlineOrderMessage = '同じ伝票や卓に送信待ちの操作があります。同期後に最新の内容を確認してください。';
const dutyOfflineMessage = '担当キャストの勤務状況を確認するため、接続が回復してから注文を確定してください。';
const coldOfflineUnavailable = 'この端末に利用できる店舗データがありません。オンラインで店舗を開き直してください。';
const workspaceRoles = new Set(['admin','manager','staff','cast','trainee']);
const invalidSessionCodes = new Set(['auth/user-token-expired','auth/invalid-user-token','auth/user-disabled','auth/user-not-found']);
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
  operationQueue = openOperationQueue(globalThis.indexedDB),
  offlineCache = openOfflineWorkspaceCache(globalThis.indexedDB),
  offlineAccessAllowed = () => false,
  now = Date.now,
} = {}) {
  const endpoint = endpointFor(apiBase);
  const configured = Boolean(endpoint && firebase?.apiKey && firebase.projectId);
  const cacheKey = JSON.stringify([endpoint,firebase?.projectId]);
  let current = {
    status: configured ? 'idle' : 'unavailable', cloudConfigured: configured,
    user: null, userVerified: false, stores: [], store: null, state: null, revision: null,
    restricted: false, pending: 0, waiting: [], pendingVolatile: false, conflict: '', error: '',
    coldOffline: false, offlineSavedAt: null, offlineExpiresAt: null,
  };
  let sdk;
  let auth;
  let startPromise;
  let detachAuth;
  let timer;
  let leaseTimer;
  let listening = false;
  let cacheWrites = Promise.resolve();
  let activeScope;
  let takingOrder = false;
  let writingQueue = false;
  let polling = false;
  let ended = false;
  let workspaceLocked = false;

  const patch = (next) => {
    if (Object.keys(next).every((key) => current[key] === next[key])) return;
    current = { ...current, ...next };
    onChange(current);
  };

  function clearStore() {
    activeScope = undefined;
    clearTimeout(leaseTimer);
    patch({ store: null, state: null, revision: null, restricted: false, pending: 0, waiting: [], pendingVolatile: false, conflict: '',
      coldOffline:false, offlineSavedAt:null, offlineExpiresAt:null });
  }

  function writeOfflineCache(record) {
    cacheWrites = cacheWrites.catch(() => {}).then(() => offlineCache.write(cacheKey,record));
    return cacheWrites;
  }

  function clearOfflineSnapshot() {
    if (activeScope) activeScope.cachedAt = undefined;
    return writeOfflineCache(null).catch(() => {});
  }

  async function saveOfflineSnapshot() {
    const scope = activeScope;
    if (!scope || scope.cold || !isOnline() || current.userVerified !== true || !offlineAccessAllowed(scope.uid,scope.storeId)) return false;
    const savedAt = now();
    if (scope.cachedAt !== undefined && current.revision === scope.cachedRevision && current.store.role === scope.cachedRole
      && current.store.profileId === scope.cachedProfileId && savedAt >= scope.cachedAt && savedAt - scope.cachedAt < 300_000) return true;
    try {
      const record = createOfflineWorkspace({ uid:scope.uid, store:current.store, state:current.state, revision:current.revision, savedAt });
      if (!record) { await clearOfflineSnapshot(); return false; }
      await writeOfflineCache(record);
      scope.cachedAt = savedAt;
      scope.cachedRevision = record.revision;
      scope.cachedRole = record.store.role;
      scope.cachedProfileId = record.store.profileId;
      return true;
    } catch { return false; }
  }

  function stillAuthorizedOffline(scope) {
    return scope?.cold && now() >= scope.savedAt && now() < scope.expiresAt && offlineAccessAllowed(scope.uid,scope.storeId);
  }

  function expireOfflineScope(scope) {
    if (scope !== activeScope || !scope?.cold || stillAuthorizedOffline(scope)) return;
    void clearOfflineSnapshot();
    clearStore();
    patch({ user:auth?.currentUser ? summaryUser(auth.currentUser) : null, error:coldOfflineUnavailable,
      status:'offline', userVerified:auth?.currentUser?.emailVerified === true });
  }

  function attachEvents() {
    if (listening) return;
    listening = true;
    globalThis.addEventListener?.('online', onConnectivity);
    globalThis.addEventListener?.('offline', onConnectivity);
    globalThis.addEventListener?.('beforeunload', onPendingExit);
    globalThis.document?.addEventListener('visibilitychange', onConnectivity);
  }

  function assertNoPending(discard = false) {
    if ((current.pending || takingOrder || writingQueue) && !discard) throw new CloudError('sync-pending', lockedMessage);
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
    if (scope.cold && !stillAuthorizedOffline(scope)) {
      expireOfflineScope(scope);
      throw new CloudError('offline-snapshot-expired',coldOfflineUnavailable);
    }
  }

  function assertWorkspaceUnlocked() {
    if (workspaceLocked) throw new CloudError('device-locked', '画面ロックを解除してから操作してください。', 423);
  }

  async function request(path, { method = 'GET', body, actor = requireActor() } = {}) {
    assertWorkspaceUnlocked();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      const idToken = await actor.getIdToken();
      assertWorkspaceUnlocked();
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

  function setPending(scope, rows) {
    assertScope(scope);
    const changed = rows.length !== scope.queue.length || rows.some((row,index) => row.body.operationId !== scope.queue[index].body.operationId);
    scope.queue = rows;
    if (changed) patch({pending:rows.length,pendingVolatile:Boolean(scope.volatile),waiting:rows.map(({route,body,createdAt})=>({
      type:route === 'migrate' ? 'migrate' : body.command?.type,
      ticketId:body.command?.ticketId,tableIds:body.command?.tableIds,createdAt,
    }))});
  }

  async function refreshQueue(scope) {
    if (scope.volatile || scope.storageUnavailable) return;
    let rows;
    try { rows = await operationQueue.update(scope.key); }
    catch { scope.storageUnavailable = true; return; }
    setPending(scope,rows);
    if (!rows.length && current.conflict) patch({conflict:'',status:'connecting'});
  }

  async function removePending(scope, operation) {
    if (scope.volatile) {
      scope.volatile = false;
      setPending(scope,[]);
      return;
    }
    let rows;
    try {
      rows = await operationQueue.update(scope.key,(saved) => saved.filter(({body}) => body.operationId !== operation.body.operationId));
    } catch {
      throw new CloudError('queue-storage-write','端末の送信待ちを更新できませんでした。',503);
    }
    setPending(scope,rows);
  }

  function acceptState(scope, result, serial) {
    assertScope(scope);
    if (!Number.isSafeInteger(result.revision) || result.revision < 0) throw new CloudError('invalid-response', 'クラウドの応答を確認できませんでした。');
    const role = result.role ?? current.store.role;
    const restricted = Boolean(result.restricted || role === 'trainee' || (role === 'cast' && result.scope !== 'cast'));
    let store = current.store;
    const changedRole = result.role && (store.role !== result.role || store.profileId !== result.profileId);
    if (serial < scope.roleSerial) return false;
    if (scope.cold && (result.unchanged || !workspaceRoles.has(result.role) || (!restricted && !result.state))) {
      throw new CloudError('invalid-response','クラウドから最新の営業データを受け取れませんでした。');
    }
    if (changedRole) {
      scope.roleSerial = serial;
      store = { ...store, role: result.role, profileId:result.profileId };
      if (result.unchanged && !restricted) {
        patch({ store, state: null, revision: null, restricted, status: 'connecting' });
        return true;
      }
    }
    if (!scope.cold && !changedRole && current.revision !== null && result.revision < current.revision) return false;
    if (store.hasState !== true && result.revision > 0) store = { ...store, hasState: true };
    const cold = scope.cold;
    if (cold) {
      scope.cold = false;
      clearTimeout(leaseTimer);
    }
    patch({
      store,
      state: restricted ? null : result.unchanged ? current.state : (result.state ?? null),
      revision: result.revision,
      restricted,
      status: current.conflict ? 'conflict' : scope.queue.length ? 'offline' : 'synced',
      error: '',
      ...(cold && {coldOffline:false,offlineSavedAt:null,offlineExpiresAt:null}),
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
    if (previous && (previous !== actor?.uid || !actor.emailVerified)) void clearOfflineSnapshot();
    if (!actor || actor.uid !== previous || !actor.emailVerified) clearStore();
    patch({
      user: actor, userVerified: actor?.emailVerified ?? false, error: '',
      ...(!activeScope && { status: !actor ? 'signed-out' : actor.emailVerified ? 'ready' : 'needs-verification' }),
      ...(actor?.uid !== previous && { stores: [] }),
    });
    if (!actor?.emailVerified || workspaceLocked) return;
    try { await listStores(); }
    catch (error) {
      if (current.user?.uid === actor.uid && error.code !== 'device-locked') {
        patch({ error: error.message, status: transient(error) ? 'offline' : 'error' });
      }
    }
  }

  async function start() {
    if (!configured || ended) return current;
    attachEvents();
    if (!isOnline() && !startPromise) return current;
    if (startPromise) return startPromise;
    if (!activeScope?.cold) patch({ status: 'connecting', error: '' });
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
        return current;
      } catch (error) {
        startPromise = undefined;
        patch({ status: activeScope?.cold ? 'offline' : 'error', error: authError(error).message });
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
    const dutyRefresh = current.state?.castDutyProjection?.refreshAt;
    const since = scope.cold || current.revision === null || current.restricted || !current.state || autoDue || (dutyRefresh != null && dutyRefresh <= Date.now())
      ? '' : `?since=${current.revision}`;
    const result = await request(`${storePath(scope)}/state${since}`);
    if (acceptState(scope, result, serial)) return refreshStore(scope);
    await saveOfflineSnapshot();
    return currentStoreResult();
  }

  function currentStoreResult() {
    const profileId = current.store?.profileId;
    return { state: current.state, revision: current.revision, role: current.store?.role, restricted: current.restricted,
      ...(profileId && {profileId}) };
  }

  function topicDenied(scope, error) {
    if (scope !== activeScope || error.code === 'device-locked') return;
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      void clearOfflineSnapshot();
      clearStore();
      patch({ status: 'ready', error: 'この店舗にアクセスできなくなりました。店舗を選び直してください。' });
      void listStores().catch(() => {});
      return;
    }
    patch({ status: current.conflict ? 'conflict' : transient(error) ? 'offline' : 'error', error: transient(error) ? '' : error.message });
  }

  function schedule(delay = pollMs) {
    clearTimeout(timer);
    if (!activeScope || ended || workspaceLocked || globalThis.document?.hidden || !isOnline()) return;
    timer = setTimeout(() => void tick(), delay);
  }

  async function tick() {
    const scope = activeScope;
    if (!scope || polling || takingOrder || writingQueue) { schedule(); return; }
    if (workspaceLocked || globalThis.document?.hidden || !isOnline()) return;
    polling = true;
    let sent = false;
    try {
      if (scope.cold) await revalidateOfflineScope(scope);
      await refreshQueue(scope);
      if (workspaceLocked) return;
      if (scope.queue.length && !current.conflict) {
        const result = await sendPending(scope);
        sent = Boolean(result && !result.queued);
      }
      else await refreshStore(scope);
    } catch (error) {
      if (!current.conflict) topicDenied(scope, error);
    } finally {
      polling = false;
      schedule(sent && scope.queue.length ? 0 : pollMs);
    }
  }

  function onConnectivity() {
    expireOfflineScope(activeScope);
    if (workspaceLocked) return;
    if (!activeScope) {
      if (isOnline() && current.userVerified && current.status === 'offline') void listStores().catch(() => {});
      return;
    }
    if (!isOnline()) patch({ status: current.conflict ? 'conflict' : 'offline' });
    schedule(isOnline() ? 0 : pollMs);
  }

  function onPendingExit(event) {
    if (!activeScope?.volatile || !current.pending) return;
    event.preventDefault();
    event.returnValue = '';
  }

  async function restoreOfflineStore({ uid, storeId }) {
    assertWorkspaceUnlocked();
    if (activeScope?.cold && activeScope.uid === uid && activeScope.storeId === storeId && stillAuthorizedOffline(activeScope)) return current;
    if (isOnline() || ended || !uid || !storeId || !offlineAccessAllowed(uid,storeId) || activeScope
      || (auth && (!auth.currentUser || auth.currentUser.uid !== uid || !auth.currentUser.emailVerified))) {
      throw new CloudError('offline-snapshot-unavailable',coldOfflineUnavailable);
    }
    await cacheWrites.catch(() => {});
    let record;
    try { record = await offlineCache.read(cacheKey); } catch { /* Report the same user-facing cache message. */ }
    assertWorkspaceUnlocked();
    if (isOnline() || activeScope || !offlineAccessAllowed(uid,storeId)
      || (auth && (!auth.currentUser || auth.currentUser.uid !== uid || !auth.currentUser.emailVerified))
      || !usableOfflineWorkspace(record,{uid,storeId,now:now()})) {
      throw new CloudError('offline-snapshot-unavailable',coldOfflineUnavailable);
    }
    attachEvents();
    const expiresAt = record.savedAt + offlineWorkspaceLifetime;
    const scope = {
      uid, storeId, key:JSON.stringify([endpoint,uid,storeId]), sequence:0,roleSerial:0,queue:[],
      cold:true,fromOffline:true,savedAt:record.savedAt,expiresAt,
    };
    activeScope = scope;
    patch({user:{uid},userVerified:false,stores:[],store:record.store,state:record.state,revision:record.revision,restricted:false,
      status:'offline',coldOffline:true,offlineSavedAt:record.savedAt,offlineExpiresAt:expiresAt,conflict:'',error:''});
    leaseTimer = setTimeout(() => expireOfflineScope(scope),Math.max(0,expiresAt - now()));
    await refreshQueue(scope);
    return current;
  }

  async function revalidateOfflineScope(scope) {
    assertScope(scope);
    if (!scope.cold) return;
    await start();
    assertScope(scope);
    const actor = auth?.currentUser;
    if (!actor || actor.uid !== scope.uid || !actor.emailVerified) {
      throw new CloudError('network-unavailable','オンラインで店舗への接続を確認しています。');
    }
    try { await actor.getIdToken(true); }
    catch (error) {
      if (invalidSessionCodes.has(error.code)) throw new CloudError('auth-required','アカウントにサインインし直してください。',401);
      throw new CloudError('network-unavailable','オンラインで店舗への接続を確認しています。');
    }
    await refreshStore(scope);
  }

  async function enterStore(storeId) {
    assertWorkspaceUnlocked();
    const actor = requireActor();
    const store = current.stores.find(({ id }) => id === storeId);
    if (!store) throw new CloudError('store-unknown', '店舗一覧を更新してから選び直してください。');
    if (activeScope?.storeId === storeId && current.revision !== null) return current;
    assertNoPending();
    if (activeScope) await clearOfflineSnapshot();
    const scope = { uid: actor.uid, storeId, key:JSON.stringify([endpoint,actor.uid,storeId]), sequence:0,roleSerial:0,queue:[] };
    activeScope = scope;
    patch({ store, state: null, revision: null, restricted: false, status: 'connecting', conflict: '', error: '' });
    try {
      await refreshQueue(scope);
      if (!isOnline()) {
        patch({status:'offline'});
        return current;
      }
      await refreshStore(scope);
      return current;
    } catch (error) {
      topicDenied(scope, error);
      throw error;
    } finally {
      schedule(scope.queue.length ? 0 : pollMs);
    }
  }

  async function sendPending(scope, immediateId) {
    assertScope(scope);
    const operation = scope.queue[0];
    if (!operation || current.conflict) return null;
    if (workspaceLocked || scope.cold) return { queued: true, operationId: operation.body.operationId };
    if (scope.fromOffline && (current.restricted || !offlineRoleAllows(operation.body.command))) {
      const reason = '現在の店舗権限では送信待ちの操作を処理できません。管理者に確認してください。';
      patch({status:'conflict',conflict:reason,error:''});
      throw new CloudError('forbidden',reason,403);
    }
    if (takingOrder) throw new CloudError('sync-pending', lockedMessage);
    takingOrder = true;
    const serial = ++scope.sequence;
    try {
      // Background and reconnect replay must keep its original strict revision check.
      const allowConcurrentOrder = operation.body.operationId === immediateId && scope.queue.length === 1
        && isOnline() && isConcurrentOrder(operation.body.command);
      const body = allowConcurrentOrder ? {...operation.body,allowConcurrentOrder:true} : operation.body;
      const result = await request(`${storePath(scope)}/${operation.route}`, { method: 'POST', body });
      assertScope(scope);
      acceptState(scope, result, serial);
      await removePending(scope,operation);
      patch({ status: scope.queue.length ? 'offline' : 'synced', conflict: '', error: '' });
      await saveOfflineSnapshot();
      return currentStoreResult();
    } catch (error) {
      if (scope !== activeScope) throw error;
      if (error.status === 409 && error.code === 'revision-conflict') {
        patch({ status: 'conflict', conflict: conflictMessage, error: '' });
        void refreshStore(scope).catch(() => {});
        throw new CloudError(error.code, conflictMessage, error.status);
      }
      if (transient(error) || error.code === 'device-locked') {
        patch({ status: 'offline', error: '' });
        return { queued: true, operationId: operation.body.operationId };
      }
      if (error.code === 'store-access' || error.status === 401) {
        topicDenied(scope,error);
        throw error;
      }
      if (operation.body.operationId !== immediateId || scope.queue.length > 1) {
        patch({status:'conflict',conflict:error.message,error:''});
        void refreshStore(scope).catch(() => {});
        throw error;
      }
      await removePending(scope,operation);
      patch({ status: 'synced', error: '' });
      if (error.code === 'auto-extension-updated') void refreshStore(scope).catch(() => {});
      throw error;
    } finally {
      takingOrder = false;
    }
  }

  async function queueOrSend(route, data) {
    assertWorkspaceUnlocked();
    const scope = activeScope;
    assertScope(scope);
    if (!scope.cold) requireActor();
    const operationId = globalThis.crypto.randomUUID();
    if (takingOrder || writingQueue || current.conflict) throw new CloudError('sync-pending', lockedMessage);
    const durable = route === 'commands' && offlineCommands.has(data.command?.type) && !isDutyOrder(data.command);
    const operation = {route,body:{...data,operationId},createdAt:Date.now()};
    const append = (rows) => {
      if (rows.length >= offlineLimit) throw new CloudError('queue-full','送信待ちが30件あります。同期後に操作してください。');
      if (!orderCanWait(rows,data.command)) throw new CloudError('sync-pending',offlineOrderMessage);
      const previous = rows.at(-1);
      if (previous && (previous.body.expectedRevision < data.expectedRevision || data.expectedRevision < current.revision)) {
        throw new CloudError('sync-pending','先に送信待ちの操作を同期し、最新の内容を確認してください。');
      }
      return [...rows,{...operation,body:{...operation.body,expectedRevision:previous ? previous.body.expectedRevision + 1 : data.expectedRevision}}];
    };
    writingQueue = true;
    try {
      let rows;
      if (durable && !scope.volatile && !scope.storageUnavailable) {
        try { rows = await operationQueue.update(scope.key,append); }
        catch (error) {
          if (error instanceof CloudError) throw error;
          scope.storageUnavailable = true;
        }
      } else if (!durable) await refreshQueue(scope);
      assertScope(scope);
      if (!rows) {
        if (scope.queue.length) throw new CloudError('sync-pending',lockedMessage);
        if (!isOnline()) throw new CloudError('queue-unavailable','このブラウザーに送信待ちを保存できません。接続回復後に操作してください。');
        scope.volatile = true;
        rows = [operation];
      }
      setPending(scope,rows);
      patch({error:''});
      if (!isOnline() || scope.cold || rows[0].body.operationId !== operationId) {
        patch({ status: 'offline' });
        return { queued: true, operationId };
      }
      return await sendPending(scope,operationId);
    } finally {
      writingQueue = false;
      schedule(current.pending > 1 && isOnline() && !current.conflict ? 0 : pollMs);
    }
  }

  function isDutyOrder(command) {
    return command?.type === 'order' && getCastDutyMode(current.state) !== 'all'
      && command.items?.some(({castIds}) => castIds?.length);
  }

  function submit(command, expectedRevision = current.revision) {
    assertScope(activeScope);
    if (current.restricted || !current.state) throw new CloudError('store-restricted', 'この権限では営業データを変更できません。');
    const canCheckNewerOrders = expectedRevision > 0 && expectedRevision < current.revision && !current.pending
      && current.revision - expectedRevision <= orderConcurrencyWindow && isOnline() && !activeScope.cold && isConcurrentOrder(command);
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision !== current.revision && !canCheckNewerOrders)) {
      throw new CloudError('revision-conflict', conflictMessage, 409);
    }
    if (activeScope.cold) validateColdCommand(command);
    if (!isOnline() && isDutyOrder(command)) throw new CloudError('offline-command',dutyOfflineMessage);
    if (!isOnline() && !offlineCommands.has(command?.type)) throw new CloudError('offline-command', 'この操作にはインターネット接続が必要です。');
    return queueOrSend('commands', { command: structuredClone(command), expectedRevision });
  }

  function offlineRoleAllows(command) {
    const {role,profileId} = current.store;
    return ['admin','manager','staff'].includes(role) && offlineCommands.has(command?.type) && (role !== 'staff' || command.type !== 'open')
      && roleAllowsCommand(current.state,role,command,profileId);
  }

  function validateColdCommand(command) {
    if (isOnline()) throw new CloudError('offline-reauthenticating','店舗への接続を確認してから操作してください。');
    if (!offlineRoleAllows(command) || (command.type === 'seat' && (command.customer || command.customerId || command.newCustomer || command.companionCustomerIds?.length))
      || (command.type === 'settle' && (command.payments?.some(({method}) => method === 'receivable')
        || (getNextAutoExtensionAt(current.state) ?? Infinity) <= now()))) {
      throw new CloudError('offline-command','この操作は、店舗に再接続してから行ってください。');
    }
  }

  function migrate(snapshot) {
    assertScope(activeScope);
    if (current.store?.role !== 'admin' || current.store.hasState || current.revision !== 0) {
      throw new CloudError('migration-not-available', '管理者が未使用の店舗を選んでから移行してください。');
    }
    if (!isOnline()) throw new CloudError('offline-command', 'データの移行にはインターネット接続が必要です。');
    return queueOrSend('migrate', { snapshot: structuredClone(snapshot) });
  }

  async function leaveStore({ discard = false } = {}) {
    assertNoPending(discard);
    const scope = activeScope;
    if (discard && scope && !scope.volatile && (scope.queue.length || !scope.storageUnavailable)) {
      await operationQueue.update(scope.key,()=>[]);
    }
    if (scope !== activeScope) return;
    await clearOfflineSnapshot();
    if (scope !== activeScope) return;
    clearTimeout(timer);
    clearStore();
    patch({ status: current.userVerified ? 'ready' : 'signed-out', error: '' });
  }

  async function clearQueue() {
    assertWorkspaceUnlocked();
    if (activeScope?.cold) throw new CloudError('offline-command','店舗に再接続してから送信待ちを変更してください。');
    if (takingOrder || writingQueue) throw new CloudError('sync-pending', lockedMessage);
    const scope = activeScope;
    assertScope(scope);
    if (!scope.volatile) await operationQueue.update(scope.key,()=>[]);
    scope.volatile = false;
    setPending(scope,[]);
    patch({ conflict: '', error: '', status: isOnline() ? 'synced' : 'offline' });
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
    restoreOfflineStore,
    saveOfflineSnapshot,
    clearOfflineSnapshot,
    checkOfflineAccess() { expireOfflineScope(activeScope); },
    async setWorkspaceLocked(locked) {
      if (workspaceLocked === locked) return;
      workspaceLocked = locked;
      schedule(0);
      if (locked || activeScope || !current.userVerified) return;
      if (!isOnline()) { patch({status:'offline'}); return; }
      try { await listStores(); }
      catch (error) {
        if (error.code !== 'device-locked') patch({error:error.message,status:transient(error) ? 'offline' : 'error'});
      }
    },
    async verifyDeviceLockAccount(uid, { method, email, password }) {
      if (!workspaceLocked) throw new CloudError('not-device-locked', '画面はすでにロック解除されています。');
      return login(async () => {
        const account = auth.currentUser;
        if (account && account.uid !== uid) {
          throw new CloudError('device-account-mismatch', '画面ロックを設定したアカウントで本人確認してください。');
        }
        let result;
        if (method === 'google') {
          const provider = new sdk.GoogleAuthProvider();
          provider.setCustomParameters({ prompt: 'select_account' });
          result = account ? await sdk.reauthenticateWithPopup(account, provider) : await sdk.signInWithPopup(auth,provider);
        } else {
          const address = email.trim();
          result = account ? await sdk.reauthenticateWithCredential(account, sdk.EmailAuthProvider.credential(address, password))
            : await sdk.signInWithEmailAndPassword(auth, address, password);
        }
        if (result.user.uid !== uid || !result.user.emailVerified) {
          if (!account) await sdk.signOut(auth);
          throw new CloudError('device-account-mismatch', '画面ロックを設定したアカウントで本人確認してください。');
        }
        await handleAuth(result.user);
        return result.user.uid;
      });
    },
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
      await leaveStore(options);
      patch({ user: null, userVerified: false, stores: [], status: 'signed-out', error: '' });
      if (auth) await sdk.signOut(auth);
    },
    listStores,
    storeOverview() { return request('/stores/overview'); },
    async operationsGuide(topic) {
      const scope = activeScope;
      const result = await request(`${storePath(scope)}/guide`,topic ? {method:'POST',body:{topic}} : undefined);
      assertScope(scope);
      return result;
    },
    listStoreGroups() { return request('/groups'); },
    createStoreGroup(name) { return request('/groups', { method: 'POST', body: { name } }); },
    renameStoreGroup(id, name) { return request(`/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }); },
    setGroupStore(id, storeId, attach) {
      return request(`/groups/${encodeURIComponent(id)}/stores/${encodeURIComponent(storeId)}`, { method: attach ? 'PUT' : 'DELETE' });
    },
    inviteGroupMember(id, email, role) {
      return request(`/groups/${encodeURIComponent(id)}/members`, { method: 'POST', body: { email, role } });
    },
    changeGroupMember(id, uid, role) {
      return request(`/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(uid)}`,
        role === undefined ? { method: 'DELETE' } : { method: 'PATCH', body: { role } });
    },
    revokeGroupInvite(id, inviteId) {
      return request(`/groups/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' });
    },
    async createStore(name) {
      const { store } = await request('/stores', { method: 'POST', body: { name } });
      await listStores();
      return store;
    },
    enterStore,
    leaveStore,
    submit,
    migrate,
    async listAudit({ before, limit, ticketId, registerDate } = {}) {
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
      if (ticketId != null) query.set('ticketId',ticketId);
      if (registerDate != null) query.set('registerDate',registerDate);
      const suffix = query.size ? `?${query}` : '';
      const result = await request(`${storePath(scope)}/audit${suffix}`);
      assertScope(scope);
      assertAdmin();
      return result;
    },
    listMembers() { return request(`${storePath()}/members`); },
    lineSettings() { return request(`${storePath()}/line-notifications`); },
    linePairing() { return request(`${storePath()}/line-notifications/pairing`); },
    beginLinePairing() { return request(`${storePath()}/line-notifications/pairing`,{method:'POST'}); },
    confirmLinePairing(pairing) { return request(`${storePath()}/line-notifications/pairing`,{method:'PATCH',body:pairing}); },
    saveLineSettings(settings) { return request(`${storePath()}/line-notifications`,{method:'PATCH',body:settings}); },
    queueLineTest() { return request(`${storePath()}/line-notifications/test`,{method:'POST'}); },
    inviteMember(email, role) { return request(`${storePath()}/members`, { method: 'POST', body: { email, role } }); },
    updateMember(uid, role) { return request(`${storePath()}/members/${encodeURIComponent(uid)}`, { method: 'PATCH', body: { role } }); },
    removeMember(uid) { return request(`${storePath()}/members/${encodeURIComponent(uid)}`, { method: 'DELETE' }); },
    restoreGroupMember(uid) { return request(`${storePath()}/members/${encodeURIComponent(uid)}`, { method: 'PUT' }); },
    cancelInvite(id) { return request(`${storePath()}/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    async retrySync() {
      assertWorkspaceUnlocked();
      const scope = activeScope;
      assertScope(scope);
      if (scope.cold) {
        if (!isOnline()) throw new CloudError('network-unavailable','インターネット接続を確認してください。');
        try { await revalidateOfflineScope(scope); }
        catch (error) { topicDenied(scope,error); throw error; }
      }
      await refreshQueue(scope);
      if (current.conflict) return refreshStore(scope);
      if (scope.queue.length) return sendPending(scope);
      return refreshStore(scope);
    },
    clearQueue,
  };
}
