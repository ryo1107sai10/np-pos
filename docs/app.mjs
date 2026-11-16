import { apply, businessDate, createDemo, discountReasonCodes, exportStoreConfiguration, getItemCommission, getLayoutAreas, getLayoutTables, getManagerDiscountLimit, getOverdueExtensionCount, getTableLabel, getTicketForTable, getTicketTableLabels, maxOverdueExtensionCount, parseStoreConfiguration, quote, summary, tableStatus, yen } from './engine.mjs';
import { icon } from './icons.mjs';
import { previewSettledContents } from './engine.mjs';
import { readSettledContents, renderSettledContents } from './settled-edit-ui.mjs';
import { renderReport } from './reports.mjs';
import { getAutoExtensionNotices, getAutoExtensionPlans, getAutoExtensionSettings, getAutomaticExtensionPlan,
  getNextAutoExtensionAt, getTableAutoExtensionEnabled, getTicketAutoExtensionAt, isVisitAutoExtensionPaused } from './auto-extension.mjs';
import { formatAutoExtensionCountdown, renderAutoExtensionBadge, renderAutoExtensionWarnings, renderTableAutoExtensionControl,
  renderTableAutoExtensionSettings, renderVisitAutoExtensionPaused } from './auto-extension-ui.mjs';
import { canWaivePaymentFee, depositGrossAmount, getCardFee, getCardFeeSettings, getDepositPaymentTerms } from './card-fee.mjs';
import { getSettlementPaymentFees } from './engine.mjs';
import { getMonthlyReportSales, getReportDates, getReportPeriod } from './report-period.mjs';
import { buildDailyReportCsv } from './report-export.mjs';
import { buildFreeeCsv } from './freee-export.mjs';
import { accountingCsvColumns, accountingCsvEditor, accountingCsvPreview, buildCustomAccountingCsv, readAccountingCsvEditor } from './accounting-csv.mjs';
import { bindLayoutEditor, commitLayoutFields, floorLayoutStage, handleLayoutEditorAction, layoutAreaTabs, newLayoutDraft, renderLayoutEditor } from './floor-layout.mjs';
import { renderLayoutTransfer } from './layout-transfer.mjs';
import { catalogDeletionBlocker, getOrderCategories, getStoreSettings, stockDeletionBlocker } from './store-settings.mjs';
import { commitStoreSettingsEditor, handleStoreSettingsEditorAction, renderStoreSettingsEditor } from './store-settings-editor.mjs';
import { openBarcodeScanner } from './barcode-scanner.mjs';
import { cloudConfig } from './cloud-config.mjs';
import { createCloudClient } from './cloud-client.mjs';
import { renderCloudBanner, renderCloudEntry, renderCloudMigration, renderCloudPanel, renderCloudRestricted, renderStoreOverview } from './cloud-ui.mjs';
import { createStoreGroupDemo } from './store-group-demo.mjs';
import { renderStoreGroups } from './store-group-ui.mjs';
import { customerAnniversaryLimit, findCustomer, findSettledCustomerTicket, getCustomerDetail, isAssignedCustomer, parseCustomersCsv } from './customers.mjs';
import { ticketHasReceivable } from './receivables.mjs';
import { cashMovementCategories, cashMovementKinds, editableCashMovement } from './cash-ledger.mjs';
import { cashAccountOptions, readCashAccounts, renderCashAccountRow, renderCashAccounts, vaultBalance } from './cash-accounts.mjs';
import { purchaseCancellationBlocker } from './inventory-operations.mjs';
import { findPrintableTicket, getPrintAutoKind, getPrintDocuments, getPrintSettings, getPrintTenderReceived } from './print-domain.mjs';
import { printDocumentTitles, renderExtensionQuote, renderPrintOptions, renderPrintPreview, renderPrintSettings } from './print-ui.mjs';
import { createBillingDemo, createCashDemo, createCustomerNoticeDemo, createLaborDemo, createPayrollDemo, createPhaseTwoDemo, createPeriodReportDemo, createVisitAnalyticsDemo } from './phase-two-demo.mjs';
import * as customerUI from './customer-ui.mjs';
import { operationReason, renderAuditLog, renderDiscountForm, renderPersonalSalesAdjustment } from './operations-ui.mjs';
import { getAdjustablePersonalSalesPeople, personalSalesDiscountModes } from './personal-sales.mjs';
import { getOperationsGuideTopic, getPracticeStatus, renderGuideResults, renderPracticeProgress } from './practice-guide.mjs';
import { paymentCorrectionModel, readPaymentCorrection, renderPaymentCorrection, updatePaymentCorrection } from './payment-correction-ui.mjs';
import { calculateCashTender, cashDenominations, cashEntryMaximum, getCashCountTotal, getCashPaymentAmount } from './register-cash.mjs';
import { getRegisterSettings, openingCashSuggestion, operationBusinessDate, registerCutoff } from './register-config.mjs';
import { renderWorkspaceMenu } from './workspace-menu.mjs';
import { getCustomRole, readRolePolicy, renderRolePolicy, roleAllowsAction, roleAllowsPage, roleGroupAllowed, roleLabel } from './role-policy.mjs';
import { renderAnalytics, buildAnalyticsCsv } from './analytics.mjs';
import { getDailyPayLimit, getPayrollDailyPays, getPayrollDraft, getPayrollRangeStatements, getPayrollTemplates, isPayrollMonth, MissingPayrollRateError,
  previewPayroll, previewPayrollRange } from './payroll.mjs';
import * as payrollUI from './payroll-ui.mjs';
import { getPayrollVariables } from './payroll-formula.mjs';
import { renderTicketHistory, bindTicketHistory } from './ticket-history.mjs';
import { readShiftForm, renderShiftEditor, renderShifts } from './shifts-ui.mjs';
import { buildTeamPerformanceCsv, renderTeamPerformance } from './team-performance.mjs';
import { getStaffLabor } from './labor-workspace.mjs';
import { buildLaborCsv, getLaborReport } from './labor-report.mjs';
import { renderLaborHighlights, renderLaborReport, renderStaffAttendance, renderStaffAttendanceForm,
  renderStaffPersonForm, renderStaffRateForm } from './labor-ui.mjs';
import { getAvailableInitialSets, suggestInitialSet } from './set-schedule.mjs';
import { getCastWorkspace, listCastAttendance } from './cast-self.mjs';
import { readManagedAttendance, renderCastAttendance, renderCastShiftRequest, renderCastWorkspace, renderManagedAttendance, renderManagedBreakRow } from './cast-self-ui.mjs';
import { canExcludeOrderService, getCalculationSettings } from './calculation-settings.mjs';
import { handleInitialSetScheduleClick, readInitialSetSchedule, renderInitialSetSchedule } from './set-schedule-ui.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const workspaceMenu = document.querySelector('#workspace-menu');
const notifications = document.querySelector('#notifications');
const autoExtensionLive = document.querySelector('#auto-extension-live');
const printOutput = document.querySelector('#print-output');
const storageKey = 'np-pos.demo.v1';
const legacyStorageKey = 'lumi-pos.demo.v1';
const floorViewStorageKey = 'np-pos.floor-view.v1';
const cloudWorkspaceKey = 'np-pos.cloud-workspace.v1';
const pages = {
  'cast-workspace': {title:'マイページ',icon:'user',group:'スタッフ管理',roles:['cast'],help:'打刻、勤務希望、日払い、自分の支給明細'},
  floor: { title: 'ホール', icon: 'grid', group:'営業', help: '席を選んで、来店・注文・延長・会計を操作できます。' },
  commission: { title: '歩合・成績', icon: 'users', group:'スタッフ管理', help: 'キャストごとの歩合を、確定額と見込額で確認できます。' },
  stock: { title: '在庫', icon: 'box', group:'営業', help: 'メニューの注文に連動した在庫と、品目の増減履歴。' },
  reports: { title: '日報', icon: 'chart', group:'分析・レポート', help: '営業日ごとの売上、入出金、レジ締めを確認できます。' },
  tickets: { title: '伝票履歴', icon: 'ticket', group:'分析・レポート', help: '決済方法や期間で会計済み伝票・取消履歴を確認できます。' },
  analytics: { title: '経営分析', icon: 'trend', group:'分析・レポート', help: '期間ごとの売上、来店、決済、歩合を確認できます。' },
  'product-sales': { title: '商品別売上', icon: 'box', group:'分析・レポート', help: '商品ごとの販売数量と売上を確認できます。' },
  payroll: { title: '給与・支給明細', icon: 'wallet', group:'スタッフ管理', roles:['admin'], help: '出勤、手当・控除、支給明細を管理できます。' },
  shifts: { title: 'シフト', icon: 'calendar', group:'スタッフ管理', help: '勤務希望と確定シフトを日・週・月で確認できます。' },
  attendance: {title:'勤怠',icon:'clock',group:'スタッフ管理',help:'役職別の出退勤を記録し、キャストの打刻を確認します。'},
  labor: {title:'勤怠・人件費',icon:'users',group:'分析・レポート',roles:['admin'],help:'役職・勤務者ごとに出勤者数、勤務時間、人件費を集計できます。'},
  'team-performance': { title: 'スタッフ成績', icon: 'users', group:'分析・レポート', roles:['admin'], help: 'マネージャーとスタッフが確定した会計を確認できます。' },
  cash: { title: '入出金管理', icon: 'cash', group:'顧客・資金', help: '営業中に出し入れした現金を確認できます。' },
  customers: { title: '顧客管理', icon: 'users', group:'顧客・資金', help: '登録情報と来店・指名履歴を確認できます。' },
};
const quickPages = ['floor','commission','stock','reports','cast-workspace'];
const statuses = {
  available: '空席', active: '利用中', soon: '終了間近', overtime: '時間超過', paid: '会計済',
};
const tenderMethods = { cash: '現金', card: 'カード', qr: 'QR決済' };
const orderCategoryNames = () => ['よく使う',...getOrderCategories(state)];
const dateTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const prettyDate = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' });
const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 6 });
const ownerActions = new Set(['store-settings', 'stock-settings', 'edit-layout', 'layout-transfer', 'layout-export',
  'discount-review', 'discount-reject', 'cancel-settlement', 'reopen-ticket', 'audit-log', 'audit-more', 'ops-settings', 'print-settings', 'billing-settings', 'billing-settings-tab', 'calculation-settings', 'customer-merge', 'customer-link', 'customer-import', 'settled-ticket-customer', 'settled-ticket-payment', 'set-schedule',
  'accounting-settings', 'accounting-add-column', 'accounting-remove-column','correct-register-count','role-policy',
  'cash-accounts','cash-account-add','cash-account-remove-new','settled-ticket-companions','demo-backup','demo-backup-download']);
const managerActions = new Set(['open', 'close', 'stock-adjust', 'stocktake', 'discount', 'cancel-line', 'cancel-deposit', 'customer-detail', 'customer-new', 'customer-edit', 'customer-visit',
  'record-cash', 'report-mode', 'report-day', 'report-export', 'ticket-end', 'ticket-set-time', 'ticket-guests',
  'edit-ticket-line', 'cancel-ticket-extension', 'ops-notices','edit-cash-movement','void-cash-movement','edit-deposit','personal-sales-adjustment']);
const cloudLabels = { admin: '店舗管理者', manager: 'マネージャー', staff: 'スタッフ', cast: 'キャスト', trainee: '体入' };
let demoProfileId;

let cloudState;
let demoRole = 'admin';
let demoPractice = null;
const castNoticesSeen = new Map();
let state = loadState();
let stockSearch = '';
let stockBarcodeExact = false;
let activeBarcodeScan;
let stockLowOnly = false;
let stockHistoryId = '';
let page = readPage();
let selected = state.tables.find((table) => getTicketForTable(state, table.id))?.id ?? null;
let area = null;
let { view: floorView, area: planArea } = loadFloorView();
let filter = 'all';
let showHiddenStock = false;
let reportDate = '';
let reportInterval = {mode:'day'};
let analyticsRange = {};
let payrollMonth = '';
let payrollCastId = '';
let teamRange = {};
let laborRange = {};
let teamRole = 'all';
let shiftDate = '';
let shiftMode = 'week';
let reportExportError = '';
let commissionCast = '';
let customersQuery = '';
let customerFilters = {};
let mobileDetails = false;
let workspaceMenuContent = '';
let modal = null;
let priorFocus = null;
let lastStatuses = '';
let lastAutoExtensionNotices = '';
let pendingVisitAutoExtensionTicket = null;
const announcedAutoExtensions = new Map();
let lastMinute = '';
let saveAvailable = true;
let pendingStorage = false;
let committing = false;
let syncingLocalExtensions = false;
let cloudMembers = { members: [], invites: [] };
let cloudBusy = false;
let cloudMessage = '';
let cloudActionError = '';
const cloud = createCloudClient(cloudConfig, { onChange: cloudUpdated, pollMs: 6000 });
cloudState = cloud.snapshot;

