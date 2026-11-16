import { getAutoExtensionNotices } from '../docs/auto-extension.mjs';
import { lineNotifications } from '../docs/line-notification-content.mjs';
import { prepared, readRows, resultRow } from './db-queries.mjs';
import { canPairLine, lineCredentialId } from './line-pairing.mjs';
import { requireCondition } from './policy.mjs';

const minute = 60_000;
const leadTime = 5 * minute;
const historyWindow = 7 * 24 * 60 * minute;
const readyLimit = 12;
const retryLimit = 4;
const linePushUrl = 'https://api.line.me/v2/bot/message/push';
const destinationPattern = /^[UCR][0-9a-f]{32}$/i;
const adminGuard = `EXISTS (SELECT 1 FROM np_store_access a WHERE a.store_id = ? AND a.uid = ? AND a.role = 'admin')`;
const activeJob = `EXISTS (SELECT 1 FROM np_line_settings s WHERE s.store_id = j.store_id AND s.enabled = 1
  AND s.configuration_id = j.configuration_id AND (j.kind = 'test' OR j.kind = 'extension' AND s.extension = 1
    OR j.kind = 'low-stock' AND s.low_stock = 1))`;

function destinations(env) {
  if (typeof env.LINE_CHANNEL_ACCESS_TOKEN !== 'string' || !env.LINE_CHANNEL_ACCESS_TOKEN.trim()
    || typeof env.LINE_DESTINATIONS_JSON !== 'string' || env.LINE_DESTINATIONS_JSON.length > 64_000) return {};
  try {
    const parsed = JSON.parse(env.LINE_DESTINATIONS_JSON);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function destinationFor(config,storeId) {
  const destination = Object.hasOwn(config,storeId) ? config[storeId] : null;
  return typeof destination === 'string' && destinationPattern.test(destination) ? destination : null;
}

async function recipientFor(db,storeId,credentialId,legacy) {
  const linked = await resultRow(db,'SELECT destination_id,label,credential_id FROM np_line_destinations WHERE store_id = ?',storeId);
  if (linked) return credentialId === linked.credential_id && destinationPattern.test(linked.destination_id)
    ? {destination:linked.destination_id,hash:await destinationHash(`${linked.destination_id}:${credentialId}`),label:linked.label} : null;
  const destination = destinationFor(legacy,storeId);
  return destination ? {destination,hash:await destinationHash(destination)} : null;
}

async function currentRecipient(db,env,storeId) {
  return recipientFor(db,storeId,await lineCredentialId(env),destinations(env));
}

async function destinationHash(destination) {
  if (!destination) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(destination)));
  return [...digest].map((byte) => byte.toString(16).padStart(2,'0')).join('');
}

function lineExtensionSignals(state,now) {
  return getAutoExtensionNotices(state,now,Number.MAX_SAFE_INTEGER).map(({ticketId,deadline}) => ({
    eventKey:`extension:${ticketId}:${deadline}`,kind:'extension',availableAt:Math.max(now,deadline - leadTime),expiresAt:deadline,
  }));
}

function hasLowStockCrossing(previous,next) {
  const old = new Map(previous.stock.map((item) => [item.id,item]));
  return next.stock.some(({id,quantity,minimum,hidden}) => {
    const prior = old.get(id);
    return prior && !hidden && !prior.hidden && prior.quantity > prior.minimum && quantity < prior.quantity && quantity <= minimum;
  });
}

function lineJobStatements(db,storeId,signals,{replaceExtensions,now,condition,conditionArgs}) {
  const statements = [];
  const jobs = JSON.stringify(signals.map((signal) => ({...signal,id:crypto.randomUUID()})));
  if (replaceExtensions) statements.push(prepared(db,`UPDATE np_line_jobs SET status = 'cancelled', finished_at = ?
    WHERE store_id = ? AND kind = 'extension' AND status = 'pending' AND expires_at > ?
    AND event_key NOT IN (SELECT json_extract(value,'$.eventKey') FROM json_each(?))
    AND ${condition}`,now,storeId,now,jobs,...conditionArgs));
  if (!signals.length) return statements;
  statements.push(prepared(db,`INSERT INTO np_line_jobs (id,store_id,event_key,configuration_id,kind,created_at,available_at,expires_at)
    SELECT json_extract(job.value,'$.id'),s.store_id,json_extract(job.value,'$.eventKey'),s.configuration_id,
      json_extract(job.value,'$.kind'),?,json_extract(job.value,'$.availableAt'),json_extract(job.value,'$.expiresAt')
    FROM json_each(?) job JOIN np_line_settings s ON s.store_id = ?
    WHERE s.enabled = 1 AND ((json_extract(job.value,'$.kind') = 'extension' AND s.extension = 1)
      OR (json_extract(job.value,'$.kind') = 'low-stock' AND s.low_stock = 1)) AND ${condition}
    ON CONFLICT (store_id,event_key) DO UPDATE SET configuration_id = excluded.configuration_id, status = 'pending',
      available_at = excluded.available_at, expires_at = excluded.expires_at, lease_until = 0, finished_at = NULL
    WHERE np_line_jobs.kind = 'extension' AND np_line_jobs.status = 'cancelled' AND np_line_jobs.attempts = 0`,
  now,jobs,storeId,...conditionArgs));
  return statements;
}

