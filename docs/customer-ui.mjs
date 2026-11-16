import { customerAnniversaryLimit, customerPhotoMax, customerWeekdays, findCustomer, getCustomerDetail, getCustomerDirectory, getCustomerNotices,
  getReturningCustomerCastSuggestions, isCustomerPhoto, listUnlinkedVisits, searchCustomers } from './customers.mjs';

const appointment = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tokyo' });
const canView = (api) => ['admin', 'manager'].includes(api.role);
const canViewCustomer = (customer, api) => canView(api) && customer && !customer.restricted;

function ticketCompanionAliases(state,ticket) {
  if (ticket.activeCompanionLinks) return ticket.activeCompanionLinks;
  return (ticket.companionCustomerIds ?? []).flatMap((id)=>{
    const customer = findCustomer(state,id);
    return customer ? [{id,name:customer.name}] : [];
  });
}

export function renderCompanionResults(workspace,ticket,primary,query,api) {
  if (!query.trim()) return '<p class="field-help">名前を入力すると登録済みの候補が表示されます。</p>';
  const excluded = new Set([primary.id,...ticketCompanionAliases(workspace,ticket).map(({id})=>id)]);
  const matches = searchCustomers(workspace,query).filter(({id})=>!excluded.has(id)).slice(0,8);
  if (!matches.length) return '<p class="field-help">該当するお客様は見つかりません。</p>';
  return `<div class="ops-actions">${matches.map(({id,name})=>
    action(api,`同席者に追加 ／ ${api.escape(name)}`,'save-ticket-companion',id,'plus')).join('')}</div>`;
}

export function renderCompanionEditor(workspace,ticket,primary,api) {
  const companions = ticketCompanionAliases(workspace,ticket);
  return `<p class="form-copy">会計の代表 ／ <strong>${api.escape(primary.name)}</strong></p>
    <p class="field-help">伝票の売上は代表のお客様に集計し、同席者には来店履歴だけを記録します。</p>
    ${companions.length ? `<ul class="compact-history">${companions.map(({id,name})=>`<li>
      <span>${api.escape(name)}</span><button class="btn btn-secondary" type="button" data-action="save-ticket-companion"
        data-mode="remove" data-id="${api.escape(id)}">解除</button></li>`).join('')}</ul>` : ''}
    ${companions.length >= Math.min(20,ticket.guests - 1) ? '<p class="field-help">登録できる同席者が上限に達しました。</p>'
      : `${field('同席者を検索','<input type="search" name="companionQuery" maxlength="100" autocomplete="off" aria-controls="companion-results">')}
        <div id="companion-results" aria-live="polite">${renderCompanionResults(workspace,ticket,primary,'',api)}</div>`}`;
}

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

function avatar(photo, api, size = 18) {
  return `<span class="np-directory-avatar" aria-hidden="true">${photo && isCustomerPhoto(photo)
    ? `<img src="${api.escape(photo)}" alt="" ${size === 18 ? 'loading="lazy"' : ''}>` : api.icon('user', size)}</span>`;
}

