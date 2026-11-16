import { apply, createDemo } from '../docs/engine.mjs';
import { getNextAutoExtensionAt } from '../docs/auto-extension.mjs';
import { getMonthlyReportSales, getReportDay } from '../docs/report-period.mjs';
import { getCustomRole, isCustomRoleId } from '../docs/role-policy.mjs';
import { ApiError, canOperate, projectState, requireCondition, roles, validateSnapshot, verifyCommand } from './policy.mjs';
import { emailAddress, prepared, readRows, resultRow } from './db-queries.mjs';
import { groupInviteAcceptance } from './store-groups.mjs';

const chunkLength = 200_000;
const maxSnapshotBytes = 7 * 1024 * 1024;
const textEncoder = new TextEncoder();

function storeResponse(row) {
  return { id: row.id, name: row.name, role: row.role, hasState: row.revision > 0, ...profileResponse(row) };
}

function profileResponse({profile_id:profileId}) {
  return profileId ? {profileId} : {};
}

function memberRequired(row) {
  requireCondition(row, 403, 'store-access', 'この店舗へのアクセス権がありません。');
  return row;
}

function adminRequired(row) {
  requireCondition(row.role === 'admin', 403, 'forbidden', '店舗管理者の権限が必要です。');
  return row;
}

export async function listStores(db, actor) {
  await db.batch([
    prepared(db, `INSERT INTO np_members (store_id, uid, email, role)
      SELECT invite.store_id, ?, invite.email, invite.role FROM np_invites invite
      WHERE invite.email = ?
      AND NOT EXISTS (SELECT 1 FROM np_store_access_blocks b WHERE b.store_id = invite.store_id
        AND (b.uid = ? OR b.email = invite.email) AND (b.uid <> ? OR b.invite_id IS NOT invite.id))
      ON CONFLICT DO NOTHING`, actor.uid, actor.email, actor.uid, actor.uid),
    prepared(db, `DELETE FROM np_store_access_blocks
      WHERE uid = ? AND EXISTS (
        SELECT 1 FROM np_invites i JOIN np_members m ON m.store_id = i.store_id AND m.uid = ? AND m.email = i.email
        WHERE i.store_id = np_store_access_blocks.store_id AND i.id = np_store_access_blocks.invite_id AND i.email = ?
      )`, actor.uid, actor.uid, actor.email),
    prepared(db, `INSERT INTO np_member_role_profiles (store_id, uid, profile_id)
      SELECT m.store_id, m.uid, p.profile_id FROM np_invite_role_profiles p JOIN np_invites i ON i.id = p.invite_id
      JOIN np_members m ON m.store_id = i.store_id AND m.email = i.email AND m.role = i.role
      JOIN np_store_access a ON a.store_id = m.store_id AND a.uid = m.uid AND a.source = 'direct'
      WHERE m.uid = ? AND m.email = ? ON CONFLICT DO NOTHING`,actor.uid,actor.email),
    prepared(db, `DELETE FROM np_invites
      WHERE email = ? AND EXISTS (SELECT 1 FROM np_members m
        WHERE m.store_id = np_invites.store_id AND m.uid = ? AND m.email = ?)`, actor.email, actor.uid, actor.email),
    ...groupInviteAcceptance(db, actor),
  ]);
  const rows = await readRows(db, `SELECT s.id, s.name, s.revision, m.role, p.profile_id
    FROM np_store_access m JOIN np_stores s ON s.id = m.store_id
    LEFT JOIN np_member_role_profiles p ON p.store_id = m.store_id AND p.uid = m.uid
    WHERE m.uid = ?
    ORDER BY s.created_at, s.id`, actor.uid);
  return { stores: rows.map(storeResponse) };
}

export async function getStoreOverview(db, actor) {
  const limit = 20;
  const rows = await readRows(db,`SELECT s.id,s.name FROM np_members m JOIN np_stores s ON s.id = m.store_id
    WHERE m.uid = ? AND m.role = 'admin' ORDER BY s.created_at,s.id LIMIT ?`,actor.uid,limit + 1);
  const stores = [];
  for (const {id,name} of rows.slice(0,limit)) {
    let current;
    try { current = await snapshot(db,actor,id); }
    catch (error) {
      if (error instanceof ApiError && error.code === 'store-access') continue;
      throw error;
    }
    if (current.role !== 'admin') continue;
    const {date,status} = current.state.day;
    const day = getReportDay(current.state,date);
    const dailySales = day?.current.sales ?? 0;
    stores.push({id,name,date,status,dailySales,monthlySales:getMonthlyReportSales(current.state,date.slice(0,7),day?.current),
      hasState:current.revision > 0});
  }
  return {stores,...(rows.length > limit && {truncated:true})};
}

