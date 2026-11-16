import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { getDailyPayLimit, getDailyPayTotals, getPayrollDailyPays, getPayrollDraft, getPayrollSettings, getPayrollTemplates,
  previewPayroll, previewPayrollRange } from '../docs/payroll.mjs';
import { makeImagePdf, makeStoredZip } from '../docs/payroll-pdf.mjs';
import { renderPayroll, renderPayrollRange } from '../docs/payroll-ui.mjs';
import { createPayrollDemo } from '../docs/phase-two-demo.mjs';
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

test('date range uses dated work, confirmed historical commissions, attendance items and actual payout dates', () => {
  const previousDate = '2026-10-31';
  const previousMonth = '2026-10';
  let state = run(createDemo('closed',now),{type:'open',date:previousDate,openingCash:20_000});
  state = run(state,rate(3_000,'2026-10-01'));
  const settings = {pointRate:100,commissionRounding:'floor',commissionUnit:10,
    statementRules:[{label:'月次手当',kind:'allowance',basis:'fixed',value:800}]};
  state = run(state,{type:'savePayrollSettings',settings});
  state.menu.find(({id}) => id === 'champagne').commission = {fixed:3_019,points:2};
  const {id,state:visited} = visit(state);
  state = run(visited,{type:'settle',ticketId:id,payments:[{method:'cash',amount:quote(visited,id).remaining}]});
  state = run(state,{type:'depart',ticketId:id});
  state = run(state,{type:'close',actualCash:summary(state).expectedCash});
  state = run(state,payDraft({month:previousMonth,work:[work(90,previousDate),work(120,'2026-10-30')],
    allowances:[{label:'月次手当の調整',amount:500}],manualAdvance:200}));
  state = run(state,{type:'requestDailyPay',castId,month:previousMonth,amount:1_000});
  const [{id:dailyPayId}] = getPayrollDailyPays(state);
  state = run(state,{type:'reviewDailyPay',dailyPayId,decision:'approve'});
  state = run(state,{type:'open',date,openingCash:20_000});
  state = run(state,{type:'payDailyPay',dailyPayId,method:'bank'});
  state = run(state,{...finalize,month:previousMonth});
  const frozen = structuredClone(getPayrollDraft(state,previousMonth,castId).snapshot);
  state = run(state,rate(6_000,'2026-10-01'));
  state = run(state,rate(3_600,date));
  state = run(state,{type:'savePayrollSettings',settings:{...settings,pointRate:200}});
  state.attendances = [{castId,date,status:'approved',minutes:120},
    {castId,date:'2026-11-15',status:'pending',minutes:120},{castId,date:'2026-11-17',status:'approved',minutes:60}];
  state.castAttendance = [{castId,date,status:'approved',items:[{label:'出勤手当',kind:'allowance',amount:600},
    {label:'控除',kind:'deduction',amount:200},{label:'出勤ポイント',kind:'points',amount:1}]}];
  state = visit(state).state;
  delete state.closedDays[0].ticketSnapshots;
  const report = previewPayrollRange(state,{start:previousDate,end:date});
  const [row] = report.rows;
  assert.equal(report.rows.length,1);
  assert.equal(row.castId,castId);
  assert.equal(row.minutes,210);
  assert.deepEqual(row.work.map(({date,hourlyRate}) => [date,hourlyRate]),[[previousDate,3000],[date,3600]]);
  assert.equal(row.hourlyPay,11_700);
  assert.equal(row.rawCommission,3_319);
  assert.equal(row.commission,3_310);
  assert.equal(row.pointPay,500);
  assert.equal(row.allowanceTotal,600);
  assert.equal(row.deductionTotal,200);
  assert.deepEqual(row.advances.map(({paidDate,month}) => [paidDate,month]),[[date,previousMonth]]);
  assert.equal(row.net,14_910);
  assert.deepEqual(getPayrollDraft(state,previousMonth,castId).snapshot,frozen);
  assert.equal(previewPayrollRange(state,{start:previousDate,end:previousDate,castId}).rows[0].advance,0);
  assert.equal(previewPayrollRange(state,{start:date,end:date,castId}).rows[0].advance,1_000);
  assert.throws(() => previewPayrollRange(state,{start:'2026-02-29',end:date}),/日付の順/);
  assert.throws(() => previewPayrollRange(state,{start:date,end:previousDate}),/日付の順/);

  delete state.closedDays[0].commission;
  const incomplete = previewPayrollRange(state,{start:previousDate,end:date,castId});
  assert.deepEqual(incomplete.unavailableDates,[previousDate]);
  assert.equal(incomplete.rows[0].net,null);
  assert.match(renderPayrollRange(state,{range:{...incomplete,castId},result:incomplete},{escape:String,yen:String}),/歩合の元データが不足/);
});

