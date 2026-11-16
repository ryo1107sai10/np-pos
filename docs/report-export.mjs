import { encodeCsv } from './csv-file.mjs';

const methods = [['cash','現金'], ['card','カード'], ['qr','QR決済']];
const recoveryMethods = [['cash','現金'], ['card','カード'], ['bank','振込']];
const columns = [
  '営業日', '店舗名', '営業状態', '税込売上', '会計組数', '会計客数', '客単価',
  ...methods.map(([,label]) => `${label}入金（前受金含む）`),
  ...methods.map(([,label]) => `${label}会計入金`),
  ...methods.map(([,label]) => `${label}前受金受取`),
  '前受金充当', '売掛発生', ...recoveryMethods.map(([,label]) => `売掛回収（${label}）`),
  'その他の現金入金', '現金出金（経費除く）', '現金経費', 'レジ理論残高', 'レジ実残高', '差額', '差額理由',
];

export function buildDailyReportCsv(period, storeName) {
  const rows = period.days.map(({date,current,closed,state}) => [
    date, storeName, closed ? '締め済み' : state.day.status === 'open' ? '営業中' : '開店前',
    current.sales, current.tickets, current.guests, current.guests ? Math.round(current.sales / current.guests) : '',
    ...methods.map(([method]) => current.payments[method]),
    ...methods.map(([method]) => current.tenderPayments?.[method]),
    ...methods.map(([method]) => current.depositsReceived?.[method]),
    current.depositsApplied, current.receivableSales, ...recoveryMethods.map(([method]) => current.recoveries[method]),
    current.cashIn, current.cashOut - current.expenses, current.expenses,
    current.expectedCash, closed?.actualCash, closed?.discrepancy, closed?.reason,
  ]);
  return encodeCsv([columns, ...rows]);
}
