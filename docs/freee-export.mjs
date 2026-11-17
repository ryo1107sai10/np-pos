import { encodeCsv } from './csv-file.mjs';
import { depositGrossAmount } from './card-fee.mjs';
import { cashMovementCategoryLabel } from './cash-ledger.mjs';

export const freeeJournalColumns = Object.freeze([
  '[表題行]', '日付', '伝票番号', '決算整理仕訳',
  '借方勘定科目', '借方補助科目', '借方部門', '借方金額', '借方税区分', '借方税額',
  '貸方勘定科目', '貸方部門', '貸方金額', '貸方税区分', '貸方税額', '摘要',
]);

const tenderAccounts = Object.freeze({
  cash: { account: '現金', label: '現金' },
  card: { account: '未収入金', label: 'カード' },
  qr: { account: '未収入金', label: 'QR決済' },
  receivable: { account: '売掛金', label: '売掛' },
  advance: { account: '前受金', label: '前受金充当' },
});
const salesTaxTypes = new Map([[1000, '課税売上10%'], [800, '課税売上8%（軽）'], [0, '非課売上']]);
const slotCount = 1_000_000;
const settledStatuses = new Set(['paid', 'departed']);

function wholeAmount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sumAmounts(entries) {
  return entries.reduce((sum, {amount}) => sum + amount, 0);
}

function addTender(tenders, method, amount) {
  if (!Object.hasOwn(tenderAccounts,method) || !wholeAmount(amount)) return false;
  tenders.set(method, (tenders.get(method) ?? 0) + amount);
  return true;
}

function groupsToCredits(groups) {
  return [...groups.entries()].sort(([first], [second]) => second - first)
    .map(([rate, {amount, tax}]) => ({ account:'売上高', amount, tax, taxType:salesTaxTypes.get(rate) }))
    .filter(({amount}) => amount > 0);
}

function ticketSale(ticket,date) {
  const error = (message) => new Error(`${date}の伝票 No. ${ticket.number}：${message}`);
  const settlement = ticket.settlement;
  if (!settlement || !wholeAmount(settlement.total) || !Array.isArray(settlement.taxBreakdown)) {
    throw error('会計時の税率別内訳がないため、freee向けCSVを作成できません。');
  }
  const taxes = new Map();
  for (const group of settlement.taxBreakdown) {
    if (!group || !salesTaxTypes.has(group.rate) || !wholeAmount(group.base) || !wholeAmount(group.tax)
        || group.tax > 999_999_999_999 || (group.rate === 0 && group.tax !== 0) || taxes.has(group.rate)) {
      throw error('会計時の税率別内訳を確認してください。CSVの税率は10%、軽減8%、非課税に対応しています。');
    }
    taxes.set(group.rate, { amount:group.base + group.tax, tax:group.tax });
  }
  if (sumAmounts(groupsToCredits(taxes)) !== settlement.total) {
    throw error('税率別内訳と会計額が一致しないため、freee向けCSVを作成できません。');
  }

  const tenders = new Map();
  const payments = ticket.payments ?? [];
  const deposits = ticket.deposits ?? [];
  const advancesValid = deposits.every((deposit) => addTender(tenders,'advance',depositGrossAmount(deposit)));
  const paymentsValid = payments.every(({method, amount}) => method !== 'advance' && addTender(tenders,method,amount));
  const received = [...tenders.values()].reduce((sum,amount) => sum + amount,0);
  if (!advancesValid || !paymentsValid || received !== settlement.total) {
    throw error('支払内訳と会計額が一致しないため、freee向けCSVを作成できません。');
  }
  return { tenders, taxes, total:settlement.total, number:ticket.number };
}

function combineSales(sales) {
  const tenders = new Map();
  const taxes = new Map();
  for (const sale of sales) {
    for (const [method, amount] of sale.tenders) addTender(tenders,method,amount);
    for (const [rate, {amount,tax}] of sale.taxes) {
      const prior = taxes.get(rate) ?? {amount:0,tax:0};
      taxes.set(rate,{amount:prior.amount + amount,tax:prior.tax + tax});
    }
  }
  return { tenders, taxes };
}

function storeNamespace(storeId) {
  let hash = 2166136261;
  for (const character of String(storeId)) {
    hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  }
  return (hash >>> 0) % slotCount;
}

