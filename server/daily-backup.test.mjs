import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { backupPath, backupPrefix } from './backup-format.mjs';
import { dailyBackupDay, runDailyBackup } from './daily-backup.mjs';
import { applyCommand, createStore } from './database.mjs';
import { restoreArchives } from './restore-backup.mjs';
import { databaseAdapter, d1SeedSql, isolatedProject, seedRecoveryFixture, verifyRecovery } from './restore-drill.mjs';

const day = '2026-11-17';
const minute = 60_000;
const base = Date.parse(`${day}T06:15:00+09:00`);
const secret = '6a'.repeat(32);

function storage() {
  const objects = new Map();
  let byteVisits = 0;
  let loseNextAcknowledgement = false;
  return {
    objects,
    visits:() => byteVisits,
    loseNextAcknowledgement() { loseNextAcknowledgement = true; },
    async put(path,bytes,options) {
      assert.equal(options.onlyIf.etagDoesNotMatch,'*');
      if (objects.has(path)) return null;
      objects.set(path,Uint8Array.from(bytes));
      if (loseNextAcknowledgement) {
        loseNextAcknowledgement = false;
        throw new Error('Synthetic transport loss after durable object write');
      }
      return {};
    },
    async head(path) { byteVisits++; return objects.has(path) ? {} : null; },
    async get(path) {
      const bytes = objects.get(path);
      return bytes ? {arrayBuffer:async()=>bytes.slice().buffer} : null;
    },
    read(path) {
      assert.ok(objects.has(path),'Encrypted backup part is missing');
      return objects.get(path).slice();
    },
  };
}

async function verifyWithLocalD1(bucket,stores,expected) {
  const directory = await mkdtemp(join(tmpdir(),'np-pos-daily-restore-'));
  try {
    for (const [path,bytes] of bucket.objects) {
      const local = join(directory,path);
      await mkdir(dirname(local),{recursive:true});
      await writeFile(local,bytes,{mode:0o600});
    }
    const sql = join(directory,'verified.sql');
    execFileSync(process.execPath,[fileURLToPath(new URL('./restore-backup.mjs',import.meta.url)),
      '--day',day,'--store',stores[0],'--store',stores[1],'--directory',directory,'--out',sql],{
      env:{...process.env,NP_POS_BACKUP_KEY:secret},encoding:'utf8',timeout:20_000,
    });
    const d1 = isolatedProject(directory,'target');
    d1('execute','np-pos-recovery-demo',`--file=${sql}`);
    const exportFile = join(directory,'restored.sql');
    d1('export','np-pos-recovery-demo',`--output=${exportFile}`);
    const restored = new DatabaseSync(':memory:',{enableForeignKeyConstraints:false});
    try {
      restored.exec(await readFile(exportFile,'utf8'));
      await verifyRecovery(restored,expected);
    } finally { restored.close(); }
  } finally { await rm(directory,{recursive:true,force:true}); }
}

test('daily scheduler does not access storage before its JST window or without activation', async () => {
  const store = storage();
  const env = {NP_POS_BACKUPS:store,NP_POS_BACKUP_KEY:secret};
  assert.equal(dailyBackupDay(base-1),null);
  assert.equal(dailyBackupDay(base-1,'2026-11-16'),null);
  assert.equal(dailyBackupDay(base-1,day),day);
  assert.equal(dailyBackupDay(base),day);
  await runDailyBackup(env,{now:base});
  await runDailyBackup({...env,NP_POS_BACKUP_RUN:'1'},{now:base-1});
  assert.equal(store.visits(),0);
});

test('backup staging stays bounded during a vault outage and resumes all stores', async (t) => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  sqlite.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const db = databaseAdapter(sqlite);
  for (let index=0; index<6; index++) await createStore(db,{uid:'backup-qa-owner',email:'backup@example.test'},`合成店舗${index}`);
  const store = storage();
  let available = false;
  const put = (...args) => {
    if (!available) throw new Error('Synthetic vault outage');
    return store.put(...args);
  };
  const env = {DB:db,NP_POS_BACKUPS:{...store,put},NP_POS_BACKUP_KEY:secret,NP_POS_BACKUP_RUN:'1'};
  const active = sqlite.prepare('SELECT COUNT(DISTINCT store_id) AS total FROM np_backup_stage');
  for (let step=0; step<18; step++) {
    await runDailyBackup(env,{now:base+step*minute}).catch((error)=>assert.match(error.message,/Synthetic vault outage/));
    assert.ok(active.get().total <= 4);
  }
  assert.equal(active.get().total,4);
  available = true;
  const marker = `${backupPrefix}/${day}/complete.npb`;
  for (let step=18; step<50 && !store.objects.has(marker); step++) await runDailyBackup(env,{now:base+step*minute});
  assert.ok(store.objects.has(marker));
  assert.equal(active.get().total,0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM np_backup_jobs WHERE phase = 'complete'").get().total,6);
});

