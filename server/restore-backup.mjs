import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { link, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { backupColumns, backupPath, decryptBackupPart, importBackupKey, maxEncryptedBackupPartBytes } from './backup-format.mjs';
import { d1RestoreStatements } from './restore-drill.mjs';

const schemaPath = new URL('./schema.sql',import.meta.url);
const groupTables = new Set(['np_groups','np_group_members','np_group_invites']);
const run = promisify(exec);
const recordNumber = (value) => Number.isSafeInteger(value) && value >= 0;

function requireManifest(data,day,storeId) {
  if (data?.day !== day || data.storeId !== storeId
    || !recordNumber(data.revision) || !recordNumber(data.capturedAt)
    || !Number.isSafeInteger(data.stageCount) || data.stageCount < 1
    || !Number.isSafeInteger(data.partCount) || data.partCount < 1 || data.partCount > data.stageCount + data.revision) {
    throw new Error('Invalid or incomplete backup manifest');
  }
}

function scopeRow(table,row,storeId,groupId,inviteIds) {
  if (table === 'np_groups') return groupId === null && typeof row[0] === 'string';
  if (table === 'np_group_stores') return row[0] === storeId && groupId !== null && row[1] === groupId;
  if (table === 'np_group_members') return groupId !== null && row[0] === groupId;
  if (table === 'np_group_invites') return groupId !== null && row[1] === groupId;
  if (table === 'np_invite_role_profiles') return inviteIds.has(row[0]);
  if (table === 'np_invites') return row[1] === storeId;
  return row[0] === storeId;
}

async function restoreStore(sqlite,key,day,storeId,read,groups) {
  const load = async (file) => {
    const path = backupPath(day,storeId,file);
    return decryptBackupPart(key,path,new Uint8Array(await read(path)));
  };
  const manifest = await load('manifest');
  requireManifest(manifest,day,storeId);
  if (sqlite.prepare('SELECT id FROM np_stores WHERE id = ?').get(storeId)) throw new Error('A store may be restored only once per recovery set');
  const statements = new Map();
  const insert = (table,row) => {
    const columns = Object.hasOwn(backupColumns,table) ? backupColumns[table] : null;
    if (!columns || !Array.isArray(row) || row.length !== columns.length
      || row.some((value)=>value !== null && typeof value !== 'string' && !Number.isSafeInteger(value))) {
      throw new Error('The backup contains an invalid record');
    }
    if (!statements.has(table)) {
      statements.set(table,sqlite.prepare(`INSERT INTO ${table} (${columns.join(',')})
        VALUES (${columns.map(() => '?').join(',')})`));
    }
    statements.get(table).run(...row);
  };
  let snapshotRows = 0;
  let expectedRevision = 1;
  let ledgerStarted = false;
  let groupId = null;
  const groupRows = [];
  const inviteIds = new Set();
  for (let index = 1; index <= manifest.partCount; index++) {
    const part = await load(`part-${index}`);
    if (part?.day !== day || part.storeId !== storeId || part.revision !== manifest.revision || part.index !== index
      || !Array.isArray(part.rows) || !part.rows.length || !['snapshot','ledger'].includes(part.phase)) {
      throw new Error('Invalid backup part sequence');
    }
    for (const [first,second] of part.rows) {
      if (part.phase === 'snapshot') {
        if (ledgerStarted || !Array.isArray(second) || ['np_operations','np_audit_events'].includes(first)
          || !scopeRow(first,second,storeId,groupId,inviteIds)) throw new Error('Invalid store snapshot record');
        if (first === 'np_groups') groupId = second[0];
        if (first === 'np_invites') inviteIds.add(second[0]);
        if (groupTables.has(first)) {
          groupRows.push([first,second]);
          if (!groups.has(groupId)) insert(first,second);
        } else insert(first,second);
        snapshotRows++;
      } else {
        ledgerStarted = true;
        if (!Array.isArray(first) || first[0] !== storeId || first[5] !== expectedRevision
          || expectedRevision > manifest.revision || (second !== null && typeof second !== 'string')) {
          throw new Error('Invalid backup ledger record');
        }
        insert('np_operations',first);
        if (second !== null) insert('np_audit_events',[storeId,first[1],expectedRevision,second]);
        expectedRevision++;
      }
    }
  }
  if (groupId !== null) {
    const fingerprint = JSON.stringify(groupRows);
    if (groups.has(groupId) && groups.get(groupId) !== fingerprint) throw new Error('Group permissions differ between backup cuts');
    groups.set(groupId,fingerprint);
  }
  const stored = sqlite.prepare('SELECT revision FROM np_stores WHERE id = ?').get(storeId);
  const chunks = sqlite.prepare('SELECT position,payload FROM np_state_chunks WHERE store_id = ? ORDER BY position').all(storeId);
  if (stored?.revision !== manifest.revision || snapshotRows !== manifest.stageCount || expectedRevision !== manifest.revision + 1
    || chunks.some(({position},index)=>position !== index) || (manifest.revision > 0 && chunks.length === 0)) {
    throw new Error('Backup contents do not match the completed manifest');
  }
  if (chunks.length) {
    const state = JSON.parse(chunks.map(({payload})=>payload).join(''));
    if (!state?.day?.date || !['tables','tickets','closedDays','stock'].every((key)=>Array.isArray(state[key]))) {
      throw new Error('The restored business snapshot is invalid');
    }
  }
  return manifest;
}

export async function restoreArchives(sqlite,secret,day,storeIds,read) {
  const key = await importBackupKey(secret);
  sqlite.exec(await readFile(schemaPath,'utf8'));
  const groups = new Map();
  const manifest = [];
  sqlite.exec('BEGIN');
  try {
    for (const storeId of storeIds) manifest.push(await restoreStore(sqlite,key,day,storeId,read,groups));
    assert.deepEqual(sqlite.prepare('PRAGMA integrity_check').all().map(({integrity_check})=>integrity_check),['ok']);
    assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
  return manifest;
}

async function main() {
  const {values} = parseArgs({options:{
    day:{type:'string'},store:{type:'string',multiple:true},directory:{type:'string'},bucket:{type:'string'},out:{type:'string'},
  }});
  if (!values.day || !values.store?.length || !values.out || Boolean(values.bucket) === Boolean(values.directory)
    || (values.bucket && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(values.bucket))) {
    throw new Error('Specify --day YYYY-MM-DD --store STORE_ID [--store STORE_ID] --directory LOCAL_DIRECTORY or --bucket R2_BUCKET, and --out PATH.sql');
  }
  const output = resolve(values.out);
  const temporary = await mkdtemp(join(dirname(output),'.np-pos-restore-'));
  try {
    const sqlite = new DatabaseSync(join(temporary,'verified.sqlite'));
    try {
      const readPart = async (file) => {
        if ((await stat(file)).size > maxEncryptedBackupPartBytes) throw new Error('Backup file exceeds the size limit');
        return readFile(file);
      };
      const read = values.directory ? (path) => readPart(join(values.directory,path)) : async (path) => {
        const file = join(temporary,'part.npb');
        await run('npx',['--offline','wrangler','r2','object','get',`${values.bucket}/${path}`,'--remote',`--file=${file}`],
          {cwd:fileURLToPath(new URL('../',import.meta.url)),timeout:60_000});
        return readPart(file);
      };
      const manifests = await restoreArchives(sqlite,process.env.NP_POS_BACKUP_KEY,values.day,values.store,read);
      const sql = join(temporary,'verified.sql');
      function* lines() {
        for (const statement of d1RestoreStatements(sqlite)) yield statement + '\n';
      }
      await pipeline(Readable.from(lines()),createWriteStream(sql,{flags:'wx',mode:0o600}));
      await link(sql,output);
      console.log(`Verified ${manifests.length} encrypted store backup(s). SQL is ready for import into an empty D1 database.`);
    } finally { sqlite.close(); }
  } finally { await rm(temporary,{recursive:true,force:true}); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
