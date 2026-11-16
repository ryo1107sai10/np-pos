import { apply, createDemo } from '../docs/engine.mjs';
import { ApiError, canOperate, projectState, requireCondition, roles, validateSnapshot, verifyCommand } from './policy.mjs';

const chunkLength = 200_000;
const maxSnapshotBytes = 7 * 1024 * 1024;
const textEncoder = new TextEncoder();

function prepared(db, sql, ...args) {
  return db.prepare(sql).bind(...args);
}

async function readRows(db, sql, ...args) {
  return (await prepared(db, sql, ...args).all()).results ?? [];
}

function resultRow(db, sql, ...args) {
  return prepared(db, sql, ...args).first();
}

function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  requireCondition(email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    400, 'invalid-email', 'メールアドレスを確認してください。');
  return email;
}

function storeResponse(row) {
  return { id: row.id, name: row.name, role: row.role, hasState: row.revision > 0 };
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
      ON CONFLICT DO NOTHING`, actor.uid, actor.email),
    prepared(db, `DELETE FROM np_invites
      WHERE email = ? AND EXISTS (SELECT 1 FROM np_members m
        WHERE m.store_id = np_invites.store_id AND m.uid = ? AND m.email = ?)`, actor.email, actor.uid, actor.email),
  ]);
  const rows = await readRows(db, `SELECT s.id, s.name, s.revision, m.role
    FROM np_members m JOIN np_stores s ON s.id = m.store_id WHERE m.uid = ?
    ORDER BY s.created_at, s.id`, actor.uid);
  return { stores: rows.map(storeResponse) };
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
  return resultRow(db, `SELECT s.id, s.owner_uid, s.revision, m.role FROM np_stores s
    INNER JOIN np_members m ON m.store_id = s.id
    WHERE s.id = ? AND m.uid = ?`, storeId, actor.uid);
}

export async function listMembers(db, actor, storeId) {
  adminRequired(memberRequired(await findMembership(db, actor, storeId)));
  const [members, invites] = await db.batch([
    prepared(db, `SELECT m.uid, m.email, m.role, (m.uid = s.owner_uid) AS is_primary
      FROM np_members m JOIN np_stores s ON s.id = m.store_id
      WHERE m.store_id = ? AND EXISTS (SELECT 1 FROM np_members a WHERE a.store_id = m.store_id AND a.uid = ? AND a.role = 'admin')
      ORDER BY is_primary DESC, m.email`, storeId, actor.uid),
    prepared(db, `SELECT i.id, i.email, i.role FROM np_invites i WHERE i.store_id = ?
      AND EXISTS (SELECT 1 FROM np_members a WHERE a.store_id = i.store_id AND a.uid = ? AND a.role = 'admin')
      ORDER BY i.created_at, i.id`, storeId, actor.uid),
  ]);
  requireCondition(members.results?.length, 403, 'forbidden', '店舗管理者の権限が必要です。');
  return {
    members: members.results.map(({ is_primary, ...member }) => ({ ...member, primary: Boolean(is_primary) })),
    invites: invites.results ?? [],
  };
}

export async function inviteMember(db, actor, storeId, emailInput, role) {
  adminRequired(memberRequired(await findMembership(db, actor, storeId)));
  const email = emailAddress(emailInput);
  requireCondition(roles.has(role), 400, 'invalid-role', '権限を選択してください。');
  const invite = await resultRow(db, `INSERT INTO np_invites (id, store_id, email, role, created_at)
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM np_members a WHERE a.store_id = ? AND a.uid = ? AND a.role = 'admin')
    AND NOT EXISTS (SELECT 1 FROM np_members m WHERE m.store_id = ? AND m.email = ?)
    ON CONFLICT (store_id, email) DO UPDATE SET role = excluded.role
    RETURNING id, email, role`, crypto.randomUUID(), storeId, email, role, Date.now(), storeId, actor.uid, storeId, email);
  if (!invite) {
    adminRequired(memberRequired(await findMembership(db, actor, storeId)));
    throw new ApiError(409, 'already-member', 'このメールアドレスは既に店舗に所属しています。');
  }
  return { invite };
}

export async function changeMember(db, actor, storeId, uid, role) {
  const member = adminRequired(memberRequired(await findMembership(db, actor, storeId)));
  requireCondition(uid !== member.owner_uid, 409, 'primary-member', '最初の管理者の所属と権限は変更できません。');
  if (role !== undefined) requireCondition(roles.has(role), 400, 'invalid-role', '権限を選択してください。');
  const guards = `WHERE store_id = ? AND uid = ? AND uid <> (SELECT owner_uid FROM np_stores WHERE id = ?)
    AND EXISTS (SELECT 1 FROM np_members a WHERE a.store_id = ? AND a.uid = ? AND a.role = 'admin') RETURNING uid`;
  const row = role === undefined
    ? await resultRow(db, `DELETE FROM np_members ${guards}`, storeId, uid, storeId, storeId, actor.uid)
    : await resultRow(db, `UPDATE np_members SET role = ? ${guards}`, role, storeId, uid, storeId, storeId, actor.uid);
  if (!row) {
    adminRequired(memberRequired(await findMembership(db, actor, storeId)));
    throw new ApiError(404, 'member-not-found', '所属メンバーが見つかりません。');
  }
  return { ok: true };
}

export async function revokeInvite(db, actor, storeId, inviteId) {
  adminRequired(memberRequired(await findMembership(db, actor, storeId)));
  const row = await resultRow(db, `DELETE FROM np_invites WHERE store_id = ? AND id = ?
    AND EXISTS (SELECT 1 FROM np_members a WHERE a.store_id = ? AND a.uid = ? AND a.role = 'admin')
    RETURNING id`, storeId, inviteId, storeId, actor.uid);
  if (!row) {
    adminRequired(memberRequired(await findMembership(db, actor, storeId)));
    throw new ApiError(404, 'invite-not-found', '招待が見つかりません。');
  }
  return { ok: true };
}

async function snapshot(db, actor, storeId, since = null) {
  const rows = await readRows(db, `SELECT s.revision, m.role, c.position, c.payload FROM np_stores s
    JOIN np_members m ON m.store_id = s.id AND m.uid = ?
    LEFT JOIN np_state_chunks c ON c.store_id = s.id AND m.role IN ('admin','manager','staff') AND (? IS NULL OR s.revision <> ?)
    WHERE s.id = ? ORDER BY c.position`, actor.uid, since, since, storeId);
  const { revision, role } = memberRequired(rows[0]);
  if (!canOperate(role)) return { restricted: true, role, revision };
  if (since === revision) return { unchanged: true, role, revision };
  const chunks = rows.filter((row) => row.position !== null && row.position !== undefined).map(({ payload }) => payload);
  const state = chunks.length ? JSON.parse(chunks.join('')) : createDemo('closed');
  return { state, revision, role, chunks };
}

function visibleSnapshot(result, actorUid) {
  if (result.restricted || result.unchanged) return result;
  const state = { ...result.state };
  delete state.auditLog;
  return { state: projectState(state, result.role, actorUid), revision: result.revision, role: result.role };
}

export async function readState(db, actor, storeId, since) {
  return visibleSnapshot(await snapshot(db, actor, storeId, since), actor.uid);
}

export async function listAudit(db, actor, storeId, { before = null, limit = 50 } = {}) {
  requireCondition(before === null || (Number.isSafeInteger(before) && before > 0),
    400, 'invalid-audit-cursor', '監査ログの表示位置を確認してください。');
  requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 100,
    400, 'invalid-audit-limit', '監査ログの表示件数を確認してください。');
  const rows = await readRows(db, `SELECT m.role, e.revision, e.payload FROM np_members m
    LEFT JOIN np_audit_events e ON e.store_id = m.store_id AND m.role = 'admin'
      AND (? IS NULL OR e.revision < ?)
    WHERE m.store_id = ? AND m.uid = ? ORDER BY e.revision DESC LIMIT ?`,
  before, before, storeId, actor.uid, limit + 1);
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

async function saveOperation(db, actor, storeId, command) {
  const { operationId, operation, value, expectedRevision = 0 } = command;
  requireCondition(typeof operationId === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(operationId),
    400, 'invalid-operation-id', '操作番号が無効です。');
  requireCondition(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
    400, 'invalid-revision', '保存番号が無効です。');
  const current = await snapshot(db, actor, storeId);
  if (operation === 'migrate') adminRequired(current);
  else verifyCommand(current.role, value);
  const fingerprint = await getFingerprint(operation, value);
  if (matchingOperation(await operationLog(db, storeId, operationId), actor, fingerprint)) {
    return readState(db, actor, storeId);
  }
  const checkRevision = (revision, role) => {
    requireCondition(role === current.role, 403, 'forbidden', '操作の権限が変更されました。');
    if (operation === 'migrate') {
      requireCondition(revision === 0, 409, 'migration-not-empty', '営業データがすでにある店舗には移行できません。');
    } else {
      requireCondition(revision === expectedRevision, 409, 'revision-conflict',
        '別の端末が更新しました。最新の内容を確認してからもう一度操作してください。');
    }
  };
  checkRevision(current.revision, current.role);
  const now = Date.now();
  const operator = { id: actor.uid, label: actor.email, role: current.role };
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
  const statements = [
    prepared(db, `INSERT INTO np_operations (store_id, operation_id, actor_uid, operation, fingerprint, revision, recorded_at)
      SELECT s.id, ?, m.uid, ?, ?, ?, ? FROM np_stores s JOIN np_members m ON m.store_id = s.id
      WHERE s.id = ? AND s.revision = ? AND m.uid = ? AND m.role = ? ON CONFLICT DO NOTHING`,
    operationId, operation === 'migrate' ? 'migrate' : value.type, fingerprint, revision, now, storeId, expectedRevision, actor.uid, current.role),
  ];
  if (event) {
    const payload = JSON.stringify({ ...event, id: operationId, at: now, actor: operator });
    statements.push(prepared(db, `INSERT INTO np_audit_events (store_id, operation_id, revision, payload)
      SELECT ?, ?, ?, ? WHERE ${currentOperation}`, storeId, operationId, revision, payload, ...conditionArgs));
  }
  for (const [position, payload] of chunks.entries()) {
    if (payload === current.chunks[position]) continue;
    statements.push(prepared(db, `INSERT INTO np_state_chunks (store_id, position, payload)
      SELECT ?, ?, ? WHERE ${currentOperation} ON CONFLICT (store_id, position) DO UPDATE SET payload = excluded.payload`,
    storeId, position, payload, ...conditionArgs));
  }
  if (chunks.length < current.chunks.length) {
    statements.push(prepared(db, `DELETE FROM np_state_chunks WHERE store_id = ? AND position >= ? AND ${currentOperation}`,
      storeId, chunks.length, ...conditionArgs));
  }
  statements.push(prepared(db, `UPDATE np_stores SET revision = ? WHERE id = ? AND ${currentOperation}`,
    revision, storeId, ...conditionArgs));
  const results = await db.batch(statements);
  if (!results[0]?.meta?.changes) {
    if (matchingOperation(await operationLog(db, storeId, operationId), actor, fingerprint)) return readState(db, actor, storeId);
    const fresh = memberRequired(await findMembership(db, actor, storeId));
    checkRevision(fresh.revision, fresh.role);
    throw new ApiError(409, 'revision-conflict', '更新が重なりました。最新の内容を確認してください。');
  }
  return readState(db, actor, storeId);
}

export function applyCommand(db, actor, storeId, { operationId, command, expectedRevision }) {
  requireCondition(expectedRevision !== undefined, 400, 'invalid-revision', '保存番号が無効です。');
  return saveOperation(db, actor, storeId, { operationId, operation: 'command', value: command, expectedRevision });
}

export function migrateState(db, actor, storeId, { operationId, snapshot: value }) {
  return saveOperation(db, actor, storeId, { operationId, operation: 'migrate', value });
}
