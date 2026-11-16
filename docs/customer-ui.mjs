import { findCustomer, getCustomerDetail, listUnlinkedVisits, searchCustomers } from './customers.mjs';

const appointment = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tokyo' });
const canView = (api) => ['admin', 'manager'].includes(api.role);
const canViewCustomer = (customer, api) => canView(api) && customer && !customer.restricted;

function dateAndTime(date, at, {escape}) {
  const parsed = new Date(at);
  const time = at && Number.isFinite(parsed.valueOf()) ? ` ${appointment.format(parsed)}` : '';
  return `${escape(date || '—')}${time}`;
}

function action(api, label, name, id = '', glyph = '', primary = false) {
  return `<button class="btn ${primary ? 'btn-primary' : 'btn-secondary'}" type="button" data-action="${name}"${id ? ` data-id="${api.escape(id)}"` : ''}>${glyph ? api.icon(glyph, 16) : ''}${label}</button>`;
}

function field(title, html, help = '') {
  return `<label class="field"><span>${title}</span>${html}${help ? `<small>${help}</small>` : ''}</label>`;
}

function empty(api, iconName, title, text = '') {
  return `<div class="np-directory-empty"><span aria-hidden="true">${api.icon(iconName, 21)}</span><strong>${title}</strong>${text ? `<p>${text}</p>` : ''}</div>`;
}

function denied(api) {
  return empty(api, 'info', 'この情報を表示できません', '店舗の管理者に閲覧権限をご確認ください。');
}

function panel(title, body, meta = '') {
  return `<section class="np-directory-panel"><div class="np-directory-panel-head"><h2>${title}</h2>${meta ? `<span>${meta}</span>` : ''}</div>${body}</section>`;
}

