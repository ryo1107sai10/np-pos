import { backupColumns, backupPath, backupPrefix, decryptBackupPart, encryptBackupPart, importBackupKey, maxEncryptedBackupPartBytes } from './backup-format.mjs';
import { prepared, readRows, resultRow } from './db-queries.mjs';

const minute = 60_000;
const startMinute = 6 * 60 + 15;
const backupPageBytes = 512 * 1024;
const backupPageRows = 160;
const maximumStagedStores = 4;
const sourceScopes = {
  np_stores:'id = ?',
  np_groups:'id IN (SELECT group_id FROM np_group_stores WHERE store_id = ?)',
  np_group_stores:'store_id = ?',
  np_group_members:'group_id IN (SELECT group_id FROM np_group_stores WHERE store_id = ?)',
  np_group_invites:'group_id IN (SELECT group_id FROM np_group_stores WHERE store_id = ?)',
  np_store_access_blocks:'store_id = ?',
  np_members:'store_id = ?',
  np_invites:'store_id = ?',
  np_member_role_profiles:'store_id = ?',
  np_invite_role_profiles:'invite_id IN (SELECT id FROM np_invites WHERE store_id = ?)',
  np_state_chunks:'store_id = ?',
};

export function dailyBackupDay(now, bootstrapDay) {
  const local = new Date(now + 9 * 60 * minute);
  const day = local.toISOString().slice(0,10);
  return day === bootstrapDay || local.getUTCHours() * 60 + local.getUTCMinutes() >= startMinute ? day : null;
}

async function putArchiveObject(bucket,key,path,record) {
  const encrypted = await encryptBackupPart(key,path,record);
  const saved = await bucket.put(path,encrypted,{
    onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'},
  });
  if (saved) return;
  const existing = await bucket.get(path);
  if (!existing) throw new Error('Backup object raced with removal');
  if (existing.size > maxEncryptedBackupPartBytes) throw new Error('Backup object exceeds the size limit');
  const restored = await decryptBackupPart(key,path,new Uint8Array(await existing.arrayBuffer()));
  if (JSON.stringify(restored) !== JSON.stringify(record)) throw new Error('Conflicting encrypted backup object');
}

function claimJob(db,day,now) {
  return resultRow(db,`UPDATE np_backup_jobs SET lease_token = ?, lease_until = ?, last_error = NULL
    WHERE (backup_day,store_id) = (
      SELECT backup_day,store_id FROM np_backup_jobs WHERE phase <> 'complete' AND retry_at <= ? AND lease_until <= ?
        AND (backup_day = ? OR phase <> 'capture')
        AND (phase <> 'capture' OR (
          SELECT COUNT(*) FROM np_backup_jobs
          WHERE phase IN ('snapshot','ledger','publish') OR (phase = 'capture' AND lease_until > ?)
        ) < ?)
      ORDER BY (phase = 'capture'),backup_day,retry_at,store_id LIMIT 1
    ) RETURNING *`,crypto.randomUUID(),now + 4 * minute,now,now,day,now,maximumStagedStores);
}

const jobScope = 'backup_day = ? AND store_id = ? AND lease_token = ?';
const jobArgs = (job) => [job.backup_day,job.store_id,job.lease_token];

async function captureSnapshot(db,job,now) {
  const ownsJob = `EXISTS (SELECT 1 FROM np_backup_jobs WHERE ${jobScope} AND phase = 'capture')`;
  const [day,storeId] = jobArgs(job);
  const stage = Object.entries(sourceScopes).map(([table,scope]) => {
    const hasPosition = table === 'np_state_chunks';
    const columns = backupColumns[table];
    const payload = hasPosition ? 'payload' : `json_array(${columns.join(',')})`;
    return prepared(db,`INSERT INTO np_backup_stage (backup_day,store_id,source_table,ordinal,payload)
      SELECT ?,?,?,${hasPosition ? 'position' : 'NULL'},${payload} FROM ${table}
      WHERE (${scope}) AND ${ownsJob} ORDER BY ${columns.slice(0,2).join(',')}`,
    day,storeId,table,storeId,...jobArgs(job));
  });
  await db.batch([
    ...stage,
    prepared(db,`UPDATE np_backup_jobs SET snapshot_revision = (SELECT revision FROM np_stores WHERE id = ?),
      stage_count = (SELECT COUNT(*) FROM np_backup_stage WHERE backup_day = ? AND store_id = ?),
      captured_at = ?, phase = 'snapshot', retry_at = ?, lease_token = NULL, lease_until = 0 WHERE ${jobScope}`,
    storeId,day,storeId,now,now,...jobArgs(job)),
  ]);
}

