import { emailAddress, prepared, resultRow } from './db-queries.mjs';
import { requireCondition } from './policy.mjs';

const ownerGuard = 'EXISTS (SELECT 1 FROM np_groups g WHERE g.id = ? AND g.owner_uid = ?)';
const groupRoles = new Set(['manager', 'staff']);

function groupName(value) {
  const name = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  requireCondition(name.length > 0 && name.length <= 60 && !/[\p{Cc}\u2028\u2029]/u.test(name),
    400, 'invalid-group-name', 'グループ名を60文字以内で入力してください。');
  return name;
}

function requireRole(role) {
  requireCondition(groupRoles.has(role), 400, 'invalid-role', 'グループ権限を選択してください。');
}

async function requireGroupOwner(db, actor, groupId) {
  const owned = await resultRow(db, 'SELECT id FROM np_groups WHERE id = ? AND owner_uid = ?', groupId, actor.uid);
  requireCondition(owned, 403, 'group-forbidden', 'グループの管理権限が必要です。');
}

export function groupInviteAcceptance(db, actor) {
  return [
    prepared(db, `INSERT INTO np_group_members (group_id, uid, email, role)
      SELECT i.group_id, ?, i.email, i.role FROM np_group_invites i
      JOIN np_groups g ON g.id = i.group_id
      WHERE i.email = ? AND g.owner_uid <> ?
      ON CONFLICT DO NOTHING`, actor.uid, actor.email, actor.uid),
    prepared(db, `DELETE FROM np_group_invites WHERE email = ? AND (
      EXISTS (SELECT 1 FROM np_group_members m WHERE m.group_id = np_group_invites.group_id AND m.uid = ? AND m.email = ?)
      OR EXISTS (SELECT 1 FROM np_groups g WHERE g.id = np_group_invites.group_id AND g.owner_uid = ?)
    )`, actor.email, actor.uid, actor.email, actor.uid),
  ];
}

export async function listStoreGroups(db, actor) {
  const [, , groups, stores, members, invites, attachable] = await db.batch([
    ...groupInviteAcceptance(db, actor),
    prepared(db, `SELECT g.id, g.name, CASE WHEN g.owner_uid = ? THEN 'owner' ELSE m.role END AS role
      FROM np_groups g LEFT JOIN np_group_members m ON m.group_id = g.id AND m.uid = ?
      WHERE g.owner_uid = ? OR m.uid IS NOT NULL ORDER BY g.created_at, g.id`, actor.uid, actor.uid, actor.uid),
    prepared(db, `SELECT gs.group_id, s.id, s.name, a.role FROM np_group_stores gs
      JOIN np_stores s ON s.id = gs.store_id
      JOIN np_store_access a ON a.store_id = s.id AND a.uid = ?
      JOIN np_groups g ON g.id = gs.group_id
      WHERE g.owner_uid = ? OR EXISTS (SELECT 1 FROM np_group_members m WHERE m.group_id = g.id AND m.uid = ?)
      ORDER BY s.name, s.id`, actor.uid, actor.uid, actor.uid),
    prepared(db, `SELECT m.group_id, m.uid, m.email, m.role FROM np_group_members m
      JOIN np_groups g ON g.id = m.group_id WHERE g.owner_uid = ? ORDER BY m.email`, actor.uid),
    prepared(db, `SELECT i.group_id, i.id, i.email, i.role FROM np_group_invites i
      JOIN np_groups g ON g.id = i.group_id WHERE g.owner_uid = ? ORDER BY i.created_at, i.id`, actor.uid),
    prepared(db, `SELECT s.id, s.name FROM np_stores s LEFT JOIN np_group_stores gs ON gs.store_id = s.id
      WHERE s.owner_uid = ? AND gs.store_id IS NULL ORDER BY s.name, s.id`, actor.uid),
  ]);
  const byGroup = new Map(groups.results.map((group) => [group.id,
    { ...group, stores: [], ...(group.role === 'owner' && { members: [], invites: [] }) }]));
  for (const [rows, key] of [[stores, 'stores'], [members, 'members'], [invites, 'invites']]) {
    for (const {group_id, ...value} of rows.results) byGroup.get(group_id)?.[key]?.push(value);
  }
  return { groups: [...byGroup.values()], attachable: attachable.results.map(({id,name}) => ({id,name})) };
}

