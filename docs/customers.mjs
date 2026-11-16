const settled = new Set(['paid', 'departed']);
const editors = new Set(['admin', 'manager']);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function profileText(value, max, label, required = false) {
  check(value == null || typeof value === 'string', `${label}を確認してください。`);
  const text = (value ?? '').trim();
  check(text.length <= max && (!required || text.length > 0), `${label}を${max}字以内で入力してください。`);
  return text;
}

function calendarDate(value, label) {
  const text = profileText(value, 10, label);
  if (!text) return '';
  const parsed = new Date(`${text}T00:00:00Z`);
  check(datePattern.test(text) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text,
    `${label}を確認してください。`);
  return text;
}

function bottleRecords(value) {
  const bottles = value ?? [];
  check(Array.isArray(bottles) && bottles.length <= 30, 'ボトルキープは30件以内で登録できます。');
  return bottles.map((entry) => {
    check(record(entry) && Number.isFinite(entry.quantity) && entry.quantity >= 0 && entry.quantity <= 1_000_000,
      'ボトルの残量を確認してください。');
    return { name: profileText(entry.name, 60, 'ボトル名', true), quantity: entry.quantity,
      unit: profileText(entry.unit, 12, '残量の単位'), expiresAt: calendarDate(entry.expiresAt, '期限') };
  });
}

export function findCustomer(state, id) {
  return id ? (state.customers ?? []).find((entry) => entry.id === id) : undefined;
}

export function customerName(state, id) {
  return findCustomer(state, id)?.name ?? '';
}

function comparable(value) {
  const text = typeof value === 'string' ? value : '';
  return text.normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g,
    (katakana) => String.fromCharCode(katakana.charCodeAt(0) - 0x60));
}

export function searchCustomers(state, query = '') {
  const terms = comparable(query).trim().split(/\s+/).filter(Boolean);
  return (state.customers ?? []).filter((customer) => {
    const names = [customer.name, customer.kana].map((name) => comparable(name).replace(/\s+/g, ''));
    const phone = comparable(customer.phone).replace(/\D/g, '');
    return terms.every((term) => names.some((name) => name.includes(term)) || (/^[+()\d-]+$/.test(term) && term.replace(/\D/g, '').length > 0
      && phone.includes(term.replace(/\D/g, ''))));
  });
}

function ticketSnapshots(state) {
  const snapshots = new Map();
  for (const ticket of state.tickets ?? []) snapshots.set(ticket.id, { ticket, date: state.day?.date });
  for (const day of state.closedDays ?? []) {
    for (const ticket of day.ticketSnapshots ?? []) {
      if (!snapshots.has(ticket.id)) snapshots.set(ticket.id, { ticket, date: day.date });
    }
  }
  for (const cancellation of state.cancelledSettlements ?? []) {
    if (cancellation.receipt && !snapshots.has(cancellation.ticketId)) {
      snapshots.set(cancellation.ticketId, {
        ticket: { ...cancellation.receipt, status: 'cancelled' }, date: cancellation.date,
      });
    }
  }
  return [...snapshots.values()].sort((a, b) => (b.ticket.createdAt ?? 0) - (a.ticket.createdAt ?? 0));
}

export function isAssignedCustomer(_state, customer, actorId) {
  return Boolean(actorId && customer?.createdByUid === actorId);
}

function visitRecord(state, { ticket, date }) {
  const labels = ticket.tableLabels ?? [...new Set(ticket.tableIds?.length ? ticket.tableIds :
    (ticket.tableHistory ?? []).map(({ tableId }) => tableId))].map((id) =>
    state.tables.find((table) => table.id === id)?.name ?? state.archivedTables?.find((table) => table.id === id)?.name ?? id);
  return { id: ticket.id, date, at: ticket.createdAt, number: ticket.number, tableLabels: labels,
    status: ticket.status, total: settled.has(ticket.status) ? ticket.settlement?.total ?? 0 : 0,
    customer: ticket.customer ?? '' };
}

export function listUnlinkedVisits(state) {
  return ticketSnapshots(state).filter(({ ticket }) => !ticket.customerId && ticket.status !== 'void' && ticket.customer?.trim())
    .map((entry) => visitRecord(state, entry));
}

