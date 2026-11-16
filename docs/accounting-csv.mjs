import { encodeCsv } from './csv-file.mjs';
import { depositGrossAmount } from './card-fee.mjs';

const modes = ['daily','tickets'];
const encodingLabels = {bom:'UTF-8（BOM付き）',utf8:'UTF-8',sjis:'Shift_JIS'};
const labels = {cash:'現金',card:'カード',qr:'QR決済',advance:'前受金',receivable:'その他'};
const fields = {business_date:'営業日',ticket_number:'伝票番号',store_name:'店舗名',payment_method:'決済方法',amount:'金額',tax_rate:'税率'};
const sample = {business_date:'2026/11/16',ticket_number:42,store_name:'銀座店',payment_method:'カード',amount:13_200,tax_rate:10};
const defaults = (mode) => [
  ['営業日','{business_date}'],...(mode === 'tickets' ? [['伝票番号','{ticket_number}']] : []),
  ['店舗','{store_name}'],['決済方法','{payment_method}'],['勘定科目','売上高'],['金額','{amount}'],['税率（%）','{tax_rate}'],
].map(([name,value]) => ({name,value}));

function assert(value, message) {
  if (!value) throw new Error(message);
}

export function getAccountingCsvSettings(state, mode) {
  return state.accountingCsv?.[mode] ?? {encoding:'bom',columns:defaults(mode)};
}

export function normalizeAccountingCsv({encoding,columns}) {
  assert(Object.hasOwn(encodingLabels,encoding), 'CSVの文字コードを選択してください。');
  assert(Array.isArray(columns) && columns.length >= 1 && columns.length <= 32, 'CSVの列は1〜32件にしてください。');
  const rows = columns.map(({name,value}) => {
    assert(typeof name === 'string' && name.trim() && name.trim().length <= 60 && typeof value === 'string' && value.length <= 160,
      'CSVの列名は60文字以内、値は160文字以内です。');
    return {name:name.trim(),value};
  });
  assert(new Set(rows.map(({name}) => name)).size === rows.length, 'CSVの列名が重複しています。');
  assert(rows.some(({value}) => value.includes('{amount}')), '金額の埋め込み値 {amount} を使う列を追加してください。');
  return {encoding,columns:rows};
}

export function applyAccountingCsv(state, {mode,settings}, actor) {
  assert(actor.role === 'admin' && modes.includes(mode), '会計CSVを設定できるのは店舗管理者です。');
  state.accountingCsv = {...state.accountingCsv,[mode]:normalizeAccountingCsv(settings)};
}

const interpolate = (value, row) => value.replace(/\{([a-z_]+)\}/gu, (token,key) => Object.hasOwn(row,key) ? row[key] : token);
const money = (value) => Number.isSafeInteger(value) && value >= 0;

function saleRows(ticket, businessDate, storeName) {
  const buckets = ticket.settlement?.taxBreakdown?.map(({base,tax,rate}) => ({amount:base + tax,rate})) ?? [];
  const tender = [...(ticket.payments ?? []),...(ticket.deposits ?? []).map((deposit) => ({method:'advance',amount:depositGrossAmount(deposit)}))];
  const sum = (rows) => rows.reduce((total,{amount}) => total + amount,0);
  assert([...buckets,...tender].every(({amount}) => money(amount))
    && tender.every(({method}) => Object.hasOwn(labels,method))
    && sum(buckets) === ticket.settlement?.total && sum(tender) === sum(buckets),
  `${businessDate} 伝票No.${ticket.number}の決済内訳と税率内訳を確認してください。`);
  let total = sum(buckets);
  const rows = [];
  for (const {method,amount} of tender) {
    let remainder = amount;
    let available = total;
    for (const bucket of buckets) {
      if (available === 0) break;
      const previous = bucket.amount;
      const allocation = Number(BigInt(remainder) * BigInt(previous) / BigInt(available));
      available -= previous;
      remainder -= allocation;
      bucket.amount -= allocation;
      if (allocation) rows.push({business_date:businessDate.replaceAll('-','/'),ticket_number:ticket.number,store_name:storeName,
        payment_method:labels[method],amount:allocation,tax_rate:bucket.rate / 100});
    }
    total -= amount;
  }
  return rows;
}