function escape(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function readSavedState() {
  if (demoPractice) return null;
  return localStorage.getItem(storageKey) ?? localStorage.getItem(legacyStorageKey);
}

function loadState() {
  return loadLocalData() ?? createPhaseTwoDemo();
}

function loadLocalData() {
  try {
    const stored = JSON.parse(readSavedState());
    if (stored?.day && Array.isArray(stored.tables) && Array.isArray(stored.tickets) && Array.isArray(stored.menu)) return stored;
  } catch { /* A fresh sample is available when storage is blocked. */ }
  return null;
}

function saveState(next) {
  state = next;
  if (demoPractice) return;
  try { localStorage.setItem(storageKey, JSON.stringify(state)); }
  catch { saveAvailable = false; }
}

function loadFloorView() {
  const areas = getLayoutAreas(state);
  try {
    const preference = JSON.parse(localStorage.getItem(floorViewStorageKey));
    if (preference?.view === 'plan') {
      return { view: 'plan', area: areas.includes(preference.area) ? preference.area : (areas[0] ?? null) };
    }
  } catch { /* The list is available when storage is blocked. */ }
  return { view: 'list', area: areas[0] ?? null };
}

function setFloorView(view, nextArea = planArea) {
  floorView = view;
  planArea = nextArea;
  if (cloudState?.store || demoPractice) return;
  try { localStorage.setItem(floorViewStorageKey, JSON.stringify({ view, area: planArea })); }
  catch { /* The current view remains available in memory. */ }
}

function revealTable(id) {
  selected = id;
  const table = state.tables.find((entry) => entry.id === id);
  if (floorView === 'plan' && table) setFloorView('plan', table.area);
}

function selectVisibleTicket() {
  if (!state.tables.some((table) => table.id === selected && table.area === planArea)) {
    selected = state.tables.find((table) => table.area === planArea && getTicketForTable(state,table.id))?.id ?? null;
  }
}

function syncFloorSelection() {
  const areas = getLayoutAreas(state);
  if (area !== null && !areas.includes(area)) area = null;
  if (!areas.includes(planArea)) {
    const selectedTable = state.tables.find((table) => table.id === selected);
    const fallback = selectedTable?.area ?? areas[0] ?? null;
    if (planArea !== fallback) setFloorView(floorView, fallback);
  }
  if (floorView === 'plan') selectVisibleTicket();
  else if (selected && !state.tables.some((table) => table.id === selected)) selected = null;
}

function readPage() {
  const key = window.location.hash.slice(1);
  return canOpenPage(key) ? key : defaultPage();
}

function defaultPage() { return currentRole() === 'cast' ? 'cast-workspace' : 'floor'; }

function go(key) {
  if (!canOpenPage(key)) return;
  page = key;
  if (window.location.hash !== `#${key}`) history.replaceState(null, '', `#${key}`);
  window.scrollTo(0, 0);
  render();
}

function timer(endsAt, now = Date.now()) {
  const seconds = Math.floor(Math.abs(endsAt - now) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function canOpenPage(key) {
  const role = currentRole();
  return Object.hasOwn(pages,key) && roleAllowsPage(state,role,key,currentProfileId())
    && (key === 'floor' ? role !== 'cast' : (pages[key].roles ?? ['admin','manager']).includes(role));
}

function currentRole() {
  return cloudState?.store?.role ?? demoRole;
}

function currentProfileId() {
  if (cloudState?.store) return cloudState.store.profileId;
  return !demoPractice && getCustomRole(state,demoProfileId)?.base === demoRole ? demoProfileId : undefined;
}

function currentRoleLabel() {
  return roleLabel(state,currentRole(),currentProfileId());
}

function currentRoleAllows(group) {
  return roleGroupAllowed(state,currentRole(),group,currentProfileId());
}

function demoActor() {
  const profileId = currentProfileId();
  return { id: `demo-${profileId ?? demoRole}`, label: `デモの${currentRoleLabel()}`, role: demoRole, ...(profileId && {profileId}) };
}

function permittedAction(action) {
  const store = cloudState.store;
  if (action.startsWith('practice-')) return !store;
  if (demoPractice && (action.startsWith('cloud-') || action.startsWith('demo-'))) return false;
  if (store && (!cloudState.state || !store.hasState)) return action === 'dismiss' || action.startsWith('cloud-');
  const role = currentRole();
  if (!roleAllowsAction(state,role,action,currentProfileId())) return false;
  if (role === 'cast') return ['dismiss','navigate','ops-guide','ops-guide-explain'].includes(action) || action.startsWith('cast-') || action.startsWith('cloud-')
    || (!store && ['demo','demo-role'].includes(action));
  if (action.startsWith('cast-')) return false;
  if (action.startsWith('attendance-')) return canOpenPage('attendance');
  if (store && action.startsWith('demo')) return false;
  if (action.startsWith('payroll-')) return role === 'admin';
  if (action.startsWith('labor-')) return role === 'admin';
  if (action.startsWith('shift-')) return canOpenPage('shifts');
  if (ownerActions.has(action) || action.startsWith('role-custom-') || action.startsWith('store-editor-') || action.startsWith('layout-editor-')
    || action.startsWith('payment-brand-')) return role === 'admin';
  if (managerActions.has(action)) return role === 'admin' || role === 'manager';
  if (['table-auto-extension','auto-extension-pause','auto-extension-checkout','auto-extension-resume','ticket-customer','ticket-note','extend-overdue'].includes(action)) {
    return ['admin','manager','staff'].includes(role);
  }
  return true;
}

function button(text, action, { glyph, tone = '', cls = '', id, data = '', disabled = false } = {}) {
  if (!permittedAction(action)) return '';
  return `<button type="button" class="btn ${tone ? `btn-${tone}` : ''} ${cls}" data-action="${action}"${id === undefined ? '' : ` data-id="${escape(id)}"`} ${data}${disabled ? ' disabled' : ''}>${glyph ? icon(glyph, 16) : ''}${text}</button>`;
}

function pill(status, label = statuses[status]) {
  return `<span class="pill pill-${status}"><span class="dot"></span>${label}</span>`;
}

function tableName(id) {
  return getTableLabel(state, id);
}

function staffName(id) {
  return state.cast.find((person) => person.id === id)?.name
    ?? state.archivedCast?.find((person) => person.id === id)?.name ?? id;
}

function lineStaffNames(line) {
  return (line.castIds ?? []).map((id, index) => line.castNames?.[index] ?? staffName(id)).map(escape).join('・');
}

function tokyoDateTimeValue(at) {
  return new Date(at + 9 * 60 * 60_000).toISOString().slice(0,16);
}

function parseTokyoDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return NaN;
  const at = Date.parse(`${value}:00+09:00`);
  return Number.isFinite(at) && tokyoDateTimeValue(at) === value ? at : NaN;
}

function ticketAuditButton(ticket, date) {
  return currentRole() === 'admin' ? button('操作履歴','audit-log',{glyph:'history',tone:'quiet',id:ticket.id,
    data:`data-ticket-audit="true" data-date="${escape(date)}"`}) : '';
}

function renderTicketLineControls(ticket, line) {
  if (ticket.status !== 'open') return '';
  const attrs = `data-ticket="${escape(ticket.id)}"`;
  if (line.category === '延長') return line.menuId === 'nominationExtra' ? '' : button('延長取消','cancel-ticket-extension',
    {id:line.id,data:attrs,tone:'quiet',cls:'ticket-line-action'});
  return `${button('訂正','edit-ticket-line',{id:line.id,data:`${attrs} aria-label="${escape(line.name)}を訂正"`,tone:'quiet',cls:'ticket-line-action'})}
    ${permittedAction('cancel-line') && line.category !== 'セット' ? `<button class="line-remove" type="button" data-action="cancel-line" data-id="${escape(line.id)}" ${attrs} aria-label="${escape(line.name)}を取り消す">${icon('x',13)}</button>` : ''}`;
}

function extensionPlans(source = state) {
  return source.menu.filter((item) => item.enabled !== false && item.category === '延長' && item.duration);
}

function titles(ticket) {
  return ticket.tableIds.map(tableName).join('・');
}

function renderSide() {
  const store = cloudState.store;
  const workspaceName = store?.name ?? '銀座店';
  const role = currentRoleLabel();
  return `<aside class="sidebar">
    <div class="brand" aria-label="NP POS"><img src="np-pos.svg" alt="" width="38" height="38"><span class="brand-word">NP <small>POS</small></span></div>
    <div class="store"><span class="store-icon">${icon('store', 16)}</span><span class="store-name">${escape(workspaceName)}<small>${store ? 'クラウド店舗' : 'デモ店舗'}</small></span></div>
    <nav class="side-nav" aria-label="メインメニュー">
      ${hasWorkspace() ? quickPages.filter(canOpenPage).map((key) => `<button type="button" class="nav-link" data-action="navigate" data-id="${key}" ${page === key ? 'aria-current="page"' : ''}>${icon(pages[key].icon, 18)}<span>${pages[key].title}</span></button>`).join('') : ''}
    </nav>
    <div class="side-bottom">
      ${store ? '' : `<button type="button" class="demo-button" data-action="demo" aria-label="サンプル操作" title="サンプル操作">${icon('refresh', 16)}<span>サンプル操作</span>${icon('chevron-right', 14)}</button>`}
      <div class="operator"><span class="avatar">店</span><div><strong>${escape(role)}</strong><small>${store ? 'クラウドモード' : 'デモモード'}</small></div></div>
    </div>
  </aside>`;
}

function hasWorkspace() {
  return !cloudState.store || Boolean(cloudState.store.hasState && cloudState.state);
}

function renderWorkspaceMenuTrigger() {
  return `<button id="workspace-menu-toggle" type="button" class="workspace-menu-trigger" data-action="open-workspace-menu" aria-label="メニューを開く"
    aria-expanded="${workspaceMenu.open}" aria-haspopup="dialog" aria-controls="workspace-menu">${icon('menu',20)}<span class="workspace-menu-trigger-label">メニュー</span></button>`;
}

function refreshWorkspaceMenu() {
  const active = workspaceMenu.contains(document.activeElement) ? document.activeElement.dataset : {};
  const control = app.querySelector('#workspace-menu-toggle');
  control?.setAttribute('aria-expanded',String(workspaceMenu.open));
  const content = renderWorkspaceMenu({pages,page,ready:hasWorkspace(),isOpen:state.day.status==='open',hasTables:state.tables.length>0,
    storeName:cloudState.store?.name ?? '銀座店',role:currentRoleLabel(),cloud:Boolean(cloudState.store),
    showOverview:cloudState.userVerified && cloudState.stores.some(({role})=>role==='admin')},
    {escape,icon,canOpenPage,permittedAction});
  if (workspaceMenuContent === content) return;
  const scroll = workspaceMenu.querySelector('.workspace-menu-nav')?.scrollTop ?? 0;
  workspaceMenuContent = content;
  workspaceMenu.innerHTML = content;
  workspaceMenu.querySelector('.workspace-menu-nav').scrollTop = scroll;
  if (active.action) {
    const equivalent = [...workspaceMenu.querySelectorAll('[data-action]')].find((el) => el.dataset.action===active.action && el.dataset.id===active.id);
    (equivalent ?? workspaceMenu.querySelector('.workspace-menu-close')).focus({preventScroll:true});
  }
}

function renderTop() {
  const isOpen = state.day.status === 'open';
  const dailyView = page === 'cash' || (page === 'reports' && reportInterval.mode === 'day');
  const activeReport = dailyView && (!reportDate || reportDate === state.day.date);
  const date = prettyDate.format(new Date(`${state.day.date}T12:00:00+09:00`));
  return `<div class="workspace-top"><div class="workspace-top-leading">${renderWorkspaceMenuTrigger()}<div class="open-meta"><span class="workspace-store">${icon('store',15)}<span class="store-label">${escape(cloudState.store?.name ?? '銀座店')}</span><span class="mobile-wordmark"><img src="np-pos.svg" width="20" height="20" alt="">NP POS</span></span><span class="meta-sep"></span>${icon('calendar',16)}<span>${date} 営業日</span></div></div><div class="workspace-time"><span class="live ${isOpen ? '' : 'closed'}"><span class="dot"></span>${isOpen ? '営業中' : '営業時間外'}</span><span class="meta-sep"></span><time id="workspace-time">${dateTime.format(Date.now())}</time><span>JST</span></div></div>
    <header class="page-head"><div><h1>${pages[page].title}</h1><p>${pages[page].help}</p></div><div class="actions">
    ${page === 'floor' ? (isOpen ? button('閉店処理','close',{ glyph: 'checkout' }) + button('来店登録','seat',{ glyph: 'plus', tone: 'primary', disabled: state.tables.length === 0 }) : button('開店する','open',{ glyph: 'power', tone: 'primary' })) : ''}
    ${isOpen && activeReport ? button('閉店処理','close',{glyph:'checkout'}) : ''}
    ${page === 'stock' ? button('品目設定', 'stock-settings', { glyph: 'settings' }) : ''}${demoPractice ? '' : renderCloudEntry(cloudModel(), {escape, icon})}</div></header>`;
}

function renderMetrics() {
  const totals = summary(state);
  const month = state.day.date.slice(0,7);
  const monthlySales = state.floorMonthSales ?? getMonthlyReportSales(state,month,totals);
  const [year,monthNumber] = month.split('-').map(Number);
  const soon = state.tables.filter((table) => ['soon','overtime'].includes(tableStatus(state,table.id))).length;
  const active = new Set(state.tickets.filter((ticket) => ticket.status === 'open').map((ticket) => ticket.id)).size;
  const figures = [
    ...(currentRoleAllows('reports') ? [
      ['calendar', '月間売上', yen(monthlySales), `${year}年${monthNumber}月 · 確定売上`, 'blue'],
      ['trend','営業売上',yen(totals.sales), `会計済み ${totals.tickets}組`, 'green'],
    ] : []),
    ['clock','終了間近・超過', `${soon} <small>卓</small>`, '残り10分以下を表示', 'amber'],
    ['ticket','未会計の伝票', `${active} <small>件</small>`, `退店待ち ${totals.paidTickets ?? 0}組`, 'blue'],
  ];
  return `<section aria-label="営業状況" class="metrics">${figures.map(([glyph,label,value,hint,tone]) => `<article class="metric"><span class="metric-icon ${tone}">${icon(glyph, 19)}</span><div><div class="metric-title">${label}</div><div class="metric-value numeric">${value}</div><div class="metric-hint">${hint}</div></div></article>`).join('')}</section>`;
}

function autoNoticesKey(notices) {
  return notices.map(({ticketId,deadline}) => `${ticketId}:${deadline}`).join('|');
}

function announceAutoExtensionNotices(notices, now) {
  if (!autoExtensionLive) return;
  for (const [key,deadline] of announcedAutoExtensions) {
    if (deadline <= now) announcedAutoExtensions.delete(key);
  }
  const newLabels = [];
  for (const {ticketId,tableIds,deadline} of notices) {
    const key = `${ticketId}:${deadline}`;
    if (announcedAutoExtensions.has(key)) continue;
    announcedAutoExtensions.set(key,deadline);
    newLabels.push(tableIds.map(tableName).join('・'));
  }
  if (newLabels.length) autoExtensionLive.textContent = `${newLabels.join('、')}は1分以内に自動延長されます。`;
  else if (!notices.length) autoExtensionLive.textContent = '';
}

function renderTable(table, warning = false) {
  const ticket = getTicketForTable(state, table.id);
  const status = tableStatus(state, table.id);
  const isSelected = table.id === selected;
  const name = escape(table.name);
  const paused = ticket?.status === 'open' && isVisitAutoExtensionPaused(ticket);
  const autoMode = paused ? 'paused' : !getTableAutoExtensionEnabled(state,table.id) ? 'off' : warning ? 'soon' : null;
  const autoLabel = { paused:' 今回の自動延長は停止中', off:' 自動延長オフ', soon:' まもなく自動延長' }[autoMode] ?? '';
  const canSeat = permittedAction('seat');
  return `<button type="button" class="seat seat-${status}${isSelected ? ' is-selected' : ''}" data-action="table" data-id="${escape(table.id)}" aria-pressed="${isSelected}" aria-label="${name} ${statuses[status]}${ticket?.tableIds.length > 1 ? ' 複数卓' : ''} 定員${table.capacity}名 ${escape(table.area)}${autoLabel}"${!ticket && !canSeat ? ' disabled' : ''}>
    <div class="seat-top"><span><span class="seat-name" title="${name}">${name}</span><span class="seat-area" title="${escape(table.area)}">${escape(table.area)}${ticket?.tableIds.length > 1 ? ` <span class="seat-linked">· ${ticket.tableIds.length}卓共有</span>` : ''}</span></span>${pill(status)}</div>
    <div class="seat-timer">${icon(ticket ? (status === 'paid' ? 'check' : 'clock') : canSeat ? 'plus' : 'table',14)}${ticket ? status === 'paid' ? '退店待ち' : `<time data-ends="${ticket.endsAt}">${timer(ticket.endsAt)}</time>` : canSeat ? '来店登録' : '空席'}${autoMode ? renderAutoExtensionBadge(autoMode,{icon}) : ''}</div>
    <div class="seat-bottom"><span class="seat-guests">${icon('users',13)}${ticket ? `${ticket.guests}名` : `定員${table.capacity}名`}</span>
    ${ticket ? `<span class="seat-price money">${yen(quote(state,ticket.id).total)}</span>` : `<span class="available-price">${icon('arrow-right',14)}</span>`}</div>
  </button>`;
}

function renderFloor(notices, now) {
  const warnedTables = new Set(notices.flatMap(({tableIds}) => tableIds));
  const renderSeat = (table) => renderTable(table,warnedTables.has(table.id));
  const isOpen = state.day.status === 'open';
  const showingPlan = floorView === 'plan';
  const areas = getLayoutAreas(state);
  const activeArea = showingPlan ? planArea : area;
  const range = (showingPlan ? getLayoutTables(state) : state.tables)
    .filter((table) => activeArea === null || activeArea === table.area);
  const counts = { all: range.length, used: 0, available: 0, urgent: 0 };
  const visible = range.filter((table) => {
    const status = tableStatus(state, table.id);
    counts[status === 'available' ? 'available' : 'used']++;
    if (status === 'soon' || status === 'overtime') counts.urgent++;
    return filter === 'all' || (filter === 'used' && status !== 'available') || filter === status || (filter === 'urgent' && ['soon','overtime'].includes(status));
  });
  const viewSwitch = `<div class="floor-view-switch" role="group" aria-label="ホールの表示形式">
    <button type="button" data-action="floor-view" data-id="list" aria-pressed="${!showingPlan}">一覧</button>
    <button type="button" data-action="floor-view" data-id="plan" aria-pressed="${showingPlan}">レイアウト</button></div>`;
  const areaPicker = areas.length === 0 ? '' : showingPlan ? layoutAreaTabs(planArea, 'layout-view-area', escape, areas)
    : `<label class="area-filter" title="エリア">${icon('filter', 16)}<select id="area-filter" aria-label="エリアで絞り込む"><option value="">全エリア</option>${areas.map((name) => `<option value="${escape(name)}" ${area === name ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select></label>`;
  const emptyFloor = areas.length === 0 ? '「レイアウト編集」からフロア・エリアを追加できます。'
    : state.tables.length === 0 ? '「レイアウト編集」から卓を追加できます。' : '該当する卓はありません。';
  const emptyState = `<p class="empty-grid">${emptyFloor}</p>`;
  const planHint = visible.length ? `<p class="hall-plan-hint">${icon('move', 14)}図面を左右にスワイプできます</p>` : '';
  const floorContent = areas.length === 0 ? emptyState
    : showingPlan ? planHint + floorLayoutStage(visible, planArea, { renderSeat, escape })
    : `<div class="table-grid">${visible.length ? visible.map(renderSeat).join('') : emptyState}</div>`;
  return `${!isOpen ? `<div class="notice"><span>${icon('info',17)}開店すると、空席から来店を登録できます。</span></div>` : ''}${renderAutoExtensionWarnings(notices,now,{
    escape,icon,tableName, pendingTicketId:pendingVisitAutoExtensionTicket,
    canCheckout:(id) => !state.tickets.find((ticket) => ticket.id === id)?.discountRequest,
    showPause:permittedAction('auto-extension-pause'),showCheckout:permittedAction('auto-extension-checkout'),
  })}${renderMetrics()}
    <div class="floor-layout">
      <section class="floor" aria-labelledby="floor-title"><div class="floor-heading">
      <div class="floor-heading-main"><h2 id="floor-title">${icon('grid',17)}${showingPlan ? '店内レイアウト' : '座席一覧'}</h2>${viewSwitch}</div>
      <div class="floor-heading-actions">${button('レイアウト編集', 'edit-layout', { glyph: 'move' })}${button('店舗設定', 'store-settings', { glyph: 'settings' })}${button('設定の移行', 'layout-transfer', { glyph: 'download' })}${button('延長・カード設定','billing-settings',{glyph:'settings'})}</div></div>
      ${areas.length ? `<div class="seating-toolbar glass${showingPlan ? ' seating-plan-toolbar' : ''}"><div class="seg" role="group" aria-label="卓の状態で絞り込む">${[['all','すべて'],['used','使用中'],['available','空席'],['urgent','要対応']].map(([key,text])=>`<button type="button" data-action="filter" data-id="${key}" aria-pressed="${key===filter}">${text}<small>${counts[key]}</small></button>`).join('')}</div>${areaPicker}</div>` : ''}
      ${floorContent}</section>
      ${mobileDetails ? `<button type="button" class="detail-shade" data-action="hide-detail" aria-hidden="true" tabindex="-1"></button>` : ''}${renderDetail(notices,now)}
    </div>`;
}

function totalRows(q, { settlement = false, large = false } = {}) {
  const tax = q.priceMode === 'inclusive' ? 'うち消費税' : '消費税';
  const taxLabel = q.cardFee ? `${tax}（加算前）` : q.taxBreakdown.length === 1 ? `${tax}（${q.taxBreakdown[0].rate / 100}%）` : tax;
  const settlementFee = (q.cardFee ?? 0) - (q.depositFee ?? 0);
  return `<dl class="totals ${large ? 'totals-large' : ''}">
    <div><dt>小計</dt><dd class="money">${yen(q.subtotal)}</dd></div>
    ${q.discount ? `<div><dt>値引き</dt><dd class="money">−${yen(q.discount)}</dd></div>` : ''}
    <div><dt>サービス料</dt><dd class="money">${yen(q.service)}</dd></div>
    <div><dt>${taxLabel}</dt><dd class="money">${yen(q.tax - (q.cardFeeTax ?? 0))}</dd></div>
    ${q.depositFee ? `<div><dt>前受金の決済加算（税込）</dt><dd class="money">${yen(q.depositFee)}</dd></div>` : ''}
    ${settlementFee ? `<div><dt>${q.brandedFee ? '決済加算（税込）' : 'カード会計加算（税込）'}</dt><dd class="money">${yen(settlementFee)}</dd></div>` : ''}
    ${large && q.taxBreakdown.length > 1 ? q.taxBreakdown.map((tax) => `<div><dt>税率 ${tax.rate / 100}%</dt><dd>${yen(tax.tax)}</dd></div>`).join('') : ''}
    <div class="total"><dt>${settlement ? '合計' : '合計（税込）'}</dt><dd class="money">${yen(q.total)}</dd></div>
    ${q.deposit ? `<div><dt>${q.depositFee ? '受領済みの前受金' : '前受金'}</dt><dd class="money">−${yen(q.deposit)}</dd></div>` : ''}
    ${settlement && q.paid ? `<div><dt>会計時のお支払い</dt><dd class="money">${yen(q.paid)}</dd></div>` : ''}
    ${(!settlement && (large || q.deposit)) ? `<div class="balance"><dt>未収額</dt><dd class="money">${yen(q.remaining)}</dd></div>` : ''}
  </dl>`;
}

function receiptBody(ticket, totals) {
  const lines = ticket.lines.filter((line) => line.cancelledAt == null);
  const payments = [...ticket.deposits.map((deposit) => ({...deposit,amount:depositGrossAmount(deposit),isDeposit:true})),
    ...ticket.payments].filter(({method}) => Object.hasOwn(tenderMethods,method));
  const customer = canOpenPage('customers') && findCustomer(customerWorkspaceState(),ticket.customerId);
  const customerLink = customer && !customer.restricted
    ? `<div class="ops-actions">${button('顧客詳細','customer-detail',{id:customer.id,glyph:'users'})}</div>` : '';
  return `${customerLink}${ticket.note && currentRole() === 'admin' ? `<p class="ticket-operation-note"><strong>伝票メモ</strong><br>${escape(ticket.note)}</p>` : ''}<section aria-labelledby="receipt-lines-title">
    <h3 id="receipt-lines-title">注文明細</h3>
    <ul class="ticket-lines">${lines.map((line) => {
      const cast = lineStaffNames(line);
      return `<li class="ticket-line"><span class="line-desc">${escape(line.name)} <em>${yen(line.price)} × ${line.quantity}</em>${cast ? `<small>${cast}</small>` : ''}</span><span class="money">${yen(line.total)}</span></li>`;
    }).join('')}</ul></section>
    ${totalRows(totals, { settlement: true, large: true })}
    ${payments.length ? `<ul class="deposit-list">${payments.map((entry) => `<li><span>${entry.isDeposit ? '前受金・' : ''}${escape(entry.brandName || tenderMethods[entry.method])}</span><strong>${yen(entry.amount)}</strong></li>`).join('')}</ul>` : ''}
    ${ticket.cashTender ? `<dl class="cash-close-breakdown"><div><dt>現金お預かり</dt><dd>${yen(ticket.cashTender.received)}</dd></div>
      <div><dt>お釣り</dt><dd>${yen(ticket.cashTender.change)}</dd></div></dl>` : ''}`;
}

function canCorrectToday(date) {
  return state.day.status === 'open' && state.day.date === date && currentRole() === 'admin';
}

function printButton(ticket, date, kind, label, options = {}) {
  return button(label,'print-document',{id:ticket.id,glyph:'printer',...options,
    data:`data-print-kind="${kind}" data-date="${escape(date)}"`});
}

function settledCorrectionActions(ticket) {
  const customer = button('顧客を訂正','settled-ticket-customer',{id:ticket.id,glyph:'users',tone:'quiet'});
  const payment = paymentCorrectionModel(ticket).total > 0
    ? button('支払方法を訂正','settled-ticket-payment',{id:ticket.id,glyph:'wallet',tone:'quiet'}) : '';
  const contents = currentRole() === 'admin' && !ticketHasReceivable(state,ticket)
    ? button('注文・値引きを訂正','settled-ticket-contents',{id:ticket.id,glyph:'ticket',tone:'quiet'}) : '';
  const companions = currentRole() === 'admin' && ticket.customerId && (ticket.guests > 1 || ticket.companionCustomerIds?.length)
    ? button('同席者を訂正','settled-ticket-companions',{id:ticket.id,glyph:'users',tone:'quiet'}) : '';
  return customer + companions + payment + contents;
}

function receiptActions(ticket, date) {
  if (!['paid','departed'].includes(ticket.status)) return '';
  const hasTender = getPrintTenderReceived(ticket) > 0;
  const prints = `<div class="ops-actions">${printButton(ticket,date,'receipt','レシートを印刷',{tone:'secondary'})}
    ${printButton(ticket,date,'invoice','領収書を印刷',{disabled:!hasTender})}${settledCorrectionActions(ticket)}</div>
    ${hasTender ? '' : '<p class="field-help">領収書は、この会計で受け取った金額がある場合に発行できます。</p>'}`;
  if (!canCorrectToday(date)) return prints;
  if (state.receivables?.some((entry) => entry.ticketId === ticket.id && entry.cancelledAt == null && entry.collections.length)) {
    return prints;
  }
  return prints + `<div class="ops-actions">${button('会計を取り消す','cancel-settlement',{id:ticket.id,glyph:'x',tone:'danger'})}</div>`;
}

function tableAutoExtensionModel(tableId) {
  const ticket = getTicketForTable(state,tableId);
  const blockedBy = (ticket?.status === 'open' ? ticket.tableIds : [])
    .filter((id) => id !== tableId && !getTableAutoExtensionEnabled(state,id));
  return {tableId, enabled:getTableAutoExtensionEnabled(state,tableId),
    storeEnabled:getAutoExtensionSettings(state).enabled, available:Boolean(getAutomaticExtensionPlan(state)), blockedBy};
}

function ticketCustomerAlias(ticket) {
  if (!currentRoleAllows('customers')) return null;
  if (ticket.activeCustomerLink) return ticket.activeCustomerLink;
  const customer = findCustomer(state,ticket.customerId);
  if (customer) return {id:customer.id,name:customer.name};
  return ticket.customer ? {name:ticket.customer} : null;
}

function openSettledCustomerEditor(ticketId, options = {}) {
  const entry = findSettledCustomerTicket(state,ticketId);
  if (!entry || !permittedAction('settled-ticket-customer')) return;
  openDialog('settled-ticket-customer',{ticketId,ticketCustomerAlias:ticketCustomerAlias(entry.ticket),
    canDetach:!ticketHasReceivable(state,entry.ticket),...options});
}

function settledTicketContext({ticket,date}) {
  const tables = getTicketTableLabels(state,ticket).join('・');
  return `<div class="modal-context">${icon('ticket',16)}<strong>伝票 No. ${escape(ticket.number)}</strong><span>${escape(date)}${tables ? ` · ${escape(tables)}` : ''}</span></div>`;
}

function renderDetail(notices, now) {
  const ticket = selected && getTicketForTable(state, selected);
  const detailClose = `<button type="button" class="icon-btn detail-mobile-close" data-action="hide-detail" aria-label="伝票詳細を閉じる">${icon('x',18)}</button>`;
  if (!ticket) return `<aside class="detail ${mobileDetails ? 'mobile-visible' : ''}" aria-label="伝票詳細"><div class="detail-head"><h2>${icon('ticket',17)}伝票詳細</h2>${detailClose}</div><div class="detail-empty"><span class="metric-icon">${icon('table',23)}</span><h3>卓を選択</h3><p>利用中の卓を選ぶと、注文と会計の内訳を確認できます。</p>${state.day.status === 'closed' ? button('開店する','open',{glyph:'power',tone:'secondary'}) : ''}</div></aside>`;
  const q = quote(state,ticket.id);
  const selectedTable = state.tables.find(({id}) => id === selected);
  const warning = notices.find(({ticketId}) => ticketId === ticket.id);
  const nextAutoExtension = getTicketAutoExtensionAt(state,ticket);
  const autoModel = tableAutoExtensionModel(selected);
  const status = tableStatus(state,selected);
  const settled = ticket.status === 'paid';
  const canSetCustomer = ticket.status === 'open' && state.day.status === 'open';
  const customerName = currentRoleAllows('customers') ? ticket.customer || (canSetCustomer ? ticket.activeCustomerLink?.name : '') : '';
  const customerAction = settled ? settledCorrectionActions(ticket)
    : canSetCustomer ? button('顧客を設定','ticket-customer',{id:ticket.id,glyph:'users',tone:'quiet'})
      + (ticket.customerId || ticket.activeCustomerLink?.id
        ? button('同席者','ticket-companions',{id:ticket.id,glyph:'users',tone:'quiet'}) : '')
      + button('人数を変更','ticket-guests',{id:ticket.id,glyph:'users',tone:'quiet'})
      + button('伝票メモ','ticket-note',{id:ticket.id,glyph:'ticket',tone:'quiet'})
      + button('終了時刻を調整','ticket-end',{id:ticket.id,glyph:'clock',tone:'quiet'}) : '';
  const lines = ticket.lines.filter((line)=>!line.cancelledAt);
  const requested = ticket.discountRequest;
  const pending = requested ? `<div class="ops-highlight" role="status">値引き承認待ち
    ${requested.amount != null && currentRole() !== 'staff' ? ` · ${yen(requested.amount)}` : ''}
    ${button('値引きの承認','discount-review',{ id:ticket.id, tone:'secondary' })}</div>` : '';
  const quickItem = state.menu.find((item) => item.id === 'highball' && item.enabled !== false
    && ['ドリンク','ボトル','フード','指名'].includes(item.category));
  return `<aside class="detail ${mobileDetails ? 'mobile-visible' : ''}" aria-label="伝票詳細" data-ticket="${escape(ticket.id)}">
    <div class="detail-head"><h2>${icon('ticket',17)}伝票詳細</h2><span class="detail-number">No. ${ticket.number}</span>${detailClose}</div>
    <div class="detail-inner"><div class="detail-title"><h3>${escape(tableName(selected))}</h3>${pill(status)}</div>
    <div class="detail-meta"><span>${icon('users',13)}${ticket.guests}名${customerName ? ` · ${escape(customerName)}` : ''}</span><span>${settled ? `${icon('check',13)}退店待ち` : `${icon('clock',13)}<time data-ends="${ticket.endsAt}">${timer(ticket.endsAt)}</time>`}</span></div>
    ${customerAction ? `<div class="ops-actions">${customerAction}</div>` : ''}
    ${ticket.note ? `<p class="ticket-operation-note">${escape(ticket.note)}</p>` : ''}
    ${ticket.tableIds.length > 1 ? `<div class="detail-links" aria-label="同じ伝票の卓">${ticket.tableIds.map(id=>`<span class="detail-link">${escape(tableName(id))}</span>`).join('')}</div>` : ''}
    ${warning ? `<div class="auto-extension-detail-warning" role="group" aria-label="自動延長まで1分以内">${renderAutoExtensionBadge('soon',{icon})}
      <strong data-auto-extension-deadline="${warning.deadline}">${formatAutoExtensionCountdown(warning.deadline,now)}</strong></div>` : ''}
    ${!warning && nextAutoExtension > ticket.endsAt ? `<p class="next-auto-extension">次の自動延長予定 <strong>${dateTime.format(nextAutoExtension)}</strong></p>` : ''}
    ${status === 'overtime' && state.bulkExtensionEnabled !== false && extensionPlans().length && permittedAction('extend-overdue')
      ? `<div class="ops-actions">${button('超過分を一括延長','extend-overdue',{id:ticket.id,glyph:'clock',tone:'secondary'})}</div>` : ''}
    ${!settled && isVisitAutoExtensionPaused(ticket) ? `<div class="visit-auto-extension-controls">
      ${renderVisitAutoExtensionPaused({icon})}
      ${button('自動延長を再開','auto-extension-resume',{id:ticket.id,glyph:'refresh',tone:'secondary',
        disabled:pendingVisitAutoExtensionTicket === ticket.id})}
    </div>` : ''}
    ${!settled && selectedTable && permittedAction('table-auto-extension')
      ? renderTableAutoExtensionControl(selectedTable,autoModel,{escape,icon,tableName}) : ''}
    <div class="detail-aux"><h3>注文明細 <small>${lines.length}</small></h3>${settled ? '' : button('卓移動・連結','move',{glyph:'move',id:ticket.id})}</div>
    <ul class="ticket-lines">${lines.length ? lines.map((line) => `<li class="ticket-line"><span class="line-desc">${escape(line.name)} <em>×${line.quantity}</em>${line.castIds.length ? `<small>${lineStaffNames(line)}</small>` : ''}${line.autoExtension ? '<small>自動延長</small>' : ''}${line.serviceExcluded === true ? '<small>サービス料対象外</small>' : ''}</span><span class="money">${yen(line.total)}</span>${renderTicketLineControls(ticket,line)}</li>`).join('') : '<li class="lines-empty">注文明細はありません。</li>'}</ul>
    ${totalRows(q,{settlement:settled})}${pending}
    <div class="mini-tools">${!settled ? `${button('前受金','deposit',{glyph:'wallet',tone:'quiet',id:ticket.id})}${button('値引き','discount',{glyph:'minus',tone:'quiet',id:ticket.id})}${button('個人売上を調整','personal-sales-adjustment',{glyph:'users',tone:'quiet',id:ticket.id})}${quickItem ? button(escape(quickItem.name),'order',{glyph:'plus',tone:'quiet',id:ticket.id,data:'data-product="highball"'}) : ''}${button('卓履歴','seat-history',{glyph:'history',tone:'quiet',id:ticket.id})}${printButton(ticket,state.day.date,'check','確認伝票を印刷',{tone:'quiet'})}` : ''}${ticketAuditButton(ticket,state.day.date)}</div>
    <div class="detail-actions">${!settled ? `${button('注文','order',{glyph:'plus',tone:'secondary',id:ticket.id})}${button('延長','extend',{glyph:'clock',id:ticket.id,disabled:!extensionPlans().length})}${button('会計へ進む','settle',{glyph:'arrow-right',tone:'primary',id:ticket.id,cls:'btn-block',disabled:Boolean(requested)})}` : `${button('会計内訳','receipt',{glyph:'ticket',id:ticket.id,cls:'btn-block'})}${button('退店・卓を解放','depart',{glyph:'checkout',tone:'primary',id:ticket.id,cls:'btn-block'})}`}</div></div></aside>`;
}

function customerUIApi() {
  const today = operationBusinessDate(state);
  return {escape, icon, yen, role:currentRole(),canEdit:permittedAction('customer-edit'),
    businessDate:state.day.status === 'closed' && today > state.day.date ? today : state.day.date};

}

function customerWorkspaceState() {
  if (cloudState.store || currentRole() === 'admin') return state;
  const actor = demoActor();
  const customers = (state.customers ?? []).map((customer) =>
    actor.role === 'manager' && isAssignedCustomer(state, customer, actor.id) ? customer
      : {id:customer.id,name:customer.name,kana:customer.kana,restricted:true});
  return {...state,customers};
}

function renderOperationalNotices() {
  const stock = state.stock.filter(({hidden,quantity,minimum}) => !hidden && quantity <= minimum);
  const items = stock.map((entry) => `<li><strong>${escape(entry.name)}</strong><span>${number.format(entry.quantity)} ${escape(entry.unit)}</span></li>`);
  const customers = permittedAction('customer-detail') ? `<section class="ops-notice-section"><h3>誕生日・記念日・ボトル期限</h3>
    ${customerUI.renderCustomerNotices(customerWorkspaceState(),customerUIApi())}</section>` : '';
  return `<section class="ops-notice-section"><h3>下限に達した在庫</h3>${items.length
    ? `<ul class="ops-notices-list">${items.join('')}</ul>` : '<p class="field-help">該当するお知らせはありません。</p>'}</section>${customers}`;
}

function renderOperationsNav() {
  if (!['floor','reports','cash','customers'].includes(page)) return '';
  const links = ['cash','customers'].filter(canOpenPage).map((key) =>
    button(pages[key].title,'navigate',{id:key,glyph:pages[key].icon,tone:page === key ? 'secondary' : '',
      data:page === key ? 'aria-current="page"' : ''})).join('');
  const tableSettings = page === 'floor' ? button('卓別の自動延長','table-auto-extension',
    {glyph:'clock',disabled:state.tables.length === 0}) : '';
  return links || tableSettings ? `<nav class="ops-tools customer-workspace-nav" aria-label="営業管理">${links}${tableSettings}</nav>` : '';
}

function render({ preserveFocus = false } = {}) {
  const focused = preserveFocus ? document.activeElement : null;
  const focusAction = focused?.dataset.action;
  const focusId = focused?.dataset.id;
  const searchFocus = focused?.name === 'customerSearch'
    ? { name:focused.name, start:focused.selectionStart, end:focused.selectionEnd } : null;
  lastStatuses = state.tables.map((table)=>tableStatus(state,table.id)).join('|');
  lastMinute = dateTime.format(Date.now());
  const model = cloudModel();
  const banner = renderCloudBanner(model, {escape, icon});
  const now = Date.now();
  let floorNotices = [];
  let content;
  if (currentRole() === 'cast') {
    const workspace = currentCastWorkspace();
    content = `<header class="page-head"><div><h1>マイページ</h1><p>勤怠・シフト・支給明細</p></div>
      <div class="actions">${renderWorkspaceMenuTrigger()}${renderCloudEntry(model,{escape,icon})}</div></header>${banner}
      ${cloudState.store && cloudState.status === 'connecting' ? '<p class="notice" role="status">店舗に接続しています。</p>'
        : renderCastWorkspace(workspace,{escape,icon,yen},{seenPayrollMonths:seenCastPayrollNotices(workspace)})}`;
  } else if (cloudState.store && (!cloudState.state || !cloudState.store.hasState)) {
    content = `<header class="page-head"><h1>クラウド店舗</h1><div class="actions">${renderWorkspaceMenuTrigger()}${renderCloudEntry(model,{escape,icon})}</div></header>${banner}
      ${cloudState.restricted ? renderCloudRestricted(model,{escape,icon}) : '<p class="notice">店舗・アカウントから営業データを準備してください。</p>'}`;
  } else {
    const tools = page === 'reports' && currentRole() === 'admin' ? `<div class="ops-tools">
      ${button('監査ログ','audit-log',{glyph:'history'})}${button('運用設定','ops-settings',{glyph:'settings'})}${button('印刷設定','print-settings',{glyph:'printer'})}${button('会計CSV設定','accounting-settings',{glyph:'download'})}</div>` : '';
    let view;
    if (page === 'floor') {
      floorNotices = getAutoExtensionNotices(state,now);
      view = renderFloor(floorNotices,now);
    }
    else if (page === 'customers') view = customerUI.renderCustomers(customerWorkspaceState(),
      {...customerUIApi(),query:customersQuery,filter:customerFilters});
    else if (page === 'tickets') view = renderTicketHistory(state,{escape,icon,yen,role:currentRole(),workspaceId:cloudState.store?.id});
    else if (page === 'analytics' || page === 'product-sales') view = renderAnalytics(page,state,{escape,icon,yen,range:analyticsRange});
    else if (page === 'payroll') view = payrollUI.renderPayroll(state,{escape,icon,yen,month:payrollMonth,castId:payrollCastId});
    else if (page === 'shifts') view = renderShifts(state,{escape,icon,date:shiftDate || state.day.date,mode:shiftMode,
      canEdit:permittedAction('shift-new')});
    else if (page === 'attendance') view = renderStaffAttendance(state,{escape,icon,canEdit:permittedAction('attendance-staff-editor')})
      + renderCastAttendance(state,listCastAttendance(state),{escape,icon,yen,canEdit:permittedAction('attendance-editor')});
    else if (page === 'labor') view = renderLaborReport(state,laborRange,{escape,icon,yen});
    else if (page === 'team-performance') view = renderTeamPerformance(state,{escape,icon,yen,range:teamRange,role:teamRole});
    else view = renderReport(page,state,{yen,summary,quote,escape,icon,showHiddenStock,canAdjustStock:permittedAction('stock-adjust'),
      canCorrectRegister:currentRole() === 'admin',canRecordCash:permittedAction('record-cash'),
      canEditCash:(item) => permittedAction('edit-cash-movement') && Boolean(editableCashMovement(state,item.id))
        && (currentRole() === 'admin' || (state.day.date === item.date && state.day.status === 'open')),
      reportDate,commissionCast,reportInterval:currentReportInterval(),reportExportError,stockSearch,stockBarcodeExact,stockLowOnly,stockHistoryId});
    if (currentRole() === 'admin' && (page === 'analytics' || page === 'reports')) {
      const filters = page === 'analytics' ? analyticsRange : getReportPeriod(state,currentReportInterval());
      if (page === 'analytics' || filters.valid) view += renderLaborHighlights(state,filters,{escape,icon,yen});
    }
    const practice = demoPractice ? renderPracticeProgress(getPracticeStatus(state),{button,escape,icon}) : '';
    content = renderTop() + banner + practice + tools + renderOperationsNav() + view;
  }
  app.innerHTML = `<div class="shell">${renderSide()}<main class="workspace" id="workspace" tabindex="-1">${content}</main></div>`;
  if (hasWorkspace() && page === 'tickets') bindTicketHistory(app,state,{escape,icon,yen,role:currentRole(),workspaceId:cloudState.store?.id});
  if (workspaceMenu.open) refreshWorkspaceMenu();
  document.title = `NP POS | ${pages[page].title}`;
  lastAutoExtensionNotices = autoNoticesKey(floorNotices);
  announceAutoExtensionNotices(floorNotices,now);
  if (focusAction) [...app.querySelectorAll('[data-action]')].find((el) => el.dataset.action === focusAction && el.dataset.id === focusId)?.focus({ preventScroll: true });
  if (searchFocus) {
    const control = app.querySelector(`[name=${searchFocus.name}]`);
    control?.focus({preventScroll:true});
    if (searchFocus.start !== null) control?.setSelectionRange(searchFocus.start, searchFocus.end);
  }
}

function currentCastWorkspace() {
  return cloudState.store ? cloudState.state : getCastWorkspace(state,demoActor().id);
}

function castPayrollNoticeKey(model) {
  if (!model?.cast) return null;
  return `np-pos.payroll-notice.v1:${JSON.stringify([cloudState.store?.id ?? 'demo',cloudState.user?.uid ?? 'demo-cast',model.cast.id])}`;
}

function seenCastPayrollNotices(model) {
  const key = castPayrollNoticeKey(model);
  if (!key) return new Set();
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch { /* Use the current session when storage is unavailable. */ }
  return new Set([...(Array.isArray(saved) ? saved : []),...(castNoticesSeen.get(key) ?? [])]);
}

function readCastPayrollNotice(model,month) {
  const key = castPayrollNoticeKey(model);
  const seen = seenCastPayrollNotices(model);
  seen.add(month);
  castNoticesSeen.set(key,seen);
  try { localStorage.setItem(key,JSON.stringify([...seen])); } catch { /* The current session still remembers the notice. */ }
  render();
  const statement = document.getElementById(`cast-payslip-${month}`);
  if (statement) {
    statement.open = true;
    statement.querySelector('summary').focus({preventScroll:true});
    statement.scrollIntoView({block:'nearest'});
  }
}

function cloudModel() {
  let hasLocalData = false;
  if (modal?.type === 'cloud') {
    try { hasLocalData = readSavedState() !== null; } catch { /* Storage can be disabled. */ }
  }
  const stores = cloudState.stores.map((store) => store.id === cloudState.store?.id ? cloudState.store : store);
  return {
    ...cloudState, ...cloudMembers, stores, mode: cloudState.store ? 'cloud' : 'demo',
    castAccountChoices:cloudState.store?.role === 'admin' && cloudState.state ? state.cast.filter(({enabled})=>enabled!==false) : [],
    castAccounts:cloudState.store?.role === 'admin' && cloudState.state ? state.castAccounts ?? [] : [],
    hasLocalData, providers: cloudConfig.providers, rolePolicy:state.rolePolicy,
    busy: cloudBusy, message: cloudMessage, actionError: cloudActionError || cloudState.error,
  };
}

function rememberStore(store) {
  try {
    if (store && cloudState.user) localStorage.setItem(cloudWorkspaceKey, JSON.stringify({ uid: cloudState.user.uid, id: store.id }));
    else localStorage.removeItem(cloudWorkspaceKey);
  } catch { /* The workspace selection can still be made for this session. */ }
}

function cloudUpdated(next) {
  const before = cloudState;
  cloudState = next;
  if (next.store && demoPractice) {
    demoRole = demoPractice.role;
    demoPractice = null;
  }
  const contextChanged = before.store?.id !== next.store?.id || before.store?.role !== next.store?.role
    || before.store?.profileId !== next.store?.profileId;
  const accountChanged = before.user?.uid !== next.user?.uid || before.userVerified !== next.userVerified;
  if (next.store && next.state && next.store.role !== 'cast') state = next.state;
  else if (next.store && (contextChanged || (before.state && before.store?.role !== 'cast'))) state = createDemo('closed');
  else if (before.store && !next.store) state = loadState();
  if (!contextChanged && next.store && next.store.role !== 'admin'
      && JSON.stringify(before.state?.rolePolicy) !== JSON.stringify(next.state?.rolePolicy)) {
    if (!canOpenPage(page)) {
      page = defaultPage();
      history.replaceState(null,'',`#${page}`);
    }
    if (dialog.open && modal?.type !== 'cloud') dialog.close();
  }
  if (contextChanged) {
    activeBarcodeScan?.close();
    stockSearch = ''; stockBarcodeExact = false;
    announcedAutoExtensions.clear();
    cloudMembers = {members: [], invites: []};
    customersQuery = '';
    customerFilters = {};
    if (!canOpenPage(page)) {
      page = defaultPage();
      history.replaceState(null,'',`#${page}`);
    }
    if (dialog.open && modal?.type !== 'cloud') dialog.close();
    pendingStorage = false;
    selected = null; mobileDetails = false; area = null; filter = 'all'; reportDate = ''; commissionCast = '';
    reportInterval = {mode:'day'}; reportExportError = '';
    analyticsRange = {}; payrollMonth = ''; payrollCastId = '';
    laborRange = {};
    const view = next.store ? {view: 'list', area: null} : loadFloorView();
    floorView = view.view; planArea = view.area;
    if (before.store && !next.store) rememberStore(null);
  }
  if (contextChanged || before.state !== next.state) syncFloorSelection();
  if ((contextChanged || accountChanged) && dialog.open && modal?.type === 'cloud') paintDialog();
  if (dialog.open && modal?.type === 'cloud-sync-review' && (before.pending !== next.pending || before.conflict !== next.conflict)) paintDialog();
  if (accountChanged && dialog.open && modal?.type === 'cloud-groups' && !modal.demo) dialog.close();
  if (contextChanged || before.state !== next.state || before.status !== next.status
    || before.pending !== next.pending || accountChanged) render({preserveFocus: true});
  if (before.status === 'offline' && next.status === 'ready' && !next.store && next.stores.length > 0) void restoreCloud();
}

async function refreshMembers() {
  const store = cloudState.store;
  const uid = cloudState.user?.uid;
  if (store?.role !== 'admin') return;
  const members = await cloud.listMembers();
  if (cloudState.store?.id === store.id && cloudState.store.role === 'admin' && cloudState.user?.uid === uid) cloudMembers = members;
}

async function restoreCloud() {
  let hint;
  try { hint = JSON.parse(localStorage.getItem(cloudWorkspaceKey)); } catch { /* Select a store manually. */ }
  if (!hint) return;
  await cloud.start();
  if (hint.uid === cloudState.user?.uid && cloudState.stores.some(({id}) => id === hint.id)) {
    await cloud.enterStore(hint.id).catch(() => {});
  }
}

function initialCloudState() {
  const fresh = createDemo('closed');
  fresh.cast = [];
  fresh.stock = fresh.stock.map((item) => ({...item, quantity: 0, value: 0}));
  return fresh;
}

async function migrateBrowserData() {
  const active = modal;
  if (cloudBusy || active.storeId !== cloudState.store?.id) return;
  const submit = dialog.querySelector('#submit-dialog');
  submit.disabled = true;
  cloudBusy = true;
  try {
    const result = await cloud.migrate(active.snapshot);
    if (modal !== active) return;
    dialog.close();
    toast(result.queued ? '保存結果を確認しています。同期状況をご覧ください。'
      : active.initialize ? '営業データを準備しました。' : 'このブラウザーのデータを移行しました。');
  } catch (error) {
    if (modal === active) showError(error.message);
  } finally {
    cloudBusy = false;
    if (submit.isConnected) submit.disabled = false;
  }
}

async function storeGroupAction(action, target) {
  if (action === 'cloud-groups' || action === 'cloud-groups-demo') {
    const demo = action === 'cloud-groups-demo' || !cloudState.userVerified;
    const service = demo ? createStoreGroupDemo() : cloud;
    openDialog('cloud-groups', {demo, service, loading:true, uid:cloudState.user?.uid});
    const active = modal;
    try { active.model = await service.listStoreGroups(); }
    catch (error) { active.error = error.message; }
    if (modal === active && dialog.open && (demo || cloudState.user?.uid === active.uid)) {
      active.loading = false;
      paintDialog();
    }
    return;
  }
  const active = modal;
  if (active?.type !== 'cloud-groups' || active.loading || (!active.demo && cloudState.user?.uid !== active.uid)) return;
  const { service } = active;
  const values = new FormData(dialog.querySelector('#dialog-form'));
  const value = (name) => String(values.get(name) ?? '').trim();
  const group = active.model.groups.find(({id}) => id === active.selectedGroupId) ?? active.model.groups[0];
  const groupId = group?.id;
  const id = target.dataset.id;
  const memberRole = target.closest('.np-cloud-person')?.querySelector('[data-group-member-role]')?.value;
  cloudBusy = true;
  target.disabled = true;
  dialog.setAttribute('aria-busy','true');
  try {
    switch (action) {
      case 'cloud-group-create':
        active.selectedGroupId = (await service.createStoreGroup(value('group-create-name'))).group.id;
        break;
      case 'cloud-group-rename':
        await service.renameStoreGroup(groupId,value('group-name'));
        break;
      case 'cloud-group-store-add':
        if (!value('group-store')) throw new Error('追加する店舗を選択してください。');
        await service.setGroupStore(groupId,value('group-store'),true);
        break;
      case 'cloud-group-store-remove':
        if (!window.confirm('この店舗のグループ経由のアクセスを解除しますか？')) return;
        await service.setGroupStore(groupId,id,false);
        break;
      case 'cloud-group-invite':
        await service.inviteGroupMember(groupId,value('group-email'),value('group-role'));
        break;
      case 'cloud-group-member-save':
        await service.changeGroupMember(groupId,id,memberRole);
        break;
      case 'cloud-group-member-remove':
        if (!window.confirm('このメンバーのグループ経由のアクセスを解除しますか？')) return;
        await service.changeGroupMember(groupId,id);
        break;
      case 'cloud-group-invite-remove':
        await service.revokeGroupInvite(groupId,id);
        break;
      case 'cloud-group-demo-accept':
        if (!active.demo) return;
        service.acceptDemoInvite(groupId,id);
        break;
      case 'cloud-group-demo-preview':
      case 'cloud-group-demo-return':
        if (!active.demo) return;
        active.preview = action === 'cloud-group-demo-preview';
        service.preview(groupId,active.preview ? id : null);
        break;
      default: return;
    }
    active.model = await service.listStoreGroups();
    if (modal === active && dialog.open) {
      paintDialog();
      toast(active.preview ? 'グループ所属メンバーの表示です。' : 'グループの表示を更新しました。');
    }
  } catch (error) {
    if (modal === active && dialog.open) showError(error.message);
  } finally {
    cloudBusy = false;
    if (target.isConnected) target.disabled = false;
    dialog.removeAttribute('aria-busy');
  }
}

async function cloudAction(action, target) {
  if (cloudBusy) return;
  if (action.startsWith('cloud-group')) {
    await storeGroupAction(action,target);
    return;
  }
  if (action === 'cloud-overview') {
    if (!cloudState.userVerified || !cloudState.stores.some(({role})=>role==='admin')) return;
    openDialog('cloud-overview',{loading:true});
    const active = modal;
    const uid = cloudState.user?.uid;
    try { active.overview = await cloud.storeOverview(); }
    catch (error) { active.error = error.message; }
    if (modal === active && cloudState.user?.uid === uid && dialog.open) {
      active.loading = false;
      paintDialog();
    }
    return;
  }
  const id = target.dataset.id;
  if (action === 'cloud-migrate' || action === 'cloud-initialize') {
    if (cloudState.store?.role !== 'admin' || cloudState.store.hasState) return;
    const initialize = action === 'cloud-initialize';
    const snapshot = initialize ? initialCloudState() : loadLocalData();
    if (!snapshot) { showError('移行できるデータが見つかりません。'); return; }
    openDialog('cloud-migration', { snapshot, initialize });
    return;
  }

  if (action === 'cloud-open') {
    cloudMessage = ''; cloudActionError = '';
    cloudBusy = true;
    openDialog('cloud');
  }
  const active = modal;
  const values = new FormData(dialog.querySelector('#dialog-form') ?? undefined);
  const value = (key) => String(values.get(key) ?? '').trim();
  const email = value('cloud-email');
  const password = String(values.get('cloud-password') ?? '');
  const memberRole = target.closest('.np-cloud-person')?.querySelector('[data-cloud-member-role]')?.value;
  const memberCast = target.closest('.np-cloud-person')?.querySelector('[data-cloud-cast-id]');
  cloudBusy = true;
  cloudMessage = ''; cloudActionError = '';
  try {
    switch (action) {
      case 'cloud-open':
        await cloud.start();
        if (cloudState.userVerified && !cloudState.store) await cloud.listStores();
        await refreshMembers();
        break;
      case 'cloud-google':
        await cloud.signInGoogle();
        break;
      case 'cloud-email-sign-in':
        await cloud.signInEmail(email, password);
        break;
      case 'cloud-email-register':
        await cloud.registerEmail(email, password);
        cloudMessage = '確認メールを送信しました。メールのリンクを開き、ここで更新を押してください。';
        break;
      case 'cloud-email-reset':
        await cloud.resetPassword(email);
        cloudMessage = '再設定メールを送信しました。受信ボックスを確認してください。';
        break;
      case 'cloud-email-verify':
        await cloud.sendVerification();
        cloudMessage = '確認メールを再送しました。';
        break;
      case 'cloud-refresh':
        await cloud.refreshAuth();
        await refreshMembers();
        break;
      case 'cloud-select-store':
      case 'cloud-create-store': {
        const storeId = action === 'cloud-create-store' ? (await cloud.createStore(value('cloud-store-name'))).id : id;
        if (active?.type === 'cloud-groups') await cloud.listStores();
        await cloud.enterStore(storeId);
        rememberStore(cloudState.store);
        if (active?.type === 'cloud-groups' && !cloudState.store?.hasState) openDialog('cloud');
        if (cloudState.store?.hasState && dialog.open && modal === active) dialog.close();
        else await refreshMembers();
        break;
      }
      case 'cloud-invite':
        await cloud.inviteMember(value('cloud-invite-email'), value('cloud-invite-role'));
        cloudMessage = '招待を登録しました。同じ確認済みメールアドレスでサインインすると店舗が表示されます。';
        await refreshMembers();
        break;
      case 'cloud-member-save':
        await cloud.updateMember(id, memberRole);
        await refreshMembers();
        break;
      case 'cloud-bind-cast': {
        if (!memberCast || cloudState.store?.role !== 'admin') break;
        const result = await cloud.submit({type:'bindCastAccount',memberUid:id,castId:memberCast.value || null});
        cloudMessage = result.queued ? 'ひもづけの保存結果を確認しています。' : 'キャストアカウントの設定を保存しました。';
        break;
      }
      case 'cloud-member-revoke':
        if (!window.confirm('グループ経由の権限も含め、この店舗へのアクセスを解除しますか？')) break;
        await cloud.removeMember(id);
        cloudMessage = 'この店舗へのアクセスを解除しました。';
        await refreshMembers();
        break;
      case 'cloud-member-restore':
        if (!window.confirm('この店舗へのグループ経由のアクセスを再開しますか？')) break;
        await cloud.restoreGroupMember(id);
        cloudMessage = 'グループ経由のアクセスを再開しました。';
        await refreshMembers();
        break;
      case 'cloud-invite-revoke':
        await cloud.cancelInvite(id);
        await refreshMembers();
        break;
      case 'cloud-sign-out':
        await cloud.signOut();
        rememberStore(null);
        if (dialog.open && modal === active) dialog.close();
        break;
      case 'cloud-demo':
        await cloud.leaveStore();
        rememberStore(null);
        if (dialog.open && modal === active) dialog.close();
        break;
      case 'cloud-sync-retry':
        await cloud.retrySync();
        break;
      case 'cloud-sync-review':
        openDialog(action);
        break;
      case 'cloud-sync-discard':
        if (cloudState.conflict && window.confirm(`${cloudState.pending}件の送信待ちを取り消し、最新の営業データを読み込みますか？`)) {
          await cloud.clearQueue();
          await cloud.retrySync();
        }
        break;
    }
  } catch (error) {
    if (dialog.open && modal === active && ['cloud-overview','cloud-groups','cloud-sync-review'].includes(active?.type)) showError(error.message);
    else if (dialog.open && modal === active) cloudActionError = error.message;
    else toast(error.message);
  } finally {
    cloudBusy = false;
    if (dialog.open && modal === active && modal?.type === 'cloud') {
      paintDialog();
      const emailInput = dialog.querySelector('[name=cloud-email]');
      if (emailInput && email) emailInput.value = email;
    }
    render({preserveFocus: true});
  }
}

function toast(message, {error = false} = {}) {
  const item = document.createElement('div');
  item.className = error ? 'toast toast-error' : 'toast';
  item.innerHTML = `${icon(error ? 'alert' : 'check',17)}<span>${escape(message)}</span>`;
  notifications.append(item);
  setTimeout(()=>item.remove(), 4300);
}

async function scanStockBarcode(action) {
  if (activeBarcodeScan) return;
  const register = action === 'stock-barcode-register';
  const field = register ? dialog.querySelector('[name=store-barcode]') : app.querySelector('[name=stockSearch]');
  if (!field || (register ? !modal?.editor || currentRole() !== 'admin' : page !== 'stock' || !canOpenPage('stock'))) return;
  const storeId = cloudState.store?.id;
  const scan = openBarcodeScanner();
  activeBarcodeScan = scan;
  try {
    const value = await scan.result;
    if (!value || storeId !== cloudState.store?.id) return;
    if (register) {
      if (field.isConnected && dialog.open && currentRole() === 'admin') {
        field.value = value;
        field.focus({preventScroll:true});
      }
    } else if (page === 'stock' && canOpenPage('stock')) {
      stockSearch = value;
      stockBarcodeExact = true;
      stockLowOnly = false;
      if (state.stock.some(({barcode,hidden}) => hidden && barcode?.toLowerCase() === value.toLowerCase())) showHiddenStock = true;
      render();
      app.querySelector('[name=stockSearch]')?.focus({preventScroll:true});
    }
  } finally {
    if (activeBarcodeScan === scan) activeBarcodeScan = undefined;
  }
}

function visibleOperationMessage(message) {
  return /売掛|与信/.test(message) ? 'この操作を完了できません。最新の会計記録を開き直してください。' : message;
}

function showError(message) {
  const box = dialog.querySelector('.modal-body > .form-error');
  if (!box) return;
  box.textContent = visibleOperationMessage(message);
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

async function commit(command, message, after, {fromFloor = false} = {}) {
  if (committing) return;
  committing = true;
  const activeModal = modal;
  const storeId = cloudState.store?.id;
  const revision = fromFloor ? cloudState.revision : activeModal?.revision;
  const floorDate = state.day.date;
  const role = currentRole();
  const staysActive = () => fromFloor
    ? !dialog.open && page === 'floor' && cloudState.store?.id === storeId
      && currentRole() === role && state.day.date === floorDate
    : dialog.open && modal === activeModal;
  const submit = fromFloor ? null : dialog.querySelector('#submit-dialog');
  if (submit) submit.disabled = true;
  const finish = (next, queued = false) => {
    if (!staysActive()) return;
    if (!fromFloor) {
      if (!queued) after?.(next);
      dialog.close();
    }
    if (!queued && demoPractice) mobileDetails = false;
    render();
    if (fromFloor && !queued) after?.(next);
    if (queued) toast(cloudState.pendingVolatile ? '送信待ちです。同期待ちの間はこの画面を開いてください。'
      : '送信待ちを端末に保存しました。接続が回復すると同期します。');
    else if (message) toast(message);
    return queued ? null : next;
  };
  try {
    if (storeId) {
      if (!fromFloor && activeModal.storeId !== storeId) throw new Error('店舗を開き直してから操作してください。');
      const result = await cloud.submit(command,revision);
      return finish(result.state ?? state,result.queued);
    }
    const update = () => {
      if (!staysActive()) return;
      let latest;
      try { latest = readSavedState(); } catch { /* Storage can be disabled. */ }
      const freshImport = command.type === 'importStoreConfiguration' && activeModal?.fresh;
      if (activeModal?.autoExtended) throw new Error('自動延長が反映されました。画面を開き直してご確認ください。');
      if (activeModal?.stale || (latest && (freshImport || latest !== JSON.stringify(state)))) {
        if (fromFloor) {
          state = loadState();
          syncFloorSelection();
          render();
          throw new Error('別のタブで伝票が更新されました。ホールの最新状態を確認してください。');
        }
        activeModal.stale = true;
        pendingStorage = true;
        throw new Error('別のタブでデータが更新されました。画面を閉じ、最新状態を確認してください。');
      }
      const now = Date.now();
      const source = storeImportTarget(command.configuration,freshImport);
      const reconciled = role === 'cast' ? source : applyDueLocalExtensions(source,now);
      if (reconciled !== source) {
        saveState(reconciled);
        if (activeModal) activeModal.autoExtended = true;
        render();
        throw new Error(fromFloor ? '自動延長が反映されました。最新の伝票をご確認ください。'
          : '自動延長が反映されました。画面を開き直してご確認ください。');
      }
      const next = apply(source,command,now,demoActor());
      saveState(next);
      const result = finish(next);
      if (!saveAvailable) toast('ブラウザーの設定により操作内容を保存できません。');
      return result;
    };
    if (!demoPractice && navigator.locks?.request) return await navigator.locks.request(storageKey,update);
    return update();
  } catch (error) {
    if (staysActive()) {
      if (fromFloor) toast(error.message,{error:true});
      else showError(error.message);
    }
  } finally {
    committing = false;
    if (submit?.isConnected) {
      if (modal?.type === 'settled-ticket-payment') refreshPaymentCorrection();
      else if (hasTicketCustomerEditor()) syncTicketCustomerSubmit();
      else submit.disabled = false;
    }
  }
}

async function commitReceiptCorrection(command, message) {
  const {returnToReceipt} = modal;
  const next = await commit(command,message);
  if (!next || !returnToReceipt || dialog.open) return;
  const entry = findSettledCustomerTicket(next,command.ticketId);
  if (entry) openDialog('history-receipt',{receipt:entry.ticket,date:entry.date});
}

function applyDueLocalExtensions(source, now) {
  const deadline = getNextAutoExtensionAt(source);
  return deadline != null && deadline <= now ? apply(source,{type:'syncAutoExtensions'},now,demoActor()) : source;
}

async function syncDueLocalExtensions(now) {
  const deadline = getNextAutoExtensionAt(state);
  if (cloudState.store || syncingLocalExtensions || committing || deadline == null || deadline > now) return;
  syncingLocalExtensions = true;
  const update = () => {
    if (cloudState.store || committing) return;
    const source = loadLocalData() ?? state;
    const next = applyDueLocalExtensions(source,Date.now());
    if (next === source) return;
    saveState(next);
    if (dialog.open && modal) {
      modal.autoExtended = true;
      showError('自動延長が反映されました。画面を開き直してご確認ください。');
    }
    render({preserveFocus:true});
  };
  try {
    if (!demoPractice && navigator.locks?.request) await navigator.locks.request(storageKey,update);
    else update();
  } finally {
    syncingLocalExtensions = false;
  }
}

function freshLayoutTarget() {
  if (cloudState.store) return false;
  try { return saveAvailable && readSavedState() === null; }
  catch { return false; }
}

function storeImportTarget(configuration, fresh) {
  if (!fresh) return state;
  const target = createDemo('closed');
  if (configuration.settings?.stock) {
    const importedIds = new Set(configuration.settings.stock.map(({ id }) => id));
    target.stock = target.stock.filter(({ id }) => importedIds.has(id));
  }
  return target;
}

function checkStockDeletion(id, menu) {
  return stockDeletionBlocker(state, id, menu);
}

function checkCatalogDeletion(kind, id, menu) {
  return catalogDeletionBlocker(state, kind, id, menu);
}

function downloadFile(filename, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], {type}));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url),30_000);
}

