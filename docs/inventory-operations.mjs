const precision = 1_000_000;
const precise = (value) => Math.round(value * precision) / precision;
const roundedNumber = (value) => Number.isFinite(value) ? precise(value) : 0;

export function purchaseCancellationBlocker(state, purchase) {
  if (purchase?.kind !== 'purchase') return '取り消す入庫記録を選んでください。';
  const stock = state.stock.find(({id}) => id === purchase.stockId);
  if (!stock) return '在庫品目が見つかりません。';
  const itemHistory = state.movements.filter(({stockId}) => stockId === purchase.stockId);
  if (itemHistory.some(({reversesId}) => reversesId === purchase.id)) return 'この入庫は取り消し済みです。';
  const lastStocktake = itemHistory.findIndex(({kind}) => kind === 'stocktake');
  if (lastStocktake >= 0 && lastStocktake < itemHistory.indexOf(purchase)) return '前回棚卸より前の入庫は取り消せません。';
  if (stock.quantity < purchase.quantity) return 'この入庫数を取り消せる在庫がありません。';
  return '';
}

export function replayPurchaseCancellation(state, stock, purchase) {
  const blocker = purchaseCancellationBlocker(state,purchase);
  if (blocker) throw new Error(blocker);
  const history = state.movements.filter(({stockId}) => stockId === stock.id);
  const checkpoint = history.findIndex(({kind}) => kind === 'stocktake');
  const entries = (checkpoint < 0 ? history : history.slice(0,checkpoint)).reverse();
  const cancelled = new Set(entries.map(({reversesId}) => reversesId).filter(Boolean));
  cancelled.add(purchase.id);
  const initialQuantity = precise(stock.quantity - entries.reduce((sum,{quantity}) => sum + quantity,0));
  const initialValue = precise(stock.value - entries.reduce((sum,{quantity,cost,valueChange}) =>
    sum + (Number.isFinite(valueChange) ? valueChange : Math.sign(quantity) * roundedNumber(cost)),0));

  let quantity = initialQuantity;
  let value = Math.max(0, initialValue);
  let unitCost = quantity > 0 ? precise(value / quantity) : stock.defaultUnitCost ?? stock.unitCost;
  const deductions = new Map();
  for (const entry of entries) {
    if (cancelled.has(entry.id) || entry.kind === 'purchaseCancellation') continue;
    const amount = entry.quantity;
    const currentPrice = amount < 0 ? unitCost
      : entry.kind === 'return' && deductions.has(entry.sourceLineId) ? deductions.get(entry.sourceLineId) : entry.unitCost ?? unitCost;
    if (entry.kind === 'order' && entry.sourceLineId) deductions.set(entry.sourceLineId,currentPrice);
    quantity = precise(quantity + amount);
    if (quantity < 0) throw new Error('取消後に在庫不足になるため、この入庫は取り消せません。');
    value = quantity === 0 ? 0 : precise(Math.max(0,value + amount * currentPrice));
    if (quantity > 0) unitCost = precise(value / quantity);
  }
  return {quantity,value,unitCost,valueChange:precise(value - stock.value)};
}

export function getInventoryCostSummary(movements, month, toBusinessDate) {
  let consumption = 0;
  let losses = 0;
  for (const movement of movements) {
    const {kind,cost,date,at} = movement;
    const businessDate = date ?? (Number.isFinite(at) ? toBusinessDate(at) : '');
    if (!businessDate.startsWith(month)) continue;
    if (kind === 'order' || kind === 'usage') consumption += roundedNumber(cost);
    if (kind === 'return') consumption -= roundedNumber(cost);
    if (kind === 'loss') losses += roundedNumber(cost);
  }
  return {consumption:precise(consumption),losses:precise(losses)};
}
