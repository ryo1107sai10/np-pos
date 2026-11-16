import { getPrintTenderReceived } from './print-domain.mjs';

export const printDocumentTitles = Object.freeze({ check: '会計確認伝票', receipt: 'レシート', invoice: '領収書' });

const methods = { cash: '現金', card: 'カード', qr: 'QR決済', receivable: '売掛' };
const timestamp = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const calendar = new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit'});
const quantities = new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 6});
const decimal = new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 2});

function dateLabel(at, formatter) {
  if (at == null) return '';
  const date = new Date(at);
  return Number.isFinite(date.valueOf()) ? formatter.format(date) : '';
}

function field(label, control, help = '') {
  return `<label class="field"><span>${label}</span>${control}${help ? `<small>${help}</small>` : ''}</label>`;
}

function widthSelect(width) {
  return `<select name="printWidth">${[58,80].map((size) =>
    `<option value="${size}"${Number(width) === size ? ' selected' : ''}>${size} mm</option>`).join('')}</select>`;
}

export function renderPrintOptions({kind, width, recipient = '', purpose = '', showWidth = true}, {escape}) {
  return `<div class="np-print-options${kind === 'invoice' ? ' np-print-options-invoice' : ''}">
    ${showWidth ? field('印刷幅', widthSelect(width)) : ''}
    ${kind === 'invoice' ? field('宛名', `<input name="printRecipient" value="${escape(recipient)}" maxlength="80" autocomplete="off" placeholder="株式会社〇〇" required>`)
      + field('但し書き', `<input name="printPurpose" value="${escape(purpose)}" maxlength="120" autocomplete="off" placeholder="ご飲食代として" required>`) : ''}
    </div>`;
}

export function renderPrintSettings(settings, {escape}) {
  const input = (name, key, max, extra = '') => `<input name="${name}" value="${escape(settings[key] ?? '')}" maxlength="${max}" ${extra}>`;
  return `<div class="np-print-settings"><div class="form-grid">
    ${field('既定の印刷幅', widthSelect(settings.width))}
    ${field('印字する店名', input('printStoreName','storeName',80,'placeholder="店舗名を使用"'))}
    ${field('住所（任意）', input('printAddress','address',160))}
    ${field('電話番号（任意）', input('printPhone','phone',40,'type="tel"'))}
    ${field('登録番号（任意）', input('printRegistrationNumber','registrationNumber',32,'placeholder="Tから始まる登録番号"'))}</div>
    <div class="np-print-switches"><label class="inline-check"><input type="checkbox" name="printShowItems"${settings.showItems !== false ? ' checked' : ''}>商品・プラン明細を印字する</label>
    <label class="inline-check"><input type="checkbox" name="printAutoReceipt"${settings.autoReceipt ? ' checked' : ''}>会計確定時にレシートの印刷画面を開く</label></div>
    <p class="field-help">印刷ダイアログの用紙も、プリンターのロール幅に合わせてください。</p></div>`;
}

function moneyRows(rows, {yen, escape}) {
  return `<dl class="np-print-rows">${rows.map(([label, amount]) =>
    `<div><dt>${escape(label)}</dt><dd>${amount < 0 ? '−' : ''}${yen(Math.abs(amount))}</dd></div>`).join('')}</dl>`;
}

function lineItems(ticket, detailed, {escape, yen}) {
  const lines = (ticket.lines ?? []).filter(({cancelledAt}) => cancelledAt == null);
  if (!detailed || !lines.length) return '';
  return `<section class="np-print-section"><h4>会計明細（税抜）</h4><ul class="np-print-items">${lines.map((line) => `
    <li><span>${escape(line.name)}<small>${yen(line.price)} × ${quantities.format(line.quantity)}</small></span><strong>${yen(line.total)}</strong></li>`).join('')}
  </ul></section>`;
}

function chargeDetails(totals, api) {
  const rows = [['小計（税抜）', totals.subtotal]];
  if (totals.discount) rows.push(['値引き', -totals.discount]);
  if (totals.service) rows.push(['サービス料', totals.service]);
  rows.push(['消費税', totals.tax]);
  return moneyRows(rows,api);
}

function taxBreakdown({taxBreakdown}, api) {
  if (!taxBreakdown?.length) return '';
  const rows = taxBreakdown.flatMap(({rate,base,tax}) => rate === 0 ? [['非課税対象', base]]
    : [[`${decimal.format(rate / 100)}%対象（税込）`,base + tax],['内消費税',tax]]);
  return `<section class="np-print-section np-print-tax"><h4>会計全体の税率別内訳</h4>${moneyRows(rows,api)}</section>`;
}

