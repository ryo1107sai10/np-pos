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

function renderLinePairing({model,pairing,busy,webhookUrl},{escape,button}) {
  return `<section class="np-cloud-card">
    <h3>LINE公式アカウントと接続</h3>
    ${model.destinationLabel ? `<p class="np-cloud-copy">現在の送信先 <strong>${escape(model.destinationLabel)}</strong></p>` : ''}
    ${model.canPair ? `<p class="np-cloud-copy">接続コードを、通知を受け取るLINEグループか公式アカウントとの個別トークに送ってください。</p>
      <div class="np-cloud-buttons">
      ${button(model.configured ? '送信先を変更するコードを発行' : '接続コードを発行','line-notifications-pair-start',{disabled:busy,tone:'secondary'})}
      ${button('送信先を確認','line-notifications-pair-check',{disabled:busy,tone:'quiet'})}</div>
      ${pairing?.sendText && !pairing?.label ? `
      ${pairing.officialAccount ? `<p class="np-cloud-copy">公式アカウント <strong>${escape(pairing.officialAccount)}</strong></p>` : ''}
      <label class="field"><span>LINEに送るメッセージ</span><input type="text" readonly value="${escape(pairing.sendText)}"></label>
      <p class="np-cloud-copy">有効期限 ${escape(time.format(pairing.expiresAt))}</p>
      ${button('接続コードをコピー','line-notifications-pair-copy',{disabled:busy,tone:'quiet'})}` : ''}
      ${pairing?.label ? `<p class="np-cloud-message" role="status">LINEで確認した送信先 <strong>${escape(pairing.label)}</strong></p>
      <p class="np-cloud-copy">この送信先を登録すると、通知はいったん停止します。登録後に有効にしてください。</p>
      ${button('このトークを送信先にする','line-notifications-pair-confirm',{disabled:busy,tone:'secondary'})}` : ''}`
      : '<p class="np-cloud-copy">公式アカウントを管理する方が、先にCloudflareへ接続情報を登録してください。</p>'}
    <details${model.canPair ? '' : ' open'}><summary>公式アカウントの初回設定</summary><div class="np-cloud-detail-body">
      <ol><li>LINE公式アカウントでMessaging APIを有効にします。</li>
      <li>CloudflareのWorker「np-pos-cloud」の設定で「シークレット」を選び、<code>LINE_CHANNEL_SECRET</code> と <code>LINE_CHANNEL_ACCESS_TOKEN</code> を登録します。</li>
      <li>LINE DevelopersコンソールでこのWebhook URLを設定し、検証してWebhookを有効にします。</li>
      <li>グループを使う場合は公式アカウントのグループ参加を許可し、対象グループに招待します。</li></ol>
      <label class="field"><span>Webhook URL</span><input type="url" readonly value="${escape(webhookUrl ?? '')}"></label>
      <p><a href="https://developers.line.biz/console/" target="_blank" rel="noopener noreferrer">LINE Developersコンソール</a></p>
    </div></details>
  </section>`;
}

export function renderLineSettings({model,loading,failed,demo,busy,pairing,webhookUrl},{escape,button}) {
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
    ${demo ? '' : renderLinePairing({model,pairing,busy,webhookUrl},{escape,button})}
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