function exportStoreFile() {
  const text = `${JSON.stringify(exportStoreConfiguration(state),null,2)}\n`;
  downloadFile(`np-pos-settings-${operationBusinessDate(state)}.json`,text,'application/json');
  toast('店舗設定と卓レイアウトを書き出しました。');
}

async function exportDemoBackup(active) {
  if (currentRole() !== 'admin' || cloudState.store || demoPractice || active.loading) return;
  const source = state;
  active.loading = true;
  paintDialog();
  try {
    const {writeDemoBackup} = await import('./demo-backup.mjs');
    const text = await writeDemoBackup(source);
    if (modal !== active || !dialog.open) return;
    downloadFile(`np-pos-demo-backup-${source.day.date}.json`,text,'application/json');
    toast('デモデータをバックアップしました。');
  } catch (error) {
    if (modal === active && dialog.open) active.error = error.message;
  } finally {
    active.loading = false;
    if (modal === active && dialog.open) paintDialog();
  }
}

async function selectDemoBackup(file) {
  const active = modal;
  if (!file || active?.type !== 'demo-backup' || cloudState.store || active.loading) return;
  Object.assign(active,{loading:true,error:'',backup:null,fileName:file.name});
  paintDialog();
  try {
    const {demoBackupMaxBytes,readDemoBackup} = await import('./demo-backup.mjs');
    if (file.size > demoBackupMaxBytes) throw new Error('この端末に保存できる範囲のバックアップを選んでください。');
    active.backup = await readDemoBackup(await file.text());
  } catch (error) {
    active.error = error.message;
  } finally {
    active.loading = false;
    if (modal === active && dialog.open) paintDialog();
  }
}

async function restoreDemoBackup(active) {
  if (!active.backup || active.loading || currentRole() !== 'admin' || cloudState.store || demoPractice) return;
  const submit = dialog.querySelector('#submit-dialog');
  if (submit) submit.disabled = true;
  const replace = () => {
    if (modal !== active || !dialog.open || cloudState.store || demoPractice) return;
    if (readSavedState() !== active.localAtOpen) throw new Error('別の画面でデモデータが更新されました。開き直してから復元してください。');
    const next = active.backup.snapshot;
    try { localStorage.setItem(storageKey,JSON.stringify(next)); }
    catch { throw new Error('端末の保存領域に空きがあるか確認してください。'); }
    saveAvailable = true;
    state = next;
    selected = null;
    mobileDetails = false;
    reportDate = '';
    reportInterval = {mode:'day'};
    pendingStorage = false;
    dialog.close();
    syncFloorSelection();
    go('floor');
    toast('このブラウザーのデモデータを復元しました。');
  };
  try {
    if (navigator.locks?.request) await navigator.locks.request(storageKey,replace);
    else replace();
  } catch (error) {
    if (modal === active && dialog.open) showError(error.message);
  } finally {
    if (submit?.isConnected) submit.disabled = false;
  }
}

function currentReportInterval() {
  const month = state.day.date.slice(0,7);
  return {date:reportDate,month,start:`${month}-01`,end:state.day.date,...reportInterval};
}

function exportReport(kind) {
  if (page !== 'reports' || !['report','daily','tickets','custom-daily','custom-tickets'].includes(kind)) return;
  const period = getReportPeriod(state,currentReportInterval());
  if (!period.valid || !period.days.length) return;
  const storeName = cloudState.store?.name ?? '銀座店';
  const suffix = period.start === period.end ? period.start : `${period.start}_${period.end}`;
  let csv;
  let encoding = 'utf-8';
  try {
    if (kind.startsWith('custom-')) ({data:csv,encoding} = buildCustomAccountingCsv(state,period,kind.slice(7),storeName));
    else csv = kind === 'report' ? buildDailyReportCsv(period,storeName)
      : buildFreeeCsv(period,{mode:kind,storeName,storeId:cloudState.store?.id}).csv;
  } catch (error) {
    reportExportError = error.message;
    render({preserveFocus:true});
    app.querySelector('[data-report-export-error]')?.focus({preventScroll:true});
    return;
  }
  if (reportExportError) {
    reportExportError = '';
    render({preserveFocus:true});
  }
  const prefix = kind === 'report' ? 'daily-report' : kind.startsWith('custom-') ? kind : `freee-${kind}`;
  downloadFile(`np-pos-${prefix}-${suffix}.csv`,csv,`text/csv;charset=${encoding}`);
  toast('CSVを書き出しました。');
}

async function readStoreFile(input) {
  const file = input.files[0];
  if (modal?.type !== 'layout-transfer' || !file) return;
  const activeModal = modal;
  const request = Symbol('layout file');
  Object.assign(activeModal, { request, fileName: file.name, configuration: null, error: '', loading: true });
  paintDialog(input);
  try {
    const text = await file.text().catch(() => { throw new Error('ファイルを開けませんでした。もう一度選んでください。'); });
    if (modal !== activeModal || request !== activeModal.request || !dialog.open) return;
    const configuration = parseStoreConfiguration(text);
    apply(storeImportTarget(configuration, activeModal.fresh), { type: 'importStoreConfiguration', configuration });
    activeModal.configuration = configuration;
  } catch (error) {
    if (modal !== activeModal || request !== activeModal.request || !dialog.open) return;
    activeModal.error = error.message;
  }
  activeModal.loading = false;
  paintDialog(input);
  if (activeModal.configuration) dialog.querySelector('#submit-dialog')?.focus({ preventScroll: true });
}

function openDialog(type, data = {}) {
  if (!dialog.open) priorFocus = document.activeElement;
  modal = { type, storeId: cloudState.store?.id, revision: cloudState.revision, ...data };
  paintDialog();
  if (!dialog.open) dialog.showModal();
}

function present(title, body, primary, { submit = true, style = '' } = {}) {
  dialog.className = `modal ${style}`;
  dialog.innerHTML = `<form id="dialog-form"><header class="modal-head"><h2 id="dialog-title">${title}</h2><button type="button" class="icon-btn" data-action="dismiss" aria-label="閉じる">${icon('x',19)}</button></header><div class="modal-body">${body}<p class="form-error" role="alert" hidden></p></div>${primary ? `<footer class="modal-foot">${button('キャンセル','dismiss',{tone:'quiet'})}${submit ? `<button type="submit" class="btn btn-primary" id="submit-dialog">${primary}</button>` : primary}</footer>` : ''}</form>`;
}

async function loadAuditPage() {
  const active = modal;
  if (active?.type !== 'audit-log' || active.loading) return;
  active.loading = true; active.failed = '';
  paintDialog();
  try {
    if (cloudState.store) {
      const { events, nextBefore } = await cloud.listAudit({before:active.before, limit:30,ticketId:active.ticketAuditId});
      if (modal !== active || !dialog.open) return;
      active.entries.push(...events);
      active.before = nextBefore;
      active.more = nextBefore != null;
    } else {
      const entries = (state.auditLog ?? []).filter((entry)=> !active.ticketAuditId
        || (entry.target?.kind === 'ticket' && entry.target.id === active.ticketAuditId));
      active.entries.push(...entries.slice(active.entries.length, active.entries.length + 30));
      active.more = active.entries.length < entries.length;
    }
  } catch (error) {
    active.failed = error.message;
  } finally {
    active.loading = false;
    if (modal === active && dialog.open) paintDialog();
  }
}

function label(title, control, help = '') {
  return `<label class="field"><span>${title}</span>${control}${help ? `<small>${help}</small>` : ''}</label>`;
}

function methodSelect(name, method = 'cash') {
  return `<select name="${name}" aria-label="支払方法">${Object.entries(tenderMethods).map(([key,text])=>`<option value="${key}" ${key===method?'selected':''}>${text}</option>`).join('')}</select>`;
}

function seatPicker(selectedIds,{ticketId,primary=null}={}) {
  return `<fieldset class="choices"><legend>使用する卓</legend><div class="choice-grid">${state.tables.map((table) => {
    const holder = getTicketForTable(state,table.id);
    const disabled = (!!holder && holder.id!==ticketId);
    const checked = selectedIds.includes(table.id);
    return `<label class="choice"><input type="checkbox" name="tableIds" value="${escape(table.id)}" ${checked || primary===table.id?'checked':''} ${disabled||primary===table.id?'disabled':''}><span><strong>${escape(table.name)}</strong><small>${escape(table.area)} · ${disabled?'使用中':`${table.capacity}名`}</small></span></label>`;
  }).join('')}</div></fieldset>`;
}

function canShowGuideTopic(topic) {
  return topic && (!topic.adminOnly || currentRole() === 'admin')
    && (topic.page ? canOpenPage(topic.page) : currentRole() !== 'cast');
}

function guideList(query) {
  return renderGuideResults(query,escape,{
    allows:canShowGuideTopic,
    actions:(topic) => `<div class="ops-actions">${topic.page ? button(`${pages[topic.page].title}を開く`,'navigate',{id:topic.page,tone:'quiet'})
      : button('店舗グループを開く',topic.action,{tone:'quiet'})}${modal.guideEnabled
        ? button('AIで手順を見る','ops-guide-explain',{id:topic.id,tone:'quiet'}) : ''}</div>`,
  });
}

async function openOperationsGuide() {
  openDialog('ops-guide');
  const current = modal;
  if (!cloudState.store) return;
  const {enabled} = await cloud.operationsGuide().catch(()=>({enabled:false}));
  if (modal !== current || !dialog.open || !enabled) return;
  current.guideEnabled = true;
  const search = dialog.querySelector('[name=guideSearch]');
  dialog.querySelector('[data-guide-results]').innerHTML = guideList(search.value);
}

async function explainGuideTopic(id,target) {
  const current = modal;
  const topic = getOperationsGuideTopic(id);
  if (current?.type !== 'ops-guide' || !current.guideEnabled || !canShowGuideTopic(topic) || current.guidePending) return;
  current.guidePending = true;
  target.disabled = true;
  const result = dialog.querySelector('[data-guide-answer]');
  result.hidden = false;
  result.querySelector('strong').textContent = topic.title;
  const status = result.querySelector('p');
  status.textContent = '手順をまとめています…';
  try {
    const {answer} = await cloud.operationsGuide(id);
    if (modal === current && dialog.open) status.textContent = answer;
  } catch (error) {
    if (modal === current && dialog.open) status.textContent = error.message;
  } finally {
    current.guidePending = false;
    if (target.isConnected) target.disabled = false;
  }
}