export function captureLineJobs(db,storeId,previous,next,{operationId,now,condition,conditionArgs}) {
  const previousExtensions = lineExtensionSignals(previous,now);
  const nextExtensions = lineExtensionSignals(next,now);
  const replaceExtensions = JSON.stringify(previousExtensions) !== JSON.stringify(nextExtensions);
  const signals = replaceExtensions ? nextExtensions : [];
  if (hasLowStockCrossing(previous,next)) signals.push({
    eventKey:`stock:${operationId}`,kind:'low-stock',availableAt:now,expiresAt:now + 30 * minute,
  });
  return lineJobStatements(db,storeId,signals,{replaceExtensions,now,condition,conditionArgs});
}

export async function getLineSettings(db,env,actor,storeId) {
  const [settings,history] = await db.batch([
    prepared(db,`SELECT s.id, l.destination_hash, l.enabled, l.extension, l.low_stock, l.updated_at FROM np_stores s
      LEFT JOIN np_line_settings l ON l.store_id = s.id WHERE s.id = ? AND ${adminGuard}`,storeId,storeId,actor.uid),
    prepared(db,`SELECT kind,status,created_at,finished_at FROM np_line_jobs
      WHERE store_id = ? AND ${adminGuard} AND (kind <> 'extension' OR status <> 'pending' OR available_at <= ?)
      ORDER BY created_at DESC,id LIMIT 8`,storeId,storeId,actor.uid,Date.now()),
  ]);
  const row = settings.results?.[0];
  requireCondition(row,403,'line-forbidden','LINE通知の設定には店舗管理者の権限が必要です。');
  const recipient = await currentRecipient(db,env,storeId);
  const hash = recipient?.hash;
  return {configured:Boolean(hash),canPair:canPairLine(env),destinationLabel:recipient?.label ?? null,
    enabled:Boolean(hash && row.enabled && row.destination_hash === hash),
    needsConfirmation:Boolean(hash && row.enabled && row.destination_hash !== hash),extension:Boolean(row.extension),lowStock:Boolean(row.low_stock),
    history:(history.results ?? []).map(({kind,status,created_at,finished_at}) => ({kind,status,createdAt:created_at,finishedAt:finished_at}))};
}

export async function saveLineSettings(db,env,actor,storeId,input) {
  await getLineSettings(db,env,actor,storeId);
  requireCondition(input && ['enabled','extension','lowStock'].every((key) => typeof input[key] === 'boolean'),
    400,'line-settings-invalid','LINE通知の設定を確認してください。');
  const hash = (await currentRecipient(db,env,storeId))?.hash ?? null;
  requireCondition(!input.enabled || hash,409,'line-not-configured','LINEの接続情報がまだ登録されていません。');
  const now = Date.now();
  const [settings] = await db.batch([
    prepared(db,`INSERT INTO np_line_settings (store_id,configuration_id,destination_hash,enabled,extension,low_stock,updated_at,updated_by)
      SELECT ?,?,?,?,?,?,?,? WHERE ${adminGuard}
      ON CONFLICT (store_id) DO UPDATE SET configuration_id = CASE WHEN enabled = excluded.enabled AND extension = excluded.extension
        AND low_stock = excluded.low_stock AND destination_hash IS excluded.destination_hash
        THEN configuration_id ELSE excluded.configuration_id END,
        destination_hash = excluded.destination_hash, enabled = excluded.enabled, extension = excluded.extension,
        low_stock = excluded.low_stock, updated_at = excluded.updated_at, updated_by = excluded.updated_by RETURNING store_id`,
    storeId,crypto.randomUUID(),hash,Number(input.enabled),Number(input.extension),Number(input.lowStock),now,actor.uid,storeId,actor.uid),
    prepared(db,`UPDATE np_line_jobs AS j SET status = 'cancelled', finished_at = ? WHERE store_id = ? AND status = 'pending'
      AND ${adminGuard} AND NOT ${activeJob}`,now,storeId,storeId,actor.uid),
  ]);
  requireCondition(settings.results?.length,403,'line-forbidden','LINE通知の設定には店舗管理者の権限が必要です。');
  return getLineSettings(db,env,actor,storeId);
}

export async function primeLineReminders(db,storeId,{state,revision},now = Date.now()) {
  if (!state || !Number.isSafeInteger(revision)) return;
  const signals = lineExtensionSignals(state,now);
  if (!signals.length) return;
  const condition = 'EXISTS (SELECT 1 FROM np_stores WHERE id = ? AND revision = ?)';
  await db.batch(lineJobStatements(db,storeId,signals,{replaceExtensions:true,now,condition,conditionArgs:[storeId,revision]}));
}

