import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { backupPrefix } from './backup-format.mjs';
import { readVaultCiphertext } from './backup-vault.mjs';

const {values} = parseArgs({options:{day:{type:'string'},directory:{type:'string'},local:{type:'boolean'}}});
const {day,directory,local} = values;
if (!directory || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || Number.isNaN(Date.parse(day))) {
  throw new Error('Usage: node server/export-backup-vault.mjs --day YYYY-MM-DD --directory OUTPUT [--local]');
}
const base = `${backupPrefix}/${day}/`;
const storeFile = /^[A-Za-z0-9_-]{1,128}\/(?:manifest|part-[1-9][0-9]*)\.npb$/;
const validKey = (key) => key.startsWith(base) && (key === `${base}complete.npb` || storeFile.test(key.slice(base.length)));

function query(sql) {
  const stdout = execFileSync('npx',['--offline','wrangler','d1','execute','np-pos-backup-vault',local ? '--local' : '--remote',
    '--json','--command',sql],{encoding:'utf8',maxBuffer:24 * 1024 * 1024});
  const reply = JSON.parse(stdout)[0];
  if (!reply?.success) throw new Error('Could not read the backup vault');
  return reply.results;
}

process.umask(0o077);
const target = resolve(directory);
const entries = query(`SELECT object_key FROM np_backup_vault_objects WHERE backup_day = '${day}' AND object_key IS NOT NULL ORDER BY object_key`);
const keys = entries.map(({object_key}) => object_key);
const marker = `${base}complete.npb`;
if (!keys.includes(marker) || !keys.every(validKey)) throw new Error('No completed daily backup exists for that date');
for (const key of [...keys.filter((value) => value !== marker),marker]) {
  const rows = query(`SELECT o.bytes,c.position,c.ciphertext FROM np_backup_vault_objects o JOIN np_backup_vault_chunks c ON c.object_id = o.id
    WHERE o.object_key = '${key}' ORDER BY c.position`);
  const dest = resolve(target,key);
  await mkdir(dirname(dest),{recursive:true});
  await writeFile(dest,readVaultCiphertext(rows),{flag:'wx'});
}
console.log(`Exported ${keys.length} encrypted objects for ${day}.`);