function paintDialog(layoutFileInput) {
  const ticket = modal.ticketId ? state.tickets.find((item)=>item.id===modal.ticketId) : null;
  const id = modal.ticketId;
  const q = ticket ? quote(state,id) : null;
  const customerName = currentRoleAllows('customers') ? ticket?.customer : '';
  const headline = ticket ? `<div class="modal-context">${icon('table',16)}<strong>${escape(titles(ticket))}</strong><span>${ticket.guests}名${customerName ? ` · ${escape(customerName)}` : ''}</span></div>` : '';
  switch (modal.type) {
    case 'cloud-groups': {
      const sections = new Map([...dialog.querySelectorAll('[data-group-section]')].map((section) => [section.dataset.groupSection,section.open]));
      present('店舗グループ',renderStoreGroups(modal,{escape,button}),null,{style:'cloud-dialog'});
      for (const section of dialog.querySelectorAll('[data-group-section]')) {
        if (sections.has(section.dataset.groupSection)) section.open = sections.get(section.dataset.groupSection);
      }
      return;
    }
    case 'cloud-sync-review': {
      const labels = {open:'開店',seat:'来店',order:'注文',extend:'延長',move:'卓移動',settle:'会計',depart:'退店',serve:'提供済み',migrate:'データ移行'};
      const waiting = cloudState.waiting ?? [];
      const entries = waiting.map(({type,ticketId,tableIds,createdAt}) => {
        const visit = (state.tickets ?? []).find(({id}) => ticketId === id);
        const tables = tableIds?.map(tableName).join('・');
        const target = visit ? ` ／ 伝票 No. ${visit.number}` : tables ? ` ／ ${tables}` : '';
        return `<li><span>${escape((labels[type] ?? '営業操作') + target)}</span><span>${dateTime.format(createdAt)}</span></li>`;
      });
      const status = cloudState.conflict ? `<p class="ops-highlight" role="status">${escape(visibleOperationMessage(cloudState.conflict))}</p>`
        : cloudState.pendingVolatile ? '<p class="ops-highlight" role="status">この操作は画面を開いている間、接続の回復を待ちます。</p>'
          : '<p class="field-help">接続が回復すると上から順に送信し、店舗の営業データに反映します。</p>';
      present('送信待ちの操作',waiting.length ? status + `<ul class="compact-history">${entries.join('')}</ul>` +
        (cloudState.conflict ? `<div class="ops-actions">${button('送信待ちを取り消す','cloud-sync-discard',{tone:'danger'})}</div>` : '')
        : '<p class="form-copy" role="status">送信待ちの操作はありません。</p>',null,{style:'ops-modal'});
      return;
    }
    case 'cloud-overview':
      present('複数店舗の営業状況',renderStoreOverview(modal,{escape,icon,yen}),null,{style:'cloud-dialog modal-wide'});
      return;
    case 'cloud': {
      const sections = new Map([...dialog.querySelectorAll('[data-cloud-section]')].map((section) => [section.dataset.cloudSection, section.open]));
      present('店舗・アカウント', renderCloudPanel(cloudModel(), {escape, icon}), null, { style: 'cloud-dialog' });
      for (const section of dialog.querySelectorAll('[data-cloud-section]')) {
        if (sections.has(section.dataset.cloudSection)) section.open = sections.get(section.dataset.cloudSection);
      }
      return;
    }
    case 'cloud-migration': {
      const snapshot = modal.snapshot;
      const details = {
        storeName: cloudState.store?.name, date: snapshot.day.date, tableCount: snapshot.tables.length,
        ticketCount: snapshot.tickets.length, closedDayCount: snapshot.closedDays.length, movementCount: snapshot.movements.length,
      };
      const body = modal.initialize ? '<p class="form-copy">ひな形の卓とメニューを使い、在庫数と営業履歴が空の状態から始めます。</p>'
        : renderCloudMigration(details, {escape, icon});
      present(modal.initialize ? '営業データを準備' : 'このブラウザーのデータを移行', body,
        modal.initialize ? '営業データを準備する' : '店舗に移行する', {style: 'cloud-dialog'});
      return;
    }
    case 'demo-backup': {
      const {backup,loading,error,fileName} = modal;
      const dateLabel = backup && new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'})
        .format(new Date(backup.savedAt));
      const review = backup ? `<div class="modal-context"><strong>${escape(backup.snapshot.day.date)} 営業日</strong>
        <span>保存日時 ${escape(dateLabel)}</span></div><p class="form-copy">現在のデモデータを置き換えます。利用中の伝票は復元後の営業設定に従って処理されます。</p>` : '';
      present('デモデータのバックアップ',`<p class="form-copy">このブラウザーのデモの設定、伝票、在庫、給与、監査履歴をJSONで保存・復元します。</p>
        <div class="ops-actions">${button('バックアップを書き出す','demo-backup-download',{glyph:'download',tone:'secondary',disabled:loading})}</div>
        ${label('復元するファイル','<input type="file" name="demo-backup-file" accept=".json,application/json"'+(loading ? ' disabled' : '')+'>')}
        ${fileName ? `<p class="field-help">${escape(fileName)}</p>` : ''}${loading ? '<p class="field-help" role="status">確認しています…</p>' : ''}
        ${error ? `<p class="form-error" role="alert">${escape(error)}</p>` : ''}${review}`,backup ? 'デモデータを復元' : null,{style:'ops-modal'});
      return;
    }
    case 'layout-transfer': {
      const fileFocused = document.activeElement === layoutFileInput;
      const confirm = modal.configuration?.settings ? 'この設定を読み込む' : 'このレイアウトを読み込む';
      present('設定の書き出し・読み込み', renderLayoutTransfer(modal, { escape, icon }),
        modal.configuration ? confirm : null, { style: 'layout-transfer-dialog' });
      if (layoutFileInput) {
        const replacement = dialog.querySelector('#layout-transfer-file');
        layoutFileInput.setAttribute('aria-describedby', replacement.getAttribute('aria-describedby'));
        if (modal.error) layoutFileInput.setAttribute('aria-invalid', 'true');
        else layoutFileInput.removeAttribute('aria-invalid');
        replacement.replaceWith(layoutFileInput);
        if (fileFocused) layoutFileInput.focus({ preventScroll: true });
      }
      return;
    }
    case 'store-settings':
      present('店舗設定', renderStoreSettingsEditor(modal.editor, { escape, icon, yen, priceMode:getCalculationSettings(state).priceMode,
        stockDeletionBlocker: checkStockDeletion, catalogDeletionBlocker: checkCatalogDeletion }),
        '店舗設定を保存', { style: 'store-settings-dialog' });
      dialog.querySelector('#submit-dialog').formNoValidate = true;
      return;
    case 'edit-layout':
      present('ホールのレイアウト編集', renderLayoutEditor(modal.layout, escape), 'レイアウトを保存', { style: 'modal-layout' });
      return;
    case 'ticket-customer':
      present('伝票の顧客を設定',headline + customerUI.renderTicketCustomerEditor(customerWorkspaceState(),{
        currentAlias:modal.ticketCustomerAlias,query:modal.seatCustomerQuery ?? '',selected:modal.seatCustomerId,
      },customerUIApi()),'顧客の設定を保存',{style:'modal-wide customer-dialog'});
      syncTicketCustomerSubmit();
      return;
    case 'settled-ticket-companions':
    case 'ticket-companions': {
      const isCorrection = modal.type === 'settled-ticket-companions';
      const entry = isCorrection ? findSettledCustomerTicket(state,id) : {ticket};
      const visit = entry?.ticket;
      const primary = visit && ticketCustomerAlias(visit);
      if (!primary?.id) {present('同席者','<p class="form-copy">会計を代表するお客様を選択してください。</p>',null);return;}
      const reason = isCorrection ? settledTicketContext(entry) + operationReason({title:'訂正理由'}) : '';
      present(isCorrection ? '会計済み伝票の同席者を訂正' : '同席者',reason
        + customerUI.renderCompanionEditor(customerWorkspaceState(),visit,primary,customerUIApi()),null,{style:'ops-modal'});
      return;
    }
    case 'ticket-note':
      present('伝票メモ',headline + label('営業メモ',`<textarea name="ticketNote" maxlength="400" rows="4">${escape(ticket.note ?? '')}</textarea>`,
        '同じ店舗の営業担当者が確認できます。空欄で保存するとメモが消えます。'),'メモを保存',{style:'ops-modal'});
      return;
    case 'ticket-end':
      present('終了時刻を調整',`${headline}<p class="form-copy">現在の終了時刻 ${dateTime.format(ticket.endsAt)}。注文や料金はそのままです。</p>`
        + label('調整する時間（分）','<input name="timeAdjustment" type="number" min="-180" max="180" step="1" inputmode="numeric" required>',
          '延ばす場合は正の数、短くする場合は負の数を入力します。') + operationReason({title:'調整理由'})
          + `<div class="ops-actions">${button('開始・終了を日時で指定','ticket-set-time',{id,glyph:'clock',tone:'quiet'})}</div>`,
        '終了時刻を保存',{style:'ops-modal'});
      return;
    case 'ticket-set-time':
      present('セットの開始・終了時刻',headline + `<div class="form-grid">
        ${label('開始日時（日本時間）',`<input type="datetime-local" name="startsAt" value="${tokyoDateTimeValue(ticket.setStartedAt ?? ticket.createdAt)}" required>`)}
        ${label('終了日時（日本時間）',`<input type="datetime-local" name="endsAt" value="${tokyoDateTimeValue(ticket.endsAt)}" required>`)}
        </div>` + operationReason({title:'調整理由'}),'セット時間を保存',{style:'ops-modal'});
      return;
    case 'ticket-guests': {
      const capacity = state.tables.filter(({id:tableId}) => ticket.tableIds.includes(tableId))
        .reduce((sum, table) => sum + table.capacity, 0);
      present('利用人数を変更',`${headline}<p class="form-copy">使用卓の定員は合計 ${capacity} 名です。次回の延長から新しい人数で計算します。登録済みのセットや注文の料金はそのままです。</p>`
        + label('変更方法', `<select name="guestChangeMode">
          <option value="correct">人数の訂正</option>
          <option value="join"${ticket.guests >= Math.min(capacity, 100) ? ' disabled' : ''}>途中合流</option>
          <option value="leave"${ticket.guests <= 1 ? ' disabled' : ''}>一部退店</option>
        </select>`)
        + label('人数（名）', '<input name="guestChangeCount" type="number" min="1" max="100" step="1" inputmode="numeric" required>',
          '訂正は変更後の人数、合流・一部退店は増減した人数を入力します。')
        + operationReason({title:'変更理由'}), '人数を保存',{style:'ops-modal'});
      return;
    }
    case 'settled-ticket-customer': {
      const entry = findSettledCustomerTicket(state,id);
      if (!entry) {
        present('会計済み伝票の顧客を訂正','<p class="form-copy">伝票を開き直して現在の会計状態を確認してください。</p>',null);
        return;
      }
      present('会計済み伝票の顧客を訂正',settledTicketContext(entry) + customerUI.renderTicketCustomerEditor(customerWorkspaceState(),{
        currentAlias:modal.ticketCustomerAlias,query:modal.seatCustomerQuery ?? '',selected:modal.seatCustomerId,
        settled:true,reason:modal.customerCorrectionReason ?? '',canDetach:modal.canDetach,
        customerConstraint:modal.canDetach ? '' : '過去の会計記録との整合性を保つため、別の顧客を選んでください。',
      },customerUIApi()),'顧客の訂正を保存',{style:'modal-wide customer-dialog'});
      syncTicketCustomerSubmit();
      return;
    }
    case 'settled-ticket-payment': {
      const entry = findSettledCustomerTicket(state,id);
      if (!entry || !paymentCorrectionModel(entry.ticket).total) {
        present('会計済み伝票の支払方法を訂正','<p class="form-copy">伝票を開き直して支払内訳を確認してください。</p>',null);
        return;
      }
      const model = modal.paymentCorrection = paymentCorrectionModel(entry.ticket);
      present('会計済み伝票の支払方法を訂正',settledTicketContext(entry) + renderPaymentCorrection(model,{escape,yen}),
        '支払方法の訂正を保存',{style:'ops-modal'});
      refreshPaymentCorrection();
      return;
    }
    case 'settled-ticket-contents': {
      const entry = findSettledCustomerTicket(state,id);
      if (!entry) { present('会計内容を訂正','<p>対象の伝票は見つかりません。</p>',null); return; }
      present('会計内容を訂正',settledTicketContext(entry) + renderSettledContents(entry.ticket,modal,state,{escape,methodSelect}),
        '訂正を確定',{style:'ops-modal modal-wide'});
      updateSettledContentsPreview(dialog.querySelector('form'));
      return;
    }
    case 'customer-detail':
      present('顧客詳細', customerUI.renderCustomerDetail(customerWorkspaceState(),modal.customerId,customerUIApi()), null, {style:'modal-wide customer-dialog'});
      return;
    case 'customer-new':
    case 'customer-edit':
      present(modal.type === 'customer-new' ? '顧客を登録' : '顧客情報を編集',
        customerUI.renderCustomerForm(customerWorkspaceState(),modal.customerId,customerUIApi()), '顧客情報を保存', {style:'modal-wide customer-dialog'});
      return;
    case 'customer-merge':
      present('顧客の重複を統合', customerUI.renderCustomerMerge(customerWorkspaceState(),modal.customerId,customerUIApi()), '統合を確定', {style:'customer-dialog'});
      return;
    case 'customer-link':
      present('過去の来店をひもづける', customerUI.renderCustomerLink(customerWorkspaceState(),modal.customerId,customerUIApi()), '来店をひもづける', {style:'customer-dialog'});
      return;
    case 'customer-import':
      present('顧客のCSV読み込み', customerUI.renderCustomerImport(customerUIApi()), '顧客をまとめて登録', {style:'modal-wide customer-dialog'});
      return;
    case 'table-auto-extension':
      present('卓別の自動延長',renderTableAutoExtensionSettings(state,tableAutoExtensionModel(modal.autoTableId),
        {escape,icon,tableName}),'卓の設定を保存',{style:'ops-modal table-auto-extension-dialog'});
      return;
    case 'billing-settings':
      present('延長・カード設定',renderBillingSettings(modal.billingTab),'設定を保存',{style:'ops-modal billing-dialog'});
      return;
    case 'print-settings':
      present('印刷設定',renderPrintSettings(getPrintSettings(state),{escape}),'印刷設定を保存',{style:'ops-modal np-print-dialog'});
      return;
    case 'accounting-settings':
      present('会計CSV設定',accountingCsvEditor(state,modal.csvMode ?? 'daily',{escape,icon}),
        'この出力区分を保存',{style:'ops-modal modal-wide'});
      return;
    case 'role-policy':
      present('役職・権限',renderRolePolicy(state,{escape},modal.rolePolicyDraft),'権限を保存',{style:'ops-modal modal-wide'});
      return;
    case 'cash-accounts':
      present('金庫・出金先',renderCashAccounts(state,{escape,icon,yen}),'金庫と出金先を保存',{style:'ops-modal modal-wide'});
      return;
    case 'print-document':
      present(`${printDocumentTitles[modal.printKind]}を印刷`,
        renderPrintOptions({kind:modal.printKind,width:modal.printWidth,recipient:modal.printRecipient,purpose:modal.printPurpose},{escape})
          + `<p class="field-help">印刷画面でも、プリンターの用紙幅を合わせてください。</p><div id="print-preview" class="np-print-preview-frame" aria-label="印刷プレビュー">${renderPendingPrint(modal)}</div>`,
        '印刷する',{style:'ops-modal np-print-dialog'});
      return;
    case 'extension-quote': {
      const estimate = (modal.estimate ??= buildExtensionQuote(modal));
      present('延長見積書を印刷',renderPrintOptions({kind:'extension-quote',width:modal.printWidth},{escape})
        + renderExtensionQuoteOptions(modal)
        + `<div id="print-preview" class="np-print-preview-frame" aria-label="印刷プレビュー">${renderExtensionQuote(estimate,{escape,yen})}</div>
          <div class="ops-actions">${button('延長に戻る','extension-quote-back',{glyph:'clock',tone:'quiet'})}</div>`,
        '印刷する',{style:'ops-modal np-print-dialog'});
      return;
    }
    case 'audit-log':
      present(modal.ticketAuditId ? '伝票の操作履歴' : '監査ログ',renderAuditLog(modal,{escape,icon}),null,{style:'ops-modal'});
      return;
    case 'ops-settings': {
      const register = getRegisterSettings(state);
      present('運用設定',`<p class="form-copy">マネージャーが承認なしで適用できる、小計に対する値引きの上限です。</p>
        ${label('マネージャーの値引き上限（%）',`<input name="managerDiscountLimit" type="number" min="0" max="100" step="0.01" inputmode="decimal" value="${getManagerDiscountLimit(state) / 100}" required>`)}
        <div class="form-grid">${label('営業日が切り替わる時刻',`<input name="registerCutoff" type="time" value="${register.cutoff}" required>`)}
        ${label('営業時間の開始',`<input name="hoursStart" type="time" value="${register.hoursStart}" required>`)}
        ${label('営業時間の終了',`<input name="hoursEnd" type="time" value="${register.hoursEnd}" required>`)}
        ${label('釣銭準備金の初期値',`<select name="openingMode"><option value="fixed">固定額</option><option value="previous"${register.openingMode === 'previous' ? ' selected' : ''}>前回の実残高</option></select>`)}
        ${label('固定額・前回がない場合（円）',`<input name="openingDefault" type="number" min="0" max="${cashEntryMaximum}" value="${register.openingCash}" required>`)}</div>`,
      '運用設定を保存',{style:'ops-modal'});
      return;
    }
    case 'calculation-settings':
      present('税とサービス料の計算設定',renderCalculationSettings(),'計算設定を保存',{style:'ops-modal'});
      return;
    case 'ops-notices':
      present('営業のお知らせ',renderOperationalNotices(),null,{style:'ops-modal'});
      return;
    case 'set-schedule':
      present('時間帯別セット',renderInitialSetSchedule(state,{escape,yen}),'時間帯別セットを保存',{style:'ops-modal modal-wide'});
      return;
    case 'ops-guide':
      present('操作ガイド',`${label('操作を検索','<input type="search" name="guideSearch" placeholder="例　レシートを印刷したい" autocomplete="off" maxlength="80">')}
        ${!cloudState.store && !demoPractice ? renderPracticeEntry() : ''}
        <section class="ops-guide-answer" data-guide-answer aria-live="polite" hidden><strong></strong><p></p></section>
        <div data-guide-results aria-live="polite">${guideList('')}</div>`,null,{style:'ops-modal'});
      return;
    case 'cast-clock-in':
      present('出勤を打刻','<p class="form-copy">現在の時刻を出勤時刻として記録します。</p>','出勤を確定',{style:'ops-modal'});
      return;
    case 'cast-clock-out':
      present('退勤を打刻',`<p class="form-copy">現在の時刻を退勤時刻として記録します。</p>
        ${label('休憩時間（分）','<input type="number" name="castBreakMinutes" min="0" max="1440" step="1" inputmode="numeric" value="0" required>')}`,
        '退勤を確定',{style:'ops-modal'});
      return;
    case 'cast-request-shift':
      present('勤務希望を送る',renderCastShiftRequest(modal.date,{escape}),'勤務希望を送信',{style:'ops-modal'});
      return;
    case 'cast-request-pay':
      present('日払いを申請',`${modal.dailyPayLimit ? `<p class="form-copy">申請目安 ${yen(modal.dailyPayLimit.limit)}</p>` : ''}
        ${label('申請額（円）','<input type="number" name="dailyPayAmount" min="1" max="100000000" step="1" required inputmode="numeric">')}
        ${operationReason({title:'申請メモ（任意）',required:false})}`,'日払い申請を送信',{style:'ops-modal'});
      return;
    case 'attendance-review': {
      const entry = listCastAttendance(state).find(({id})=>id === modal.attendanceId);
      const person = [...state.cast,...(state.archivedCast ?? [])].find(({id})=>id === entry.castId);
      present('勤怠を確認',`<div class="modal-context">${icon('clock',16)}<strong>${escape(person?.name ?? entry.castId)}</strong>
        <span>${escape(entry.date)}${entry.minutes != null ? ` ／ 実働 ${entry.minutes}分` : ' ／ 勤務中'}</span></div>
        ${label('確認結果',`<select name="attendanceDecision">${entry.status === 'pending' ? '<option value="approve">承認</option>' : ''}<option value="reject">却下</option></select>`)}
        ${operationReason({title:'確認理由（却下時は必須）',required:false})}`,'確認結果を保存',{style:'ops-modal'});
      return;
    }
    case 'attendance-editor': {
      const entry = listCastAttendance(state).find(({id})=>id===modal.attendanceId);
      present(entry ? '勤怠を訂正' : '勤怠を代理登録',renderManagedAttendance(state,entry,{escape,icon}),
        '勤怠を保存',{style:'ops-modal modal-wide'});
      return;
    }
    case 'attendance-staff-editor': {
      const entry = getStaffLabor(state).attendance.find(({id})=>id === modal.staffAttendanceId);
      present(entry ? '勤務を訂正' : '勤務を記録',renderStaffAttendanceForm(state,entry,{escape}),'勤務を保存',{style:'ops-modal'});
      return;
    }
    case 'attendance-staff-void': {
      const entry = getStaffLabor(state).attendance.find(({id})=>id === modal.staffAttendanceId);
      present('勤務を取り消す',`<p class="form-copy">${escape(entry.date)}の${escape(entry.personName)}の勤務を取り消します。</p>
        ${operationReason({title:'取消理由'})}`,'勤務を取り消す',{style:'ops-modal'});
      return;
    }
    case 'labor-person': {
      const person = getStaffLabor(state).people.find(({id})=>id === modal.staffPersonId);
      present(person ? '勤務者を編集' : '勤務者を登録',renderStaffPersonForm(state,person,{escape}),'勤務者を保存',{style:'ops-modal'});
      return;
    }
    case 'labor-rate': {
      const person = getStaffLabor(state).people.find(({id})=>id === modal.staffPersonId);
      present('勤務者の時給を登録',renderStaffRateForm(state,person,{escape}),'時給を保存',{style:'ops-modal'});
      return;
    }
    case 'payroll-employee':
      present('従業員台帳',payrollUI.renderEmployeeProfile(state,modal.selection.castId,{escape}),'台帳を保存',{style:'ops-modal modal-wide'});
      return;
    case 'payroll-attendance-items':
      present('勤怠項目',payrollUI.renderAttendanceItems(state,{escape,icon}),'勤怠項目を保存',{style:'ops-modal modal-wide'});
      return;
    case 'payroll-settings':
      present('給与設定',payrollUI.renderPayrollSettings(state,{escape,icon}),'給与設定を保存',{style:'ops-modal modal-wide'});
      return;
    case 'payroll-variables':
      present('給与の個人別変数',payrollUI.renderPayrollVariables(state,modal.selection.castId,{escape,icon}),
        '変数を保存',{style:'ops-modal modal-wide'});
      return;
    case 'payroll-batch':
      present('確定明細を一括出力',payrollUI.renderPayrollBatch(state,modal.selection,{escape}),'出力する',{style:'ops-modal'});
      return;
    case 'payroll-range':
      present('日付指定の給与集計',payrollUI.renderPayrollRange(state,modal,{escape,icon,yen}),'集計する',{style:'ops-modal modal-wide'});
      return;
    case 'payroll-templates':
      present('給与の計算テンプレート',payrollUI.renderPayrollTemplates(state,modal.selection,{escape,icon}),
        modal.selection.castId ? '割り当てを保存' : '',{style:'ops-modal modal-wide'});
      return;
    case 'payroll-template-editor': {
      const template = getPayrollTemplates(state).find(({id}) => id === modal.templateId);
      present(template ? 'テンプレートを編集' : 'テンプレートを追加',payrollUI.renderPayrollTemplateEditor(template,{escape,icon,state,variables:getPayrollVariables(state)}),
        'テンプレートを保存',{style:'ops-modal modal-wide'});
      return;
    }
    case 'payroll-template-remove': {
      const template = getPayrollTemplates(state).find(({id}) => id === modal.templateId);
      present('テンプレートを削除',`<p class="form-copy">「${escape(template.name)}」を削除します。</p>`,'削除する',{style:'ops-modal'});
      return;
    }
    case 'shift-editor':
      present(modal.shiftId ? 'シフトを編集' : 'シフトを登録',renderShiftEditor(state,{shiftId:modal.shiftId,date:modal.shiftDate,escape}),
        'シフトを保存',{style:'ops-modal'});
      return;
    case 'shift-remove':
      present('シフトを削除','<p class="form-copy">選択したシフトを予定表から削除します。</p>','削除する',{style:'ops-modal'});
      return;
    case 'payroll-rate':
      present('時給を登録',payrollUI.renderPayrollRate(state,modal.selection,{escape}),'時給を保存',{style:'ops-modal'});
      return;
    case 'payroll-draft': {
      const {month,castId} = modal.selection;
      const draft = getPayrollDraft(state,month,castId) ?? {month,work:[{}],allowances:[],deductions:[],manualAdvance:0};
      present('給与の下書き',payrollUI.renderPayrollDraft(draft,{escape,icon}),'下書きを保存',{style:'ops-modal modal-wide'});
      return;
    }
    case 'payroll-finalize': {
      const {month,castId} = modal.selection;
      const draft = getPayrollDraft(state,month,castId);
      let pay;
      try {
        pay = previewPayroll(state,draft);
      } catch (error) {
        if (!(error instanceof MissingPayrollRateError)) throw error;
        present('給与を確定',`<p class="form-copy">${escape(error.message)}</p>
          ${button('時給を登録','payroll-rate',{glyph:'wallet'})}`,null,{style:'ops-modal'});
        return;
      }
      present('給与を確定',`<div class="result-bar"><span>${escape(month)} ／ ${escape(pay.castName)}</span><strong>${yen(pay.net)}</strong></div>
        <p class="form-copy">確定時点の金額を支給明細として保存します。訂正が必要な場合は、翌月の手当または控除で調整してください。</p>`,
        '確定して明細を保存',{style:'ops-modal'});
      return;
    }
    case 'payroll-request-pay':
      present('日払いを申請登録',payrollUI.renderDailyPayRequest(state,modal.selection,{yen}),'申請を保存',{style:'ops-modal'});
      return;
    case 'payroll-review-pay': {
      const entry = getPayrollDailyPays(state).find(({id}) => id === modal.dailyPayId);
      const {limit,committed} = getDailyPayLimit(state,entry.month,entry.castId);
      present('日払い申請を確認',`<div class="result-bar"><span>${escape(entry.castName)}</span><strong>${yen(entry.amount)}</strong></div>
        ${committed > limit ? `<p class="ops-highlight">日払いの目安 ${yen(limit)} を超えています。理由を記録してください。</p>` : ''}
        ${label('審査結果',`<select name="dailyPayDecision">${entry.status === 'requested' ? '<option value="approve">承認</option>' : ''}<option value="reject">却下</option></select>`)}
        ${operationReason({title:'審査理由',required:false})}`,'審査結果を保存',{style:'ops-modal'});
      return;
    }
    case 'payroll-pay': {
      const entry = getPayrollDailyPays(state).find(({id}) => id === modal.dailyPayId);
      present('日払いの支給を記録',`<div class="result-bar"><span>${escape(entry.castName)}</span><strong>${yen(entry.amount)}</strong></div>
        ${label('支給方法','<select name="dailyPayMethod"><option value="cash">現金</option><option value="bank">振込</option></select>','現金はレジからの出金として記録します。')}`,
        '支給を確定',{style:'ops-modal'});
      return;
    }
    case 'demo':
      if (demoPractice) {
        present('体験クエスト','<p class="form-copy">体験クエストの練習中です。</p>' + button('練習を終了','practice-stop'),null,{style:'ops-modal'});
        return;
      }
      present('サンプル操作',`${renderPracticeEntry()}<p class="form-copy">開店から試すと、現在の卓配置と店舗設定で営業をやり直せます。ほかのサンプルを選ぶと、店舗設定・卓配置・操作履歴がサンプルの初期状態に戻ります。</p><div class="demo-options">${button('開店から試す','demo-start',{glyph:'power',tone:'primary'})}${button('営業中のサンプルを読み込む','demo-live',{glyph:'refresh'})}${button('入出金と日報を試す','demo-cash',{glyph:'cash'})}${button('期間集計とCSVを試す','demo-reports',{glyph:'download'})}${button('滞在・指名分析を試す','demo-analytics',{glyph:'chart'})}${button('自動延長とカード会計を試す','demo-billing',{glyph:'clock'})}${button('給与・日払いを試す','demo-payroll',{glyph:'wallet'})}${button('勤怠・人件費を試す','demo-labor',{glyph:'users'})}${button('顧客のお知らせを試す','demo-customer-notices',{glyph:'bell'})}</div>
        <section aria-labelledby="demo-role-label"><h3 id="demo-role-label">デモの権限</h3><p class="form-copy">現在の権限は${escape(currentRoleLabel())}です。同じデモデータで役割を切り替えて確認できます。</p><div class="ops-actions">${['admin','manager','staff','cast'].map((role) =>
          button(`${cloudLabels[role]}で試す`,'demo-role',{id:role,tone:!currentProfileId()&&role===demoRole?'primary':'secondary'})).join('')}
          ${Object.entries(state.rolePolicy?.custom ?? {}).map(([id,{label}]) => button(`${escape(label)}で試す`,'demo-role',
            {id,tone:currentProfileId()===id?'primary':'secondary'})).join('')}</div></section>`,null,{style:'ops-modal'});
      return;
    case 'open': {
      const current = businessDate(Date.now(),registerCutoff(state));
      const latest = state.closedDays[0]?.date;
      const suggested = latest && current <= latest ? new Date(Date.parse(latest)+86400000).toISOString().slice(0,10) : current;
      const register = getRegisterSettings(state);
      present('開店処理',`<p class="form-copy">営業時間 ${register.hoursStart}〜${register.hoursEnd}</p><div class="form-grid">
        ${label('営業日',`<input name="date" type="date" required value="${suggested}">`,`営業日の切替は${register.cutoff}です。`)}
        ${label('釣銭準備金（円）',`<input name="openingCash" type="number" min="0" step="1" required value="${openingCashSuggestion(state,suggested)}" inputmode="numeric">`)}</div>`,'開店を確定');
      return;
    }
    case 'seat': {
      const first = modal.tableId ? [modal.tableId] : [];
      const isVip = state.tables.some((table) => table.id === modal.tableId && table.area === 'VIP');
      const suggested = suggestInitialSet(state);
      const initialSetId = suggested?.id ?? (isVip ? 'vip60' : undefined);
      const options = getAvailableInitialSets(state).map((item)=>`<option value="${escape(item.id)}" ${item.id===initialSetId ? 'selected' : ''}>${escape(item.name)}${item.name.includes(`${item.duration}分`) ? '' : ` · ${item.duration}分`} · ${yen(item.price)}/人</option>`).join('');
      const customerChoice = currentRoleAllows('customers') ? customerUI.renderSeatCustomer(
        customerWorkspaceState(),customerUIApi(),{query:modal.seatCustomerQuery ?? '',selected:modal.seatCustomerId ?? ''}) : '';
      present('来店登録',`<div class="form-grid">${label('来店人数','<input name="guests" type="number" min="1" max="100" step="1" value="2" required inputmode="numeric">')}${label('初回セット',`<select name="setId">${options}</select>`,suggested ? '現在の時間帯に合うセットを選択しています。変更できます。' : '')}</div>${customerChoice}
        <details class="arrival-time-detail"><summary>来店時刻を指定</summary>${label('実際の来店日時（日本時間）',
          '<input type="datetime-local" name="arrivedAt">','未入力の場合は、登録した時刻を使います。')}</details>
        ${seatPicker(first,{primary:modal.tableId})}<p class="field-help">同じグループで複数卓を使う場合は、追加の卓も選択します。伝票・残り時間・会計は全卓で共有します。</p>`,'来店を確定',{style:'modal-wide'});
      return;
    }
    case 'move':
      present('卓移動・連結',`${headline}<p class="form-copy">移動先または追加する卓を選択してください。チェックを外した卓は、確定時に空席になります。</p>${seatPicker(ticket.tableIds,{ticketId:id})}`,'卓の変更を確定',{style:'modal-wide'});
      return;
    case 'order':
      present('注文を追加',`${headline}<div class="order-tools"><div class="seg order-seg" role="group" aria-label="メニューのカテゴリ">${orderCategoryNames().map((text)=>`<button type="button" data-action="category" data-id="${escape(text)}" aria-pressed="${modal.category===text}">${escape(text)}</button>`).join('')}</div><label class="field"><span class="sr-only">メニュー検索</span><input id="menu-search" placeholder="メニューを検索" value="${escape(modal.search)}"></label></div><div id="order-products">${renderProducts()}</div><div id="order-selection">${renderProductDetails()}</div><div id="order-cart" aria-live="polite">${renderOrderCart()}</div><div id="order-service-preview" role="status"></div>`,'注文を確定',{style:'modal-wide'});
      updateOrderServicePreview();
      return;
    case 'extend': {
      const activePlanId = modal.extensionId ?? extensionPlans()[0]?.id;
      const options = extensionPlans().map((plan, index)=> {
        const next = apply(state,{type:'extend',ticketId:id,menuId:plan.id});
        const final = quote(next,id);
        const newTicket = next.tickets.find((current)=>current.id===id);
        return `<label class="extend-option"><input type="radio" name="extensionId" value="${escape(plan.id)}" ${(modal.extensionId ? modal.extensionId === plan.id : index === 0) ? 'checked' : ''}><span><strong>${escape(plan.name)}</strong><small>${plan.duration}分 · 終了予定 ${dateTime.format(newTicket.endsAt)}</small></span><span><strong class="money">+${yen(final.total-q.total)}</strong><small>延長後 ${yen(final.total)}</small></span></label>`;
      }).join('');
      present('セットを延長',`${headline}<p class="form-copy">人数、指名料、サービス料・税を含めた追加額です。</p><fieldset class="choices extend-choices"><legend class="sr-only">延長時間</legend>${options}</fieldset>
        <div id="extension-mix">${renderExtensionMix(ticket,activePlanId,modal.extensionMix)}</div>
        <div class="ops-actions">${button('延長見積書','extension-quote',{glyph:'printer'})}</div>`,'延長を確定');
      updateExtensionMixPreview();
      return;
    }
    case 'seat-history': {
      const history = ticket.tableHistory ?? [];
      present('使用卓の履歴', `${headline}${history.length ? `<ol class="seat-history">${history.map((entry) => `<li><span class="metric-icon">${icon('table',17)}</span><div><strong>${escape(tableName(entry.tableId))}</strong><p>${dateTime.format(entry.attachedAt)} 〜 ${entry.releasedAt ? dateTime.format(entry.releasedAt) : '使用中'} · JST</p></div></li>`).join('')}</ol>` : '<p class="form-copy">この伝票の使用卓履歴はありません。</p>'}`, null);
      return;
    }
    case 'extend-overdue': {
      const now = Date.now();
      const options = extensionPlans().flatMap((plan) => {
        const count = getOverdueExtensionCount(ticket,plan,now);
        if (count < 1 || count > maxOverdueExtensionCount) return [];
        try {
          const preview = apply(state,{type:'extendOverdue',ticketId:id,menuId:plan.id,expectedCount:count},now);
          const newTicket = preview.tickets.find((entry) => entry.id === id);
          return [{plan,count,endsAt:newTicket.endsAt,total:quote(preview,id).total}];
        } catch {
          return [];
        }
      });
      modal.overdueExtensionCounts = new Map(options.map(({plan,count}) => [plan.id,count]));
      const choices = options.map(({plan,count,endsAt,total},index) =>
        `<label class="extend-option"><input type="radio" name="extensionId" value="${escape(plan.id)}"${index === 0 ? ' checked' : ''}>
          <span><strong>${escape(plan.name)}</strong><small>${plan.duration}分 × ${count}回 · 終了予定 ${dateTime.format(endsAt)}</small></span>
          <span><strong class="money">+${yen(total-q.total)}</strong><small>延長後 ${yen(total)}</small></span></label>`).join('');
      const body = choices
        ? `<p class="form-copy">終了予定 ${dateTime.format(ticket.endsAt)} から現在までの超過分を、選んだプランの時間単位で切り上げて登録します。</p><fieldset class="choices extend-choices"><legend class="sr-only">一括延長プラン</legend>${choices}</fieldset>
          <div id="extension-mix">${renderExtensionMix(ticket,options[0].plan.id)}</div>`
        : '<p class="form-copy">一括延長できるプランがありません。超過時間と延長プランを確認してください。</p>';
      present('超過分を一括延長',headline + body,choices ? '一括延長を確定' : null);
      return;
    }
    case 'deposit':
    case 'edit-deposit': {
      const entry = currentDeposit();
      if (modal.type === 'edit-deposit' && !entry) {
        present('前受金を訂正','<p class="form-copy">前受金が見つかりません。伝票を開き直してください。</p>',null);
        return;
      }
      present(entry ? '前受金を訂正' : '前受金を登録',`${headline}<p class="form-copy">残りのお支払いは <strong>${yen(q.remaining)}</strong> です。</p>
        <div class="form-grid">${label('支払方法',methodSelect('depositMethod',entry?.method))}
        ${label('会計に充当する額（円）',`<input name="depositAmount" type="number" min="1" max="${q.remaining + (entry?.amount ?? 0)}" value="${entry?.amount ?? ''}" required inputmode="numeric" placeholder="3000">`)}</div>
        <div class="payment-brand-fields" data-deposit-brand-fields>${renderPaymentBrandFields({method:entry?.method ?? 'cash',brandId:savedDepositPaymentTerms},entry,'deposit')}</div>
        <div class="card-fee-preview" data-deposit-fee-preview aria-live="polite" hidden></div>
        ${label('前受金メモ（任意）',`<input name="depositMemo" maxlength="120" value="${escape(entry?.memo ?? '')}">`)}
        ${entry ? operationReason({title:'訂正理由'}) : ticket.deposits.length ? `<ul class="deposit-list">${ticket.deposits.map((row)=>
          `<li><span>${escape(row.brandName || tenderMethods[row.method])} · ${yen(depositGrossAmount(row))}${row.cardFee ? `（加算 ${yen(row.cardFee)}）` : ''}${row.memo ? ' ／ ' + escape(row.memo) : ''}</span>
            <div class="ops-actions">${button('訂正','edit-deposit',{id:row.id})}${button('取消','cancel-deposit',{id:row.id,tone:'danger'})}</div></li>`).join('')}</ul>` : ''}`,
        entry ? '訂正を保存' : '前受金を確定');
      updateDepositPreview();
      return;
    }
    case 'personal-sales-adjustment': {
      const people = getAdjustablePersonalSalesPeople(state,ticket);
      present('個人売上を調整',headline + renderPersonalSalesAdjustment(ticket,people,q.commission,{escape,yen}),
        people.length ? '調整を記録' : null,{style:'ops-modal'});
      return;
    }
    case 'discount':
      present('値引きを設定',headline + renderDiscountForm({ticket,subtotal:q.subtotal,priceMode:q.priceMode,
        limit:getManagerDiscountLimit(state),role:currentRole(),reasonCodes:discountReasonCodes},{escape,yen}),
      currentRole() === 'manager' ? '値引きを保存・申請' : '値引きを確定',{style:'ops-modal'});
      return;
    case 'discount-review':
    case 'discount-reject': {
      const request = ticket.discountRequest;
      if (!request || request.id !== modal.requestId) { present('値引き申請','<p class="form-copy">この申請は更新されています。伝票から開き直してください。</p>',null); return; }
      const rejecting = modal.type === 'discount-reject';
      const body = `${headline}<div class="result-bar"><span>申請額</span><strong>${yen(request.amount)}</strong></div>
        <p class="form-copy">${escape(discountReasonCodes[request.reasonCode])} · ${escape(request.reason)}</p>
        <p class="field-help">申請者 ${escape(request.actor?.label)} · 申請時の小計 ${yen(request.subtotal)}</p>
        <p class="field-help">${personalSalesDiscountModes[request.personalSalesMode] ?? personalSalesDiscountModes.reflect}</p>
        ${!rejecting && q.subtotal !== request.subtotal ? '<p class="ops-highlight">明細の小計が変わりました。却下してから、現在の小計で申請し直せます。</p>' : ''}
        ${operationReason({title:rejecting?'却下理由':'承認メモ（任意）',required:rejecting})}
        ${rejecting ? '' : button('却下する','discount-reject',{id,tone:'danger'})}`;
      present(rejecting?'値引き申請を却下':'値引き申請の確認',body,
        rejecting?'却下を確定':q.subtotal === request.subtotal ? '値引きを承認' : null,{style:'ops-modal'});
      return;
    }
    case 'settle':
      present('お会計',`${headline}${isVisitAutoExtensionPaused(ticket) ? renderVisitAutoExtensionPaused({icon}) : ''}${totalRows(q,{large:true})}${q.remaining > 0 ? `<p class="form-copy payment-copy">${getCardFeeSettings(state).enabled || getCardFeeSettings(state).brands?.some(({enabled})=>enabled)
        ? '加算前の支払額を入力します。外部端末には表示された決済額を入力してください。'
        : 'カード・QRは、外部端末で受け取った金額を記録します。'}</p><div id="payment-rows">${modal.payments.map(renderPayment).join('')}</div>${button('支払方法を追加','add-payment',{glyph:'plus',tone:'quiet'})}
        <div id="payment-note" class="result-bar" aria-live="polite"></div><div id="cash-tender" hidden>
          ${label('現金のお預かり額（任意）',`<input name="cashReceived" type="number" min="1" max="${cashEntryMaximum}" step="1" inputmode="numeric" placeholder="お客様から受け取った現金" aria-describedby="cash-tender-change" disabled>`)}
          <div id="cash-tender-change" class="result-bar" aria-live="polite"><span>お釣り</span><strong>—</strong></div>
        </div><div id="card-fee-preview" class="card-fee-preview" aria-live="polite" hidden></div>` : `<p class="form-copy payment-copy">前受金で全額を充当しました。会計を確定できます。</p>`}`,'会計を確定');
      if (q.remaining > 0) updatePaymentNote();
      return;
    case 'depart':
      present('退店を確定',`${headline}<p class="form-copy">${escape(titles(ticket))}を空席に戻します。確定済みの伝票は営業レポートから確認できます。</p>`,'退店・卓を解放');
      return;
    case 'receipt':
      present(`会計内訳 No. ${ticket.number}`, headline + receiptBody(ticket, q) + receiptActions(ticket,state.day.date) + ticketAuditButton(ticket,state.day.date), null);
      return;
    case 'history-receipt': {
      const archived = modal.receipt;
      const labels = getTicketTableLabels(state, archived).join('・');
      const info = [labels, `${archived.admittedGuests ?? archived.guests}名`, archived.customer].filter(Boolean).map(escape).join(' · ');
      const header = `<div class="modal-context">${icon('calendar',16)}<strong>${escape(modal.date)}</strong><span>${info}</span></div>`;
      const totals = archived.settlement ?? quote({ ...state, tickets: [archived] }, archived.id);
      present(`会計内訳 No. ${archived.number}`, header + receiptBody(archived, totals) + receiptActions(archived,modal.date) + ticketAuditButton(archived,modal.date), null);
      return;
    }
    case 'cancel-settlement':
      present('会計を取り消す',`${headline}<div class="result-bar"><span>取消対象の会計</span><strong>${yen(q.total)}</strong></div>
        <p class="form-copy">伝票 No. ${ticket.number} の売上・確定歩合・支払記録を取り消し、注文で引いた在庫を戻します。会計と支払の内訳は取消履歴から確認できます。実際の返金は、受け付けた決済手段で処理してください。</p>
        ${operationReason({title:'会計の取消理由'})}`,'会計取消を確定',{style:'ops-modal'});
      return;
    case 'cancelled-receipt': {
      const {record} = modal;
      const receipt = record.receipt;
      const current = state.tickets.find((item) => item.id === record.ticketId);
      const reopen = canCorrectToday(record.date) && current?.status === 'cancelled'
        ? button('伝票を再オープン','reopen-ticket',{id:current.id,glyph:'refresh',tone:'primary'}) : '';
      present(`取消済みの会計 No. ${record.ticketNumber}`,`<p class="ops-highlight">取消済み · ${escape(record.date)}<br>${escape(record.reason)}</p>
        ${receiptBody(receipt,receipt.settlement)}${reopen}`,null,{style:'ops-modal'});
      return;
    }
    case 'reopen-ticket': {
      const previous = ticket.tableIds.filter((tableId) => state.tables.some((row) => row.id === tableId) && !getTicketForTable(state,tableId));
      present('伝票を再オープン',`${headline}<p class="form-copy">空席を選ぶと元の注文を引き継ぎ、取消時に戻した在庫を引き直して未会計の伝票に戻します。</p>
        ${seatPicker(previous,{ticketId:id})}${operationReason({title:'再オープンの理由'})}`,'再オープンを確定',{style:'ops-modal'});
      return;
    }
    case 'cancel-line': {
      const line = ticket.lines.find((item)=>item.id===modal.lineId);
      present('注文を取り消す',`${headline}<p class="form-copy">${escape(line.name)} ×${line.quantity}（${yen(line.total)}）を取り消します。</p>${line.stockUses.length ? `<label class="inline-check"><input type="checkbox" name="returnStock" ${line.providedAt ? 'disabled' : 'checked'}>未提供で再利用できる在庫を戻す</label>` : ''}${operationReason({title:'注文の取消理由'})}`,'注文を取り消す');
      return;
    }
    case 'edit-ticket-line': {
      const line = ticket?.lines.find((entry)=>entry.id === modal.lineId && entry.cancelledAt === null);
      if (!line) { present('注文を訂正','<p class="form-copy">最新の伝票を開き直してください。</p>',null); return; }
      const menu = state.menu.find(({id})=>id === line.menuId);
      const selectedCast = new Set(line.castIds);
      const available = [...state.cast,...(state.archivedCast ?? [])].filter((person)=>selectedCast.has(person.id)
        || (person.enabled !== false && state.cast.includes(person)));
      const options = line.category === 'セット' ? '' : `<fieldset class="choices"><legend>歩合を付けるキャスト</legend><div class="choice-grid">
        ${available.map((person)=>`<label class="choice"><input type="checkbox" name="castIds" value="${escape(person.id)}"${selectedCast.has(person.id) ? ' checked' : ''}><span>${escape(person.name)}</span></label>`).join('')}
        </div></fieldset>`;
      const serviceControl = line.serviceEligible === true && canExcludeOrderService(state,currentRole())
        ? `${orderServiceChoice(line.serviceExcluded === true)}<div id="order-service-preview" role="status"></div>` : '';
      present('注文を訂正',`${headline}<p class="form-copy">${escape(line.name)}${(line.stockUses.length || menu?.recipe?.length) && line.providedAt
        ? '。提供済みの在庫は、請求数量を減らしても戻りません。' : ''}</p><div class="form-grid">
        ${label('数量',`<input type="number" name="quantity" min="1" max="100" required inputmode="numeric" value="${line.quantity}">`)}
        ${label('単価（円）',`<input type="number" name="linePrice" min="0" max="100000000" required inputmode="numeric" value="${line.price}">`)}
        </div>${options}${serviceControl}${operationReason({title:'注文の訂正理由'})}`,'注文の訂正を保存',{style:'ops-modal'});
      updateOrderServicePreview();
      return;
    }
    case 'cancel-ticket-extension': {
      const line = ticket?.lines.find((entry)=>entry.id === modal.lineId && entry.cancelledAt === null);
      if (!line) { present('延長を取り消す','<p class="form-copy">最新の伝票を開き直してください。</p>',null); return; }
      present('延長を取り消す',`${headline}<p class="form-copy">${escape(line.name)} ×${line.quantity}と同時に登録した延長指名料を取り消します。</p>
        ${operationReason({title:'延長の取消理由'})}`,'延長を取り消す',{style:'ops-modal'});
      return;
    }
    case 'close': {
      const outstanding = state.tickets.filter((item)=>['open','paid'].includes(item.status));
      const totals = summary(state);
      if (outstanding.length) {
        present('閉店処理',`<p class="form-copy">会計または退店が完了していない伝票があります。卓を開いて処理を完了してください。</p><ul class="outstanding">${outstanding.map((row)=>`<li>${button(`${escape(titles(row))} · ${row.status==='paid'?'退店待ち':'未会計'}`,'open-ticket',{glyph:'chevron-right',id:row.id,cls:'btn-block'})}</li>`).join('')}</ul>`,null);
        return;
      }
      modal.expectedCash = totals.expectedCash;
      present('閉店処理',renderRegisterClose(totals),'閉店を確定',{style:'ops-modal cash-dialog'});
      return;
    }
    case 'record-cash':
      if (state.day.status !== 'open') { present('入出金を記録','<p class="form-copy">開店後に入出金を記録できます。</p>',null); return; }
      present('入出金を記録',renderCashMovementForm(),'入出金を保存',{style:'ops-modal cash-dialog'});
      return;
    case 'edit-cash-movement':
    case 'void-cash-movement': {
      const entry = editableCashMovement(state,modal.movementId);
      const editing = modal.type === 'edit-cash-movement';
      present(editing ? '入出金を訂正' : '入出金を取り消す',
        (editing ? renderCashMovementForm(entry) : `<p class="form-copy">${escape(entry.date)}の入出金 ${yen(entry.amount)} を取り消します。</p>`)
        + label('訂正理由','<textarea name="cashCorrectionReason" maxlength="120" rows="2" required></textarea>'),
        editing ? '訂正を保存' : '取消を確定',{style:'ops-modal cash-dialog'});
      return;
    }
    case 'correct-register-count': {
      const record = state.closedDays.find(({date}) => date === modal.closeDate);
      modal.expectedCash = record.expectedCash;
      present('閉店時の実残高を訂正',renderRegisterClose({expectedCash:record.expectedCash},record),'訂正を保存',
        {style:'ops-modal cash-dialog'});
      if (record.cashDenominations) {
        dialog.querySelector('[name=countByDenomination]').checked = true;
        updateCashDenominations();
      }
      return;
    }
    case 'stock-adjust': {
      const stock = state.stock.find(({id}) => id === modal.stockId);
      const unit = escape(stock.unit);
      const cost = stock.defaultUnitCost ?? stock.unitCost;
      present('在庫の入出庫',`<p class="form-copy">${escape(stock.name)} · 現在庫 <strong>${number.format(stock.quantity)} ${unit}</strong></p>
        <div class="form-grid">${label('入出庫の種類', `<select name="stockAdjustmentMode">
          <option value="purchase">仕入れ・入庫</option><option value="loss">廃棄・破損（ロス）</option>
          <option value="usage">店舗消費</option><option value="adjust">その他の数量調整</option></select>`)}
        ${label(`入庫数量（${unit}）`, `<input name="quantity" type="number" min="0.000001" max="1000000" step="0.000001" inputmode="decimal" data-stock-unit="${unit}" required>`)}
        </div><div data-stock-purchase>${label(`今回の仕入単価（円 / ${unit}）`,
          `<input name="purchaseUnitCost" type="number" min="0" max="100000000" step="0.000001" inputmode="decimal" value="${cost}" required>`,
          'この単価で入庫し、在庫の平均原価を更新します。')}
          <label class="inline-check"><input type="checkbox" name="adoptStockUnitCost">この単価を次回の参考単価にする</label></div>
        ${operationReason()}`,'入出庫を記録',{style:'ops-modal'});
      return;
    }
    case 'stocktake': {
      const stock = state.stock.find(({id}) => id === modal.stockId);
      const unit = escape(stock.unit);
      present('棚卸を記録',`<p class="form-copy">${escape(stock.name)} · 帳簿在庫 <strong>${number.format(modal.bookQuantity)} ${unit}</strong></p>
        ${label(`実際に数えた在庫（${unit}）`, '<input name="actualQuantity" type="number" min="0" max="1000000" step="0.000001" inputmode="decimal" required>',
          '数えた数量で在庫を更新し、差がない場合も棚卸履歴に記録します。')}
        ${operationReason({title:'棚卸メモ'})}`,'棚卸を確定',{style:'ops-modal'});
      return;
    }
    case 'stock-cancel-purchase': {
      const entry = state.movements.find(({id}) => id === modal.purchaseId);
      const blocker = purchaseCancellationBlocker(state,entry);
      present('入庫を取り消す',blocker ? `<p class="form-copy">${escape(blocker)}</p>`
        : `<p class="form-copy">${escape(entry.stockName)}の入庫 ${number.format(entry.quantity)}${escape(entry.unit)} を取り消し、平均原価を再計算します。</p>
          ${operationReason({title:'取消理由'})}`,blocker ? null : '入庫取消を確定',{style:'ops-modal'});
      return;
    }
  }
}