function stat(label, value) {
  return `<div class="np-directory-stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function visitAction(entry, api) {
  return `<button class="np-directory-inline" type="button" data-action="customer-visit" data-id="${api.escape(entry.id)}" data-date="${api.escape(entry.date)}">伝票 ${api.escape(entry.number || 'を見る')}${api.icon('chevron-right', 16)}</button>`;
}

export function renderCustomers(state, api) {
  if (!canView(api)) return denied(api);
  const {escape, icon, query = ''} = api;
  const customers = searchCustomers(state, query).filter((customer) => canViewCustomer(customer, api));
  const rows = customers.map((customer) => `<li><button class="np-directory-row np-customer-row" type="button" data-action="customer-detail" data-id="${escape(customer.id)}">
    <span class="np-directory-avatar" aria-hidden="true">${icon('user', 18)}</span>
    <span class="np-directory-row-name"><strong>${escape(customer.name)}</strong>${customer.kana ? `<small>${escape(customer.kana)}</small>` : ''}</span>
    <span class="np-directory-contact">${escape(customer.phone || '—')}</span>
    <span class="np-directory-account">${customer.flagged ? '<span class="np-directory-badge np-ar-status-overdue">要注意</span>' : ''}</span>
    ${icon('chevron-right', 17)}</button></li>`).join('');
  return `<div class="np-directory"><div class="np-directory-actions np-directory-page-actions">
    ${api.role === 'admin' ? action(api, 'CSV一括登録', 'customer-import', '', 'plus') : ''}
    ${action(api, '顧客を登録', 'customer-new', '', 'plus', true)}</div>
    ${panel('顧客一覧', `<div class="np-directory-toolbar">${field('顧客を検索', `<input type="search" name="customerSearch" value="${escape(query)}" placeholder="表示名・ふりがな・電話番号" autocomplete="off" maxlength="100">`)}</div>
    ${rows ? `<ul class="np-directory-list">${rows}</ul>` : empty(api, 'users', query ? '一致する顧客が見つかりません' : '登録された顧客はまだいません', query ? '別の名前や番号で検索できます。' : '')}`, `${customers.length}件`)}</div>`;
}

export function renderCustomerDetail(state, id, api) {
  if (!canViewCustomer(findCustomer(state, id), api)) return denied(api);
  const {escape, icon, yen} = api;
  const {customer, visits, nominations, totalSales, preferredCast} = getCustomerDetail(state, id);
  const visitRows = visits.map((visit) => `<li><div><strong>${dateAndTime(visit.date, visit.at, api)}</strong><small>${escape(visit.tableLabels?.join('・') || '—')}${visit.status === 'open' ? ' ／ 利用中' : ''}</small></div>${visitAction(visit, api)}</li>`).join('');
  const nominationRows = nominations.map((entry) => `<li><div><strong>${escape(entry.castName || '—')}</strong><small>${dateAndTime(entry.date, entry.at, api)}${entry.name ? ` ／ ${escape(entry.name)}` : ''}</small></div></li>`).join('');
  const bottles = (customer.bottleKeeps ?? []).map((bottle) => `<li><div><strong>${escape(bottle.name)}</strong><small>残り ${escape(bottle.quantity)} ${escape(bottle.unit || '')}${bottle.expiresAt ? ` ／ 期限 ${escape(bottle.expiresAt)}` : ''}</small></div></li>`).join('');
  return `<div class="np-directory np-directory-detail"><div class="np-directory-profile"><span class="np-directory-avatar" aria-hidden="true">${icon('user', 22)}</span>
    <div><strong>${escape(customer.name)}</strong>${customer.kana ? `<small>${escape(customer.kana)}</small>` : ''}</div>
    ${customer.flagged ? '<span class="np-directory-badge np-ar-status-overdue">要注意</span>' : ''}</div>
    <div class="np-directory-actions">${action(api, '編集', 'customer-edit', id, 'edit')}${api.role === 'admin' ? action(api, '伝票を紐づける', 'customer-link', id, 'ticket') + action(api, '重複顧客を統合', 'customer-merge', id, 'users') : ''}</div>
    <div class="np-directory-stats">${stat('来店回数', `${visits.length}回`)}${stat('累計売上', yen(totalSales))}</div>
    <dl class="np-directory-facts"><div><dt>担当キャスト</dt><dd>${escape(preferredCast?.name || '—')}</dd></div><div><dt>初回来店日</dt><dd>${escape(customer.firstVisitDate || visits.at(-1)?.date || '—')}</dd></div>
    <div><dt>電話番号</dt><dd>${escape(customer.phone || '—')}</dd></div><div><dt>誕生日</dt><dd>${escape(customer.birthday || '—')}</dd></div>
    ${customer.memo ? `<div class="np-directory-note"><dt>メモ</dt><dd>${escape(customer.memo)}</dd></div>` : ''}</dl>
    ${panel('来店履歴', compactHistory(visitRows) || empty(api, 'calendar', '来店履歴はありません'), `${visits.length}件`)}
    ${panel('指名履歴', compactHistory(nominationRows) || empty(api, 'user', '指名履歴はありません'), `${nominations.length}件`)}
    ${panel('キープボトル', compactHistory(bottles) || empty(api, 'box', 'キープ中のボトルはありません'))}</div>`;
}

function compactHistory(rows) {
  return rows ? `<ul class="np-directory-history">${rows}</ul>` : '';
}

export function renderCustomerForm(state, id, api) {
  const {escape} = api;
  const customer = id ? findCustomer(state, id) : {};
  if (!canViewCustomer(customer, api)) return denied(api);
  const value = (key) => escape(customer[key] ?? '');
  const castOptions = state.cast.filter((person) => person.enabled !== false || person.id === customer.castId).map((person) =>
    `<option value="${escape(person.id)}"${person.id === customer.castId ? ' selected' : ''}>${escape(person.name)}</option>`).join('');
  return `<div class="np-directory-detail"><div class="form-grid">
    ${field('表示名', `<input name="name" required maxlength="60" value="${value('name')}" autocomplete="off">`)}
    ${field('ふりがな（任意）', `<input name="kana" maxlength="60" value="${value('kana')}" autocomplete="off">`)}
    ${field('電話番号（任意）', `<input name="phone" type="tel" maxlength="32" value="${value('phone')}" autocomplete="off">`)}
    ${field('誕生日（任意）', `<input name="birthday" type="date" value="${value('birthday')}" autocomplete="off">`)}
    ${field('担当キャスト（任意）', `<select name="castId"><option value="">担当なし</option>${castOptions}</select>`)}
    </div><div class="np-directory-checks"><label><input name="flagged" type="checkbox" value="1"${customer.flagged ? ' checked' : ''}>要注意として表示</label>
    </div>${field('メモ（任意）', `<textarea name="memo" rows="3" maxlength="400">${value('memo')}</textarea>`)}${bottleFields(customer, api)}</div>`;
}

function bottleFields(customer, {escape}) {
  const entries = [...(customer.bottleKeeps ?? []), {}].slice(0, 30);
  return `<fieldset class="np-directory-bottle"><legend>キープボトル（任意）</legend>${entries.map((entry) => `<div class="np-directory-bottle-row">
    ${field('銘柄', `<input name="bottleName" maxlength="60" value="${escape(entry.name || '')}">`)}
    ${field('残量', `<input name="bottleQuantity" type="number" min="0" max="1000000" step="any" inputmode="decimal" value="${escape(entry.quantity ?? '')}" placeholder="0.5">`)}
    ${field('単位', `<input name="bottleUnit" maxlength="12" value="${escape(entry.unit || '')}" placeholder="本">`)}
    ${field('期限', `<input type="date" name="bottleExpiresAt" value="${escape(entry.expiresAt || '')}">`)}
    </div>`).join('')}</fieldset>`;
}

export function renderCustomerMerge(state, id, api) {
  if (api.role !== 'admin') return denied(api);
  const {escape} = api;
  const customer = findCustomer(state, id);
  if (!customer) return denied(api);
  const candidates = searchCustomers(state).filter((entry) => entry.id !== id && !entry.restricted);
  return `<p class="form-copy"><strong>${escape(customer.name)}</strong> に、選択した顧客の履歴を統合します。</p>
    ${field('統合する顧客', `<select name="sourceId" required><option value="">選択してください</option>${candidates.map((entry) => `<option value="${escape(entry.id)}">${escape(entry.name)}${entry.kana ? ` ／ ${escape(entry.kana)}` : ''}${entry.phone ? ` ／ ${escape(entry.phone)}` : ''}</option>`).join('')}</select>`)}
    ${field('統合の理由', '<input name="reason" maxlength="120" required placeholder="同じ顧客の重複登録">')}`;
}

export function renderCustomerLink(state, id, api) {
  const {escape} = api;
  const customer = findCustomer(state, id);
  if (api.role !== 'admin' || !canViewCustomer(customer, api)) return denied(api);
  const visits = listUnlinkedVisits(state);
  return `<p class="form-copy"><strong>${escape(customer.name)}</strong> の来店履歴に、顧客未登録の伝票を追加します。</p>
    ${field('伝票', `<select name="ticketId" required><option value="">${visits.length ? '選択してください' : '紐づけられる伝票がありません'}</option>${visits.map((entry) => `<option value="${escape(entry.id)}">${escape(entry.date)} ／ No. ${escape(entry.number)} ／ ${escape(entry.customer || 'お客様名なし')}</option>`).join('')}</select>`, '会計済みの伝票を選ぶと、訂正理由を入力する画面が開きます。')}`;
}

export function renderCustomerImport(api) {
  if (api.role !== 'admin') return denied(api);
  return `<p class="form-copy">1行目に列名を含むCSVを貼り付けます。表示名は必須です。担当はキャスト設定の名前を入力してください。</p>
    ${field('顧客CSV', '<textarea name="csv" class="np-directory-csv" rows="7" required spellcheck="false" placeholder="表示名,ふりがな,電話,誕生日,担当,メモ"></textarea>')}`;
}

export function renderSeatCustomerResults(state, query, selected, api) {
  const {escape} = api;
  if (!query?.trim()) return '';
  const staff = !canView(api);
  const searchable = (state.customers ?? []).map((customer) => staff ? { id:customer.id, name:customer.name }
    : customer.restricted ? { id:customer.id, name:customer.name, kana:customer.kana } : customer);
  const candidates = searchCustomers({customers:searchable}, query).slice(0, 8);
  return candidates.length ? candidates.map((customer) =>
    `<label class="np-seat-customer-choice"><input type="radio" name="customerId" value="${escape(customer.id)}"${customer.id === selected ? ' checked' : ''}>
      <span><strong>${escape(customer.name)}</strong>${!staff && customer.kana ? `<small>${escape(customer.kana)}</small>` : ''}</span></label>`).join('')
    : '<p role="status" class="field-help">検索に一致する顧客が見つかりません。</p>';
}

function renderSeatCustomerSuggestion(state, id, api) {
  if (!canViewCustomer(findCustomer(state, id), api)) return '';
  const detail = getCustomerDetail(state, id);
  const preferred = detail.preferredCast?.name;
  const last = detail.lastNomination?.castName;
  const {escape} = api;
  return preferred || last ? `<div class="np-seat-customer-hints">${preferred ? `<span>担当キャスト <strong>${escape(preferred)}</strong></span>` : ''}${last ? `<span>前回の指名 <strong>${escape(last)}</strong></span>` : ''}</div>` : '';
}

export function renderSeatCustomerSelection(state, id, api) {
  const customer = findCustomer(state, id);
  if (!customer) return '';
  return `<div class="np-seat-customer-current"><span>指定した顧客 <strong>${api.escape(customer.name)}</strong></span>
    ${action(api, '選択を解除', 'seat-customer-clear')}</div>${renderSeatCustomerSuggestion(state, id, api)}`;
}

function renderSeatCustomerPicker(state, api, {query, selected, label, help, selection}) {
  const {escape} = api;
  return `<fieldset class="np-seat-customer"><legend>${label}</legend>
    ${field('顧客を検索', `<input name="customerQuery" type="search" autocomplete="off" value="${escape(query)}" placeholder="${canView(api) ? '表示名・ふりがな・電話番号' : '表示名'}" maxlength="100" aria-controls="seat-customer-results">`, help)}
    <div id="seat-customer-results" class="np-seat-customer-results" role="group" aria-label="顧客の検索候補">${renderSeatCustomerResults(state, query, selected, api)}</div>
    <div id="seat-customer-selection" aria-live="polite">${selection}</div>
  </fieldset>`;
}

export function renderSeatCustomer(state, api, {query = '', selected = ''} = {}) {
  return renderSeatCustomerPicker(state, api, {
    query, selected, label: 'お客様（任意）', help: '登録済みのお客様を検索できます。顧客の指定は任意です。',
    selection: renderSeatCustomerSelection(state, selected, api),
  });
}

export function renderTicketCustomerSelection(state, selected, api, currentAlias, {canDetach = true} = {}) {
  const hasCurrent = Boolean(currentAlias?.id || currentAlias?.name);
  const detachLabel = hasCurrent ? 'ひもづけを解除' : '選択を解除';
  const detach = canDetach ? action(api, detachLabel, 'seat-customer-clear') : '';
  if (selected === null) return hasCurrent && canDetach
    ? '<p class="np-ticket-customer-detached">保存後は顧客の指定が解除されます。</p>' : '';
  if (selected === undefined || selected === currentAlias?.id) return hasCurrent && detach
    ? `<div class="np-ticket-customer-actions">${detach}</div>` : '';
  const customer = findCustomer(state, selected);
  if (!customer) return '';
  return `<div class="np-seat-customer-current"><span>保存後のお客様 <strong>${api.escape(customer.name)}</strong></span>
    ${detach}</div>${renderSeatCustomerSuggestion(state, selected, api)}`;
}

export function renderTicketCustomerEditor(state, {
  currentAlias, query = '', selected = currentAlias?.id, settled = false, reason = '', canDetach = true, customerConstraint = '',
}, api) {
  const {escape} = api;
  const hasCurrent = Boolean(currentAlias?.id || currentAlias?.name);
  const currentName = currentAlias?.name || (hasCurrent ? '指定済み' : '顧客の指定なし');
  return `<div class="np-ticket-customer">
    <dl class="np-ticket-customer-current"><dt>現在のお客様</dt><dd>${escape(currentName)}</dd></dl>
    ${customerConstraint ? `<p class="ops-highlight np-ticket-customer-constraint">${escape(customerConstraint)}</p>` : ''}
    ${renderSeatCustomerPicker(state, api, {
      query, selected, label: '登録済みのお客様', help: '検索結果からお客様を選び、保存します。',
      selection: renderTicketCustomerSelection(state, selected, api, currentAlias, {canDetach}),
    })}
    ${settled ? field('訂正理由', `<textarea name="customerCorrectionReason" rows="3" maxlength="120" required>${escape(reason)}</textarea>`, '訂正理由は必須です。監査ログに記録されます。') : ''}
  </div>`;
}
