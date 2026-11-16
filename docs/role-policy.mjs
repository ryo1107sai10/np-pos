export const roleLabels = Object.freeze({
  admin:'店舗管理者', manager:'マネージャー', staff:'スタッフ', cast:'キャスト', trainee:'体入',
});

const common = ['floor','orders','checkout','printing','customers'];
export const editableRoles = Object.freeze({
  manager:[...common,'inventory','reports','staffing'],
  staff:[...common,'inventory','reports'],
});

const groups = {
  floor:{
    title:'卓の操作', detail:'開店・来店、卓移動、延長、退店、閉店',
    commands:['open','close','seat','move','extend','extendOverdue','depart','saveTicketNote','setTableAutoExtension',
      'pauseVisitAutoExtension','resumeVisitAutoExtension','adjustTicketEnd','adjustTicketGuests','cancelTicketExtension'],
    actions:['open','close','seat','move','extend','extend-overdue','depart','ticket-note','table-auto-extension',
      'auto-extension-pause','auto-extension-resume','auto-extension-checkout','ticket-end','ticket-set-time','ticket-guests','cancel-ticket-extension'],
  },
  orders:{
    title:'注文の操作', detail:'注文の追加・訂正・取消、提供済みの記録',
    commands:['order','serve','cancelLine','editTicketLine'],
    actions:['order','category','product','serve','cancel-line','edit-ticket-line','order-line-stage','order-line-reset','order-line-edit','order-line-remove'],
  },
  checkout:{
    title:'会計の操作', detail:'会計確定、値引き、前受金、伝票取消',
    commands:['deposit','editDeposit','cancelDeposit','discount','settle','void'],
    actions:['settle','auto-extension-checkout','deposit','edit-deposit','cancel-deposit','discount','void','payment-add','payment-remove'],
  },
  printing:{
    title:'帳票の発行', detail:'確認伝票、レシート、領収書、延長見積書',
    commands:['issuePrintDocument'],
    actions:['print-document','extension-quote','extension-quote-back'],
  },
  customers:{
    title:'顧客管理', detail:'来店時の顧客選択、顧客情報と履歴の閲覧・登録',
    commands:['setTicketCustomer','setTicketCompanion','saveCustomer','recoverReceivable'],
    actions:['ticket-customer','ticket-companions','save-ticket-companion','customer-new','customer-detail','customer-edit','customer-visit'],
    pages:['customers'],
  },
  inventory:{
    title:'在庫管理', detail:'在庫残高・原価・履歴の閲覧、入出庫・棚卸',
    commands:['stockAdjust','recordStockOperation','cancelStockPurchase'],
    actions:['stock-adjust','stocktake','stock-history','stock-cancel-purchase','stock-ticket'],
    pages:['stock'],
  },
  reports:{
    title:'レポート・入出金', detail:'日報・過去伝票・分析の閲覧、個人売上の調整、レジ入出金',
    commands:['recordCashMovement','editCashMovement','voidCashMovement','recoverReceivable','adjustPersonalSales'],
    actions:['record-cash','edit-cash-movement','void-cash-movement','report-mode','report-day','report-export',
      'analytics-csv','analytics-print','history-receipt','personal-sales-adjustment'],
    pages:['commission','reports','tickets','analytics','product-sales','cash','team-performance'],
  },
  staffing:{
    title:'シフト・勤怠', detail:'シフト一覧、勤務希望と打刻の確認・訂正',
    commands:['saveShift','removeShift','reviewCastAttendance','saveManagedAttendance','saveStaffAttendance','voidStaffAttendance'],
    actions:[], pages:['shifts','attendance'],
  },
};

