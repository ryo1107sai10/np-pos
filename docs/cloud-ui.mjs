const roles = Object.freeze({
  admin: '店舗管理者', manager: 'マネージャー', staff: 'スタッフ', cast: 'キャスト', trainee: '体入',
});
const integer = new Intl.NumberFormat('ja-JP');

function roleName(role) {
  return Object.hasOwn(roles, role) ? roles[role] : '権限未設定';
}

function button(label, action, { escape, icon }, { id, glyph, tone = 'secondary', disabled = false } = {}) {
  return `<button type="button" class="btn btn-${tone}" data-action="${action}"${id == null ? '' : ` data-id="${escape(id)}"`}${disabled ? ' disabled' : ''}>
    ${glyph ? icon(glyph, 16) : ''}<span>${label}</span></button>`;
}

function field(label, name, type, options = '') {
  return `<label class="field"><span>${label}</span><input type="${type}" name="${name}" ${options}></label>`;
}

function roleOptions(selected = 'staff') {
  return Object.entries(roles).map(([value, label]) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
}

function heading(iconName, title, api) {
  return `<h3 class="np-cloud-heading">${api.icon(iconName, 17)}<span>${title}</span></h3>`;
}

function isCloudMode(cloud) {
  return cloud.mode === 'cloud' || (cloud.mode == null && Boolean(cloud.store));
}

export function renderCloudEntry(cloud, api) {
  const label = isCloudMode(cloud) ? '店舗・アカウント' : cloud.user ? 'クラウド店舗を開く' : 'クラウドにサインイン';
  return `<span class="np-cloud-entry">${button(label, 'cloud-open', api, { glyph: 'user' })}</span>`;
}

export function renderCloudBanner(cloud, api) {
  if (!isCloudMode(cloud)) return '';
  const { escape, icon } = api;
  const { store, status, pending } = cloud;
  const waiting = Array.isArray(pending) ? pending.length : Number(pending) || 0;
  const offline = status === 'offline';
  const failed = status === 'error' || status === 'conflict';
  const connected = status === 'synced';
  const name = store?.name || 'クラウド店舗';
  let caption = 'クラウドに接続しています';
  if (connected) caption = '同期済み';
  if (connected && waiting) caption = '送信を確認しています';
  if (offline) caption = waiting ? `オフライン · ${integer.format(waiting)}件の送信待ち` : 'オフライン';
  if (failed) caption = status === 'conflict' ? '操作内容を確認してください' : '接続を確認してください';
  if (connected && store?.hasState === false) caption = '営業データの準備が必要です';
  return `<section class="np-cloud-banner${failed || offline ? ' np-cloud-banner-warning' : ''}" aria-label="クラウド店舗">
    <span class="np-cloud-symbol">${icon('store', 18)}</span>
    <div class="np-cloud-banner-store"><strong>${escape(name)}</strong>${store?.role ? `<span>${roleName(store.role)}</span>` : ''}</div>
    <span class="np-cloud-state${connected ? ' np-cloud-state-connected' : ''}" role="status"><span class="dot" aria-hidden="true"></span>${caption}</span>
    ${status === 'conflict' ? button('送信待ちを取り消す', 'cloud-sync-discard', api, { tone: 'quiet' })
      : failed || offline ? button('再接続', 'cloud-sync-retry', api, { glyph: 'refresh', tone: 'quiet' }) : ''}
  </section>`;
}

function loginPanel(cloud, api) {
  const unavailable = cloud.cloudConfigured === false;
  const providers = cloud.providers ?? ['email'];
  const google = providers.includes('google');
  const passwords = providers.includes('password') || providers.includes('email');
  const busy = Boolean(cloud.busy || cloud.status === 'connecting');
  const emailFields = `<div class="np-cloud-detail-body">
        ${field('メールアドレス', 'cloud-email', 'email', `autocomplete="email" maxlength="254"${busy ? ' disabled' : ''}`)}
        ${field('パスワード', 'cloud-password', 'password', `autocomplete="current-password"${busy ? ' disabled' : ''}`)}
    <div class="np-cloud-buttons">${button('サインイン', 'cloud-email-sign-in', api, { tone: google ? 'secondary' : 'primary', disabled: busy })}
      ${button('アカウントを作成', 'cloud-email-register', api, { tone: 'quiet', disabled: busy })}</div>
    <div class="np-cloud-reset">${button('パスワードを再設定', 'cloud-email-reset', api, { tone: 'quiet', disabled: busy })}</div>
  </div>`;
  return `<section class="np-cloud-card np-cloud-intro">
    <span class="np-cloud-symbol">${api.icon('store', 20)}</span>
    <p>PCとスマホで同じ店舗を開き、注文・会計・在庫を共有します。</p>
  </section>
  ${unavailable ? `<p class="np-cloud-message" role="status">この公開先ではクラウド店舗を利用できません。デモは引き続きお試しいただけます。</p>` : `<section class="np-cloud-card np-cloud-sign-in" aria-labelledby="cloud-login-heading">
    <h3 id="cloud-login-heading">サインイン</h3>
    ${google ? `<div class="np-cloud-google">${button('Googleでサインイン', 'cloud-google', api, { glyph: 'user', tone: 'primary', disabled: busy })}</div>` : ''}
    ${passwords ? (google ? `<details><summary>メールアドレスでサインイン</summary>${emailFields}</details>` : emailFields) : ''}
  </section>`}
  <div class="np-cloud-buttons">${button('サインインなしで試す', 'cloud-demo', api, { glyph: 'arrow-left', tone: 'quiet' })}</div>`;
}

function storeChooser(cloud, api) {
  const {escape, icon} = api;
  const stores = Array.isArray(cloud.stores) ? cloud.stores : [];
  const busy = Boolean(cloud.busy);
  return `<section class="np-cloud-card">
    <header class="np-cloud-section-head">${heading('store', '店舗', api)}${button('更新', 'cloud-refresh', api, { glyph: 'refresh', tone: 'quiet', disabled: busy })}</header>
    ${stores.length ? `<ul class="np-cloud-stores">${stores.map((store) => {
      const current = store.id === cloud.store?.id && isCloudMode(cloud);
      return `<li><button type="button" class="np-cloud-store-row" data-action="cloud-select-store" data-id="${escape(store.id)}" aria-pressed="${current}"${busy ? ' disabled' : ''}>
        <span class="np-cloud-symbol">${icon('store', 16)}</span><span class="np-cloud-store-text"><strong>${escape(store.name)}</strong>
        <small>${roleName(store.role)}${store.hasState === false ? ' · 初期設定待ち' : ''}</small></span>
        ${current ? '<span class="np-cloud-role">利用中</span>' : icon('chevron-right', 14)}</button></li>`;
    }).join('')}</ul>` : '<p class="np-cloud-copy">所属する店舗はありません。招待を受けたメールアドレスでサインインすると店舗が表示されます。</p>'}
    <details class="np-cloud-create"><summary>店舗を作成</summary><div class="np-cloud-detail-body">
      <div class="np-cloud-form-row">${field('店舗名','cloud-store-name','text',`autocomplete="organization" maxlength="80"${busy ? ' disabled' : ''}`)}${button('作成する','cloud-create-store',api,{ glyph:'plus', disabled:busy })}</div>
    </div></details>
  </section>`;
}

function storePreparation(cloud, api) {
  if (!cloud.store || cloud.store.role !== 'admin' || cloud.store.hasState !== false || !isCloudMode(cloud)) return '';
  const {escape} = api;
  return `<section class="np-cloud-card np-cloud-prepare">
    ${heading('box', '営業データの準備', api)}
    <p class="np-cloud-copy">${escape(cloud.store.name)}の初回設定です。保存済みの営業データを移行するか、新しい営業データで始めます。</p>
    <div class="np-cloud-buttons">
      ${cloud.hasLocalData ? button('このブラウザーから移行', 'cloud-migrate', api, { tone: 'primary', glyph: 'move', disabled: cloud.busy }) : ''}
      ${button('新しい営業データで始める', 'cloud-initialize', api, { tone: cloud.hasLocalData ? 'secondary' : 'primary', glyph: 'plus', disabled: cloud.busy })}
    </div>
  </section>`;
}

function memberControls(member, api, cloud) {
  const { escape } = api;
  if (member.primary || member.uid === cloud.user?.uid) return `<span class="np-cloud-role">${member.primary ? '店舗の作成者' : roleName(member.role)}</span>`;
  return `<div class="np-cloud-member-controls"><label class="field"><span class="sr-only">${escape(member.email)}の権限</span>
    <select name="cloud-member-role" data-cloud-member-role${cloud.busy ? ' disabled' : ''}>${roleOptions(member.role)}</select></label>
    ${button('更新', 'cloud-member-save', api, { id: member.uid, disabled: cloud.busy })}
    ${button('アクセスを解除', 'cloud-member-revoke', api, { id: member.uid, tone: 'danger', disabled: cloud.busy })}</div>`;
}

function membersPanel(cloud, api) {
  if (!cloud.store || cloud.store.role !== 'admin' || !isCloudMode(cloud)) return '';
  const { escape } = api;
  const members = Array.isArray(cloud.members) ? cloud.members : [];
  const invites = Array.isArray(cloud.invites) ? cloud.invites : [];
  return `<section class="np-cloud-card">
    ${heading('users', 'メンバーと権限', api)}
    ${cloud.membersLoading ? '<p class="np-cloud-copy" role="status">メンバーを読み込んでいます。</p>' : ''}
    ${members.length ? `<ul class="np-cloud-people">${members.map((member) => `<li class="np-cloud-person">
      <span class="np-cloud-identity"><strong>${escape(member.email || member.uid)}</strong><small>${roleName(member.role)}${member.uid === cloud.user?.uid ? ' · あなた' : ''}</small></span>
      ${memberControls(member, api, cloud)}</li>`).join('')}</ul>` : ''}
    ${invites.length ? `<div><h4 class="np-cloud-subheading">招待中</h4><ul class="np-cloud-people">${invites.map((invite) => `<li class="np-cloud-person">
      <span class="np-cloud-identity"><strong>${escape(invite.email)}</strong><small>${roleName(invite.role)}</small></span>
      ${button('招待を取り消す', 'cloud-invite-revoke', api, { id: invite.id, tone: 'quiet', disabled: cloud.busy })}</li>`).join('')}</ul></div>` : ''}
    <details class="np-cloud-create"><summary>メンバーを招待</summary>
      <div class="np-cloud-detail-body">
        <div class="np-cloud-invite-form">${field('メールアドレス', 'cloud-invite-email', 'email', `autocomplete="off" maxlength="254"${cloud.busy ? ' disabled' : ''}`)}
          <label class="field"><span>権限</span><select name="cloud-invite-role"${cloud.busy ? ' disabled' : ''}>${roleOptions()}</select></label></div>
        <p class="np-cloud-copy">相手にこの公開ページを案内してください。招待先と同じ確認済みメールアドレスでサインインすると、店舗が表示されます。</p>
        <div class="np-cloud-buttons">${button('招待を登録', 'cloud-invite', api, { glyph:'plus', disabled:cloud.busy })}</div>
      </div>
    </details>
  </section>`;
}

function accountPanel(cloud, api) {
  const { escape, icon } = api;
  const user = cloud.user;
  const verified = cloud.userVerified ?? user.emailVerified;
  const name = user.displayName || user.email || 'サインイン済み';
  return `<section class="np-cloud-card np-cloud-account">
    <span class="np-cloud-symbol">${icon('user', 19)}</span><div class="np-cloud-identity"><strong>${escape(name)}</strong>
      ${user.email && name !== user.email ? `<small>${escape(user.email)}</small>` : ''}</div>
    ${button('サインアウト', 'cloud-sign-out', api, { tone: 'quiet', disabled: cloud.busy })}
  </section>
  ${verified === false ? `<section class="np-cloud-card np-cloud-verification">${heading('info', 'メールアドレスの確認', api)}
    <p class="np-cloud-copy">確認リンクを開いたら、この画面で「更新」を押すと招待された店舗を確認できます。</p>
    <div class="np-cloud-buttons">${button('確認メールを再送', 'cloud-email-verify', api, { disabled: cloud.busy })}${button('更新', 'cloud-refresh', api, { glyph: 'refresh', tone: 'quiet', disabled: cloud.busy })}</div></section>` : ''}
  ${storePreparation(cloud, api)}
  ${verified === false ? '' : storeChooser(cloud, api)}
  ${membersPanel(cloud, api)}
  <div class="np-cloud-buttons">${button('デモを開く', 'cloud-demo', api, { glyph: 'arrow-left', tone: 'quiet' })}</div>`;
}

export function renderCloudPanel(cloud, api) {
  const message = cloud.actionError || cloud.message;
  return `<div class="np-cloud-panel"${cloud.busy ? ' aria-busy="true"' : ''}>
    ${message ? `<p class="np-cloud-message${cloud.actionError ? ' np-cloud-message-error' : ''}" role="${cloud.actionError ? 'alert' : 'status'}">${api.escape(message)}</p>` : ''}
    ${cloud.user ? accountPanel(cloud, api) : loginPanel(cloud, api)}
  </div>`;
}

export function renderCloudRestricted(cloud, api) {
  return `<section class="np-cloud-card np-cloud-restricted">
    ${heading('user', '店舗へのアクセス', api)}
    <p class="np-cloud-copy">${roleName(cloud.store?.role)}として所属しています。営業画面の利用権限は店舗管理者に確認してください。</p>
    <div class="np-cloud-buttons">${button('店舗・アカウント', 'cloud-open', api, { glyph: 'user' })}</div>
  </section>`;
}

export function renderCloudMigration({storeName, date, tableCount, ticketCount, closedDayCount, movementCount}, api) {
  const { escape, icon } = api;
  const counts = [['卓', tableCount], ['伝票', ticketCount], ['締め済み営業日', closedDayCount], ['入出庫履歴', movementCount]];
  return `<div class="np-cloud-panel">
    <section class="np-cloud-card np-cloud-intro"><span class="np-cloud-symbol">${icon('move', 20)}</span>
      <div><h3>${escape(storeName)}</h3><p>このブラウザーの店舗設定と営業データを移行します。</p></div></section>
    <section class="np-cloud-card">${heading('history', '移行するデータ', api)}
      ${date ? `<p class="np-cloud-copy">直近の営業日 ${escape(date)}</p>` : ''}
      <dl class="np-cloud-migration-counts">${counts.map(([label, value]) =>
        `<div><dt>${label}</dt><dd>${integer.format(Number(value) || 0)}</dd></div>`).join('')}</dl>
    </section>
    <p class="np-cloud-message">移行すると、この店舗に所属する端末で営業データを共有できます。このブラウザーの元データも保持します。</p>
  </div>`;
}