export function getCustomerDetail(state, id) {
  const customer = findCustomer(state, id);
  if (!customer || customer.restricted) return null;
  const entries = ticketSnapshots(state).filter(({ ticket }) => ticket.customerId === id && ticket.status !== 'void');
  const visits = entries.map((entry) => visitRecord(state, entry));
  const castById = new Map([...(state.archivedCast ?? []), ...(state.cast ?? [])].map(({id, name}) => [id, name]));
  const nominations = entries.flatMap(({ ticket, date }) => (ticket.lines ?? [])
    .filter((line) => line.category === '指名' && line.cancelledAt == null)
    .flatMap((line) => (line.castIds ?? []).map((castId, index) => ({ id: `${line.id}:${castId}`, ticketId: ticket.id,
      number: ticket.number, date, at: line.createdAt, name: line.name, castId,
      castName: line.castNames?.[index] ?? castById.get(castId) ?? castId })))).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const preferred = (state.cast ?? []).find((person) => person.id === customer.castId && person.enabled !== false);
  const preferredCast = preferred ? {id: preferred.id, name: preferred.name} : null;
  return { customer, visits, nominations, totalSales: visits.reduce((sum, visit) => sum + visit.total, 0),
    lastNomination: nominations[0] ?? null, preferredCast };
}

function customerInput(state, incoming, previous) {
  check(record(incoming), '顧客情報を確認してください。');
  const fields = { ...previous, ...incoming };
  const phone = profileText(fields.phone, 32, '電話番号');
  check(!phone || /^[+()\d\p{Zs}ー－-]+$/u.test(phone.normalize('NFKC'))
    && /\d/.test(phone.normalize('NFKC')), '電話番号を確認してください。');
  const castId = profileText(fields.castId, 100, '担当キャスト');
  check(!castId || castId === previous?.castId || (state.cast ?? []).some((person) => person.id === castId && person.enabled !== false),
    '担当キャストを確認してください。');
  const creditLimit = fields.creditLimit ?? 0;
  check(Number.isSafeInteger(creditLimit) && creditLimit >= 0 && creditLimit <= 100_000_000, '売掛上限を円単位で入力してください。');
  check((fields.flagged === undefined || typeof fields.flagged === 'boolean')
    && (fields.creditEnabled === undefined || typeof fields.creditEnabled === 'boolean'), '顧客区分を確認してください。');
  return { name: profileText(fields.name, 60, '顧客名', true), kana: profileText(fields.kana, 60, 'ふりがな'), phone,
    birthday: calendarDate(fields.birthday, '誕生日'), castId, memo: profileText(fields.memo, 400, 'メモ'),
    flagged: fields.flagged === true, creditEnabled: fields.creditEnabled === true, creditLimit,
    bottleKeeps: bottleRecords(fields.bottleKeeps) };
}

function writeCustomer(state, customer, previous, actor, now, allocateId) {
  const row = { ...customer, id: previous?.id ?? allocateId(), createdByUid: previous ? previous.createdByUid ?? null : actor.id ?? null,
    createdAt: previous?.createdAt ?? now, updatedAt: now, firstVisitDate: previous?.firstVisitDate ?? '' };
  state.customers ??= [];
  if (previous) state.customers[state.customers.indexOf(previous)] = row;
  else state.customers.push(row);
  return row;
}

function firstVisit(customer, date) {
  if (date && (!customer.firstVisitDate || customer.firstVisitDate > date)) customer.firstVisitDate = date;
}

export function customerForSeat(state, action) {
  check(action.newCustomer == null, '新しいお客様は顧客管理から登録してください。');
  if (!action.customerId) return {customer:String(action.customer ?? '').trim().slice(0, 60)};
  const customer = findCustomer(state, action.customerId);
  check(customer, '顧客が見つかりません。選び直してください。');
  firstVisit(customer, state.day.date);
  return { customer: customer.name, customerId: customer.id };
}

function rewriteTicketLinks(state, from, to) {
  const update = (ticket) => { if (ticket?.customerId === from) ticket.customerId = to; };
  (state.tickets ?? []).forEach(update);
  for (const day of state.closedDays ?? []) (day.ticketSnapshots ?? []).forEach(update);
  for (const cancellation of state.cancelledSettlements ?? []) update(cancellation.receipt);
  for (const loan of state.receivables ?? []) {
    if (loan.customerId === from) loan.customerId = to;
  }
}

function linkLegacyVisit(state, action, customer) {
  const entry = ticketSnapshots(state).find(({ticket}) => ticket.id === action.ticketId);
  check(entry && entry.ticket.status !== 'void' && !entry.ticket.customerId, '未登録の来店伝票を選んでください。');
  const attach = (ticket) => {
    if (ticket?.id === action.ticketId) ticket.customerId = customer.id;
  };
  (state.tickets ?? []).forEach(attach);
  for (const day of state.closedDays ?? []) (day.ticketSnapshots ?? []).forEach(attach);
  for (const cancellation of state.cancelledSettlements ?? []) attach(cancellation.receipt);
  firstVisit(customer, entry.date);
}

