import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomAccountingCsv } from '../docs/accounting-csv.mjs';
import { apply, createDemo, exportStoreConfiguration, parseStoreConfiguration, previewSettledContents, quote, summary, yen } from '../docs/engine.mjs';
import { getReportPeriod } from '../docs/report-period.mjs';
import { getPrintSettings } from '../docs/print-domain.mjs';
import { renderPrintPreview } from '../docs/print-ui.mjs';
import { getPayrollDraft, previewPayroll } from '../docs/payroll.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';
import { validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-17';
const at = Date.parse(date + 'T21:00:00+09:00');
const admin = {id:'owner',label:'管理者',role:'admin'};
const manager = {id:'manager',label:'担当',role:'manager'};
const run = (state,action,actor=admin) => apply(state,action,at,actor);
const opened = () => run(createDemo('closed',at),{type:'open',date,openingCash:20_000});

test('custom menu groups and customer-facing printed names are portable and snapshotted', () => {
  let state = opened();
  const settings = getStoreSettings(state);
  settings.customMenuCategories = ['特製ドリンク'];
  Object.assign(settings.menu.find(({id}) => id === 'highball'),{category:'特製ドリンク',printName:'特選ハイボール'});
  const water = 'menu-10000000-0000-4000-8000-000000000000';
  settings.menu.push({id:water,category:'ドリンク',name:'無料サービス品',price:0,hideReceiptLine:true});
  state = run(state,{type:'saveStoreSettings',settings});
  const saved = parseStoreConfiguration(JSON.stringify(exportStoreConfiguration(state))).settings;
  assert.deepEqual(saved.customMenuCategories,['特製ドリンク']);
  state = run(state,{type:'seat',tableIds:['a1'],guests:1,setId:'set60'});
  const ticketId = state.tickets[0].id;
  state = run(state,{type:'order',ticketId,items:[{menuId:'highball',quantity:1},{menuId:water,quantity:1}]});
  state = run(state,{type:'settle',ticketId,payments:[{method:'cash',amount:quote(state,ticketId).total}]});
  const ticket = state.tickets[0];
  const printed = renderPrintPreview({ticket,totals:ticket.settlement,date,kind:'receipt',settings:getPrintSettings(state)},
    {escape:String,yen});
  assert.match(printed,/特選ハイボール/);
  assert.doesNotMatch(printed,/無料サービス品/);
  assert.ok(validateSnapshot(state));
});

test('editable accounting export keeps a split mixed-tax sale balanced and supports Shift_JIS', () => {
  let state = opened();
  const settings = getStoreSettings(state);
  settings.menu.find(({id})=>id === 'highball').taxRate = 800;
  state = run(state,{type:'saveStoreSettings',settings});
  state = run(state,{type:'seat',tableIds:['a1'],guests:1,setId:'set60'});
  const ticketId = state.tickets[0].id;
  state = run(state,{type:'order',ticketId,items:[{menuId:'highball',quantity:1}]});
  const total=quote(state,ticketId).total;
  state = run(state,{type:'settle',ticketId,payments:[{method:'cash',amount:3000},{method:'card',amount:total-3000}]});
  const action={type:'saveAccountingCsv',mode:'daily',settings:{encoding:'sjis',columns:[
    {name:'決済',value:'{payment_method}'},{name:'金額',value:'{amount}'},{name:'税率',value:'{tax_rate}'},
  ]}};
  assert.throws(() => verifyCommand('staff',action),{code:'forbidden'});
  verifyCommand('admin',action);
  state = run(state,action);
  const period=getReportPeriod(state,{mode:'day',date});
  const output = buildCustomAccountingCsv(state,period,'daily','店舗');
  const rows = new TextDecoder('shift_jis').decode(output.data).trim().split(/\r?\n/).slice(1).map((row)=>row.split(','));
  assert.equal(rows.reduce((acc,row)=>acc+Number(row[1]),0),total);
  assert.equal(rows.filter(([method])=>method==='現金').reduce((acc,row)=>acc+Number(row[1]),0),3000);
  assert.equal(rows.filter((row)=>row[2]==='8').reduce((acc,row)=>acc+Number(row[1]),0),
    state.tickets[0].settlement.taxBreakdown.filter(({rate})=>rate===800).reduce((acc,group)=>acc+group.base+group.tax,0));
  assert.equal(validateSnapshot(state).accountingCsv.daily.encoding,'sjis');
});

test('editing and voiding register entries adjusts reports and preserves the count and actor trail', () => {
  let state=run(opened(),{type:'recordCashMovement',kind:'expense',category:'supplies',amount:3000,reason:'備品'});
  const movementId=state.cashMovements[0].id;
  const edit={type:'editCashMovement',movementId,kind:'expense',category:'supplies',amount:2000,reason:'備品',correctionReason:'入力違い'};
  state=run(state,edit,manager);
  assert.equal(summary(state).expectedCash,18_000);
  state=run(state,{type:'close',actualCash:18_000});
  assert.throws(()=>run(state,{...edit,amount:1500},manager),/権限/);
  state=run(state,{type:'voidCashMovement',movementId,correctionReason:'重複記録'});
  assert.equal(state.closedDays[0].expectedCash,20_000);
  assert.equal(state.closedDays[0].actualCash,18_000);
  assert.equal(state.closedDays[0].discrepancy,-2000);
  state=run(state,{type:'correctRegisterCount',date,actualCash:20_000,cashDenominations:{10000:2},reason:'再確認'});
  assert.equal(state.closedDays[0].discrepancy,0);
  assert.equal(state.day.closingCash,20_000);
  assert.equal(state.auditLog.find(({action})=>action==='editCashMovement').actor.id,manager.id);
  assert.ok(validateSnapshot(state));
});

test('archived line correction verifies the new total and updates cash, sales and inventory atomically', () => {
  let state=run(opened(),{type:'seat',tableIds:['a1'],guests:1,setId:'set60'});
  const ticketId=state.tickets[0].id;
  state=run(state,{type:'order',ticketId,items:[{menuId:'highball',quantity:2}]});
  const before=quote(state,ticketId).total;
  state=run(state,{type:'settle',ticketId,payments:[{method:'cash',amount:before}]});
  state=run(state,{type:'depart',ticketId});
  state=run(state,{type:'close',actualCash:20_000 + before});
  state=run(state,{type:'open',date:'2026-11-18',openingCash:20_000});
  const ticket=state.closedDays[0].ticketSnapshots[0];
  const line=ticket.lines.find(({menuId}) => menuId === 'highball');
  const action={type:'correctSettledContents',ticketId,lineId:line.id,quantity:1,price:line.price,discount:0,castIds:[],
    adjustmentMethod:'cash',returnStock:true,reason:'未提供分を返金'};
  const expectedTotal=previewSettledContents(state,ticket,action).totals.total;
  assert.throws(()=>run(state,{...action,expectedTotal:before}),/金額|請求額/);
  assert.throws(()=>verifyCommand('manager',{...action,expectedTotal}),{code:'forbidden'});
  verifyCommand('admin',{...action,expectedTotal});
  state=run(state,{...action,expectedTotal});
  const report=state.closedDays[0];
  assert.equal(report.ticketSnapshots[0].settlement.total,expectedTotal);
  assert.equal(report.sales,expectedTotal);
  assert.equal(report.expectedCash,20_000 + expectedTotal);
  assert.equal(report.discrepancy,before-expectedTotal);
  assert.equal(report.actualCash,20_000 + before);
  assert.equal(state.movements[0].kind,'return');
  assert.equal(state.auditLog.find(({action})=>action==='correctSettledContents').businessDate,date);
  assert.ok(validateSnapshot(state));
});

test('an archived extension price and its linked cancellation update the original receipt, timing and payout', () => {
  let state = run(opened(),{type:'seat',tableIds:['a1'],guests:1,setId:'set60'});
  const ticketId = state.tickets[0].id;
  state = run(state,{type:'order',ticketId,items:[{menuId:'nomination',quantity:1,castIds:['cast1']}]});
  const originalEnd = state.tickets[0].endsAt;
  state = run(state,{type:'extend',ticketId,menuId:'extend30'});
  const charge = state.tickets[0].lines.find(({menuId}) => menuId === 'extend30');
  const surcharge = state.tickets[0].lines.find(({menuId}) => menuId === 'nominationExtra');
  assert.equal(surcharge.extensionGroupId,charge.id);
  const before = quote(state,ticketId);
  state = run(state,{type:'settle',ticketId,payments:[{method:'cash',amount:before.total}]});
  state = run(state,{type:'depart',ticketId});
  state = run(state,{type:'close',actualCash:20_000 + before.total});
  state = run(state,{type:'open',date:'2026-11-18',openingCash:20_000});
  const ticket = state.closedDays[0].ticketSnapshots[0];
  const action = {type:'correctSettledContents',ticketId,lineId:charge.id,price:2_000,
    quantity:1,discount:0,castIds:[],adjustmentMethod:'cash',reason:'延長料金を訂正'};
  const priceTotal = previewSettledContents(state,ticket,action).totals.total;
  state = run(state,{...action,expectedTotal:priceTotal});
  const adjusted = state.closedDays[0].ticketSnapshots[0];
  assert.equal(adjusted.lines.find(({id}) => id === charge.id).price,2_000);
  assert.equal(adjusted.endsAt,ticket.endsAt);
  const voidGroup = {...action,cancelLine:true,reason:'延長自体を取り消し'};
  const cancelledTotal = previewSettledContents(state,adjusted,voidGroup).totals.total;
  state = run(state,{...voidGroup,expectedTotal:cancelledTotal});
  const closing = state.closedDays[0];
  assert.equal(closing.sales,cancelledTotal);
  assert.equal(closing.expectedCash,20_000 + cancelledTotal);
  assert.equal(closing.actualCash,20_000 + before.total);
  assert.equal(closing.ticketSnapshots[0].endsAt,originalEnd);
  assert.deepEqual(closing.ticketSnapshots[0].lines.filter(({cancelledAt}) => cancelledAt !== null).map(({id}) => id),
    [charge.id,surcharge.id]);
  assert.equal(state.auditLog[0].after.lines.length,2);
  assert.ok(validateSnapshot(state));
});

test('payroll formulas freeze personal variable values and intermediate calculations', () => {
  const castId='cast1';
  const month='2026-11';
  let state=run(opened(),{type:'savePayrollVariables',castId,variables:[{name:'時給加算',defaultValue:200,value:350}]});
  const variable=state.payroll.variables[0];
  state=run(state,{type:'savePayrollSettings',settings:{statementRules:[
    {label:'内部計算',kind:'intermediate',basis:'formula',left:'var:'+variable.id,operator:'*',right:'number',rightValue:3},
    {label:'手当',kind:'allowance',basis:'threshold',left:'item:0',threshold:1000,above:2000,below:500},
  ]}});
  state=run(state,{type:'savePayrollDraft',month,castId});
  state=run(state,{type:'finalizePayroll',month,castId});
  assert.equal(getPayrollDraft(state,month,castId).snapshot.net,2000);
  state=run(state,{type:'savePayrollVariables',castId,variables:[{id:variable.id,name:variable.name,defaultValue:200,value:150}]});
  assert.equal(previewPayroll(state,{month:'2026-12',castId}).net,500);
  assert.equal(validateSnapshot(state).payroll.records[0].snapshot.net,2000);
  assert.throws(()=>run(state,{type:'savePayrollVariables',castId,variables:[]}),/使用している/);
});

test('restoring a voided ticket charges inventory only when the cancellation returned it', () => {
  let state=run(opened(),{type:'seat',tableIds:['a1'],guests:1,setId:'set60'});
  const ticketId=state.tickets[0].id;
  state=run(state,{type:'order',ticketId,items:[{menuId:'highball',quantity:1}]});
  const quantities=state.stock.map(({quantity})=>quantity);
  const restore={type:'reopenTicket',ticketId,tableIds:['a1'],reason:'誤取消の復元'};
  for (const returnStock of [true,false]) {
    const voided=run(state,{type:'void',ticketId,returnStock});
    const reopened=run(voided,restore);
    assert.equal(reopened.tickets[0].status,'open');
    assert.deepEqual(reopened.stock.map(({quantity})=>quantity),quantities);
    assert.equal(reopened.auditLog[0].before.status,'void');
  }
});
