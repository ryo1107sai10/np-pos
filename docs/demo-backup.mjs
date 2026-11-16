import { exportStoreConfiguration, parseStoreConfiguration, quote, summary } from './engine.mjs';
import { normalizeAttendanceSnapshot, normalizePayrollSnapshot } from './payroll.mjs';
import { validateCastAttendanceSnapshot } from './cast-self.mjs';
import { validateShiftsSnapshot } from './shifts.mjs';
import { normalizeRolePolicy } from './role-policy.mjs';
import { normalizeStaffLabor } from './labor-workspace.mjs';

const format = 'np-pos.demo-backup';
export const demoBackupMaxBytes = 12 * 1024 * 1024;
const invalid = 'NP POSデモのバックアップJSONを読み取れません。';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identified = (rows) => Array.isArray(rows) && rows.every((row)=>record(row) && typeof row.id === 'string' && row.id)
  && new Set(rows.map(({id})=>id)).size === rows.length;
const date = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;

function validateDemoSnapshot(state) {
  if (!record(state) || !record(state.day) || !date(state.day.date) || !['open','closed'].includes(state.day.status)
    || !['tables','tickets','stock','menu','cast','movements'].every((key)=>identified(state[key]))
    || !Number.isSafeInteger(state.nextId) || state.nextId <= 0 || !Number.isSafeInteger(state.nextTicket) || state.nextTicket <= 0
    || !Array.isArray(state.closedDays) || !state.closedDays.every((row)=>record(row) && date(row.date)
      && (row.ticketSnapshots === undefined || identified(row.ticketSnapshots)))
    || !['customers','receivables','cashMovements','cancelledSettlements','auditLog','printDocuments'].every((key)=>
      state[key] === undefined || identified(state[key]))) throw new Error(invalid);
  try {
    if (new Set(state.closedDays.map(({date})=>date)).size !== state.closedDays.length) throw new Error(invalid);
    parseStoreConfiguration(JSON.stringify(exportStoreConfiguration(state)));
    if (state.rolePolicy !== undefined) normalizeRolePolicy(state.rolePolicy);
    if (state.staffLabor !== undefined) normalizeStaffLabor(state.staffLabor);
    validateShiftsSnapshot(state);
    validateCastAttendanceSnapshot(state);
    normalizeAttendanceSnapshot(state);
    normalizePayrollSnapshot(state);
    for (const ticket of state.tickets) quote(state,ticket.id);
    summary(state);
  } catch { throw new Error(invalid); }
}

async function digest(payload) {
  const buffer = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)));
  return [...new Uint8Array(buffer)].map((byte)=>byte.toString(16).padStart(2,'0')).join('');
}

export async function writeDemoBackup(state, now = Date.now()) {
  const snapshot = structuredClone(state);
  validateDemoSnapshot(snapshot);
  const payload = {format,version:1,savedAt:new Date(now).toISOString(),snapshot};
  return JSON.stringify({...payload,sha256:await digest(payload)});
}

export async function readDemoBackup(text) {
  let file;
  try { file = JSON.parse(text); }
  catch { throw new Error(invalid); }
  if (!record(file) || file.format !== format) throw new Error(invalid);
  if (file.version !== 1) throw new Error('このバックアップ形式には対応していません。');
  const {savedAt,snapshot,sha256} = file;
  if (typeof savedAt !== 'string' || !Number.isFinite(Date.parse(savedAt)) || new Date(savedAt).toISOString() !== savedAt
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(invalid);
  if (sha256 !== await digest({format,version:1,savedAt,snapshot})) {
    throw new Error('バックアップが変更または破損しています。書き出したファイルを選んでください。');
  }
  validateDemoSnapshot(snapshot);
  return {savedAt,snapshot};
}
