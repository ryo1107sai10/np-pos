import { backupPrefix } from './backup-format.mjs';
import { prepared, readRows, resultRow } from './db-queries.mjs';

const chunkBytes = 512 * 1024;
const maxBytes = 8 * 1024 * 1024 + 32;
const dayMs = 86_400_000;
const backupKey = new RegExp(`^${backupPrefix}/(\\d{4}-\\d{2}-\\d{2})/(?:complete\\.npb|[A-Za-z0-9_-]{1,128}/(?:manifest|part-[1-9][0-9]*)\\.npb)$`);

function encodeBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start,start + 8192));
  return btoa(binary);
}

function decodeBase64(data) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function readVaultCiphertext(rows) {
  const length = rows[0]?.bytes;
  if (!Number.isSafeInteger(length) || length < 1 || length > maxBytes) throw new Error('Invalid backup vault object');
  const value = new Uint8Array(length);
  let written = 0;
  for (const [position,row] of rows.entries()) {
    const chunk = decodeBase64(row.ciphertext);
    if (row.position !== position || chunk.byteLength !== Math.min(chunkBytes,length - written)) throw new Error('Incomplete backup vault object');
    value.set(chunk,written);
    written += chunk.byteLength;
  }
  if (written !== length) throw new Error('Incomplete backup vault object');
  return value;
}

export function openBackupVault(binding,{now = Date.now} = {}) {
  const db = binding.withSession?.('first-primary') ?? binding;
  const remove = (id) => prepared(db,'DELETE FROM np_backup_vault_objects WHERE id = ?',id).all();
  return {
    async head(path) {
      return resultRow(db,'SELECT object_key AS key,bytes AS size FROM np_backup_vault_objects WHERE object_key = ?',path);
    },
    async get(path) {
      const rows = await readRows(db,`SELECT o.bytes,c.position,c.ciphertext FROM np_backup_vault_objects o
        JOIN np_backup_vault_chunks c ON c.object_id = o.id WHERE o.object_key = ? ORDER BY c.position`,path);
      return rows.length ? {arrayBuffer:async () => readVaultCiphertext(rows).buffer} : null;
    },
    async put(path, ciphertext, options) {
      const day = backupKey.exec(path)?.[1];
      if (!day || !(ciphertext instanceof Uint8Array) || ciphertext.byteLength < 1 || ciphertext.byteLength > maxBytes
        || options?.onlyIf?.etagDoesNotMatch !== '*') throw new Error('Invalid backup vault write');
      const id = crypto.randomUUID();
      const at = now();
      await prepared(db,'INSERT INTO np_backup_vault_objects (id,backup_day,created_at,bytes) VALUES (?,?,?,?)',id,day,at,ciphertext.byteLength).all();
      try {
        for (let offset = 0; offset < ciphertext.byteLength; offset += 2 * chunkBytes) {
          const statements = [];
          for (const start of [offset, offset + chunkBytes]) {
            if (start >= ciphertext.byteLength) break;
            const chunk = ciphertext.subarray(start,start + chunkBytes);
            statements.push(prepared(db,'INSERT INTO np_backup_vault_chunks (object_id,position,ciphertext) VALUES (?,?,?)',id,start / chunkBytes,encodeBase64(chunk)));
          }
          await db.batch(statements);
        }
        // The unique key becomes visible only after all pieces are saved.
        const stored = await resultRow(db,`UPDATE OR IGNORE np_backup_vault_objects SET object_key = ? WHERE id = ?
          RETURNING object_key AS key, bytes AS size`,path,id);
        if (!stored) { await remove(id); return null; }
        if (path === `${backupPrefix}/${day}/complete.npb`) {
          const cutoff = new Date(Date.parse(day) - 29 * dayMs).toISOString().slice(0,10);
          await prepared(db,`DELETE FROM np_backup_vault_objects WHERE backup_day < ?
            OR (object_key IS NULL AND created_at < ?)`,cutoff,at - dayMs).all().catch(() => {
            console.warn(JSON.stringify({event:'np_backup_vault_retention_retry'}));
          });
        }
        return stored;
      } catch (error) {
        // An ambiguous response must never remove a successfully sealed object.
        await prepared(db,'DELETE FROM np_backup_vault_objects WHERE id = ? AND object_key IS NULL',id).all().catch(() => {});
        throw error;
      }
    },
  };
}
