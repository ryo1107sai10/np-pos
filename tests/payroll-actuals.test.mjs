import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';
import { createPayrollDemo } from '../docs/phase-two-demo.mjs';
import { getPayrollDraft, getPayrollTemplates, previewPayroll } from '../docs/payroll.mjs';
import { PayrollFormulaError, payrollLineKey } from '../docs/payroll-formula.mjs';
import { renderPayroll, renderPayrollTemplateEditor } from '../docs/payroll-ui.mjs';
import { validateSnapshot } from '../server/policy.mjs';

const month = '2026-11';
const date = month + '-16';
const castId = 'cast1';
const now = Date.parse(date + 'T21:00:00+09:00');
const identityRule = (label,left) => ({label,kind:'allowance',basis:'formula',left,operator:'*',right:'number',rightValue:1});
const run = (state,action) => apply(state,action,now,{id:'owner',label:'管理者',role:'admin'});
const markup = {escape:String,icon:()=>'',yen:String};

function settledVisit() {
  let state = run(createDemo('closed',now),{type:'open',date,openingCash:20_000});
  state = run(state,{type:'seat',tableIds:['a1'],guests:2,setId:'set60'});
  const {id:ticketId} = state.tickets[0];
  state = run(state,{type:'order',ticketId,items:[{menuId:'castDrink',quantity:5,castIds:[castId,'cast2']},
    {menuId:'castDrink',quantity:3,castIds:[castId]}]});
  const cancelled = state.tickets[0].lines.at(-1);
  state = run(state,{type:'cancelLine',ticketId,lineId:cancelled.id,returnStock:true,reason:'注文内容を確認'});
  state = run(state,{type:'adjustPersonalSales',ticketId,castId,amount:1000,reason:'個人売上の調整'});
  state = run(state,{type:'settle',ticketId,payments:[{method:'cash',amount:quote(state,ticketId).remaining}]});
  return run(state,{type:'depart',ticketId});
}

test('automatic payroll inputs include only settled sales, attributed line values, and dated approved work', () => {
  let state = settledVisit();
  state = run(state,{type:'seat',tableIds:['a2'],guests:1,setId:'set60'});
  state = run(state,{type:'order',ticketId:state.tickets.at(-1).id,items:[{menuId:'castDrink',quantity:9,castIds:[castId]}]});
  state = run(state,{type:'savePayrollRate',castId,effectiveDate:month+'-01',hourlyRate:3500});
  state = run(state,{type:'saveManagedAttendance',castId,date,classification:'late',
    clockInAt:Date.parse(date+'T18:00:00+09:00'),clockOutAt:now,breakMinutes:0,reason:'当日の勤怠を確認'});
  state = run(state,{type:'saveManagedAttendance',castId,date:month+'-15',classification:'absent',reason:'本人の連絡を確認'});
  state = run(state,{type:'saveManagedAttendance',castId,date:month+'-14',classification:'no-show',reason:'連絡なし'});
  const actuals = {
    personalSales:4750,workdays:2,lateDays:1,absenceDays:1,noShowDays:1,
    'menu:quantity:castDrink':2.5,'menu:sales:castDrink':3750,'menu:commission:castDrink':750,'menu:points:castDrink':2.5,
    [payrollLineKey('category','quantity','ドリンク')]:2.5,[payrollLineKey('category','sales','ドリンク')]:3750,
    [payrollLineKey('category','commission','ドリンク')]:750,[payrollLineKey('category','points','ドリンク')]:2.5,
    'menu:quantity:champagne':0,
  };
  const rules = Object.keys(actuals).map((key,index)=>identityRule(`項目${index+1}`,key));
  state = run(state,{type:'savePayrollTemplate',name:'実績連動',columns:3,rules});
  const [{id:templateId}] = getPayrollTemplates(state);
  state = run(state,{type:'assignPayrollTemplate',castId,templateId});
  state = run(state,{type:'savePayrollDraft',month,castId,work:[{date:month+'-01',minutes:60},{date:month+'-02',minutes:0}]});
  const draft = getPayrollDraft(state,month,castId);
  const pay = previewPayroll(state,draft);
  assert.deepEqual(pay.formulaContext.actuals,actuals);
  assert.equal(pay.formulaContext.actualLabels['menu:quantity:castDrink'],'キャストドリンク ／ 数量');
  assert.equal(pay.statementItems.find(({left})=>left === 'menu:commission:castDrink').amount,750);
  assert.match(renderPayroll(state,{...markup,month,castId}),/給与の計算に使用した実績/);
  state = run(state,{type:'finalizePayroll',month,castId});
  const frozen = structuredClone(getPayrollDraft(state,month,castId).snapshot);
  const settings = getStoreSettings(state);
  settings.menu.find(({id})=>id === 'castDrink').name = '新しい商品名';
  state = run(state,{type:'saveStoreSettings',settings});
  state = run(state,{type:'savePayrollTemplate',templateId,name:'新しい計算テンプレート',columns:1,rules:[]});
  const migrated = validateSnapshot(state);
  assert.deepEqual(getPayrollDraft(migrated,month,castId).snapshot,frozen);
  assert.equal(getPayrollDraft(migrated,month,castId).snapshot.templateColumns,3);
  assert.match(renderPayroll(migrated,{...markup,month,castId}),/キャストドリンク ／ 数量/);
  const tampered = structuredClone(migrated);
  delete tampered.payroll.records[0].snapshot.formulaContext.actuals.personalSales;
  assert.throws(() => validateSnapshot(tampered),{code:'invalid-snapshot'});
});

