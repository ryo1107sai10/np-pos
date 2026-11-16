export function renderSettledContents(ticket,draft,state,{escape,methodSelect}) {
  const lines = ticket.lines.filter((line)=>line.cancelledAt == null && line.category !== '延長');
  const line = lines.find(({id})=>id === draft.lineId);
  const cast = [...state.cast.filter((person) => person.enabled !== false || line?.castIds.includes(person.id)),
    ...(state.archivedCast ?? []).filter(({id}) => line?.castIds.includes(id))];
  const label = (text,input) => `<label class="field"><span>${text}</span>${input}</label>`;
  return `${label('訂正する明細',`<select name="settledContentLine"><option value="">値引きのみを訂正</option>
      ${lines.map(({id,name})=>`<option value="${escape(id)}"${line?.id === id ? ' selected' : ''}>${escape(name)}</option>`).join('')}</select>`)}
    ${line ? `<div class="form-grid">${label('数量',`<input name="correctedQuantity" type="number" min="1" max="100" value="${line.quantity}" required>`)}
      ${label('単価（円）',`<input name="correctedPrice" type="number" min="0" max="100000000" value="${line.price}" required>`)}</div>
      ${line.category !== 'セット' ? `<fieldset class="choices"><legend>歩合の対象</legend><div class="choice-grid">${cast.map(({id,name})=>
        `<label class="choice"><input name="correctedCast" type="checkbox" value="${escape(id)}"${line.castIds.includes(id) ? ' checked' : ''}>
          <span>${escape(name)}</span></label>`).join('')}</div></fieldset>
        <label class="inline-check"><input name="removeSettledLine" type="checkbox">この注文明細を取り消す</label>` : ''}
      ${line.stockUses?.length && line.providedAt == null ? '<label class="inline-check"><input type="checkbox" name="returnCorrectedStock">未提供分の在庫を戻す</label>' : ''}` : ''}
    ${label('訂正後の値引き（円）',`<input name="correctedDiscount" type="number" min="0" max="100000000" value="${draft.discount ?? ticket.discount}" required>`)}
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