export function buildCustomAccountingCsv(state, period, mode, storeName) {
  assert(period.valid && modes.includes(mode), '会計CSVの期間と形式を指定してください。');
  const {columns,encoding} = normalizeAccountingCsv(getAccountingCsvSettings(state,mode));
  const records = new Map();
  const lines = [];
  for (const {date,current,settledTickets,ticketDataComplete} of period.days) {
    assert(ticketDataComplete || current.sales === 0, `${date}の会計明細が不足しています。`);
    const detail = settledTickets.flatMap((ticket) => saleRows(ticket,date,storeName));
    assert(detail.reduce((total,{amount}) => total + amount,0) === current.sales, `${date}の伝票合計と日報の売上が一致しません。`);
    if (mode === 'tickets') {
      lines.push(...detail);
      continue;
    }
    for (const row of detail) {
      const key = JSON.stringify([row.business_date,row.payment_method,row.tax_rate]);
      const saved = records.get(key) ?? {...row,amount:0,ticket_number:''};
      saved.amount += row.amount;
      records.set(key,saved);
    }
  }
  const csv = encodeCsv([columns.map(({name}) => name),...lines.concat([...records.values()]).map((row) =>
    columns.map(({value}) => interpolate(value,row)))]);
  if (encoding === 'sjis') return {data:encodeShiftJis(csv.slice(1)),encoding:'shift_jis'};
  return {data:encoding === 'bom' ? csv : csv.slice(1),encoding:'utf-8'};
}

let shiftJisChars;
function encodeShiftJis(text) {
  if (!shiftJisChars) {
    shiftJisChars = new Map();
    const decoder = new TextDecoder('shift_jis',{fatal:true});
    const add = (...bytes) => {
      try {
        const char = decoder.decode(Uint8Array.from(bytes));
        if (char && !shiftJisChars.has(char)) shiftJisChars.set(char,bytes);
      } catch { /* Undefined byte sequences have no text mapping. */ }
    };
    for (let byte = 0; byte <= 0xff; byte++) add(byte);
    for (let high = 0x81; high <= 0xfc; high++) {
      if (high > 0x9f && high < 0xe0) continue;
      for (let low = 0x40; low <= 0xfc; low++) if (low !== 0x7f) add(high,low);
    }
  }
  const bytes = [];
  for (const char of text) {
    const encoded = shiftJisChars.get(char);
    assert(encoded, `Shift_JISに変換できない文字「${char}」があります。UTF-8を選択してください。`);
    bytes.push(...encoded);
  }
  return Uint8Array.from(bytes);
}

export function accountingCsvColumns(columns,{escape,icon}) {
  return columns.map(({name = '',value = ''},index) => `<div class="payroll-edit-row">
    <label class="field"><span>列名</span><input name="csvColumn" maxlength="60" value="${escape(name)}" required></label>
    <label class="field"><span>出力値</span><input name="csvValue" maxlength="160" value="${escape(value)}">
      <small data-accounting-preview>例 ${escape(interpolate(value,sample))}</small></label>
    <button type="button" class="icon-btn" data-action="accounting-remove-column" data-id="${index}" aria-label="${index + 1}列目を削除">${icon('x',16)}</button>
  </div>`).join('');
}

export function accountingCsvEditor(state, mode, api) {
  const {encoding,columns} = getAccountingCsvSettings(state,mode);
  return `<label class="field"><span>出力区分</span><select name="csvMode"><option value="daily">日次集計</option>
    <option value="tickets"${mode === 'tickets' ? ' selected' : ''}>伝票別</option></select></label>
    <label class="field"><span>文字コード</span><select name="csvEncoding">${Object.entries(encodingLabels)
      .map(([id,label]) => `<option value="${id}"${encoding === id ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    <p class="field-help">${Object.entries(fields).map(([id,label]) => `{${id}} ${label}`).join(' ／ ')}</p>
    <div data-accounting-columns>${accountingCsvColumns(columns,api)}</div>
    <button type="button" class="btn" data-action="accounting-add-column">${api.icon('plus',16)}列を追加</button>`;
}

export function readAccountingCsvEditor(form) {
  const data = new FormData(form);
  const values = data.getAll('csvValue');
  return {encoding:data.get('csvEncoding'),columns:data.getAll('csvColumn').map((name,index) => ({name,value:values[index]}))};
}

export const accountingCsvPreview = (value) => interpolate(value,sample);
