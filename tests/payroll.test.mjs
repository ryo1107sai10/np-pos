import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { getDailyPayLimit, getDailyPayTotals, getPayrollDailyPays, getPayrollDraft, previewPayroll } from '../docs/payroll.mjs';
import { buildDailyReportCsv } from '../docs/report-export.mjs';
import { getReportDay, getReportPeriod } from '../docs/report-period.mjs';
import { projectState, validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-16';
const month = date.slice(0, 7);
const castId = 'cast1';
const now = Date.parse(`${date}T21:00:00+09:00`);
const admin = {id:'owner',label:'店舗管理者',role:'admin'};
const manager = {id:'manager',label:'担当者',role:'manager'};
const run = (state, action, at = now, actor = admin) => apply(state,action,at,actor);
const rate = (hourlyRate, effectiveDate = date) => ({type:'savePayrollRate',castId,effectiveDate,hourlyRate});
const work = (minutes, workDate = date) => ({date:workDate,minutes});
const payDraft = (fields = {}) => ({type:'savePayrollDraft',month,castId,work:[work(180)],...fields});
const finalize = {type:'finalizePayroll',month,castId};

function shop() {
  return run(createDemo('closed',now),{type:'open',date,openingCash:20_000});
}

function visit(state, table = 'a1') {
  const seated = run(state,{type:'seat',tableIds:[table],guests:2,setId:'set60'});
  const id = seated.tickets.at(-1).id;
  return {id,state:run(seated,{type:'order',ticketId:id,items:[
    {menuId:'champagne',quantity:1,castIds:[castId]},
    {menuId:'castDrink',quantity:1,castIds:[castId]},
  ]})};
}

test('a monthly wage of ¥17,100 only includes settled commissions and locks the original amount', () => {
  let state = shop();
  state.menu.find(({id}) => id === 'champagne').commission = {fixed:3_000};
  state.menu.find(({id}) => id === 'castDrink').commission = {fixed:3_600};
  const first = visit(state);
  state = run(first.state,rate(3_500));
  state = run(state,payDraft());
  assert.equal(previewPayroll(state,getPayrollDraft(state,month,castId)).net,10_500);
  state = run(state,{type:'settle',ticketId:first.id,payments:[{method:'cash',amount:quote(state,first.id).remaining}]});
  let preview = previewPayroll(state,getPayrollDraft(state,month,castId));
  assert.equal(preview.net,17_100);
  assert.deepEqual(preview.commissionDetails.map(({amount}) => amount),[3_000,3_600]);
  assert.match(preview.castName,/美月/);
  state = run(state,{type:'depart',ticketId:first.id});
  state = run(state,{type:'close',actualCash:summary(state).expectedCash});
  preview = previewPayroll(state,getPayrollDraft(state,month,castId));
  assert.equal(preview.net,17_100);
  const archivedWithoutReceipts = structuredClone(state);
  archivedWithoutReceipts.tickets = [];
  delete archivedWithoutReceipts.closedDays[0].ticketSnapshots;
  const legacy = previewPayroll(archivedWithoutReceipts,getPayrollDraft(archivedWithoutReceipts,month,castId));
  assert.equal(legacy.net,17_100);
  assert.equal(legacy.commissionDetails[0].name,'確定歩合（旧伝票）');
  state = run(state,finalize,now + 60_000);
  const frozen = getPayrollDraft(state,month,castId);
  assert.deepEqual(frozen.snapshot,preview);
  state = run(state,rate(5_000),now + 90_000);
  assert.equal(getPayrollDraft(state,month,castId).snapshot.net,17_100);
  assert.throws(() => run(state,payDraft()),/確定済み/);
  assert.throws(() => run(state,finalize),/確定済み/);
  assert.equal(state.auditLog.find(({action}) => action === 'finalizePayroll').after.net,17_100);
  assert.deepEqual(validateSnapshot(state).payroll.records,[frozen]);
});

test('applies effective-dated hourly rates, approved attendance, point conversion and manual line items', () => {
  let state = run(shop(),rate(2_500,'2026-11-01'));
  state = run(state,rate(3_500,'2026-11-10'));
  state = run(state,{type:'savePayrollSettings',settings:{pointRate:30,commissionRounding:'floor',commissionUnit:100}});
  state.attendances = [
    {castId,date:'2026-11-06',minutes:60,status:'approved'},
    {castId,date:'2026-11-09',minutes:240,status:'pending'},
    {castId,date:'2026-11-11',minutes:60,status:'approved'},
  ];
  const ordered = visit(state);
  state = run(ordered.state,{type:'settle',ticketId:ordered.id,payments:[{method:'cash',amount:quote(ordered.state,ordered.id).remaining}]});
  state = run(state,payDraft({work:[work(120,'2026-11-11')],allowances:[{label:'役職手当',amount:500}],
    deductions:[{label:'立替精算',amount:200}],manualAdvance:1_000}));
  const result = previewPayroll(state,getPayrollDraft(state,month,castId));
  assert.deepEqual(result.work.map(({minutes,source,hourlyRate}) => [minutes,source,hourlyRate]),
    [[60,'attendance',2_500],[120,'manual',3_500]]);
  assert.equal(result.hourlyPay,9_500);
  assert.equal(result.rawCommission,2_460);
  assert.equal(result.commission,2_400);
  assert.equal(result.pointPay,180);
  assert.equal(result.net,11_380);
  assert.throws(() => run(state,payDraft({work:[work(60),work(30)]})),/重複/);
  assert.throws(() => run(state,payDraft({work:[work(60,'2026-12-01')]})),/給与期間内/);
  assert.throws(() => run(state,payDraft(),now,manager),/権限/);
  for (const role of ['manager','staff','cast','trainee']) {
    assert.throws(() => verifyCommand(role,payDraft()),{code:'forbidden'});
    assert.equal(projectState(state,role,'member')?.payroll,undefined);
  }
});

test('daily pay approval and payout adjust one register entry and the locked month only', () => {
  let state = run(shop(),rate(3_500));
  state = run(state,payDraft());
  assert.deepEqual(getDailyPayLimit(state,month,castId),{limit:8_400,committed:0,rateBps:8_000});
  state = run(state,{type:'requestDailyPay',month,castId,amount:9_000,reason:'当日の申請'});
  const [large] = getPayrollDailyPays(state,{month,castId});
  assert.equal(large.exceededLimit,true);
  assert.equal(large.status,'requested');
  assert.throws(() => run(state,finalize),/未処理の日払い/);
  assert.throws(() => run(state,{type:'payDailyPay',dailyPayId:large.id,method:'cash'}),/承認済み/);
  const approval = {type:'reviewDailyPay',dailyPayId:large.id,decision:'approve'};
  assert.throws(() => run(state,approval),/上限/);
  state = run(state,{...approval,reason:'責任者が確認'});
  const cash = {type:'payDailyPay',dailyPayId:large.id,method:'cash'};
  state = run(state,cash);
  assert.equal(summary(state).expectedCash,11_000);
  assert.throws(() => run(state,cash),/承認済み/);
  const [movement] = state.cashMovements;
  assert.equal(movement.reason,'日払いの現金支給');
  assert.equal(movement.kind,'withdrawal');
  assert.equal(movement.amount,9_000);
  assert.equal(state.auditLog[0].after.cashMovementId,movement.id);

  state = run(state,{type:'requestDailyPay',month,castId,amount:500});
  const bank = state.payroll.dailyPays.at(-1);
  state = run(state,{type:'reviewDailyPay',dailyPayId:bank.id,decision:'approve',reason:'本人から振込の希望'});
  state = run(state,{type:'payDailyPay',dailyPayId:bank.id,method:'bank'});
  assert.deepEqual(getDailyPayTotals(state,date),{cash:9_000,bank:500});
  assert.equal(summary(state).expectedCash,11_000);
  assert.equal(state.cashMovements.length,1);
  state = run(state,finalize);
  const {snapshot} = getPayrollDraft(state,month,castId);
  assert.equal(snapshot.paidDailyPay,9_500);
  assert.equal(snapshot.net,1_000);
  assert.throws(() => run(state,{type:'requestDailyPay',month,castId,amount:100}),/確定済み/);
  const migrated = validateSnapshot(state);
  assert.deepEqual(migrated.payroll,state.payroll);
  const corrupted = structuredClone(state);
  corrupted.payroll.dailyPays[0].cashMovementId = 'mismatch';
  assert.throws(() => validateSnapshot(corrupted),{code:'invalid-snapshot'});

  const closed = run(state,{type:'close',actualCash:11_000});
  const masked = projectState(closed,'manager','member');
  assert.equal(masked.payroll,undefined);
  assert.equal(masked.dailyPayByDate[date].cash,9_000);
  assert.equal(projectState(closed,'staff','member').dailyPayByDate,undefined);
  const report = getReportDay(masked,date);
  assert.equal(report.current.expectedCash,11_000);
  assert.equal(report.current.cashOut,9_000);
  assert.deepEqual(report.current.dailyPayTotals,{cash:9_000,bank:500});
  const monthly = getReportPeriod(masked,{mode:'month',month});
  assert.deepEqual(monthly.totals.dailyPayTotals,{cash:9_000,bank:500});
  const csv = buildDailyReportCsv(monthly,'サンプル店舗');
  assert.match(csv,/日払い支給（現金・出金に含む）,日払い支給（振込）\r\n/);
  assert.match(csv,/,9000,500\r\n$/);
});
