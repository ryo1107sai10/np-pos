import { apply, businessDate, createDemo, getTicketForTable, quote, summary, tableStatus, yen } from './engine.mjs';
import { icon } from './icons.mjs';
import { renderReport } from './reports.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notifications = document.querySelector('#notifications');
const storageKey = 'np-pos.demo.v1';
const legacyStorageKey = 'lumi-pos.demo.v1';
const pages = {
  floor: { title: 'ホール', icon: 'grid', help: '席を選んで、来店・注文・延長・会計を操作できます。' },
  commission: { title: '歩合・成績', icon: 'users', help: 'キャストごとの歩合を、確定額と見込額で確認できます。' },
  stock: { title: '在庫', icon: 'box', help: 'メニューの注文に連動した在庫と、品目の増減履歴。' },
  reports: { title: '営業レポート', icon: 'chart', help: '営業日ごとの売上、支払い、レジ締めを確認できます。' },
};
const statuses = {
  available: '空席', active: '利用中', soon: '終了間近', overtime: '時間超過', paid: '会計済',
};
const methods = { cash: '現金', card: 'カード', qr: 'QR決済' };
const categories = ['よく使う', 'ドリンク', 'ボトル', 'フード', '指名'];
const dateTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const prettyDate = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' });
const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 });

let state = loadState();
let page = readPage();
let selected = state.tables.find((table) => getTicketForTable(state, table.id))?.id ?? null;
let area = 'all';
let filter = 'all';
let mobileDetails = false;
let modal = null;
let priorFocus = null;
let lastStatuses = '';
let lastMinute = '';
let saveAvailable = true;
let pendingStorage = false;
let committing = false;