function paymentGroups(payments, prefix = '') {
  const byMethod = new Map();
  for (const {method, amount} of payments) byMethod.set(method,(byMethod.get(method) ?? 0) + amount);
  return [...byMethod.entries()].map(([method,amount]) => [prefix + (Object.hasOwn(methods,method) ? methods[method] : 'その他'),amount]);
}

function receiptPayments(ticket, api) {
  const deposits = paymentGroups(ticket.deposits ?? [],'前受金・');
  const payments = paymentGroups(ticket.payments ?? []);
  if (!deposits.length && !payments.length) return '';
  return `<section class="np-print-section"><h4>会計時の支払内訳</h4>${moneyRows([...deposits,...payments],api)}</section>`;
}

function amountLine(label, amount, {escape, yen}) {
  return `<div class="np-print-amount"><span>${escape(label)}</span><strong>${yen(amount)}</strong></div>`;
}

function confirmationAmount(totals, api) {
  const lines = [['会計合計（税込）', totals.total]];
  if (totals.deposit) lines.push(['前受金', -totals.deposit]);
  return `${moneyRows(lines,api)}${amountLine('お支払い予定額',totals.remaining,api)}`;
}

function invoiceHeader(ticket, issuerAt, recipient, purpose, api) {
  const {escape} = api;
  const date = dateLabel(issuerAt,calendar);
  const honorific = /(?:様|御中)$/.test(recipient.trim()) ? '' : ' 様';
  return `<div class="np-print-invoice-data">${date ? `<p>発行日 ${escape(date)}</p>` : ''}
    <p class="np-print-recipient">${recipient ? `${escape(recipient)}${honorific}` : '宛名'}</p>
    ${amountLine('領収金額',getPrintTenderReceived(ticket),api)}
    <p class="np-print-purpose"><strong>但し書き</strong> ${escape(purpose || '—')}</p></div>`;
}

function invoiceBalance(totals, api) {
  return moneyRows([['会計合計（税込）',totals.total],['会計時の売掛',totals.receivable]],api);
}

export function renderPrintPreview({ticket, totals, date, tables = [], kind, settings, storeName,
  issueNumber = 1, issuedAt, recipient = '', purpose = ''}, api) {
  const {escape} = api;
  if (!ticket || !totals || !Object.hasOwn(printDocumentTitles,kind)) return '';
  const width = Number(settings.width) === 80 ? 80 : 58;
  const name = settings.storeName || storeName || 'NP POS';
  const when = kind === 'check' ? dateLabel(issuedAt,timestamp) : dateLabel(ticket.settledAt,timestamp);
  const tableLabel = Array.isArray(tables) ? tables.join('・') : tables;
  const printerMeta = [settings.phone && `TEL ${settings.phone}`,settings.registrationNumber && `登録番号 ${settings.registrationNumber}`].filter(Boolean);
  return `<article class="np-print-paper" data-paper-width="${width}" data-print-kind="${kind}">
    <header class="np-print-paper-header">
      ${issueNumber > 1 ? '<p class="np-print-reissue">再発行</p>' : ''}
      <h3>${printDocumentTitles[kind]}</h3>
      <p class="np-print-store-name">${escape(name)}</p>
      ${settings.address ? `<p class="np-print-address">${escape(settings.address)}</p>` : ''}
      ${printerMeta.map((value) => `<p>${escape(value)}</p>`).join('')}
    </header>
    <div class="np-print-meta">
      <span><strong>伝票 No. ${escape(ticket.number ?? '')}</strong>${tableLabel ? ` ／ ${escape(tableLabel)}` : ''}</span>
      ${date ? `<span>営業日 ${escape(date)}</span>` : ''}
      ${when ? `<span>${kind === 'check' ? '確認日時' : '会計日時'} ${escape(when)}</span>` : ''}
    </div>
    ${kind === 'invoice' ? invoiceHeader(ticket,issuedAt ?? ticket.settledAt,recipient,purpose,api) : ''}
    ${lineItems(ticket,settings.showItems !== false,api)}
    ${kind === 'invoice' ? (totals.receivable ? `<section class="np-print-section">${invoiceBalance(totals,api)}</section>` : '')
      : `<section class="np-print-section">${chargeDetails(totals,api)}
        ${kind === 'check' ? confirmationAmount(totals,api) : amountLine('会計合計（税込）',totals.total,api)}</section>`}
    ${kind === 'receipt' ? receiptPayments(ticket,api) : ''}
    ${taxBreakdown(totals,api)}
    ${kind === 'check' ? '<p class="np-print-note">お支払い前に会計内容をご確認ください。</p>' : ''}
  </article>`;
}