export function applyCustomerCommand(state, action, actor, now, allocateId) {
  if (action.type === 'saveCustomer') {
    check(editors.has(actor.role), '顧客情報を変更する権限がありません。');
    const previous = findCustomer(state, action.customerId);
    check(!action.customerId || previous, '顧客が見つかりません。');
    check(!previous || actor.role === 'admin' || isAssignedCustomer(state, previous, actor.id), '担当の顧客を選んでください。');
    const profile = customerInput(state, action.customer, previous);
    check(actor.role === 'admin' || (profile.creditEnabled === (previous?.creditEnabled ?? false)
      && profile.creditLimit === (previous?.creditLimit ?? 0)), '売掛の可否と上限は店舗管理者が設定できます。');
    writeCustomer(state, profile, previous, actor, now, allocateId);
    return;
  }
  check(actor.role === 'admin', 'この操作には店舗管理者の権限が必要です。');
  if (action.type === 'importCustomers') {
    check(Array.isArray(action.customers) && action.customers.length > 0 && action.customers.length <= 500,
      '顧客CSVは1回に1〜500件まで登録できます。');
    const profiles = action.customers.map((incoming) => customerInput(state, incoming));
    for (const profile of profiles) writeCustomer(state, profile, null, actor, now, allocateId);
    return;
  }
  if (action.type === 'linkCustomer') {
    const customer = findCustomer(state, action.customerId);
    check(customer, '顧客が見つかりません。');
    linkLegacyVisit(state, action, customer);
    return;
  }
  check(action.type === 'mergeCustomers', '顧客操作を確認してください。');
  profileText(action.reason, 120, '統合の理由', true);
  const source = findCustomer(state, action.sourceId);
  const target = findCustomer(state, action.targetId);
  check(source && target && source.id !== target.id, '統合元と統合先には別の顧客を選んでください。');
  firstVisit(target, source.firstVisitDate);
  target.bottleKeeps = [...(target.bottleKeeps ?? []), ...(source.bottleKeeps ?? [])];
  check(target.bottleKeeps.length <= 30, '統合後のボトルキープが30件を超えます。');
  target.updatedAt = now;
  rewriteTicketLinks(state, source.id, target.id);
  state.customers = state.customers.filter(({id}) => id !== source.id);
}

function csvRows(input) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  const endCell = () => { row.push(cell); cell = ''; afterQuote = false; };
  const endRow = () => { endCell(); if (row.some((value) => value.trim())) rows.push(row); row = []; };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else cell += char;
      continue;
    }
    if (char === ',') endCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index++;
      endRow();
    } else {
      check(!afterQuote && (char !== '"' || !cell), 'CSVの引用符を確認してください。');
      if (char === '"') quoted = true;
      else cell += char;
    }
  }
  check(!quoted, 'CSVの引用符を確認してください。');
  endRow();
  return rows;
}

const csvColumns = {
  '表示名':'name', '顧客名':'name', '名前':'name', '氏名':'name', name:'name',
  'ふりがな':'kana', 'カナ':'kana', 'フリガナ':'kana', kana:'kana', '電話':'phone', '電話番号':'phone', phone:'phone',
  '誕生日':'birthday', birthday:'birthday', '担当':'castName', '担当キャスト':'castName', castId:'castId', 'メモ':'memo', memo:'memo',
};

export function parseCustomersCsv(text, people = []) {
  check(typeof text === 'string' && text.length <= 1_000_000, '顧客CSVのサイズを確認してください。');
  const rows = csvRows(text.replace(/^\uFEFF/, ''));
  const fields = rows.shift()?.map((heading) => {
    const key = heading.trim();
    return Object.hasOwn(csvColumns, key) ? csvColumns[key] : null;
  });
  check(fields?.includes('name') && fields.length === new Set(fields).size && fields.every(Boolean),
    'CSVの1行目に表示名と取り込む項目名を指定してください。');
  check(rows.length > 0 && rows.length <= 500, '顧客CSVは1回に1〜500件まで登録できます。');
  return rows.map((row, index) => {
    check(row.length === fields.length, `CSVの${index + 2}行目の列数を確認してください。`);
    const profile = Object.fromEntries(fields.map((field, column) => [field, row[column].trim()]));
    check(profile.name, `CSVの${index + 2}行目に表示名を入力してください。`);
    if (profile.castName) {
      const matches = people.filter((person) => person.name === profile.castName && person.enabled !== false);
      check(matches.length === 1, `CSVの${index + 2}行目の担当キャストを確認してください。`);
      profile.castId = matches[0].id;
    }
    delete profile.castName;
    return profile;
  });
}