export async function queueLineTest(db,env,actor,storeId,now = Date.now()) {
  const settings = await getLineSettings(db,env,actor,storeId);
  requireCondition(settings.enabled,409,'line-disabled','LINE通知をオンにして保存してください。');
  const hash = (await currentRecipient(db,env,storeId))?.hash ?? null;
  const id = crypto.randomUUID();
  const queued = await resultRow(db,`INSERT INTO np_line_jobs (id,store_id,event_key,configuration_id,kind,created_at,available_at,expires_at)
    SELECT ?,store_id,?,configuration_id,'test',?,?,? FROM np_line_settings
    WHERE store_id = ? AND enabled = 1 AND destination_hash = ? AND ${adminGuard} AND NOT EXISTS (
      SELECT 1 FROM np_line_jobs WHERE store_id = ? AND kind = 'test' AND created_at > ?
    ) RETURNING id`,id,`test:${id}`,now,now,now + 10 * minute,storeId,hash,storeId,actor.uid,storeId,now - minute);
  requireCondition(queued,409,'line-test-wait','送信設定を確認し、1分ほど待ってからテストしてください。');
  return getLineSettings(db,env,actor,storeId);
}

export async function sendLineMessage({token,destination,kind,retryKey},send = globalThis.fetch) {
  let response;
  try {
    response = await send(linePushUrl,{
      method:'POST',redirect:'error',
      headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json','X-Line-Retry-Key':retryKey},
      body:JSON.stringify({to:destination,messages:[{type:'text',text:lineNotifications[kind].text}]}),
      signal:AbortSignal.timeout(6_000),
    });
  } catch { return {status:null,accepted:false,retry:true}; }
  const {status} = response;
  const accepted = response.ok || (status === 409 && Boolean(response.headers.get('x-line-accepted-request-id')));
  return {status,accepted,retry:status >= 500};
}

export async function dispatchLineJobs(db,env,{now=Date.now(),send=globalThis.fetch}={}) {
  const config = destinations(env);
  const credentialId = await lineCredentialId(env);
  if (!credentialId && !Object.keys(config).length) return;
  await db.batch([
    prepared(db,`UPDATE np_line_jobs SET status = 'expired', finished_at = ?
      WHERE status = 'pending' AND expires_at <= ? AND lease_until <= ?`,now,now,now),
    prepared(db,`DELETE FROM np_line_jobs WHERE finished_at < ?`,now - historyWindow),
    prepared(db,`DELETE FROM np_line_pairings WHERE expires_at <= ?`,now),
  ]);
  const rows = await readRows(db,`SELECT j.id FROM np_line_jobs j WHERE j.status = 'pending' AND j.available_at <= ? AND j.expires_at > ?
    AND j.lease_until <= ? ORDER BY j.expires_at,j.created_at LIMIT ?`,now,now,now,readyLimit);
  const results = await Promise.allSettled(rows.map(async ({id}) => {
    const job = await resultRow(db,`UPDATE np_line_jobs SET attempts = attempts + 1, lease_until = ?
      WHERE id = ? AND status = 'pending' AND available_at <= ? AND expires_at > ? AND lease_until <= ?
      RETURNING store_id, configuration_id, kind, attempts, expires_at`,now + minute,id,now,now,now);
    if (!job) return;
    const recipient = await recipientFor(db,job.store_id,credentialId,config);
    const hash = recipient?.hash;
    const current = hash && await resultRow(db,`SELECT 1 AS enabled FROM np_line_jobs j JOIN np_line_settings s ON s.store_id = j.store_id
      WHERE j.id = ? AND j.status = 'pending' AND j.attempts = ? AND s.destination_hash = ? AND ${activeJob}`,id,job.attempts,hash);
    const outcome = current && await sendLineMessage({token:env.LINE_CHANNEL_ACCESS_TOKEN,destination:recipient.destination,kind:job.kind,retryKey:id},send);
    const retryAt = now + minute * 2 ** (job.attempts - 1);
    const retry = Boolean(outcome?.retry && job.attempts < retryLimit && retryAt < job.expires_at);
    const status = !outcome ? 'cancelled' : outcome.accepted ? 'accepted' : retry ? 'pending' : 'failed';
    await resultRow(db,`UPDATE np_line_jobs SET status = ?, response_status = ?, available_at = ?, finished_at = ?, lease_until = 0
      WHERE id = ? AND status = 'pending' AND attempts = ? RETURNING id`,
    status,outcome?.status ?? null,retryAt,retry ? null : now,id,job.attempts);
  }));
  const failed = results.filter(({status}) => status === 'rejected').length;
  if (failed) console.error(JSON.stringify({event:'line_jobs_database_failure',count:failed}));
}