export async function createStore(db, actor, name) {
  const label = typeof name === 'string' ? name.trim() : '';
  requireCondition(label.length > 0 && label.length <= 60 && !/[\u0000-\u001f]/.test(label),
    400, 'invalid-store-name', '店舗名を入力してください。');
  const id = crypto.randomUUID();
  await db.batch([
    prepared(db, 'INSERT INTO np_stores (id, name, owner_uid, created_at) VALUES (?, ?, ?, ?)', id, label, actor.uid, Date.now()),
    prepared(db, `INSERT INTO np_members (store_id, uid, email, role) VALUES (?, ?, ?, 'admin')`, id, actor.uid, actor.email),
  ]);
  return { store: { id, name: label, role: 'admin', hasState: false } };
}

function findMembership(db, actor, storeId) {
  return resultRow(db, `SELECT s.id, s.owner_uid, s.revision, m.role, p.profile_id FROM np_stores s
    INNER JOIN np_store_access m ON m.store_id = s.id
    LEFT JOIN np_member_role_profiles p ON p.store_id = m.store_id AND p.uid = m.uid
    WHERE s.id = ? AND m.uid = ?`, storeId, actor.uid);
}

export async function listMembers(db, actor, storeId) {
  const store = adminRequired(memberRequired(await findMembership(db, actor, storeId)));
  const [members, invites, blocks] = await db.batch([
    prepared(db, `SELECT m.uid, m.email, m.role, m.source, p.profile_id, (m.uid = s.owner_uid) AS is_primary
      FROM np_store_access m JOIN np_stores s ON s.id = m.store_id
      LEFT JOIN np_member_role_profiles p ON p.store_id = m.store_id AND p.uid = m.uid
      WHERE m.store_id = ? AND EXISTS (SELECT 1 FROM np_store_access a WHERE a.store_id = m.store_id AND a.uid = ? AND a.role = 'admin')
      ORDER BY is_primary DESC, m.email`, storeId, actor.uid),
    prepared(db, `SELECT i.id, i.email, i.role, p.profile_id FROM np_invites i
      LEFT JOIN np_invite_role_profiles p ON p.invite_id = i.id WHERE i.store_id = ?
      AND EXISTS (SELECT 1 FROM np_store_access a WHERE a.store_id = i.store_id AND a.uid = ? AND a.role = 'admin')
      ORDER BY i.created_at, i.id`, storeId, actor.uid),
    prepared(db, `SELECT b.uid, b.email, gm.role AS group_role FROM np_store_access_blocks b
      LEFT JOIN np_group_stores gs ON gs.store_id = b.store_id
      LEFT JOIN np_group_members gm ON gm.group_id = gs.group_id AND gm.uid = b.uid
      WHERE b.store_id = ? AND EXISTS (SELECT 1 FROM np_store_access a WHERE a.store_id = b.store_id AND a.uid = ? AND a.role = 'admin')
      ORDER BY b.email`, storeId, actor.uid),
  ]);
  requireCondition(members.results?.length, 403, 'forbidden', '店舗管理者の権限が必要です。');
  return {
    members: members.results.map(({ is_primary, profile_id, ...member }) => ({ ...member, primary: Boolean(is_primary), ...profileResponse({profile_id}) })),
    invites: (invites.results ?? []).map(({profile_id,...invite}) => ({...invite,...profileResponse({profile_id})})),
    blocks: (blocks.results ?? []).map(({group_role, ...block}) => ({...block, groupRole:group_role})),
    canRestore: store.owner_uid === actor.uid,
  };
}

async function resolveStoreRole(db,actor,storeId,choice) {
  if (roles.has(choice)) return {role:choice,profileId:null,profileRevision:null};
  requireCondition(isCustomRoleId(choice),400,'invalid-role','権限を選択してください。');
  const {state,revision} = adminRequired(await snapshot(db,actor,storeId));
  const profile = getCustomRole(state,choice);
  requireCondition(profile,409,'role-not-found','カスタム役職が見つかりません。最新の設定を確認してください。');
  return {role:profile.base,profileId:choice,profileRevision:revision};
}

