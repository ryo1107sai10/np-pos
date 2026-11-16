const storageKey = 'np-pos.device-lock.v1';
const minute = 60_000;
const rounds = 310_000;
export const deviceLockIntervals = Object.freeze([1, 3, 5, 10, 15]);

const isPin = (pin) => typeof pin === 'string' && /^[0-9]{6}$/.test(pin);
const isHex = (value, length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const encodeHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

async function digestPin(crypto, pin, salt) {
  const bytes = Uint8Array.from(salt.match(/../g), (byte) => Number.parseInt(byte, 16));
  const input = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const output = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: rounds, salt: bytes }, input, 256);
  return encodeHex(new Uint8Array(output));
}

async function matchesPin(crypto, pin, { salt, verifier }) {
  const actual = await digestPin(crypto, pin, salt);
  let mismatch = 0;
  for (let index = 0; index < verifier.length; index++) mismatch |= verifier.charCodeAt(index) ^ actual.charCodeAt(index);
  return mismatch === 0;
}

function parseRecord(text) {
  const record = JSON.parse(text);
  if (typeof record?.uid !== 'string' || !record.uid || !isHex(record.salt, 32) || !isHex(record.verifier, 64)
    || !deviceLockIntervals.includes(record.minutes) || typeof record.locked !== 'boolean'
    || !validTime(record.deadline) || !validTime(record.retryAt) || !validTime(record.failures)) return null;
  return record;
}

