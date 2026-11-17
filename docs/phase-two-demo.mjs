import { apply, createDemo, quote, summary } from './engine.mjs';
import { getCalculationSettings } from './calculation-settings.mjs';

const demoAdmin = { id: 'demo-admin', label: 'デモの店舗管理者', role: 'admin' };
const demoCustomer = {name:'山本 花子', kana:'やまもと はなこ',
  castId:'cast1', creditEnabled:true, creditLimit:30_000};

export function createPhaseTwoDemo(mode = 'live', now = Date.now()) {
  let state = createDemo(mode, now);
  const step = (command, at = now) => { state = apply(state, command, at, demoAdmin); };
  step({ type:'saveCustomer', customer:demoCustomer }, now - 180 * 60_000);
  if (mode === 'closed') return state;

  const customerId = state.customers[0].id;
  step({type:'saveCustomer', customer:{name:'佐藤 彩',kana:'さとう あや'}},now - 175 * 60_000);
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

export function createCustomerNoticeDemo(now = Date.now()) {
  let state = createPhaseTwoDemo('live', now);
  const date = (offset) => new Date(Date.parse(state.day.date) + offset * 86_400_000).toISOString().slice(0,10);
  const [birthday, anniversary] = state.customers;
  state = apply(state, {type:'saveCustomer',customerId:birthday.id,customer:{castId:'cast2',birthday:`2000-${date(0).slice(5)}`,
    bottleKeeps:[{name:'サンプルウイスキー',quantity:0.7,unit:'本',expiresAt:date(5)}]}}, now, demoAdmin);
  return apply(state, {type:'saveCustomer',customerId:anniversary.id,customer:{
    anniversaries:[{label:'初回来店記念日',monthDay:date(2).slice(5)}],
    bottleKeeps:[{name:'サンプル焼酎',quantity:0.4,unit:'本',expiresAt:date(-1)}]}}, now, demoAdmin);
}

export function createCashDemo(now = Date.now()) {
  const minute = 60_000;
  let state = createDemo('closed', now);
  const latestDate = state.day.date;
  const previousDate = new Date(Date.parse(latestDate) - 86_400_000).toISOString().slice(0,10);
  const previousOpening = Date.parse(`${previousDate}T19:00:00+09:00`);
  state = apply(state,{type:'open',date:previousDate,openingCash:20_000},previousOpening,demoAdmin);
  state = apply(state,{type:'recordCashMovement',kind:'expense',category:'transport',amount:700,reason:'備品受け取りの交通費'},
    previousOpening + 30 * minute,demoAdmin);
  state = apply(state,{type:'close',actualCash:19_300},previousOpening + 180 * minute,demoAdmin);
  const step = (command, minutesAgo) => { state = apply(state, command, now - minutesAgo * minute, demoAdmin); };
  step({type:'open',date:latestDate,openingCash:20_000},100);
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
  sample = step(sample,{type:'setTableAutoExtension',tableId:'a2',enabled:false},now - 72 * minute);
  const seatedAt = now - 60 * minute + 30_000;
  sample = step(sample,{type:'seat',tableIds:['a1'],guests:2,setId:'set60'},seatedAt);
  sample = step(sample,{type:'seat',tableIds:['a2'],guests:1,setId:'set60'},seatedAt);
  return step(sample,{type:'saveCalculationSettings',settings:{
    ...getCalculationSettings(sample),allowOrderServiceExclusion:true,allowOrderTaxOverride:true,allowOrderLineDiscount:true,
  }},now);
}

export function createCastDutyDemo(now = Date.now()) {
  let state = createPhaseTwoDemo('live',now);
  const {date} = state.day;
  const minute = 60_000;
  const midnight = Date.parse(`${date}T00:00:00+09:00`);
  const elapsed = Math.floor((now - midnight) / minute);
  const step = (command) => { state = apply(state,command,now,demoAdmin); };
  const times = {date,startMinute:Math.min(1_439,Math.max(0,elapsed - 30)),endMinute:elapsed + 180};
  step({type:'saveShift',castId:'cast2',status:'confirmed',...times});
  step({type:'saveShift',castId:'cast3',status:'requested',...times});
  step({type:'saveManagedAttendance',castId:'cast1',date,classification:'worked',
    clockInAt:Math.max(midnight,now - 20 * minute),clockOutAt:null,reason:'勤務中キャストのサンプル'});
  step({type:'saveControls',managerDiscountRateBps:1_000,castDutyMode:'attendance'});
  return state;
}

export function createPayrollDemo(now = Date.now()) {
  let state = createPhaseTwoDemo('live',now);
  const date = state.day.date;
  const month = date.slice(0,7);
  const castId = 'cast1';
  const step = (action) => { state = apply(state,action,now,demoAdmin); };
  step({type:'savePayrollRate',castId,effectiveDate:`${month}-01`,hourlyRate:3500});
  step({type:'savePayrollDraft',month,castId,work:[{date,minutes:180}],
    allowances:[{label:'交通費',amount:500}],deductions:[]});
  step({type:'requestDailyPay',castId,month,amount:1000,reason:'サンプルの日払い申請'});
  const previousDate = new Date(Date.parse(`${month}-01`) - 86_400_000).toISOString().slice(0,10);
  for (const [id,workDate,minutes,hourlyRate] of [['cast2',date,240,3000],[castId,previousDate,225,3200]]) {
    const payrollMonth = workDate.slice(0,7);
    step({type:'savePayrollRate',castId:id,effectiveDate:workDate,hourlyRate});
    step({type:'savePayrollDraft',month:payrollMonth,castId:id,work:[{date:workDate,minutes}]});
    step({type:'finalizePayroll',month:payrollMonth,castId:id});
  }
  step({type:'saveShift',castId,date,startMinute:1200,endMinute:1500,status:'confirmed'});
  step({type:'saveShift',castId:'cast2',date,startMinute:1260,endMinute:1560,status:'requested'});
  step({type:'savePayrollTemplate',name:'実績連動サンプル',rules:[
    {label:'個人売上の5％',kind:'allowance',basis:'formula',left:'personalSales',operator:'*',right:'number',rightValue:0.05},
    {label:'勤務日手当',kind:'allowance',basis:'formula',left:'workdays',operator:'*',right:'number',rightValue:200},
    {label:'本指名の件数手当',kind:'allowance',basis:'formula',left:'menu:quantity:nomination',operator:'*',right:'number',rightValue:100},
  ]});
  return state;
}

export function createLaborDemo(now = Date.now()) {
  let state = createPayrollDemo(now);
  const dates = [2,1].map((offset)=>new Date(Date.parse(state.day.date) - offset * 86_400_000).toISOString().slice(0,10));
  const step = (command) => { state = apply(state,command,now,demoAdmin); };
  const roster = [['高橋','admin',0],['佐伯','manager',3000],['森','staff',1800],['望月','trainee',null]];
  for (const [index,[name,role,hourlyRate]] of roster.entries()) {
    step({type:'saveStaffPerson',name,role,enabled:true});
    const {id:personId} = state.staffLabor.people.at(-1);
    if (hourlyRate !== null) step({type:'saveStaffRate',personId,effectiveDate:dates[0],hourlyRate});
    for (const date of index < 3 ? dates : dates.slice(1)) {
      const clockInAt = Date.parse(`${date}T20:00:00+09:00`);
      step({type:'saveStaffAttendance',personId,date,clockInAt,clockOutAt:clockInAt + (5+index) * 60 * 60_000,
        breakMinutes:30,reason:'勤怠・人件費サンプル'});
    }
  }
  return state;
}

export function createVisitAnalyticsDemo(now = Date.now()) {
  const minute = 60_000;
  let state = createDemo('closed',now);
  const date = state.day.date;
  const prior = new Date(Date.parse(date) - 86_400_000).toISOString().slice(0,10);
  const step = (command,at) => { state = apply(state,command,at,demoAdmin); };
  const sampleDays = [
    {date:prior,start:Date.parse(`${prior}T20:00:00+09:00`),stays:[55,35],close:true},
    {date,start:now - 175 * minute,stays:[75,45,null],close:false},
  ];
  for (const day of sampleDays) {
    let at = day.start;
    step({type:'open',date:day.date,openingCash:20_000},at);
    for (const [index,stay] of day.stays.entries()) {
      at += 5 * minute;
      step({type:'seat',tableIds:[`a${index + 1}`],guests:index === 0 ? 2 : 1,setId:'set60'},at);
      const {id:ticketId} = state.tickets.at(-1);
      const item = index === 0 ? {menuId:'nomination',quantity:1,castIds:['cast1']}
        : {menuId:'highball',quantity:1,castIds:[]};
      step({type:'order',ticketId,items:[item]},at + 4 * minute);
      step({type:'settle',ticketId,payments:[{method:'cash',amount:quote(state,ticketId).remaining}]},at + 25 * minute);
      at += (stay ?? 25) * minute;
      if (stay !== null) step({type:'depart',ticketId},at);
    }
    if (day.close) step({type:'close',actualCash:summary(state).expectedCash},at + 10 * minute);
  }
  return state;
}
