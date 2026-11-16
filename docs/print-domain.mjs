export const printDocumentKinds = Object.freeze({
  check: '会計確認用伝票',
  receipt: 'レシート',
  invoice: '領収書',
});

const defaults = Object.freeze({
  width: 58, storeName: '', address: '', phone: '', registrationNumber: '', showItems: true, autoReceipt: false,
});
const operatorRoles = new Set(['admin', 'manager', 'staff']);
const receivedMethods = new Set(['cash', 'card', 'qr']);
const settledStatuses = new Set(['paid', 'departed']);
const unsafeLineCharacters = /[\u0000-\u001F\u007F]/;
const settingsTextLengths = { storeName: 80, address: 160, phone: 40, registrationNumber: 32 };
const settingsTextLabels = { storeName: '店名', address: '住所', phone: '電話番号', registrationNumber: '登録番号' };
const versionPattern = /^(?:draft|settled|legacy):(?:0|[1-9]\d*)$/;

function assertPrint(condition, message) {
  if (!condition) throw new Error(message);
}

function validText(value, length, required = false) {
  return typeof value === 'string' && value.length <= length && !unsafeLineCharacters.test(value)
    && (!required || value.trim().length > 0);
}

function cleanText(value, label, length, required = false) {
  const text = typeof value === 'string' ? value.trim() : value;
  assertPrint(validText(text, length, required), `${label}を${length}文字以内で入力してください。`);
  return text;
}

function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function settlementRevision(ticket) {
  return positiveInteger(ticket.settlementRevision) ? ticket.settlementRevision : 0;
}

function printVersion(ticket, kind) {
  const revision = settlementRevision(ticket);
  if (kind === 'check') return `draft:${revision}`;
  return revision ? `settled:${revision}` : `legacy:${Number.isSafeInteger(ticket.settledAt) && ticket.settledAt >= 0 ? ticket.settledAt : 0}`;
}

export function normalizePrintSettings(settings) {
  assertPrint(settings && typeof settings === 'object' && !Array.isArray(settings), '印刷設定を確認してください。');
  const { width, showItems, autoReceipt } = settings;
  assertPrint(width === 58 || width === 80, '用紙幅は58mmまたは80mmを選択してください。');
  assertPrint(typeof showItems === 'boolean' && typeof autoReceipt === 'boolean', '明細表示と自動印刷の設定を確認してください。');
  const fields = Object.keys(settingsTextLengths).map((key) =>
    [key, cleanText(settings[key] ?? '', settingsTextLabels[key], settingsTextLengths[key])]);
  return { width, ...Object.fromEntries(fields), showItems, autoReceipt };
}

export function getPrintSettings(state) {
  return state.printSettings ? { ...defaults, ...state.printSettings } : { ...defaults };
}

export function findPrintableTicket(state, ticketId, date) {
  if (!validDate(date) || typeof ticketId !== 'string') return undefined;
  if (date === state.day.date) {
    const current = state.tickets.find(({id}) => id === ticketId);
    if (current) return current;
  }
  return state.closedDays.find((day) => day.date === date)?.ticketSnapshots?.find(({id}) => id === ticketId);
}

export function getPrintTenderReceived(ticket) {
  return [...(ticket.deposits ?? []), ...(ticket.payments ?? [])]
    .filter(({method}) => receivedMethods.has(method))
    .reduce((total, {amount}) => total + amount, 0);
}

export function getPrintDocuments(state, ticket, date, kind) {
  if (!ticket || typeof kind !== 'string' || !Object.hasOwn(printDocumentKinds, kind)) return [];
  const version = printVersion(ticket, kind);
  return (state.printDocuments ?? []).filter((entry) =>
    entry.ticketId === ticket.id && entry.date === date && entry.kind === kind && entry.version === version)
    .sort((first, second) => first.number - second.number);
}

export function isValidPrintDocument(record) {
  return record != null && validText(record.id, 128, true) && validText(record.ticketId, 128, true)
    && positiveInteger(record.ticketNumber) && validDate(record.date)
    && typeof record.kind === 'string' && Object.hasOwn(printDocumentKinds, record.kind)
    && typeof record.version === 'string' && record.version.length <= 30 && versionPattern.test(record.version)
    && (record.kind === 'check' ? record.version.startsWith('draft:') : !record.version.startsWith('draft:'))
    && positiveInteger(record.number) && Number.isSafeInteger(record.at) && record.at >= 0
    && (record.kind === 'invoice' ? validText(record.recipient, 80, true) && validText(record.purpose, 120, true)
      : record.recipient === '' && record.purpose === '')
    && validText(record.actor?.id, 256, true) && validText(record.actor?.label, 320, true)
    && operatorRoles.has(record.actor?.role);
}

export function applyPrintCommand(state, action, actor, at, allocateId) {
  if (action.type === 'savePrintSettings') {
    assertPrint(actor.role === 'admin', '印刷設定を変更するには店舗管理者の権限が必要です。');
    state.printSettings = normalizePrintSettings(action.settings);
    return;
  }
  assertPrint(operatorRoles.has(actor.role), '印刷を発行する権限がありません。');
  const {date, kind} = action;
  assertPrint(typeof kind === 'string' && Object.hasOwn(printDocumentKinds, kind), '印刷する書類を選択してください。');
  assertPrint(actor.role !== 'staff' || date === state.day.date, '過去の営業日の印刷にはマネージャー以上の権限が必要です。');
  const ticket = findPrintableTicket(state, action.ticketId, date);
  assertPrint(ticket, '指定した営業日の伝票が見つかりません。');
  if (kind === 'check') {
    assertPrint(date === state.day.date && state.day.status === 'open' && ticket.status === 'open',
      '会計確認用伝票は営業中の未会計伝票から発行できます。');
  } else {
    assertPrint(settledStatuses.has(ticket.status), '会計確定済みの伝票を選択してください。');
  }
  const latest = getPrintDocuments(state, ticket, date, kind).at(-1);
  const number = (latest?.number ?? 0) + 1;
  assertPrint(positiveInteger(number), 'この書類の発行回数を確認できません。');
  let recipient = '';
  let purpose = '';
  if (kind === 'invoice') {
    assertPrint(getPrintTenderReceived(ticket) > 0, '会計時に受領した金額がある伝票から領収書を発行できます。');
    const previous = actor.role === 'admin' || latest?.actor?.id === actor.id ? latest : null;
    recipient = cleanText(action.recipient ?? previous?.recipient, '宛名', 80, true);
    purpose = cleanText(action.purpose ?? previous?.purpose, '但し書き', 120, true);
  }
  const version = printVersion(ticket, kind);
  const document = { id: allocateId(), ticketId: ticket.id, ticketNumber: ticket.number, date, kind,
    version, number, at, recipient, purpose, actor: { ...actor } };
  (state.printDocuments ??= []).push(document);
}
