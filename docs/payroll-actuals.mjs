import { isPayrollActualValue, parsePayrollActualKey, payrollActualNames, payrollLineKey, payrollLineMetrics, PayrollFormulaError,
  usedPayrollActualKeys } from './payroll-formula.mjs';
import { getOrderCategories } from './store-settings.mjs';

function payrollActualCatalog(state,keys) {
  const menu = new Map(state.menu.map(({id,name}) => [id,name]));
  const categories = new Set(['セット','延長',...getOrderCategories(state)]);
  const referenced = keys.map(parsePayrollActualKey).filter(Boolean);
  const missing = new Set(referenced.filter(({kind,id}) => kind === 'menu' && !menu.has(id)).map(({id}) => id));
  if (missing.size) {
    for (const ticket of [...state.tickets,...state.closedDays.flatMap((day)=>day.ticketSnapshots ?? [])]) {
      for (const {menuId,name} of ticket.lines ?? []) {
        if (missing.delete(menuId)) menu.set(menuId,name);
      }
      if (!missing.size) break;
    }
    for (const id of missing) menu.set(id,`旧メニュー ${id}`);
  }
  for (const {kind,id} of referenced) if (kind === 'category') categories.add(id);
  return {menu,categories};
}

function actualLabel(catalog,key) {
  const parsed = parsePayrollActualKey(key);
  if (parsed.kind === 'summary') return payrollActualNames[parsed.id];
  const {kind,metric,id} = parsed;
  const name = kind === 'menu' ? catalog.menu.get(id) : id;
  return `${name} ／ ${payrollLineMetrics[metric]}`;
}

export function payrollActualOptionGroups(state,rules) {
  const catalog = payrollActualCatalog(state,usedPayrollActualKeys(rules));
  const choices = (kind,targets) => targets.flatMap((id) => Object.keys(payrollLineMetrics).flatMap((metric) => {
    const key = payrollLineKey(kind,metric,id);
    return parsePayrollActualKey(key) ? [[key,actualLabel(catalog,key)]] : [];
  }));
  return [
    ['営業・勤怠の実績',Object.entries(payrollActualNames)],
    ['商品別の会計済み実績',choices('menu',[...catalog.menu.keys()])],
    ['分類別の会計済み実績',choices('category',[...catalog.categories])],
  ];
}

function attendanceDays(state,month,castId,work) {
  const late = new Set();
  const absent = new Set();
  const noShow = new Set();
  for (const {castId:id,date,status,classification} of state.castAttendance ?? []) {
    if (id !== castId || !date.startsWith(month)) continue;
    if (status === 'approved' && classification === 'late') late.add(date);
    if (status === 'absent' && classification === 'absent') absent.add(date);
    if (status === 'absent' && classification === 'no-show') noShow.add(date);
  }
  return {workdays:work.filter(({minutes}) => minutes > 0).length,lateDays:late.size,absenceDays:absent.size,noShowDays:noShow.size};
}

function shareUnits(total,count,index) {
  return Math.floor(total / count) + Number(index < total % count);
}

function ticketValues(tickets,castId,entries,unavailableDates) {
  if (unavailableDates.length) {
    throw new PayrollFormulaError(`会計済みの実績データが不足しています（${unavailableDates.join('・')}）。`);
  }
  const personal = entries.some(({kind}) => kind === 'summary');
  const targets = entries.filter(({kind}) => kind !== 'summary');
  const amounts = Object.fromEntries(entries.map(({key}) => [key,0]));
  for (const ticket of tickets) {
    const {settlement,legacyDate,legacyTicketCount} = ticket;
    if (personal) {
      const entry = settlement.commission.find((row) => row.castId === castId);
      if (entry && !Number.isSafeInteger(entry.sales)) throw new PayrollFormulaError('会計済みの個人売上が保存されていない伝票があります。');
      amounts.personalSales += entry?.sales ?? 0;
    }
    if (!targets.length) continue;
    if (!Array.isArray(ticket.lines)) {
      if (legacyTicketCount === 0 && !settlement.commission.length) continue;
      throw new PayrollFormulaError(`商品・分類別の確定実績に必要な注文明細が不足しています${legacyDate ? `（${legacyDate}）` : ''}。`);
    }
    const details = new Map();
    for (const row of settlement.commissionDetails ?? []) {
      if (row.castId !== castId) continue;
      details.set(row.lineId,details.has(row.lineId) ? null : row);
    }
    for (const line of ticket.lines) {
      const index = line.castIds.indexOf(castId);
      if (line.cancelledAt != null || index < 0) continue;
      const detail = details.get(line.id);
      for (const {key,kind,metric,id} of targets) {
        if (id !== (kind === 'menu' ? line.menuId : line.category)) continue;
        const value = metric === 'quantity' ? shareUnits(line.quantity * 10_000,line.castIds.length,index)
          : metric === 'commission' ? detail?.amount : metric === 'points' ? Math.round(detail?.points * 1000) : detail?.sales;
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new PayrollFormulaError(`確定済みの「${line.name}」の${payrollLineMetrics[metric]}が確認できません。注文明細を確認してください。`);
        }
        amounts[key] += value;
      }
    }
  }
  for (const {key,metric} of targets) {
    if (metric === 'quantity') amounts[key] /= 10_000;
    if (metric === 'points') amounts[key] /= 1000;
  }
  return amounts;
}

export function getPayrollActualContext(state,{month,castId,work,tickets,unavailableDates,rules}) {
  const keys = usedPayrollActualKeys(rules);
  if (!keys.length) return {};
  const entries = keys.map((key) => ({key,...parsePayrollActualKey(key)}));
  const attendance = attendanceDays(state,month,castId,work);
  const sales = entries.filter(({key}) => !Object.hasOwn(attendance,key));
  const values = sales.length ? ticketValues(tickets,castId,sales,unavailableDates) : {};
  const catalog = payrollActualCatalog(state,keys);
  const actuals = Object.fromEntries(keys.map((key) => [key,attendance[key] ?? values[key]]));
  if (!Object.values(actuals).every(isPayrollActualValue)) throw new PayrollFormulaError('給与の実績値が計算できる範囲を超えています。');
  const actualLabels = Object.fromEntries(keys.map((key) => [key,actualLabel(catalog,key)]));
  return {actuals,actualLabels};
}