function printData(source, ticket, options, issued) {
  const {printKind:kind, printDate:date, printWidth:width, printRecipient:recipient, printPurpose:purpose} = options;
  const records = getPrintDocuments(source,ticket,date,kind);
  return {
    ticket, kind, date, recipient, purpose,
    tables:getTicketTableLabels(source,ticket),
    totals:kind === 'check' || !ticket.settlement ? quote({...source,tickets:[ticket]},ticket.id) : ticket.settlement,
    settings:{...(options.printSettings ?? getPrintSettings(source)),width},
    storeName:cloudState.store?.name ?? '銀座店',
    issueNumber:issued?.number ?? (records.at(-1)?.number ?? 0) + 1,
    issuedAt:(kind === 'check' ? issued?.at : records[0]?.at) ?? Date.now(),
  };
}

function renderPendingPrint(options) {
  const ticket = findPrintableTicket(state,options.printTicketId,options.printDate);
  return ticket ? renderPrintPreview(printData(state,ticket,options),{escape,yen}) : '';
}

function renderExtensionMix(ticket, menuId, preset) {
  const primary = extensionPlans().find(({id}) => id === menuId);
  const plans = extensionPlans().filter(({duration}) => duration === primary?.duration);
  if (!ticket || ticket.guests < 2 || plans.length < 2 || plans.length > 24) return '';
  const value = (id) => preset?.find(({menuId:planId}) => id === planId)?.quantity ?? (preset ? 0 : id === menuId ? ticket.guests : 0);
  return `<label class="inline-check"><input type="checkbox" name="splitExtension"${preset ? ' checked' : ''}>同じ時間のプランを人数別に組み合わせる</label>
    <fieldset class="choices" data-extension-allocations${preset ? '' : ' hidden disabled'}><legend>プラン別の人数（合計 ${ticket.guests}名）</legend>
      <div class="form-grid">${plans.map(({id,name,price}) => label(escape(name),
        `<input name="extensionPlanQuantity" data-plan-id="${escape(id)}" value="${value(id)}" type="number" min="0" max="${ticket.guests}" step="1" inputmode="numeric">`,
        `${yen(price)} / 人`)).join('')}</div>
      <div class="result-bar" data-extension-mix-preview aria-live="polite"></div>
    </fieldset>`;
}

function readExtensionMix(form) {
  if (!form.querySelector('[name=splitExtension]')?.checked) return undefined;
  const fields = [...form.querySelectorAll('[name=extensionPlanQuantity]')];
  if (fields.some((field) => !field.validity.valid)) throw new Error('プラン別の人数は0名以上の整数を入力してください。');
  return fields.filter(({value}) => Number(value) > 0).map(({dataset,value}) => ({menuId:dataset.planId,quantity:Number(value)}));
}

function extensionCommand(form) {
  const menuId = form.querySelector('[name=extensionId]:checked')?.value;
  const plans = readExtensionMix(form);
  if (!menuId) throw new Error('延長プランを選択してください。');
  const overdue = modal.type === 'extend-overdue';
  const expectedCount = modal.overdueExtensionCounts?.get(menuId);
  return {type:overdue ? 'extendOverdue' : 'extend',ticketId:modal.ticketId,
    ...(plans !== undefined ? {plans} : {menuId}),...(overdue && {expectedCount})};
}

function updateExtensionMixPreview() {
  const fields = dialog.querySelector('[data-extension-allocations]');
  if (!fields) return;
  const enabled = dialog.querySelector('[name=splitExtension]').checked;
  fields.disabled = fields.hidden = !enabled;
  modal.expectedMixTotal = undefined;
  if (!enabled) return;
  const output = fields.querySelector('[data-extension-mix-preview]');
  try {
    const command = extensionCommand(dialog.querySelector('form'));
    const current = quote(state,modal.ticketId);
    const preview = apply(state,command,Date.now());
    const total = quote(preview,modal.ticketId).total;
    modal.expectedMixTotal = total;
    output.textContent = `追加 ${yen(total - current.total)} ／ 延長後 ${yen(total)}`;
  } catch (error) {
    output.textContent = error.message;
  }
}

function renderExtensionQuoteOptions(options) {
  return `<fieldset class="choices"><legend>印刷するプラン</legend>
    <div class="form-grid">${options.quotePlanLabels.map(({id,name}) => `<label class="inline-check">
      <input type="checkbox" name="quoteExtensionId" value="${escape(id)}"${options.quotePlanIds.includes(id) ? ' checked' : ''}>${escape(name)}</label>`).join('')}</div>
    </fieldset><label class="inline-check"><input type="checkbox" name="deductAdvance"${options.deductAdvance ? ' checked' : ''}>前受金を差し引いた金額を表示</label>`;
}

function buildExtensionQuote({ticketId, quotePlanIds, extensionMix, printWidth, deductAdvance}) {
  const source = !cloudState.store && pendingStorage ? loadLocalData() ?? state : state;
  const ticket = source.tickets.find(({id,status}) => id === ticketId && status === 'open');
  if (!ticket) throw new Error('利用中の伝票を選択してください。');
  const at = Date.now();
  const entries = quotePlanIds.map((id) => {
    const mix = id === '@mixed' ? extensionMix : null;
    const plans = extensionPlans(source);
    const plan = mix ? plans.find(({id}) => id === mix[0]?.menuId) : plans.find((item) => item.id === id);
    if (!plan) throw new Error('選択した延長プランが変わりました。延長画面から開き直してください。');
    const command = {type:'extend',ticketId,...(mix ? {plans:mix} : {menuId:plan.id})};
    const next = apply(source,command,at);
    const printName = (option) => option.printName || option.name;
    const name = mix ? mix.map(({menuId,quantity}) => `${printName(plans.find(({id}) => id === menuId))} ${quantity}名`).join(' ＋ ') : printName(plan);
    return {name,duration:plan.duration,endsAt:next.tickets.find(({id}) => id === ticketId).endsAt,after:quote(next,ticketId)};
  });
  return {ticket,entries,at,deductAdvance,tables:getTicketTableLabels(source,ticket),date:source.day.date,before:quote(source,ticketId),
    settings:{...getPrintSettings(source),width:printWidth},storeName:cloudState.store?.name ?? '銀座店'};
}

function openPrintDocument(id, date, kind) {
  if (!Object.hasOwn(printDocumentTitles,kind)) return;
  if (currentRole() === 'staff' && date !== state.day.date) return;
  const ticket = findPrintableTicket(state,id,date);
  if (!ticket || (kind === 'check' ? ticket.status !== 'open' : !['paid','departed'].includes(ticket.status))) return;
  if (kind === 'invoice' && getPrintTenderReceived(ticket) === 0) return;
  const last = getPrintDocuments(state,ticket,date,kind).at(-1);
  const recipient = kind === 'invoice' && currentRoleAllows('customers')
    ? findCustomer(customerWorkspaceState(),ticket.customerId)?.receiptRecipient : '';
  const printSettings = getPrintSettings(state);
  openDialog('print-document',{printTicketId:id,printDate:date,printKind:kind,printWidth:printSettings.width,printSettings,
    printRecipient:last?.recipient || recipient || '',
    printPurpose:last?.purpose || (kind === 'invoice' ? printSettings.invoicePurpose || 'ご飲食代' : '')});
}

function updatePrintPreview(control) {
  if (modal?.type === 'extension-quote') {
    if (!['printWidth','quoteExtensionId','deductAdvance'].includes(control.name)) return;
    modal.printWidth = Number(dialog.querySelector('[name=printWidth]').value);
    modal.quotePlanIds = [...dialog.querySelectorAll('[name=quoteExtensionId]:checked')].map(({value}) => value);
    modal.deductAdvance = dialog.querySelector('[name=deductAdvance]').checked;
    const frame = dialog.querySelector('#print-preview');
    const button = dialog.querySelector('#submit-dialog');
    try {
      if (!modal.quotePlanIds.length) throw new Error('印刷する延長プランを1つ以上選択してください。');
      modal.estimate = buildExtensionQuote(modal);
      frame.innerHTML = renderExtensionQuote(modal.estimate,{escape,yen});
      button.disabled = false;
    } catch (error) {
      frame.textContent = error.message;
      button.disabled = true;
    }
    return;
  }
  if (modal?.type !== 'print-document') return;
  if (control.name === 'printWidth') modal.printWidth = Number(control.value);
  else if (control.name === 'printRecipient') modal.printRecipient = control.value;
  else if (control.name === 'printPurpose') modal.printPurpose = control.value;
  else return;
  dialog.querySelector('#print-preview').innerHTML = renderPendingPrint(modal);
}

function clearPrintOutput() {
  document.body.classList.remove('np-print-active');
  printOutput.replaceChildren();
}

function printWorkspace(html) {
  printMarkup(`<article class="np-print-a4">${html}</article>`);
}

function printMarkup(html) {
  printOutput.innerHTML = html;
  document.body.classList.add('np-print-active');
  try { window.print(); }
  catch {
    clearPrintOutput();
    toast('印刷画面を開けませんでした。ブラウザーの印刷機能を確認してください。');
  }
}

async function issuePrintDocument(options) {
  const {printTicketId:ticketId, printDate:date, printKind:kind,
    printRecipient:recipient, printPurpose:purpose} = options;
  const next = await commit({type:'issuePrintDocument',ticketId,date,kind,recipient,purpose});
  if (!next) return;
  const ticket = findPrintableTicket(next,ticketId,date);
  const entry = ticket && getPrintDocuments(next,ticket,date,kind).at(-1);
  if (!entry) return;
  const issuedOptions = {...options,printRecipient:entry.recipient ?? recipient,printPurpose:entry.purpose ?? purpose};
  printMarkup(renderPrintPreview(printData(next,ticket,issuedOptions,entry),{escape,yen}));
}

async function settleAndPrint(command) {
  const next = await commit(command,'会計を確定し、歩合を実績に計上しました。');
  if (!next) return;
  const kind = getPrintAutoKind(getPrintSettings(next));
  if (kind === 'none') return;
  openPrintDocument(command.ticketId,next.day.date,kind);
  if (kind === 'receipt' && modal?.type === 'print-document' && dialog.open) await issuePrintDocument(modal);
}

window.addEventListener('afterprint',clearPrintOutput);