function assignMemberProfile(db,storeId,uid,profileId,condition,args) {
  return profileId ? prepared(db,`INSERT INTO np_member_role_profiles (store_id,uid,profile_id)
    SELECT ?,?,? WHERE ${condition} ON CONFLICT (store_id,uid) DO UPDATE SET profile_id = excluded.profile_id`,
  storeId,uid,profileId,...args)
    : prepared(db,`DELETE FROM np_member_role_profiles WHERE store_id = ? AND uid = ? AND ${condition}`,storeId,uid,...args);
}

export async function inviteMember(db, actor, storeId, emailInput, choice) {
  adminRequired(memberRequired(await findMembership(db, actor, storeId)));
  const email = emailAddress(emailInput);
  const {role,profileId,profileRevision} = await resolveStoreRole(db,actor,storeId,choice);
  const [created] = await db.batch([
    prepared(db, `INSERT INTO np_invites (id, store_id, email, role, created_at)
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM np_store_access a WHERE a.store_id = ? AND a.uid = ? AND a.role = 'admin')
    AND NOT EXISTS (SELECT 1 FROM np_members m WHERE m.store_id = ? AND m.email = ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM np_stores s WHERE s.id = ? AND s.revision = ?))
    AND (EXISTS (SELECT 1 FROM np_stores s WHERE s.id = ? AND s.owner_uid = ?)
      OR NOT EXISTS (SELECT 1 FROM np_store_access_blocks b WHERE b.store_id = ? AND b.email = ?))
    ON CONFLICT (store_id, email) DO UPDATE SET role = excluded.role
    RETURNING id, email, role`, crypto.randomUUID(), storeId, email, role, Date.now(), storeId, actor.uid, storeId, email,
    profileRevision,storeId,profileRevision,
    storeId, actor.uid, storeId, email),
    profileId ? prepared(db,`INSERT INTO np_invite_role_profiles (invite_id,profile_id)
      SELECT id, ? FROM np_invites WHERE store_id = ? AND email = ? AND changes() > 0
      ON CONFLICT (invite_id) DO UPDATE SET profile_id = excluded.profile_id`,profileId,storeId,email)
      : prepared(db,`DELETE FROM np_invite_role_profiles WHERE changes() > 0
        AND invite_id = (SELECT id FROM np_invites WHERE store_id = ? AND email = ?)`,storeId,email),
    prepared(db, `UPDATE np_store_access_blocks SET invite_id = (
      SELECT i.id FROM np_invites i WHERE i.store_id = ? AND i.email = ?
    ) WHERE store_id = ? AND email = ?
    AND EXISTS (SELECT 1 FROM np_stores s WHERE s.id = ? AND s.owner_uid = ?)`, storeId,email,storeId,email,storeId,actor.uid),
  ]);
  const invite = created.results?.[0];
  if (!invite) {
    const store = adminRequired(memberRequired(await findMembership(db, actor, storeId)));
    requireCondition(profileRevision === null || store.revision === profileRevision,409,'membership-conflict','最新の役職設定を確認してください。');
    const blocked = await resultRow(db,'SELECT uid FROM np_store_access_blocks WHERE store_id = ? AND email = ?',storeId,email);
    requireCondition(!blocked || store.owner_uid === actor.uid,403,'regrant-forbidden','アクセスを再付与できるのは店舗の作成者です。');
    throw new ApiError(409, 'already-member', 'このメールアドレスは既に店舗に所属しています。');
  }
  return { invite: {...invite,...(profileId && {profileId})} };
}