function snapshotPage(db,job) {
  return readRows(db,`WITH candidates AS (
    SELECT sequence,LENGTH(CAST(payload AS BLOB)) + 128 AS bytes FROM np_backup_stage
    WHERE backup_day = ? AND store_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
  ), sizes AS (
    SELECT sequence,SUM(bytes) OVER(ORDER BY sequence) AS total,ROW_NUMBER() OVER(ORDER BY sequence) AS rank FROM candidates
  )
  SELECT s.sequence,s.source_table,s.ordinal,s.payload,
    s.sequence = (SELECT MAX(sequence) FROM np_backup_stage WHERE backup_day = s.backup_day AND store_id = s.store_id) AS final_row
  FROM sizes JOIN np_backup_stage s ON s.sequence = sizes.sequence
  WHERE sizes.total <= ? OR sizes.rank = 1 ORDER BY s.sequence`,
  job.backup_day,job.store_id,job.stage_cursor,backupPageRows,backupPageBytes);
}

function ledgerPage(db,job) {
  return readRows(db,`WITH candidates AS (
    SELECT o.revision,COALESCE(LENGTH(CAST(a.payload AS BLOB)),0) + 512 AS bytes FROM np_operations o
    LEFT JOIN np_audit_events a ON a.store_id = o.store_id AND a.revision = o.revision
    WHERE o.store_id = ? AND o.revision > ? AND o.revision <= ? ORDER BY o.revision LIMIT ?
  ), sizes AS (
    SELECT revision,SUM(bytes) OVER(ORDER BY revision) AS total,ROW_NUMBER() OVER(ORDER BY revision) AS rank FROM candidates
  )
  SELECT o.operation_id,o.actor_uid,o.operation,o.fingerprint,o.revision,o.recorded_at,a.payload AS audit,a.operation_id AS audit_operation_id
  FROM sizes JOIN np_operations o ON o.store_id = ? AND o.revision = sizes.revision
  LEFT JOIN np_audit_events a ON a.store_id = o.store_id AND a.revision = o.revision
  WHERE sizes.total <= ? OR sizes.rank = 1 ORDER BY o.revision`,
  job.store_id,job.ledger_cursor,job.snapshot_revision,backupPageRows,job.store_id,backupPageBytes);
}

async function writePage(db,bucket,key,job,now) {
  const {backup_day:day,store_id:storeId,snapshot_revision:revision} = job;
  const snapshot = job.phase === 'snapshot';
  const page = snapshot ? await snapshotPage(db,job) : await ledgerPage(db,job);
  const phase = snapshot ? 'ledger' : 'publish';
  if (!page.length) {
    if (!snapshot && job.ledger_cursor !== revision) throw new Error('Backup ledger revisions are incomplete');
    await resultRow(db,`UPDATE np_backup_jobs SET phase = ?, retry_at = ?, lease_token = NULL, lease_until = 0
      WHERE ${jobScope} RETURNING phase`,phase,now,...jobArgs(job));
    return;
  }
  if (!snapshot && page.some(({revision:actual},index) => actual !== job.ledger_cursor + index + 1)) {
    throw new Error('Backup ledger has an unexpected revision gap');
  }
  if (!snapshot && page.some(({audit,operation_id,audit_operation_id}) => audit !== null && audit_operation_id !== operation_id)) {
    throw new Error('Backup audit has an unexpected operation reference');
  }
  const index = job.part_count + 1;
  const rows = snapshot ? page.map(({source_table,ordinal,payload}) => source_table === 'np_state_chunks'
    ? [source_table,[storeId,ordinal,payload]] : [source_table,JSON.parse(payload)])
    : page.map(({operation_id,actor_uid,operation,fingerprint,revision:rowRevision,recorded_at,audit}) => [
      [storeId,operation_id,actor_uid,operation,fingerprint,rowRevision,recorded_at],audit,
    ]);
  await putArchiveObject(bucket,key,backupPath(day,storeId,`part-${index}`),
    {day,storeId,revision,index,phase:job.phase,rows});
  const cursor = snapshot ? 'stage_cursor' : 'ledger_cursor';
  const end = snapshot ? page.at(-1).sequence : page.at(-1).revision;
  const lastPage = snapshot ? Boolean(page.at(-1).final_row) : end === revision;
  const next = lastPage ? (snapshot && revision === 0 ? 'publish' : phase) : job.phase;
  await resultRow(db,`UPDATE np_backup_jobs SET ${cursor} = ?, part_count = ?, phase = ?, retry_at = ?, lease_token = NULL, lease_until = 0
    WHERE ${jobScope} RETURNING phase`,end,index,next,now,...jobArgs(job));
}

