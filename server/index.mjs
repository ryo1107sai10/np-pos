import { createRemoteJWKSet, jwtVerify } from 'jose';
import { applyCommand, changeMember, createStore, getStoreOverview, inviteMember, listAudit, listMembers, listStores, migrateState, readState, restoreGroupStoreMember, revokeInvite, runScheduledAutoExtensions } from './database.mjs';
import { changeGroupMember, createStoreGroup, inviteGroupMember, listStoreGroups, renameStoreGroup, revokeGroupInvite, setGroupStore } from './store-groups.mjs';
import { ApiError, isRecord, requireCondition } from './policy.mjs';
import { answerGuideTopic, getGuideAccess } from './guide-assistant.mjs';
import { runDailyBackup } from './daily-backup.mjs';
import { openBackupVault } from './backup-vault.mjs';
import { mirrorAuditVault } from './audit-integrity.mjs';
import { dispatchLineJobs, getLineSettings, primeLineReminders, queueLineTest, saveLineSettings } from './line-notifications.mjs';
import { beginLinePairing, confirmLinePairing, getLinePairing, processLineWebhook } from './line-pairing.mjs';

const firebaseKeys = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
), { cacheMaxAge: 10 * 60_000, timeoutDuration: 4000 });
const defaultOrigin = 'https://ryo1107sai10.github.io';

function extraHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  let local = false;
  try {
    const url = new URL(origin);
    local = ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && url.origin === origin;
  } catch { /* An invalid Origin is not allowed. */ }
  const allowed = (env.ALLOWED_ORIGINS || defaultOrigin).split(',').map((item) => item.trim());
  requireCondition(local || allowed.includes(origin), 403, 'origin-forbidden', 'この場所からは接続できません。');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

async function firebaseActor(request, env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  requireCondition(projectId, 503, 'not-configured', 'クラウド保存の準備ができていません。');
  const authorization = request.headers.get('Authorization') ?? '';
  const token = /^Bearer ([\w.-]+)$/i.exec(authorization)?.[1];
  requireCondition(token && token.length <= 8192, 401, 'unauthenticated', 'ログインしてください。');
  let verified;
  try {
    verified = await jwtVerify(token, firebaseKeys, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
      requiredClaims: ['aud', 'iss', 'sub', 'iat', 'exp', 'auth_time'],
      clockTolerance: 5,
    });
  } catch {
    throw new ApiError(401, 'invalid-token', 'ログインの有効期限が切れました。もう一度ログインしてください。');
  }
  const { payload, protectedHeader } = verified;
  const now = Date.now() / 1000 + 5;
  requireCondition(typeof protectedHeader.kid === 'string' && protectedHeader.kid.length > 0
    && payload.aud === projectId && typeof payload.sub === 'string' && payload.sub.length > 0 && payload.sub.length <= 128
    && Number.isFinite(payload.iat) && payload.iat <= now
    && Number.isFinite(payload.auth_time) && payload.auth_time <= now,
  401, 'invalid-token', 'ログイン情報を確認できません。');
  requireCondition(payload.email_verified === true && typeof payload.email === 'string' && payload.email.length <= 254,
    403, 'email-unverified', 'メールアドレスの確認を済ませてからログインしてください。');
  return { uid: payload.sub, email: payload.email.trim().toLowerCase() };
}

async function jsonBody(request, limit = 512 * 1024) {
  requireCondition(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json',
    415, 'unsupported-content-type', '入力形式を確認してください。');
  const length = Number(request.headers.get('content-length'));
  const size = () => new ApiError(413, 'body-size', '入力データが大きすぎます。');
  if (length > limit) throw size();
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'invalid-body', '入力内容を確認してください。');
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw size();
    }
    body += decoder.decode(result.value, { stream: true });
  }
  body += decoder.decode();
  try {
    const data = JSON.parse(body);
    if (!isRecord(data)) throw new Error();
    return data;
  } catch {
    throw new ApiError(400, 'invalid-body', '入力内容を確認してください。');
  }
}

function sinceRevision(search) {
  const value = search.get('since');
  if (value === null || value === '') return null;
  requireCondition(/^\d+$/.test(value) && Number.isSafeInteger(Number(value)),
    400, 'invalid-revision', '保存番号が無効です。');
  return Number(value);
}

