import { prepared, resultRow } from './db-queries.mjs';
import { requireCondition } from './policy.mjs';

const encoder = new TextEncoder();
const lifetime = 10 * 60_000;
const requestInterval = 30_000;
const maxWebhookBytes = 256_000;
const api = 'https://api.line.me';
const botPattern = /^U[0-9a-f]{32}$/i;
const groupPattern = /^C[0-9a-f]{32}$/i;
const pairingIdPattern = /^[a-f0-9-]{36}$/;
const adminGuard = `EXISTS (SELECT 1 FROM np_store_access a WHERE a.store_id = ? AND a.uid = ? AND a.role = 'admin')`;

export function canPairLine(env) {
  return Boolean(typeof env.LINE_CHANNEL_ACCESS_TOKEN === 'string' && env.LINE_CHANNEL_ACCESS_TOKEN.trim()
    && typeof env.LINE_CHANNEL_SECRET === 'string' && env.LINE_CHANNEL_SECRET.trim());
}

async function hash(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
  return Array.from(bytes,(byte) => byte.toString(16).padStart(2,'0')).join('');
}

export async function lineCredentialId(env) {
  return canPairLine(env) ? hash(JSON.stringify(['np-pos.line.v1',env.LINE_CHANNEL_ACCESS_TOKEN,env.LINE_CHANNEL_SECRET])) : null;
}

async function requireAdmin(db,actor,storeId) {
  const access = await resultRow(db,`SELECT 1 AS allowed WHERE ${adminGuard}`,storeId,actor.uid);
  requireCondition(access,403,'line-forbidden','LINE通知の設定には店舗管理者の権限が必要です。');
}

