import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createDemo } from '../docs/engine.mjs';
import { normalizeRolePolicy, roleAllowsAction, roleAllowsPage, roleLabel } from '../docs/role-policy.mjs';
import { projectState, validateSnapshot, verifyCommand } from '../server/policy.mjs';

const date = '2026-11-17';
const now = Date.parse(date + 'T21:00:00+09:00');
const admin = {id:'owner',role:'admin',label:'店舗管理者'};
const manager = {id:'manager',role:'manager',label:'元マネージャー'};
const staff = {id:'staff',role:'staff',label:'元スタッフ'};

test('a store can rename and limit operational roles and audit the change', () => {
  const original = createDemo('closed',now);
  const policy = {
    manager:{label:'  締め担当  ',disabled:['orders','staffing']},
    staff:{label:'注文担当',disabled:['checkout','floor','customers']},
  };
  const command = {type:'saveRolePolicy',policy};
  assert.throws(() => verifyCommand('manager',command,original),{code:'forbidden'});
  assert.throws(() => apply(original,command,now,manager),/店舗管理者/);
  verifyCommand('admin',command,original);
  const state = apply(original,command,now,admin);
  assert.equal(roleLabel(state,'manager'),'締め担当');
  assert.equal(roleLabel(state,'staff'),'注文担当');
  assert.equal(roleAllowsAction(state,'staff','settle'),false);
  assert.equal(roleAllowsAction(state,'staff','order-line-stage'),true);
  assert.equal(roleAllowsPage(state,'manager','attendance'),false);
  assert.equal(state.auditLog[0].actor.id,admin.id);
  assert.deepEqual(validateSnapshot(state).rolePolicy,normalizeRolePolicy(policy));
  assert.throws(() => normalizeRolePolicy({admin:{label:'admin',disabled:[]}}),/役職設定/);
  assert.throws(() => normalizeRolePolicy({staff:{label:'worker',disabled:['staffing']}}),/操作/);
});

test('command and projection filtering protects history, cash, staff and customer data', () => {
  let state = apply(createDemo('closed',now),{type:'open',date,openingCash:12000},now,admin);
  state = apply(state,{type:'saveCustomer',customer:{name:'営業用顧客',phone:'09012345678'}},now,manager);
  const customer = state.customers.find(({name}) => name === '営業用顧客');
  state = apply(state,{type:'seat',customerId:customer.id,tableIds:['a1'],setId:'set60',guests:1},now,manager);
  const ticketId = state.tickets.at(-1).id;
  state = apply(state,{type:'recordCashMovement',kind:'expense',category:'supplies',amount:100,reason:'文具'},now,manager);
  state = apply(state,{type:'saveRolePolicy',policy:{manager:{label:'営業担当',
    disabled:['reports','inventory','printing','customers','staffing']}}},now,admin);
  const cash = {type:'recordCashMovement',kind:'expense',category:'supplies',amount:100,reason:'文具'};
  assert.throws(() => verifyCommand('manager',cash,state),{code:'forbidden'});
  assert.throws(() => apply(state,{type:'seat',tableIds:['a2'],guests:1,setId:'set60',customerId:customer.id},now,manager),/許可/);
  verifyCommand('manager',{type:'seat',tableIds:['a2'],guests:1,setId:'set60'},state);
  const projected = projectState(state,'manager',manager.id);
  assert.equal(projected.day.openingCash,0);
  assert.equal(projected.cashMovements,undefined);
  assert.equal(projected.printDocuments,undefined);
  assert.equal(projected.shifts,undefined);
  assert.deepEqual(projected.stock,[]);
  assert.equal(projected.customers.length,0);
  assert.equal(projected.tickets.find(({id})=>id===ticketId).customerId,undefined);
  assert.notEqual(projectState(state,'admin',admin.id).customers[0].name,undefined);
  assert.throws(() => verifyCommand('staff',{type:'saveStoreSettings'},state),{code:'forbidden'});
  assert.equal(projectState(state,'staff',staff.id).day.openingCash,0);
});

test('custom roles split order, checkout and read-only staffing permissions', () => {
  const id = 'role-0bb13d6c-bcbf-4de9-8ccf-d57189978e1a';
  const make = (base,allowed) => ({custom:{[id]:{label:'卓担当',base,allowed}}});
  assert.throws(() => normalizeRolePolicy(make('admin',['addOrders'])),/操作/);
  assert.throws(() => normalizeRolePolicy(make('staff',['discounts'])),/操作/);
  assert.throws(() => normalizeRolePolicy(make('manager',['approveDiscount'])),/操作/);
  const state = apply(createDemo('closed',now),{type:'saveRolePolicy',policy:make('manager',['addOrders','staffing'])},now,admin);
  assert.equal(roleLabel(state,'manager',id),'卓担当');
  assert.equal(roleAllowsPage(state,'manager','shifts',id),true);
  assert.equal(roleAllowsAction(state,'manager','shift-period',id),true);
  assert.equal(roleAllowsAction(state,'manager','shift-new',id),false);
  assert.equal(roleAllowsAction(state,'manager','order',id),true);
  assert.equal(roleAllowsAction(state,'manager','settle',id),false);
  const actor = {...manager,profileId:id};
  assert.throws(() => apply(state,{type:'open',openingCash:0},now,actor),/許可/);
  assert.throws(() => verifyCommand('manager',{type:'saveStaffAttendance'},state,id),{code:'forbidden'});
  assert.throws(() => verifyCommand('staff',{type:'order'},state,id),{code:'forbidden'});
});

test('a checkout-only custom role can record regular payment but cannot create customer credit', () => {
  const id = 'role-0bb13d6c-bcbf-4de9-8ccf-d57189978e1a';
  const policy = {custom:{[id]:{label:'会計担当',base:'manager',allowed:['takePayment']}}};
  const state = apply(createDemo('closed',now),{type:'saveRolePolicy',policy},now,admin);
  const cash = {type:'settle',ticketId:'ticket-1',payments:[{method:'cash',amount:1000}]};
  const credit = {...cash,payments:[{method:'receivable',amount:1000}],creditDueDate:date};
  verifyCommand('manager',cash,state,id);
  verifyCommand('manager',credit,state);
  assert.throws(()=>verifyCommand('manager',credit,state,id),{code:'forbidden'});
});