export function createDeviceLock({
  storage, crypto = globalThis.crypto, now = Date.now,
  exclusive = (action) => action(), onChange = () => {},
} = {}) {
  let record = null;
  let error = '';
  let localDeadline = 0;
  let lastWrite = 0;
  let writeTimer;
  let locallyLocked = false;

  const available = Boolean(crypto?.subtle && crypto.getRandomValues && storage);

  function snapshot() {
    return { available, enabled: Boolean(record), locked: record?.locked === true,
      uid: record?.uid, minutes: record?.minutes ?? 5, retryAt: record?.retryAt ?? 0, error };
  }

  function notify(previous) {
    const current = snapshot();
    if (Object.keys(current).some((key) => current[key] !== previous[key])) onChange(current, previous);
  }

  function read() {
    if (!available) return record;
    try {
      const saved = parseRecord(storage.getItem(storageKey));
      return locallyLocked && saved?.salt === record?.salt ? { ...saved, locked: true } : saved;
    }
    catch { return record; }
  }

  function save(next, { hideOnFailure = false } = {}) {
    const previous = snapshot();
    try {
      if (next) storage.setItem(storageKey, JSON.stringify(next));
      else storage.removeItem(storageKey);
      record = next;
      locallyLocked = false;
      error = '';
      notify(previous);
    } catch {
      if (hideOnFailure) {
        record = next;
        locallyLocked = true;
      }
      error = '端末に画面ロックの状態を保存できませんでした。';
      notify(previous);
      throw new Error(error);
    }
  }

  function refresh() {
    const previous = snapshot();
    const old = record;
    record = read();
    if (record?.salt !== old?.salt || previous.locked !== (record?.locked === true)) {
      localDeadline = 0;
      clearTimeout(writeTimer);
    }
    notify(previous);
    return record;
  }

  function lock() {
    const latest = refresh();
    if (!latest || latest.locked) return;
    localDeadline = 0;
    clearTimeout(writeTimer);
    try { save({ ...latest, locked: true }, { hideOnFailure: true }); }
    catch { /* The local workspace is already hidden. */ }
  }

  function check({ shared = false } = {}) {
    if (shared) refresh();
    if (record && !record.locked && now() >= Math.max(record.deadline, localDeadline)) {
      refresh();
      if (record && !record.locked && now() >= Math.max(record.deadline, localDeadline)) lock();
    }
    return snapshot();
  }

  function persistActivity() {
    const latest = refresh();
    if (!latest || latest.locked || localDeadline <= latest.deadline) return;
    lastWrite = now();
    try { save({ ...latest, deadline: localDeadline }); } catch { /* This tab keeps its local deadline. */ }
  }

  function activity() {
    const current = check({ shared: true });
    if (!current.enabled || current.locked) return;
    localDeadline = now() + current.minutes * minute;
    clearTimeout(writeTimer);
    if (now() - lastWrite >= 2_000) persistActivity();
    else writeTimer = setTimeout(persistActivity, 2_000);
  }

  function rejectPin(latest) {
    const failures = Math.min(latest.failures + 1, 12);
    const wait = failures < 5 ? 0 : Math.min(300_000, 30_000 * 2 ** (failures - 5));
    save({ ...latest, failures, retryAt: wait ? now() + wait : 0 });
    throw new Error(wait ? 'PINの入力回数が上限に達しました。しばらく待ってからお試しください。' : 'PINが正しくありません。');
  }

  async function authenticate(latest, pin) {
    if (latest.retryAt > now()) throw new Error('しばらく待ってからPINを入力してください。');
    if (!isPin(pin)) throw new Error('PINを半角数字6桁で入力してください。');
    const correct = await matchesPin(crypto, pin, latest);
    const refreshed = refresh();
    if (refreshed?.salt !== latest.salt || refreshed.locked !== latest.locked) {
      throw new Error('別のタブで画面ロックの状態が変わりました。');
    }
    if (refreshed.retryAt > now()) throw new Error('しばらく待ってからPINを入力してください。');
    if (!correct) rejectPin(refreshed);
    return refreshed;
  }

  async function configure({ uid, enabled, minutes, pin, currentPin }) {
    if (!available) throw new Error('このブラウザーでは画面ロックを設定できません。');
    return exclusive(async () => {
      let latest = refresh();
      if (latest?.locked || (latest && latest.uid !== uid)) throw new Error('この画面ロックは設定したアカウントで変更してください。');
      if (typeof uid !== 'string' || !uid || typeof enabled !== 'boolean' || !deviceLockIntervals.includes(minutes)) {
        throw new Error('画面ロックの設定を確認してください。');
      }
      if (latest) latest = await authenticate(latest, currentPin);
      if (!enabled) { save(null); return; }
      let salt = latest?.salt;
      let verifier = latest?.verifier;
      if (pin || !latest) {
        if (!isPin(pin)) throw new Error('新しいPINを半角数字6桁で入力してください。');
        salt = encodeHex(crypto.getRandomValues(new Uint8Array(16)));
        verifier = await digestPin(crypto, pin, salt);
      }
      const updated = refresh();
      if (updated?.salt !== latest?.salt || updated?.locked !== latest?.locked) {
        throw new Error('別のタブで画面ロックの状態が変わりました。');
      }
      localDeadline = 0;
      save({ uid, minutes, salt, verifier, locked: false, deadline: now() + minutes * minute, failures: 0, retryAt: 0 });
    });
  }

  async function unlock(pin) {
    return exclusive(async () => {
      const latest = refresh();
      if (!latest?.locked) return;
      const verified = await authenticate(latest, pin);
      save({ ...verified, locked: false, deadline: now() + verified.minutes * minute, failures: 0, retryAt: 0 });
    });
  }

  function resetAfterIdentityCheck(uid) {
    const latest = refresh();
    if (!latest || latest.uid !== uid) throw new Error('画面ロックを設定したアカウントで本人確認してください。');
    save(null);
  }

  if (available) {
    record = read();
    check();
  }
  return { get snapshot() { return snapshot(); }, check, activity, lock, configure, unlock, resetAfterIdentityCheck };
}

export function memoryLockStorage() {
  let value = null;
  return { getItem: () => value, setItem: (_key, data) => { value = data; }, removeItem: () => { value = null; } };
}

export const deviceLockStorageKey = storageKey;
