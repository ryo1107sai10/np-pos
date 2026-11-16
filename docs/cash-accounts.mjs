const kinds = ['vault','payee'];
const labels = {vault:'金庫',payee:'出金先'};
const validId = (id) => typeof id === 'string' && /^cash-account-[a-z0-9-]{1,64}$/.test(id);
const validBalance = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
const active = (entry) => entry.enabled !== false;

export function cashAccounts(state, kind) {
  return (state.cashAccounts ?? []).filter((entry) => (kind === undefined || entry.kind === kind));
}

export function cashAccountOptions(state, kind) {
  return cashAccounts(state,kind).filter(active);
}

export function normalizeCashAccounts(value) {
  if (!Array.isArray(value) || value.length > 40) throw new Error('金庫と出金先は合わせて40件まで登録できます。');
  const rows = value.map((entry) => {
    const name = typeof entry?.name === 'string' ? entry.name.trim().normalize('NFC') : '';
    if (!validId(entry?.id) || !kinds.includes(entry.kind) || typeof entry.enabled !== 'boolean'
        || !name || name.length > 60 || /[\p{Cc}\u2028\u2029]/u.test(name)
        || !validBalance(entry.openingBalance) || (entry.kind === 'payee' && entry.openingBalance !== 0)) {
      throw new Error('金庫名・出金先名は60文字以内、残高は0円以上の整数で入力してください。');
    }
    return {id:entry.id,kind:entry.kind,name,openingBalance:entry.openingBalance,enabled:entry.enabled};
  });
  if (new Set(rows.map(({id})=>id)).size !== rows.length
      || new Set(rows.map(({kind,name})=>kind + ':' + name)).size !== rows.length) {
    throw new Error('同じ種類に同一の金庫名・出金先名が登録されています。');
  }
  return rows;
}

function storedMovements(state) {
  return new Map([...(state.closedDays ?? []).flatMap(({cashMovements})=>cashMovements ?? []),
    ...(state.cashMovements ?? [])].map((entry)=>[entry.id,entry])).values();
}

export function vaultBalance(state, vault) {
  let balance = vault.openingBalance;
  for (const entry of storedMovements(state)) {
    if (entry.cashAccountId !== vault.id || entry.voidedAt != null) continue;
    balance += entry.kind === 'withdrawal' ? entry.amount : -entry.amount;
  }
  return balance;
}

export function saveCashAccounts(state, action, actor) {
  if (actor.role !== 'admin') throw new Error('金庫と出金先の設定には店舗管理者の権限が必要です。');
  const next = normalizeCashAccounts(action.accounts);
  const previous = cashAccounts(state);
  for (const old of previous) {
    const updated = next.find(({id}) => id === old.id);
    if (!updated || old.kind !== updated.kind || old.openingBalance !== updated.openingBalance) {
      throw new Error('登録済みの金庫・出金先は表示状態と名前を変更できます。');
    }
  }
  state.cashAccounts = next;
}

export function cashCounterparty(state, action) {
  if (action.cashAccountId == null || action.cashAccountId === '') return {};
  const entry = cashAccountOptions(state).find(({id})=>id === action.cashAccountId);
  if (!entry) throw new Error('利用できる金庫・出金先を選択してください。');
  if (entry.kind === 'vault') {
    if (!['deposit','withdrawal'].includes(action.kind) || action.category !== 'safe') {
      throw new Error('金庫移動には入金または出金の金庫区分を選択してください。');
    }
    if (action.kind === 'deposit' && vaultBalance(state,entry) < action.amount) throw new Error('金庫の残高を超えてレジに移動できません。');
  } else if (action.kind !== 'expense' && action.kind !== 'withdrawal') throw new Error('出金・経費で出金先を選択できます。');
  return {cashAccountId:entry.id,cashAccountKind:entry.kind,destination:entry.name};
}

export function validCashAccountMetadata(entry) {
  if (entry.cashAccountKind === undefined && entry.cashAccountId === undefined) return true;
  return validId(entry.cashAccountId) && (entry.cashAccountKind === 'vault'
    ? ['deposit','withdrawal'].includes(entry.kind) && entry.category === 'safe'
    : entry.cashAccountKind === 'payee' && ['expense','withdrawal'].includes(entry.kind));
}

export function validCashAccountHistory(state) {
  const known = new Map(cashAccounts(state).map((entry)=>[entry.id,entry]));
  const balances = new Map(cashAccounts(state,'vault').map((entry)=>[entry.id,entry.openingBalance]));
  const movements = [...storedMovements(state)].filter(({cashAccountId})=>cashAccountId !== undefined).sort((a,b)=>a.at-b.at);
  for (const entry of movements) {
    if (known.get(entry.cashAccountId)?.kind !== entry.cashAccountKind) return false;
    if (entry.cashAccountKind !== 'vault' || entry.voidedAt != null) continue;
    const total = balances.get(entry.cashAccountId) + (entry.kind === 'withdrawal' ? entry.amount : -entry.amount);
    if (!Number.isSafeInteger(total) || total < 0) return false;
    balances.set(entry.cashAccountId,total);
  }
  return true;
}

export function renderCashAccounts(state,{escape,icon,yen}) {
  return `<p class="field-help">金庫と出金先を登録すると入出金で選択できます。金庫の残高はレジとの移動を反映します。</p>
    ${kinds.map((kind)=>`<section class="payroll-edit-section"><h3>${labels[kind]}</h3><div data-cash-accounts="${kind}">
      ${cashAccounts(state,kind).map((entry)=>renderCashAccountRow(entry,{escape,yen},kind === 'vault' ? vaultBalance(state,entry) : 0)).join('')}</div>
      <button type="button" class="btn" data-action="cash-account-add" data-id="${kind}">${icon('plus',16)}${labels[kind]}を追加</button></section>`).join('')}`;
}

export function renderCashAccountRow({id,kind,name = '',openingBalance = 0,enabled = true},{escape,yen},balance) {
  return `<div class="form-grid payroll-edit-section" data-cash-account-row data-account-id="${escape(id)}" data-account-kind="${kind}">
    <label class="field"><span>${labels[kind]}名</span><input name="cashAccountName" value="${escape(name)}" maxlength="60" required></label>
    ${kind === 'vault' ? `<label class="field"><span>開始時の残高（円）</span><input name="openingBalance" type="number" min="0" max="100000000" step="1" inputmode="numeric" value="${openingBalance}"${balance === undefined ? '' : ' readonly'} required></label>` : ''}
    <label class="inline-check"><input type="checkbox" name="cashAccountEnabled"${enabled ? ' checked' : ''}>入出金で利用する</label>
    ${kind === 'vault' && balance !== undefined ? `<p class="field-help">現在の残高 ${yen(balance)}</p>` : ''}
    ${balance === undefined ? '<button type="button" class="btn" data-action="cash-account-remove-new">追加を取り消す</button>' : ''}</div>`;
}

export function readCashAccounts(form) {
  return [...form.querySelectorAll('[data-cash-account-row]')].map((row)=>({
    id:row.dataset.accountId,kind:row.dataset.accountKind,name:row.querySelector('[name=cashAccountName]').value,
    openingBalance:Number(row.querySelector('[name=openingBalance]')?.value ?? 0),
    enabled:row.querySelector('[name=cashAccountEnabled]').checked,
  }));
}
