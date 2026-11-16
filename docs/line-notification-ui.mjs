import { lineNotifications } from './line-notification-content.mjs';

const time = new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const statusLabels = { pending:'送信待ち',accepted:'LINEが受理',failed:'送信失敗',expired:'期限切れ',cancelled:'取り消し',demo:'デモで確認済み' };

export function createLineDemoSettings() {
  return {configured:true,enabled:false,extension:false,lowStock:false,history:[]};
}

export function readLineSettings(form) {
  const data = new FormData(form);
  return Object.fromEntries(['enabled','extension','lowStock'].map((key) => [key,data.has(key)]));
}

export function renderLineSettings({model,loading,failed,demo,busy},{escape,button}) {
  if (loading) return '<p class="notice" role="status">LINE通知の設定を取得しています。</p>';
  if (failed) return `<p class="notice" role="alert">${escape(failed)}</p>`;
  const {configured,enabled,needsConfirmation,lowStock,extension,history} = model;
  const ready = configured && enabled;
  const checkbox = (name,label,checked) => `<label class="inline-check"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}
    ${!configured ? ' disabled' : ''}><span>${label}</span></label>`;
  return `<div class="np-cloud-panel" aria-busy="${Boolean(busy)}">
    <section class="np-cloud-card np-cloud-intro np-cloud-group-demo"><div>
      <h3>${demo ? 'LINE通知のデモ' : '店舗向けLINE通知'}</h3>
      <p>${demo ? 'ここでは通知の文面と送信履歴を画面内で試せます。'
        : configured ? '設定済みのLINE送信先へ、店舗の確認事項を通知します。'
          : 'LINEの公式アカウントと、この店舗の送信先をサーバーに設定すると利用できます。'}</p>
    </div><span class="np-cloud-role">${demo ? 'デモ' : ready ? '有効' : '停止中'}</span></section>
    ${needsConfirmation ? '<p class="np-cloud-message" role="status">LINEの送信先が更新されています。設定を確認して、もう一度有効にしてください。</p>' : ''}
    <section class="np-cloud-card">
      <h3>通知する内容</h3>
      ${checkbox('enabled','店舗のLINE通知を有効にする',enabled)}
      ${checkbox('extension','自動延長の予定時刻が近づいたとき（約5分前）',extension)}
      ${checkbox('lowStock','在庫数量が設定した下限に達したとき',lowStock)}
      <details><summary>送信される文面</summary><div class="np-cloud-detail-body">${Object.values(lineNotifications)
        .map(({label,text}) => `<div><strong>${escape(label)}</strong><p>${escape(text)}</p></div>`).join('')}</div></details>
    </section>
    <section class="np-cloud-card">
      <header class="np-cloud-section-head"><h3>通知履歴</h3>
      ${!demo ? button('履歴を更新','line-notifications-refresh',{tone:'quiet',disabled:busy}) : ''}</header>
      <div class="np-cloud-buttons">${button(demo ? 'テスト通知を試す' : 'テスト通知を送信','line-notifications-test',
        {tone:'secondary',disabled:busy || !ready})}
      ${demo && extension ? button('延長前通知を試す','line-notifications-preview',{id:'extension',disabled:busy || !ready}) : ''}
      ${demo && lowStock ? button('在庫通知を試す','line-notifications-preview',{id:'low-stock',disabled:busy || !ready}) : ''}</div>
      ${history.length ? `<ul class="np-cloud-people">${history.map(({kind,status,createdAt}) => `<li class="np-cloud-person">
        <span class="np-cloud-identity"><strong>${escape(lineNotifications[kind]?.label ?? '通知')}</strong>
        <small>${escape(Number.isFinite(createdAt) ? time.format(createdAt) : '')}</small></span>
        <span class="np-cloud-role">${escape(statusLabels[status] ?? '状態を確認できません')}</span></li>`).join('')}</ul>`
        : '<p class="np-cloud-copy">まだ通知履歴はありません。</p>'}
    </section></div>`;
}
