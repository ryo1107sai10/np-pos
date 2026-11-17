import { activeCastAssignments, castRotationEndLabels, castRotationLimit, getRotationAssignableCast, splitCastRotation } from './cast-rotation.mjs';

const clock = new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

export function renderCastRotationHistory(ticket, {escape}) {
  const {history} = splitCastRotation(ticket);
  if (!history.length) return '';
  return `<details class="rotation-history"><summary>付け回しの履歴（${history.length}件）</summary>
    <ul class="rotation-list">${history.map(({castName,queuedAt,startedAt,endedAt,endReason}) => `<li>
      <span><strong>${escape(castName)}</strong><small>${startedAt == null ? `待機 ${clock.format(queuedAt)}` : clock.format(startedAt)} 〜 ${clock.format(endedAt)}
      <span> · ${castRotationEndLabels[endReason] ?? '終了'}</span></small></span></li>`).join('')}</ul></details>`;
}

export function renderCastRotationBoard(state, api) {
  const {escape,button,ticketLabel} = api;
  const rows = state.tickets.filter(({status}) => status === 'open');
  if (!rows.length) return '<p class="form-copy">会計前の伝票がありません。ホールで来店を登録してください。</p>';
  return `<ul class="rotation-list" aria-label="伝票ごとのキャスト配置">${rows.map((ticket) => {
    const {active,waiting} = splitCastRotation(ticket);
    const names = active.map(({castName}) => castName).join('・');
    return `<li><span><strong>${escape(ticketLabel(ticket))}</strong><small>${names ? `接客中 ${escape(names)}` : '接客中なし'} · 待機 ${waiting.length}名</small></span>
      ${button('配置・交代','rotation-ticket',{id:ticket.id,glyph:'users'})}</li>`;
  }).join('')}</ul>`;
}

function rotationChange(api, label, id, mode, extra = '') {
  return api.button(label,'rotation-change',{id,data:`data-rotation-mode="${mode}" ${extra}`,tone:'secondary'});
}

export function renderCastRotationTicket(state, ticket, api, now = Date.now()) {
  const {button,escape,ticketLabel} = api;
  const {active,waiting} = splitCastRotation(ticket);
  const positions = activeCastAssignments(state);
  const eligible = new Set(getRotationAssignableCast(state,now).map(({id}) => id));
  const first = waiting[0];
  const canSwap = first && eligible.has(first.castId) && !positions.has(first.castId);
  const pendingIds = new Set([...active,...waiting].map(({castId}) => castId));
  const candidates = state.cast.filter(({id,enabled}) => enabled !== false && !pendingIds.has(id));
  const activeRows = active.map(({id,castName,startedAt}) => `<li><span><strong>${escape(castName)}</strong><small>${clock.format(startedAt)} から接客中</small></span>
    <div class="ops-actions">${canSwap ? rotationChange(api,'次と交代',id,'swap',`data-rotation-next="${escape(first.id)}"`) : ''}
    ${rotationChange(api,'終了',id,'finish')}</div></li>`).join('');
  const waitingRows = waiting.map(({id,castId,castName,queuedAt},index) => {
    const source = positions.get(castId);
    const description = !eligible.has(castId) ? '現在は勤務条件の対象外' : source ? `${ticketLabel(source.ticket)}で接客中` : `待機開始 ${clock.format(queuedAt)}`;
    const start = !eligible.has(castId) ? '' : source ? button('移動して開始','rotation-transfer',{id,tone:'secondary',
      data:`data-rotation-source="${escape(source.entry.id)}"`}) : rotationChange(api,'開始',id,'start');
    return `<li><span><strong>${index + 1}．${escape(castName)}</strong><small>${escape(description)}</small></span>
      <div class="ops-actions">${start}${index ? rotationChange(api,'次にする',id,'next') : ''}${rotationChange(api,'待機取消',id,'remove')}</div></li>`;
  }).join('');
  const add = candidates.length && (ticket.castRotation ?? []).length < castRotationLimit
    ? `<label class="field"><span>待機に追加するキャスト</span><select name="rotationCastId" required>
      <option value="">選択してください</option>${candidates.map(({id,name}) => `<option value="${escape(id)}">${escape(name)}</option>`).join('')}</select></label>` : '';
  const roster = `<p class="form-copy">待機の順に交代できます。接客の記録は担当注文・歩合を変更しません。</p>
    <section class="rotation-section" aria-labelledby="rotation-active"><h3 id="rotation-active">接客中</h3>
      ${activeRows ? `<ul class="rotation-list">${activeRows}</ul>` : '<p class="field-help">接客中のキャストはいません。</p>'}</section>
    <section class="rotation-section" aria-labelledby="rotation-waiting"><h3 id="rotation-waiting">交代待ち</h3>
      ${waitingRows ? `<ol class="rotation-list">${waitingRows}</ol>` : '<p class="field-help">待機中のキャストはいません。</p>'}</section>`;
  return {body:roster + add + renderCastRotationHistory(ticket,api),canAdd:Boolean(add)};
}
