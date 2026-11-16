export function formatAutoExtensionCountdown(deadline, now) {
  const seconds = Math.max(0,Math.ceil((deadline - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
}

export function renderAutoExtensionWarnings(notices, now, {escape, icon, tableName, canCheckout = () => true, pendingTicketId = null}) {
  const entries = notices.map(({ticketId, tableIds, deadline}) => {
    const names = tableIds.map(tableName).join('・');
    const id = escape(ticketId);
    const pending = pendingTicketId === ticketId;
    const checkoutAllowed = canCheckout(ticketId);
    return `<li class="auto-extension-warning-card">
      <button type="button" class="auto-extension-warning" data-action="auto-extension-focus" data-id="${id}"
        aria-label="${escape(names)}の伝票を開く（自動延長まで1分以内）">
        <strong>${escape(names)}</strong>
        <span class="auto-extension-countdown">
          <time datetime="${new Date(deadline).toISOString()}" data-auto-extension-deadline="${escape(deadline)}">
            ${formatAutoExtensionCountdown(deadline,now)}
          </time>
          ${icon('chevron-right',16)}
        </span>
      </button>
      <div class="auto-extension-warning-actions" role="group" aria-label="${escape(names)}の延長前の操作">
        <button type="button" class="btn auto-extension-warning-pause" data-action="auto-extension-pause"
          data-id="${id}"${pending ? ' disabled' : ''}>今回の来店だけ自動延長を止める</button>
        <button type="button" class="btn btn-primary" data-action="auto-extension-checkout"
          data-id="${id}"${pending || !checkoutAllowed ? ' disabled' : ''}>${icon('arrow-right',15)}会計へ進む</button>
        ${checkoutAllowed ? '' : '<p class="auto-extension-checkout-note">値引きの承認後に会計できます。</p>'}
      </div>
    </li>`;
  });
  return `<section class="auto-extension-warnings" id="auto-extension-warnings"
    aria-labelledby="auto-extension-warning-title"${entries.length ? '' : ' hidden'}>
    <h2 id="auto-extension-warning-title">${icon('alert',19)}自動延長まで1分以内</h2>
    <ul>${entries.join('')}</ul>
  </section>`;
}

export function renderVisitAutoExtensionPaused({icon}) {
  return `<p class="auto-extension-visit-paused">${icon('clock',15)}この来店の自動延長は停止中</p>`;
}

export function renderAutoExtensionBadge(mode, {icon}) {
  if (mode === 'soon') return `<span class="seat-auto-extension seat-auto-extension-soon" title="自動延長まで1分以内" aria-hidden="true">
    ${icon('alert',12)}<span>延長間近</span></span>`;
  if (mode === 'off') return `<span class="seat-auto-extension seat-auto-extension-off" title="この卓の自動延長はオフ" aria-hidden="true">
    ${icon('x',12)}<span>延長OFF</span></span>`;
  if (mode === 'paused') return `<span class="seat-auto-extension seat-auto-extension-paused" title="この来店の自動延長は停止中" aria-hidden="true">
    ${icon('clock',12)}<span>今回のみ停止</span></span>`;
  return '';
}

export function renderTableAutoExtensionControl(table, {enabled, storeEnabled, blockedBy = []}, {escape, icon, tableName}) {
  const others = blockedBy.filter((id) => id !== table.id);
  const detail = !storeEnabled ? '店舗全体の設定はオフです。'
    : enabled && others.length ? `連結卓の${others.map(tableName).join('・')}がオフです。` : '';
  const status = enabled ? 'オン' : 'オフ';
  return `<div class="table-auto-extension-control">
    <button type="button" class="btn btn-quiet table-auto-extension-opener" data-action="table-auto-extension" data-id="${escape(table.id)}"
      aria-label="${escape(table.name)}の自動延長設定（${status}）">
      ${icon('clock',15)}<span>卓の自動延長</span><strong class="table-auto-extension-state" data-enabled="${enabled}">${status}</strong>
      ${icon('chevron-right',15)}
    </button>
    ${detail ? `<p>${escape(detail)}</p>` : ''}
  </div>`;
}

export function renderTableAutoExtensionSettings(state, {tableId, enabled, storeEnabled, available = storeEnabled, blockedBy = []},
  {escape, tableName}) {
  if (state.tables.length === 0) return '<p class="form-copy">設定できる卓がありません。</p>';
  const options = state.tables.map(({id,name,area}) => `<option value="${escape(id)}"${id === tableId ? ' selected' : ''}>
    ${escape(name)}${area ? `（${escape(area)}）` : ''}
  </option>`);
  const others = blockedBy.filter((id) => id !== tableId);
  const detail = !storeEnabled ? '店舗全体の設定をオンにすると、保存した卓の設定が適用されます。'
    : !available ? '店舗で利用できる延長プランを選ぶと、保存した卓の設定が適用されます。' : '';
  return `<div class="table-auto-extension-settings">
    <label class="field"><span>卓を選択</span><select name="autoTableId" required>${options.join('')}</select></label>
    <label class="billing-switch"><span>この卓の自動延長をオンにする</span>
      <input type="checkbox" role="switch" name="tableAutoExtensionEnabled"${enabled ? ' checked' : ''}></label>
    ${detail ? `<p class="ops-highlight">${detail}</p>` : ''}
    ${others.length ? `<p class="ops-highlight">連結卓の${escape(others.map(tableName).join('・'))}がオフです。</p>` : ''}
    <p class="field-help">この設定は次の来店にも引き継ぎます。連結した卓は、すべての卓がオンのときに自動延長します。</p>
  </div>`;
}
