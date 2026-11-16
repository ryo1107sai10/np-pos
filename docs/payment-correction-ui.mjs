import { getSettledTicketPaymentTotal } from './engine.mjs';
import { operationReason } from './operations-ui.mjs';

const methods = { cash: '現金', card: 'カード', qr: 'QR決済' };

export function paymentCorrectionModel(ticket) {
  const amounts = { cash: 0, card: 0, qr: 0 };
  let fixedAmount = 0;
  for (const { method, amount } of ticket.payments) {
    if (Object.hasOwn(amounts, method)) amounts[method] += amount;
    if (method === 'receivable') fixedAmount += amount;
  }
  return {
    amounts, fixedAmount, total:getSettledTicketPaymentTotal(ticket) - fixedAmount,
    cardFee:ticket.settlement?.cardFee ?? 0,
  };
}

export function renderPaymentCorrection(model, { yen }) {
  const fields = Object.entries(methods).map(([method,label]) =>
    `<label class="field"><span>${label}（円）</span><input name="correction-${method}" type="number" inputmode="numeric" step="1"
      min="0" max="${model.total}" value="${model.amounts[method]}" required></label>`).join('');
  return `<div class="payment-correction">
    <p class="form-copy">会計時に記録した受取額の内訳を訂正します。会計合計と前受金はそのままです。</p>
    ${model.cardFee && !model.fixedAmount ? `<p class="field-help">会計時のカード加算 ${yen(model.cardFee)} を含めた金額を入力してください。</p>` : ''}
    <div class="result-bar"><span>会計時の受取額</span><strong>${yen(model.total)}</strong></div>
    <div class="form-grid">${fields}</div>
    <div id="correction-payment-difference" class="result-bar" aria-live="polite"><span>入力した合計との差</span><strong></strong></div>
    <p id="correction-cash-impact" class="field-help" aria-live="polite"></p>
    ${operationReason({title:'訂正理由'})}
  </div>`;
}

export function readPaymentCorrection(form, model) {
  const amounts = Object.keys(methods).map((method) => {
    const field = form.elements.namedItem(`correction-${method}`);
    return { method, amount:field.valueAsNumber, valid:field.validity.valid };
  });
  const valid = amounts.every(({amount,valid}) => valid && Number.isSafeInteger(amount) && amount >= 0);
  const difference = valid ? model.total - amounts.reduce((total,{amount}) => total + amount,0) : null;
  const changed = amounts.some(({method,amount}) => model.amounts[method] !== amount);
  const payments = amounts.filter(({amount}) => amount > 0).map(({method,amount}) => ({method,amount}));
  if (model.fixedAmount > 0) payments.push({ method:'receivable', amount:model.fixedAmount });
  return { amounts, difference, changed, payments };
}

export function updatePaymentCorrection(form, model, yen) {
  const {amounts,difference,changed} = readPaymentCorrection(form,model);
  const cash = amounts.find(({method}) => method === 'cash').amount;
  const differenceRow = form.querySelector('#correction-payment-difference');
  differenceRow.classList.toggle('result-warn',difference !== 0);
  differenceRow.querySelector('strong').textContent = difference === null ? '金額を確認' : yen(Math.abs(difference));
  const delta = cash - model.amounts.cash;
  form.querySelector('#correction-cash-impact').textContent = Number.isSafeInteger(delta)
    ? `レジ理論残高の増減 ${delta > 0 ? '+' : delta < 0 ? '−' : ''}${yen(Math.abs(delta))}` : '';
  const reason = form.elements.namedItem('reason').value.trim();
  form.querySelector('#submit-dialog').disabled = difference !== 0 || !changed || !reason;
}