function journalNumber(date, mode, namespace, ticketNumber) {
  // A date prefix and six-digit slot keep the numeric ID within Excel's precision.
  const slot = (namespace + (ticketNumber ?? 0) % slotCount) % slotCount;
  return date.replaceAll('-','') + (mode === 'daily' ? '1' : '2') + String(slot).padStart(6,'0');
}

function journalRows(sale,{date,number,storeName,daily}) {
  const debits = Object.entries(tenderAccounts).flatMap(([method,{account,label}]) => {
    const amount = sale.tenders.get(method) ?? 0;
    return amount > 0 ? [{account,label,amount}] : [];
  });
  const credits = groupsToCredits(sale.taxes);
  if (debits.some(({amount}) => !wholeAmount(amount))
      || credits.some(({amount,tax}) => !wholeAmount(amount) || tax > 999_999_999_999)
      || sumAmounts(debits) !== sumAmounts(credits)) {
    throw new Error(`${date}の借方と貸方の金額を確認してください。`);
  }
  const memo = `NP POS｜${storeName}｜${daily ? '日次売上' : '伝票 No. ' + sale.number}｜` + debits
    .map(({label,amount}) => `${label} ${amount}円`).join('／');
  return Array.from({length:Math.max(debits.length,credits.length)}, (_,index) => {
    const debit = debits[index];
    const credit = credits[index];
    return [
      '[明細行]',date.replaceAll('-','/'),number,'',
      debit?.account,'','',debit?.amount,debit ? '対象外' : '',debit ? 0 : '',
      credit?.account,'',credit?.amount,credit?.taxType,credit?.tax,memo,
    ];
  });
}

function daySales(day) {
  if (day.ticketDataComplete === false) {
    if (day.current?.sales === 0) return [];
    throw new Error(`${day.date}の確定伝票の明細が不足しているため、freee向けCSVを作成できません。`);
  }
  const sales = (day.settledTickets ?? []).filter((ticket) => settledStatuses.has(ticket.status))
    .map((ticket) => ticketSale(ticket,day.date));
  if (!wholeAmount(day.current?.sales) || sales.reduce((total,{total:amount}) => total + amount,0) !== day.current.sales) {
    throw new Error(`${day.date}の確定伝票と日報の売上が一致しないため、freee向けCSVを作成できません。`);
  }
  return sales.filter(({total}) => total > 0);
}

export function buildFreeeCsv(period,{mode,storeName='店舗',storeId=storeName}) {
  if (!period?.valid || !Array.isArray(period.days) || !['daily','tickets'].includes(mode)) {
    throw new Error('出力形式と営業日を選び直してください。');
  }
  const namespace = storeNamespace(storeId);
  let salesTotal = 0;
  let journalCount = 0;
  const rows = [freeeJournalColumns];
  const numbers = new Set();
  for (const day of period.days) {
    const sales = daySales(day);
    if (!sales.length) continue;
    const daily = mode === 'daily';
    const groups = daily ? [combineSales(sales)] : sales;
    for (const sale of groups) {
      if (!daily && (!Number.isSafeInteger(sale.number) || sale.number < 1)) {
        throw new Error(`${day.date}の確定伝票の番号を確認してください。`);
      }
      const number = journalNumber(day.date,mode,namespace,sale.number);
      if (numbers.has(number)) throw new Error(`${day.date}に同じ出力番号の伝票があるため、CSVを作成できません。`);
      numbers.add(number);
      const journal = journalRows(sale,{date:day.date, number, storeName, daily});
      salesTotal += sumAmounts(groupsToCredits(sale.taxes));
      journalCount++;
      rows.push(...journal);
    }
  }
  return { csv:encodeCsv(rows), salesTotal, journalCount };
}

const expenseAccounts = Object.freeze({supplies:'消耗品費',purchase:'仕入高',transport:'旅費交通費',other:'雑費'});
const expenseTaxTypes = ['課対仕入10%','課対仕入8%（軽）','非課仕入','対象外'];