async function lineApi(path,env,send) {
  try {
    const response = await send(`${api}${path}`,{headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`},
      redirect:'error',signal:AbortSignal.timeout(4_000)});
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

function checkedLabel(value) {
  return typeof value === 'string' ? [...value.replace(/[\p{C}\u2028\u2029]/gu,' ').trim()].slice(0,100).join('') : '';
}

export async function beginLinePairing(db,env,actor,storeId,{now = Date.now(),send = globalThis.fetch} = {}) {
  await requireAdmin(db,actor,storeId);
  const credentialId = await lineCredentialId(env);
  requireCondition(credentialId,409,'line-not-configured','公式アカウントの接続情報をCloudflareに登録してください。');
  const previous = await resultRow(db,`SELECT created_at FROM np_line_pairings WHERE store_id = ?`,storeId);
  requireCondition(!previous || previous.created_at <= now - requestInterval,429,'line-pairing-wait','30秒ほど待ってから接続コードを発行してください。');
  const bot = await lineApi('/v2/bot/info',env,send);
  requireCondition(typeof bot?.userId === 'string' && botPattern.test(bot.userId),409,'line-credentials-unverified',
    'LINE公式アカウントを確認できません。Cloudflareに登録したチャネルアクセストークンを確認してください。');
  const id = crypto.randomUUID();
  const code = crypto.randomUUID().replaceAll('-','');
  const expiresAt = now + lifetime;
  const stored = await resultRow(db,`INSERT INTO np_line_pairings (store_id,id,code_hash,credential_id,bot_id,requested_by,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${adminGuard}
    ON CONFLICT(store_id) DO UPDATE SET id=excluded.id,code_hash=excluded.code_hash,credential_id=excluded.credential_id,
      bot_id=excluded.bot_id,requested_by=excluded.requested_by,created_at=excluded.created_at,expires_at=excluded.expires_at,destination_id=NULL
    WHERE np_line_pairings.created_at <= ? RETURNING id`,storeId,id,await hash(code),credentialId,bot.userId,actor.uid,
  now,expiresAt,storeId,actor.uid,now - requestInterval);
  requireCondition(stored,409,'line-pairing-wait','30秒ほど待ってから接続コードを発行してください。');
  return {id,sendText:`NP POS 接続 ${code}`,expiresAt,officialAccount:checkedLabel(bot.displayName)};
}

async function candidate(db,env,actor,storeId,now) {
  const credentialId = await lineCredentialId(env);
  const pending = credentialId && await resultRow(db,`SELECT id,expires_at,destination_id FROM np_line_pairings
    WHERE store_id = ? AND requested_by = ? AND credential_id = ? AND expires_at > ? AND ${adminGuard}`,
  storeId,actor.uid,credentialId,now,storeId,actor.uid);
  return pending ? {...pending,credentialId} : null;
}

async function describeDestination(destination,env,send) {
  const group = groupPattern.test(destination);
  const lookup = group ? `/v2/bot/group/${destination}/summary` : `/v2/bot/profile/${destination}`;
  const profile = await lineApi(lookup,env,send);
  const name = checkedLabel(group ? profile?.groupName : profile?.displayName);
  requireCondition(name && (group ? profile.groupId : profile.userId) === destination,409,'line-destination-unverified',
    'LINEの送信先名を確認できません。対象トークで公式アカウントが利用できるか確認してください。');
  return `${group ? 'グループ' : '個別トーク'}「${name}」`;
}

export async function getLinePairing(db,env,actor,storeId,{now = Date.now(),send = globalThis.fetch} = {}) {
  await requireAdmin(db,actor,storeId);
  const pending = await candidate(db,env,actor,storeId,now);
  if (!pending) return {pairing:null};
  const {id,expires_at:expiresAt,destination_id:destination} = pending;
  const label = destination ? await describeDestination(destination,env,send) : null;
  return {pairing:{id,expiresAt,label}};
}

export async function confirmLinePairing(db,env,actor,storeId,input,{now = Date.now(),send = globalThis.fetch} = {}) {
  await requireAdmin(db,actor,storeId);
  const pending = await candidate(db,env,actor,storeId,now);
  requireCondition(typeof input?.id === 'string' && pairingIdPattern.test(input.id) && pending?.id === input.id
    && pending.destination_id,409,'line-pairing-unconfirmed','新しい接続コードを発行し、送信先の確認をやり直してください。');
  const {id,credentialId,destination_id:destination} = pending;
  const label = await describeDestination(destination,env,send);
  requireCondition(input.label === label,409,'line-destination-changed','LINEの送信先名が変わりました。送信先を再確認してください。');
  const matched = `EXISTS (SELECT 1 FROM np_line_destinations WHERE store_id = ? AND pairing_id = ?)`;
  const finishedAt = Math.max(now,Date.now());
  const [result] = await db.batch([
    prepared(db,`INSERT INTO np_line_destinations (store_id,pairing_id,destination_id,label,credential_id,confirmed_at,confirmed_by)
      SELECT store_id,id,destination_id,?,credential_id,?,? FROM np_line_pairings WHERE store_id = ? AND id = ? AND credential_id = ?
      AND destination_id = ? AND requested_by = ? AND expires_at > ? AND ${adminGuard}
      ON CONFLICT(store_id) DO UPDATE SET pairing_id=excluded.pairing_id,destination_id=excluded.destination_id,label=excluded.label,
        credential_id=excluded.credential_id,confirmed_at=excluded.confirmed_at,confirmed_by=excluded.confirmed_by RETURNING store_id`,
    label,finishedAt,actor.uid,storeId,id,credentialId,destination,actor.uid,finishedAt,storeId,actor.uid),
    prepared(db,`UPDATE np_line_settings SET enabled = 0, updated_at = ?, updated_by = ? WHERE store_id = ? AND ${matched}`,
    finishedAt,actor.uid,storeId,storeId,id),
    prepared(db,`UPDATE np_line_jobs SET status = 'cancelled', finished_at = ? WHERE store_id = ? AND status = 'pending' AND ${matched}`,
    finishedAt,storeId,storeId,id),
    prepared(db,`DELETE FROM np_line_pairings WHERE store_id = ? AND id = ? AND ${matched}`,storeId,id,storeId,id),
  ]);
  requireCondition(result.results?.length,409,'line-pairing-unconfirmed','新しい接続コードを発行し、送信先の確認をやり直してください。');
}

async function rawWebhookBody(request) {
  const capacity = Number(request.headers.get('content-length'));
  requireCondition(capacity <= maxWebhookBytes,413,'line-webhook-large','LINEイベントのサイズを確認してください。');
  const reader = request.body?.getReader();
  requireCondition(reader,400,'line-webhook-invalid','LINEイベントを確認してください。');
  const parts = [];
  let length = 0;
  while (true) {
    const {done,value} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxWebhookBytes) {
      await reader.cancel();
      requireCondition(false,413,'line-webhook-large','LINEイベントのサイズを確認してください。');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) { bytes.set(part,cursor); cursor += part.byteLength; }
  return bytes;
}

export async function processLineWebhook(db,env,request,now = Date.now()) {
  const credentialId = await lineCredentialId(env);
  requireCondition(credentialId,503,'line-not-configured','LINEの接続情報を登録してください。');
  const signature = request.headers.get('x-line-signature') ?? '';
  const signatureError = 'LINEイベントの署名を確認できません。';
  requireCondition(/^[A-Za-z0-9+/]{43}=$/.test(signature),401,'line-signature-invalid',signatureError);
  const raw = await rawWebhookBody(request);
  const key = await crypto.subtle.importKey('raw',encoder.encode(env.LINE_CHANNEL_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const verified = await crypto.subtle.verify('HMAC',key,Uint8Array.from(atob(signature),(char) => char.charCodeAt(0)),raw);
  requireCondition(verified,401,'line-signature-invalid',signatureError);
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)); }
  catch { requireCondition(false,400,'line-webhook-invalid','LINEイベントを確認してください。'); }
  requireCondition(typeof body?.destination === 'string' && botPattern.test(body.destination) && Array.isArray(body.events),
    400,'line-webhook-invalid','LINEイベントを確認してください。');
  for (const event of body.events) {
    if (event?.type !== 'message' || event.mode !== 'active' || event.message?.type !== 'text'
      || typeof event.message.text !== 'string' || !Number.isSafeInteger(event.timestamp) || event.timestamp > now + 5_000) continue;
    const code = /^NP POS 接続 ([a-f0-9]{32})$/.exec(event.message.text.trim())?.[1];
    const {type,groupId,userId} = event.source ?? {};
    const destination = type === 'group' && groupPattern.test(groupId) ? groupId
      : type === 'user' && botPattern.test(userId) ? userId : null;
    if (!code || !destination) continue;
    await resultRow(db,`UPDATE np_line_pairings SET destination_id = ? WHERE code_hash = ? AND bot_id = ? AND credential_id = ?
      AND expires_at > ? AND created_at <= ? AND destination_id IS NULL
      AND EXISTS (SELECT 1 FROM np_store_access a WHERE a.store_id = np_line_pairings.store_id
        AND a.uid = np_line_pairings.requested_by AND a.role = 'admin') RETURNING id`,destination,await hash(code),body.destination,
    credentialId,now,event.timestamp + 5_000);
  }
  return {ok:true};
}
