import assert from 'node:assert/strict';
import test from 'node:test';
import { activeCastAssignments, splitCastRotation } from '../docs/cast-rotation.mjs';
import { renderCastRotationBoard, renderCastRotationHistory, renderCastRotationTicket } from '../docs/cast-rotation-ui.mjs';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { getStoreSettings } from '../docs/store-settings.mjs';
import { projectState, validateSnapshot, verifyCommand } from '../server/policy.mjs';

const at = Date.parse('2026-11-17T20:00:00+09:00');
const admin = {id:'owner',label:'管理者',role:'admin'};
const staff = {id:'staff',label:'スタッフ',role:'staff'};
const api = {escape:String,button:(label)=>`<button>${label}</button>`,ticketLabel:(ticket)=>ticket.tableIds.join('・')};

function hall() {
  let state = apply(createDemo('closed',at),{type:'open',date:'2026-11-17',openingCash:0},at,admin);
  for (const tableId of ['a1','a2']) {
    state = apply(state,{type:'seat',tableIds:[tableId],setId:'set60',guests:2},at,staff);
  }
  return state;
}

function rotate(state,ticket,mode,fields,seconds = 1,operator = staff) {
  const action = {type:'changeCastRotation',ticketId:ticket.id,mode,...fields};
  verifyCommand(operator.role,action,state,operator.profileId);
  return apply(state,action,at + seconds * 1_000,operator);
}

test('wait order, swap and explicit transfer enforce one active visit per cast and preserve sales', () => {
  let state = hall();
  const [a,b] = state.tickets;
  const initial = quote(state,a.id);
  for (const [index,castId] of ['cast1','cast2','cast3'].entries()) state = rotate(state,a,'enqueue',{castId},index + 1);
  const [one,two,three] = splitCastRotation(state.tickets[0]).waiting;
  assert.throws(()=>rotate(state,a,'enqueue',{castId:'cast2'}),/同じ伝票/);
  state = rotate(state,a,'start',{assignmentId:one.id},4);
  state = rotate(state,a,'next',{assignmentId:three.id},5);
  assert.deepEqual(state.auditLog[0].after.waitingOrder,[three.castName,two.castName]);
  assert.throws(()=>rotate(state,a,'swap',{assignmentId:one.id,nextId:two.id},6),/待機順/);
  state = rotate(state,a,'swap',{assignmentId:one.id,nextId:three.id},6);
  assert.equal(splitCastRotation(state.tickets[0]).history[0].endReason,'swapped');
  assert.equal(activeCastAssignments(state).get('cast3').ticket.id,a.id);
  state = rotate(state,b,'enqueue',{castId:'cast3'},7);
  const [other] = splitCastRotation(state.tickets[1]).waiting;
  assert.throws(()=>rotate(state,b,'start',{assignmentId:other.id},8),/別の伝票/);
  assert.throws(()=>rotate(state,b,'start',{assignmentId:other.id,sourceId:one.id},8),/別の伝票/);
  assert.match(renderCastRotationTicket(state,state.tickets[1],api,at + 8_000).body,/移動して開始|a1で接客中/);
  state = rotate(state,b,'start',{assignmentId:other.id,sourceId:three.id},8);
  assert.equal(activeCastAssignments(state).get('cast3').ticket.id,b.id);
  const [moved] = splitCastRotation(state.tickets[0]).history;
  assert.equal(moved.endReason,'moved');
  assert.equal(moved.endedAt,activeCastAssignments(state).get('cast3').entry.startedAt);
  assert.equal(state.auditLog[0].after.length,2);
  assert.equal(state.auditLog[0].actor.id,staff.id);
  assert.deepEqual(quote(state,a.id),initial);
  assert.equal(state.movements.length,0);
  assert.doesNotThrow(()=>validateSnapshot(state));
});

