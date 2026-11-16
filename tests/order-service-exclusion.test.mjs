import assert from 'node:assert/strict';
import test from 'node:test';
import { getCalculationSettings } from '../docs/calculation-settings.mjs';
import { apply, createDemo, exportStoreConfiguration, parseStoreConfiguration, quote, summary } from '../docs/engine.mjs';
import { buildFreeeCsv } from '../docs/freee-export.mjs';
import { createBillingDemo } from '../docs/phase-two-demo.mjs';
import { getReportPeriod } from '../docs/report-period.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';
import { validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-16';
const now = Date.parse(`${date}T20:00:00+09:00`);
const admin = {id:'owner',label:'店舗管理者',role:'admin'};
const manager = {id:'manager',label:'マネージャー',role:'manager'};
const staff = {id:'staff',label:'スタッフ',role:'staff'};
const run = (state, action, actor = admin) => apply(state,action,now,actor);

function configure(state, changes) {
  return run(state,{type:'saveCalculationSettings',settings:{...getCalculationSettings(state),...changes}});
}

function seated(changes) {
  const opened = run(createDemo('closed',now),{type:'open',date,openingCash:15_000});
  return run(changes ? configure(opened,changes) : opened,{type:'seat',tableIds:['a1'],guests:1,setId:'set60'});
}

function drinkOrder(state, fields = {}) {
  return {type:'order',ticketId:state.tickets[0].id,
    items:[{menuId:'castDrink',quantity:1,castIds:['cast1'],...fields}]};
}

const exclusion = {serviceExcluded:true,serviceExclusionReason:'  招待ドリンク  '};

test('the store opts in, and only an administrator can record a service exclusion with a reason', () => {
  const original = seated();
  const proposed = drinkOrder(original,exclusion);
  const workerRejects = (state,action,role,status) =>
    assert.throws(() => verifyCommand(role,action,state),(error) => error.status === status);
  assert.throws(() => run(original,proposed),/店舗設定と管理者権限/);
  workerRejects(original,proposed,'admin',403);
  const enabled = configure(original,{allowOrderServiceExclusion:true});
  for (const actor of [manager,staff]) {
    assert.throws(() => run(enabled,proposed,actor),/店舗設定と管理者権限/);
    workerRejects(enabled,proposed,actor.role,403);
  }
  const incomplete = drinkOrder(enabled,{serviceExcluded:true,serviceExclusionReason:'   '});
  assert.throws(() => run(enabled,incomplete),/除外理由/);
  workerRejects(enabled,incomplete,'admin',400);
  const malformed = drinkOrder(enabled,{serviceExcluded:'true'});
  assert.throws(() => run(enabled,malformed),/除外設定/);
  workerRejects(enabled,malformed,'admin',400);
  verifyCommand('admin',proposed,enabled);
  const ordinaryStaffOrder = drinkOrder(enabled);
  verifyCommand('staff',ordinaryStaffOrder,enabled);
  assert.equal(run(enabled,ordinaryStaffOrder,staff).tickets[0].lines.at(-1).serviceExcluded,undefined);

  const settings = getStoreSettings(enabled);
  settings.menu.find(({id}) => id === 'castDrink').serviceEligible = false;
  const ineligible = run(enabled,{type:'saveStoreSettings',settings});
  assert.throws(() => run(ineligible,proposed),/対象外/);
});

test('service exclusion changes only the service and resulting tax and freezes after checkout', () => {
  const started = seated({allowOrderServiceExclusion:true});
  const {id:ticketId} = started.tickets[0];
  const ordinary = run(started,drinkOrder(started));
  let excluded = run(started,drinkOrder(started,exclusion));
  const ordinaryQuote = quote(ordinary,ticketId);
  const newQuote = quote(excluded,ticketId);
  assert.equal(ordinaryQuote.subtotal,newQuote.subtotal);
  assert.equal(ordinaryQuote.service,1_300);
  assert.equal(newQuote.service,1_000);
  assert.equal(ordinaryQuote.total - newQuote.total,330);
  assert.equal(ordinaryQuote.tax - newQuote.tax,30);
  assert.deepEqual(ordinaryQuote.commission,newQuote.commission);
  assert.deepEqual(ordinary.stock,excluded.stock);
  assert.deepEqual(ordinary.movements,excluded.movements);
  const line = excluded.tickets[0].lines.at(-1);
  assert.equal(line.serviceEligible,true);
  assert.equal(line.serviceExcluded,true);
  assert.equal(line.serviceExclusionReason,undefined);
  const audit = excluded.auditLog[0];
  assert.equal(audit.actor.id,admin.id);
  assert.equal(audit.at,now);
  assert.equal(audit.after.lines[0].id,line.id);
  assert.equal(audit.after.lines[0].serviceExclusionReason,'招待ドリンク');
  assert.equal(audit.after.lines[0].serviceExcluded,true);

  excluded = run(excluded,{type:'settle',ticketId,payments:[{method:'cash',amount:newQuote.total}]});
  const paidQuote = quote(excluded,ticketId);
  excluded = run(excluded,{type:'depart',ticketId});
  excluded = run(excluded,{type:'close',actualCash:summary(excluded).expectedCash});
  excluded = configure(excluded,{allowOrderServiceExclusion:false,serviceRateBps:5_000});
  assert.deepEqual(quote(excluded,ticketId),paidQuote);
  const report = getReportPeriod(excluded,{mode:'day',date});
  const accounting = buildFreeeCsv(report,{mode:'tickets'});
  assert.equal(accounting.salesTotal,newQuote.total);
  assert.equal(report.totals.payments.cash,newQuote.total);
  assert.equal(excluded.closedDays[0].ticketSnapshots[0].lines.at(-1).serviceExcluded,true);
  const malformed = structuredClone(excluded);
  malformed.closedDays[0].ticketSnapshots[0].lines.at(-1).serviceExcluded = 'true';
  assert.throws(() => validateSnapshot(malformed),/営業データ/);
  assert.doesNotThrow(() => validateSnapshot(excluded));
});

test('active corrections keep the existing snapshot unless the admin explicitly changes it', () => {
  let state = seated({allowOrderServiceExclusion:true,priceMode:'inclusive',serviceBase:'beforeDiscount'});
  state = run(state,drinkOrder(state,exclusion));
  const {id:ticketId,lines} = state.tickets[0];
  const {id:lineId} = lines.at(-1);
  const original = quote(state,ticketId);
  const edit = {type:'editTicketLine',ticketId,lineId,quantity:1,reason:'通常注文に訂正'};
  assert.equal(original.service,1_000);
  assert.equal(original.tax > 0,true);
  const managerEdit = run(state,edit,manager);
  assert.equal(managerEdit.tickets[0].lines.at(-1).serviceExcluded,true);
  const clear = {...edit,serviceExcluded:false};
  assert.throws(() => run(state,clear,manager),/店舗設定と管理者権限/);
  assert.throws(() => run(state,{...clear,reason:''}),/訂正理由/);
  const assessed = run(state,clear);
  const corrected = quote(assessed,ticketId);
  assert.equal(corrected.service,1_300);
  assert.equal(corrected.total-original.total,300);
  assert.equal(corrected.tax > original.tax,true);
  assert.deepEqual(assessed.movements,state.movements);
  assert.deepEqual(corrected.commission,original.commission);
  assert.equal(assessed.auditLog[0].before.line.serviceExcluded,true);
  assert.equal(assessed.auditLog[0].after.line.serviceExcluded,false);
  assert.equal(assessed.auditLog[0].reason,edit.reason);

  const prepaid = run(assessed,{type:'deposit',ticketId,method:'cash',amount:corrected.total});
  assert.throws(() => run(prepaid,{...edit,serviceExcluded:true}),/前受金を下回ります/);

  state = configure(state,{allowOrderServiceExclusion:false});
  assert.equal(quote(state,ticketId).total,original.total);
  assert.throws(() => run(state,clear),/店舗設定と管理者権限/);
});

test('the opt-in transfers to another browser and stays optional in older configuration files', () => {
  const enabled = seated({allowOrderServiceExclusion:true});
  const file = exportStoreConfiguration(enabled);
  const configuration = parseStoreConfiguration(JSON.stringify(file));
  const imported = run(seated(),{type:'importStoreConfiguration',configuration});
  assert.equal(getCalculationSettings(imported).allowOrderServiceExclusion,true);
  assert.equal(run(imported,drinkOrder(imported,exclusion)).tickets[0].lines.at(-1).serviceExcluded,true);

  file.calculationSettings.allowOrderServiceExclusion = 'true';
  assert.throws(() => parseStoreConfiguration(JSON.stringify(file)),/設定を確認/);
  delete file.calculationSettings.allowOrderServiceExclusion;
  assert.equal(parseStoreConfiguration(JSON.stringify(file)).calculationSettings.allowOrderServiceExclusion,undefined);
});

test('the billing demo enables the option and retains the original exhibit timers', () => {
  const state = createBillingDemo(now);
  assert.equal(getCalculationSettings(state).allowOrderServiceExclusion,true);
  assert.deepEqual(state.tickets.map(({tableIds,endsAt,lines}) => [tableIds[0],endsAt,lines.length]),
    [['a1',now + 30_000,1],['a2',now + 30_000,1]]);
  assert.equal(state.tableAutoExtension.a2,false);
  assert.equal(state.cardFeeSettings.rateBps,500);
});
