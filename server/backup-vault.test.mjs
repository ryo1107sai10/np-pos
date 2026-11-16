import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { backupPath, backupPrefix } from './backup-format.mjs';
import { openBackupVault, readVaultCiphertext } from './backup-vault.mjs';

function vault(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./backup-vault.sql',import.meta.url),'utf8'));
  t.after(() => sqlite.close());
  const db = {
    prepare: (sql) => ({bind: (...args) => ({
      all: async () => ({results:sqlite.prepare(sql).all(...args)}),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
    })}),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = await Promise.all(statements.map((statement) => statement.all()));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return {store:openBackupVault(db),sqlite};
}

const conditional = {onlyIf:{etagDoesNotMatch:'*'}};
const recent = '2026-11-17';

test('vault reconstructs chunked ciphertext and never overwrites a committed object',async (t) => {
  const {store,sqlite} = vault(t);
  const key = backupPath(recent,'synthetic-store','part-1');
  const ciphertext = Uint8Array.from({length:1_200_001},(_,index) => index % 251);
  assert.equal(await store.head(key),null);
  assert.equal((await store.put(key,ciphertext,conditional)).size,ciphertext.length);
  assert.equal(await store.put(key,new Uint8Array([1,2]),conditional),null);
  assert.deepEqual(new Uint8Array(await (await store.get(key)).arrayBuffer()),ciphertext);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM np_backup_vault_chunks').get().count,3);
  sqlite.prepare('DELETE FROM np_backup_vault_chunks WHERE position = 1').run();
  await assert.rejects(() => store.get(key).then((entry) => entry.arrayBuffer()),/Incomplete backup vault object/);
  assert.throws(() => readVaultCiphertext([]),/Invalid backup vault object/);
});

test('completed backup retains the latest 30 calendar days as complete sets',async (t) => {
  const {store} = vault(t);
  const expired = backupPath('2026-10-18','synthetic-store','manifest');
  const edge = backupPath('2026-10-19','synthetic-store','manifest');
  const bytes = new Uint8Array([10,20,30]);
  await store.put(expired,bytes,conditional);
  await store.put(edge,bytes,conditional);
  await store.put(`${backupPrefix}/${recent}/complete.npb`,bytes,conditional);
  assert.equal(await store.head(expired),null);
  assert.ok(await store.head(edge));
});