test('assignments follow linked and moved tables, terminate at checkout, and persist in closed snapshots', () => {
  let state = hall();
  const [,ticket] = state.tickets;
  state = rotate(state,ticket,'enqueue',{castId:'cast1'},1);
  state = rotate(state,ticket,'enqueue',{castId:'cast2'},2);
  const [first] = splitCastRotation(state.tickets[1]).waiting;
  state = rotate(state,ticket,'start',{assignmentId:first.id},3);
  state = apply(state,{type:'move',ticketId:ticket.id,tableIds:['b1','b2']},at + 4_000,staff);
  assert.match(renderCastRotationBoard(state,api),/b1・b2/);
  assert.equal(activeCastAssignments(state).get('cast1').ticket.id,ticket.id);
  for (const visit of state.tickets) {
    state = apply(state,{type:'settle',ticketId:visit.id,payments:[{method:'cash',amount:quote(state,visit.id).remaining}]},at + 5_000,staff);
    state = apply(state,{type:'depart',ticketId:visit.id},at + 6_000,staff);
  }
  assert.equal(activeCastAssignments(state).size,0);
  assert.equal(splitCastRotation(state.tickets[1]).history.length,2);
  state = apply(state,{type:'close',actualCash:summary(state).expectedCash},at + 8_000,admin);
  const history = state.closedDays[0].ticketSnapshots.find(({id})=>id === ticket.id);
  assert.match(renderCastRotationHistory(history,api),/付け回しの履歴（2件）[\s\S]*会計/);
  assert.doesNotThrow(()=>validateSnapshot(state));
});

test('role policy, duty, catalog changes and snapshot validation block unsafe assignments', () => {
  let state = hall();
  const [a,b] = state.tickets;
  const command = {type:'changeCastRotation',ticketId:a.id,mode:'enqueue',castId:'cast1'};
  assert.throws(()=>verifyCommand('cast',command,state),{code:'forbidden'});
  assert.throws(()=>verifyCommand('staff',{...command,mode:'wrong'},state),{code:'invalid-command'});
  const restricted = {rolePolicy:{staff:{label:'スタッフ',disabled:['floor']}}};
  assert.throws(()=>verifyCommand('staff',command,{...state,...restricted}),{code:'forbidden'});
  const profileId = 'role-764b5ca6-ef6a-4323-9d2a-ce33289fda11';
  const custom = {rolePolicy:{custom:{[profileId]:{base:'staff',label:'卓担当',allowed:['seatGuests']}}}};
  assert.throws(()=>verifyCommand('staff',command,{...state,...custom},profileId),{code:'forbidden'});
  custom.rolePolicy.custom[profileId].allowed.push('castRotation');
  assert.doesNotThrow(()=>verifyCommand('staff',command,{...state,...custom},profileId));
  state = apply(state,command,at,staff);
  const [first] = state.tickets[0].castRotation;
  state = rotate(state,a,'start',{assignmentId:first.id},1);
  assert.equal(projectState({...state,...restricted},'staff',staff.id).tickets[0].castRotation,undefined);
  assert.equal(projectState(state,'staff',staff.id).tickets[0].castRotation.length,1);
  const removed = getStoreSettings(state);
  removed.cast = removed.cast.filter(({id})=>id !== 'cast1');
  assert.throws(()=>apply(state,{type:'saveStoreSettings',settings:removed,removeCastIds:['cast1']},at + 2_000,admin),/接客・待機を終了/);
  const settings = getStoreSettings(state);
  settings.cast.find(({id})=>id === 'cast1').enabled = false;
  state = apply(state,{type:'saveStoreSettings',settings},at + 2_000,admin);
  assert.equal(activeCastAssignments(state).size,0);
  assert.equal(splitCastRotation(state.tickets[0]).history[0].endReason,'unavailable');
  assert.throws(()=>rotate(state,a,'enqueue',{castId:'cast1'},3),/在籍キャスト/);
  state.controls = {...state.controls,castDutyMode:'attendance'};
  state = rotate(state,b,'enqueue',{castId:'cast2'},4);
  const [other] = state.tickets[1].castRotation;
  assert.throws(()=>rotate(state,b,'start',{assignmentId:other.id},5),/勤務条件/);
  const unsafe = structuredClone(state);
  unsafe.tickets[0].castRotation = [{...other,id:'rotation-unsafe',startedAt:other.queuedAt}];
  unsafe.tickets[1].castRotation[0].startedAt = other.queuedAt;
  assert.throws(()=>validateSnapshot(unsafe),{code:'invalid-snapshot'});
});