function cashCategoryOptions(kind, selected) {
  return Object.entries(cashMovementCategories[kind] ?? {}).map(([value,text]) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${text}</option>`).join('');
}

function cashAccountSelect(kind, category, selected, editing) {
  const choices = !editing && category === 'safe' ? cashAccountOptions(state,'vault')
    : ['expense','withdrawal'].includes(kind) ? cashAccountOptions(state,'payee') : [];
  if (!choices.length) return '';
  return label(category === 'safe' && !editing ? '移動する金庫' : '登録済みの出金先',
    `<select name="cashAccountId"><option value="">指定なし</option>${choices.map((entry)=>
      `<option value="${escape(entry.id)}"${entry.id === selected ? ' selected' : ''}>${escape(entry.name)}
      ${entry.kind === 'vault' ? ' ／ ' + yen(vaultBalance(state,entry)) : ''}</option>`).join('')}</select>`);
}

function renderCashMovementForm(entry) {
  const kind = entry?.kind ?? 'expense';
  const counterparty = cashAccountSelect(kind,entry?.category,entry?.cashAccountId,Boolean(entry));
  const kinds = Object.entries(cashMovementKinds).map(([value,text]) =>
    `<option value="${value}"${value === kind ? ' selected' : ''}>${text}</option>`).join('');
  return `<div class="modal-context">${icon('calendar',16)}<strong>${escape(entry?.date ?? state.day.date)}</strong><span>営業日</span></div>
    <div class="form-grid">
    ${label('入出金の種類',`<select name="cashKind">${kinds}</select>`)}
    ${label('理由区分',`<select name="cashCategory">${cashCategoryOptions(kind,entry?.category)}</select>`)}
    ${label('金額（円）',`<input name="cashAmount" type="number" min="1" max="100000000" step="1" value="${entry?.amount ?? ''}" inputmode="numeric" required>`)}
    <div data-cash-counterparty${counterparty ? '' : ' hidden'}>${counterparty}</div>
    ${label('相手先・移動先（任意）',`<input name="cashDestination" type="text" maxlength="80" value="${escape(entry?.destination ?? '')}" placeholder="例　金庫、仕入先">`)}
    </div>${label('具体的な理由',`<textarea name="reason" maxlength="120" rows="2" required>${escape(entry?.reason ?? '')}</textarea>`)}
    <p class="field-help">レジで実際に出し入れした現金を記録します。</p>`;
}

function renderRegisterClose(totals, archived) {
  const rows = archived ? [] : [
    ['釣銭準備金',state.day.openingCash], ['会計・前受金の現金入金',totals.payments.cash],
    ['その他の現金入金',totals.cashIn + totals.recoveries.cash],
    ['出金・経費',-totals.cashOut],
  ];
  return `${archived ? `<p class="form-copy">営業日 ${escape(archived.date)}</p>` : `<dl class="cash-close-breakdown">${rows.map(([name,amount]) => `<div><dt>${name}</dt><dd>${yen(amount)}</dd></div>`).join('')}</dl>`}
    <div class="result-bar"><span>レジの理論残高</span><strong>${yen(totals.expectedCash)}</strong></div>
    <label class="inline-check"><input name="countByDenomination" type="checkbox" aria-controls="cash-denominations">金種別に数える</label>
    <div id="cash-denominations" class="cash-denominations" hidden>${cashDenominations.map((denomination) =>
      label(`${yen(denomination)}の枚数`,`<input data-cash-denomination="${denomination}" type="number" min="0" max="${Math.floor(cashEntryMaximum / denomination)}" step="1" inputmode="numeric" value="${archived?.cashDenominations?.[denomination] ?? ''}" placeholder="0" disabled>`)).join('')}</div>
    ${label('実際のレジ残高（円）',`<input name="actualCash" type="number" min="0" max="${cashEntryMaximum}" step="1" value="${archived?.actualCash ?? ''}" required inputmode="numeric" placeholder="数えた現金を入力">`)}
    <div id="cash-close-difference" class="result-bar" role="status"><span>差額（実残高 − 理論残高）</span><strong>—</strong></div>
    ${operationReason({title:archived ? '実残高を訂正する理由' : '差額の理由（差額がある場合は必須）',required:Boolean(archived)})}
    <p class="field-help">閉店を確定すると、内訳と差額が営業日の日報に保存されます。</p>`;
}

function readCashDenominations() {
  const inputs = [...dialog.querySelectorAll('[data-cash-denomination]')];
  return Object.fromEntries(inputs.filter((input) => !input.validity.valid || input.value !== '')
    .map((input) => [input.dataset.cashDenomination,input.validity.valid ? input.valueAsNumber : NaN]));
}

function updateCashDenominations() {
  const enabled = dialog.querySelector('[name=countByDenomination]').checked;
  const counts = dialog.querySelector('#cash-denominations');
  const actual = dialog.querySelector('[name=actualCash]');
  counts.hidden = !enabled;
  for (const input of counts.querySelectorAll('input')) input.disabled = !enabled;
  if (enabled && !actual.readOnly) modal.manualActualCash = actual.value;
  if (!enabled && actual.readOnly) actual.value = modal.manualActualCash ?? '';
  actual.readOnly = enabled;
  if (enabled) actual.value = getCashCountTotal(readCashDenominations()) ?? '';
  updateCashCloseDifference(actual);
}

function updateCashCloseDifference(input) {
  const row = dialog.querySelector('#cash-close-difference');
  if (!row) return;
  const actual = input.valueAsNumber;
  const difference = actual - modal.expectedCash;
  const valid = input.validity.valid && Number.isFinite(difference);
  row.querySelector('strong').textContent = valid ? `${difference > 0 ? '+' : ''}${yen(difference)}` : '—';
  row.classList.toggle('result-warn',valid && difference !== 0);
  dialog.querySelector('[name=reason]').required = modal.type === 'correct-register-count' || (valid && difference !== 0);
}

function renderProducts() {
  const query = modal.search.trim().toLowerCase();
  const options = state.menu.filter((item) => {
    if (item.enabled === false || ['セット','延長'].includes(item.category)) return false;
    return query ? `${item.name} ${item.category}`.toLowerCase().includes(query) : modal.category === 'よく使う' ? item.popular : item.category === modal.category;
  });
  if (!options.length) return '<p class="form-copy">該当するメニューはありません。</p>';
  return `<div class="product-grid">${options.map((item) => `<button type="button" class="product" data-action="product" data-id="${escape(item.id)}" aria-pressed="${item.id===modal.product}"><span>${escape(item.name)}</span><strong>${yen(item.price)}</strong></button>`).join('')}</div>`;
}

function commissionLabel({ fixed, rate, points }) {
  return [fixed && `${yen(fixed)}/点`, rate && `${rate}%`, points && `${points} Pt/点`].filter(Boolean).join(' · ');
}

function orderServiceChoice(checked) {
  return `<label class="inline-check"><input type="checkbox" name="orderServiceExcluded"${checked ? ' checked' : ''}>この明細にサービス料をかけない</label>`;
}

function renderProductDetails() {
  const item = state.menu.find((product)=>product.id === modal.product && product.enabled !== false);
  if (!item) return '<p class="form-copy order-tip">追加するメニューを選択してください。</p>';
  const draft = modal.editingOrderIndex !== undefined ? modal.orderItems[modal.editingOrderIndex] : null;
  const initialCast = new Set(draft?.castIds ?? []);
  const stockInfo = item.recipe?.map((need)=> {
    const stock = state.stock.find((goods)=>goods.id===need.stockId);
    return stock ? `${escape(stock.name)} ${number.format(need.quantity)}${escape(stock.unit)}` : '';
  }).join('・');
  const availableCast = state.cast.filter((person) => person.enabled !== false);
  if (item.category === '指名' && canOpenPage('customers')) {
    const customerState = customerWorkspaceState();
    const customerId = state.tickets.find(({id}) => id === modal.ticketId)?.customerId;
    const customer = findCustomer(customerState,customerId);
    if (customer && !customer.restricted) {
      const detail = getCustomerDetail(customerState,customerId);
      const suggestions = [detail?.preferredCast?.id,detail?.lastNomination?.castId].filter(Boolean);
      const rank = (id) => suggestions.includes(id) ? suggestions.indexOf(id) : suggestions.length;
      availableCast.sort((first, second) => rank(first.id) - rank(second.id));
    }
  }
  const baseCommission = commissionLabel(getItemCommission(item));
  const usesOverrides = availableCast.some((person) => person.commissionOverride);
  const showChoices = item.requiresCast || item.acceptsCast || availableCast.some((person) => commissionLabel(getItemCommission(item, person)));
  let castChoices = '';
  if (showChoices && availableCast.length) {
    const choices = availableCast.map((person) => {
      const rule = usesOverrides ? commissionLabel(getItemCommission(item, person)) || '歩合なし' : '';
      return `<label class="choice"><input name="castIds" type="checkbox" value="${escape(person.id)}"${initialCast.has(person.id) ? ' checked' : ''}><span><strong>${escape(person.name)}</strong>${rule ? `<small>${rule}</small>` : ''}</span></label>`;
    }).join('');
    castChoices = `<fieldset class="choices cast-choices"><legend>歩合を付けるキャスト${item.requiresCast ? '（必須）' : '（任意）'}</legend><div class="choice-grid">${choices}</div>${usesOverrides
      ? '<p class="field-help">複数のキャストを選ぶと、売上・固定額・ポイントを按分します。</p>'
      : baseCommission ? `<p class="field-help">${icon('users',14)} ${baseCommission}</p>` : ''}</fieldset>`;
  } else if (item.requiresCast) {
    castChoices = '<p class="field-help">店舗設定で注文に使うキャストを有効にしてください。</p>';
  }
  const excluded = draft?.serviceExcluded === true;
  const serviceControl = item.serviceEligible !== false && canExcludeOrderService(state,currentRole())
    ? `${orderServiceChoice(excluded)}<div id="order-service-reason"${excluded ? '' : ' hidden'}>
      ${label('サービス料の除外理由',`<textarea name="orderServiceReason" maxlength="120"${excluded ? ' required' : ''}>${escape(draft?.serviceExclusionReason ?? '')}</textarea>`)}</div>` : '';
  return `<section class="order-selection"><div class="order-selected"><div><h3>${escape(item.name)}</h3><p>${yen(item.price)} / 点</p></div><label class="field order-qty"><span>数量</span><input name="quantity" type="number" min="1" max="100" step="1" inputmode="numeric" value="${draft?.quantity ?? 1}" required></label></div>
    ${stockInfo ? `<p class="field-help">${icon('box',14)} 在庫引き落とし / 点　${stockInfo}</p>` : ''}
    ${castChoices}${serviceControl}<div class="ops-actions">${button(draft ? '明細の変更を反映' : '注文リストに追加','order-line-stage',{tone:'secondary',glyph:'plus'})}
      ${draft ? button('変更をやめる','order-line-reset',{tone:'quiet'}) : ''}</div></section>`;
}

function renderOrderCart() {
  if (!modal.orderItems.length) return '';
  return `<section class="order-cart"><h3>注文リスト <small>${modal.orderItems.length}件</small></h3>
    <ul>${modal.orderItems.map(({menuId,quantity,castIds,serviceExcluded},index) => {
      const item = state.menu.find(({id})=>id === menuId);
      const name = item?.name ?? '現在選べない商品';
      return `<li><span><strong>${escape(name)} ×${quantity}</strong>${castIds.length ? `<small>${castIds.map(staffName).map(escape).join('・')}</small>` : ''}${serviceExcluded === true ? '<small>サービス料対象外</small>' : ''}</span>
        <span class="money">${item ? yen(item.price * quantity) : '—'}</span><div class="ops-actions">
        ${button('編集','order-line-edit',{id:index,tone:'quiet',data:`aria-label="${escape(name)}の明細を編集"`})}
        ${button('除外','order-line-remove',{id:index,tone:'quiet',data:`aria-label="${escape(name)}を注文リストから除外"`})}</div></li>`;
    }).join('')}</ul></section>`;
}

function currentOrderLine(form, preview = false) {
  const item = state.menu.find(({id,enabled})=>id === modal.product && enabled !== false);
  if (!item) throw new Error('追加するメニューを選択してください。');
  const data = new FormData(form);
  const quantity = Number(data.get('quantity'));
  const castIds = data.getAll('castIds');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('数量は1〜100の整数で入力してください。');
  if (item.requiresCast && !castIds.length) throw new Error('担当キャストを選択してください。');
  const serviceExcluded = data.has('orderServiceExcluded');
  const reason = String(data.get('orderServiceReason') ?? '').trim();
  if (serviceExcluded && !preview && (!reason || reason.length > 120)) {
    throw new Error('サービス料の除外理由を120文字以内で入力してください。');
  }
  return {menuId:item.id,quantity,castIds,
    ...(serviceExcluded && {serviceExcluded,serviceExclusionReason:preview ? 'プレビュー' : reason})};
}

function orderItemsFromForm(form, preview = false) {
  const items = [...modal.orderItems];
  if (modal.product) {
    const line = currentOrderLine(form,preview);
    if (modal.editingOrderIndex !== undefined) items[modal.editingOrderIndex] = line;
    else items.push(line);
  }
  return items;
}

function editTicketLineCommand(form, preview = false) {
  const data = new FormData(form);
  const line = state.tickets.find(({id}) => id === modal.ticketId)?.lines.find(({id}) => id === modal.lineId);
  const serviceExcluded = data.has('orderServiceExcluded');
  const changeService = form.elements.orderServiceExcluded && serviceExcluded !== (line?.serviceExcluded === true);
  return {type:'editTicketLine',ticketId:modal.ticketId,lineId:modal.lineId,quantity:Number(data.get('quantity')),
    price:Number(data.get('linePrice')),castIds:data.getAll('castIds'),reason:preview ? 'プレビュー' : data.get('reason'),
    ...(changeService && {serviceExcluded})};
}

function updateOrderServicePreview() {
  const output = dialog.querySelector('#order-service-preview');
  if (!output) return;
  const form = output.closest('form');
  if (modal.type === 'order' && !form.elements.orderServiceExcluded
    && !modal.orderItems.some(({serviceExcluded}) => serviceExcluded === true)) {
    output.textContent = '';
    return;
  }
  try {
    const command = modal.type === 'order'
      ? {type:'order',ticketId:modal.ticketId,items:orderItemsFromForm(form,true)}
      : editTicketLineCommand(form,true);
    const next = apply(state,command,Date.now(),{role:currentRole(),profileId:currentProfileId()});
    const {service,total} = quote(next,modal.ticketId);
    output.innerHTML = `<p class="field-help">伝票見込額 <strong>${yen(total)}</strong>（うちサービス料 ${yen(service)}）</p>`;
  } catch {
    output.innerHTML = '<p class="field-help">数量・担当・在庫などの明細を確認すると、伝票見込額を表示します。</p>';
  }
}

function refreshOrderSelection() {
  for (const control of dialog.querySelectorAll('[data-action=product]')) {
    control.setAttribute('aria-pressed',String(control.dataset.id === modal.product));
  }
  dialog.querySelector('#order-selection').innerHTML = renderProductDetails();
  dialog.querySelector('#order-cart').innerHTML = renderOrderCart();
  updateOrderServicePreview();
}

function renderBillingSettings(tab) {
  const tabs = [['auto','自動延長'],['card','カード会計加算']];
  const nav = `<div class="seg billing-tabs" role="group" aria-label="設定の種類">${tabs.map(([id,title]) =>
    `<button type="button" data-action="billing-settings-tab" data-id="${id}" aria-pressed="${tab === id}">${title}</button>`).join('')}</div>`;
  if (tab === 'card') {
    const fee = getCardFeeSettings(state);
    return nav + `<label class="billing-switch"><span>ブランド未指定のカードに加算する</span>
      <input type="checkbox" role="switch" name="cardFeeEnabled"${fee.enabled ? ' checked' : ''}></label>
      ${label('加算率（%）',`<input type="number" name="cardFeeRate" min="0" max="100" step="0.01"
        inputmode="decimal" value="${fee.rateBps / 100}" required>`)}
      <p class="field-help">ブランドを選ばなかったカード支払分の税込加算率です。前受金と現金には加算しません。</p>
      <section class="payroll-edit-section"><h3>決済ブランド</h3>
        <p class="field-help">ブランドを選ぶと、ブランドごとの率を使います。決済契約で認められた率を登録してください。</p>
        <div data-payment-brand-settings>${(fee.brands ?? []).map(renderPaymentBrandSetting).join('')}</div>
        ${button('決済ブランドを追加','payment-brand-add',{glyph:'plus'})}
      </section>`;
  }
  const auto = getAutoExtensionSettings(state);
  const plans = getAutoExtensionPlans(state);
  const configured = plans.some(({id}) => id === auto.menuId);
  const selectedPlan = configured ? auto.menuId : plans[0]?.id;
  const planOptions = plans.map((plan) => `<option value="${escape(plan.id)}"${plan.id === selectedPlan ? ' selected' : ''}>
    ${escape(plan.name)} · ${plan.duration}分 · ${yen(plan.price)}/人</option>`).join('');
  return nav + `<label class="billing-switch"><span>自動延長を適用する</span>
    <input type="checkbox" role="switch" name="autoExtensionEnabled"${auto.enabled && configured ? ' checked' : ''}${plans.length ? '' : ' disabled'}></label>
    ${label('延長プラン',`<select name="autoExtensionPlan"${plans.length ? '' : ' disabled'}>
      ${planOptions || '<option value="">有効なプランがありません</option>'}</select>`)}
    ${auto.enabled && !configured ? '<p class="ops-highlight">設定中のプランは自動延長に使えません。選び直して保存してください。</p>' : ''}
    <p class="field-help">${plans.length ? '利用中の伝票が終了時刻を迎えると、選んだプランで延長を追加します。すでに時間を超過している卓では、設定後に選んだプランの時間が経過してから追加します。' : '在庫に連動しない延長プランを有効にすると、自動延長を設定できます。'}</p>
    <label class="billing-switch"><span>超過分の手動一括延長を許可する</span>
      <input type="checkbox" role="switch" name="bulkExtensionEnabled"${state.bulkExtensionEnabled !== false ? ' checked' : ''}></label>
    <p class="field-help">時間を過ぎた伝票に複数回分の延長を登録できます。</p>`;
}

function renderCalculationSettings() {
  const settings = getCalculationSettings(state);
  const choices = (name,values) => `<select name="${name}">${Object.entries(values).map(([key,label])=>
    `<option value="${key}"${settings[name]===key ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
  const rounding = {floor:'切り捨て',round:'四捨五入',ceil:'切り上げ'};
  return `<div class="form-grid">
    ${label('サービス料率（%）',`<input type="number" name="serviceRate" min="0" max="100" step="0.01" value="${settings.serviceRateBps / 100}" required inputmode="decimal">`)}
    ${label('メニュー価格',choices('priceMode',{exclusive:'税抜価格',inclusive:'税込価格'}))}
    ${label('サービス料の計算基準',choices('serviceBase',{afterDiscount:'値引き後の小計',beforeDiscount:'値引き前の小計'}))}
    ${label('サービス料の端数',choices('serviceRounding',rounding))}
    ${label('消費税の端数',choices('taxRounding',rounding))}
    </div><p class="field-help">計算設定は新しく登録する来店に適用します。税込価格に切り替えると、登録済みのメニュー単価を税込として扱います。</p>
    <label class="billing-switch"><span>注文明細ごとのサービス料除外を許可する</span>
      <input type="checkbox" role="switch" name="allowOrderServiceExclusion"${settings.allowOrderServiceExclusion ? ' checked' : ''}></label>
    <p class="field-help">管理者が理由を入力して、新規注文や会計前の明細でサービス料を除外できます。</p>`;
}

function renderPayment(entry,index) {
  return `<div class="payment-row">${label('支払方法',methodSelect('paymentMethod',entry.method))}${label('金額（円）',`<input type="number" name="paymentAmount" min="0" step="1" value="${entry.amount}" inputmode="numeric" required>`)}${modal.payments.length>1 ? `<button type="button" class="icon-btn" aria-label="支払い行を削除" data-action="remove-payment" data-id="${index}">${icon('x',16)}</button>` : ''}<div class="payment-brand-fields" data-payment-brand-fields>${renderPaymentBrandFields(entry)}</div></div>`;
}

function currentPayments() {
  return [...dialog.querySelectorAll('.payment-row')].map((row)=>{
    const brandId = row.querySelector('[name=paymentBrand]')?.value;
    const waiveFee = row.querySelector('[name=paymentWaiveFee]')?.checked;
    return {method:row.querySelector('[name=paymentMethod]').value,amount:Number(row.querySelector('[name=paymentAmount]').value),
      ...(brandId && {brandId}),...(waiveFee && {waiveFee})};
  });
}

const savedDepositPaymentTerms = '!saved';

function renderPaymentBrandFields(entry, saved = null, prefix = 'payment') {
  const settings = getCardFeeSettings(state);
  const brands = (settings.brands ?? []).filter(({enabled,method}) => enabled && method === entry.method);
  const showSaved = saved?.method === entry.method && ['card','qr'].includes(entry.method);
  const keepingSaved = showSaved && entry.brandId === savedDepositPaymentTerms;
  const savedLabel = saved?.brandName || (saved?.method && tenderMethods[saved.method]);
  const savedOption = showSaved ? `<option value="${savedDepositPaymentTerms}"${keepingSaved ? ' selected' : ''}>登録時の設定（${escape(savedLabel)}）</option>` : '';
  const chosen = brands.find(({id})=>id === entry.brandId);
  const rate = chosen?.rateBps ?? (entry.method === 'card' && settings.enabled ? settings.rateBps : 0);
  const options = brands.map(({id,name,rateBps}) =>
    `<option value="${escape(id)}"${entry.brandId === id ? ' selected' : ''}>${escape(name)}（+${rateBps / 100}%）</option>`).join('');
  const brand = brands.length || showSaved ? label('決済ブランド',`<select name="${prefix}Brand">${savedOption}<option value=""${showSaved && !keepingSaved && !chosen ? ' selected' : ''}>指定しない</option>${options}</select>`) : '';
  const waive = !keepingSaved && rate > 0 && canWaivePaymentFee(currentRole()) ? `<label class="inline-check">
    <input type="checkbox" name="${prefix}WaiveFee"${entry.waiveFee ? ' checked' : ''}>この支払いの加算を免除</label>` : '';
  return brand + waive;
}

function currentDeposit() {
  return state.tickets.find(({id}) => id === modal.ticketId)?.deposits.find(({id}) => id === modal.depositId);
}

function readDepositPayment() {
  const method = dialog.querySelector('[name=depositMethod]').value;
  const amount = Number(dialog.querySelector('[name=depositAmount]').value);
  const brand = dialog.querySelector('[name=depositBrand]')?.value;
  const waiveFee = dialog.querySelector('[name=depositWaiveFee]')?.checked;
  return {method,amount,...(brand === savedDepositPaymentTerms ? {preservePaymentTerms:true} : brand ? {brandId:brand} : {}),
    ...(waiveFee && {waiveFee:true})};
}

function updateDepositPreview() {
  const panel = dialog.querySelector('[data-deposit-fee-preview]');
  if (!panel) return;
  const payment = readDepositPayment();
  modal.expectedDepositFee = undefined;
  panel.hidden = !['card','qr'].includes(payment.method);
  if (panel.hidden) { modal.expectedDepositFee = 0; return; }
  panel.hidden = !Number.isSafeInteger(payment.amount) || payment.amount <= 0;
  if (panel.hidden) return;
  try {
    const terms = getDepositPaymentTerms(state,payment,currentDeposit());
    modal.expectedDepositFee = terms.cardFee ?? 0;
    panel.innerHTML = `<dl><div><dt>会計に充当する額</dt><dd>${yen(payment.amount)}</dd></div>
      <div><dt>決済加算（税込）</dt><dd>${yen(terms.cardFee ?? 0)}</dd></div>
      <div><dt>${escape(terms.brandName || tenderMethods[payment.method])}端末の決済額</dt><dd>${yen(depositGrossAmount({...payment,...terms}))}</dd></div></dl>`;
  } catch (error) { panel.textContent = error.message; }
}

function renderPaymentBrandSetting(brand) {
  return `<div class="form-grid payment-brand-setting" data-payment-brand-setting data-id="${escape(brand.id)}">
    ${label('ブランド名',`<input name="brandName" maxlength="40" value="${escape(brand.name)}" required>`)}
    ${label('決済種別',`<select name="brandMethod"><option value="card">カード</option><option value="qr"${brand.method === 'qr' ? ' selected' : ''}>QR決済</option></select>`)}
    ${label('ブランド別加算率（%）',`<input type="number" name="brandFeeRate" min="0" max="100" step="0.01" value="${brand.rateBps / 100}" required inputmode="decimal">`)}
    <div class="ops-actions"><label class="inline-check"><input type="checkbox" name="brandEnabled"${brand.enabled ? ' checked' : ''}>会計で選択する</label>
    ${button('削除','payment-brand-remove',{glyph:'x',tone:'quiet'})}</div>
  </div>`;
}

function currentPaymentBrands(form) {
  return [...form.querySelectorAll('[data-payment-brand-setting]')].map((row)=>({
    id:row.dataset.id,name:row.querySelector('[name=brandName]').value,method:row.querySelector('[name=brandMethod]').value,
    rateBps:Math.round(Number(row.querySelector('[name=brandFeeRate]').value) * 100),enabled:row.querySelector('[name=brandEnabled]').checked,
  }));
}

function updateSettledContentsPreview(form) {
  const display = form?.querySelector('[data-settled-preview]');
  if (!display) return;
  try {
    const {ticket} = findSettledCustomerTicket(state,modal.ticketId);
    const {totals,change} = previewSettledContents(state,ticket,{...readSettledContents(form,modal),at:Date.now()});
    modal.previewSettledTotal = totals.total;
    display.textContent = `訂正後 ${yen(totals.total)} ／ 差額 ${change > 0 ? '+' : ''}${yen(change)}`;
  } catch (error) { modal.previewSettledTotal = null; display.textContent = error.message; }
}

function updatePaymentNote() {
  const note = dialog.querySelector('#payment-note');
  if (!note) return;
  const payments = currentPayments();
  const left = quote(state,modal.ticketId).remaining - payments.reduce((sum,entry)=>sum+entry.amount,0);
  note.innerHTML = left === 0 ? `<span>${icon('check',16)}支払額が一致しています</span><strong>差額 ${yen(0)}</strong>` : `<span>${left>0?'未充当の金額':'超過した金額'}</span><strong>${yen(Math.abs(left))}</strong>`;
  note.classList.toggle('result-warn',left!==0);
  const cashPanel = dialog.querySelector('#cash-tender');
  const cashReceived = cashPanel.querySelector('[name=cashReceived]');
  const cashChange = cashPanel.querySelector('#cash-tender-change');
  const cashApplied = getCashPaymentAmount(payments);
  cashPanel.hidden = cashApplied <= 0;
  cashReceived.disabled = cashPanel.hidden;
  if (cashPanel.hidden) cashReceived.value = '';
  const received = cashReceived.valueAsNumber;
  const difference = received - cashApplied;
  const validTender = cashReceived.validity.valid && Number.isFinite(difference);
  cashChange.querySelector('span').textContent = validTender && difference < 0 ? '現金の不足額' : 'お釣り';
  cashChange.querySelector('strong').textContent = validTender ? yen(Math.abs(difference)) : '—';
  cashChange.classList.toggle('result-warn', validTender && difference < 0);
  const cardPreview = dialog.querySelector('#card-fee-preview');
  let breakdown;
  try {
    breakdown = getSettlementPaymentFees(state,payments);
  } catch (error) {
    if (cardPreview) {
      cardPreview.hidden = false;
      cardPreview.textContent = error.message;
    }
    return;
  }
  const {metadata,fees,total:fee} = breakdown;
  if (cardPreview) {
    cardPreview.hidden = fee <= 0;
    const isBranded = metadata.some(({brandId},index)=>brandId && fees[index] > 0);
    const externalPayments = payments.filter(({method,amount})=>['card','qr'].includes(method) && amount > 0);
    cardPreview.innerHTML = fee > 0 ? `<dl><div><dt>${isBranded ? '決済加算（税込）' : 'カード会計加算（税込）'}</dt><dd>${yen(fee)}</dd></div>
      ${payments.map(({method,amount},index)=>['card','qr'].includes(method) && amount > 0
        ? `<div><dt>${escape(metadata[index].brandName || tenderMethods[method])}端末の決済額${externalPayments.length > 1 ? `（${index + 1}行目）` : ''}</dt>
        <dd${method === 'card' ? ' data-card-charge' : ''}>${yen(amount + fees[index])}</dd></div>` : '').join('')}
      <div><dt>会計合計（税込）</dt><dd>${yen(quote(state,modal.ticketId).total + fee)}</dd></div></dl>` : '';
  }

}

function reviseProduct() {
  dialog.querySelector('#order-products').innerHTML = renderProducts();
}

function openTicket(id) {
  const ticket = state.tickets.find(item=>item.id===id);
  if (!ticket) return;
  if (['departed','void'].includes(ticket.status)) { openDialog('receipt',{ticketId:id}); return; }
  if (dialog.open) dialog.close();
  revealTable(ticket.tableIds[0]);
  mobileDetails = true;
  go('floor');
}

function openSettlement(ticketId) {
  openDialog('settle',{ticketId,payments:[{method:'cash',amount:quote(state,ticketId).remaining}]});
}

async function changeVisitAutoExtension(ticketId, source) {
  if (page !== 'floor' || dialog.open || committing || pendingVisitAutoExtensionTicket) return;
  const ticket = state.tickets.find((entry) => entry.id === ticketId && entry.status === 'open');
  const resuming = source === 'resume';
  if (!ticket || (resuming && !isVisitAutoExtensionPaused(ticket))) return;
  const checkout = source === 'checkout';
  const command = resuming ? {type:'resumeVisitAutoExtension',ticketId} : {type:'pauseVisitAutoExtension',ticketId,source};
  if (checkout && ticket.discountRequest) {
    toast('値引きの承認後に会計できます。',{error:true});
    return;
  }
  pendingVisitAutoExtensionTicket = ticketId;
  render({preserveFocus:true});
  try {
    await commit(command,checkout || resuming ? null : '今回の来店の自動延長を止めました。', (next) => {
        const current = next.tickets.find((entry) => entry.id === ticketId && entry.status === 'open');
        if (!current) return;
        if (resuming) {
          const deadline = getTicketAutoExtensionAt(next,current);
          toast(deadline == null ? '今回の停止を解除しました。店舗と卓の設定に従います。'
            : `自動延長を再開しました。次の自動延長は${dateTime.format(deadline)}です。`);
          app.querySelector('.detail [data-action=table-auto-extension]')?.focus({preventScroll:true});
        } else if (checkout && !current.discountRequest) {
          revealTable(current.tableIds[0]);
          mobileDetails = true;
          openSettlement(ticketId);
        } else {
          const table = [...app.querySelectorAll('[data-action=table]')]
            .find((entry) => current.tableIds.includes(entry.dataset.id));
          (table ?? app.querySelector('#workspace'))?.focus({preventScroll:true});
          if (checkout) toast('値引きの承認後に会計できます。',{error:true});
        }
      },{fromFloor:true});
  } finally {
    pendingVisitAutoExtensionTicket = null;
    render({preserveFocus:true});
  }
}

function modalFromAction(target) {
  const {action,id} = target.dataset;
  if (['customer-new','customer-import'].includes(action)) openDialog(action);
  if (['customer-detail','customer-edit','customer-merge','customer-link'].includes(action)) openDialog(action,{customerId:id});
  if (['move','extend','deposit','discount','depart','receipt','seat-history','cancel-settlement','reopen-ticket','personal-sales-adjustment'].includes(action)) openDialog(action,{ticketId:id});
  if (action === 'extend-overdue' && state.bulkExtensionEnabled !== false && state.tickets.some((ticket) => ticket.id === id && ticket.status === 'open')) {
    openDialog(action,{ticketId:id});
  }
  if (action === 'discount-review' || action === 'discount-reject') {
    const request = state.tickets.find((ticket) => ticket.id === id)?.discountRequest;
    if (request) openDialog(action,{ticketId:id,requestId:request.id});
  }
  if (action === 'order') openDialog(action,{ticketId:id,product:target.dataset.product ?? '',category:'よく使う',search:'',orderItems:[]});
  if (action === 'settle') openSettlement(id);
  if (action === 'stock-adjust' || action === 'stocktake') {
    const stock = state.stock.find((item) => item.id === id);
    if (stock) openDialog(action,{stockId:id,bookQuantity:stock.quantity});
  }
  if (action === 'cancel-line') openDialog(action,{ticketId:target.dataset.ticket,lineId:id});
}

function renderPracticeEntry() {
  return `<div class="ops-actions">${button('体験クエストを始める','practice-start',{glyph:'check',tone:'secondary'})}</div>
    <p class="field-help">このタブの練習用データで、開店から閉店まで操作できます。終了すると元のデモに戻ります。</p>`;
}

function resetPracticeView() {
  announcedAutoExtensions.clear();
  selected = null;
  mobileDetails = false;
  area = null;
  filter = 'all';
  reportDate = '';
  reportInterval = {mode:'day'};
  pendingStorage = false;
  syncFloorSelection();
}

function updatePractice(action) {
  if (cloudState.store || committing) return;
  if (action === 'practice-start' && !demoPractice) {
    demoPractice = {state,role:demoRole,page,floorView,planArea};
    state = createDemo('closed');
    demoRole = 'admin';
    floorView = 'list';
    planArea = getLayoutAreas(state)[0] ?? null;
    resetPracticeView();
    if (dialog.open) dialog.close();
    go('floor');
    return;
  }
  if (!demoPractice) return;
  if (action === 'practice-stop') {
    const previous = demoPractice;
    demoPractice = null;
    state = loadLocalData() ?? previous.state;
    demoRole = previous.role;
    floorView = previous.floorView;
    planArea = previous.planArea;
    resetPracticeView();
    if (dialog.open) dialog.close();
    go(canOpenPage(previous.page) ? previous.page : defaultPage());
    return;
  }
  if (action === 'practice-report') { go('reports'); return; }
  const {nextStep,open,paid} = getPracticeStatus(state);
  const free = state.tables.find(({id}) => !getTicketForTable(state,id));
  mobileDetails = false;
  go('floor');
  if (nextStep === 0) openDialog('open');
  else if (nextStep === 1 && free) openDialog('seat',{tableId:free.id});
  else if (nextStep === 2 && open) {
    revealTable(open.tableIds[0]);
    modalFromAction({dataset:{action:'order',id:open.id}});
  } else if (nextStep === 3 && open) {
    revealTable(open.tableIds[0]);
    openSettlement(open.id);
  } else if (nextStep === 4 && paid) {
    revealTable(paid.tableIds[0]);
    openDialog('depart',{ticketId:paid.id});
  } else if ((nextStep === 2 || nextStep === 3) && free && state.day.status === 'open') {
    openDialog('seat',{tableId:free.id});
  } else if (nextStep === 5) openDialog('close');
}

function clickAction(target) {
  const {action,id} = target.dataset;
  if (!permittedAction(action)) return;
  if (['customer-anniversary-add','customer-anniversary-remove'].includes(action)
    && ['customer-new','customer-edit'].includes(modal?.type) && permittedAction('customer-edit')) {
    if (action === 'customer-anniversary-remove') {
      target.closest('[data-anniversary-row]')?.remove();
      dialog.querySelector('[data-action=customer-anniversary-add]')?.focus();
    } else {
      const rows = dialog.querySelector('[data-anniversary-rows]');
      if (rows.children.length >= customerAnniversaryLimit) { showError('記念日は10件まで登録できます。'); return; }
      rows.insertAdjacentHTML('beforeend',customerUI.renderAnniversaryRow({},customerUIApi()));
      rows.lastElementChild.querySelector('input').focus();
    }
    return;
  }
  if (action.startsWith('practice-')) { updatePractice(action); return; }
  if (action.startsWith('cloud-')) { void cloudAction(action, target); return; }
  if (action === 'audit-log') {
    openDialog(action,{entries:[],more:false,ticketAuditId:target.dataset.ticketAudit ? id : undefined});
    void loadAuditPage();
    return;
  }
  if (action === 'audit-more') { void loadAuditPage(); return; }
  if (action === 'ops-guide') { void openOperationsGuide(); return; }
  if (action === 'ops-guide-explain') { void explainGuideTopic(id,target); return; }
  if (['ops-settings','print-settings','ops-notices','set-schedule','calculation-settings','role-policy'].includes(action)) { openDialog(action); return; }
  if (modal?.type === 'role-policy' && ['role-custom-add','role-custom-remove'].includes(action)) {
    const draft = readRolePolicy(dialog.querySelector('#dialog-form'));
    if (action === 'role-custom-remove') delete draft.custom[id];
    else if (['manager','staff'].includes(id)) {
      if (Object.keys(draft.custom).length >= 24) { showError('カスタム役職は24件まで登録できます。'); return; }
      const names = new Set(Object.values(draft.custom).map(({label}) => label));
      let suffix = 1;
      while (names.has(`新しい役職 ${suffix}`)) suffix++;
      draft.custom[`role-${crypto.randomUUID()}`] = {label:`新しい役職 ${suffix}`,base:id,allowed:[]};
    }
    modal.rolePolicyDraft = draft;
    paintDialog();
    return;
  }
  if (action === 'cash-accounts') { openDialog(action); return; }
  if (action === 'cash-account-add' && modal?.type === 'cash-accounts' && ['vault','payee'].includes(id)) {
    const list = dialog.querySelector(`[data-cash-accounts="${id}"]`);
    if (dialog.querySelectorAll('[data-cash-account-row]').length >= 40) return;
    list.insertAdjacentHTML('beforeend',renderCashAccountRow({id:'cash-account-' + crypto.randomUUID(),kind:id},{escape,yen}));
    list.lastElementChild.querySelector('[name=cashAccountName]').focus();
    return;
  }
  if (action === 'cash-account-remove-new' && modal?.type === 'cash-accounts') {
    target.closest('[data-cash-account-row]')?.remove();
    return;
  }
  if (action === 'accounting-settings') { openDialog(action,{csvMode:'daily'}); return; }
  if (action === 'stock-cancel-purchase') {
    if (permittedAction('stock-adjust')) openDialog(action,{purchaseId:id});
    return;
  }
  if (['edit-cash-movement','void-cash-movement'].includes(action)) {
    const item = editableCashMovement(state,id);
    if (item && (currentRole() === 'admin' || (state.day.status === 'open' && state.day.date === item.date))) {
      openDialog(action,{movementId:id});
    }
    return;
  }
  if (action === 'correct-register-count' && state.closedDays.some(({date}) => date === id)) {
    openDialog(action,{closeDate:id});
    return;
  }
  if (['accounting-add-column','accounting-remove-column'].includes(action) && modal?.type === 'accounting-settings') {
    const form = dialog.querySelector('form');
    const {columns} = readAccountingCsvEditor(form);
    if (action === 'accounting-remove-column' && columns.length > 1) columns.splice(Number(id),1);
    if (action === 'accounting-add-column' && columns.length < 32) columns.push({});
    form.querySelector('[data-accounting-columns]').innerHTML = accountingCsvColumns(columns,{escape,icon});
    if (action === 'accounting-add-column') Array.from(form.querySelectorAll('[name=csvColumn]')).at(-1)?.focus();
    return;
  }
  if (action === 'ticket-customer') {
    const ticket = state.tickets.find((entry) => entry.id === id && entry.status === 'open');
    if (ticket && state.day.status === 'open') openDialog(action,{ticketId:id,ticketCustomerAlias:ticketCustomerAlias(ticket)});
    return;
  }
  if (action === 'ticket-companions') {
    const ticket = state.tickets.find((entry) => entry.id === id && entry.status === 'open');
    if (ticket && state.day.status === 'open' && ticketCustomerAlias(ticket)?.id) openDialog(action,{ticketId:id});
    return;
  }
  if (action === 'settled-ticket-companions') {
    const entry = findSettledCustomerTicket(state,id);
    if (entry?.ticket.customerId) openDialog(action,{ticketId:id,primaryCustomerId:entry.ticket.customerId,
      returnToReceipt:['receipt','history-receipt'].includes(modal?.type)});
    return;
  }
  if (action === 'save-ticket-companion' && modal?.type === 'settled-ticket-companions') {
    const reason = dialog.querySelector('[name=reason]').value.trim();
    if (!reason) {
      showError('同席者を訂正する理由を入力してください。');
      dialog.querySelector('[name=reason]').focus();
      return;
    }
    const mode = target.dataset.mode === 'remove' ? 'remove' : 'add';
    void commitReceiptCorrection({type:'correctSettledTicketCompanion',ticketId:modal.ticketId,
      customerId:id,primaryCustomerId:modal.primaryCustomerId,mode,reason},'同席者を訂正しました。');
    return;
  }
  if (action === 'save-ticket-companion' && modal?.type === 'ticket-companions') {
    const mode = target.dataset.mode === 'remove' ? 'remove' : 'add';
    void commit({type:'setTicketCompanion',ticketId:modal.ticketId,customerId:id,mode},
      mode === 'add' ? '同席者を追加しました。' : '同席者を解除しました。');
    return;
  }
  if (['ticket-note','ticket-end','ticket-set-time','ticket-guests'].includes(action)) {
    if (state.day.status === 'open' && state.tickets.some((entry) => entry.id === id && entry.status === 'open')) {
      openDialog(action,{ticketId:id});
    }
    return;
  }
  if (action === 'edit-ticket-line' || action === 'cancel-ticket-extension') {
    const ticket = state.tickets.find(({id,status})=>id === target.dataset.ticket && status === 'open');
    if (ticket?.lines.some((line)=>line.id === id && line.cancelledAt === null)) openDialog(action,{ticketId:ticket.id,lineId:id});
    return;
  }
  if (action === 'settled-ticket-customer') {
    openSettledCustomerEditor(id,{returnToReceipt:['receipt','history-receipt'].includes(modal?.type)});
    return;
  }
  if (action === 'settled-ticket-payment') {
    const entry = findSettledCustomerTicket(state,id);
    if (entry && paymentCorrectionModel(entry.ticket).total > 0) {
      openDialog(action,{ticketId:id,returnToReceipt:['receipt','history-receipt'].includes(modal?.type)});
    }
    return;
  }
  if (action === 'settled-ticket-contents') {
    const entry = findSettledCustomerTicket(state,id);
    if (currentRole() === 'admin' && entry && !ticketHasReceivable(state,entry.ticket)) {
      openDialog(action,{ticketId:id,returnToReceipt:['receipt','history-receipt'].includes(modal?.type)});
    }
    return;
  }
  if (action === 'table-auto-extension') {
    const tableId = id ?? selected ?? state.tables[0]?.id;
    if (state.tables.some((table) => table.id === tableId)) openDialog(action,{autoTableId:tableId});
    return;
  }
  if (['auto-extension-pause','auto-extension-checkout','auto-extension-resume'].includes(action)) {
    const source = action === 'auto-extension-resume' ? 'resume' : action === 'auto-extension-checkout' ? 'checkout' : 'manual';
    void changeVisitAutoExtension(id,source);
    return;
  }
  if (action === 'seat-customer-clear' && hasCustomerPicker()) {
    if (modal.canDetach === false) return;
    modal.seatCustomerId = null;
    renderSeatCustomerMatches();
    renderSeatCustomerSelection();
    dialog.querySelector('[name=customerQuery]')?.focus({preventScroll:true});
    return;
  }
  if (action === 'auto-extension-focus') {
    if (state.tickets.some((ticket) => ticket.id === id && ticket.status === 'open')) openTicket(id);
    return;
  }
  if (action === 'billing-settings') { openDialog(action,{billingTab:id==='card'?'card':'auto'}); return; }
  if (action === 'billing-settings-tab' && modal?.type === 'billing-settings' && ['auto','card'].includes(id)) {
    if (modal.billingTab !== id) {
      modal.billingTab = id;
      paintDialog();
      dialog.querySelector(`[data-action=billing-settings-tab][data-id=${id}]`)?.focus();
    }
    return;
  }
  if (modal?.type === 'billing-settings' && modal.billingTab === 'card' && action === 'payment-brand-add') {
    const container = dialog.querySelector('[data-payment-brand-settings]');
    if (container.children.length >= 20) { showError('決済ブランドは20件まで登録できます。'); return; }
    container.insertAdjacentHTML('beforeend',renderPaymentBrandSetting({id:crypto.randomUUID(),name:'',method:'card',rateBps:0,enabled:true}));
    container.lastElementChild.querySelector('[name=brandName]').focus();
    return;
  }
  if (modal?.type === 'billing-settings' && modal.billingTab === 'card' && action === 'payment-brand-remove') {
    target.closest('[data-payment-brand-setting]')?.remove();
    dialog.querySelector('[data-action=payment-brand-add]')?.focus();
    return;
  }
  if (action === 'print-document') { openPrintDocument(id,target.dataset.date,target.dataset.printKind); return; }
  if (action === 'extension-quote' && modal?.type === 'extend') {
    const extensionId = dialog.querySelector('[name=extensionId]:checked')?.value;
    if (!extensionId) return;
    try {
      const extensionMix = readExtensionMix(dialog.querySelector('form'));
      if (extensionMix !== undefined && modal.expectedMixTotal === undefined) {
        throw new Error('見積もりを開く前にプラン別の人数を確認してください。');
      }
      const quotePlanLabels = extensionPlans().map(({id,name}) => ({id,name}));
      if (extensionMix) quotePlanLabels.unshift({id:'@mixed',name:'選択中のプラン組み合わせ'});
      const options = {ticketId:modal.ticketId,extensionId,extensionMix,deductAdvance:true,quotePlanLabels,
        quotePlanIds:[extensionMix ? '@mixed' : extensionId],printWidth:getPrintSettings(state).width};
      options.estimate = buildExtensionQuote(options);
      openDialog('extension-quote',options);
    } catch (error) {
      showError(error.message);
    }
    return;
  }
  if (action === 'extension-quote-back' && modal?.type === 'extension-quote') {
    if (state.tickets.some(({id,status}) => id === modal.ticketId && status === 'open')) {
      openDialog('extend',{ticketId:modal.ticketId,extensionId:modal.extensionId,extensionMix:modal.extensionMix});
    } else dialog.close();
    return;
  }
  if (action === 'demo-role' && !cloudState.store && (['admin','manager','staff','cast'].includes(id) || getCustomRole(state,id))) {
    const profile = getCustomRole(state,id);
    if (id === 'cast' && !getCastWorkspace(state,'demo-cast')) {
      const occupiedCastIds = new Set((state.castAccounts ?? []).map(({castId})=>castId));
      const person = state.cast.find((entry)=>entry.enabled!==false && !occupiedCastIds.has(entry.id));
      if (person) saveState(apply(state,{type:'bindCastAccount',memberUid:'demo-cast',castId:person.id},Date.now(),
        {id:'demo-admin',role:'admin',label:'デモの店舗管理者'}));
    }
    demoRole = profile?.base ?? id;
    demoProfileId = profile ? id : undefined;
    dialog.close();
    if (!canOpenPage(page)) go(defaultPage()); else render();
    return;
  }
  if (action.startsWith('cast-') && page === 'cast-workspace') {
    const model = currentCastWorkspace();
    if (!model) return;
    if (action === 'cast-payroll-notice' && model.payroll.finals.some(({month})=>month === id)) {
      readCastPayrollNotice(model,id);
    } else if (action === 'cast-payslip-print') {
      const snapshot = model.payroll.finals.find(({month})=>month === id);
      if (snapshot) printWorkspace(payrollUI.renderPayrollPrint({month:id,snapshot},{escape,yen,storeName:cloudState.store?.name ?? '銀座店'}));
    } else if (['cast-clock-in','cast-clock-out','cast-request-shift','cast-request-pay'].includes(action)) {
      openDialog(action,{date:model.date,month:model.payroll.month,dailyPayLimit:model.dailyPayLimit});
    }
    return;
  }
  if (action === 'attendance-review' && page === 'attendance' && listCastAttendance(state).some((row)=>row.id===id)) {
    openDialog(action,{attendanceId:id});
    return;
  }
  if (page === 'attendance' && ['attendance-staff-editor','attendance-staff-void'].includes(action)) {
    const entry = getStaffLabor(state).attendance.find((row)=>row.id === id && row.voidedAt === undefined);
    if (entry || (!id && action === 'attendance-staff-editor')) openDialog(action,{staffAttendanceId:entry?.id ?? null});
    return;
  }
  if (action === 'attendance-editor' && page === 'attendance' && (!id || listCastAttendance(state).some((row)=>row.id===id))) {
    openDialog(action,{attendanceId:id});
    return;
  }
  if (modal?.type === 'attendance-editor' && ['attendance-break-add','attendance-break-remove'].includes(action)) {
    const list = dialog.querySelector('[data-attendance-breaks]');
    if (action === 'attendance-break-add' && list.children.length < 12) {
      list.insertAdjacentHTML('beforeend',renderManagedBreakRow({}, {escape,icon}));
      list.lastElementChild.querySelector('input').focus();
    }
    if (action === 'attendance-break-remove') target.closest('[data-attendance-break]')?.remove();
    return;
  }
  if (action === 'navigate') { if (dialog.open) dialog.close(); mobileDetails = false; go(id); return; }
  if (action === 'report-mode' && page === 'reports' && ['day','month','range'].includes(id)) {
    reportInterval.mode = id;
    reportExportError = '';
    render({preserveFocus:true});
    return;
  }
  if (action === 'report-day' && page === 'reports' && getReportDates(state).includes(id)) {
    reportDate = id === state.day.date ? '' : id;
    reportInterval.mode = 'day';
    reportExportError = '';
    go('reports');
    return;
  }
  if (action === 'report-export') { exportReport(id); return; }
  if (action === 'analytics-csv' && ['analytics','product-sales'].includes(page) && canOpenPage(page)) {
    const csv = buildAnalyticsCsv(page,state,analyticsRange);
    if (csv) downloadFile(`np-pos-${page}-${analyticsRange.end || state.day.date}.csv`,csv,'text/csv;charset=utf-8');
    return;
  }
  if (action === 'analytics-print' && ['analytics','product-sales'].includes(page) && canOpenPage(page)) {
    printWorkspace(renderAnalytics(page,state,{escape,icon,yen,range:analyticsRange,print:true}));
    return;
  }
  if (action === 'team-performance-csv' && page === 'team-performance' && canOpenPage(page)) {
    const csv = buildTeamPerformanceCsv(state,teamRange,teamRole);
    if (csv) downloadFile(`np-pos-staff-${teamRange.end || state.day.date}.csv`,csv,'text/csv;charset=utf-8');
    return;
  }
  if (action === 'labor-open') {
    laborRange = {start:target.dataset.start,end:target.dataset.end};
    go('labor');
    return;
  }
  if (action.startsWith('labor-') && page === 'labor') {
    if (action === 'labor-export' && ['summary','daily'].includes(id)) {
      const report = getLaborReport(state,laborRange);
      const csv = buildLaborCsv(report,id);
      if (csv) downloadFile(`np-pos-${id === 'daily' ? 'attendance' : 'labor'}-${report.start}-${report.end}.csv`,csv,'text/csv;charset=utf-8');
    } else if (['labor-person','labor-rate'].includes(action)) {
      const person = getStaffLabor(state).people.find((row)=>row.id === id);
      if (person || (!id && action === 'labor-person')) openDialog(action,{staffPersonId:person?.id ?? null});
    }
    return;
  }
  if (action.startsWith('shift-') && page === 'shifts') {
    if (action === 'shift-period' && ['day','week','month'].includes(id)) { shiftMode = id; render({preserveFocus:true}); }
    if (action === 'shift-navigate') { shiftDate = target.dataset.date; render({preserveFocus:true}); }
    if (action === 'shift-new') openDialog('shift-editor',{shiftDate:target.dataset.date});
    if (['shift-edit','shift-remove'].includes(action) && state.shifts?.some((entry) => entry.id === id)) {
      openDialog(action === 'shift-edit' ? 'shift-editor' : 'shift-remove',{shiftId:id});
    }
    return;
  }
  if (action === 'payroll-add-row' || action === 'payroll-remove-row') {
    if (modal?.type !== 'payroll-draft') return;
    const kind = target.dataset.kind;
    if (!['work','allowance','deduction'].includes(kind)) return;
    const form = dialog.querySelector('#dialog-form');
    const values = payrollUI.readPayrollRows(form,kind);
    if (action === 'payroll-remove-row') values.splice(Number(id),1);
    else if (values.length < (kind === 'work' ? 31 : 20)) values.push({});
    const group = form.querySelector(`[data-payroll-rows="${kind}"]`);
    const addButton = group.parentElement.querySelector('[data-action=payroll-add-row]');
    group.innerHTML = payrollUI.renderPayrollRows(kind,values,{escape,icon},modal.selection.month);
    (action === 'payroll-add-row' ? group.lastElementChild?.querySelector('input') : addButton)?.focus();
    return;
  }
  if (action === 'payroll-add-rule' || action === 'payroll-remove-rule') {
    if (!['payroll-settings','payroll-template-editor'].includes(modal?.type)) return;
    const form = dialog.querySelector('#dialog-form');
    const rules = payrollUI.readPayrollTemplateRows(form);
    if (action === 'payroll-remove-rule') rules.splice(Number(id),1);
    else if (rules.length < 20) rules.push({});
    const group = form.querySelector('[data-payroll-rules]');
    group.innerHTML = payrollUI.renderPayrollTemplateRows(rules,{escape,icon,state,variables:getPayrollVariables(state)});
    (action === 'payroll-add-rule' ? group.lastElementChild?.querySelector('input') : form.querySelector('[data-action=payroll-add-rule]'))?.focus();
    return;
  }
  if (['payroll-variable-add','payroll-variable-remove'].includes(action) && modal?.type === 'payroll-variables') {
    const form = dialog.querySelector('form');
    const rows = payrollUI.readPayrollVariables(form);
    if (action === 'payroll-variable-remove') rows.splice(Number(id),1);
    else if (rows.length < 30) rows.push({});
    form.querySelector('[data-payroll-variables]').innerHTML = payrollUI.payrollVariableRows(rows,{escape,icon},modal.selection.castId);
    if (action === 'payroll-variable-add') Array.from(form.querySelectorAll('[name=variableName]')).at(-1)?.focus();
    return;
  }
  if (modal?.type === 'payroll-attendance-items' && ['payroll-attendance-item-add','payroll-attendance-item-remove'].includes(action)) {
    const list = dialog.querySelector('[data-payroll-attendance-items]');
    if (action === 'payroll-attendance-item-add' && list.children.length < 50) {
      list.insertAdjacentHTML('beforeend',payrollUI.renderAttendanceItemRow({}, {escape,icon}));
      list.lastElementChild.querySelector('input:not([type=hidden])').focus();
    }
    if (action === 'payroll-attendance-item-remove') target.closest('[data-payroll-attendance-item]')?.remove();
    return;
  }
  if (modal?.type === 'payroll-range' && ['payroll-range-export','payroll-range-select-all','payroll-range-select-none'].includes(action)) {
    const form = target.form;
    if (action === 'payroll-range-export') {
      try {
        if (!form.reportValidity()) return;
        const data = new FormData(form);
        const range = payrollUI.readPayrollRange(data);
        if (!modal.result || Object.keys(range).some((key) => range[key] !== modal.range[key])) {
          throw new Error('集計条件を変更しました。もう一度「集計する」を押してください。');
        }
        const records = getPayrollRangeStatements(state,range,data.getAll('rangeExportCast'));
        void downloadPayrollZip({records,storeName:cloudState.store?.name ?? '銀座店',start:range.start,end:range.end,
          control:target,periodReference:true});
      } catch (error) { showError(error.message); }
    } else {
      for (const checkbox of form.querySelectorAll('[name="rangeExportCast"]:enabled')) {
        checkbox.checked = action === 'payroll-range-select-all';
      }
    }
    return;
  }
  if (action.startsWith('payroll-') && page === 'payroll') {
    const {month,castId} = payrollUI.getPayrollPageSelection(state,payrollMonth,payrollCastId);
    const selection = {month,castId};
    const record = getPayrollDraft(state,month,castId);
    if (action === 'payroll-print' && record?.status === 'final') {
      printWorkspace(payrollUI.renderPayrollPrint(record,{escape,yen,storeName:cloudState.store?.name ?? '銀座店'}));
    } else if (action === 'payroll-range') {
      openDialog(action,{range:payrollUI.payrollRangeDefaults(month)});
    } else if (['payroll-settings','payroll-templates','payroll-attendance-items','payroll-variables','payroll-batch'].includes(action)
      || (castId && ['payroll-rate','payroll-draft','payroll-request-pay','payroll-employee'].includes(action))
      || (action === 'payroll-finalize' && record?.status === 'draft')) {
      openDialog(action,{selection});
    } else if (action === 'payroll-template-editor' && (!id || getPayrollTemplates(state).some((row) => row.id === id))
      || action === 'payroll-template-remove' && getPayrollTemplates(state).some((row) => row.id === id)) {
      openDialog(action,{selection,templateId:id || null});
    } else if (['payroll-review-pay','payroll-pay'].includes(action) && getPayrollDailyPays(state,selection).some((entry) => entry.id === id)) {
      openDialog(action,{dailyPayId:id});
    }
    return;
  }
  if (action === 'customer-visit') {
    const date = target.dataset.date;
    const ticket = date === state.day.date ? state.tickets.find((entry) => entry.id === id)
      : state.closedDays.find((day) => day.date === date)?.ticketSnapshots?.find((entry) => entry.id === id);
    if (ticket && ['paid','departed'].includes(ticket.status)) openDialog('history-receipt',{receipt:ticket,date});
    else if (ticket?.status === 'open' && date === state.day.date) openTicket(id);
    else {
      const record = state.cancelledSettlements?.find((entry) => entry.ticketId === id && entry.date === date);
      if (record) openDialog('cancelled-receipt',{record});
    }
    return;
  }
  if (action === 'customer-reset-filters') {
    customerFilters = {};
    customersQuery = '';
    render({preserveFocus:true});
    app.querySelector('[name=customerSearch]')?.focus({preventScroll:true});
    return;
  }
  if (action === 'filter') { filter=id; render({preserveFocus:true}); return; }
  if (action === 'toggle-hidden-stock') {
    showHiddenStock = !showHiddenStock;
    render({ preserveFocus: true });
    return;
  }
  if (action === 'stock-barcode-register' || action === 'stock-barcode-search') {
    void scanStockBarcode(action);
    return;
  }
  if (action === 'commission-cast') {
    commissionCast = id === commissionCast ? '' : id ?? '';
    render({ preserveFocus: true });
    return;
  }
  if (action === 'floor-view') {
    const nextArea = area ?? planArea;
    setFloorView(id, nextArea);
    if (id === 'plan') selectVisibleTicket();
    render({preserveFocus:true});
    return;
  }
  if (action === 'layout-view-area') {
    if (!getLayoutAreas(state).includes(id)) return;
    setFloorView('plan', id);
    selectVisibleTicket();
    render({preserveFocus:true});
    return;
  }
  if (action === 'demo-backup') {
    let localAtOpen;
    try { localAtOpen = readSavedState(); } catch { /* Download still works in the current tab. */ }
    openDialog(action,{localAtOpen});
    return;
  }
  if (action === 'demo-backup-download' && modal?.type === 'demo-backup') {
    void exportDemoBackup(modal);
    return;
  }
  if (action === 'layout-transfer') {
    openDialog(action, { fileName: '', configuration: null, error: '', loading: false, fresh: freshLayoutTarget() });
    return;
  }
  if (action === 'layout-export') { exportStoreFile(); return; }
  if (action === 'store-settings' || action === 'stock-settings') {
    const tab = action === 'stock-settings' ? 'stock' : ['plans','cast'].includes(id) ? id : 'menu';
    openDialog('store-settings', { editor: { settings: getStoreSettings(state), tab, selected: {} } });
    return;
  }
  if (action.startsWith('store-editor-') && modal?.editor) {
    if (handleStoreSettingsEditorAction(dialog, modal.editor, target, {
      stockDeletionBlocker: checkStockDeletion, catalogDeletionBlocker: checkCatalogDeletion,
    })) paintDialog();
    return;
  }
  if (action === 'edit-layout') {
    const preferredArea = floorView === 'plan' ? planArea : area;
    openDialog(action, { layout: newLayoutDraft(state, preferredArea, selected) });
    return;
  }
  if (action.startsWith('layout-editor-') && modal?.layout) {
    handleLayoutEditorAction(dialog, modal.layout, target, escape);
    return;
  }
  if (action === 'hide-detail') { mobileDetails=false; render(); return; }
  if (action === 'dismiss') { dialog.close(); return; }
  if (action === 'open-ticket') { openTicket(id); return; }
  if (action === 'history-receipt') {
    const date = target.dataset.date;
    const archived = state.closedDays.find((day) => day.date === date)?.ticketSnapshots?.find((entry) => entry.id === id);
    const receipt = archived ?? (date === state.day.date ? state.tickets.find((entry) => entry.id === id) : null);
    if (receipt && ['paid', 'departed'].includes(receipt.status)) openDialog(action, { receipt, date });
    return;
  }
  if (action === 'cancelled-receipt') {
    const record = state.cancelledSettlements?.find((item) => item.id === id);
    if (record) openDialog(action,{record});
    return;
  }
  if (action === 'table') {
    if (state.day.status === 'closed') { openDialog('open'); return; }
    const ticket = getTicketForTable(state,id);
    if (!ticket) {
      if (permittedAction('seat')) openDialog('seat',{tableId:id});
      return;
    }
    selected = id;
    mobileDetails = true;
    render({preserveFocus:true});
    if (matchMedia('(max-width: 1050px)').matches) app.querySelector('.detail-mobile-close')?.focus();
    return;
  }
  if (['demo','open','seat','close','record-cash'].includes(action)) {openDialog(action); return;}
  if (['demo-start','demo-live','demo-cash','demo-reports','demo-analytics','demo-billing','demo-payroll','demo-labor','demo-customer-notices'].includes(action)) {
    const fromOpening = action === 'demo-start';
    const cashSample = action === 'demo-cash';
    const reportSample = action === 'demo-reports';
    const analyticsSample = action === 'demo-analytics';
    const billingSample = action === 'demo-billing';
    const payrollSample = action === 'demo-payroll';
    const laborSample = action === 'demo-labor';
    const customerNoticeSample = action === 'demo-customer-notices';
    let sample = analyticsSample ? createVisitAnalyticsDemo() : customerNoticeSample ? createCustomerNoticeDemo() : laborSample ? createLaborDemo() : payrollSample ? createPayrollDemo() : billingSample ? createBillingDemo() : reportSample ? createPeriodReportDemo()
      : cashSample ? createCashDemo() : createPhaseTwoDemo(fromOpening ? 'closed' : 'live');
    if (cashSample || reportSample || analyticsSample || billingSample || payrollSample || laborSample || customerNoticeSample) demoRole = 'admin';
    if (fromOpening) {
      sample.tables = structuredClone(state.tables);
      sample.layoutAreas = getLayoutAreas(state);
      sample.archivedTables = structuredClone(state.archivedTables ?? []);
      if (state.controls) sample.controls = structuredClone(state.controls);
      if (state.autoExtensionSettings) sample.autoExtensionSettings = structuredClone(state.autoExtensionSettings);
      if (state.bulkExtensionEnabled !== undefined) sample.bulkExtensionEnabled = state.bulkExtensionEnabled;
      if (state.tableAutoExtension) sample.tableAutoExtension = structuredClone(state.tableAutoExtension);
      if (state.cardFeeSettings) sample.cardFeeSettings = structuredClone(state.cardFeeSettings);
      if (state.initialSetSchedule) sample.initialSetSchedule = structuredClone(state.initialSetSchedule);
      if (state.calculationSettings) sample.calculationSettings = structuredClone(state.calculationSettings);
      const retainedStock = new Set(state.stock.map(({ id }) => id));
      sample.stock = sample.stock.filter(({ id }) => retainedStock.has(id));
      sample = apply(sample, { type: 'saveStoreSettings', settings: getStoreSettings(state) });
    }
    saveState(sample);
    announcedAutoExtensions.clear();
    selected = fromOpening || cashSample || reportSample || analyticsSample ? null : 'a1';
    area=null; filter='all'; showHiddenStock=false; mobileDetails=false;
    reportDate = ''; commissionCast = ''; customersQuery = ''; customerFilters = {};
    analyticsRange = analyticsSample ? {start:getReportDates(sample)[0],end:sample.day.date} : {};
    payrollMonth = ''; payrollCastId = '';
    teamRange = {}; teamRole = 'all'; shiftDate = ''; shiftMode = 'week';
    laborRange = laborSample ? {start:getStaffLabor(sample).attendance[0].date,end:sample.day.date} : {};
    reportInterval = reportSample ? {mode:'range',start:getReportDates(sample)[0],end:sample.day.date} : {mode:'day'};
    reportExportError = '';
    if (!fromOpening) setFloorView('list',getLayoutAreas(state)[0]);
    go(analyticsSample ? 'analytics' : customerNoticeSample ? 'customers' : laborSample ? 'labor' : payrollSample ? 'payroll' : reportSample ? 'reports' : cashSample ? 'cash' : 'floor');
    if (fromOpening) openDialog('open');
    else {
      dialog.close();
      toast(analyticsSample ? '滞在・指名分析のサンプルを読み込みました。' : customerNoticeSample ? '顧客のお知らせのサンプルを読み込みました。' : laborSample ? '役職別の勤怠と人件費のサンプルを読み込みました。' : payrollSample ? '給与と日払いのサンプルを読み込みました。' : billingSample ? 'A-01は約30秒後に自動延長。A-02の自動延長はオフです。'
        : reportSample ? '期間集計のサンプルを読み込みました。'
        : cashSample ? '入出金と日報のサンプルを読み込みました。' : '営業中のサンプルを読み込みました。');
    }
    return;
  }
  if (action==='category') {
    if (modal?.type !== 'order') return;
    modal.category=id;
    modal.search='';
    dialog.querySelector('#menu-search').value='';
    for (const control of dialog.querySelectorAll('[data-action=category]')) control.setAttribute('aria-pressed',String(control.dataset.id===id));
    reviseProduct();
    return;
  }
  if (action==='product') {
    if (modal?.type !== 'order') return;
    if (modal.product===id) return;
    modal.product=id;
    delete modal.editingOrderIndex;
    refreshOrderSelection();
    return;
  }
  if (['order-line-edit','order-line-remove','order-line-stage','order-line-reset'].includes(action) && modal?.type === 'order') {
    const index = Number(id);
    if (action === 'order-line-edit') {
      if (!modal.orderItems[index]) return;
      modal.editingOrderIndex = index;
      modal.product = modal.orderItems[index].menuId;
      refreshOrderSelection();
      dialog.querySelector('#order-selection input')?.focus();
      return;
    }
    if (action === 'order-line-remove') {
      if (!modal.orderItems[index]) return;
      modal.orderItems.splice(index,1);
      if (modal.editingOrderIndex !== undefined && modal.editingOrderIndex !== index) {
        if (modal.editingOrderIndex > index) modal.editingOrderIndex--;
        dialog.querySelector('#order-cart').innerHTML = renderOrderCart();
        return;
      }
      if (modal.editingOrderIndex === undefined) {
        dialog.querySelector('#order-cart').innerHTML = renderOrderCart();
        return;
      }
    }
    if (action === 'order-line-stage') {
      const line = currentOrderLine(dialog.querySelector('#dialog-form'));
      if (modal.editingOrderIndex !== undefined) modal.orderItems[modal.editingOrderIndex] = line;
      else {
        if (modal.orderItems.length >= 100) throw new Error('一度に登録できる明細は100件までです。');
        modal.orderItems.push(line);
      }
    }
    delete modal.editingOrderIndex;
    modal.product = '';
    refreshOrderSelection();
    dialog.querySelector('#order-products .product')?.focus();
    return;
  }
  if (action==='add-payment' || action==='remove-payment') {
    modal.payments=currentPayments();
    if (action==='add-payment') {
      if (modal.payments.length>=3) {showError('一度に登録できる支払行は3件までです。');return;}
      const due=quote(state,modal.ticketId).remaining;
      const rest=due-modal.payments.reduce((sum,entry)=>sum+entry.amount,0);
      const method=Object.keys(tenderMethods).find(key=>!modal.payments.some(entry=>entry.method===key)) ?? 'cash';
      modal.payments.push({method,amount:Math.max(0,rest)});
    } else modal.payments.splice(Number(id),1);
    dialog.querySelector('#payment-rows').innerHTML=modal.payments.map(renderPayment).join('');
    updatePaymentNote();
    if (action==='add-payment') dialog.querySelector('.payment-row:last-child [name=paymentAmount]')?.focus();
    return;
  }
  if (action === 'edit-deposit' && modal?.type === 'deposit') {
    openDialog(action,{ticketId:modal.ticketId,depositId:id});
    return;
  }
  if (action==='cancel-deposit') {
    const ticketId=modal.ticketId;
    const entry=state.tickets.find(item=>item.id===ticketId).deposits.find(item=>item.id===id);
    modal={...modal,type:'cancel-deposit',ticketId,depositId:id};
    present('前受金を取り消す',`<p class="form-copy">${escape(entry.brandName || tenderMethods[entry.method])}で記録した受取額 ${yen(depositGrossAmount(entry))} を取り消します。</p>`,'前受金を取り消す');
    return;
  }
  modalFromAction(target);
}

async function downloadPayrollZip({records,storeName,start,end,control,periodReference = false}) {
  const active = modal;
  if (active.zipInProgress) return;
  active.zipInProgress = true;
  const source = active.result;
  const label = control.innerHTML;
  const title = periodReference ? '給与期間参考明細' : '支給明細';
  control.disabled = true;
  control.textContent = 'PDFを作成中…';
  try {
    const {createPayrollZip,createPayrollRangeZip} = await import('./payroll-pdf.mjs');
    const archive = await (periodReference ? createPayrollRangeZip : createPayrollZip)(records,storeName);
    if (modal === active && active.result === source && dialog.open && currentRole() === 'admin') {
      downloadFile(`NP-POS_${title}_${start}${start === end ? '' : `_${end}`}.zip`,archive);
      toast('個別PDFのZIPを保存しました。');
    }
  } catch (error) {
    if (modal === active && active.result === source && dialog.open) showError(error.message);
  } finally {
    active.zipInProgress = false;
    control.disabled = false;
    control.innerHTML = label;
  }
}

function submitDialog(form) {
  const data = new FormData(form);
  const value = (key) => data.get(key);
  const numeric = (key) => Number(value(key));
  const id = modal.ticketId;
  switch(modal.type) {
    case 'cast-clock-in':
      commit({type:'castClockIn'},'出勤を記録しました。');
      break;
    case 'cast-clock-out':
      commit({type:'castClockOut',breakMinutes:numeric('castBreakMinutes')},'退勤を記録しました。');
      break;
    case 'cast-request-shift': {
      const {date,startMinute,endMinute,note} = readShiftForm(data);
      commit({type:'castRequestShift',date,startMinute,endMinute,note},'勤務希望を送信しました。');
      break;
    }
    case 'cast-request-pay':
      commit({type:'castRequestDailyPay',month:modal.month,amount:numeric('dailyPayAmount'),reason:value('reason')},'日払いの申請を送信しました。');
      break;
    case 'attendance-review':
      commit({type:'reviewCastAttendance',attendanceId:modal.attendanceId,decision:value('attendanceDecision'),reason:value('reason')},'勤怠の確認結果を保存しました。');
      break;
    case 'attendance-editor':
      commit({type:'saveManagedAttendance',attendanceId:modal.attendanceId,...readManagedAttendance(data)},'勤怠を保存しました。');
      break;
    case 'attendance-staff-editor':
      commit({type:'saveStaffAttendance',attendanceId:modal.staffAttendanceId,personId:value('staffAttendancePerson'),
        date:value('staffAttendanceDate'),clockInAt:parseTokyoDateTime(value('staffClockIn')),clockOutAt:parseTokyoDateTime(value('staffClockOut')),
        breakMinutes:numeric('staffBreak'),reason:value('staffAttendanceReason')},'勤務を保存しました。');
      break;
    case 'attendance-staff-void':
      commit({type:'voidStaffAttendance',attendanceId:modal.staffAttendanceId,reason:value('reason')},'勤務を取り消しました。');
      break;
    case 'labor-person': {
      const [role,profileId] = String(value('staffRole')).split('/');
      commit({type:'saveStaffPerson',personId:modal.staffPersonId,name:value('staffName'),role,profileId,enabled:data.has('staffEnabled')},
        '勤務者を保存しました。');
      break;
    }
    case 'labor-rate':
      commit({type:'saveStaffRate',personId:modal.staffPersonId,effectiveDate:value('staffRateDate'),hourlyRate:numeric('staffHourlyRate')},
        '時給を保存しました。');
      break;
    case 'payroll-employee':
      commit({type:'saveEmployeeProfile',castId:modal.selection.castId,profile:payrollUI.readEmployeeProfile(data)},'従業員台帳を保存しました。');
      break;
    case 'payroll-attendance-items':
      commit({type:'saveAttendanceItems',items:payrollUI.readAttendanceItems(data)},'勤怠項目を保存しました。');
      break;
    case 'set-schedule':
      commit({type:'saveInitialSetSchedule',rules:readInitialSetSchedule(data)},'時間帯別セットを保存しました。');
      break;
    case 'shift-editor': {
      const fields = readShiftForm(data);
      commit({type:'saveShift',shiftId:modal.shiftId,...fields},'シフトを保存しました。',() => {shiftDate = fields.date;});
      break;
    }
    case 'shift-remove':
      commit({type:'removeShift',shiftId:modal.shiftId},'シフトを削除しました。');
      break;
    case 'payroll-settings':
      commit({type:'savePayrollSettings',settings:{pointRate:numeric('payrollPointRate'),commissionRounding:value('payrollRounding'),
        commissionUnit:numeric('payrollUnit'),dailyPayLimitBps:Math.round(numeric('dailyPayLimit') * 100),
        statementRules:payrollUI.readPayrollTemplateRows(form)}},'給与設定を保存しました。');
      break;
    case 'payroll-variables':
      commit({type:'savePayrollVariables',castId:modal.selection.castId || null,variables:payrollUI.readPayrollVariables(form)},
        '給与の個人別変数を保存しました。');
      break;
    case 'payroll-templates':
      commit({type:'assignPayrollTemplate',castId:modal.selection.castId,templateId:value('payrollTemplateId') || null},'給与の計算テンプレートを割り当てました。');
      break;
    case 'payroll-template-editor':
      commit({type:'savePayrollTemplate',templateId:modal.templateId,name:value('payrollTemplateName'),
        columns:numeric('payrollTemplateColumns'),isDefault:data.has('payrollTemplateDefault'),
        rules:payrollUI.readPayrollTemplateRows(form)},'給与の計算テンプレートを保存しました。');
      break;
    case 'payroll-range': {
      const range = payrollUI.readPayrollRange(data);
      const result = previewPayrollRange(state,range);
      Object.assign(modal,{range,result});
      paintDialog();
      dialog.querySelector('#submit-dialog')?.focus();
      break;
    }
    case 'payroll-batch': {
      const start = value('batchStart');
      const end = value('batchEnd');
      const castId = value('batchCast');
      if (!isPayrollMonth(start) || !isPayrollMonth(end) || start > end) throw new Error('出力する期間を確認してください。');
      const records = (state.payroll?.records ?? []).filter((row)=>row.status === 'final'
        && row.month >= start && row.month <= end && (!castId || row.castId === castId))
        .sort((a,b)=>a.month.localeCompare(b.month) || a.snapshot.castName.localeCompare(b.snapshot.castName,'ja'));
      if (!records.length) throw new Error('この期間の確定明細はありません。');
      const api = {escape,yen,storeName:cloudState.store?.name ?? '銀座店'};
      if (value('batchOutput') === 'zip') {
        const control = form.querySelector('#submit-dialog');
        if (!control.disabled) void downloadPayrollZip({records,storeName:api.storeName,start,end,control});
      } else printWorkspace(records.map((record)=>`<section class="payroll-print-page">${payrollUI.renderPayrollPrint(record,api)}</section>`).join(''));
      break;
    }
    case 'payroll-template-remove':
      commit({type:'removePayrollTemplate',templateId:modal.templateId},'給与の計算テンプレートを削除しました。');
      break;
    case 'payroll-rate':
      commit({type:'savePayrollRate',castId:modal.selection.castId,effectiveDate:value('payrollRateDate'),hourlyRate:numeric('payrollHourlyRate')},'時給を保存しました。');
      break;
    case 'payroll-draft':
      commit({type:'savePayrollDraft',...payrollUI.readPayrollDraft(form,modal.selection)},'給与の下書きを保存しました。');
      break;
    case 'payroll-finalize':
      commit({type:'finalizePayroll',...modal.selection},'給与を確定しました。');
      break;
    case 'payroll-request-pay':
      commit({type:'requestDailyPay',...modal.selection,amount:numeric('dailyPayAmount'),reason:value('reason')},'日払い申請を保存しました。');
      break;
    case 'payroll-review-pay':
      commit({type:'reviewDailyPay',dailyPayId:modal.dailyPayId,decision:value('dailyPayDecision'),reason:value('reason')},'日払い申請の審査結果を保存しました。');
      break;
    case 'payroll-pay':
      commit({type:'payDailyPay',dailyPayId:modal.dailyPayId,method:value('dailyPayMethod')},'日払いの支給を記録しました。');
      break;
    case 'cloud-migration':
      void migrateBrowserData();
      break;
    case 'demo-backup':
      void restoreDemoBackup(modal);
      break;
    case 'layout-transfer': {
      if (!modal.configuration) return;
      const message = modal.configuration.settings ? '店舗設定と卓レイアウトを読み込みました。' : '卓レイアウトを読み込みました。';
      commit({ type: 'importStoreConfiguration', configuration: modal.configuration }, message, (next) => {
        setFloorView('plan', getLayoutAreas(next)[0] ?? null);
        area = null; filter = 'all'; showHiddenStock = false; mobileDetails = false; syncFloorSelection();
      });
      break;
    }
    case 'store-settings': {
      if (!commitStoreSettingsEditor(dialog, modal.editor)) return;
      const removeStockIds = [...(modal.editor.removeStockIds ?? [])];
      const removeMenuIds = [...(modal.editor.removeMenuIds ?? [])];
      const removeCastIds = [...(modal.editor.removeCastIds ?? [])];
      const settings = structuredClone(modal.editor.settings);
      commit({ type: 'saveStoreSettings', settings, removeStockIds, removeMenuIds, removeCastIds }, '店舗設定を保存しました。', () => {
        showHiddenStock = false;
      });
      break;
    }
    case 'edit-layout': {
      const layout = modal.layout;
      if (!commitLayoutFields(dialog, layout, escape).ok) return;
      commit({type:'saveLayout',areas:layout.areas,tables:layout.tables},'卓のレイアウトを保存しました。',()=>{
        setFloorView('plan', layout.area);
        filter='all'; mobileDetails=false; syncFloorSelection();
      });
      break;
    }
    case 'open':
      commit({type:'open',date:value('date'),openingCash:numeric('openingCash')},'開店しました。空席から来店を登録できます。');
      break;
    case 'customer-new':
    case 'customer-edit': {
      const customer = customerUI.readCustomerForm(form,data);
      commit({type:'saveCustomer',customerId:modal.customerId,customer},'顧客情報を保存しました。');
      break;
    }
    case 'ticket-customer':
      if (!hasTicketCustomerChange()) break;
      commit({type:'setTicketCustomer',ticketId:id,customerId:modal.seatCustomerId},
        modal.seatCustomerId ? '伝票に顧客をひもづけました。' : '伝票の顧客のひもづけを解除しました。');
      break;
    case 'ticket-note':
      commit({type:'saveTicketNote',ticketId:id,note:value('ticketNote')},'伝票メモを保存しました。');
      break;
    case 'ticket-end':
      commit({type:'adjustTicketEnd',ticketId:id,minutes:numeric('timeAdjustment'),reason:value('reason')},'終了時刻を更新しました。');
      break;
    case 'ticket-set-time':
      commit({type:'adjustTicketEnd',ticketId:id,startsAt:parseTokyoDateTime(value('startsAt')),endsAt:parseTokyoDateTime(value('endsAt')),
        reason:value('reason')},'セット時間を更新しました。');
      break;
    case 'ticket-guests':
      commit({type:'adjustTicketGuests',ticketId:id,mode:value('guestChangeMode'),count:numeric('guestChangeCount'),reason:value('reason')},
        '利用人数を更新しました。');
      break;
    case 'settled-ticket-customer': {
      const reason = value('customerCorrectionReason')?.trim();
      if (!hasTicketCustomerChange() || !reason) break;
      void commitReceiptCorrection({type:'correctSettledTicketCustomer',ticketId:id,customerId:modal.seatCustomerId,reason},
        '会計済み伝票の顧客を訂正しました。');
      break;
    }
    case 'settled-ticket-payment': {
      const {difference,changed,payments} = readPaymentCorrection(form,modal.paymentCorrection);
      const reason = value('reason')?.trim();
      if (difference !== 0 || !changed || !reason) break;
      void commitReceiptCorrection({type:'correctSettledTicketPayments',ticketId:id,payments,reason},
        '会計済み伝票の支払方法を訂正しました。');
      break;
    }
    case 'settled-ticket-contents': {
      const {ticket} = findSettledCustomerTicket(state,id);
      const action = readSettledContents(form,modal);
      const {totals} = previewSettledContents(state,ticket,{...action,at:Date.now()});
      if (modal.previewSettledTotal !== totals.total) {
        updateSettledContentsPreview(form);
        throw new Error('金額が更新されました。訂正後の金額を確認してください。');
      }
      void commitReceiptCorrection({type:'correctSettledContents',...action,expectedTotal:totals.total},'注文・値引きを訂正しました。');
      break;
    }
    case 'customer-merge':
      commit({type:'mergeCustomers',sourceId:value('sourceId'),targetId:modal.customerId,reason:value('reason')},'顧客と履歴を統合しました。');
      break;
    case 'customer-link': {
      const ticketId = value('ticketId');
      if (findSettledCustomerTicket(state,ticketId)) openSettledCustomerEditor(ticketId,{seatCustomerId:modal.customerId});
      else commit({type:'linkCustomer',ticketId,customerId:modal.customerId},'来店をひもづけました。');
      break;
    }
    case 'customer-import':
      commit({type:'importCustomers',customers:parseCustomersCsv(value('csv'),state.cast)},'顧客を読み込みました。');
      break;
    case 'seat': {
      const selectedIds=data.getAll('tableIds');
      const tableIds=modal.tableId ? [modal.tableId,...selectedIds] : selectedIds;
      const customerId = modal.seatCustomerId || value('customerId') || undefined;
      const arrangedTime = value('arrivedAt');
      const arrivedAt = arrangedTime ? parseTokyoDateTime(arrangedTime) : undefined;
      if (arrangedTime && !Number.isFinite(arrivedAt)) throw new Error('日本時間の来店日時を確認してください。');
      commit({type:'seat',tableIds,guests:numeric('guests'),customerId,setId:value('setId'),...(arrangedTime && {arrivedAt})},
        '来店を登録しました。',()=>{revealTable(tableIds[0]); area=null;filter='all';mobileDetails=true;});
      break;
    }
    case 'move': {
      const tableIds=data.getAll('tableIds');
      commit({type:'move',ticketId:id,tableIds},'使用卓を変更しました。',()=>{if (!tableIds.includes(selected)) revealTable(tableIds[0]); area=null;filter='all';});
      break;
    }
    case 'order': {
      const items = orderItemsFromForm(form);
      if (!items.length || items.length > 100) throw new Error('1〜100件の明細を注文リストに追加してください。');
      commit({type:'order',ticketId:id,items},'注文を確定しました。在庫と歩合見込を更新しました。');
      break;
    }
    case 'edit-ticket-line':
      commit(editTicketLineCommand(form),'注文明細を訂正しました。');
      break;
    case 'cancel-ticket-extension':
      commit({type:'cancelTicketExtension',ticketId:id,lineId:modal.lineId,reason:value('reason')},'延長を取り消しました。');
      break;
    case 'extend':
    case 'extend-overdue': {
      const command = extensionCommand(form);
      if (command.plans !== undefined) {
        if (modal.expectedMixTotal === undefined) throw new Error('プラン別の人数を確認してください。');
        command.expectedTotal = modal.expectedMixTotal;
      }
      if (command.type === 'extendOverdue' && command.expectedCount === undefined) break;
      const message = command.type === 'extendOverdue'
        ? `${command.expectedCount}回分の延長を登録しました。`
        : `${extensionPlans().find(({id}) => id === value('extensionId')).duration}分延長しました。`;
      commit(command,message);
      break;
    }
    case 'deposit':
    case 'edit-deposit': {
      const previous = currentDeposit();
      if (modal.type === 'edit-deposit' && !previous) throw new Error('前受金が見つかりません。伝票を開き直してください。');
      const payment = readDepositPayment();
      if (modal.expectedDepositFee === undefined) throw new Error('前受金の決済額を確認してください。');
      commit({type:previous?'editDeposit':'deposit',ticketId:id,...payment,expectedCardFee:modal.expectedDepositFee,memo:value('depositMemo'),
        ...(previous && {depositId:previous.id,reason:value('reason')})},previous?'前受金を訂正しました。':'前受金を記録しました。');
      break;
    }
    case 'cancel-deposit':
      commit({type:'cancelDeposit',ticketId:id,depositId:modal.depositId},'前受金を取り消しました。');
      break;
    case 'ops-settings':
      commit({type:'saveControls',managerDiscountRateBps:Math.round(numeric('managerDiscountLimit')*100),
        register:{cutoff:value('registerCutoff'),hoursStart:value('hoursStart'),hoursEnd:value('hoursEnd'),
          openingMode:value('openingMode'),openingCash:numeric('openingDefault')}},'運用設定を保存しました。');
      break;
    case 'calculation-settings':
      commit({type:'saveCalculationSettings',settings:{serviceRateBps:Math.round(numeric('serviceRate')*100),priceMode:value('priceMode'),
        serviceBase:value('serviceBase'),serviceRounding:value('serviceRounding'),taxRounding:value('taxRounding'),
        allowOrderServiceExclusion:data.has('allowOrderServiceExclusion')}},'計算設定を保存しました。');
      break;
    case 'discount':
      commit({type:'discount',ticketId:id,mode:value('discountMode'),value:numeric('discountValue'),
        reasonCode:value('reasonCode'),reason:value('reason'),personalSalesMode:value('personalSalesMode')},'値引きの入力を保存しました。');
      break;
    case 'personal-sales-adjustment':
      commit({type:'adjustPersonalSales',ticketId:id,castId:value('personalSalesCast'),
        amount:numeric('personalSalesAmount') * (value('personalSalesDirection') === 'subtract' ? -1 : 1),reason:value('reason')},
      '個人売上の調整を記録しました。');
      break;
    case 'discount-review':
    case 'discount-reject':
      commit({type:modal.type==='discount-review'?'approveDiscount':'rejectDiscount',ticketId:id,
        requestId:modal.requestId,reason:value('reason')},modal.type==='discount-review'?'値引きを承認しました。':'値引き申請を却下しました。');
      break;
    case 'table-auto-extension':
      commit({type:'setTableAutoExtension',tableId:modal.autoTableId,enabled:data.has('tableAutoExtensionEnabled')},
        '卓の自動延長設定を保存しました。');
      break;
    case 'billing-settings':
      if (modal.billingTab === 'card') {
        const brands = currentPaymentBrands(form);
        const settings = {enabled:data.has('cardFeeEnabled'),rateBps:Math.round(numeric('cardFeeRate') * 100)};
        if (brands.length || getCardFeeSettings(state).brands) settings.brands = brands;
        commit({type:'saveCardFeeSettings',settings},'決済の加算設定を保存しました。');
      } else {
        commit({type:'saveAutoExtensionSettings',enabled:data.has('autoExtensionEnabled'),menuId:value('autoExtensionPlan') ?? '',
          bulkExtensionEnabled:data.has('bulkExtensionEnabled')},'延長の設定を保存しました。');
      }
      break;
    case 'print-settings': {
      const autoPrintKind = value('printAutoKind');
      const documents = Object.fromEntries(Object.keys(printDocumentTitles).map((kind)=>[kind,{
        grouping:value(`printGrouping-${kind}`),items:value(`printItems-${kind}`),
        showTender:data.has(`printTender-${kind}`),storeCopy:data.has(`printCopy-${kind}`),
      }]));
      commit({type:'savePrintSettings',settings:{width:numeric('printWidth'),storeName:value('printStoreName'),
        address:value('printAddress'),phone:value('printPhone'),registrationNumber:value('printRegistrationNumber'),
        showItems:data.has('printShowItems'),autoReceipt:autoPrintKind === 'receipt',autoPrintKind,
        invoiceDate:value('printInvoiceDate'),invoicePurpose:value('printInvoicePurpose'),documents}},'印刷設定を保存しました。');
      break;
    }
    case 'accounting-settings':
      commit({type:'saveAccountingCsv',mode:modal.csvMode,settings:readAccountingCsvEditor(form)},'会計CSVの設定を保存しました。');
      break;
    case 'role-policy':
      commit({type:'saveRolePolicy',policy:readRolePolicy(form)},'役職と権限を保存しました。');
      break;
    case 'cash-accounts':
      commit({type:'saveCashAccounts',accounts:readCashAccounts(form)},'金庫と出金先を保存しました。');
      break;
    case 'print-document':
      void issuePrintDocument({...modal,printWidth:numeric('printWidth'),
        printRecipient:value('printRecipient') ?? '',printPurpose:value('printPurpose') ?? ''});
      break;
    case 'extension-quote': {
      if (!modal.quotePlanIds.length) throw new Error('印刷する延長プランを1つ以上選択してください。');
      const estimate = buildExtensionQuote(modal);
      const preview = renderExtensionQuote(modal.estimate,{escape,yen});
      if (renderExtensionQuote({...estimate,at:modal.estimate.at},{escape,yen}) !== preview) {
        modal.estimate = estimate;
        paintDialog();
        showError('伝票の内容が更新されました。最新の見積もりを確認してから印刷してください。');
        break;
      }
      printMarkup(preview);
      break;
    }
    case 'settle': {
      const payments = currentPayments().filter(({amount}) => amount > 0);
      const cashReceived = value('cashReceived') ? numeric('cashReceived') : undefined;
      calculateCashTender(payments,cashReceived);
      void settleAndPrint({type:'settle',ticketId:id,payments,expectedCardFee:getCardFee(state,payments),
        ...(cashReceived === undefined ? {} : {cashReceived})});
      break;
    }
    case 'depart':
      commit({type:'depart',ticketId:id},'退店を記録し、使用卓を解放しました。',()=>{selected=null;mobileDetails=false;});
      break;
    case 'cancel-settlement':
      commit({type:'cancelSettlement',ticketId:id,reason:value('reason')},'会計を取り消しました。',()=>{
        selected = null; mobileDetails = false; reportDate = ''; page = 'reports';
        reportInterval.mode = 'day'; reportExportError = '';
        history.replaceState(null,'','#reports'); window.scrollTo(0,0);
      });
      break;
    case 'reopen-ticket': {
      const tableIds = data.getAll('tableIds');
      commit({type:'reopenTicket',ticketId:id,tableIds,reason:value('reason')},'伝票を再オープンしました。',()=>{
        page = 'floor'; history.replaceState(null,'','#floor'); revealTable(tableIds[0]);
        area = null; filter = 'all'; mobileDetails = true; window.scrollTo(0,0);
      });
      break;
    }
    case 'cancel-line':
      commit({type:'cancelLine',ticketId:id,lineId:modal.lineId,returnStock:data.has('returnStock'),reason:value('reason')},'注文を取り消しました。');
      break;
    case 'record-cash':
      commit({type:'recordCashMovement',kind:value('cashKind'),category:value('cashCategory'),
        amount:numeric('cashAmount'),destination:value('cashDestination'),reason:value('reason'),cashAccountId:value('cashAccountId')},
        '入出金を記録し、レジの理論残高を更新しました。');
      break;
    case 'edit-cash-movement':
      commit({type:'editCashMovement',movementId:modal.movementId,kind:value('cashKind'),category:value('cashCategory'),
        amount:numeric('cashAmount'),destination:value('cashDestination'),reason:value('reason'),correctionReason:value('cashCorrectionReason'),
        cashAccountId:value('cashAccountId')},
      '入出金を訂正しました。');
      break;
    case 'void-cash-movement':
      commit({type:'voidCashMovement',movementId:modal.movementId,correctionReason:value('cashCorrectionReason')},'入出金を取り消しました。');
      break;
    case 'correct-register-count': {
      const counts = data.has('countByDenomination') ? readCashDenominations() : undefined;
      const actualCash = counts ? getCashCountTotal(counts) : numeric('actualCash');
      if (actualCash === null) throw new Error('金種別の合計金額を確認してください。');
      commit({type:'correctRegisterCount',date:modal.closeDate,actualCash,reason:value('reason'),
        ...(counts && {cashDenominations:counts})},'日報の実残高を訂正しました。');
      break;
    }
    case 'close': {
      const cashDenominations = data.has('countByDenomination') ? readCashDenominations() : undefined;
      const actualCash = cashDenominations ? getCashCountTotal(cashDenominations) : numeric('actualCash');
      if (actualCash === null) throw new Error('金種別の枚数と合計金額を確認してください。');
      commit({type:'close',actualCash,reason:value('reason'),...(cashDenominations ? {cashDenominations} : {})},
        '閉店しました。締め結果を日報に保存しました。',()=>{
        selected = null; mobileDetails = false; reportDate = ''; commissionCast = '';
        reportInterval.mode = 'day'; reportExportError = '';
        page = 'reports'; history.replaceState(null, '', '#reports');
      });
      window.scrollTo(0,0);
      break;
    }
    case 'stock-adjust': {
      const kind = value('stockAdjustmentMode');
      const operation = {stockId:modal.stockId,quantity:numeric('quantity'),reason:value('reason')};
      const command = kind === 'adjust' ? {type:'stockAdjust',...operation} : {type:'recordStockOperation',kind,...operation,
        ...(kind === 'purchase' && {unitCost:numeric('purchaseUnitCost'),adoptUnitCost:data.has('adoptStockUnitCost')})};
      commit(command,'在庫の入出庫を記録しました。');
      break;
    }
    case 'stocktake':
      commit({type:'recordStockOperation',stockId:modal.stockId,kind:'stocktake',bookQuantity:modal.bookQuantity,
        actualQuantity:numeric('actualQuantity'),reason:value('reason')},'棚卸を記録しました。');
      break;
    case 'stock-cancel-purchase': {
      const entry = state.movements.find(({id}) => id === modal.purchaseId);
      if (!entry) throw new Error('入庫記録が見つかりません。');
      commit({type:'recordStockOperation',kind:'purchaseCancellation',stockId:entry.stockId,purchaseId:entry.id,reason:value('reason')},
        '入庫を取り消し、平均原価を再計算しました。');
      break;
    }
  }
}

bindLayoutEditor(dialog, () => modal?.layout, escape);

document.addEventListener('click',(event)=> {
  if (modal?.type === 'set-schedule' && handleInitialSetScheduleClick(event)) return;
  if (event.target === workspaceMenu) { workspaceMenu.close(); return; }
  const target=event.target.closest?.('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'open-workspace-menu') {
    if (workspaceMenu.open) return;
    refreshWorkspaceMenu(); workspaceMenu.showModal();
    target.setAttribute('aria-expanded','true');
    workspaceMenu.querySelector('.workspace-menu-close')?.focus({preventScroll:true});
    return;
  }
  if (action === 'close-workspace-menu') { workspaceMenu.close(); return; }
  const fromMenu = workspaceMenu.contains(target);
  if (fromMenu) {
    workspaceMenu.close();
    app.querySelector('#workspace-menu-toggle')?.focus({preventScroll:true});
  }
  try {
    clickAction(target);
    if (fromMenu && action === 'navigate') app.querySelector('#workspace')?.focus({preventScroll:true});
  }
  catch (error) { if (!dialog.open) openDialog('demo'); showError(error.message); }
});
workspaceMenu.addEventListener('close',()=> {
  if (workspaceMenu.open) return;
  const trigger = app.querySelector('#workspace-menu-toggle');
  trigger?.setAttribute('aria-expanded','false');
  if (!dialog.open && (document.activeElement === document.body || workspaceMenu.contains(document.activeElement))) {
    trigger?.focus({preventScroll:true});
  }
  workspaceMenu.replaceChildren(); workspaceMenuContent = '';
});
function updateCustomerPageSearch(event) {
  if (event.isComposing) return;
  const {name,value} = event.target;
  if (name === 'customerSearch' && customersQuery !== value) customersQuery = value;
  else return;
  render({preserveFocus:true});
}

app.addEventListener('input',updateCustomerPageSearch);
app.addEventListener('compositionend',updateCustomerPageSearch);
app.addEventListener('change',(event)=> {
  if (page === 'stock' && ['stockSearch','stockLowOnly','stockHistoryId'].includes(event.target.name)) {
    const {name,value,checked} = event.target;
    if (name === 'stockSearch') { stockSearch = value; stockBarcodeExact = false; }
    if (name === 'stockLowOnly') stockLowOnly = checked;
    if (name === 'stockHistoryId') stockHistoryId = value;
    render();
    app.querySelector(`[name=${name}]`)?.focus({preventScroll:true});
    return;
  }
  const customerFilter = event.target.dataset.customerFilter;
  if (page === 'customers' && customerFilter) {
    customerFilters[customerFilter] = event.target.value;
    render();
    const filterInput = app.querySelector(`[data-customer-filter="${customerFilter}"]`);
    filterInput.closest('details').open = true;
    filterInput.focus({preventScroll:true});
    return;
  }
  if (page === 'shifts' && event.target.matches('[data-shift-date]') && event.target.value) {
    shiftDate = event.target.value;
    render(); app.querySelector('[data-shift-date]')?.focus({preventScroll:true});
    return;
  }
  if (page === 'team-performance') {
    const teamField = [['start','[data-team-start]'],['end','[data-team-end]'],['role','[data-team-role]']]
      .find(([,selector]) => event.target.matches(selector));
    if (teamField) {
      const [key,selector] = teamField;
      if (key === 'role') teamRole = event.target.value;
      else teamRange[key] = event.target.value;
      render(); app.querySelector(selector)?.focus({preventScroll:true});
      return;
    }
  }
  const laborField = event.target.dataset.laborFilter;
  if (page === 'labor' && ['start','end','role'].includes(laborField)) {
    laborRange[laborField] = event.target.value;
    render();
    app.querySelector(`[data-labor-filter="${laborField}"]`)?.focus({preventScroll:true});
    return;
  }
  const analyticsFields = [['start','[data-analytics-start]'],['end','[data-analytics-end]'],['comparison','[data-analytics-comparison]']];
  const analyticsField = analyticsFields.find(([,selector]) => event.target.matches(selector));
  if (analyticsField && ['analytics','product-sales'].includes(page)) {
    const [key,selector] = analyticsField;
    analyticsRange[key] = event.target.value;
    render(); app.querySelector(selector)?.focus({preventScroll:true});
    return;
  }
  const intervalFields = [['month','[data-report-month]'],['start','[data-report-start]'],['end','[data-report-end]']];
  const interval = intervalFields.find(([,selector]) => event.target.matches(selector));
  if (interval && page === 'reports') {
    const [key,selector] = interval;
    reportInterval[key] = event.target.value;
    reportExportError = '';
    render();
    app.querySelector(selector)?.focus({preventScroll:true});
    return;
  }
  if (event.target.id==='area-filter') { area=event.target.value || null;render();app.querySelector('#area-filter')?.focus(); }
  if (event.target.matches('[data-report-date]')) {
    reportDate = event.target.value;
    reportExportError = '';
    commissionCast = '';
    render();
    app.querySelector('[data-report-date]')?.focus({ preventScroll: true });
  }
});
dialog.addEventListener('change', (event) => {
  if (event.target.name === 'orderServiceExcluded') {
    const reason = dialog.querySelector('#order-service-reason');
    if (reason) {
      reason.hidden = !event.target.checked;
      reason.querySelector('textarea').required = event.target.checked;
    }
    updateOrderServicePreview();
  }
  if (modal?.type === 'cloud-groups' && event.target.name === 'group-select') {
    modal.selectedGroupId = event.target.value;
    paintDialog();
    dialog.querySelector('[name=group-select]')?.focus({preventScroll:true});
    return;
  }
  if (modal?.type === 'open' && event.target.name === 'date' && event.target.value) {
    dialog.querySelector('[name=openingCash]').value = openingCashSuggestion(state,event.target.value);
  }
  if (modal?.type === 'settled-ticket-contents' && event.target.name === 'settledContentLine') {
    const {discount,reason,adjustmentMethod} = readSettledContents(event.target.form,modal);
    Object.assign(modal,{lineId:event.target.value,discount,reason,adjustmentMethod});
    paintDialog();
    dialog.querySelector('[name=settledContentLine]')?.focus();
    return;
  }
  if (['extend','extend-overdue'].includes(modal?.type) && event.target.name === 'extensionId') {
    const ticket = state.tickets.find(({id}) => id === modal.ticketId);
    dialog.querySelector('#extension-mix').innerHTML = renderExtensionMix(ticket,event.target.value);
    modal.expectedMixTotal = undefined;
  }
  if (['extend','extend-overdue'].includes(modal?.type) && event.target.name === 'splitExtension') updateExtensionMixPreview();
  if (modal?.type === 'attendance-editor' && event.target.name === 'attendanceClass') {
    dialog.querySelector('[data-attendance-clock]').hidden = ['absent','no-show'].includes(event.target.value);
  }
  if (event.target.matches('[data-customer-photo]')) {
    void customerUI.updateCustomerPhoto(event.target);
    return;
  }
  if (modal?.type === 'accounting-settings' && event.target.name === 'csvMode') {
    modal.csvMode = event.target.value;
    paintDialog();
    dialog.querySelector('[name=csvMode]')?.focus();
    return;
  }
  if (modal?.type === 'stock-adjust' && event.target.name === 'stockAdjustmentMode') {
    const kind = event.target.value;
    const purchase = kind === 'purchase';
    const adjust = kind === 'adjust';
    const quantity = dialog.querySelector('[name=quantity]');
    quantity.min = adjust ? '-1000000' : '0.000001';
    quantity.closest('label').querySelector('span').textContent = `${adjust ? '数量の増減' : purchase ? '入庫数量' : '出庫数量'}（${quantity.dataset.stockUnit}）`;
    dialog.querySelector('[data-stock-purchase]').hidden = !purchase;
    dialog.querySelector('[name=purchaseUnitCost]').disabled = !purchase;
  }
  if (['payroll-settings','payroll-template-editor'].includes(modal?.type) && event.target.name === 'payrollRuleBasis') {
    const group = dialog.querySelector('[data-payroll-rules]');
    const index = [...group.querySelectorAll('[name=payrollRuleBasis]')].indexOf(event.target);
    const rules = payrollUI.readPayrollTemplateRows(dialog.querySelector('form'));
    rules[index].value = null;
    group.innerHTML = payrollUI.renderPayrollTemplateRows(rules,{escape,icon,state,variables:getPayrollVariables(state)});
    group.querySelectorAll('[name=payrollRuleBasis]')[index]?.focus();
  }
  if (event.target.name === 'autoTableId' && modal?.type === 'table-auto-extension') {
    if (!state.tables.some(({id}) => id === event.target.value)) return;
    modal.autoTableId = event.target.value;
    paintDialog();
    dialog.querySelector('[name=autoTableId]')?.focus({preventScroll:true});
    return;
  }
  updatePrintPreview(event.target);
  if (['cashKind','cashCategory'].includes(event.target.name)) {
    const kind = dialog.querySelector('[name=cashKind]').value;
    const category = dialog.querySelector('[name=cashCategory]');
    if (event.target.name === 'cashKind') category.innerHTML = cashCategoryOptions(kind);
    const field = dialog.querySelector('[data-cash-counterparty]');
    field.innerHTML = cashAccountSelect(kind,category.value,null,modal?.type === 'edit-cash-movement');
    field.hidden = !field.firstElementChild;
  }
  if (modal?.type === 'settle' && ['paymentMethod','paymentBrand','paymentWaiveFee'].includes(event.target.name)) {
    const row = event.target.closest('.payment-row');
    if (event.target.name !== 'paymentWaiveFee') {
      const method = row.querySelector('[name=paymentMethod]').value;
      const brandId = event.target.name === 'paymentBrand' ? event.target.value : undefined;
      row.querySelector('[data-payment-brand-fields]').innerHTML = renderPaymentBrandFields({method,brandId});
      if (event.target.name === 'paymentBrand') row.querySelector('[name=paymentBrand]')?.focus();
    }
    updatePaymentNote();
  }
  if (['deposit','edit-deposit'].includes(modal?.type) && ['depositMethod','depositBrand','depositWaiveFee'].includes(event.target.name)) {
    if (event.target.name !== 'depositWaiveFee') {
      const method = dialog.querySelector('[name=depositMethod]').value;
      const brandId = event.target.name === 'depositBrand' ? event.target.value : undefined;
      dialog.querySelector('[data-deposit-brand-fields]').innerHTML = renderPaymentBrandFields({method,brandId},currentDeposit(),'deposit');
      if (event.target.name === 'depositBrand') dialog.querySelector('[name=depositBrand]')?.focus();
    }
    updateDepositPreview();
  }
  if (event.target.name === 'countByDenomination') updateCashDenominations();
  if (event.target.name === 'customerId' && hasCustomerPicker()) {
    modal.seatCustomerId = event.target.value;
    renderSeatCustomerSelection();
  }
  if (event.target.name === 'layout-file') readStoreFile(event.target);
  if (event.target.name === 'demo-backup-file') void selectDemoBackup(event.target.files[0]);
  if (event.target.name === 'discountMode') {
    const rate = event.target.value === 'percent';
    const input = dialog.querySelector('[name=discountValue]');
    input.value = '';
    input.step = rate ? '0.01' : '1';
    input.max = rate ? '100' : String(quote(state,modal.ticketId).subtotal);
    input.closest('label').querySelector('span').textContent = rate ? '値引き率（%）' : '値引き額（円）';
  }
});
function hasCustomerPicker() {
  return modal?.type === 'seat' || hasTicketCustomerEditor();
}

function hasTicketCustomerEditor() {
  return ['ticket-customer','settled-ticket-customer'].includes(modal?.type);
}

function hasTicketCustomerChange() {
  if (modal.seatCustomerId === undefined || (modal.canDetach === false && modal.seatCustomerId === null)) return false;
  const current = modal.ticketCustomerAlias;
  return modal.seatCustomerId !== (current?.id ?? null) || (!current?.id && Boolean(current?.name));
}

function syncTicketCustomerSubmit() {
  const save = dialog.querySelector('#submit-dialog');
  if (hasTicketCustomerEditor() && save) {
    const missingReason = modal.type === 'settled-ticket-customer' && !modal.customerCorrectionReason?.trim();
    save.disabled = committing || !hasTicketCustomerChange() || missingReason;
  }
}

function renderSeatCustomerMatches() {
  const results = dialog.querySelector('#seat-customer-results');
  const selected = modal.seatCustomerId === undefined ? modal.ticketCustomerAlias?.id : modal.seatCustomerId;
  if (results) results.innerHTML = customerUI.renderSeatCustomerResults(customerWorkspaceState(),
    modal.seatCustomerQuery ?? '',selected,customerUIApi());
}

function renderSeatCustomerSelection() {
  const selection = dialog.querySelector('#seat-customer-selection');
  if (!selection) return;
  const workspace = customerWorkspaceState();
  if (hasTicketCustomerEditor()) {
    selection.innerHTML = customerUI.renderTicketCustomerSelection(workspace,modal.seatCustomerId,customerUIApi(),modal.ticketCustomerAlias,
      {canDetach:modal.canDetach});
    syncTicketCustomerSubmit();
  } else {
    selection.innerHTML = customerUI.renderSeatCustomerSelection(workspace,modal.seatCustomerId,customerUIApi());
  }
}

function updateSeatCustomerSearch(event) {
  if (!hasCustomerPicker() || event.target.name !== 'customerQuery' || event.isComposing
    || modal.seatCustomerQuery === event.target.value) return;
  modal.seatCustomerQuery = event.target.value;
  renderSeatCustomerMatches();
}

function refreshPaymentCorrection() {
  if (modal?.paymentCorrection && !committing) {
    updatePaymentCorrection(dialog.querySelector('#dialog-form'),modal.paymentCorrection,yen);
  }
}

dialog.addEventListener('keydown',(event) => {
  if (event.key !== 'Enter' || event.target.name !== 'customerQuery' || event.isComposing) return;
  event.preventDefault();
  dialog.querySelector('#seat-customer-results [name=customerId]')?.focus();
});
function updateGuideSearch(event) {
  if (modal?.type === 'ops-guide' && event.target.name === 'guideSearch' && !event.isComposing) {
    dialog.querySelector('[data-guide-results]').innerHTML = guideList(event.target.value);
  }
}

function updateCompanionSearch(event) {
  if (!['ticket-companions','settled-ticket-companions'].includes(modal?.type) || event.target.name !== 'companionQuery') return;
  const ticket = modal.type === 'settled-ticket-companions' ? findSettledCustomerTicket(state,modal.ticketId)?.ticket
    : state.tickets.find(({id})=>id === modal.ticketId);
  const primary = ticket && ticketCustomerAlias(ticket);
  if (primary?.id) dialog.querySelector('#companion-results').innerHTML = customerUI.renderCompanionResults(
    customerWorkspaceState(),ticket,primary,event.target.value,customerUIApi());
}

dialog.addEventListener('compositionend',(event)=> {
  updateSeatCustomerSearch(event);
  updateGuideSearch(event);
  updateCompanionSearch(event);
});
dialog.addEventListener('input',(event)=> {
  if (!event.isComposing) updateCompanionSearch(event);
  updateGuideSearch(event);
  if (modal?.type === 'settled-ticket-contents') updateSettledContentsPreview(event.target.form);
  if (['order','edit-ticket-line'].includes(modal?.type)
    && ['quantity','linePrice','castIds'].includes(event.target.name)) updateOrderServicePreview();
  if (['extend','extend-overdue'].includes(modal?.type) && event.target.name === 'extensionPlanQuantity') updateExtensionMixPreview();
  if (modal?.type === 'accounting-settings' && event.target.name === 'csvValue') {
    event.target.closest('label').querySelector('[data-accounting-preview]').textContent = '例 ' + accountingCsvPreview(event.target.value);
  }
  updatePrintPreview(event.target);
  updateSeatCustomerSearch(event);
  refreshPaymentCorrection();
  if (modal?.type === 'settled-ticket-customer' && event.target.name === 'customerCorrectionReason') {
    modal.customerCorrectionReason = event.target.value;
    syncTicketCustomerSubmit();
  }
  if (event.target.id==='menu-search') {modal.search=event.target.value;reviseProduct();}
  if (event.target.name==='paymentAmount' || event.target.name==='cashReceived') updatePaymentNote();
  if (event.target.name === 'depositAmount') updateDepositPreview();
  if (event.target.matches('[data-cash-denomination]')) updateCashDenominations();
  if (event.target.name==='actualCash') updateCashCloseDifference(event.target);
  for (const error of dialog.querySelectorAll('.form-error')) error.hidden = true;
});
dialog.addEventListener('submit',(event)=> {
  event.preventDefault();
  try {submitDialog(event.target);}
  catch (error) {showError(error.message);}
});
dialog.addEventListener('close',()=> {
  if (!dialog.open) {
    activeBarcodeScan?.close();
    modal=null;
    if (pendingStorage) {
      pendingStorage = false;
      if (!cloudState.store) { state = loadState(); syncFloorSelection(); render(); }
    }
    if (priorFocus?.isConnected) priorFocus.focus({preventScroll:true});
    else app.querySelector('#workspace')?.focus({preventScroll:true});
    priorFocus=null;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !workspaceMenu.open && !dialog.open && mobileDetails && matchMedia('(max-width: 1050px)').matches) {
    mobileDetails = false; render(); app.querySelector('.is-selected')?.focus();
  }
});
window.addEventListener('hashchange',()=>{page=readPage(); render();});
window.addEventListener('storage',(event)=>{
  if (event.key!==storageKey && event.key!==legacyStorageKey) return;
  if (cloudState.store || demoPractice) return;
  if (dialog.open) { pendingStorage = true; return; }
  state=loadState(); syncFloorSelection(); render({preserveFocus:true});
});

syncFloorSelection();
render();
void restoreCloud();
setInterval(()=> {
  if (document.hidden) return;
  const now=Date.now();
  if (!cloudState.store && currentRole() !== 'cast') void syncDueLocalExtensions(now).catch((error) => {
    if (dialog.open) showError(error.message);
  });
  const minute=dateTime.format(now);
  if (minute!==lastMinute) {
    const clock=document.querySelector('#workspace-time');
    if (clock) clock.textContent=minute;
    lastMinute=minute;
  }
  if (page==='floor') {
    const noticesChanged = autoNoticesKey(getAutoExtensionNotices(state,now)) !== lastAutoExtensionNotices;
    if (noticesChanged || (!dialog.open && state.tables.map((table)=>tableStatus(state,table.id,now)).join('|')!==lastStatuses)) {
      render({preserveFocus:true});
      return;
    }
    for (const time of app.querySelectorAll('[data-ends]')) time.textContent=timer(Number(time.dataset.ends),now);
    for (const countdown of app.querySelectorAll('[data-auto-extension-deadline]')) {
      countdown.textContent = formatAutoExtensionCountdown(Number(countdown.dataset.autoExtensionDeadline),now);
    }
  }
},1000);
