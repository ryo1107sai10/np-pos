import { getOrderLineDiscountAmount } from './order-line-discount.mjs';
import { getAssignableCast, getCastDutyMode } from './cast-duty.mjs';

export function renderSettledContents(ticket,draft,state,{escape,methodSelect}) {
  const lines = ticket.lines.filter((line)=>line.cancelledAt == null);
  const line = lines.find(({id})=>id === draft.lineId);
  const cast = line ? getAssignableCast(state,line.createdAt,line.castIds) : [];
  const dutyLimited = getCastDutyMode(state) !== 'all';
  const label = (text,input) => `<label class="field"><span>${text}</span>${input}</label>`;
  return `${label('訂正する明細',`<select name="settledContentLine"><option value="">伝票値引きのみを訂正</option>
      ${lines.map(({id,name})=>`<option value="${escape(id)}"${line?.id === id ? ' selected' : ''}>${escape(name)}</option>`).join('')}</select>`)}
    ${line ? `<div class="form-grid">${label('数量',`<input name="correctedQuantity" type="number" min="1" max="100" value="${line.quantity}" required>`)}
      ${label('単価（円）',`<input name="correctedPrice" type="number" min="0" max="100000000" value="${line.price}" required>`)}</div>
      ${line.category !== 'セット' ? `<fieldset class="choices"><legend>歩合の対象</legend><div class="choice-grid">${cast.map(({id,name})=>
        `<label class="choice"><input name="correctedCast" type="checkbox" value="${escape(id)}"${line.castIds.includes(id) ? ' checked' : ''}>
          <span>${escape(name)}</span></label>`).join('')}</div>${dutyLimited
    ? '<p class="field-help">担当を追加する場合は、注文した時刻の勤務条件を確認します。</p>' : ''}</fieldset>
        <label class="inline-check"><input name="removeSettledLine" type="checkbox">${line.category === '延長' && line.menuId !== 'nominationExtra'
          ? 'この延長と同時に登録した延長プラン・延長指名料を取り消す' : 'この注文明細を取り消す'}</label>` : ''}
      ${((line.stockUses?.length && line.providedAt == null) || line.category === '延長') ? '<label class="inline-check"><input type="checkbox" name="returnCorrectedStock">未提供分の在庫を戻す</label>' : ''}
      ${line.lineDiscount ? `<p class="field-help">明細値引きの条件を引き継ぎます。訂正前の値引き額は ${getOrderLineDiscountAmount(line).toLocaleString('ja-JP')}円です。</p>` : ''}` : ''}
    ${label('訂正後の伝票値引き（円）',`<input name="correctedDiscount" type="number" min="0" max="100000000" value="${draft.discount ?? ticket.discount}" required>`)}
    ${label('差額を処理した決済方法',methodSelect('adjustmentMethod',draft.adjustmentMethod ?? ticket.payments[0]?.method))}
    <div class="result-bar" data-settled-preview aria-live="polite"></div>
    ${label('訂正理由',`<textarea name="reason" maxlength="120" rows="2" required>${escape(draft.reason ?? '')}</textarea>`)}
    <p class="field-help">追加のお支払い・返金を受け付けた決済方法で処理してから記録してください。会計時の決済加算は引き継ぎます。</p>`;
}

export function readSettledContents(form,draft) {
  const values = new FormData(form);
  return {ticketId:draft.ticketId,lineId:draft.lineId ?? '',discount:Number(values.get('correctedDiscount')),
    adjustmentMethod:values.get('adjustmentMethod'),reason:values.get('reason'),
    ...(draft.lineId && {quantity:Number(values.get('correctedQuantity')),price:Number(values.get('correctedPrice')),
      castIds:values.getAll('correctedCast'),cancelLine:values.has('removeSettledLine'),returnStock:values.has('returnCorrectedStock')})};
}
