import { roleLabels } from './role-policy.mjs';

const roleName = (role) => role === 'owner' ? 'グループ管理者' : roleLabels[role] ?? '';

function roleOptions(selected = 'staff') {
  return ['manager','staff'].map((role) => `<option value="${role}"${role === selected ? ' selected' : ''}>${roleName(role)}</option>`).join('');
}

function groupOwnerActions(group, attachable, demo, {escape,button}) {
  const members = group.members.map(({uid,email,role}) => `<li class="np-cloud-person">
    <span class="np-cloud-identity"><strong>${escape(email)}</strong><small>${roleName(role)}</small></span>
    <div class="np-cloud-member-controls">
      <label class="field"><span class="sr-only">${escape(email)}のグループ権限</span><select data-group-member-role>${roleOptions(role)}</select></label>
      ${button('権限を保存','cloud-group-member-save',{id:uid})}
      ${demo ? button('この権限で見る','cloud-group-demo-preview',{id:uid,tone:'quiet'}) : ''}
      ${button('アクセス解除','cloud-group-member-remove',{id:uid,tone:'danger'})}
    </div></li>`).join('');
  const invites = group.invites.map(({id,email,role}) => `<li class="np-cloud-person">
    <span class="np-cloud-identity"><strong>${escape(email)}</strong><small>${roleName(role)} · 招待中</small></span>
    <div class="np-cloud-member-controls">
      ${demo ? button('招待を受ける','cloud-group-demo-accept',{id}) : ''}
      ${button('招待を取り消す','cloud-group-invite-remove',{id,tone:'quiet'})}
    </div></li>`).join('');
  return `<section class="np-cloud-card"><h3>グループの設定</h3>
    <div class="np-cloud-form-row">
      <label class="field"><span>グループ名</span><input name="group-name" maxlength="60" value="${escape(group.name)}"></label>
      ${button('名前を保存','cloud-group-rename')}
    </div>
    ${attachable.length ? `<div class="np-cloud-form-row">
      <label class="field"><span>追加する店舗</span><select name="group-store"><option value="">選択してください</option>
      ${attachable.map(({id,name}) => `<option value="${escape(id)}">${escape(name)}</option>`).join('')}</select></label>
      ${button('店舗を追加','cloud-group-store-add',{glyph:'plus'})}
    </div>` : '<p class="np-cloud-copy">追加できる店舗は「店舗・アカウント」で作成できます。</p>'}
  </section>
  <section class="np-cloud-card"><h3>グループメンバー</h3>
    <p class="np-cloud-copy">グループ権限は所属店舗に共通で適用されます。店舗から直接付与された権限がある場合は、その権限が優先されます。</p>
    ${members || invites ? `<ul class="np-cloud-people">${members}${invites}</ul>` : ''}
    <details data-group-section="invite"><summary>グループに招待</summary>
      <div class="np-cloud-detail-body">
        <div class="np-cloud-invite-form">
          <label class="field"><span>メールアドレス</span><input name="group-email" type="email" maxlength="254" autocomplete="off"></label>
          <label class="field"><span>グループ権限</span><select name="group-role">${roleOptions()}</select></label>
        </div>
        <p class="np-cloud-copy">${demo ? '登録した招待は、この画面で受け取る操作を試せます。' : '招待した相手が同じ確認済みメールアドレスでサインインすると、所属店舗を開けます。'}</p>
        <div class="np-cloud-buttons">${button('招待を登録','cloud-group-invite',{glyph:'plus'})}</div>
      </div>
    </details>
  </section>`;
}

export function renderStoreGroups({model,selectedGroupId,loading,error,demo,preview},{escape,button}) {
  if (loading) return '<p class="notice" role="status">店舗グループを読み込んでいます。</p>';
  if (error) return `<p class="np-cloud-message np-cloud-message-error" role="alert">${escape(error)}</p>`;
  const groups = model?.groups ?? [];
  const group = groups.find(({id}) => id === selectedGroupId) ?? groups[0];
  const owner = group?.role === 'owner';
  return `<div class="np-cloud-panel">
    ${demo ? `<section class="np-cloud-card np-cloud-intro np-cloud-group-demo"><div>
      <h3>店舗グループのデモ</h3>
      <p>サンプル店舗の追加やメンバーの招待を試せます。操作内容はこの画面を開いている間だけ保持されます。</p>
      </div>${preview ? button('管理者の表示に戻る','cloud-group-demo-return',{tone:'quiet'}) : ''}</section>` : ''}
    ${groups.length > 1 ? `<section class="np-cloud-card"><label class="field"><span>表示するグループ</span>
      <select name="group-select">${groups.map(({id,name}) => `<option value="${escape(id)}"${group.id === id ? ' selected' : ''}>${escape(name)}</option>`).join('')}</select>
    </label></section>` : ''}
    ${group ? `<section class="np-cloud-card">
      <header class="np-cloud-section-head"><h3>${escape(group.name)}</h3><span class="np-cloud-role">${roleName(group.role)}</span></header>
      ${group.stores.length ? `<ul class="np-cloud-stores">${group.stores.map(({id,name,role}) => `<li class="np-cloud-person">
        <span class="np-cloud-identity"><strong>${escape(name)}</strong><small>${roleName(role)}</small></span>
        <div class="np-cloud-member-controls">${demo ? '' : button('店舗を開く','cloud-select-store',{id,glyph:'chevron-right'})}
        ${owner ? button('グループから外す','cloud-group-store-remove',{id,tone:'quiet'}) : ''}</div>
      </li>`).join('')}</ul>` : '<p class="np-cloud-copy">このグループには店舗がありません。</p>'}
    </section>` : '<p class="np-cloud-copy">所属する店舗グループはありません。</p>'}
    ${owner ? groupOwnerActions(group,model.attachable,demo,{escape,button}) : ''}
    ${!preview ? `<section class="np-cloud-card"><details data-group-section="create"${groups.length ? '' : ' open'}>
      <summary>グループを作成</summary><div class="np-cloud-detail-body np-cloud-form-row">
        <label class="field"><span>新しいグループ名</span><input name="group-create-name" maxlength="60"></label>
        ${button('グループを作成','cloud-group-create',{glyph:'plus'})}
      </div></details>
    </section>` : ''}
  </div>`;
}