const own = (object,key) => Object.hasOwn(object,key);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const profileKey = /^role-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const permissions = {
  serviceHours:{title:'開店・閉店',commands:['open','close'],actions:['open','close']},
  seatGuests:{title:'来店・人数の登録',commands:['seat','adjustTicketGuests'],actions:['seat','ticket-guests']},
  moveGuests:{title:'卓移動・退店',commands:['move','depart'],actions:['move','depart']},
  extendVisits:{title:'延長・終了時刻の変更',commands:['extend','extendOverdue','adjustTicketEnd','cancelTicketExtension',
    'setTableAutoExtension','pauseVisitAutoExtension','resumeVisitAutoExtension'],
    actions:['extend','extend-overdue','ticket-end','ticket-set-time','cancel-ticket-extension','table-auto-extension',
      'auto-extension-pause','auto-extension-resume','auto-extension-checkout']},
  ticketNotes:{title:'伝票メモ',commands:['saveTicketNote'],actions:['ticket-note']},
  addOrders:{title:'注文・提供済みの登録',commands:['order','serve'],actions:['order','category','product','serve','order-line-stage','order-line-reset']},
  editOrders:{title:'注文の訂正・取消',commands:['cancelLine','editTicketLine'],actions:['cancel-line','edit-ticket-line','order-line-edit','order-line-remove']},
  takePayment:{title:'会計確定',commands:['settle'],actions:['settle','auto-extension-checkout','payment-add','payment-remove']},
  deposits:{title:'前受金の登録・訂正',commands:['deposit','editDeposit','cancelDeposit'],actions:['deposit','edit-deposit','cancel-deposit']},
  discounts:{title:'値引きの登録・申請',commands:['discount'],actions:['discount']},
  voidTickets:{title:'使用中の伝票取消',commands:['void'],actions:['void']},
  printing:groups.printing,
  customers:{...groups.customers,commands:['setTicketCustomer','setTicketCompanion','saveCustomer','recoverReceivable']},
  editCustomers:{title:'顧客情報の登録・編集',commands:['saveCustomer'],actions:['customer-new','customer-edit']},
  inventory:{...groups.inventory,commands:[],actions:['stock-history','stock-ticket','stock-barcode-search']},
  editInventory:{title:'入出庫・棚卸',commands:groups.inventory.commands,actions:['stock-adjust','stocktake','stock-cancel-purchase']},
  reports:{...groups.reports,commands:['recoverReceivable'],actions:groups.reports.actions.filter((action) =>
    !['record-cash','edit-cash-movement','void-cash-movement','personal-sales-adjustment'].includes(action))},
  registerCash:{title:'レジの入出金を記録・訂正',commands:['recordCashMovement','editCashMovement','voidCashMovement'],
    actions:['record-cash','edit-cash-movement','void-cash-movement']},
  personalSales:{title:'キャストの個人売上を調整',commands:['adjustPersonalSales'],actions:['personal-sales-adjustment']},
  staffing:{...groups.staffing,commands:[],actions:[]},
  editStaffing:{title:'シフト・勤怠の登録・承認',commands:groups.staffing.commands,
    actions:['shift-new','shift-edit','shift-remove','attendance-editor','attendance-review','attendance-break-add','attendance-break-remove',
      'attendance-staff-editor','attendance-staff-void']},
};
const managerOnly = new Set(['serviceHours','editOrders','discounts','voidTickets','editCustomers','editInventory',
  'registerCash','personalSales','staffing','editStaffing']);
export const isCustomRoleId = (value) => typeof value === 'string' && profileKey.test(value);
export const getCustomRole = (state,id) => isCustomRoleId(id) ? state?.rolePolicy?.custom?.[id] : undefined;

function customPermissionKeys(base) {
  return Object.keys(permissions).filter((key) => base === 'manager' || !managerOnly.has(key));
}

export function normalizeRolePolicy(value) {
  if (!isRecord(value) || Object.keys(value).some((role) => role !== 'custom' && !own(editableRoles,role))) {
    throw new Error('マネージャーとスタッフの役職設定を確認してください。');
  }
  const result = {};
  for (const [role, entry] of Object.entries(value)) {
    if (role === 'custom') continue;
    const label = typeof entry?.label === 'string' ? entry.label.trim().normalize('NFC') : '';
    if (!label || label.length > 24 || /[\p{Cc}\u2028\u2029]/u.test(label) || !Array.isArray(entry.disabled)
      || new Set(entry.disabled).size !== entry.disabled.length
      || entry.disabled.some((group) => !editableRoles[role].includes(group))) {
      throw new Error('役職名は24文字以内で、利用できる操作を選択してください。');
    }
    result[role] = {label,disabled:editableRoles[role].filter((group) => entry.disabled.includes(group))};
  }
  if (value.custom !== undefined) {
    if (!isRecord(value.custom) || Object.keys(value.custom).length > 24) throw new Error('カスタム役職は24件まで登録できます。');
    const normalized = {};
    const names = new Set(Object.entries(roleLabels).map(([id,label]) => (result[id]?.label ?? label).normalize('NFKC').toLowerCase()));
    for (const [id, entry] of Object.entries(value.custom)) {
      const label = typeof entry?.label === 'string' ? entry.label.trim().normalize('NFC') : '';
      if (!isCustomRoleId(id) || !own(editableRoles,entry?.base) || !label || label.length > 24
        || /[\p{Cc}\u2028\u2029]/u.test(label) || !Array.isArray(entry.allowed)
        || new Set(entry.allowed).size !== entry.allowed.length
        || entry.allowed.some((key) => !customPermissionKeys(entry.base).includes(key))) {
        throw new Error('カスタム役職の名前、基本役職、許可する操作を確認してください。');
      }
      const name = label.normalize('NFKC').toLowerCase();
      if (names.has(name)) throw new Error('役職名が重複しています。');
      names.add(name);
      normalized[id] = {label,base:entry.base,allowed:customPermissionKeys(entry.base).filter((key) => entry.allowed.includes(key))};
    }
    if (Object.keys(normalized).length) result.custom = normalized;
  }
  return result;
}

export function roleLabel(state, role, profileId) {
  return activeProfile(state,role,profileId)?.label ?? state?.rolePolicy?.[role]?.label ?? roleLabels[role] ?? '';
}

function activeProfile(state,role,profileId) {
  const profile = getCustomRole(state,profileId);
  return profile?.base === role && Array.isArray(profile.allowed) ? profile : null;
}

export function roleGroupAllowed(state, role, group, profileId) {
  return !state?.rolePolicy?.[role]?.disabled?.includes(group)
    && (!profileId || Boolean(activeProfile(state,role,profileId)?.allowed.includes(group)));
}

