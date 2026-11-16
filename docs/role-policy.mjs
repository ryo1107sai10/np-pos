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
    commands:['saveShift','removeShift','reviewCastAttendance','saveManagedAttendance'],
    actions:[], pages:['shifts','attendance'],
  },
};

const own = (object,key) => Object.hasOwn(object,key);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeRolePolicy(value) {
  if (!isRecord(value) || Object.keys(value).some((role) => !own(editableRoles,role))) {
    throw new Error('マネージャーとスタッフの役職設定を確認してください。');
  }
  const result = {};
  for (const [role, entry] of Object.entries(value)) {
    const label = typeof entry?.label === 'string' ? entry.label.trim().normalize('NFC') : '';
    if (!label || label.length > 24 || /[\p{Cc}\u2028\u2029]/u.test(label) || !Array.isArray(entry.disabled)
      || new Set(entry.disabled).size !== entry.disabled.length
      || entry.disabled.some((group) => !editableRoles[role].includes(group))) {
      throw new Error('役職名は24文字以内で、利用できる操作を選択してください。');
    }
    result[role] = {label,disabled:editableRoles[role].filter((group) => entry.disabled.includes(group))};
  }
  return result;
}

export function roleLabel(state, role) {
  return state?.rolePolicy?.[role]?.label ?? roleLabels[role] ?? '';
}

export function roleGroupAllowed(state, role, group) {
  return !state?.rolePolicy?.[role]?.disabled?.includes(group);
}

function roleAllows(state, role, kind, value) {
  return (state?.rolePolicy?.[role]?.disabled ?? []).every((group) => !groups[group]?.[kind]?.includes(value));
}

export function roleAllowsCommand(state, role, command) {
  // The date makes the same print command a report operation on past dates.
  if (command.type === 'issuePrintDocument' && command.date !== state?.day?.date && !roleGroupAllowed(state,role,'reports')) {
    return false;
  }
  if (command.type === 'seat' && command.customerId != null && !roleGroupAllowed(state,role,'customers')) return false;
  return roleAllows(state,role,'commands',command.type);
}

export function roleAllowsAction(state, role, action) {
  return roleAllows(state,role,'actions',action)
    && (!action.startsWith('attendance-') && !action.startsWith('shift-') || roleGroupAllowed(state,role,'staffing'));
}

export function roleAllowsPage(state, role, page) {
  return roleAllows(state,role,'pages',page);
}

export function renderRolePolicy(state, {escape}) {
  const staffViews = {reports:'ホールの売上表示',inventory:'注文時の在庫情報'};
  return `<p class="field-help">役職が持つ基本権限の範囲内で、操作や情報の表示を制限できます。</p>` + Object.entries(editableRoles).map(([role, keys]) => `<section class="payroll-edit-section">
    <label class="field"><span>${roleLabels[role]}の表示名</span><input type="text" maxlength="24" name="roleName-${role}" value="${escape(roleLabel(state,role))}" required></label>
    <fieldset class="choices"><legend>許可する機能</legend>${keys.map((key) => {
      const group = groups[key];
      const display = role === 'staff' && staffViews[key];
      return `<label class="inline-check"><input type="checkbox" name="roleAllow-${role}" value="${key}"${roleGroupAllowed(state,role,key) ? ' checked' : ''}>
        <span><strong>${display || group.title}</strong>${display ? '' : `<small class="field-help">　${group.detail}</small>`}</span></label>`;
    }).join('')}</fieldset>
  </section>`).join('');
}

export function readRolePolicy(form) {
  const data = new FormData(form);
  return Object.fromEntries(Object.entries(editableRoles).map(([role,keys]) => [role,{
    label:data.get('roleName-' + role),
    disabled:keys.filter((key) => !data.getAll('roleAllow-' + role).includes(key)),
  }]));
}