function escape(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function loadState() {
  try {
    const stored = JSON.parse((localStorage.getItem(storageKey) ?? localStorage.getItem(legacyStorageKey)));
    if (stored?.day && Array.isArray(stored.tables) && Array.isArray(stored.tickets) && Array.isArray(stored.menu)) return stored;
  } catch { /* A fresh sample is available when storage is blocked. */ }
  return createDemo();
}

function saveState(next) {
  state = next;
  try { localStorage.setItem(storageKey, JSON.stringify(state)); }
  catch { saveAvailable = false; }
}

function readPage() {
  const key = window.location.hash.slice(1);
  return Object.hasOwn(pages, key) ? key : 'floor';
}

function go(key) {
  if (!Object.hasOwn(pages, key)) return;
  page = key;
  if (window.location.hash !== `#${key}`) history.replaceState(null, '', `#${key}`);
  window.scrollTo(0, 0);
  render();
}

function timer(endsAt, now = Date.now()) {
  const seconds = Math.floor(Math.abs(endsAt - now) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function button(text, action, { glyph, tone = '', cls = '', id, data = '', disabled = false } = {}) {
  return `<button type="button" class="btn ${tone ? `btn-${tone}` : ''} ${cls}" data-action="${action}"${id === undefined ? '' : ` data-id="${escape(id)}"`} ${data}${disabled ? ' disabled' : ''}>${glyph ? icon(glyph, 16) : ''}${text}</button>`;
}

function pill(status, label = statuses[status]) {
  return `<span class="pill pill-${status}"><span class="dot"></span>${label}</span>`;
}

function tableName(id) {
  return state.tables.find((table) => table.id === id)?.name ?? id;
}

function staffName(id) {
  return state.cast.find((person) => person.id === id)?.name ?? id;
}

function titles(ticket) {
  return ticket.tableIds.map(tableName).join('・');
}

function renderSide() {
  return `<aside class="sidebar">
    <div class="brand" aria-label="NP POS"><img src="np-pos.svg" alt="" width="38" height="38"><span class="brand-word">NP <small>POS</small></span></div>
    <div class="store"><span class="store-icon">${icon('store', 16)}</span><span class="store-name">銀座店<small>デモ店舗</small></span></div>
    <nav class="side-nav" aria-label="メインメニュー">
      ${Object.entries(pages).map(([key, value]) => `<button type="button" class="nav-link" data-action="navigate" data-id="${key}" ${page === key ? 'aria-current="page"' : ''}>${icon(value.icon, 18)}<span>${value.title}</span></button>`).join('')}
    </nav>
    <div class="side-bottom">
      <button type="button" class="demo-button" data-action="demo" aria-label="サンプル操作" title="サンプル操作">${icon('refresh', 16)}<span>サンプル操作</span>${icon('chevron-right', 14)}</button>
      <div class="operator"><span class="avatar">店</span><div><strong>店舗管理者</strong><small>デモモード</small></div></div>
    </div>
  </aside>`;
}

function renderTop() {
  const isOpen = state.day.status === 'open';
  const date = prettyDate.format(new Date(`${state.day.date}T12:00:00+09:00`));
  return `<div class="workspace-top"><div class="open-meta"><span class="workspace-store">${icon('store',15)}<span class="store-label">銀座店</span><span class="mobile-wordmark"><img src="np-pos.svg" width="20" height="20" alt="">NP POS</span></span><span class="meta-sep"></span>${icon('calendar',16)}<span>${date} 営業日</span></div><div class="workspace-time"><span class="live ${isOpen ? '' : 'closed'}"><span class="dot"></span>${isOpen ? '営業中' : '営業時間外'}</span><span class="meta-sep"></span><time id="workspace-time">${dateTime.format(Date.now())}</time><span>JST</span></div></div>
    <header class="page-head"><div><h1>${pages[page].title}</h1><p>${pages[page].help}</p></div><div class="actions">
    ${page === 'floor' ? (isOpen ? button('閉店処理','close',{ glyph: 'checkout' }) + button('来店登録','seat',{ glyph: 'plus', tone: 'primary' }) : button('開店する','open',{ glyph: 'power', tone: 'primary' })) : ''}</div></header>`;
}

function renderMetrics() {
  const totals = summary(state);
  const soon = state.tables.filter((table) => ['soon','overtime'].includes(tableStatus(state,table.id))).length;
  const active = new Set(state.tickets.filter((ticket) => ticket.status === 'open').map((ticket) => ticket.id)).size;
  const figures = [
    ['table', '稼働卓', `${totals.occupied} <small>/ ${totals.totalTables}卓</small>`, `${totals.totalTables - totals.occupied}卓が空席`, ''],
    ['trend','営業売上',yen(totals.sales), `会計済み ${totals.tickets}組`, 'green'],
    ['clock','終了間近・超過', `${soon} <small>卓</small>`, '残り10分以下を表示', 'amber'],
    ['ticket','未会計の伝票', `${active} <small>件</small>`, `退店待ち ${totals.paidTickets ?? 0}組`, 'blue'],
  ];
  return `<section aria-label="営業状況" class="metrics">${figures.map(([glyph,label,value,hint,tone]) => `<article class="metric"><span class="metric-icon ${tone}">${icon(glyph, 19)}</span><div><div class="metric-title">${label}</div><div class="metric-value numeric">${value}</div><div class="metric-hint">${hint}</div></div></article>`).join('')}</section>`;
}

function renderTable(table) {
  const ticket = getTicketForTable(state, table.id);
  const status = tableStatus(state, table.id);
  const isSelected = table.id === selected;
  const name = escape(table.name);
  return `<button type="button" class="seat seat-${status}${isSelected ? ' is-selected' : ''}" data-action="table" data-id="${escape(table.id)}" aria-pressed="${isSelected}" aria-label="${name} ${statuses[status]}${ticket?.tableIds.length > 1 ? ' 複数卓' : ''}">
    <div class="seat-top"><span><span class="seat-name">${name}</span><span class="seat-area">${escape(table.area)}${ticket?.tableIds.length > 1 ? ` <span class="seat-linked">· ${ticket.tableIds.length}卓共有</span>` : ''}</span></span>${pill(status)}</div>
    <div class="seat-timer">${icon(ticket ? (status === 'paid' ? 'check' : 'clock') : 'plus',14)}${ticket ? status === 'paid' ? '退店待ち' : `<time data-ends="${ticket.endsAt}">${timer(ticket.endsAt)}</time>` : '来店登録'}</div>
    <div class="seat-bottom"><span class="seat-guests">${icon('users',13)}${ticket ? ticket.tableIds.length > 1 ? `${ticket.guests}名` : `${ticket.guests}名` : `定員${table.capacity}名`}</span>
    ${ticket ? `<span class="seat-price money">${yen(quote(state,ticket.id).total)}</span>` : `<span class="available-price">${icon('arrow-right',14)}</span>`}</div>
  </button>`;
}

function renderFloor() {
  const isOpen = state.day.status === 'open';
  const range = state.tables.filter((table) => area === 'all' || area === table.area);
  const counts = { all: range.length, used: 0, available: 0, urgent: 0 };
  const visible = range.filter((table) => {
    const status = tableStatus(state, table.id);
    counts[status === 'available' ? 'available' : 'used']++;
    if (status === 'soon' || status === 'overtime') counts.urgent++;
    return filter === 'all' || (filter === 'used' && status !== 'available') || filter === status || (filter === 'urgent' && ['soon','overtime'].includes(status));
  });
  const areas = [...new Set(state.tables.map((table) => table.area))];
  return `${!isOpen ? `<div class="notice"><span>${icon('info',17)}開店すると、空席から来店を登録できます。</span></div>` : ''}${renderMetrics()}
    <div class="floor-layout">
      <section class="floor" aria-labelledby="floor-title"><div class="floor-heading"><h2 id="floor-title">${icon('grid',17)}座席一覧</h2></div>
      <div class="seating-toolbar glass"><div class="seg" role="group" aria-label="卓の状態で絞り込む">${[['all','すべて'],['used','使用中'],['available','空席'],['urgent','要対応']].map(([key,text])=>`<button type="button" data-action="filter" data-id="${key}" aria-pressed="${key===filter}">${text}<small>${counts[key]}</small></button>`).join('')}</div><label class="area-filter" title="エリア">${icon('filter', 16)}<select id="area-filter" aria-label="エリアで絞り込む"><option value="all">全エリア</option>${areas.map((name) => `<option ${area === name ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select></label></div>
      <div class="table-grid">${visible.length ? visible.map(renderTable).join('') : '<p class="empty-grid">該当する卓はありません。</p>'}</div></section>
      ${mobileDetails ? `<button type="button" class="detail-shade" data-action="hide-detail" aria-hidden="true" tabindex="-1"></button>` : ''}${renderDetail()}
    </div>`;
}

function totalRows(q, { settlement = false, large = false } = {}) {
  const taxLabel = q.taxBreakdown.length === 1 ? `消費税（${q.taxBreakdown[0].rate / 100}%）` : '消費税';
  return `<dl class="totals ${large ? 'totals-large' : ''}">
    <div><dt>小計</dt><dd class="money">${yen(q.subtotal)}</dd></div>
    ${q.discount ? `<div><dt>値引き</dt><dd class="money">−${yen(q.discount)}</dd></div>` : ''}
    <div><dt>サービス料</dt><dd class="money">${yen(q.service)}</dd></div>
    <div><dt>${taxLabel}</dt><dd class="money">${yen(q.tax)}</dd></div>
    ${large && q.taxBreakdown.length > 1 ? q.taxBreakdown.map((tax) => `<div><dt>税率 ${tax.rate / 100}%</dt><dd>${yen(tax.tax)}</dd></div>`).join('') : ''}
    <div class="total"><dt>${settlement ? '合計' : '合計（税込）'}</dt><dd class="money">${yen(q.total)}</dd></div>
    ${q.deposit ? `<div><dt>前受金</dt><dd class="money">−${yen(q.deposit)}</dd></div>` : ''}
    ${settlement && q.paid ? `<div><dt>会計時のお支払い</dt><dd class="money">${yen(q.paid)}</dd></div>` : ''}
    ${(!settlement && (large || q.deposit)) ? `<div class="balance"><dt>未収額</dt><dd class="money">${yen(q.remaining)}</dd></div>` : ''}
  </dl>`;
}

function renderDetail() {
  const ticket = selected && getTicketForTable(state, selected);
  const detailClose = `<button type="button" class="icon-btn detail-mobile-close" data-action="hide-detail" aria-label="伝票詳細を閉じる">${icon('x',18)}</button>`;
  if (!ticket) return `<aside class="detail ${mobileDetails ? 'mobile-visible' : ''}" aria-label="伝票詳細"><div class="detail-head"><h2>${icon('ticket',17)}伝票詳細</h2>${detailClose}</div><div class="detail-empty"><span class="metric-icon">${icon('table',23)}</span><h3>卓を選択</h3><p>利用中の卓を選ぶと、注文と会計の内訳を確認できます。</p>${state.day.status === 'closed' ? button('開店する','open',{glyph:'power',tone:'secondary'}) : ''}</div></aside>`;
  const q = quote(state,ticket.id);
  const status = tableStatus(state,selected);
  const settled = ticket.status === 'paid';
  const lines = ticket.lines.filter((line)=>!line.cancelledAt);
  return `<aside class="detail ${mobileDetails ? 'mobile-visible' : ''}" aria-label="伝票詳細" data-ticket="${escape(ticket.id)}">
    <div class="detail-head"><h2>${icon('ticket',17)}伝票詳細</h2><span class="detail-number">No. ${ticket.number}</span>${detailClose}</div>
    <div class="detail-inner"><div class="detail-title"><h3>${escape(tableName(selected))}</h3>${pill(status)}</div>
    <div class="detail-meta"><span>${icon('users',13)}${ticket.guests}名${ticket.customer ? ` · ${escape(ticket.customer)}` : ''}</span><span>${settled ? `${icon('check',13)}退店待ち` : `${icon('clock',13)}<time data-ends="${ticket.endsAt}">${timer(ticket.endsAt)}</time>`}</span></div>
    ${ticket.tableIds.length > 1 ? `<div class="detail-links" aria-label="同じ伝票の卓">${ticket.tableIds.map(id=>`<span class="detail-link">${escape(tableName(id))}</span>`).join('')}</div>` : ''}
    <div class="detail-aux"><h3>注文明細 <small>${lines.length}</small></h3>${settled ? '' : button('卓移動・連結','move',{glyph:'move',id:ticket.id})}</div>
    <ul class="ticket-lines">${lines.length ? lines.map((line) => `<li class="ticket-line"><span class="line-desc">${escape(line.name)} <em>×${line.quantity}</em>${line.castIds.length ? `<small>${line.castIds.map(staffName).map(escape).join('・')}</small>` : ''}</span><span class="money">${yen(line.total)}</span>${!settled && !['セット','延長'].includes(line.category) ? `<button class="line-remove" type="button" data-action="cancel-line" data-id="${escape(line.id)}" data-ticket="${escape(ticket.id)}" aria-label="${escape(line.name)}を取り消す">${icon('x',13)}</button>` : ''}</li>`).join('') : '<li class="lines-empty">注文明細はありません。</li>'}</ul>
    ${totalRows(q,{settlement:settled})}
    ${!settled ? `<div class="mini-tools">${button('前受金','deposit',{glyph:'wallet',tone:'quiet',id:ticket.id})}${button('値引き','discount',{glyph:'minus',tone:'quiet',id:ticket.id})}${button('ハイボール','order',{glyph:'plus',tone:'quiet',id:ticket.id,data:'data-product="highball"'})}${button('卓履歴','seat-history',{glyph:'history',tone:'quiet',id:ticket.id})}</div>` : ''}
    <div class="detail-actions">${!settled ? `${button('注文','order',{glyph:'plus',tone:'secondary',id:ticket.id})}${button('延長','extend',{glyph:'clock',id:ticket.id})}${button('会計へ進む','settle',{glyph:'arrow-right',tone:'primary',id:ticket.id,cls:'btn-block'})}` : `${button('会計内訳','receipt',{glyph:'ticket',id:ticket.id,cls:'btn-block'})}${button('退店・卓を解放','depart',{glyph:'checkout',tone:'primary',id:ticket.id,cls:'btn-block'})}`}</div></div></aside>`;
}

function render({ preserveFocus = false } = {}) {
  const focused = preserveFocus ? document.activeElement : null;
  const focusAction = focused?.dataset.action;
  const focusId = focused?.dataset.id;
  lastStatuses = state.tables.map((table)=>tableStatus(state,table.id)).join('|');
  lastMinute = dateTime.format(Date.now());
  app.innerHTML = `<div class="shell">${renderSide()}<main class="workspace" id="workspace" tabindex="-1">${renderTop()}${page==='floor' ? renderFloor() : renderReport(page,state,{yen,summary,quote,escape,icon})}</main></div>`;
  document.title = `NP POS | ${pages[page].title}`;
  if (focusAction) [...app.querySelectorAll('[data-action]')].find((el) => el.dataset.action === focusAction && el.dataset.id === focusId)?.focus({ preventScroll: true });
}

function toast(message) {
  const item = document.createElement('div');
  item.className = 'toast';
  item.innerHTML = `${icon('check',17)}<span>${escape(message)}</span>`;
  notifications.append(item);
  setTimeout(()=>item.remove(), 4300);
}

function showError(message) {
  const box = dialog.querySelector('.form-error');
  if (box) { box.textContent = message; box.hidden = false; }
}

async function commit(command, message, after) {
  if (committing) return;
  committing = true;
  const activeModal = modal;
  const submit = dialog.querySelector('#submit-dialog');
  if (submit) submit.disabled = true;
  const update = () => {
    if (!dialog.open || modal !== activeModal) return;
    let latest;
    try { latest = localStorage.getItem(storageKey); } catch { /* Storage can be disabled. */ }
    if (modal?.stale || (latest && latest !== JSON.stringify(state))) {
      modal.stale = true;
      pendingStorage = true;
      throw new Error('別のタブでデータが更新されました。画面を閉じ、最新状態を確認してください。');
    }
    const next = apply(state, command);
    saveState(next);
    if (after) after(next);
    dialog.close();
    render();
    if (message) toast(message);
    if (!saveAvailable) toast('ブラウザーの設定により操作内容を保存できません。');
  };
  try {
    if (navigator.locks?.request) await navigator.locks.request(storageKey, update);
    else update();
  } catch (error) { showError(error.message); }
  finally { committing = false; if (submit?.isConnected) submit.disabled = false; }
}

function openDialog(type, data = {}) {
  if (!dialog.open) priorFocus = document.activeElement;
  modal = { type, ...data };
  paintDialog();
  if (!dialog.open) dialog.showModal();
}

function present(title, body, primary, { submit = true, style = '' } = {}) {
  dialog.className = `modal ${style}`;
  dialog.innerHTML = `<form id="dialog-form"><header class="modal-head"><h2 id="dialog-title">${title}</h2><button type="button" class="icon-btn" data-action="dismiss" aria-label="閉じる">${icon('x',19)}</button></header><div class="modal-body">${body}<p class="form-error" role="alert" hidden></p></div>${primary ? `<footer class="modal-foot">${button('キャンセル','dismiss',{tone:'quiet'})}${submit ? `<button type="submit" class="btn btn-primary" id="submit-dialog">${primary}</button>` : primary}</footer>` : ''}</form>`;
}

function label(title, control, help = '') {
  return `<label class="field"><span>${title}</span>${control}${help ? `<small>${help}</small>` : ''}</label>`;
}

function methodSelect(name, method = 'cash') {
  return `<select name="${name}" aria-label="支払方法">${Object.entries(methods).map(([key,text])=>`<option value="${key}" ${key===method?'selected':''}>${text}</option>`).join('')}</select>`;
}

function seatPicker(selectedIds,{ticketId,primary=null}={}) {
  return `<fieldset class="choices"><legend>使用する卓</legend><div class="choice-grid">${state.tables.map((table) => {
    const holder = getTicketForTable(state,table.id);
    const disabled = (!!holder && holder.id!==ticketId);
    const checked = selectedIds.includes(table.id);
    return `<label class="choice"><input type="checkbox" name="tableIds" value="${escape(table.id)}" ${checked || primary===table.id?'checked':''} ${disabled||primary===table.id?'disabled':''}><span><strong>${escape(table.name)}</strong><small>${disabled?'使用中':`${table.capacity}名`}</small></span></label>`;
  }).join('')}</div></fieldset>`;
}

function paintDialog() {
  const ticket = modal.ticketId ? state.tickets.find((item)=>item.id===modal.ticketId) : null;
  const id = modal.ticketId;
  const q = ticket ? quote(state,id) : null;
  const headline = ticket ? `<div class="modal-context">${icon('table',16)}<strong>${escape(titles(ticket))}</strong><span>${ticket.guests}名${ticket.customer ? ` · ${escape(ticket.customer)}` : ''}</span></div>` : '';
  switch (modal.type) {
    case 'demo':
      present('サンプル操作',`<p class="form-copy">開店前から操作するか、進行中の伝票が入ったホールを確認できます。選ぶと、このブラウザーの操作履歴を初期化します。</p><div class="demo-options">${button('開店から試す','demo-start',{glyph:'power',tone:'primary'})}${button('営業中のサンプルを読み込む','demo-live',{glyph:'refresh'})}</div>`,null);
      return;
    case 'open': {
      const current = businessDate();
      const latest = state.closedDays[0]?.date;
      const suggested = latest && current <= latest ? new Date(Date.parse(latest)+86400000).toISOString().slice(0,10) : current;
      present('開店処理',`<p class="form-copy">営業日とレジの釣銭準備金を入力してください。</p><div class="form-grid">${label('営業日',`<input name="date" type="date" required value="${suggested}">`,'営業日の切替は午前6時です。')}${label('釣銭準備金（円）','<input name="openingCash" type="number" min="0" step="1" required value="20000" inputmode="numeric">')}</div>`,'開店を確定');
      return;
    }
    case 'seat': {
      const first = modal.tableId ? [modal.tableId] : [];
      const options = state.menu.filter((item)=>item.category==='セット').map((item)=>`<option value="${item.id}" ${modal.tableId?.startsWith('v') && item.id==='vip60' ? 'selected' : ''}>${escape(item.name)} · ${yen(item.price)}/人</option>`).join('');
      present('来店登録',`<div class="form-grid">${label('来店人数','<input name="guests" type="number" min="1" max="100" step="1" value="2" required inputmode="numeric">')}${label('お客様名（任意）','<input name="customer" maxlength="60" placeholder="例　佐藤様">')}</div>${label('初回セット',`<select name="setId">${options}</select>`)}${seatPicker(first,{primary:modal.tableId})}<p class="field-help">同じグループで複数卓を使う場合は、追加の卓も選択します。伝票・残り時間・会計は全卓で共有します。</p>`,'来店を確定',{style:'modal-wide'});
      return;
    }
    case 'move':
      present('卓移動・連結',`${headline}<p class="form-copy">移動先または追加する卓を選択してください。チェックを外した卓は、確定時に空席になります。</p>${seatPicker(ticket.tableIds,{ticketId:id})}`,'卓の変更を確定',{style:'modal-wide'});
      return;
    case 'order':
      present('注文を追加',`${headline}<div class="order-tools"><div class="seg order-seg" role="group" aria-label="メニューのカテゴリ">${categories.map((text)=>`<button type="button" data-action="category" data-id="${text}" aria-pressed="${modal.category===text}">${text}</button>`).join('')}</div><label class="field"><span class="sr-only">メニュー検索</span><input id="menu-search" placeholder="メニューを検索" value="${escape(modal.search)}"></label></div><div id="order-products">${renderProducts()}</div><div id="order-selection">${renderProductDetails()}</div>`,'注文を確定',{style:'modal-wide'});
      return;
    case 'extend': {
      const options = [30,60].map((minutes)=> {
        const next = apply(state,{type:'extend',ticketId:id,minutes});
        const final = quote(next,id);
        const newTicket = next.tickets.find((current)=>current.id===id);
        return `<label class="extend-option"><input type="radio" name="minutes" value="${minutes}" ${minutes===30?'checked':''}><span><strong>${minutes}分延長</strong><small>終了予定 ${dateTime.format(newTicket.endsAt)}</small></span><span><strong class="money">+${yen(final.total-q.total)}</strong><small>延長後 ${yen(final.total)}</small></span></label>`;
      }).join('');
      present('セットを延長',`${headline}<p class="form-copy">人数、指名料、サービス料・税を含めた追加額です。</p><fieldset class="choices extend-choices"><legend class="sr-only">延長時間</legend>${options}</fieldset>`,'延長を確定');
      return;
    }
    case 'seat-history': {
      const history = ticket.tableHistory ?? [];
      present('使用卓の履歴', `${headline}${history.length ? `<ol class="seat-history">${history.map((entry) => `<li><span class="metric-icon">${icon('table',17)}</span><div><strong>${escape(tableName(entry.tableId))}</strong><p>${dateTime.format(entry.attachedAt)} 〜 ${entry.releasedAt ? dateTime.format(entry.releasedAt) : '使用中'} · JST</p></div></li>`).join('')}</ol>` : '<p class="form-copy">この伝票の使用卓履歴はありません。</p>'}`, null);
      return;
    }
    case 'deposit':
      present('前受金を登録',`${headline}<p class="form-copy">現在の未収額は <strong>${yen(q.remaining)}</strong> です。</p><div class="form-grid">${label('支払方法',methodSelect('method'))}${label('前受金（円）',`<input name="amount" type="number" min="1" max="${q.remaining}" required inputmode="numeric" placeholder="3000">`)}</div>${ticket.deposits.length ? `<ul class="deposit-list">${ticket.deposits.map((entry)=>`<li><span>${methods[entry.method]} · ${yen(entry.amount)}</span>${button('取消','cancel-deposit',{id:entry.id,tone:'danger'})}</li>`).join('')}</ul>` : ''}`,'前受金を確定');
      return;
    case 'discount':
      present('値引きを設定',`${headline}<p class="form-copy">値引きは税抜小計に適用し、サービス料・消費税を再計算します。</p>${label('伝票の値引き額（円）',`<input name="amount" type="number" min="0" max="${q.subtotal}" value="${ticket.discount}" required inputmode="numeric">`,'0円で値引きを解除します。')}`,'値引きを確定');
      return;
    case 'settle':
      present('お会計',`${headline}${totalRows(q,{large:true})}${q.remaining > 0 ? `<p class="form-copy payment-copy">カード・QRは、外部端末で受け取った金額を記録します。</p><div id="payment-rows">${modal.payments.map(renderPayment).join('')}</div>${button('支払方法を追加','add-payment',{glyph:'plus',tone:'quiet'})}<div id="payment-note" class="result-bar" aria-live="polite"></div>` : `<p class="form-copy payment-copy">前受金で全額を充当しました。会計を確定できます。</p>`}`,'会計を確定');
      if (q.remaining > 0) updatePaymentNote();
      return;
    case 'depart':
      present('退店を確定',`${headline}<p class="form-copy">${escape(titles(ticket))}を空席に戻します。確定済みの伝票は営業レポートから確認できます。</p>`,'退店・卓を解放');
      return;
    case 'receipt':
      present(`会計内訳 No. ${ticket.number}`,`${headline}${totalRows(q,{settlement:true,large:true})}<ul class="deposit-list">${[...ticket.deposits,...ticket.payments].map((entry)=>`<li><span>${methods[entry.method]}</span><strong>${yen(entry.amount)}</strong></li>`).join('')}</ul>`,null);
      return;
    case 'cancel-line': {
      const line = ticket.lines.find((item)=>item.id===modal.lineId);
      present('注文を取り消す',`${headline}<p class="form-copy">${escape(line.name)} ×${line.quantity}（${yen(line.total)}）を取り消します。</p>${line.stockUses.length ? `<label class="inline-check"><input type="checkbox" name="returnStock" ${line.providedAt ? 'disabled' : 'checked'}>未提供で再利用できる在庫を戻す</label>` : ''}`,'注文を取り消す');
      return;
    }
    case 'close': {
      const outstanding = state.tickets.filter((item)=>['open','paid'].includes(item.status));
      const totals = summary(state);
      if (outstanding.length) {
        present('閉店処理',`<p class="form-copy">会計または退店が完了していない伝票があります。卓を開いて処理を完了してください。</p><ul class="outstanding">${outstanding.map((row)=>`<li>${button(`${escape(titles(row))} · ${row.status==='paid'?'退店待ち':'未会計'}`,'open-ticket',{glyph:'chevron-right',id:row.id,cls:'btn-block'})}</li>`).join('')}</ul>`,null);
        return;
      }
      present('閉店処理',`<div class="result-bar"><span>理論レジ残高</span><strong>${yen(totals.expectedCash)}</strong></div><div class="form-grid">${label('実際のレジ残高（円）',`<input name="actualCash" type="number" min="0" step="1" required value="${totals.expectedCash}">`)}${label('差額の理由','<input name="reason" maxlength="120" placeholder="差額がある場合に入力">')}</div><p class="form-copy">閉店すると、この営業日の売上と現金差額が営業レポートに保存されます。</p>`,'閉店を確定');
      return;
    }
    case 'stock-adjust': {
      const stock = state.stock.find((item)=>item.id===modal.stockId);
      present('在庫を調整',`<p class="form-copy">${escape(stock.name)} · 現在庫 <strong>${number.format(stock.quantity)}${escape(stock.unit)}</strong></p><div class="form-grid">${label(`数量の増減（${escape(stock.unit)}）`,'<input name="quantity" type="number" step="0.001" required placeholder="例 2 または -0.5">')}${label('調整理由','<input name="reason" required maxlength="120" placeholder="例　仕入れ、棚卸差異">')}</div>`,'調整を確定');
      return;
    }
  }
}

function renderProducts() {
  const query = modal.search.trim().toLowerCase();
  const options = state.menu.filter((item) => {
    if (!['ドリンク','ボトル','フード','指名'].includes(item.category)) return false;
    return query ? `${item.name} ${item.category}`.toLowerCase().includes(query) : modal.category === 'よく使う' ? item.popular : item.category === modal.category;
  });
  if (!options.length) return '<p class="form-copy">該当するメニューはありません。</p>';
  return `<div class="product-grid">${options.map((item) => `<button type="button" class="product" data-action="product" data-id="${item.id}" aria-pressed="${item.id===modal.product}"><span>${escape(item.name)}</span><strong>${yen(item.price)}</strong></button>`).join('')}</div>`;
}

function renderProductDetails() {
  const item = state.menu.find((product)=>product.id === modal.product);
  if (!item) return '<p class="form-copy order-tip">追加するメニューを選択してください。</p>';
  const stockInfo = item.recipe?.map((need)=> {
    const stock = state.stock.find((goods)=>goods.id===need.stockId);
    return `${escape(stock.name)} ${number.format(need.quantity)}${escape(stock.unit)}`;
  }).join('・');
  const commissionInfo = item.commission ? [item.commission.fixed && `${yen(item.commission.fixed)} / 点`,item.commission.rate && `${item.commission.rate}%`,item.commission.points && `${item.commission.points} Pt / 点`].filter(Boolean).join(' · ') : '';
  return `<section class="order-selection"><div class="order-selected"><div><h3>${escape(item.name)}</h3><p>${yen(item.price)} / 点</p></div><label class="field order-qty"><span>数量</span><input name="quantity" type="number" min="1" max="100" step="1" inputmode="numeric" value="1" required></label></div>
    ${stockInfo ? `<p class="field-help">${icon('box',14)} 在庫引き落とし / 点　${stockInfo}</p>` : ''}
    ${commissionInfo || item.requiresCast ? `<fieldset class="choices cast-choices"><legend>歩合を付けるキャスト${item.requiresCast ? '（必須）' : '（任意）'}</legend><div class="choice-grid">${state.cast.map((person)=>`<label class="choice"><input name="castIds" type="checkbox" value="${person.id}"><span><strong>${escape(person.name)}</strong></span></label>`).join('')}</div>${commissionInfo ? `<p class="field-help">${icon('users',14)} ${commissionInfo}${item.requiresCast ? '' : ' · 対象者を選んだ場合に反映'}</p>` : ''}</fieldset>` : ''}</section>`;
}

function renderPayment(entry,index) {
  return `<div class="payment-row">${label('支払方法',methodSelect('paymentMethod',entry.method))}${label('金額（円）',`<input type="number" name="paymentAmount" min="0" step="1" value="${entry.amount}" inputmode="numeric" required>`)}${modal.payments.length>1 ? `<button type="button" class="icon-btn" aria-label="支払い行を削除" data-action="remove-payment" data-id="${index}">${icon('x',16)}</button>` : ''}</div>`;
}

function currentPayments() {
  return [...dialog.querySelectorAll('.payment-row')].map((row)=>({method:row.querySelector('[name=paymentMethod]').value,amount:Number(row.querySelector('[name=paymentAmount]').value)}));
}

function updatePaymentNote() {
  const note = dialog.querySelector('#payment-note');
  if (!note) return;
  const left = quote(state,modal.ticketId).remaining - currentPayments().reduce((sum,entry)=>sum+entry.amount,0);
  note.innerHTML = left === 0 ? `<span>${icon('check',16)}支払額が一致しています</span><strong>差額 ${yen(0)}</strong>` : `<span>${left>0?'未充当の金額':'超過した金額'}</span><strong>${yen(Math.abs(left))}</strong>`;
  note.classList.toggle('result-warn',left!==0);
}

function reviseProduct() {
  dialog.querySelector('#order-products').innerHTML = renderProducts();
}

function openTicket(id) {
  const ticket = state.tickets.find(item=>item.id===id);
  if (!ticket) return;
  if (['departed','void'].includes(ticket.status)) { openDialog('receipt',{ticketId:id}); return; }
  if (dialog.open) dialog.close();
  selected = ticket.tableIds[0];
  mobileDetails = true;
  go('floor');
}

function modalFromAction(target) {
  const {action,id} = target.dataset;
  if (['move','extend','deposit','discount','depart','receipt','seat-history'].includes(action)) openDialog(action,{ticketId:id});
  if (action === 'order') openDialog(action,{ticketId:id,product:target.dataset.product ?? '',category:'よく使う',search:''});
  if (action === 'settle') openDialog(action,{ticketId:id,payments:[{method:'cash',amount:quote(state,id).remaining}]});
  if (action === 'stock-adjust') openDialog(action,{stockId:id});
  if (action === 'cancel-line') openDialog(action,{ticketId:target.dataset.ticket,lineId:id});
}

function clickAction(target) {
  const {action,id} = target.dataset;
  if (action === 'navigate') { mobileDetails = false; go(id); return; }
  if (action === 'filter') { filter=id; render({preserveFocus:true}); return; }
  if (action === 'hide-detail') { mobileDetails=false; render(); return; }
  if (action === 'dismiss') { dialog.close(); return; }
  if (action === 'open-ticket') { openTicket(id); return; }
  if (action === 'table') {
    if (state.day.status === 'closed') { openDialog('open'); return; }
    const ticket = getTicketForTable(state,id);
    if (!ticket) { openDialog('seat',{tableId:id}); return; }
    selected = id;
    mobileDetails = true;
    render({preserveFocus:true});
    if (matchMedia('(max-width: 1050px)').matches) app.querySelector('.detail-mobile-close')?.focus();
    return;
  }
  if (['demo','open','seat','close'].includes(action)) {openDialog(action); return;}
  if (action === 'demo-start' || action === 'demo-live') {
    saveState(createDemo(action==='demo-start'?'closed':'live'));
    selected = action==='demo-live'?'a1':null;
    area='all'; filter='all'; mobileDetails=false; go('floor');
    if (action==='demo-start') openDialog('open');
    else { dialog.close(); toast('営業中のサンプルを読み込みました。'); }
    return;
  }
  if (action==='category') {
    modal.category=id;
    modal.search='';
    dialog.querySelector('#menu-search').value='';
    for (const control of dialog.querySelectorAll('[data-action=category]')) control.setAttribute('aria-pressed',String(control.dataset.id===id));
    reviseProduct();
    return;
  }
  if (action==='product') {
    if (modal.product===id) return;
    modal.product=id;
    for (const control of dialog.querySelectorAll('[data-action=product]')) control.setAttribute('aria-pressed',String(control.dataset.id===id));
    dialog.querySelector('#order-selection').innerHTML=renderProductDetails();
    return;
  }
  if (action==='add-payment' || action==='remove-payment') {
    modal.payments=currentPayments();
    if (action==='add-payment') {
      if (modal.payments.length>=3) {showError('一度に登録できる支払行は3件までです。');return;}
      const due=quote(state,modal.ticketId).remaining;
      const rest=due-modal.payments.reduce((sum,entry)=>sum+entry.amount,0);
      const method=Object.keys(methods).find(key=>!modal.payments.some(entry=>entry.method===key)) ?? 'cash';
      modal.payments.push({method,amount:Math.max(0,rest)});
    } else modal.payments.splice(Number(id),1);
    dialog.querySelector('#payment-rows').innerHTML=modal.payments.map(renderPayment).join('');
    updatePaymentNote();
    if (action==='add-payment') dialog.querySelector('.payment-row:last-child [name=paymentAmount]')?.focus();
    return;
  }
  if (action==='cancel-deposit') {
    const ticketId=modal.ticketId;
    const entry=state.tickets.find(item=>item.id===ticketId).deposits.find(item=>item.id===id);
    modal={type:'cancel-deposit',ticketId,depositId:id};
    present('前受金を取り消す',`<p class="form-copy">${methods[entry.method]}で記録した前受金 ${yen(entry.amount)} を取り消します。</p>`,'前受金を取り消す');
    return;
  }
  modalFromAction(target);
}

function submitDialog(form) {
  const data = new FormData(form);
  const value = (key) => data.get(key);
  const numeric = (key) => Number(value(key));
  const id = modal.ticketId;
  switch(modal.type) {
    case 'open':
      commit({type:'open',date:value('date'),openingCash:numeric('openingCash')},'開店しました。空席から来店を登録できます。');
      break;
    case 'seat': {
      const selectedIds=data.getAll('tableIds');
      const tableIds=modal.tableId ? [modal.tableId,...selectedIds] : selectedIds;
      commit({type:'seat',tableIds,guests:numeric('guests'),customer:value('customer'),setId:value('setId')},'来店を登録しました。',()=>{selected=tableIds[0]; area='all';filter='all';mobileDetails=true;});
      break;
    }
    case 'move': {
      const tableIds=data.getAll('tableIds');
      commit({type:'move',ticketId:id,tableIds},'使用卓を変更しました。',()=>{if (!tableIds.includes(selected)) selected=tableIds[0]; area='all';filter='all';});
      break;
    }
    case 'order':
      if (!modal.product) { showError('追加するメニューを選択してください。'); return; }
      commit({type:'order',ticketId:id,items:[{menuId:modal.product,quantity:numeric('quantity'),castIds:data.getAll('castIds')}]},'注文を確定しました。在庫と歩合見込を更新しました。');
      break;
    case 'extend':
      commit({type:'extend',ticketId:id,minutes:numeric('minutes')},`${numeric('minutes')}分延長しました。`);
      break;
    case 'deposit':
      commit({type:'deposit',ticketId:id,method:value('method'),amount:numeric('amount')},'前受金を記録しました。');
      break;
    case 'cancel-deposit':
      commit({type:'cancelDeposit',ticketId:id,depositId:modal.depositId},'前受金を取り消しました。');
      break;
    case 'discount':
      commit({type:'discount',ticketId:id,amount:numeric('amount')},'値引きと請求額を更新しました。');
      break;
    case 'settle':
      commit({type:'settle',ticketId:id,payments:currentPayments().filter((entry)=>entry.amount>0)},'会計を確定し、歩合を実績に計上しました。');
      break;
    case 'depart':
      commit({type:'depart',ticketId:id},'退店を記録し、使用卓を解放しました。',()=>{selected=null;mobileDetails=false;});
      break;
    case 'cancel-line':
      commit({type:'cancelLine',ticketId:id,lineId:modal.lineId,returnStock:data.has('returnStock')},'注文を取り消しました。');
      break;
    case 'close':
      commit({type:'close',actualCash:numeric('actualCash'),reason:value('reason')},'閉店しました。営業レポートに締めを保存しました。',()=>{selected=null;mobileDetails=false;page='reports';history.replaceState(null,'','#reports');});
      window.scrollTo(0,0);
      break;
    case 'stock-adjust':
      commit({type:'stockAdjust',stockId:modal.stockId,quantity:numeric('quantity'),reason:value('reason')},'在庫の増減を記録しました。');
      break;
  }
}

document.addEventListener('click',(event)=> {
  const target=event.target.closest?.('[data-action]');
  if (!target) return;
  try { clickAction(target); }
  catch (error) { if (!dialog.open) openDialog('demo'); showError(error.message); }
});
app.addEventListener('change',(event)=> {
  if (event.target.id==='area-filter') { area=event.target.value;render();app.querySelector('#area-filter')?.focus(); }
});
dialog.addEventListener('input',(event)=> {
  if (event.target.id==='menu-search') {modal.search=event.target.value;reviseProduct();}
  if (event.target.name==='paymentAmount') updatePaymentNote();
  const error=dialog.querySelector('.form-error');
  if (error) error.hidden=true;
});
dialog.addEventListener('submit',(event)=> {
  event.preventDefault();
  try {submitDialog(event.target);}
  catch (error) {showError(error.message);}
});
dialog.addEventListener('close',()=> {
  if (!dialog.open) {
    modal=null;
    if (pendingStorage) { pendingStorage = false; state = loadState(); render(); }
    if (priorFocus?.isConnected) priorFocus.focus({preventScroll:true});
    else app.querySelector('#workspace')?.focus({preventScroll:true});
    priorFocus=null;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dialog.open && mobileDetails && matchMedia('(max-width: 1050px)').matches) {
    mobileDetails = false; render(); app.querySelector('.is-selected')?.focus();
  }
});
window.addEventListener('hashchange',()=>{page=readPage(); render();});
window.addEventListener('storage',(event)=>{
  if (event.key!==storageKey) return;
  if (dialog.open) { pendingStorage = true; return; }
  state=loadState(); render({preserveFocus:true});
});

render();
setInterval(()=> {
  if (document.hidden) return;
  const now=Date.now();
  const minute=dateTime.format(now);
  if (minute!==lastMinute) {
    const clock=document.querySelector('#workspace-time');
    if (clock) clock.textContent=minute;
    lastMinute=minute;
  }
  if (page==='floor') {
    if (!dialog.open && state.tables.map((table)=>tableStatus(state,table.id,now)).join('|')!==lastStatuses) {
      render({preserveFocus:true});
      return;
    }
    for (const time of app.querySelectorAll('[data-ends]')) time.textContent=timer(Number(time.dataset.ends),now);
  }
},1000);
