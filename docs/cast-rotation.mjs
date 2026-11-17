import { getAssignableCast } from './cast-duty.mjs';

export const castRotationLimit = 200;
export const castRotationEndLabels = Object.freeze({finished:'終了',removed:'待機取消',swapped:'交代',
  moved:'別の伝票へ移動',checkout:'会計',voided:'伝票取消',departed:'退店',unavailable:'在籍設定の変更'});

const rowFields = new Set(['id','castId','castName','queuedAt','startedAt','endedAt','endReason']);
const id = (value) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128;
const instant = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const live = (entry) => entry.endedAt === null;
const assigned = (entry) => live(entry) && entry.startedAt !== null;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function splitCastRotation(ticket) {
  const rows = ticket.castRotation ?? [];
  return {active:rows.filter(assigned), waiting:rows.filter((entry) => live(entry) && !assigned(entry)),
    history:rows.filter((entry) => !live(entry)).sort((a,b) => b.endedAt - a.endedAt)};
}

export function activeCastAssignments(state) {
  const active = new Map();
  for (const ticket of state.tickets) {
    if (ticket.status !== 'open') continue;
    for (const entry of ticket.castRotation ?? []) {
      if (assigned(entry)) active.set(entry.castId,{ticket,entry});
    }
  }
  return active;
}

export function getRotationAssignableCast(state, at) {
  const projection = state.castRotationDutyProjection;
  return getAssignableCast(projection ? {...state,castDutyProjection:projection} : state,at);
}

export function isValidCastRotationCommand(action) {
  if (!id(action?.ticketId)) return false;
  switch (action.mode) {
    case 'enqueue': return id(action.castId);
    case 'start': return id(action.assignmentId) && (action.sourceId === undefined || id(action.sourceId));
    case 'swap': return id(action.assignmentId) && id(action.nextId);
    case 'next':
    case 'remove':
    case 'finish': return id(action.assignmentId);
    default: return false;
  }
}

function finish(entry, at, reason) {
  entry.endedAt = Math.max(at,entry.startedAt ?? entry.queuedAt);
  entry.endReason = reason;
}

export function endTicketCastRotation(ticket, at, reason) {
  for (const entry of ticket.castRotation ?? []) if (live(entry)) finish(entry,at,reason);
}

export function endUnavailableCastRotations(state, at) {
  const roster = new Set(state.cast.filter(({enabled}) => enabled !== false).map(({id:castId}) => castId));
  for (const ticket of state.tickets) {
    for (const entry of ticket.castRotation ?? []) {
      if (live(entry) && !roster.has(entry.castId)) finish(entry,at,'unavailable');
    }
  }
}

export function applyCastRotation(state, action, at, actor, allocateId) {
  check(['admin','manager','staff'].includes(actor?.role), '付け回しを操作する権限がありません。');
  check(isValidCastRotationCommand(action),'付け回しの操作内容を確認してください。');
  const ticket = state.tickets.find(({id:ticketId,status}) => ticketId === action.ticketId && status === 'open');
  check(state.day.status === 'open' && ticket,'営業中・会計前の伝票を選択してください。');
  const rows = ticket.castRotation ??= [];
  if (action.mode === 'enqueue') {
    const cast = state.cast.find(({id:castId,enabled}) => castId === action.castId && enabled !== false);
    check(cast,'在籍キャストを選択してください。');
    check(!rows.some((entry) => entry.castId === cast.id && live(entry)), 'このキャストは同じ伝票で待機または接客中です。');
    check(rows.length < castRotationLimit, 'この伝票に登録できる付け回しは200件までです。');
    rows.push({id:allocateId('rotation'),castId:cast.id,castName:cast.name,queuedAt:at,startedAt:null,endedAt:null});
    return;
  }
  const entry = rows.find(({id:entryId}) => entryId === action.assignmentId);
  check(entry && live(entry),'この操作はすでに記録されています。付け回しを開き直してください。');
  if (action.mode === 'next') {
    const first = rows.findIndex((row) => live(row) && !assigned(row));
    check(!assigned(entry) && first !== -1 && rows[first] !== entry,'待機順を確認してください。');
    rows.splice(rows.indexOf(entry),1);
    rows.splice(first,0,entry);
    return;
  }
  if (action.mode === 'finish' || action.mode === 'remove') {
    check(assigned(entry) === (action.mode === 'finish'), '現在の付け回し状態を確認してください。');
    finish(entry,at,action.mode === 'finish' ? 'finished' : 'removed');
    return;
  }
  const next = action.mode === 'swap' ? rows.find((row) => live(row) && !assigned(row)) : entry;
  check(next && !assigned(next) && (action.mode !== 'swap' || (assigned(entry) && next.id === action.nextId)),
    '待機順や接客中のキャストが変更されました。最新の内容を確認してください。');
  const eligible = getRotationAssignableCast(state,at).some(({id:castId}) => castId === next.castId);
  check(eligible,'勤務条件を満たすキャストを選択してください。');
  const source = activeCastAssignments(state).get(next.castId);
  if (action.mode === 'start') {
    check(source?.entry.id === action.sourceId, source ? 'このキャストは別の伝票で接客中です。移動元を確認してください。'
      : '移動元の伝票が変更されました。最新の内容を確認してください。');
    if (source) finish(source.entry,at,'moved');
  } else {
    check(!source,'次のキャストは別の伝票で接客中です。接客を終了してから交代してください。');
    finish(entry,at,'swapped');
  }
  next.startedAt = Math.max(at,next.queuedAt,source?.entry.endedAt ?? 0,action.mode === 'swap' ? entry.endedAt : 0);
}

function validTicketRotation(ticket, casts) {
  const rows = ticket.castRotation;
  if (rows === undefined) return true;
  if (!Array.isArray(rows) || rows.length > castRotationLimit) return false;
  const ids = new Set(), liveCasts = new Set();
  for (const row of rows) {
    if (!row || Array.isArray(row) || Object.keys(row).some((key) => !rowFields.has(key)) || !id(row.id) || ids.has(row.id)
      || !casts.has(row.castId) || typeof row.castName !== 'string' || !row.castName.trim() || row.castName.length > 80
      || /[\p{Cc}\u2028\u2029]/u.test(row.castName) || !instant(row.queuedAt)
      || (row.startedAt !== null && (!instant(row.startedAt) || row.startedAt < row.queuedAt))) return false;
    if (live(row)) {
      if (ticket.status !== 'open' || row.endReason !== undefined || liveCasts.has(row.castId)) return false;
      liveCasts.add(row.castId);
    } else if (!instant(row.endedAt) || row.endedAt < (row.startedAt ?? row.queuedAt) || !Object.hasOwn(castRotationEndLabels,row.endReason)) return false;
    ids.add(row.id);
  }
  return true;
}

export function isValidCastRotationSnapshot(state, tickets) {
  if (!tickets.some((ticket) => ticket.castRotation !== undefined)) return true;
  const archived = state.archivedCast ?? [];
  if (!Array.isArray(archived)) return false;
  const casts = new Set([...state.cast,...archived].map((person) => person?.id).filter(id));
  if (!tickets.every((ticket) => validTicketRotation(ticket,casts))) return false;
  const activeCount = state.tickets.reduce((sum,ticket) => sum + (ticket.castRotation ?? []).filter(assigned).length,0);
  return activeCastAssignments(state).size === activeCount;
}