function roleAllows(state, role, kind, value, profileId) {
  const builtInAllowed = (state?.rolePolicy?.[role]?.disabled ?? []).every((group) => !groups[group]?.[kind]?.includes(value));
  if (!builtInAllowed || !profileId) return builtInAllowed;
  const profile = activeProfile(state,role,profileId);
  return Boolean(profile && Object.entries(permissions).every(([key,permission]) =>
    !permission[kind]?.includes(value) || profile.allowed.includes(key)));
}

export function roleAllowsCommand(state, role, command, profileId) {
  // The date makes the same print command a report operation on past dates.
  if (command.type === 'issuePrintDocument' && command.date !== state?.day?.date && !roleGroupAllowed(state,role,'reports',profileId)) {
    return false;
  }
  if (command.type === 'seat' && (command.customerId != null || command.companionCustomerIds?.length)
    && !roleGroupAllowed(state,role,'customers',profileId)) return false;
  if (command.type === 'settle' && Array.isArray(command.payments) && command.payments.some((payment)=>payment?.method === 'receivable')
    && !roleGroupAllowed(state,role,'customers',profileId)) return false;
  if (profileId && command.type !== 'syncAutoExtensions'
    && !Object.values(permissions).some(({commands}) => commands?.includes(command.type))) return false;
  return roleAllows(state,role,'commands',command.type,profileId);
}

export function roleAllowsAction(state, role, action, profileId) {
  return roleAllows(state,role,'actions',action,profileId)
    && (!action.startsWith('attendance-') && !action.startsWith('shift-') || roleGroupAllowed(state,role,'staffing',profileId));
}

export function roleAllowsPage(state, role, page, profileId) {
  return roleAllows(state,role,'pages',page,profileId);
}

export function renderRolePolicy(state, {escape}, draft = state.rolePolicy) {
  const staffViews = {reports:'ホールの売上表示',inventory:'注文時の在庫情報'};
  const settings = {rolePolicy:draft};
  const builtin = Object.entries(editableRoles).map(([role, keys]) => `<section class="payroll-edit-section">
    <label class="field"><span>${roleLabels[role]}の表示名</span><input type="text" maxlength="24" name="roleName-${role}" value="${escape(roleLabel(settings,role))}" required></label>
    <fieldset class="choices"><legend>許可する機能</legend>${keys.map((key) => {
      const group = groups[key];
      const display = role === 'staff' && staffViews[key];
      return `<label class="inline-check"><input type="checkbox" name="roleAllow-${role}" value="${key}"${roleGroupAllowed(settings,role,key) ? ' checked' : ''}>
        <span><strong>${display || group.title}</strong>${display ? '' : `<small class="field-help">　${group.detail}</small>`}</span></label>`;
    }).join('')}</fieldset>
  </section>`).join('');
  const custom = Object.entries(draft?.custom ?? {});
  return `<div class="np-role-settings">
    <section class="payroll-edit-section"><h3>カスタム役職</h3>
      <p class="field-help">基本役職の範囲で操作を選べます。保存後に「店舗・アカウント」で割り当ててください。</p>
      <div class="ops-actions"><button class="btn btn-secondary" type="button" data-action="role-custom-add" data-id="staff">スタッフを基に追加</button>
      <button class="btn btn-secondary" type="button" data-action="role-custom-add" data-id="manager">マネージャーを基に追加</button></div>
    </section>
    ${custom.map(([id,profile]) => `<details open class="payroll-edit-section" data-custom-role="${escape(id)}" data-base-role="${profile.base}">
      <summary>${escape(profile.label)} <small>／ ${roleLabels[profile.base]}を基に作成</small></summary>
      <label class="field"><span>役職名</span><input name="roleName-${escape(id)}" value="${escape(profile.label)}" maxlength="24" required></label>
      <fieldset class="choices"><legend>許可する操作・閲覧</legend>
      ${customPermissionKeys(profile.base).map((key) => `<label class="inline-check"><input type="checkbox" name="roleAllow-${escape(id)}"
        value="${key}"${profile.allowed.includes(key) ? ' checked' : ''}><span>${permissions[key].title}</span></label>`).join('')}</fieldset>
      <button type="button" class="btn btn-danger" data-action="role-custom-remove" data-id="${escape(id)}">この役職を削除</button>
    </details>`).join('')}
    <details open class="payroll-edit-section"><summary>基本役職の表示と権限</summary>${builtin}</details>
  </div>`;
}

export function readRolePolicy(form) {
  const data = new FormData(form);
  const result = Object.fromEntries(Object.entries(editableRoles).map(([role,keys]) => [role,{
    label:data.get('roleName-' + role),
    disabled:keys.filter((key) => !data.getAll('roleAllow-' + role).includes(key)),
  }]));
  result.custom = Object.fromEntries([...form.querySelectorAll('[data-custom-role]')].map(({dataset:{customRole,baseRole}}) => [customRole,{
    label:data.get('roleName-' + customRole),base:baseRole,allowed:data.getAll('roleAllow-' + customRole),
  }]));
  return result;
}