export async function changeMember(db, actor, storeId, uid, choice) {
  const member = adminRequired(memberRequired(await findMembership(db, actor, storeId)));
  requireCondition(uid !== member.owner_uid, 409, 'primary-member', '最初の管理者の所属と権限は変更できません。');
  const assignment = choice === undefined ? {} : await resolveStoreRole(db,actor,storeId,choice);
  const {role,profileId,profileRevision = null} = assignment;
  const target = await resultRow(db,`SELECT a.role, a.source, p.profile_id FROM np_store_access a
    LEFT JOIN np_member_role_profiles p ON p.store_id = a.store_id AND p.uid = a.uid WHERE a.store_id = ? AND a.uid = ?`,storeId,uid);
  requireCondition(target,404,'member-not-found','所属メンバーが見つかりません。');
  requireCondition(role === undefined || target.source === 'direct',409,'group-role','グループ経由の権限は店舗グループで変更してください。');
  if (target.role === 'cast' && role !== 'cast') return revokeCastMembership(db,actor,storeId,uid,role,profileId,profileRevision);
  const selector = `SELECT t.store_id, t.uid, t.email FROM np_store_access t JOIN np_stores s ON s.id = t.store_id
    LEFT JOIN np_member_role_profiles p ON p.store_id = t.store_id AND p.uid = t.uid
    WHERE t.store_id = ? AND t.uid = ? AND t.uid <> s.owner_uid AND t.role = ? AND t.source = ?
    AND p.profile_id IS ? AND (? IS NULL OR s.revision = ?)
    AND EXISTS (SELECT 1 FROM np_store_access a WHERE a.store_id = t.store_id AND a.uid = ? AND a.role = 'admin')`;
  const args = [storeId,uid,target.role,target.source,target.profile_id,profileRevision,profileRevision,actor.uid];
  let row;
  if (role === undefined) {
    row = await resultRow(db,`INSERT INTO np_store_access_blocks (store_id, uid, email) ${selector}
      ON CONFLICT DO NOTHING RETURNING uid`,...args);
  } else {
    const [updated] = await db.batch([
      prepared(db,`UPDATE np_members SET role = ? WHERE (store_id, uid, email) IN (${selector}) RETURNING uid`,role,...args),
      assignMemberProfile(db,storeId,uid,profileId,'changes() > 0',[]),
    ]);
    row = updated.results?.[0];
  }
  if (!row) {
    adminRequired(memberRequired(await findMembership(db, actor, storeId)));
    const fresh = await resultRow(db,'SELECT role FROM np_store_access WHERE store_id = ? AND uid = ?',storeId,uid);
    requireCondition(fresh,404,'member-not-found','所属メンバーが見つかりません。');
    throw new ApiError(409,'membership-conflict','メンバーの権限が更新されました。最新の内容を確認してください。');
  }
  return { ok: true };
}

export async function restoreGroupStoreMember(db, actor, storeId, uid) {
  const store = adminRequired(memberRequired(await findMembership(db, actor, storeId)));
  requireCondition(store.owner_uid === actor.uid,403,'regrant-forbidden','アクセスを再付与できるのは店舗の作成者です。');
  const eligible = `b.store_id = ? AND b.uid = ?
    AND EXISTS (SELECT 1 FROM np_stores s WHERE s.id = b.store_id AND s.owner_uid = ?)
    AND EXISTS (SELECT 1 FROM np_group_stores gs JOIN np_group_members gm ON gm.group_id = gs.group_id
      WHERE gs.store_id = b.store_id AND gm.uid = b.uid)`;
  const [, removed] = await db.batch([
    prepared(db,`DELETE FROM np_invites WHERE store_id = ? AND id IN (
      SELECT b.invite_id FROM np_store_access_blocks b WHERE ${eligible}
    )`,storeId,storeId,uid,actor.uid),
    prepared(db,`DELETE FROM np_store_access_blocks AS b WHERE ${eligible} RETURNING uid`,storeId,uid,actor.uid),
  ]);
  requireCondition(removed.results?.length,409,'group-access-unavailable','現在のグループ所属を確認してください。');
  return {ok:true};
}

export async function revokeInvite(db, actor, storeId, inviteId) {
  adminRequired(memberRequired(await findMembership(db, actor, storeId)));
  const row = await resultRow(db, `DELETE FROM np_invites WHERE store_id = ? AND id = ?
    AND EXISTS (SELECT 1 FROM np_store_access a WHERE a.store_id = ? AND a.uid = ? AND a.role = 'admin')
    RETURNING id`, storeId, inviteId, storeId, actor.uid);
  if (!row) {
    adminRequired(memberRequired(await findMembership(db, actor, storeId)));
    throw new ApiError(404, 'invite-not-found', '招待が見つかりません。');
  }
  return { ok: true };
}

