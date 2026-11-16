import { apply, createDemo, quote, summary } from './engine.mjs';

const demoAdmin = { id: 'demo-admin', label: 'デモの店舗管理者', role: 'admin' };
const demoCustomer = {name:'山本 花子', kana:'やまもと はなこ',
  castId:'cast1', creditEnabled:true, creditLimit:30_000};

export function createPhaseTwoDemo(mode = 'live', now = Date.now()) {
  let state = createDemo(mode, now);
  const step = (command, at = now) => { state = apply(state, command, at, demoAdmin); };
  step({ type:'saveCustomer', customer:demoCustomer }, now - 180 * 60_000);
  if (mode === 'closed') return state;

  const customerId = state.customers[0].id;
  const past = now - 80 * 60_000;
  step({ type:'seat', tableIds:['a3'], guests:2, setId:'set60', customerId }, past);
  const ticketId = state.tickets.at(-1).id;
  step({ type:'order', ticketId, items:[{menuId:'nomination', quantity:1, castIds:['cast1']}] }, past + 60_000);
  const creditDueDate = new Date(Date.parse(state.day.date) + 7 * 86_400_000).toISOString().slice(0,10);
  const amount = quote(state,ticketId).remaining;
  step({ type:'settle', ticketId, payments:[{method:'cash', amount:amount - 10_000}, {method:'receivable', amount:10_000}],
    creditDueDate }, now - 20 * 60_000);
  step({ type:'depart', ticketId }, now - 19 * 60_000);
  step({ type:'recoverReceivable', receivableId:state.receivables[0].id, amount:4_000,
    method:'bank', date:state.day.date }, now - 5 * 60_000);
  return state;
}

export function createCashDemo(now = Date.now()) {
  const minute = 60_000;
  let state = createDemo('closed', now);
  const step = (command, minutesAgo) => { state = apply(state, command, now - minutesAgo * minute, demoAdmin); };
  step({type:'open',date:state.day.date,openingCash:20_000},100);
  step({type:'saveCustomer',customer:demoCustomer},85);
  step({type:'seat',tableIds:['a3'],guests:2,setId:'set60',customerId:state.customers[0].id},80);
  const ticketId = state.tickets[0].id;
  const creditAmount = 10_000;
  const tenderAmount = quote(state,ticketId).remaining - creditAmount;
  step({type:'settle',ticketId,creditDueDate:state.day.date,
    payments:[{method:'cash',amount:tenderAmount},{method:'receivable',amount:creditAmount}]},34);
  step({type:'depart',ticketId},32);
  step({type:'recordCashMovement',kind:'deposit',category:'float',amount:5_000,
    reason:'釣銭が不足したため補充',destination:'店内金庫'},30);
  step({type:'recordCashMovement',kind:'withdrawal',category:'safe',amount:2_000,
    reason:'レジの現金を金庫へ移動',destination:'店内金庫'},20);
  step({type:'recordCashMovement',kind:'expense',category:'supplies',amount:1_200,
    reason:'レジロールを購入',destination:'文具店'},14);
  step({type:'recoverReceivable',receivableId:state.receivables[0].id,amount:4_000,
    method:'cash',date:state.day.date},9);
  return state;
}

export function createPeriodReportDemo(now = Date.now()) {
  const minute = 60_000;
  const day = 86_400_000;
  let state = createDemo('closed',now);
  const latest = state.day.date;
  const previousDates = [2,1].map((offset) => new Date(Date.parse(latest) - day * offset).toISOString().slice(0,10));
  const step = (command,at) => { state = apply(state,command,at,demoAdmin); };
  step({type:'saveCustomer',customer:demoCustomer},now - 3 * day);
  const customerId = state.customers[0].id;

  for (const [index,date] of [...previousDates,latest].entries()) {
    const opening = index === 2 ? now - 56 * minute : Date.parse(`${date}T18:00:00+09:00`);
    const at = (minutes) => opening + minute * minutes;
    step({type:'open',date,openingCash:20_000},opening);
    step({type:'seat',tableIds:['a1'],guests:index === 1 ? 3 : 2,setId:'set60',...(index === 0 ? {customerId} : {})},at(5));
    const ticket = state.tickets.at(-1);
    if (index === 2) step({type:'deposit',ticketId:ticket.id,amount:2_000,method:'cash'},at(10));
    const amount = quote(state,ticket.id).remaining;
    const payments = index === 0 ? [{method:'card',amount:amount - 10_000},{method:'receivable',amount:10_000}]
      : [{method:index === 1 ? 'qr' : 'cash',amount}];
    step({type:'settle',ticketId:ticket.id,payments,...(index === 0 ? {creditDueDate:latest} : {})},at(38));
    step({type:'depart',ticketId:ticket.id},at(39));
    if (index === 1) {
      step({type:'recoverReceivable',receivableId:state.receivables[0].id,amount:4_000,method:'bank',date},at(42));
      step({type:'recordCashMovement',kind:'expense',category:'supplies',amount:900,
        reason:'レジロールを購入',destination:'文具店'},at(44));
    }
    if (index < 2) step({type:'close',actualCash:summary(state).expectedCash},at(55));
  }
  return state;
}

export function createBillingDemo(now = Date.now()) {
  const minute = 60_000;
  const step = (state,command,at) => apply(state,command,at,demoAdmin);
  let sample = createDemo('closed',now);
  sample = step(sample,{type:'open',date:sample.day.date,openingCash:20_000},now - 75 * minute);
  sample = step(sample,{type:'saveAutoExtensionSettings',enabled:true,menuId:'extend30'},now - 74 * minute);
  sample = step(sample,{type:'saveCardFeeSettings',settings:{enabled:true,rateBps:500}},now - 73 * minute);
  return step(sample,{type:'seat',tableIds:['a1'],guests:2,setId:'set60'},now - 60 * minute + 30_000);
}
