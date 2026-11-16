import { getPrintAutoKind, getPrintDocumentRules, getPrintTenderReceived, printAutoOptions, printGroupingOptions,
  printInvoiceDateOptions, printItemsOptions } from './print-domain.mjs';

export const printDocumentTitles = Object.freeze({ check: '会計確認伝票', receipt: 'レシート', invoice: '領収書' });

const methods = { cash: '現金', card: 'カード', qr: 'QR決済' };
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
  const select = (name,values,selected) => `<select name="${name}">${Object.entries(values).map(([id,label]) =>
    `<option value="${id}"${id === selected ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
  const section = (kind,title) => {
    const {grouping,items,showTender,storeCopy} = getPrintDocumentRules(settings,kind);
    return `<details class="store-editor-advanced np-print-rule"><summary>${title}</summary>
      <div class="store-editor-advanced-body"><div class="form-grid">
        ${field('明細の表示',select(`printItems-${kind}`,printItemsOptions,items))}
        ${field('明細のまとめ方',select(`printGrouping-${kind}`,printGroupingOptions,grouping),
          '担当者ごとにまとめる場合は、担当者名も印字します。')}
      </div><div class="np-print-switches">
        <label class="inline-check"><input type="checkbox" name="printTender-${kind}"${showTender ? ' checked' : ''}>支払いの内訳を印字する</label>
        <label class="inline-check"><input type="checkbox" name="printCopy-${kind}"${storeCopy ? ' checked' : ''}>店控えも同時に印刷する</label>
      </div></div></details>`;
  };
  return `<div class="np-print-settings"><div class="form-grid">
    ${field('既定の印刷幅', widthSelect(settings.width))}
    ${field('印字する店名', input('printStoreName','storeName',80,'placeholder="店舗名を使用"'))}
    ${field('住所（任意）', input('printAddress','address',160))}
    ${field('電話番号（任意）', input('printPhone','phone',40,'type="tel"'))}
    ${field('登録番号（任意）', input('printRegistrationNumber','registrationNumber',32,'placeholder="Tから始まる登録番号"'))}</div>
    <div class="np-print-switches"><label class="inline-check"><input type="checkbox" name="printShowItems"${settings.showItems !== false ? ' checked' : ''}>商品・プラン明細を印字する（共通設定）</label>
    ${field('会計確定時に開く印刷画面',select('printAutoKind',printAutoOptions,getPrintAutoKind(settings)))}
    ${field('領収書の日付の基準',select('printInvoiceDate',printInvoiceDateOptions,settings.invoiceDate ?? 'issued'))}
    ${field('領収書の既定の但し書き',input('printInvoicePurpose','invoicePurpose',120,'placeholder="ご飲食代"'))}</div>
    <section><h3>帳票別の印字設定</h3>
      ${Object.entries(printDocumentTitles).map(([kind,title])=>section(kind,title)).join('')}</section>
    <p class="field-help">印刷ダイアログの用紙も、プリンターのロール幅に合わせてください。</p></div>`;
}

function moneyRows(rows, {yen, escape}) {
  return `<dl class="np-print-rows">${rows.map(([label, amount]) =>
    `<div><dt>${escape(label)}</dt><dd>${amount < 0 ? '−' : ''}${yen(Math.abs(amount))}</dd></div>`).join('')}</dl>`;
}

function lineItems(ticket, detailed, grouping, inclusive, {escape, yen}) {
  const lines = (ticket.lines ?? []).filter(({cancelledAt,hideReceiptLine,price,total}) =>
    cancelledAt == null && !(hideReceiptLine === true && price === 0 && total === 0));
  if (!detailed || !lines.length) return '';
  const groups = new Map();
  for (const [index,line] of lines.entries()) {
    const castId = grouping === 'cast' ? JSON.stringify([...(line.castIds ?? [])].sort()) : '';
    if (!groups.has(castId)) groups.set(castId,{name: grouping === 'cast' ? (line.castNames ?? []).join('・') || '担当者の指定なし' : '',entries:new Map()});
    const {entries} = groups.get(castId);
    const productKey = grouping === 'line' ? index
      : JSON.stringify([line.menuId,line.printName ?? line.name,line.price,line.taxRate,line.serviceEligible]);
    const existing = entries.get(productKey);
    if (existing) {
      existing.quantity += line.quantity;
      existing.total += line.total;
    } else {
      entries.set(productKey,{...line});
    }
  }
  return `<section class="np-print-section"><h4>会計明細（${inclusive ? '税込' : '税抜'}）</h4>
    ${[...groups.values()].map(({name,entries})=>`${name ? `<p class="np-print-cast">${escape(name)}</p>` : ''}<ul class="np-print-items">${[...entries.values()].map((line) => `
    <li><span>${escape(line.printName ?? line.name)}<small>${yen(line.price)} × ${quantities.format(line.quantity)}</small></span><strong>${yen(line.total)}</strong></li>`).join('')}
    </ul>`).join('')}</section>`;
}

