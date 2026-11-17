import { encodeCsv } from './csv-file.mjs';
import { cashDenominations } from './register-cash.mjs';

const methods = [['cash','現金'], ['card','カード'], ['qr','QR決済']];
const columns = [
  '営業日', '店舗名', '営業状態', '税込売上', '会計組数', '会計客数', '客単価',
  ...methods.map(([,label]) => `${label}入金（前受金含む）`),
  ...methods.map(([,label]) => `${label}会計入金`),
  ...methods.map(([,label]) => `${label}前受金受取`),
  '前受金充当',
  'その他の現金入金', '現金出金（経費除く）', '現金経費', 'レジ理論残高', 'レジ実残高', '差額', '差額理由',
  '日払い支給（現金・出金に含む）', '日払い支給（振込）',
];

export function buildDailyReportCsv(period, storeName) {
  const rows = period.days.map(({date,current,closed,state}) => [
    date, storeName, closed ? '締め済み' : state.day.status === 'open' ? '営業中' : '開店前',
    current.sales, current.tickets, current.guests, current.guests ? Math.round(current.sales / current.guests) : '',
    ...methods.map(([method]) => current.payments[method]),
    ...methods.map(([method]) => current.tenderPayments?.[method]),
    ...methods.map(([method]) => current.depositsReceived?.[method]),
    current.depositsApplied,
    current.cashIn + (current.recoveries?.cash ?? 0), current.cashOut - current.expenses, current.expenses,
    current.expectedCash, closed?.actualCash, closed?.discrepancy, closed?.reason,
    current.dailyPayTotals?.cash ?? 0, current.dailyPayTotals?.bank ?? 0,
  ]);
  return encodeCsv([columns, ...rows]);
}

const registerColumns = ['営業日','店舗名','開店日時（日本時間）','閉店日時（日本時間）','釣銭準備金',
  'レジ理論残高','レジ実残高','差額','差額理由','金種の記録',...cashDenominations.map((value) => `${value}円の枚数`)];
const registerTime = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',
  day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

function registerTimestamp(timestamp) {
  return Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime()) ? registerTime.format(timestamp) : '';
}

export function buildRegisterCloseCsv(period, storeName) {
  const entries = period.days.flatMap(({closed}) => closed ? [closed] : []);
  return encodeCsv([registerColumns, ...entries.map((entry) => {
    const counts = entry.cashDenominations;
    return [entry.date,storeName,registerTimestamp(entry.openedAt),registerTimestamp(entry.closedAt),entry.openingCash,
      entry.expectedCash,entry.actualCash,entry.discrepancy,entry.reason,counts ? '記録あり' : '未記録',
      ...cashDenominations.map((value) => counts ? counts[value] ?? 0 : undefined)];
  })]);
}