export async function createStoreGroup(db, actor, name) {
  const group = { id: crypto.randomUUID(), name: groupName(name), role: 'owner' };
  await resultRow(db, 'INSERT INTO np_groups (id, name, owner_uid, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    group.id, group.name, actor.uid, Date.now());
  return { group };
}

export async function renameStoreGroup(db, actor, groupId, name) {
  await requireGroupOwner(db, actor, groupId);
  const row = await resultRow(db, 'UPDATE np_groups SET name = ? WHERE id = ? AND owner_uid = ? RETURNING id',
    groupName(name), groupId, actor.uid);
  requireCondition(row, 403, 'group-forbidden', 'グループの管理権限が必要です。');
  return { ok: true };
}

export async function setGroupStore(db, actor, groupId, storeId, attach) {
  await requireGroupOwner(db, actor, groupId);
  const row = attach
    ? await resultRow(db, `INSERT INTO np_group_stores (store_id, group_id)
      SELECT s.id, ? FROM np_stores s WHERE s.id = ? AND s.owner_uid = ? AND ${ownerGuard}
      ON CONFLICT DO NOTHING RETURNING store_id`, groupId, storeId, actor.uid, groupId, actor.uid)
    : await resultRow(db, `DELETE FROM np_group_stores WHERE store_id = ? AND group_id = ?
      AND ${ownerGuard} RETURNING store_id`, storeId, groupId, groupId, actor.uid);
  requireCondition(row, 409, 'group-store-unavailable',
    attach ? 'グループ未登録で自分が作成した店舗を選択してください。' : 'この店舗はグループに所属していません。');
  return { ok: true };
}

export async function inviteGroupMember(db, actor, groupId, emailInput, role) {
  await requireGroupOwner(db, actor, groupId);
  requireRole(role);
  const email = emailAddress(emailInput);
  requireCondition(email !== actor.email, 409, 'group-already-member', '自分のアカウントは招待できません。');
  const invite = await resultRow(db, `INSERT INTO np_group_invites (id, group_id, email, role, created_at)
    SELECT ?, ?, ?, ?, ? WHERE ${ownerGuard}
    AND NOT EXISTS (SELECT 1 FROM np_group_members m WHERE m.group_id = ? AND m.email = ?)
    ON CONFLICT (group_id, email) DO UPDATE SET role = excluded.role RETURNING id, email, role`,
  crypto.randomUUID(), groupId, email, role, Date.now(), groupId, actor.uid, groupId, email);
  requireCondition(invite, 409, 'group-already-member', 'このメールアドレスは既にグループに所属しています。');
  return { invite };
}

export async function changeGroupMember(db, actor, groupId, uid, role) {
  await requireGroupOwner(db, actor, groupId);
  const filter = `WHERE group_id = ? AND uid = ? AND ${ownerGuard} RETURNING uid`;
  const args = [groupId, uid, groupId, actor.uid];
  if (role !== undefined) requireRole(role);
  const row = role === undefined
    ? await resultRow(db, `DELETE FROM np_group_members ${filter}`, ...args)
    : await resultRow(db, `UPDATE np_group_members SET role = ? ${filter}`, role, ...args);
  requireCondition(row, 404, 'group-member-not-found', 'グループのメンバーが見つかりません。');
  return { ok: true };
}

export async function revokeGroupInvite(db, actor, groupId, inviteId) {
  await requireGroupOwner(db, actor, groupId);
  const row = await resultRow(db, `DELETE FROM np_group_invites WHERE group_id = ? AND id = ?
    AND ${ownerGuard} RETURNING id`, groupId, inviteId, groupId, actor.uid);
  requireCondition(row, 404, 'group-invite-not-found', 'グループの招待が見つかりません。');
  return { ok: true };
}