function chargeDetails(totals, api) {
  const inclusive = totals.priceMode === 'inclusive';
  const rows = [[inclusive ? '小計（税込）' : '小計（税抜）', totals.subtotal]];
  if (totals.discount) rows.push(['値引き', -totals.discount]);
  if (totals.service) rows.push(['サービス料', totals.service]);
  const taxLabel = inclusive ? 'うち消費税' : '消費税';
  rows.push([totals.cardFee ? `${taxLabel}（加算前）` : taxLabel, totals.tax - (totals.cardFeeTax ?? 0)]);
  if (totals.cardFee) rows.push([totals.brandedFee ? '決済加算（税込）' : 'カード会計加算（税込）',totals.cardFee]);
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
  for (const {method, amount,brandName} of payments) {
    if (!Object.hasOwn(methods,method)) continue;
    const label = brandName || methods[method];
    byMethod.set(label,(byMethod.get(label) ?? 0) + amount);
  }
  return [...byMethod.entries()].map(([label,amount]) => [prefix + label,amount]);
}

function receiptPayments(ticket, api) {
  const deposits = paymentGroups(ticket.deposits ?? [],'前受金・');
  const payments = paymentGroups(ticket.payments ?? []);
  if (!deposits.length && !payments.length) return '';
  const tender = ticket.cashTender;
  const rows = [...deposits,...payments];
  if (tender) rows.push(['現金お預かり',tender.received],['お釣り',tender.change]);
  return `<section class="np-print-section"><h4>受取内訳</h4>${moneyRows(rows,api)}</section>`;
}

function amountLine(label, amount, {escape, yen}) {
  return `<div class="np-print-amount"><span>${escape(label)}</span><strong>${yen(amount)}</strong></div>`;
}

export function renderExtensionQuote({ticket, tables, date, entries, before, deductAdvance, settings, storeName, at}, api) {
  const {escape} = api;
  const tableLabel = tables.join('・');
  const currentAmount = deductAdvance ? before.remaining : before.total;
  const plans = entries.map(({name,duration,endsAt,after}) => {
    const rows = [['延長追加額（税込）',after.total - before.total]];
    if (deductAdvance && after.deposit) rows.push(['延長後の会計合計（税込）',after.total],['受領済みの前受金',-after.deposit]);
    return `<section class="np-print-section"><h4>${escape(name)}</h4>
      <p>${ticket.guests}名 ／ ${duration}分延長</p><p>終了予定 ${dateLabel(endsAt,timestamp)}</p>
      ${moneyRows(rows,api)}${amountLine(deductAdvance ? '延長後のお支払い予定額' : '延長後の会計合計（税込）',
      deductAdvance ? after.remaining : after.total,api)}</section>`;
  }).join('');
  return `<article class="np-print-paper" data-paper-width="${Number(settings.width) === 80 ? 80 : 58}" data-print-kind="extension-quote">
    <header class="np-print-paper-header"><h3>延長見積書</h3>
      <p class="np-print-store-name">${escape(settings.storeName || storeName || 'NP POS')}</p></header>
    <div class="np-print-meta"><span><strong>伝票 No. ${escape(ticket.number)}</strong>${tableLabel ? ` ／ ${escape(tableLabel)}` : ''}</span>
      <span>営業日 ${escape(date)}</span><span>見積日時 ${dateLabel(at,timestamp)}</span></div>
    <section class="np-print-section">${moneyRows([[deductAdvance ? '現在のお支払い予定額' : '現在の会計合計（税込）',currentAmount]],api)}</section>
    ${plans}
    <p class="np-print-note">追加のご注文やお支払い方法により、会計時の金額が変わる場合があります。</p>
  </article>`;
}