test('old settled records support only automatic calculation inputs with available evidence', () => {
  let state = settledVisit();
  const withRule = (source,key) => run(source,{type:'savePayrollSettings',settings:{statementRules:[identityRule('実績',key)]}});
  delete state.tickets[0].settlement.commissionDetails;
  assert.equal(previewPayroll(withRule(state,'menu:quantity:castDrink'),{month,castId}).formulaContext.actuals['menu:quantity:castDrink'],2.5);
  assert.throws(() => previewPayroll(withRule(state,'menu:commission:castDrink'),{month,castId}),
    (error) => error instanceof PayrollFormulaError && /確定歩合/.test(error.message));
  state = run(state,{type:'close',actualCash:summary(state).expectedCash});
  state.tickets = [];
  delete state.closedDays[0].ticketSnapshots;
  assert.equal(previewPayroll(withRule(state,'personalSales'),{month,castId}).statementItems[0].amount,4750);
  assert.throws(() => previewPayroll(withRule(state,'menu:quantity:castDrink'),{month,castId}),/商品・分類別の確定実績/);
  delete state.closedDays[0].commission;
  assert.throws(() => previewPayroll(withRule(state,'personalSales'),{month,castId}),/会計済みの実績データが不足/);
  assert.equal(previewPayroll(withRule(state,'workdays'),{month,castId}).statementItems[0].amount,0);
});

test('the demo provides a template and all current catalog choices to exercise formula inputs', () => {
  let state = createPayrollDemo(now);
  const [demoTemplate] = getPayrollTemplates(state);
  assert.match(demoTemplate.name,/実績連動/);
  const html = renderPayrollTemplateEditor(demoTemplate,{...markup,state});
  assert.match(html,/本指名 ／ 数量/);
  assert.match(html,/ドリンク ／ 確定歩合/);
  assert.match(html,/無断欠勤日数/);
  state = run(state,{type:'assignPayrollTemplate',castId,templateId:demoTemplate.id});
  const after = previewPayroll(state,getPayrollDraft(state,month,castId));
  assert.deepEqual(after.statementItems.map(({amount})=>amount),[100,200,100]);
  assert.equal(after.net,12_100);
});