export function getFreeeExpenses(period) {
  if (!period?.valid || !Array.isArray(period.days)) throw new Error('営業日を選び直してください。');
  return period.days.flatMap(({date,current}) => {
    const entries = (current.cashMovements ?? []).filter(({kind,voidedAt}) => kind === 'expense' && voidedAt == null);
    if (entries.some(({id,amount}) => typeof id !== 'string' || !id || !wholeAmount(amount) || amount === 0)
      || sumAmounts(entries) !== current.expenses) {
      throw new Error(`${date}の経費明細と日報の金額が一致しないため、freee向けCSVを作成できません。`);
    }
    return entries.map((entry) => ({date,entry}));
  });
}

export function renderFreeeExpenseFields(expenses,{escape,yen}) {
  const suggestions = expenseTaxTypes.map((label) => `<option value="${label}"></option>`).join('');
  return `<p class="form-copy">現金で記録した経費を、借方と貸方が一致する仕訳CSVにします。証憑を確認して科目を指定してください。税区分と内税額を空欄にした場合は、freeeの取込画面で指定します。</p>
    <datalist id="freee-expense-tax-types">${suggestions}</datalist><div class="payroll-edit-section">
    ${expenses.map(({date,entry},index) => `<fieldset class="payroll-edit-section"><legend>${escape(date)} ／ ${escape(cashMovementCategoryLabel(entry))} ／ ${yen(entry.amount)}</legend>
      <p class="field-help">${escape(entry.reason)}${entry.destination ? ` ／ ${escape(entry.destination)}` : ''}</p>
      <div class="form-grid"><label class="field"><span>借方勘定科目</span><input name="freeeExpenseAccount-${index}" value="${expenseAccounts[entry.category] ?? '雑費'}" maxlength="80" required></label>
      <label class="field"><span>借方税区分</span><input name="freeeExpenseTaxType-${index}" list="freee-expense-tax-types" maxlength="80"></label>
      <label class="field"><span>内税額（円）</span><input type="number" name="freeeExpenseTax-${index}" min="0" max="${entry.amount}" step="1" inputmode="numeric"></label></div>
      </fieldset>`).join('')}</div>`;
}

export function readFreeeExpenseFields(expenses,formData) {
  return expenses.map(({date,entry},index) => ({
    date,id:entry.id,amount:entry.amount,
    account:formData.get(`freeeExpenseAccount-${index}`),
    taxType:formData.get(`freeeExpenseTaxType-${index}`),
    tax:formData.get(`freeeExpenseTax-${index}`),
  }));
}

export function buildFreeeExpenseCsv(period, choices, {storeName='店舗',storeId=storeName} = {}) {
  const expenses = getFreeeExpenses(period);
  if (!expenses.length || choices.length !== expenses.length) throw new Error('出力する経費を確認してください。');
  const numbers = new Set();
  const rows = expenses.map(({date,entry},index) => {
    const choice = choices[index];
    if (choice?.id !== entry.id || choice.date !== date || choice.amount !== entry.amount) {
      throw new Error('経費の内容が更新されました。日報から開き直してください。');
    }
    const account = choice.account?.trim();
    const taxType = choice.taxType?.trim() ?? '';
    const tax = choice.tax === '' ? '' : Number(choice.tax);
    if (!account || account.length > 80 || taxType.length > 80 || /[\p{Cc}]/u.test(account + taxType)
      || (tax !== '' && (!taxType || !wholeAmount(tax) || tax > entry.amount))
      || (tax !== '' && tax !== 0 && ['非課仕入','対象外'].includes(taxType))) {
      throw new Error(`${date}の経費「${entry.reason}」の勘定科目・税区分・内税額を確認してください。`);
    }
    const slot = storeNamespace(JSON.stringify([storeId,entry.id]));
    const number = date.replaceAll('-','') + '3' + String(slot).padStart(6,'0');
    if (numbers.has(number)) throw new Error(`${date}に同じ出力番号の経費があるため、CSVを作成できません。`);
    numbers.add(number);
    const memo = ['NP POS',storeName,cashMovementCategoryLabel(entry),entry.reason,entry.destination].filter(Boolean).join('｜');
    return ['[明細行]',date.replaceAll('-','/'),number,'',account,'','',entry.amount,taxType,tax,
      '現金','',entry.amount,'対象外',0,memo];
  });
  return {csv:encodeCsv([freeeJournalColumns,...rows]),expenseTotal:sumAmounts(expenses.map(({entry}) => entry)),journalCount:rows.length};
}
