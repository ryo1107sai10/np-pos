import assert from 'node:assert/strict';
import test from 'node:test';
import { applyShiftCommand, confirmedShiftCastIds, listShifts, shiftPeriod, validateShiftsSnapshot } from '../docs/shifts.mjs';
import { readShiftForm } from '../docs/shifts-ui.mjs';

const monday = '2026-11-16';
const tuesday = '2026-11-17';
const state = () => ({cast:[{id:'a',name:'A'},{id:'b',name:'B',enabled:false}],archivedCast:[{id:'c',name:'C'}]});
const operator = { role:'manager' };
const register = (store, fields = {}, actor = operator) => applyShiftCommand(store,{
  type:'saveShift',castId:'a',date:monday,startMinute:1_200,endMinute:1_500,status:'requested',...fields,
},actor,Date.parse(monday),() => `shift-${(store.shifts ?? []).length + 1}`);

test('shift wishes can be confirmed, listed in period and removed by a manager',() => {
  const store = state();
  assert.doesNotThrow(() => validateShiftsSnapshot(store));
  register(store,{note:'  開店から  '});
  assert.equal(store.shifts[0].note,'開店から');
  assert.deepEqual([...confirmedShiftCastIds(store,monday)],[]);
  register(store,{shiftId:'shift-1',status:'confirmed'});
  assert.deepEqual([...confirmedShiftCastIds(store,monday)],['a']);
  assert.deepEqual(listShifts(store,shiftPeriod(tuesday,'week')).map(({id}) => id),['shift-1']);
  assert.equal(listShifts(store,shiftPeriod(tuesday,'day')).length,0);
  assert.doesNotThrow(() => validateShiftsSnapshot(store));
  applyShiftCommand(store,{type:'removeShift',shiftId:'shift-1'},operator,Date.parse(monday));
  assert.deepEqual(store.shifts,[]);
});

test('confirmation rejects overnight overlaps and allows an exact boundary',() => {
  const store = state();
  register(store,{status:'confirmed'});
  register(store,{date:tuesday,startMinute:30,endMinute:60});
  assert.throws(() => register(store,{date:tuesday,startMinute:30,endMinute:60,shiftId:'shift-2',status:'confirmed'}),/重な/);
  register(store,{date:tuesday,startMinute:60,endMinute:120,status:'confirmed'});
  assert.doesNotThrow(() => validateShiftsSnapshot(store));
  store.shifts[1].status = 'confirmed';
  assert.throws(() => validateShiftsSnapshot(store),/重複/);
  assert.throws(() => register(store,{castId:'b'}),/キャスト/);
  assert.throws(() => register(store,{castId:'c'}),/キャスト/);
  assert.throws(() => register(store,{},{role:'staff'}),/権限/);
  assert.throws(() => register(store,{date:'2026-11-31'}),/営業日/);
});

test('calendar boundaries and overnight form input are stable',() => {
  assert.deepEqual(shiftPeriod('2026-12-31','week'),{start:'2026-12-28',end:'2027-01-03',previous:'2026-12-21',next:'2027-01-04'});
  assert.deepEqual(shiftPeriod('2028-02-15','month'),{start:'2028-02-01',end:'2028-02-29',previous:'2028-01-01',next:'2028-03-01'});
  const form = new FormData();
  for (const [name,value] of Object.entries({shiftCastId:'a',shiftDate:monday,shiftStart:'20:00',shiftEnd:'01:00',shiftStatus:'requested'})) form.set(name,value);
  assert.throws(() => readShiftForm(form),/翌日/);
  form.set('shiftOvernight','on');
  assert.deepEqual(readShiftForm(form),{castId:'a',date:monday,startMinute:1_200,endMinute:1_500,status:'requested',note:''});
});