async function publishBackup(db,bucket,key,job,now) {
  const {backup_day:day,store_id:storeId,snapshot_revision:revision,captured_at:capturedAt,part_count:partCount,stage_count:stageCount} = job;
  if (!Number.isSafeInteger(revision) || job.ledger_cursor !== revision || !partCount || !stageCount) {
    throw new Error('Backup is incomplete');
  }
  await putArchiveObject(bucket,key,backupPath(day,storeId,'manifest'),{day,storeId,revision,capturedAt,partCount,stageCount});
  await db.batch([
    prepared(db,`DELETE FROM np_backup_stage WHERE backup_day = ? AND store_id = ?
      AND EXISTS (SELECT 1 FROM np_backup_jobs WHERE ${jobScope})`,day,storeId,...jobArgs(job)),
    prepared(db,`UPDATE np_backup_jobs SET phase = 'complete', completed_at = ?, lease_token = NULL, lease_until = 0
      WHERE ${jobScope}`,now,...jobArgs(job)),
  ]);
}

async function publishDay(db,bucket,key,day,marker) {
  const totals = await resultRow(db,`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN phase = 'complete' THEN 1 ELSE 0 END),0) AS complete
    FROM np_backup_jobs WHERE backup_day = ?`,day);
  if (totals.complete === totals.total) {
    await putArchiveObject(bucket,key,marker,{day,storeCount:totals.complete});
  }
}

export async function runDailyBackup(env,{now=Date.now()}={}) {
  const bucket = env.NP_POS_BACKUPS;
  const day = dailyBackupDay(now,env.NP_POS_BACKUP_BOOTSTRAP_DAY);
  if (!day || env.NP_POS_BACKUP_RUN !== '1' || !bucket || !env.NP_POS_BACKUP_KEY) return;
  const marker = `${backupPrefix}/${day}/complete.npb`;
  if (await bucket.head(marker)) return;
  const key = await importBackupKey(env.NP_POS_BACKUP_KEY);
  const db = env.DB.withSession?.('first-primary') ?? env.DB;
  await prepared(db,`INSERT INTO np_backup_jobs (backup_day,store_id)
    SELECT ?,id FROM np_stores WHERE 1 ON CONFLICT DO NOTHING`,day).all();
  const job = await claimJob(db,day,now);
  if (!job) {
    await publishDay(db,bucket,key,day,marker);
    return;
  }
  try {
    if (job.phase === 'capture') await captureSnapshot(db,job,now);
    else if (job.phase === 'publish') await publishBackup(db,bucket,key,job,now);
    else await writePage(db,bucket,key,job,now);
  } catch (error) {
    await resultRow(db,`UPDATE np_backup_jobs SET retry_at = ?, last_error = ?, lease_token = NULL, lease_until = 0
      WHERE ${jobScope} RETURNING phase`,now + 5 * minute,job.phase,...jobArgs(job));
    throw error;
  }
}
