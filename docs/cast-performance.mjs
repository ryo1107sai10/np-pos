import { quote } from './engine.mjs';

const blank = () => ({sales:0,commission:0,points:0,nominations:0,drinkQuantity:0});
const settled = new Set(['paid','departed']);

function addCommission(total, commission, castId) {
  const row = commission?.find((entry) => entry.castId === castId);
  if (!row) return;
  total.sales += Number.isFinite(row.sales) ? row.sales : 0;
  total.commission += Number.isFinite(row.amount) ? row.amount : 0;
  total.points += Number.isFinite(row.points) ? row.points : 0;
}

function addLines(total, lines, castId) {
  for (const line of lines) {
    if (line.cancelledAt != null || !line.castIds.includes(castId)) continue;
    if (line.category === '指名') total.nominations += line.quantity;
    if (line.menuId === 'castDrink' || line.category?.includes?.('ドリンク')) {
      total.drinkQuantity += line.quantity / line.castIds.length;
    }
  }
}

function normalize(total) {
  return {...total,points:Math.round(total.points * 1_000) / 1_000,
    drinkQuantity:Math.round(total.drinkQuantity * 100) / 100};
}

export function getCastPerformance(state, castId, date) {
  const month = date.slice(0,7);
  const sales = new Map();
  const special = [];
  let incomplete = false;
  for (const record of state.closedDays) {
    if (!record.date.startsWith(month)) continue;
    const history = record.ticketSnapshots ?? [];
    for (const ticket of history) if (settled.has(ticket.status)) sales.set(ticket.id,ticket);
    if (history.length < (record.tickets ?? history.length)
        && !(record.date === state.day.date && state.tickets.filter(({status})=>settled.has(status)).length >= record.tickets)) {
      // The older summary already includes all tickets for its day.
      if (record.commission?.length) {
        for (const {id} of history) sales.delete(id);
        special.push(record.commission);
      }
      incomplete = true;
    }
  }
  const forecast = blank();
  if (state.day.date.startsWith(month)) for (const ticket of state.tickets) {
    if (settled.has(ticket.status)) sales.set(ticket.id,ticket);
    if (ticket.status === 'open') {
      if (ticket.lines.some((line)=>line.cancelledAt == null && line.castIds.includes(castId))) {
        addCommission(forecast,quote(state,ticket.id).commission,castId);
        addLines(forecast,ticket.lines,castId);
      }
    }
  }
  const confirmed = blank();
  for (const ticket of sales.values()) {
    const commission = ticket.settlement?.commission ?? quote({...state,tickets:[ticket]},ticket.id).commission;
    addCommission(confirmed,commission,castId);
    addLines(confirmed,ticket.lines,castId);
  }
  for (const commission of special) addCommission(confirmed,commission,castId);
  return {month,confirmed:normalize(confirmed),forecast:normalize(forecast),incomplete};
}
