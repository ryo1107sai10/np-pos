import test from 'node:test';
import assert from 'node:assert/strict';
import { getCalculationSettings } from '../docs/calculation-settings.mjs';
import { readDemoBackup, writeDemoBackup } from '../docs/demo-backup.mjs';
import { apply, createDemo, exportStoreConfiguration, getTicketCommissionDetails, parseStoreConfiguration,
  previewSettledContents, quote, summary, yen } from '../docs/engine.mjs';
import { buildFreeeCsv } from '../docs/freee-export.mjs';
import { getOrderLineDiscountAmount, getTicketDiscountableSubtotal } from '../docs/order-line-discount.mjs';
import { getPrintSettings } from '../docs/print-domain.mjs';
import { renderPrintPreview } from '../docs/print-ui.mjs';
import { getReportPeriod } from '../docs/report-period.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';
import { validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-16';
const now = Date.parse(`${date}T20:00:00+09:00`);
const admin = {id:'owner',label:'店舗管理者',role:'admin'};
const manager = {id:'manager',label:'マネージャー',role:'manager'};
const staff = {id:'staff',label:'スタッフ',role:'staff'};
const run = (state, action, actor = admin) => apply(state,action,now,actor);
const ticketId = (state) => state.tickets[0].id;
const order = (state, items) => ({type:'order',ticketId:ticketId(state),items});
const drink = (lineDiscount, quantity = 1) => ({menuId:'castDrink',quantity,castIds:['cast1'],lineDiscount});
const fixed = (value) => ({kind:'amount',value,reason:'  来店キャンペーン  '});
const percent = (value) => ({kind:'percent',value,reason:'早割'});

function configure(state, changes) {
  return run(state,{type:'saveCalculationSettings',settings:{...getCalculationSettings(state),...changes}});
}

function seating(settings, customize) {
  const initial = run(createDemo('closed',now),{type:'open',date,openingCash:15_000});
  let state = settings ? configure(initial,settings) : initial;
  if (customize) {
    const store = getStoreSettings(state);
    Object.assign(store.menu.find(({id}) => id === 'castDrink'),customize);
    state = run(state,{type:'saveStoreSettings',settings:store});
  }
  return run(state,{type:'seat',tableIds:['a1'],guests:1,setId:'set60'});
}

test('admin opt-in and a valid reason are required for a fixed or percentage item discount', () => {
  const old = seating();
  const action = order(old,[drink(fixed(300))]);
  const reject = (state,cmd,role,status) => assert.throws(() => verifyCommand(role,cmd,state),(error) => error.status === status);
  assert.throws(() => run(old,action),/店舗設定と管理者権限/);
  reject(old,action,'admin',403);
  const enabled = configure(old,{allowOrderLineDiscount:true});
  for (const actor of [manager,staff]) {
    assert.throws(() => run(enabled,action,actor),/店舗設定と管理者権限/);
    reject(enabled,action,actor.role,403);
  }
  verifyCommand('admin',action,enabled);
  for (const wrong of [null,fixed(0),fixed(1.5),fixed(100_000_001),percent(10_001),{...fixed(1),kind:'free'}]) {
    const invalid = order(enabled,[drink(wrong)]);
    reject(enabled,invalid,'admin',400);
    assert.throws(() => run(enabled,invalid),/金額または割合/);
  }
  const missingReason = order(enabled,[drink({kind:'amount',value:1,reason:'   '})]);
  reject(enabled,missingReason,'admin',400);
  assert.throws(() => run(enabled,missingReason),/値引きの理由/);
  assert.throws(() => run(enabled,order(enabled,[drink(fixed(1_501))])),/明細の小計以下/);
  assert.equal(enabled.tickets[0].lines.length,1);
  const unchanged = run(enabled,order(enabled,[drink()]),staff);
  assert.equal(quote(unchanged,ticketId(unchanged)).lineDiscount,undefined);
});

test('line and ticket discounts apply in that order, changing tax but preserving stock and fixed commission', () => {
  const original = seating({allowOrderLineDiscount:true},{taxRate:800,commission:{rate:10,fixed:200,points:1}});
  const id = ticketId(original);
  const ordinary = run(original,order(original,[drink()]));
  let state = run(original,order(original,[drink(percent(2_000))]));
  assert.deepEqual(state.stock,ordinary.stock);
  assert.deepEqual(state.movements,ordinary.movements);
  const detail = state.tickets[0].lines.at(-1);
  assert.deepEqual(detail.lineDiscount,{kind:'percent',value:2_000});
  assert.equal(getOrderLineDiscountAmount(detail),300);
  assert.deepEqual(state.auditLog[0].after.lines[0].lineDiscount,{kind:'percent',amount:300,lineDiscountRateBps:2_000});
  assert.equal(state.auditLog[0].after.lines[0].lineDiscountReason,'早割');
  assert.equal(state.auditLog[0].actor.id,admin.id);
  assert.equal(state.auditLog[0].at,now);

  const discount = {type:'discount',ticketId:id,mode:'percent',value:10,reasonCode:'service',reason:'会員割引',personalSalesMode:'keep'};
  state = run(state,discount);
  const total = quote(state,id);
  assert.equal(state.tickets[0].discount,620);
  assert.equal(getTicketDiscountableSubtotal(total),6_200);
  assert.equal(total.subtotal,6_500);
  assert.equal(total.lineDiscount,300);
  assert.equal(total.discount,920);
  assert.equal(total.service,1_116);
  assert.deepEqual(total.taxBreakdown,[{rate:1_000,base:5_400,tax:540},{rate:800,base:1_296,tax:103}]);
  assert.equal(total.total,7_339);
  assert.deepEqual(total.commission,[{castId:'cast1',sales:1_200,amount:308,points:1}]);
  assert.deepEqual(getTicketCommissionDetails(state,id).map(({sales,amount,points})=>[sales,amount,points]),[[1_200,308,1]]);
  const reflects = run(state,{...discount,personalSalesMode:'reflect'});
  assert.deepEqual(quote(reflects,id).commission,[{castId:'cast1',sales:1_080,amount:308,points:1}]);
});

test('row discounts survive authorized edits while preventing manager increases and stranded deposits', () => {
  const enabled = seating({allowOrderLineDiscount:true});
  let state = run(enabled,order(enabled,[drink(percent(3_333))]));
  const id = ticketId(state);
  const line = state.tickets[0].lines.at(-1);
  const edit = {type:'editTicketLine',ticketId:id,lineId:line.id,quantity:2,reason:'注文の数量を訂正'};
  assert.equal(quote(state,id).lineDiscount,499);
  assert.throws(() => run(state,edit,manager),/管理者権限/);
  const edited = run(state,edit);
  assert.equal(quote(edited,id).lineDiscount,999);
  assert.equal(edited.auditLog[0].before.line.lineDiscount.amount,499);
  assert.equal(edited.auditLog[0].after.line.lineDiscount.amount,999);
  assert.equal(edited.auditLog[0].after.line.lineDiscountReason,edit.reason);
  const repriced = run(state,{...edit,quantity:1,lineDiscount:fixed(600)});
  assert.equal(quote(repriced,id).lineDiscount,600);
  assert.equal(repriced.auditLog[0].after.line.lineDiscountReason,'来店キャンペーン');
  assert.throws(() => run(repriced,{...edit,quantity:1,price:599}),/明細の小計以下/);
  const removed = run(repriced,{...edit,quantity:1,lineDiscount:null});
  assert.equal(quote(removed,id).lineDiscount,undefined);
  assert.equal(removed.auditLog[0].after.line.lineDiscount,null);
  assert.equal(removed.auditLog[0].after.line.lineDiscountReason,edit.reason);
  assert.throws(() => verifyCommand('manager',{...edit,lineDiscount:null},state),(error)=>error.status === 403);

  const amount = quote(removed,id).total;
  const prepaid = run(removed,{type:'deposit',ticketId:id,method:'cash',amount});
  assert.throws(() => run(prepaid,{...edit,quantity:1,lineDiscount:fixed(1)}),/前受金を下回ります/);
  state = configure(state,{allowOrderLineDiscount:false});
  assert.equal(quote(state,id).lineDiscount,499);
  assert.throws(() => run(state,{...edit,lineDiscount:null}),/店舗設定と管理者権限/);
});

test('the whole-ticket manager threshold and pending approvals use the post-line subtotal', () => {
  let state = seating({allowOrderLineDiscount:true});
  state = run(state,order(state,[drink()]));
  const id = ticketId(state);
  const lineId = state.tickets[0].lines.at(-1).id;
  const discount = {type:'discount',ticketId:id,mode:'percent',value:90,reasonCode:'service',reason:'団体キャンペーン'};
  state = run(state,discount,manager);
  const {id:requestId,subtotal} = state.tickets[0].discountRequest;
  assert.equal(subtotal,6_500);
  state = run(state,{type:'editTicketLine',ticketId:id,lineId,quantity:1,lineDiscount:fixed(300),reason:'明細を訂正'});
  assert.throws(() => run(state,{type:'approveDiscount',ticketId:id,requestId}),/小計が変わりました/);
  state = run(state,discount,manager);
  assert.equal(state.tickets[0].discountRequest.subtotal,6_200);
  assert.equal(state.tickets[0].discountRequest.amount,5_580);
  state = run(state,{type:'approveDiscount',ticketId:id,requestId:state.tickets[0].discountRequest.id});
  assert.equal(quote(state,id).discount,5_880);
  assert.throws(() => run(state,{...discount,mode:'amount',value:6_201}),/小計以下/);
});

test('settled reports, print grouping, archives, backups and configuration transfer retain line discounts', async () => {
  let state = seating({allowOrderLineDiscount:true,serviceBase:'beforeDiscount',priceMode:'inclusive'});
  const id = ticketId(state);
  state = run(state,order(state,[drink(fixed(300)),drink(fixed(450))]));
  state = run(state,{type:'discount',ticketId:id,mode:'amount',value:50,reasonCode:'service',reason:'端数調整'});
  const quoteBefore = quote(state,id);
  assert.equal(quoteBefore.service,1_600);
  assert.equal(quoteBefore.tax,800);
  assert.equal(quoteBefore.total,8_800);
  state = run(state,{type:'settle',ticketId:id,payments:[{method:'cash',amount:quoteBefore.total}]});
  const settled = quote(state,id);
  const ticket = state.tickets[0];
  const settings = {...getPrintSettings(state),documents:{receipt:{grouping:'product'}}};
  const printed = renderPrintPreview({ticket,totals:settled,date,storeName:'テスト',kind:'receipt',settings},
    {escape:String,yen});
  assert.match(printed,/明細値引き −¥750/);
  assert.match(printed,/<dt>明細値引き<\/dt><dd>−¥750/);
  assert.match(printed,/<dt>伝票値引き<\/dt><dd>−¥50/);
  const line = ticket.lines.at(-1);
  assert.throws(() => previewSettledContents(state,ticket,{lineId:line.id,quantity:1,price:100}),/明細の小計以下/);
  assert.throws(() => previewSettledContents(state,ticket,{discount:7_251}),/小計以下/);
  assert.equal(previewSettledContents(state,ticket,{lineId:line.id,quantity:1,price:1_000}).totals.lineDiscount,750);

  const file = exportStoreConfiguration(state);
  state = run(state,{type:'depart',ticketId:id});
  state = run(state,{type:'close',actualCash:summary(state).expectedCash});
  state = configure(state,{allowOrderLineDiscount:false,serviceRateBps:0});
  assert.deepEqual(quote(state,id),settled);
  const report = getReportPeriod(state,{mode:'day',date});
  assert.equal(report.totals.payments.cash,8_800);
  assert.equal(buildFreeeCsv(report,{mode:'tickets'}).salesTotal,8_800);
  assert.doesNotThrow(()=>validateSnapshot(state));
  const {snapshot} = await readDemoBackup(await writeDemoBackup(state,now));
  assert.deepEqual(quote(snapshot,id),settled);
  const invalid = structuredClone(state);
  invalid.closedDays[0].ticketSnapshots[0].lines.at(-1).lineDiscount.value = 1_501;
  assert.throws(()=>validateSnapshot(invalid),/営業データ/);
  await assert.rejects(writeDemoBackup(invalid,now),/バックアップJSON/);
  const restored = run(seating(),{type:'importStoreConfiguration',configuration:parseStoreConfiguration(JSON.stringify(file))});
  assert.equal(getCalculationSettings(restored).allowOrderLineDiscount,true);
  assert.equal(quote(run(restored,order(restored,[drink(fixed(300))])),ticketId(restored)).lineDiscount,300);
  delete file.calculationSettings.allowOrderLineDiscount;
  assert.equal(parseStoreConfiguration(JSON.stringify(file)).calculationSettings.allowOrderLineDiscount,undefined);
});
