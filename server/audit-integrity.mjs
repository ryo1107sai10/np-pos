import { prepared, readRows, resultRow } from './db-queries.mjs';

const encoder = new TextEncoder();
const pageSize = 80;

function auditKey(secret) {
  return crypto.subtle.importKey('raw',encoder.encode(`np-pos:audit-integrity:v1:${secret.toLowerCase()}`),
    {name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}

function auditBytes(storeId,{revision,payload}) {
  return encoder.encode(JSON.stringify([storeId,revision,payload]));
}

async function signedRow(key,storeId,row) {
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC',key,auditBytes(storeId,row)));
  return [row.revision,Array.from(signature,(byte)=>byte.toString(16).padStart(2,'0')).join('')];
}

export async function mirrorAuditVault(db,binding,secret,{now = Date.now(),limit = 6} = {}) {
  if (!binding || !auditKeyAvailable(secret)) return;
  const vault = binding.withSession?.('first-primary') ?? binding;
  const cursor = (await resultRow(vault,'SELECT store_id FROM np_audit_vault_cursor WHERE id = 1'))?.store_id ?? '';
  const stores = await readRows(db,`SELECT id,revision FROM np_stores WHERE id > ? AND revision > 0 ORDER BY id LIMIT ?`,cursor,limit);
  const key = await auditKey(secret);
  let last = cursor;
  for (const {id,revision} of stores) {
    last = id;
    try {
      const observed = (await resultRow(vault,'SELECT revision FROM np_audit_vault_heads WHERE store_id = ?',id))?.revision ?? 0;
      if (revision <= observed) continue;
      const rows = await readRows(db,`WITH candidates AS (
        SELECT revision,length(CAST(payload AS BLOB)) AS bytes FROM np_audit_events
        WHERE store_id = ? AND revision > ? AND revision <= ? ORDER BY revision LIMIT ?
      ), sized AS (
        SELECT revision,ROW_NUMBER() OVER (ORDER BY revision) AS row_number,
          SUM(bytes) OVER (ORDER BY revision) AS total,COUNT(*) OVER () AS available FROM candidates
      ) SELECT a.revision,a.payload,s.available FROM sized s
        JOIN np_audit_events a ON a.store_id = ? AND a.revision = s.revision
        WHERE s.row_number <= ? AND (s.total <= 524288 OR s.row_number = 1) ORDER BY s.revision`,
      id,observed,revision,pageSize + 1,id,pageSize);
      const next = rows.length < (rows[0]?.available ?? 0) ? rows.at(-1).revision : revision;
      const signatures = await Promise.all(rows.map((row)=>signedRow(key,id,row)));
      await vault.batch([
        prepared(vault,`INSERT INTO np_audit_vault_signatures (store_id,revision,signature)
          SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?) WHERE 1
          ON CONFLICT DO NOTHING`,id,JSON.stringify(signatures)),
        prepared(vault,`INSERT INTO np_audit_vault_heads (store_id,revision,checked_at) VALUES (?,?,?)
          ON CONFLICT (store_id) DO UPDATE SET revision = excluded.revision, checked_at = excluded.checked_at
          WHERE excluded.revision > np_audit_vault_heads.revision`,id,next,now),
      ]);
    } catch (error) {
      console.error(JSON.stringify({event:'audit_vault_seal_failed',storeId:id,name:error.name}));
    }
  }
  await prepared(vault,`INSERT INTO np_audit_vault_cursor (id,store_id) VALUES (1,?)
    ON CONFLICT (id) DO UPDATE SET store_id = excluded.store_id`,stores.length < limit ? '' : last).all();
}

function auditKeyAvailable(secret) {
  return /^[0-9a-f]{64}$/i.test(secret ?? '');
}

export async function verifyAuditPage(binding,secret,storeId,{rows,minRevision,maxRevision,filtered,currentRevision}) {
  if (!binding || !auditKeyAvailable(secret)) return {status:'unavailable'};
  try {
    const vault = binding.withSession?.('first-primary') ?? binding;
    const head = await resultRow(vault,'SELECT revision,checked_at FROM np_audit_vault_heads WHERE store_id = ?',storeId);
    if (!head) return {status:currentRevision === 0 ? 'verified' : 'pending',through:0};
    const result = {through:head.revision,checkedAt:head.checked_at};
    if (currentRevision < head.revision) return {...result,status:'mismatch'};
    const sealedRows = rows.filter(({revision})=>revision <= head.revision);
    const signatures = filtered
      ? await readRows(vault,`SELECT revision,signature FROM np_audit_vault_signatures
        WHERE store_id = ? AND revision IN (SELECT value FROM json_each(?))`,storeId,JSON.stringify(sealedRows.map(({revision})=>revision)))
      : await readRows(vault,`SELECT revision,signature FROM np_audit_vault_signatures
        WHERE store_id = ? AND revision BETWEEN ? AND ? LIMIT 101`,storeId,minRevision,Math.min(maxRevision,head.revision));
    if (signatures.length !== sealedRows.length) return {...result,status:'mismatch'};
    const byRevision = new Map(signatures.map(({revision,signature})=>[revision,signature]));
    const key = await auditKey(secret);
    const valid = await Promise.all(sealedRows.map((row)=>{
      const signature = byRevision.get(row.revision);
      return typeof signature === 'string' && /^[0-9a-f]{64}$/.test(signature) && crypto.subtle.verify('HMAC',key,
        Uint8Array.from(signature.match(/../g),(byte)=>Number.parseInt(byte,16)),auditBytes(storeId,row));
    }));
    if (valid.includes(false)) return {...result,status:'mismatch'};
    return {...result,status:maxRevision > head.revision ? 'pending' : 'verified'};
  } catch (error) {
    console.error(JSON.stringify({event:'audit_vault_verification_failed',storeId,name:error.name}));
    return {status:'unavailable'};
  }
}
