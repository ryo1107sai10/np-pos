import { cashMovementCategoryLabel, cashMovementKinds } from './cash-ledger.mjs';
import { isVaultDailyPay } from './cash-accounts.mjs';
import { encodeCsv } from './csv-file.mjs';
import { getReportPeriod } from './report-period.mjs';

const movementClock = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',
  day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

function movementDateTime(at) {
  return Number.isFinite(at) && Number.isFinite(new Date(at).getTime()) ? movementClock.format(at) : '';
}

export function getCashReport(state, filters = {}) {
  const month = state.day.date.slice(0,7);
  const interval = {mode:'day',month,start:`${month}-01`,end:state.day.date,...filters};
  const period = getReportPeriod(state,interval);
  const ledger = period.days.slice().reverse().flatMap(({date,current}) => (current.cashMovements ?? [])
    .slice().sort((a,b) => (b.at ?? 0) - (a.at ?? 0)).map((item) => {
      const {kind,voidedAt} = item;
      const voided = voidedAt != null;
      const signedAmount = kind === 'deposit' ? item.amount : -item.amount;
      return {date,item,signedAmount,voided,postedAmount:voided || isVaultDailyPay(item) ? 0 : signedAmount,
        typeLabel:cashMovementKinds[kind] ?? '入出金',categoryLabel:cashMovementCategoryLabel(item),
        timestamp:movementDateTime(item.at),voidedTime:movementDateTime(voidedAt)};
    }));
  return {interval,period,ledger};
}

export function buildCashMovementCsv({ledger}, storeName) {
  const columns = ['営業日','店舗名','日時（日本時間）','種類','理由区分','記録額（円）','レジ反映額（円）','状態',
    '理由','相手先','担当者','連動','取消日時（日本時間）','取消理由'];
  const rows = ledger.map(({date,item,signedAmount,voided,postedAmount,typeLabel,categoryLabel,timestamp,voidedTime}) => [
    date,storeName,timestamp,typeLabel,categoryLabel,signedAmount,postedAmount,voided ? '取消済み' : '計上済み',
    item.reason,item.destination,item.actor?.label,item.stockPurchaseId ? '仕入れ入庫' : '',voidedTime,item.voidReason,
  ]);
  return encodeCsv([columns,...rows]);
}