function confirmationAmount(totals, api) {
  const lines = [['会計合計（税込）', totals.total]];
  if (totals.deposit) lines.push(['前受金', -totals.deposit]);
  return `${moneyRows(lines,api)}${amountLine('お支払い予定額',totals.remaining,api)}`;
}

function invoiceHeader(ticket, issuerAt, businessDate, settings, recipient, purpose, api) {
  const {escape} = api;
  const isBusinessDate = settings.invoiceDate === 'business' && businessDate;
  const date = isBusinessDate ? businessDate.replaceAll('-','/') : dateLabel(issuerAt,calendar);
  const honorific = /(?:様|御中)$/.test(recipient.trim()) ? '' : ' 様';
  return `<div class="np-print-invoice-data">${date ? `<p>${isBusinessDate ? '取引日（営業日）' : '発行日'} ${escape(date)}</p>` : ''}
    <p class="np-print-recipient">${recipient ? `${escape(recipient)}${honorific}` : '宛名'}</p>
    ${amountLine('領収金額',getPrintTenderReceived(ticket),api)}
    <p class="np-print-purpose"><strong>但し書き</strong> ${escape(purpose || '—')}</p></div>`;
}

function renderPrintDocument({ticket, totals, date, tables = [], kind, settings, storeName,
  issueNumber = 1, issuedAt, recipient = '', purpose = ''}, rules, storeCopy, api) {
  const {escape} = api;
  const width = Number(settings.width) === 80 ? 80 : 58;
  const name = settings.storeName || storeName || 'NP POS';
  const when = kind === 'check' ? dateLabel(issuedAt,timestamp) : dateLabel(ticket.settledAt,timestamp);
  const tableLabel = Array.isArray(tables) ? tables.join('・') : tables;
  const printerMeta = [settings.phone && `TEL ${settings.phone}`,settings.registrationNumber && `登録番号 ${settings.registrationNumber}`].filter(Boolean);
  const detailed = rules.items === 'default' ? settings.showItems !== false : rules.items === 'show';
  return `<article class="np-print-paper" data-paper-width="${width}" data-print-kind="${kind}"${storeCopy ? ' data-print-copy="store"' : ''}>
    <header class="np-print-paper-header">
      ${issueNumber > 1 ? '<p class="np-print-reissue">再発行</p>' : ''}
      <h3>${printDocumentTitles[kind]}</h3>
      ${storeCopy ? '<p class="np-print-copy">店舗控え</p>' : ''}
      <p class="np-print-store-name">${escape(name)}</p>
      ${settings.address ? `<p class="np-print-address">${escape(settings.address)}</p>` : ''}
      ${printerMeta.map((value) => `<p>${escape(value)}</p>`).join('')}
    </header>
    <div class="np-print-meta">
      <span><strong>伝票 No. ${escape(ticket.number ?? '')}</strong>${tableLabel ? ` ／ ${escape(tableLabel)}` : ''}</span>
      ${date ? `<span>営業日 ${escape(date)}</span>` : ''}
      ${when ? `<span>${kind === 'check' ? '確認日時' : '会計日時'} ${escape(when)}</span>` : ''}
    </div>
    ${kind === 'invoice' ? invoiceHeader(ticket,issuedAt ?? ticket.settledAt,date,settings,recipient,purpose,api) : ''}
    ${lineItems(ticket,detailed,rules.grouping,totals.priceMode === 'inclusive',api)}
    ${kind === 'invoice' ? ''
      : `<section class="np-print-section">${chargeDetails(totals,api)}
        ${kind === 'check' ? confirmationAmount(totals,api) : amountLine('会計合計（税込）',totals.total,api)}</section>`}
    ${rules.showTender ? receiptPayments(ticket,api) : ''}
    ${taxBreakdown(totals,api)}
    ${kind === 'check' ? '<p class="np-print-note">お支払い前に会計内容をご確認ください。</p>' : ''}
  </article>`;
}

export function renderPrintPreview(context, api) {
  const {ticket,totals,kind,settings} = context;
  if (!ticket || !totals || !Object.hasOwn(printDocumentTitles,kind)) return '';
  const rules = getPrintDocumentRules(settings,kind);
  return renderPrintDocument(context,rules,false,api)
    + (rules.storeCopy ? renderPrintDocument(context,rules,true,api) : '');
}