async function snapshot(db, actor, storeId, since = null) {
  const rows = await readRows(db, `SELECT s.revision, m.role, p.profile_id, c.position, c.payload FROM np_stores s
    JOIN np_store_access m ON m.store_id = s.id AND m.uid = ?
    LEFT JOIN np_member_role_profiles p ON p.store_id = m.store_id AND p.uid = m.uid
    LEFT JOIN np_state_chunks c ON c.store_id = s.id AND m.role IN ('admin','manager','staff','cast')
      AND (m.role = 'cast' OR ? IS NULL OR s.revision <> ?)
    WHERE s.id = ? ORDER BY c.position`, actor.uid, since, since, storeId);
  const membership = memberRequired(rows[0]);
  const { revision, role } = membership;
  const profile = profileResponse(membership);
  if (!canOperate(role)) return { restricted: true, role, revision, ...profile };
  if (since === revision && role !== 'cast') return { unchanged: true, role, revision, ...profile };
  const chunks = rows.filter((row) => row.position !== null && row.position !== undefined).map(({ payload }) => payload);
  const state = chunks.length ? JSON.parse(chunks.join('')) : createDemo('closed');
  return { state, revision, role, chunks, ...profile };
}

function visibleSnapshot(result, actorUid) {
  if (result.restricted || result.unchanged) return result;
  const state = { ...result.state };
  delete state.auditLog;
  if (result.profileId && getCustomRole(state,result.profileId)?.base !== result.role) {
    return { restricted:true, role:result.role, revision:result.revision, profileId:result.profileId };
  }
  const projection = projectState(state, result.role, actorUid, result.profileId);
  if (result.role === 'cast') return {state:projection,scope:'cast',role:'cast',revision:result.revision,
    ...(!projection && {restricted:true})};
  return { state:projection, revision: result.revision, role: result.role, ...(result.profileId && {profileId:result.profileId}) };
}

function autoExtensionDue(state, now) {
  const deadline = state ? getNextAutoExtensionAt(state) : null;
  return deadline != null && deadline <= now;
}

function saveAutoExtensionSync(db, actor, storeId, current, now) {
  return saveOperation(db, actor, storeId, {
    operationId: crypto.randomUUID(), operation: 'command', value: {type:'syncAutoExtensions'},
    expectedRevision: current.revision,
  }, current, now);
}

async function readVisibleState(db, actor, storeId) {
  return visibleSnapshot(await snapshot(db, actor, storeId), actor.uid);
}

export async function readState(db, actor, storeId, since) {
  const current = await snapshot(db, actor, storeId, since);
  const now = Date.now();
  if (current.role !== 'cast' && autoExtensionDue(current.state, now)) return saveAutoExtensionSync(db, actor, storeId, current, now);
  return visibleSnapshot(current, actor.uid);
}

export async function listAudit(db, actor, storeId, { before = null, limit = 50, ticketId = null } = {}) {
  requireCondition(before === null || (Number.isSafeInteger(before) && before > 0),
    400, 'invalid-audit-cursor', '監査ログの表示位置を確認してください。');
  requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 100,
    400, 'invalid-audit-limit', '監査ログの表示件数を確認してください。');
  requireCondition(ticketId === null || typeof ticketId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(ticketId),
    400,'invalid-audit-target','伝票の操作履歴を確認してください。');
  const rows = await readRows(db, `SELECT m.role, e.revision, e.payload FROM np_store_access m
    LEFT JOIN np_audit_events e ON e.store_id = m.store_id AND m.role = 'admin'
      AND (? IS NULL OR e.revision < ?)
      AND (? IS NULL OR (json_extract(e.payload,'$.target.kind') = 'ticket' AND json_extract(e.payload,'$.target.id') = ?))
    WHERE m.store_id = ? AND m.uid = ? ORDER BY e.revision DESC LIMIT ?`,
  before, before, ticketId, ticketId, storeId, actor.uid, limit + 1);
  adminRequired(memberRequired(rows[0]));
  const page = rows.slice(0, limit).filter((row) => row.payload !== null);
  return {
    events: page.map(({ payload }) => JSON.parse(payload)),
    nextBefore: rows.length > limit ? page.at(-1).revision : null,
  };
}

function snapshotChunks(state) {
  const json = JSON.stringify(state);
  requireCondition(textEncoder.encode(json).length <= maxSnapshotBytes, 413, 'store-size',
    'この店舗のデータが、現在クラウドに保存できる容量を超えています。');
  const chunks = [];
  for (let start = 0; start < json.length;) {
    let end = Math.min(start + chunkLength, json.length);
    if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
    chunks.push(json.slice(start, end));
    start = end;
  }
  return chunks;
}