test('encrypted daily backup fences audit by captured revision and restores business data and permissions', async (t) => {
  const {sqlite,expected} = await seedRecoveryFixture();
  const migration = await readFile(new URL('./migrations/20261117-daily-backups.sql',import.meta.url),'utf8');
  sqlite.exec(migration);
  sqlite.exec(migration);
  const target = new DatabaseSync(':memory:');
  const imported = new DatabaseSync(':memory:',{enableForeignKeyConstraints:false});
  t.after(()=>{sqlite.close(); target.close(); imported.close();});
  const db = databaseAdapter(sqlite);
  const bucket = storage();
  const env = {DB:db,NP_POS_BACKUPS:bucket,NP_POS_BACKUP_KEY:secret,NP_POS_BACKUP_RUN:'1'};
  const marker = `${backupPrefix}/${day}/complete.npb`;
  const firstJob = sqlite.prepare('SELECT snapshot_revision,phase FROM np_backup_jobs WHERE store_id = ?');
  let tick = 0;
  while (tick < 12 && firstJob.get(expected.storeId)?.phase !== 'snapshot') {
    await runDailyBackup(env,{now:base+tick++*minute});
  }
  const first = firstJob.get(expected.storeId);
  assert.equal(first.phase,'snapshot');
  assert.equal(first.snapshot_revision,expected.revision);
  await applyCommand(db,{uid:'recovery-demo-owner',email:'restore-owner@example.test'},expected.storeId,{
    operationId:crypto.randomUUID(),expectedRevision:expected.revision,
    command:{type:'saveCustomer',customer:{name:'バックアップ取得後の架空顧客'}},
  });
  bucket.loseNextAcknowledgement();
  await assert.rejects(runDailyBackup(env,{now:base+tick++*minute}),/Synthetic transport loss/);
  for (; tick<42 && !bucket.objects.has(marker); tick++) await runDailyBackup(env,{now:base+tick*minute});
  assert.ok(bucket.objects.has(marker));
  const copies = bucket.objects.size;
  await runDailyBackup(env,{now:base+60*minute});
  assert.equal(bucket.objects.size,copies);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM np_backup_stage').get().total,0);
  assert.ok([...bucket.objects.values()].every((bytes)=>!Buffer.from(bytes).includes('合成顧客')));

  const stores = [expected.storeId,expected.otherStoreId];
  const manifests = await restoreArchives(target,secret,day,stores,bucket.read);
  assert.equal(manifests[0].revision,expected.revision);
  await verifyRecovery(target,expected);
  imported.exec(d1SeedSql(target));
  await verifyRecovery(imported,expected);
  if (process.env.NP_POS_TEST_D1_RESTORE === '1') await verifyWithLocalD1(bucket,stores,expected);

  const corrupted = new DatabaseSync(':memory:');
  t.after(()=>corrupted.close());
  const part = backupPath(day,expected.storeId,'part-1');
  const corruptRead = (path) => {
    const bytes = bucket.read(path);
    if (path === part) bytes[bytes.length-1] ^= 1;
    return bytes;
  };
  await assert.rejects(restoreArchives(corrupted,secret,day,stores,corruptRead));
  assert.equal(corrupted.prepare('SELECT COUNT(*) AS total FROM np_stores').get().total,0);
  await assert.rejects(restoreArchives(corrupted,'aa'.repeat(32),day,stores,bucket.read));
  await assert.rejects(restoreArchives(corrupted,secret,day,stores,(path) => {
    if (path === part) throw new Error('Encrypted part is missing');
    return bucket.read(path);
  }),/missing/);
});