test('payroll range surfaces missing rates and the demo includes immediately exportable finalized months', () => {
  const demo = createPayrollDemo(now);
  const finals = demo.payroll.records.filter(({status}) => status === 'final');
  assert.deepEqual(finals.map(({month,castId}) => [month,castId]),[['2026-11','cast2'],['2026-10','cast1']]);
  assert.equal(validateSnapshot(demo).payroll.records.length,3);
  const castId = 'cast4';
  demo.attendances = [{date,castId,status:'approved',minutes:60}];
  const result = previewPayrollRange(demo,{start:date,end:date,castId});
  assert.deepEqual(result.rows[0].missingDates,[date]);
  assert.equal(result.rows[0].net,null);
});

test('PDF offsets and the Unicode ZIP directory reference each payroll PDF correctly', async () => {
  const pdf = makeImagePdf([new Blob(['image-one']),new Blob(['image-two'])],16,24);
  const contents = await pdf.text();
  assert.match(contents,/\/Type \/Pages \/Count 2/);
  const xref = Number(contents.match(/startxref\n(\d+)/)[1]);
  assert.equal(contents.slice(xref,xref + 4),'xref');
  for (const [index,entry] of [...contents.matchAll(/^(\d{10}) 00000 n /gm)].entries()) {
    assert.ok(contents.slice(Number(entry[1])).startsWith(`${index + 1} 0 obj\n`));
  }
  const name = '支給明細_2026-11_凛.pdf';
  const zip = await makeStoredZip([{name,blob:pdf}]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const data = new DataView(bytes.buffer);
  assert.equal(data.getUint32(0,true),0x04034b50);
  assert.equal(data.getUint16(6,true),0x0800);
  const length = data.getUint16(26,true);
  const index = data.getUint32(bytes.length - 6,true);
  assert.equal(data.getUint32(index,true),0x02014b50);
  assert.equal(data.getUint32(index + 42,true),0);
  const decoder = new TextDecoder();
  assert.equal(decoder.decode(bytes.slice(30,30 + length)),name);
  assert.equal(decoder.decode(bytes.slice(index + 46,index + 46 + length)),name);
  assert.equal(decoder.decode(bytes.slice(30 + length,index)),contents);
});

test('payroll still displays the rate editor and affected business dates after attendance approval', () => {
  let state = shop();
  state.attendances = [
    {castId,date:'2026-11-16',minutes:120,status:'approved'},
    {castId,date:'2026-11-11',minutes:60,status:'approved'},
    {castId,date:'2026-11-08',minutes:25,status:'pending'},
  ];
  const render = () => renderPayroll(state,{month,castId,escape:String,icon:()=>'',yen:(amount)=>`¥${amount}`});
  assert.throws(() => previewPayroll(state,{month,castId}),/2026-11-11に適用する時給/);
  const missingRate = render();
  assert.match(missingRate,/時給を登録/);
  assert.match(missingRate,/2026-11-11・2026-11-16/);
  assert.doesNotMatch(missingRate,/data-action="payroll-finalize"|支給合計|2026-11-08/);
  state = run(state,rate(2_000));
  assert.match(render(),/対象の営業日　2026-11-11</);
  state = run(state,rate(1_500,'2026-11-11'));
  assert.match(render(),/¥5500/);
  assert.doesNotMatch(render(),/適用できる時給が未登録/);
});

test('named payroll templates apply to assigned casts and leave finalized amounts and template names intact', () => {
  let state = shop();
  const fixed = (value) => [{label:'役職手当',kind:'allowance',basis:'fixed',value}];
  const command = {type:'savePayrollTemplate',name:'役職者',rules:fixed(1_500)};
  verifyCommand('admin',command);
  assert.throws(() => verifyCommand('manager',command),{code:'forbidden'});
  state = run(state,{type:'savePayrollSettings',settings:{statementRules:fixed(500)}});
  state = run(state,command);
  const [{id:templateId}] = getPayrollTemplates(state);
  const assign = {type:'assignPayrollTemplate',castId,templateId};
  verifyCommand('admin',assign);
  state = run(state,assign);
  assert.equal(previewPayroll(state,{month,castId}).net,1_500);
  assert.equal(previewPayroll(state,{month,castId:'cast2'}).net,500);
  assert.throws(() => run(state,{type:'removePayrollTemplate',templateId}),/使用中/);
  assert.throws(() => run(state,command),/同じ名前/);
  state = run(state,payDraft({work:[]}));
  state = run(state,finalize);
  state = run(state,{...command,templateId,name:'役職者（改定）',rules:fixed(2_000)});
  assert.equal(getPayrollDraft(state,month,castId).snapshot.templateName,'役職者');
  assert.equal(getPayrollDraft(state,month,castId).snapshot.net,1_500);
  assert.equal(previewPayroll(state,{month:'2026-12',castId}).net,2_000);
  assert.equal(state.auditLog.find(({action}) => action === 'assignPayrollTemplate').after.template,'役職者');
  assert.deepEqual(validateSnapshot(state).payroll,{...state.payroll,dailyPays:[]});
  assert.equal(projectState(state,'manager','member')?.payroll,undefined);
  state = run(state,{...assign,templateId:null});
  state = run(state,{type:'removePayrollTemplate',templateId});
  assert.equal(previewPayroll(state,{month:'2026-12',castId}).net,500);
  assert.equal(getPayrollDraft(state,month,castId).snapshot.net,1_500);
});

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

test('ordered payroll statement rules use fixed and exact percentage amounts and stay frozen after finalization', () => {
  let state = run(shop(),rate(3_500));
  const statementRules = [
    {label:'固定手当',kind:'allowance',basis:'fixed',value:500},
    {label:'時給分の控除',kind:'deduction',basis:'hourlyPay',value:500},
    {label:'歩合手当',kind:'allowance',basis:'commission',value:1_000},
    {label:'ポイント調整',kind:'deduction',basis:'pointPay',value:250},
    {label:'基本合計の控除',kind:'deduction',basis:'baseGross',value:2_000},
  ];
  const settings = (value) => ({type:'savePayrollSettings',settings:value});
  state = run(state,settings({pointRate:30,commissionRounding:'floor',commissionUnit:100,statementRules}));
  state = run(state,settings({dailyPayLimitBps:7_500}));
  assert.deepEqual(getPayrollSettings(state).statementRules,statementRules);
  const ordered = visit(state);
  state = run(ordered.state,{type:'settle',ticketId:ordered.id,payments:[{method:'cash',amount:quote(ordered.state,ordered.id).remaining}]});
  state = run(state,payDraft({allowances:[{label:'手入力の手当',amount:100}],deductions:[{label:'手入力の控除',amount:20}],manualAdvance:50}));
  const pay = previewPayroll(state,getPayrollDraft(state,month,castId));
  assert.deepEqual(pay.statementItems,statementRules.map((rule,index) => ({...rule,amount:[500,525,240,5,2616][index]})));
  assert.deepEqual(pay.allowances,[{label:'手入力の手当',amount:100}]);
  assert.equal(pay.allowanceTotal,840);
  assert.equal(pay.deductionTotal,3166);
  assert.equal(pay.net,10704);
  state = run(state,finalize);
  state = run(state,settings({statementRules:[]}));
  assert.deepEqual(getPayrollSettings(state).statementRules,[]);
  assert.deepEqual(getPayrollDraft(state,month,castId).snapshot,pay);
  assert.deepEqual(validateSnapshot(state).payroll.records[0].snapshot,pay);
  const tampered = structuredClone(state);
  tampered.payroll.records[0].snapshot.statementItems[0].amount += 1;
  assert.throws(() => validateSnapshot(tampered),{code:'invalid-snapshot'});
});

test('old statements migrate without a template and unsafe amounts or bases are rejected', () => {
  let state = run(shop(),rate(3_500));
  const rule = {label:'調整',kind:'deduction',basis:'fixed',value:20_000};
  const settings = (statementRules) => ({type:'savePayrollSettings',settings:{statementRules}});
  for (const invalid of [null,[{...rule,basis:'*'}],[{...rule,kind:'bonus'}],[{...rule,basis:'hourlyPay',value:10_001}],
    [{...rule,value:-1}],Array(21).fill(rule)]) {
    assert.throws(() => run(state,settings(invalid)),/支給明細/);
  }
  assert.throws(() => run(state,settings([rule]),now,manager),/権限/);
  const borrowed = run(run(state,settings([rule])),payDraft());
  assert.equal(previewPayroll(borrowed,getPayrollDraft(borrowed,month,castId)).net,-9500);
  assert.throws(() => run(borrowed,finalize),/マイナス/);

  state = run(run(state,payDraft()),finalize);
  delete state.payroll.settings.statementRules;
  delete state.payroll.records[0].snapshot.settings.statementRules;
  delete state.payroll.records[0].snapshot.statementItems;
  const migrated = validateSnapshot(state);
  const final = getPayrollDraft(migrated,month,castId).snapshot;
  assert.deepEqual(final.statementItems,[]);
  assert.equal(final.net,10500);
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