function options(entries, selected, escape) {
  return entries.map(([key,label]) =>
    `<option value="${escape(key)}"${key === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');
}

function filtersView(state, filter, {escape}) {
  const cast = [...(state.cast ?? []), ...(state.archivedCast ?? [])].map(({id,name}) => [id,name]);
  const select = (title, key, entries) => field(title, `<select data-customer-filter="${key}">${options(entries,filter[key],escape)}</select>`);
  const date = (title, key) => field(title,`<input type="date" data-customer-filter="${key}" value="${escape(filter[key] ?? '')}">`);
  return `<details class="np-directory-filters"${Object.values(filter).some(Boolean) ? ' open' : ''}><summary>条件で絞り込む</summary>
    <div class="form-grid">
    ${select('誕生月','birthdayMonth',[['','すべて'],...Array.from({length:12},(_,i) => [String(i+1).padStart(2,'0'),`${i+1}月`])])}
    ${select('指名履歴のキャスト','nomination',[['','すべて'],...cast])}
    ${date('最終来店日（から）','visitFrom')}${date('最終来店日（まで）','visitTo')}
    ${select('お休みの曜日','dayOff',[['','すべて'],...customerWeekdays.map((day) => [day,`${day}曜日`])])}
    ${select('来店・ボトル','status',[['','すべて'],['inactive','来店から30日以上（来店2回以上）'],['bottle','期限間近・期限切れのボトル']])}
    ${select('並び順','sort',[['','登録順'],['sales','累計売上の高い順'],['visits','来店回数の多い順']])}
    </div><button class="btn btn-quiet" type="button" data-action="customer-reset-filters">条件をクリア</button></details>`;
}

export function renderCustomerNotices(state, api) {
  return canView(api) ? customerNotices(getCustomerNotices(state, api.businessDate), api) : '';
}

function customerNotices(notices, api) {
  if (!notices.length) return '<p class="field-help">該当するお知らせはありません。</p>';
  const {escape} = api;
  const rows = (entries) => compactHistory(entries.map(({customerId,customerName,kind,label,date,daysUntil}) => {
    const timing = daysUntil < 0 ? '期限切れ' : daysUntil === 0 ? '今日' : `${daysUntil}日後`;
    return `<li><div><strong>${escape(customerName)}</strong><small>${escape(kind === 'bottle' ? `ボトル期限 ／ ${label}` : label)}</small>
      <small>${escape(date)} ／ ${timing}</small></div>${action(api, '詳細', 'customer-detail', customerId, 'chevron-right')}</li>`;
  }).join(''));
  const remaining = notices.slice(6);
  return rows(notices.slice(0,6)) + (remaining.length
    ? `<details class="np-directory-notice-more"><summary>ほか ${remaining.length} 件</summary>${rows(remaining)}</details>` : '');
}

export function renderCustomers(state, api) {
  if (!canView(api)) return denied(api);
  const {escape, icon, yen, query = '', filter = {}} = api;
  const customers = getCustomerDirectory(state, query, filter, api.businessDate);
  const notices = getCustomerNotices(state, api.businessDate);
  const rows = customers.map(({customer,lastVisit,visits,totalSales,bottleExpiry,lapsed}) => `<li><button class="np-directory-row np-customer-row" type="button" data-action="customer-detail" data-id="${escape(customer.id)}">
    ${avatar(customer.photo, api)}
    <span class="np-directory-row-name"><strong>${escape(customer.name)}</strong>${customer.kana ? `<small>${escape(customer.kana)}</small>` : ''}
    ${customer.tags?.length ? `<small>${customer.tags.map((tag) => escape(`#${tag}`)).join(' ')}</small>` : ''}</span>
    <span class="np-directory-contact">${escape(customer.phone || '—')}</span>
    <span class="np-directory-account">
    ${filter.sort === 'sales' ? `<small>累計 ${yen(totalSales)}</small>` : ''}
    ${filter.sort === 'visits' ? `<small>${visits}回来店</small>` : ''}
    ${customer.flagged ? '<span class="np-directory-badge np-ar-status-overdue">要注意</span>' : ''}
    ${lapsed ? `<small>最終来店 ${escape(lastVisit)}</small>` : ''}
    ${bottleExpiry ? `<small>ボトル期限 ${escape(bottleExpiry)}</small>` : ''}</span>
    ${icon('chevron-right', 17)}</button></li>`).join('');
  return `<div class="np-directory"><div class="np-directory-actions np-directory-page-actions">
    ${api.role === 'admin' ? action(api, 'CSV一括登録', 'customer-import', '', 'plus') : ''}
    ${api.canEdit !== false ? action(api, '顧客を登録', 'customer-new', '', 'plus', true) : ''}</div>
    <details class="np-directory-panel np-directory-notice-more"${notices.length ? ' open' : ''}>
    <summary>誕生日・記念日・ボトル期限${notices.length ? `（${notices.length}件）` : ''}</summary>${customerNotices(notices,api)}</details>
    ${panel('顧客一覧', `<div class="np-directory-toolbar">${field('顧客を検索', `<input type="search" name="customerSearch" value="${escape(query)}" placeholder="表示名・ふりがな・電話番号・タグ" autocomplete="off" maxlength="100">`)}</div>
    ${filtersView(state, filter, api)}
    ${rows ? `<ul class="np-directory-list">${rows}</ul>` : empty(api, 'users', query || Object.values(filter).some(Boolean)
      ? '一致する顧客が見つかりません' : '登録された顧客はまだいません')}`, `${customers.length}件`)}</div>`;
}

export function renderCustomerDetail(state, id, api) {
  if (!canViewCustomer(findCustomer(state, id), api)) return denied(api);
  const {escape, yen} = api;
  const {customer, visits, nominations, totalSales, preferredCast} = getCustomerDetail(state, id);
  const visitRows = visits.map((visit) => `<li><div><strong>${dateAndTime(visit.date, visit.at, api)}</strong><small>${escape(visit.tableLabels?.join('・') || '—')}${visit.status === 'open' ? ' ／ 利用中' : ''}${visit.companion ? ' ／ 同席' : ''}</small></div>${visit.companion && api.role !== 'admin' ? '' : visitAction(visit, api)}</li>`).join('');
  const nominationRows = nominations.map((entry) => `<li><div><strong>${escape(entry.castName || '—')}</strong><small>${dateAndTime(entry.date, entry.at, api)}${entry.name ? ` ／ ${escape(entry.name)}` : ''}</small></div></li>`).join('');
  const bottles = (customer.bottleKeeps ?? []).map((bottle) => `<li><div><strong>${escape(bottle.name)}</strong><small>残り ${escape(bottle.quantity)} ${escape(bottle.unit || '')}${bottle.expiresAt ? ` ／ 期限 ${escape(bottle.expiresAt)}` : ''}</small></div>
    ${bottle.photo && isCustomerPhoto(bottle.photo) ? `<img class="np-bottle-thumbnail" src="${escape(bottle.photo)}" alt="${escape(bottle.name)}の記録写真" loading="lazy">` : ''}</li>`).join('');
  const anniversaries = (customer.anniversaries ?? []).map(({monthDay,label}) => `<li><div><strong>${escape(label)}</strong><small>${Number(monthDay.slice(0,2))}月${Number(monthDay.slice(3))}日</small></div></li>`).join('');
  return `<div class="np-directory np-directory-detail"><div class="np-directory-profile">${avatar(customer.photo, api, 22)}
    <div><strong>${escape(customer.name)}</strong>${customer.kana ? `<small>${escape(customer.kana)}</small>` : ''}</div>
    ${customer.flagged ? '<span class="np-directory-badge np-ar-status-overdue">要注意</span>' : ''}</div>
    <div class="np-directory-actions">${api.canEdit !== false ? action(api, '編集', 'customer-edit', id, 'edit') : ''}${api.role === 'admin' ? action(api, '伝票を紐づける', 'customer-link', id, 'ticket') + action(api, '重複顧客を統合', 'customer-merge', id, 'users') : ''}</div>
    <div class="np-directory-stats">${stat('来店回数', `${visits.length}回`)}${stat('累計売上', yen(totalSales))}</div>
    <dl class="np-directory-facts"><div><dt>担当キャスト</dt><dd>${escape(preferredCast?.name || '—')}</dd></div><div><dt>初回来店日</dt><dd>${escape(customer.firstVisitDate || visits.at(-1)?.date || '—')}</dd></div>
    <div><dt>電話番号</dt><dd>${escape(customer.phone || '—')}</dd></div><div><dt>誕生日</dt><dd>${escape(customer.birthday || '—')}</dd></div>
    ${customer.email ? `<div><dt>メールアドレス</dt><dd>${escape(customer.email)}</dd></div>` : ''}
    ${customer.receiptRecipient ? `<div><dt>領収書宛名</dt><dd>${escape(customer.receiptRecipient)}</dd></div>` : ''}
    ${customer.daysOff?.length ? `<div><dt>お休み</dt><dd>${escape(customer.daysOff.join('・'))}曜日</dd></div>` : ''}
    ${customer.tags?.length ? `<div><dt>タグ</dt><dd>${customer.tags.map((tag) => escape(`#${tag}`)).join(' ')}</dd></div>` : ''}
    ${customer.memo ? `<div class="np-directory-note"><dt>メモ</dt><dd>${escape(customer.memo)}</dd></div>` : ''}</dl>
    ${anniversaries ? panel('記念日', compactHistory(anniversaries)) : ''}
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
    ${field('メールアドレス（任意）', `<input name="email" type="email" maxlength="254" value="${value('email')}" autocomplete="off">`)}
    ${field('領収書宛名（任意）', `<input name="receiptRecipient" maxlength="80" value="${value('receiptRecipient')}">`)}
    ${field('誕生日（任意）', `<input name="birthday" type="date" value="${value('birthday')}" autocomplete="off">`)}
    ${field('担当キャスト（任意）', `<select name="castId"><option value="">担当なし</option>${castOptions}</select>`)}
    ${field('タグ（任意）', `<input name="tags" maxlength="420" value="${escape((customer.tags ?? []).join('、'))}" placeholder="ウイスキー、日本酒">`,'「、」で区切って入力します。')}
    </div><fieldset class="np-directory-days"><legend>お休みの曜日（任意）</legend><div class="np-directory-checks">${customerWeekdays.map((day) =>
      `<label><input name="daysOff" type="checkbox" value="${day}"${customer.daysOff?.includes(day) ? ' checked' : ''}>${day}</label>`).join('')}</div></fieldset>
    ${photoInput('写真・名刺（任意）','profilePhoto',customer.photo,escape)}
    <div class="np-directory-checks"><label><input name="flagged" type="checkbox" value="1"${customer.flagged ? ' checked' : ''}>要注意として表示</label>
    </div>${field('メモ（任意）', `<textarea name="memo" rows="3" maxlength="400">${value('memo')}</textarea>`)}
    <fieldset class="np-directory-bottle"><legend>毎年の記念日（任意）</legend><div data-anniversary-rows>
    ${(customer.anniversaries ?? []).map((entry) => renderAnniversaryRow(entry,api)).join('')}</div>
    ${action(api,'記念日を追加','customer-anniversary-add','','plus')}<p class="field-help">${customerAnniversaryLimit}件まで登録できます。</p></fieldset>
    ${bottleFields(customer, api)}</div>`;
}

export function renderAnniversaryRow({monthDay = '', label = ''}, api) {
  const select = (name, optionLabel, length, value) => `<select name="${name}" required><option value="">${optionLabel}</option>${Array.from({length}, (_, index) => {
    const option = String(index + 1).padStart(2,'0');
    return `<option value="${option}"${option === value ? ' selected' : ''}>${index + 1}</option>`;
  }).join('')}</select>`;
  return `<div class="form-grid np-anniversary-row" data-anniversary-row>
    ${field('記念日の名前', `<input name="anniversaryLabel" required maxlength="50" value="${api.escape(label)}" placeholder="初回来店記念日">`)}
    ${field('月', select('anniversaryMonth','選択',12,monthDay.slice(0,2)))}
    ${field('日', select('anniversaryDay','選択',31,monthDay.slice(3)))}
    ${action(api,'外す','customer-anniversary-remove','','minus')}</div>`;
}

function photoInput(title, name, photo, escape) {
  const current = isCustomerPhoto(photo) ? photo ?? '' : '';
  return `<div class="np-directory-photo">
    ${field(title,'<input type="file" data-customer-photo accept="image/jpeg,image/png,image/webp">')}
    <input type="hidden" name="${name}" value="${escape(current)}">
    <label class="inline-check"><input type="checkbox" data-photo-remove> 写真を外す</label>
    <span data-photo-status role="status">${current ? '写真登録済み' : ''}</span>
    </div>`;
}

function bottleFields(customer, {escape}) {
  const entries = [...(customer.bottleKeeps ?? []), {}].slice(0, 30);
  return `<fieldset class="np-directory-bottle"><legend>キープボトル（任意）</legend>${entries.map((entry) => `<div class="np-directory-bottle-row">
    ${field('銘柄', `<input name="bottleName" maxlength="60" value="${escape(entry.name || '')}">`)}
    ${field('残量', `<input name="bottleQuantity" type="number" min="0" max="1000000" step="any" inputmode="decimal" value="${escape(entry.quantity ?? '')}" placeholder="0.5">`)}
    ${field('単位', `<input name="bottleUnit" maxlength="12" value="${escape(entry.unit || '')}" placeholder="本">`)}
    ${field('期限', `<input type="date" name="bottleExpiresAt" value="${escape(entry.expiresAt || '')}">`)}
    ${photoInput('残量写真（任意）','bottlePhoto',entry.photo,escape)}
    </div>`).join('')}</fieldset>`;
}

export function readCustomerForm(form, data) {
  if (form.querySelector('[data-photo-processing]')) throw new Error('写真の読み込みが完了してから保存してください。');
  const customer = Object.fromEntries(['name','kana','phone','email','receiptRecipient','birthday','castId','memo'].map((key) => [key,data.get(key) ?? '']));
  customer.flagged = data.has('flagged');
  customer.daysOff = data.getAll('daysOff');
  customer.tags = String(data.get('tags') ?? '').split(/[,、，]/u).map((tag) => tag.trim()).filter(Boolean);
  const months = data.getAll('anniversaryMonth');
  const days = data.getAll('anniversaryDay');
  customer.anniversaries = data.getAll('anniversaryLabel').map((label,index) => ({label:label.trim(),monthDay:`${months[index]}-${days[index]}`}));
  const photoValue = (field) => field?.closest('.np-directory-photo')?.querySelector('[data-photo-remove]')?.checked ? '' : field?.value ?? '';
  customer.photo = photoValue(form.querySelector('[name=profilePhoto]'));
  const names = data.getAll('bottleName');
  const quantities = data.getAll('bottleQuantity');
  const units = data.getAll('bottleUnit');
  const dates = data.getAll('bottleExpiresAt');
  const photos = [...form.querySelectorAll('[name=bottlePhoto]')];
  customer.bottleKeeps = names.map((name,index) => ({name,quantity:Number(quantities[index]),unit:units[index],expiresAt:dates[index],
    photo:photoValue(photos[index])})).filter(({name}) => name.trim());
  return customer;
}

export async function updateCustomerPhoto(input) {
  const file = input.files?.[0];
  if (!file) return;
  const field = input.closest('.np-directory-photo');
  const status = field.querySelector('[data-photo-status]');
  if (field.hasAttribute('data-photo-processing')) return;
  field.setAttribute('data-photo-processing','');
  status.textContent = '写真を読み込み中…';
  try {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
      throw new Error('12MB以下のJPEG・PNG・WebP画像を選んでください。');
    }
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const aspect = bitmap.width / bitmap.height;
      for (const limit of [256,192,128,96]) {
        canvas.width = Math.max(1,Math.floor(aspect >= 1 ? limit : limit * aspect));
        canvas.height = Math.max(1,Math.floor(aspect <= 1 ? limit : limit / aspect));
        context.drawImage(bitmap,0,0,canvas.width,canvas.height);
        const photo = canvas.toDataURL('image/webp',0.72);
        if (photo.length > customerPhotoMax) continue;
        field.querySelector('input[type=hidden]').value = photo;
        field.querySelector('[data-photo-remove]').checked = false;
        status.textContent = '写真を読み込みました。';
        return;
      }
    } finally { bitmap.close(); }
    throw new Error('小さい画像を選んでください。');
  } catch (error) {
    status.textContent = `写真を読み込めませんでした。 ${error.message}`;
  } finally {
    field.removeAttribute('data-photo-processing');
    input.value = '';
  }
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
  const customer = findCustomer(state, id);
  if (!canViewCustomer(customer, api)) return '';
  const {escape} = api;
  const suggestions = getReturningCustomerCastSuggestions(state,id);
  const castHints = suggestions.map(({name,assigned,nominated}) => {
    const label = [assigned && '担当キャスト', nominated && '前回の指名'].filter(Boolean).join('・');
    return `<span>${label} <strong>${escape(name)}</strong></span>`;
  });
  const bottles = (customer.bottleKeeps ?? []).filter(({quantity}) => quantity > 0).slice(0,3);
  const bottleHints = bottles.map(({name,quantity,unit}) => `<span>キープ <strong>${escape(name)} ${escape(quantity)}${escape(unit)}</strong></span>`);
  return castHints.length || bottleHints.length ? `<div class="np-seat-customer-hints">${castHints.join('')}${bottleHints.join('')}</div>` : '';
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
