const inputKeys = new Set(['hourlyPay','commission','pointPay','baseGross','minutes','points','number']);
const operators = new Set(['+','-','*','/']);
export const advancedPayrollBases = new Set(['formula','threshold','progressive']);
export class PayrollFormulaError extends Error {}

function check(condition, message) {
  if (!condition) throw new PayrollFormulaError(message);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000
    && Math.abs(Math.round(value * 10_000) - value * 10_000) < 0.01;
}

function validateKey(key,index) {
  if (inputKeys.has(key)) return true;
  if (typeof key !== 'string') return false;
  if (/^var:[A-Za-z0-9-]{1,128}$/.test(key)) return true;
  return /^item:\d{1,2}$/.test(key) && Number(key.slice(5)) < index;
}

export function normalizeAdvancedPayrollRule(row,index) {
  const {basis,left,right,operator} = row;
  const numeric = (key)=> {
    const value = row[key];
    check(isNumber(value), '給与の計算式に有効な数字を入力してください。');
    return value;
  };
  check(validateKey(left,index),'給与の計算項目は前に並ぶ項目だけを参照できます。');
  const leftValue = left === 'number' ? numeric('leftValue') : 0;
  if (basis === 'formula') {
    check(operators.has(operator) && validateKey(right,index),'演算と参照項目を選択してください。');
    const rightValue = right === 'number' ? numeric('rightValue') : 0;
    check(operator !== '/' || right !== 'number' || rightValue !== 0,'0で割る計算式は登録できません。');
    return {left,leftValue,operator,right,rightValue};
  }
  const threshold = numeric('threshold');
  return basis === 'threshold'
    ? {left,leftValue,threshold,below:numeric('below'),above:numeric('above')}
    : {left,leftValue,threshold,rate:numeric('rate')};
}

function operand(key, constant, previous, context) {
  if (key === 'number') return constant;
  if (key.startsWith('item:')) return previous[Number(key.slice(5))].amount;
  if (key.startsWith('var:')) {
    check(Object.hasOwn(context.variables,key.slice(4)),'給与の個人別変数を登録してください。');
    return context.variables[key.slice(4)];
  }
  return context[key];
}

function rationalCalculation(left,right,operator) {
  const scale = 10_000n;
  const a = BigInt(Math.round(left * Number(scale)));
  const b = BigInt(Math.round(right * Number(scale)));
  if (operator === '/') check(b !== 0n,'給与の計算式で0除算が発生しました。');
  const [top,bottom] = operator === '+' ? [a+b,scale] : operator === '-' ? [a-b,scale]
    : operator === '*' ? [a*b,scale*scale] : [a,b];
  const negative = (top < 0n) !== (bottom < 0n);
  const absTop = top < 0n ? -top : top;
  const absBottom = bottom < 0n ? -bottom : bottom;
  const value = Number((absTop * 2n + absBottom) / (absBottom * 2n)) * (negative ? -1 : 1);
  check(Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000_000,'給与の計算範囲を超えています。');
  return value === 0 ? 0 : value;
}

export function calculateAdvancedPayrollRule(rule, previous, context) {
  const a = operand(rule.left,rule.leftValue,previous,context);
  if (rule.basis === 'formula') return rationalCalculation(a,operand(rule.right,rule.rightValue,previous,context),rule.operator);
  if (rule.basis === 'threshold') return Math.round(a >= rule.threshold ? rule.above : rule.below);
  return rationalCalculation(Math.max(0,a - rule.threshold),rule.rate / 100,'*');
}

export function getPayrollVariables(state) {
  return state.payroll?.variables ?? [];
}

export function getPayrollVariableValues(state,castId) {
  return Object.fromEntries(getPayrollVariables(state).map(({id,defaultValue,overrides})=>
    [id,overrides.find((row)=>row.castId === castId)?.value ?? defaultValue]));
}

export function normalizePayrollVariables(state,rows) {
  check(Array.isArray(rows) && rows.length <= 30,'給与の個人別変数は30件以内で登録してください。');
  const castIds = new Set([...state.cast,...(state.archivedCast ?? [])].map(({id})=>id));
  const values = rows.map((row)=> {
    check(row && typeof row.id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(row.id)
      && typeof row.name === 'string' && row.name.trim() && row.name.trim().length <= 60 && isNumber(row.defaultValue)
      && Array.isArray(row.overrides),'個人別変数の名称と値を確認してください。');
    const overrides = row.overrides.map((entry)=> {
      check(entry && castIds.has(entry.castId) && isNumber(entry.value),'個人別変数の割り当てを確認してください。');
      return {castId:entry.castId,value:entry.value};
    });
    check(new Set(overrides.map(({castId})=>castId)).size === overrides.length,'個人別変数の割り当てが重複しています。');
    return {id:row.id,name:row.name.trim(),defaultValue:row.defaultValue,overrides};
  });
  check(new Set(values.map(({id})=>id)).size === values.length && new Set(values.map(({name})=>name)).size === values.length,
    '個人別変数の名称が重複しています。');
  return values;
}

export function ensurePayrollVariableReferences(rules,variables) {
  const keys = new Set(variables.map(({id})=>`var:${id}`));
  const operands = rules.flatMap(({left,right})=>[left,right]);
  check(operands.every((key)=>!key?.startsWith('var:') || keys.has(key)), '計算項目で使用している個人別変数を削除できません。');
}

export function savePayrollVariables(state,action,allocateId) {
  const {castId,variables} = action;
  check(castId == null || [...state.cast,...(state.archivedCast ?? [])].some(({id})=>id===castId),'キャストを選択してください。');
  check(Array.isArray(variables),'個人別変数を確認してください。');
  const existing = new Map(getPayrollVariables(state).map((row)=>[row.id,row]));
  const rows = normalizePayrollVariables(state,variables.map((row)=> {
    check(row && (row.id == null || existing.has(row.id)),'変更する個人別変数を確認してください。');
    const overrides = (existing.get(row.id)?.overrides ?? []).filter((entry)=>entry.castId !== castId);
    if (castId && row.value != null) overrides.push({castId,value:row.value});
    return {id:row.id ?? allocateId('pay-variable'),name:row.name,defaultValue:row.defaultValue,overrides};
  }));
  for (const rules of [state.payroll.settings.statementRules ?? [],...(state.payroll.templates ?? []).map((row)=>row.rules)]) {
    ensurePayrollVariableReferences(rules,rows);
  }
  state.payroll.variables = rows;
}

export function normalizeFormulaContext(state) {
  check(state && typeof state.variables === 'object' && state.variables && !Array.isArray(state.variables)
    && Object.entries(state.variables).every(([key,value])=>/^[A-Za-z0-9-]{1,128}$/.test(key) && isNumber(value)),
  '確定済みの給与計算値を確認してください。');
  return {variables:Object.fromEntries(Object.entries(state.variables))};
}