function auditPage(search) {
  const before = search.get('before');
  const limit = search.get('limit');
  const ticketId = search.get('ticketId');
  requireCondition(before === null || /^\d+$/.test(before), 400, 'invalid-audit-cursor', '監査ログの表示位置を確認してください。');
  requireCondition(limit === null || /^\d+$/.test(limit), 400, 'invalid-audit-limit', '監査ログの表示件数を確認してください。');
  requireCondition(ticketId === null || /^[a-zA-Z0-9_.:-]{1,128}$/.test(ticketId),
    400,'invalid-audit-target','伝票の操作履歴を確認してください。');
  return { before: before === null ? undefined : Number(before), limit: limit === null ? undefined : Number(limit),
    ticketId, registerDate:search.get('registerDate') };
}

function validPathId(value) {
  try {
    const id = decodeURIComponent(value);
    return typeof id === 'string' && id.length <= 128 && /^[a-zA-Z0-9_.:-]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function routeGroups(request, db, actor, [, rawGroup, section, rawId]) {
  const method = request.method;
  const groupId = rawGroup && validPathId(rawGroup);
  const id = rawId && validPathId(rawId);
  requireCondition((!rawGroup || groupId) && (!rawId || id), 404, 'not-found', 'ページが見つかりません。');
  if (!groupId) {
    if (method === 'GET') return listStoreGroups(db, actor);
    if (method === 'POST') return createStoreGroup(db, actor, (await jsonBody(request)).name);
  }
  if (groupId && !section && method === 'PATCH') {
    const { name } = await jsonBody(request);
    return renameStoreGroup(db, actor, groupId, name);
  }
  if (section === 'stores' && id && (method === 'PUT' || method === 'DELETE')) {
    return setGroupStore(db, actor, groupId, id, method === 'PUT');
  }
  if (section === 'members' && !id && method === 'POST') {
    const { email, role } = await jsonBody(request);
    return inviteGroupMember(db, actor, groupId, email, role);
  }
  if (section === 'members' && id && method === 'PATCH') {
    const { role } = await jsonBody(request);
    requireCondition(typeof role === 'string', 400, 'invalid-role', 'グループ権限を選択してください。');
    return changeGroupMember(db, actor, groupId, id, role);
  }
  if (section === 'members' && id && method === 'DELETE') return changeGroupMember(db, actor, groupId, id);
  if (section === 'invites' && id && method === 'DELETE') return revokeGroupInvite(db, actor, groupId, id);
  throw new ApiError(404, 'not-found', 'ページが見つかりません。');
}

async function route(request, env, url) {
  const method = request.method;
  if (method === 'GET' && url.pathname === '/api/health') {
    const row = await env.DB.prepare('SELECT 1 AS ready').first();
    return { ok: row?.ready === 1 };
  }
  if (method === 'POST' && url.pathname === '/api/line/webhook') {
    const db = env.DB.withSession?.('first-primary') ?? env.DB;
    return processLineWebhook(db,env,request);
  }
  const overview = method === 'GET' && url.pathname === '/api/stores/overview';
  const groupMatch = /^\/api\/groups(?:\/([^/]+)(?:\/(stores|members|invites)(?:\/([^/]+))?)?)?$/.exec(url.pathname);
  const match = /^\/api\/stores(?:\/([^/]+)\/(state|commands|migrate|members|invites|audit|guide|line-notifications)(?:\/([^/]+))?)?$/.exec(url.pathname);
  if (!overview && !match && !groupMatch) throw new ApiError(404, 'not-found', 'ページが見つかりません。');
  const actor = await firebaseActor(request, env);
  const db = env.DB.withSession?.('first-primary') ?? env.DB;
  if (groupMatch) return routeGroups(request, db, actor, groupMatch);
  if (overview) return getStoreOverview(db,actor);
  const [, rawStore, section, rawId] = match;
  if (!section) {
    if (method === 'GET') return listStores(db, actor);
    if (method === 'POST') return createStore(db, actor, (await jsonBody(request)).name);
  }
  const storeId = rawStore && validPathId(rawStore);
  const id = rawId && validPathId(rawId);
  requireCondition(storeId && (!rawId || id), 404, 'not-found', 'ページが見つかりません。');
  if (section === 'guide' && !id && ['GET','POST'].includes(method)) {
    const access = await getGuideAccess(db,env,actor,storeId);
    if (method === 'GET') return {enabled:access.enabled};
    return answerGuideTopic(db,env,storeId,access,(await jsonBody(request,1024)).topic);
  }
  if (section === 'line-notifications') {
    if (method === 'GET' && !id) return getLineSettings(db,env,actor,storeId);
    if (id === 'pairing') {
      if (method === 'GET') return getLinePairing(db,env,actor,storeId);
      if (method === 'POST') return beginLinePairing(db,env,actor,storeId);
      if (method === 'PATCH') {
        await confirmLinePairing(db,env,actor,storeId,await jsonBody(request,1024));
        return getLineSettings(db,env,actor,storeId);
      }
    }
    if (method === 'PATCH' && !id) {
      const settings = await saveLineSettings(db,env,actor,storeId,await jsonBody(request,1024));
      if (settings.enabled && settings.extension) {
        try { await primeLineReminders(db,storeId,await readState(db,actor,storeId)); }
        catch (error) { console.error(JSON.stringify({event:'line_reminder_initialization_failed',name:error.name})); }
      }
      return settings;
    }
    if (method === 'POST' && id === 'test') return queueLineTest(db,env,actor,storeId);
  }
  if (section === 'state' && method === 'GET' && !id) return readState(db, actor, storeId, sinceRevision(url.searchParams));
  if (section === 'audit' && method === 'GET' && !id) return listAudit(db, actor, storeId, auditPage(url.searchParams),{
    binding:env.NP_POS_BACKUP_VAULT,secret:env.NP_POS_AUDIT_KEY ?? env.NP_POS_BACKUP_KEY,
  });
  if (section === 'commands' && method === 'POST' && !id) return applyCommand(db, actor, storeId, await jsonBody(request));
  if (section === 'migrate' && method === 'POST' && !id) return migrateState(db, actor, storeId, await jsonBody(request, 8 * 1024 * 1024));
  if (section === 'members' && !id) {
    if (method === 'GET') return listMembers(db, actor, storeId);
    if (method === 'POST') {
      const { email, role } = await jsonBody(request);
      return inviteMember(db, actor, storeId, email, role);
    }
  }
  if (section === 'members' && id) {
    if (method === 'DELETE') return changeMember(db, actor, storeId, id);
    if (method === 'PUT') return restoreGroupStoreMember(db, actor, storeId, id);
    if (method === 'PATCH') {
      const { role } = await jsonBody(request);
      requireCondition(typeof role === 'string', 400, 'invalid-role', '権限を選択してください。');
      return changeMember(db, actor, storeId, id, role);
    }
  }
  if (section === 'invites' && method === 'DELETE' && id) return revokeInvite(db, actor, storeId, id);
  throw new ApiError(404, 'not-found', 'ページが見つかりません。');
}

export default {
  async scheduled(_controller,env) {
    const db = env.DB.withSession?.('first-primary') ?? env.DB;
    const backupEnv = env.NP_POS_BACKUP_VAULT && !env.NP_POS_BACKUPS
      ? {...env,NP_POS_BACKUPS:openBackupVault(env.NP_POS_BACKUP_VAULT)} : env;
    const [line,backup,extensions,audit] = await Promise.allSettled([
      dispatchLineJobs(db,env),runDailyBackup(backupEnv),runScheduledAutoExtensions(db),
      mirrorAuditVault(db,env.NP_POS_BACKUP_VAULT,env.NP_POS_AUDIT_KEY ?? env.NP_POS_BACKUP_KEY),
    ]);
    if (backup.status === 'rejected') console.error(JSON.stringify({event:'daily_backup_failed',name:backup.reason?.name ?? 'Error'}));
    if (extensions.status === 'rejected') console.error(JSON.stringify({event:'scheduled_auto_extensions_failed',name:extensions.reason?.name ?? 'Error'}));
    if (audit.status === 'rejected') console.error(JSON.stringify({event:'audit_vault_seal_failed',name:audit.reason?.name ?? 'Error'}));
    if (line.status === 'rejected') throw line.reason;
  },
  async fetch(request, env) {
    let headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    try {
      headers = { ...headers, ...extraHeaders(request, env) };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      return Response.json(await route(request, env, new URL(request.url)), { headers });
    } catch (error) {
      if (error instanceof ApiError) {
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
      }
      console.error('NP POS API request failed', error.name, error.message);
      return Response.json({ error: { code: 'server-error', message: '保存先に接続できません。少し待ってもう一度お試しください。' } },
        { status: 500, headers });
    }
  },
};
