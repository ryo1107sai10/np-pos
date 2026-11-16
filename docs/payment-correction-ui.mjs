import { findCustomer } from './customers.mjs';
import { getSettledTicketPaymentTotal } from './engine.mjs';
import { operationReason } from './operations-ui.mjs';
import { getCustomerReceivableBalance, getReceivableBalance } from './receivables.mjs';

const methods = { cash: '現金', card: 'カード', qr: 'QR決済', receivable: '売掛' };

export function paymentCorrectionModel(state, { ticket, date }, today) {
  const amounts = { cash: 0, card: 0, qr: 0, receivable: 0 };
  for (const { method, amount } of ticket.payments) amounts[method] += amount;
  const customer = findCustomer(state,ticket.customerId);
  const loan = state.receivables?.find((entry) => entry.ticketId === ticket.id && entry.cancelledAt == null);
  const balance = loan ? getReceivableBalance(loan) : 0;
  const defaultDueDate = new Date(Date.parse(date) + 7 * 86_400_000).toISOString().slice(0,10);
  return {
    amounts, date, dueDate:loan?.dueDate ?? (today > defaultDueDate ? today : defaultDueDate),
    hasLoan:Boolean(loan), canAddCredit:customer?.creditEnabled === true,
    canEnterCredit:Boolean(loan || amounts.receivable || customer?.creditEnabled),
    creditLimit:customer?.creditLimit ?? 0,
    otherBalance:customer ? getCustomerReceivableBalance(state,customer.id) - balance : 0,
    collected:loan ? loan.amount - balance : 0,
    total:getSettledTicketPaymentTotal(ticket),
    cardFee:ticket.settlement?.cardFee ?? 0,
  };
}

export function renderPaymentCorrection(model, { escape, yen }) {
  const fields = Object.entries(methods).map(([method,label]) => {
    const disabled = method === 'receivable' && !model.canEnterCredit;
    const max = method === 'receivable' && !model.canAddCredit ? model.amounts.receivable : model.total;
    return `<label class="field"><span>${label}（円）</span><input name="correction-${method}" type="number" inputmode="numeric" step="1"
      min="${method === 'receivable' ? model.collected : 0}" max="${max}" value="${model.amounts[method]}"${disabled ? ' disabled' : ' required'}></label>`;
  }).join('');
  const creditDue = model.hasLoan ? `<p class="field-help">売掛の支払期日 ${escape(model.dueDate)}</p>`
    : model.canEnterCredit ? `<label class="field" id="correction-credit-date" hidden><span>売掛の支払期日</span>
      <input type="date" name="creditDueDate" min="${escape(model.date)}" value="${escape(model.dueDate)}" disabled></label>` : '';
  return `<div class="payment-correction">
    <p class="form-copy">会計時に記録した支払内訳を訂正します。会計合計と前受金はそのままです。</p>
    ${model.cardFee ? `<p class="field-help">会計時のカード加算 ${yen(model.cardFee)} を含めた金額を入力してください。</p>` : ''}
    <div class="result-bar"><span>支払内訳の合計</span><strong>${yen(model.total)}</strong></div>
    <div class="form-grid">${fields}</div>
    ${!model.canEnterCredit ? '<p class="field-help">売掛の記録には、売掛利用を許可した顧客の登録が必要です。</p>'
      : model.hasLoan && !model.canAddCredit ? '<p class="field-help">この顧客の売掛利用は停止中です。既存の売掛額まで入力できます。</p>' : ''}
    ${model.collected ? `<p class="field-help">売掛はすでに ${yen(model.collected)} 回収しています。訂正後もこの金額以上の売掛が必要です。</p>` : ''}
    ${creditDue}
    <p id="correction-credit-limit" class="ops-highlight" hidden>訂正後の売掛残高が与信上限を超えます。訂正理由に承認の根拠を記録してください。</p>
    <div id="correction-payment-difference" class="result-bar" aria-live="polite"><span>入力した合計との差</span><strong></strong></div>
    <p id="correction-cash-impact" class="field-help" aria-live="polite"></p>
    ${operationReason({title:'訂正理由'})}
  </div>`;
}

export function readPaymentCorrection(form, model) {
  const amounts = Object.keys(methods).map((method) => {
    const field = form.elements.namedItem(`correction-${method}`);
    return { method, amount:field.disabled ? 0 : field.valueAsNumber, valid:field.validity.valid };
  });
  const valid = amounts.every(({amount,valid}) => valid && Number.isSafeInteger(amount) && amount >= 0);
  const difference = valid ? model.total - amounts.reduce((total,{amount}) => total + amount,0) : null;
  const changed = amounts.some(({method,amount}) => model.amounts[method] !== amount);
  return { amounts, difference, changed,
    payments:amounts.filter(({amount}) => amount > 0).map(({method,amount}) => ({method,amount})) };
}

export function updatePaymentCorrection(form, model, yen) {
  const {amounts,difference,changed} = readPaymentCorrection(form,model);
  const cash = amounts.find(({method}) => method === 'cash').amount;
  const credit = amounts.find(({method}) => method === 'receivable').amount;
  const date = form.elements.namedItem('creditDueDate');
  if (date) {
    date.disabled = !(credit > 0);
    date.required = !date.disabled;
    date.closest('label').hidden = date.disabled;
  }
  const exceedsLimit = credit > model.amounts.receivable && model.otherBalance + credit - model.collected > model.creditLimit;
  form.querySelector('#correction-credit-limit').hidden = !exceedsLimit;
  const differenceRow = form.querySelector('#correction-payment-difference');
  differenceRow.classList.toggle('result-warn',difference !== 0);
  differenceRow.querySelector('strong').textContent = difference === null ? '金額を確認' : yen(Math.abs(difference));
  const delta = cash - model.amounts.cash;
  form.querySelector('#correction-cash-impact').textContent = Number.isSafeInteger(delta)
    ? `レジ理論残高の増減 ${delta > 0 ? '+' : delta < 0 ? '−' : ''}${yen(Math.abs(delta))}` : '';
  const reason = form.elements.namedItem('reason').value.trim();
  form.querySelector('#submit-dialog').disabled = difference !== 0 || !changed || !reason || Boolean(date && !date.validity.valid);
}
