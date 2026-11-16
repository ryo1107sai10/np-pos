import { apply, createDemo, quote } from './engine.mjs';

const demoAdmin = { id: 'demo-admin', label: 'デモの店舗管理者', role: 'admin' };

export function createPhaseTwoDemo(mode = 'live', now = Date.now()) {
  let state = createDemo(mode, now);
  const step = (command, at = now) => { state = apply(state, command, at, demoAdmin); };
  step({ type:'saveCustomer', customer:{name:'山本 花子', kana:'やまもと はなこ',
    castId:'cast1', creditEnabled:true, creditLimit:30_000} }, now - 180 * 60_000);
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
