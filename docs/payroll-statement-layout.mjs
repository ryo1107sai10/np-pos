export const payrollStatementLabels = Object.freeze({
  summary:'支給内訳', work:'勤務の内訳', commission:'確定歩合の内訳', allowances:'手当',
  deductions:'控除', rules:'計算テンプレートの内訳', attendance:'勤怠項目の内訳',
});

export const payrollStatementNote = '店舗で登録した手当・控除を記載しています。源泉徴収・社会保険料の自動計算は対象外です。';

export function defaultPayrollStatementLayout() {
  return Object.keys(payrollStatementLabels).map((key) => ({key,visible:true}));
}

export function normalizePayrollStatementLayout(value) {
  if (value == null) return undefined;
  const keys = Object.keys(payrollStatementLabels);
  if (!Array.isArray(value) || value.length !== keys.length || new Set(value.map((row) => row?.key)).size !== keys.length
    || Array.from(value).some((row) => !keys.includes(row?.key) || typeof row.visible !== 'boolean' || (row.key === 'summary' && !row.visible)
      || (row.columns !== undefined && ![1,2,3,4].includes(row.columns)))) {
    throw new Error('支給明細の表示項目と表示順を確認してください。');
  }
  return value.map(({key,visible,columns}) => ({key,visible,...(columns !== undefined && {columns})}));
}

export function payrollSummaryAmounts(pay) {
  return [['時給分',pay.hourlyPay],['確定歩合',pay.commission],['ポイント換金',pay.pointPay],
    ['手当合計',pay.allowanceTotal],['控除合計',-pay.deductionTotal],['日払い済み',-pay.advance]];
}

export function payrollWorkRows(work,yen) {
  return work.map(({date,minutes,hourlyRate,source}) => [
    `${date}   ${source === 'attendance' ? '勤怠' : '手入力'}`,
    `${Math.floor(minutes / 60)}時間 ${minutes % 60}分   ${yen(hourlyRate)}/時`,
  ]);
}

export function monthlyPayrollSections(pay,yen) {
  const money = ([label,amount]) => [label,yen(amount || 0)];
  const rowsByKey = {
    summary:payrollSummaryAmounts(pay).map(money),
    work:payrollWorkRows(pay.work,yen),
    commission:pay.commissionDetails.map(({name,amount}) => money([name,amount])),
    allowances:pay.allowances.map(({label,amount}) => money([label,amount])),
    deductions:pay.deductions.map(({label,amount}) => money([label,-amount])),
    rules:(pay.statementItems ?? []).filter(({kind}) => kind !== 'intermediate')
      .map(({label,amount,kind}) => money([label,kind === 'deduction' ? -amount : amount])),
    attendance:(pay.attendanceItems ?? []).map(({label,amount,kind}) => kind === 'points'
      ? [label,`${amount} pt`] : money([label,kind === 'deduction' ? -amount : amount])),
  };
  return (pay.settings?.statementLayout ?? defaultPayrollStatementLayout()).filter(({key,visible}) => visible && rowsByKey[key].length)
    .map(({key,columns}) => [payrollStatementLabels[key],rowsByKey[key],columns ?? 1]);
}
