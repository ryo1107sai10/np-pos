import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceLock, deviceLockStorageKey, memoryLockStorage } from '../docs/device-lock.mjs';

const fiveMinutes = 300_000;
const setup = { uid: 'employee', enabled: true, minutes: 5, pin: '052904' };

test('the PIN is opted in and salted, with an account-scoped settings change and manual lock across tabs', async () => {
  const storage = memoryLockStorage();
  const original = createDeviceLock({ storage });
  const sibling = createDeviceLock({ storage });
  assert.equal(original.snapshot.enabled, false);
  await original.configure(setup);
  const saved = JSON.parse(storage.getItem(deviceLockStorageKey));
  assert.match(saved.salt, /^[a-f0-9]{32}$/);
  assert.match(saved.verifier, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(saved, 'pin'), false);
  assert.equal(Object.values(saved).includes(setup.pin), false);
  assert.equal(sibling.check({ shared: true }).enabled, true);
  await assert.rejects(sibling.configure({ ...setup, uid: 'another' }), /設定したアカウント/);
  await assert.rejects(sibling.configure({ ...setup, pin: '010101', currentPin: '123456' }), /正しくありません/);
  await original.configure({ ...setup, currentPin: setup.pin, pin: '010101' });
  const updated = JSON.parse(storage.getItem(deviceLockStorageKey));
  assert.notEqual(updated.salt, saved.salt);
  assert.notEqual(updated.verifier, saved.verifier);

  sibling.lock();
  assert.equal(original.check({ shared: true }).locked, true);
  const reloaded = createDeviceLock({ storage });
  assert.equal(reloaded.snapshot.locked, true);
  await assert.rejects(reloaded.unlock(setup.pin), /正しくありません/);
  await reloaded.unlock('010101');
  assert.equal(sibling.check({ shared: true }).locked, false);
});

test('one tab extends the device deadline and a later reload checks the persisted idle state', async () => {
  const storage = memoryLockStorage();
  let time = 10_000;
  const options = { storage, now: () => time };
  const original = createDeviceLock(options);
  await original.configure(setup);
  const firstDeadline = time + fiveMinutes;
  const sibling = createDeviceLock(options);
  time += 12_000;
  sibling.activity();
  time = firstDeadline + 1;
  assert.equal(original.check().locked, false);
  time += 12_000;
  const reloaded = createDeviceLock(options);
  assert.equal(reloaded.snapshot.locked, true);
  assert.equal(sibling.check({ shared: true }).locked, true);
  await reloaded.unlock(setup.pin);
  assert.equal(original.check({ shared: true }).locked, false);
  assert.equal(JSON.parse(storage.getItem(deviceLockStorageKey)).deadline, time + fiveMinutes);
});

test('failed attempts persist across tabs and recovery clears only the verified account’s lock', async () => {
  const storage = memoryLockStorage();
  let time = 1;
  const options = { storage, now: () => time };
  const original = createDeviceLock(options);
  await original.configure(setup);
  original.lock();
  const sibling = createDeviceLock(options);
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects((attempt % 2 === 0 ? original : sibling).unlock('111111'), /正しくありません|上限/);
  }
  const throttled = createDeviceLock(options);
  assert.equal(throttled.snapshot.retryAt, 30_001);
  await assert.rejects(throttled.unlock(setup.pin), /しばらく/);
  assert.throws(() => throttled.resetAfterIdentityCheck('another'), /設定したアカウント/);
  time += 30_001;
  await throttled.unlock(setup.pin);
  assert.equal(throttled.snapshot.locked, false);
  assert.equal(throttled.snapshot.retryAt, 0);
  original.lock();
  throttled.resetAfterIdentityCheck(setup.uid);
  assert.equal(original.check({ shared: true }).enabled, false);
});
