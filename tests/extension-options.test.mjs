import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createDemo, exportStoreConfiguration, parseStoreConfiguration, quote } from '../docs/engine.mjs';
import { renderExtensionQuote } from '../docs/print-ui.mjs';
import { validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-17';
const now = Date.parse(`${date}T21:00:00+09:00`);
const minute = 60_000;
const standard = 'extend30';
const premium = 'menu-12345678-90ab-4123-8123-1234567890ab';
const admin = {id:'admin',role:'admin',label:'管理者'};
const staff = {id:'staff',role:'staff',label:'ホール'};

function openTicket() {
  let state = apply(createDemo('closed',now),{type:'open',date,openingCash:20_000},now,admin);
  const defaultPlan = state.menu.find(({id}) => id === standard);
  state.menu.push({...defaultPlan,id:premium,name:'VIP延長30分',price:4000});
  state = apply(state,{type:'seat',tableIds:['a1'],guests:2,setId:'set60'},now,admin);
  state = apply(state,{type:'order',ticketId:state.tickets[0].id,items:[{menuId:'nomination',quantity:1,castIds:['cast1']}]},now,staff);
  return state;
}

test('mixed same-duration plans charge each guest once, add one nomination per interval and undo a complete interval', () => {
  const state = openTicket();
  const [ticket] = state.tickets;
  const at = ticket.endsAt + 31 * minute;
  const plans = [{menuId:standard,quantity:1},{menuId:premium,quantity:1}];
  const command = {type:'extendOverdue',ticketId:ticket.id,expectedCount:2,plans};
  assert.doesNotThrow(() => verifyCommand('staff',command));
  const extended = apply(state,command,at,staff);
  assert.equal(extended.tickets[0].endsAt,ticket.endsAt + 60 * minute);
  const newLines = extended.tickets[0].lines.slice(-6);
  assert.deepEqual(newLines.map(({menuId,quantity})=>[menuId,quantity]),[
    [standard,1],[premium,1],['nominationExtra',1],
    [standard,1],[premium,1],['nominationExtra',1],
  ]);
  assert.equal(new Set(newLines.slice(0,3).map(({extensionGroupId})=>extensionGroupId)).size,1);
  assert.equal(new Set(newLines.slice(3).map(({extensionGroupId})=>extensionGroupId)).size,1);
  assert.equal(extended.auditLog[0].after.lines.length,6);
  const total = quote(extended,ticket.id).total;
  assert.throws(() => apply(state,{...command,expectedTotal:total + 1},at,staff),/料金が変わりました/);
  assert.equal(apply(state,{...command,expectedTotal:total},at,staff).tickets[0].endsAt,extended.tickets[0].endsAt);
  assert.throws(() => apply(state,{...command,plans:[plans[0],{menuId:'extend60',quantity:1}]},at,staff),/同じ延長時間/);
  assert.throws(() => apply(state,{...command,plans:[plans[0]]},at,staff),/人数合計/);
  assert.throws(() => apply(state,{...command,plans:[plans[0],plans[0]]},at,staff),/重複/);
  assert.throws(() => verifyCommand('staff',{...command,plans:[null]}),{code:'invalid-command'});
  const cancelled = apply(extended,{type:'cancelTicketExtension',ticketId:ticket.id,lineId:newLines[1].id,reason:'誤って延長'},at,admin);
  assert.equal(cancelled.tickets[0].endsAt,ticket.endsAt + 30 * minute);
  assert.equal(cancelled.tickets[0].lines.slice(-6).filter(({cancelledAt})=>cancelledAt != null).length,3);
});

test('manual overdue setting is owner-only, independent of automatic and single manual extension and portable', () => {
  const state = openTicket();
  const [ticket] = state.tickets;
  const at = ticket.endsAt + minute;
  const settings = {type:'saveAutoExtensionSettings',enabled:true,menuId:standard,bulkExtensionEnabled:false};
  assert.throws(() => apply(state,settings,now,staff),/管理者/);
  const disabled = apply(state,settings,now,admin);
  assert.equal(disabled.autoExtensionSettings.enabled,true);
  assert.equal(disabled.bulkExtensionEnabled,false);
  assert.equal(disabled.auditLog[0].after.bulkExtensionEnabled,false);
  assert.equal(validateSnapshot(disabled).bulkExtensionEnabled,false);
  assert.throws(() => apply(disabled,{type:'extendOverdue',ticketId:ticket.id,menuId:standard,expectedCount:1},at,staff),/一括延長がオフ/);
  assert.equal(apply(disabled,{type:'extend',ticketId:ticket.id,menuId:standard},at,staff).tickets[0].endsAt,ticket.endsAt + 30*minute);
  const backup = parseStoreConfiguration(JSON.stringify(exportStoreConfiguration(disabled)));
  const restored = apply(createDemo('closed',now),{type:'importStoreConfiguration',configuration:backup},now,admin);
  assert.equal(restored.bulkExtensionEnabled,false);
});

test('extension quote prints each option and can omit all references to the advance', () => {
  const model = {ticket:{number:10,guests:2},tables:['A-01'],date,at:now,settings:{width:58},storeName:'検証店',
    before:{remaining:8000,total:10000},
    entries:[
      {name:'延長30分',duration:30,endsAt:now+30*minute,after:{total:15000,remaining:13000,deposit:2000}},
      {name:'延長60分',duration:60,endsAt:now+60*minute,after:{total:20000,remaining:18000,deposit:2000}},
    ]};
  const api = {escape:String,yen:String};
  const afterAdvance = renderExtensionQuote({...model,deductAdvance:true},api);
  assert.match(afterAdvance,/延長30分[\s\S]*13000[\s\S]*延長60分[\s\S]*18000/);
  assert.match(afterAdvance,/受領済みの前受金/);
  const gross = renderExtensionQuote({...model,deductAdvance:false},api);
  assert.doesNotMatch(gross,/受領済みの前受金|(?:13000|18000)/);
  assert.match(gross,/延長30分[\s\S]*15000[\s\S]*延長60分[\s\S]*20000/);
});