async function getFingerprint(operation, value) {
  const hash = await crypto.subtle.digest('SHA-256', textEncoder.encode(JSON.stringify([operation, value])));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function operationLog(db, storeId, operationId) {
  return resultRow(db, `SELECT actor_uid, fingerprint FROM np_operations WHERE store_id = ? AND operation_id = ?`, storeId, operationId);
}

function matchingOperation(record, actor, fingerprint) {
  if (!record) return false;
  requireCondition(record.actor_uid === actor.uid && record.fingerprint === fingerprint, 409, 'operation-reused',
    '同じ操作番号で異なる内容を保存できません。');
  return true;
}

const currentOperation = `EXISTS (SELECT 1 FROM np_operations o JOIN np_stores s ON s.id = o.store_id
  WHERE o.store_id = ? AND o.operation_id = ? AND o.actor_uid = ? AND o.revision = ? AND s.revision = ?)`;

function writeSnapshot(db, storeId, chunks, previousChunks, revision, conditionArgs) {
  const statements = [];
  for (const [position,payload] of chunks.entries()) {
    if (payload === previousChunks[position]) continue;
    statements.push(prepared(db, `INSERT INTO np_state_chunks (store_id, position, payload)
      SELECT ?, ?, ? WHERE ${currentOperation} ON CONFLICT (store_id, position) DO UPDATE SET payload = excluded.payload`,
    storeId,position,payload,...conditionArgs));
  }
  if (chunks.length < previousChunks.length) {
    statements.push(prepared(db, `DELETE FROM np_state_chunks WHERE store_id = ? AND position >= ? AND ${currentOperation}`,
      storeId,chunks.length,...conditionArgs));
  }
  statements.push(prepared(db,`UPDATE np_stores SET revision = ? WHERE id = ? AND ${currentOperation}`,revision,storeId,...conditionArgs));
  return statements;
}

async function revokeCastMembership(db,actor,storeId,memberUid,role,profileId,profileRevision) {
  const current = adminRequired(await snapshot(db,actor,storeId));
  requireCondition(profileRevision === null || current.revision === profileRevision,409,'membership-conflict','最新の役職設定を確認してください。');
  if (current.revision === 0) {
    const filter = `WHERE store_id = ? AND uid = ? AND role = 'cast'
      AND EXISTS (SELECT 1 FROM np_stores s WHERE s.id = ? AND s.revision = 0)
      AND EXISTS (SELECT 1 FROM np_store_access m WHERE m.store_id = ? AND m.uid = ? AND m.role = 'admin')`;
    const values = [storeId,memberUid,storeId,storeId,actor.uid];
    let row;
    if (role === undefined) {
      row = await resultRow(db,`INSERT INTO np_store_access_blocks (store_id, uid, email)
        SELECT store_id, uid, email FROM np_members ${filter} ON CONFLICT DO NOTHING RETURNING uid`,...values);
    } else {
      const [updated] = await db.batch([
        prepared(db,`UPDATE np_members SET role = ? ${filter} RETURNING uid`,role,...values),
        assignMemberProfile(db,storeId,memberUid,profileId,'changes() > 0',[]),
      ]);
      row = updated.results?.[0];
    }
    requireCondition(row,409,'membership-conflict','メンバーの権限が更新されました。最新の内容を確認してください。');
    return {ok:true};
  }
  const operationId = crypto.randomUUID();
  const revision = current.revision + 1;
  const oldLink = current.state.castAccounts?.find(({uid}) => uid === memberUid);
  const state = oldLink ? {...current.state,castAccounts:current.state.castAccounts.filter(({uid}) => uid !== memberUid)} : current.state;
  const now = Date.now();
  const fingerprint = await getFingerprint('revokeCastMembership',{memberUid,role:role ?? null});
  const args = [storeId,operationId,actor.uid,revision,current.revision];
  const statements = [prepared(db, `INSERT INTO np_operations (store_id, operation_id, actor_uid, operation, fingerprint, revision, recorded_at)
    SELECT s.id, ?, ?, 'revokeCastMembership', ?, ?, ? FROM np_stores s WHERE s.id = ? AND s.revision = ?
    AND EXISTS (SELECT 1 FROM np_store_access m WHERE m.store_id = s.id AND m.uid = ? AND m.role = 'admin')
    AND EXISTS (SELECT 1 FROM np_members t WHERE t.store_id = s.id AND t.uid = ? AND t.role = 'cast') ON CONFLICT DO NOTHING`,
  operationId,actor.uid,fingerprint,revision,now,storeId,current.revision,actor.uid,memberUid)];
  if (oldLink) {
    const payload = JSON.stringify({id:operationId,at:now,action:'bindCastAccount',businessDate:current.state.day.date,
      actor:{id:actor.uid,label:actor.email,role:'admin'},target:{kind:'cast',id:oldLink.castId,label:'キャスト本人アカウント'},
      before:{castId:oldLink.castId},after:null,reason:'アカウントの所属・権限変更により連携を解除'});
    statements.push(prepared(db,`INSERT INTO np_audit_events (store_id,operation_id,revision,payload)
      SELECT ?, ?, ?, ? WHERE ${currentOperation}`,storeId,operationId,revision,payload,...args));
  }
  const memberFilter = `WHERE store_id = ? AND uid = ? AND role = 'cast' AND ${currentOperation}`;
  if (role === undefined) statements.push(prepared(db,`INSERT INTO np_store_access_blocks (store_id, uid, email)
    SELECT store_id, uid, email FROM np_members ${memberFilter}`,storeId,memberUid,...args));
  else statements.push(
    prepared(db,`UPDATE np_members SET role = ? ${memberFilter}`,role,storeId,memberUid,...args),
    assignMemberProfile(db,storeId,memberUid,profileId,currentOperation,args),
  );
  // Advance the revision even when there was no link, so in-flight binds cannot target a membership that has been revoked and renewed.
  const chunks = oldLink ? snapshotChunks(state) : current.chunks;
  statements.push(...writeSnapshot(db,storeId,chunks,current.chunks,revision,args));
  const results = await db.batch(statements);
  if (!results[0]?.meta?.changes) {
    adminRequired(memberRequired(await findMembership(db,actor,storeId)));
    throw new ApiError(409,'membership-conflict','メンバーの権限が更新されました。最新の内容を確認してください。');
  }
  return {ok:true};
}

async function saveOperation(db, actor, storeId, command, observed, observedAt) {
  const { operationId, operation, value, expectedRevision = 0 } = command;
  requireCondition(typeof operationId === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(operationId),
    400, 'invalid-operation-id', '操作番号が無効です。');
  requireCondition(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
    400, 'invalid-revision', '保存番号が無効です。');
  const current = observed ?? await snapshot(db, actor, storeId);
  if (operation === 'migrate') adminRequired(current);
  else verifyCommand(current.role, value, current.state, current.profileId);
  const fingerprint = await getFingerprint(operation, value);
  if (matchingOperation(await operationLog(db, storeId, operationId), actor, fingerprint)) {
    return readVisibleState(db, actor, storeId);
  }
  const syncExtensions = operation === 'command' && value.type === 'syncAutoExtensions';
  const now = observedAt ?? Date.now();
  const due = operation === 'command' && current.role !== 'cast' && autoExtensionDue(current.state, now);
  if (syncExtensions && (!due || current.revision !== expectedRevision)) return visibleSnapshot(current, actor.uid);
  const checkRevision = (revision, role, profileId) => {
    requireCondition(role === current.role && profileId === current.profileId, 403, 'forbidden', '操作の権限が変更されました。');
    if (operation === 'migrate') {
      requireCondition(revision === 0, 409, 'migration-not-empty', '営業データがすでにある店舗には移行できません。');
    } else {
      requireCondition(revision === expectedRevision, 409, 'revision-conflict',
        '別の端末が更新しました。最新の内容を確認してからもう一度操作してください。');
    }
  };
  checkRevision(current.revision, current.role, current.profileId);
  if (due && !syncExtensions) {
    await saveAutoExtensionSync(db, actor, storeId, current, now);
    throw new ApiError(409, 'auto-extension-updated', '自動延長で伝票が更新されました。伝票を開き直して金額を確認してください。');
  }
  const operator = { id: actor.uid, label: actor.email, role: current.role, ...(current.profileId && {profileId:current.profileId}) };
  const binding = operation === 'command' && value.type === 'bindCastAccount';
  if (binding) requireCondition(current.revision > 0,409,'store-not-initialized','店舗の営業データを準備してからキャストを連携してください。');
  const bindingUid = binding && value.castId !== null ? value.memberUid : null;
  const requireBindableMember = async () => {
    if (!bindingUid) return;
    const target = await resultRow(db,'SELECT role FROM np_members WHERE store_id = ? AND uid = ?',storeId,bindingUid);
    requireCondition(target?.role === 'cast',422,'invalid-cast-member','この店舗に参加済みのキャストアカウントを選択してください。');
  };
  await requireBindableMember();
  let next;
  let event;
  if (operation === 'migrate') {
    next = validateSnapshot(value);
    event = { action: 'migrate', businessDate: next.day.date,
      target: { kind: 'store', id: storeId, label: '店舗データ' }, before: null,
      after: { tables: next.tables.length, tickets: next.tickets.length, closedDays: next.closedDays.length },
      reason: 'このブラウザーの営業データを移行' };
  }
  else {
    delete current.state.auditLog;
    try { next = apply(current.state, value, now, operator); }
    catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new ApiError(400, 'invalid-command', '入力した操作内容を確認してください。');
      }
      throw new ApiError(422, 'rejected-command', error.message);
    }
    if (value.type === 'seat') next.tickets.at(-1).seatedByUid = actor.uid;
    event = next.auditLog?.[0];
  }
  delete next.auditLog;
  const chunks = snapshotChunks(next);
  const revision = expectedRevision + 1;
  const conditionArgs = [storeId, operationId, actor.uid, revision, expectedRevision];
  const rolePolicyChange = operation === 'command' && value.type === 'saveRolePolicy';
  const declaredProfiles = rolePolicyChange ? JSON.stringify(Object.entries(next.rolePolicy.custom ?? {})
    .map(([id,{base}]) => id + '=' + base)) : null;
  const statements = [
    prepared(db, `INSERT INTO np_operations (store_id, operation_id, actor_uid, operation, fingerprint, revision, recorded_at)
      SELECT s.id, ?, m.uid, ?, ?, ?, ? FROM np_stores s JOIN np_store_access m ON m.store_id = s.id
      LEFT JOIN np_member_role_profiles p ON p.store_id = m.store_id AND p.uid = m.uid
      WHERE s.id = ? AND s.revision = ? AND m.uid = ? AND m.role = ? AND p.profile_id IS ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM np_members c WHERE c.store_id = s.id AND c.uid = ? AND c.role = 'cast'))
      AND (? IS NULL OR NOT EXISTS (
        SELECT mp.profile_id || '=' || nm.role FROM np_member_role_profiles mp
          JOIN np_members nm ON nm.store_id = mp.store_id AND nm.uid = mp.uid WHERE mp.store_id = s.id
        UNION SELECT ip.profile_id || '=' || ni.role FROM np_invite_role_profiles ip
          JOIN np_invites ni ON ni.id = ip.invite_id WHERE ni.store_id = s.id
        EXCEPT SELECT value FROM json_each(?)
      ))
      ON CONFLICT DO NOTHING`,
    operationId, operation === 'migrate' ? 'migrate' : value.type, fingerprint, revision, now, storeId, expectedRevision, actor.uid, current.role,
    current.profileId ?? null,bindingUid,bindingUid,declaredProfiles,declaredProfiles),
  ];
  if (event) {
    const payload = JSON.stringify({ ...event, id: operationId, at: now, actor: operator });
    statements.push(prepared(db, `INSERT INTO np_audit_events (store_id, operation_id, revision, payload)
      SELECT ?, ?, ?, ? WHERE ${currentOperation}`, storeId, operationId, revision, payload, ...conditionArgs));
  }
  statements.push(...writeSnapshot(db,storeId,chunks,current.chunks,revision,conditionArgs));
  const results = await db.batch(statements);
  if (!results[0]?.meta?.changes) {
    if (matchingOperation(await operationLog(db, storeId, operationId), actor, fingerprint) || syncExtensions) {
      return readVisibleState(db, actor, storeId);
    }
    const fresh = memberRequired(await findMembership(db, actor, storeId));
    checkRevision(fresh.revision, fresh.role, fresh.profile_id ?? undefined);
    await requireBindableMember();
    requireCondition(!rolePolicyChange,409,'role-in-use','メンバーや招待に使われているカスタム役職は削除・基本役職の変更ができません。');
    throw new ApiError(409, 'revision-conflict', '更新が重なりました。最新の内容を確認してください。');
  }
  return readVisibleState(db, actor, storeId);
}

export function applyCommand(db, actor, storeId, { operationId, command, expectedRevision }) {
  requireCondition(expectedRevision !== undefined, 400, 'invalid-revision', '保存番号が無効です。');
  return saveOperation(db, actor, storeId, { operationId, operation: 'command', value: command, expectedRevision });
}

export function migrateState(db, actor, storeId, { operationId, snapshot: value }) {
  return saveOperation(db, actor, storeId, { operationId, operation: 'migrate', value });
}
