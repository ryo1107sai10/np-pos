import assert from 'node:assert/strict';
import test from 'node:test';
import {getTicketAutoExtensionAt} from '../docs/auto-extension.mjs';
import {apply,createDemo,quote} from '../docs/engine.mjs';
import {validateSnapshot,verifyCommand} from '../server/policy.mjs';

const date = '2026-11-16';
const now = Date.parse(`${date}T21:00:00+09:00`);
const minute = 60_000;
const manager = {id:'manager',label:'マネージャー',role:'manager'};
const staff = {id:'staff',label:'ホール',role:'staff'};

function fixture() {
  let state = apply(createDemo('closed',now),{type:'open',date,openingCash:20_000},now - 40 * minute);
  state = apply(state,{type:'saveAutoExtensionSettings',enabled:true,menuId:'extend30'},now - 35 * minute);
  return apply(state,{type:'seat',tableIds:['a1'],guests:2,setId:'set60'},now - 30 * minute);
}

test('staff can add and clear an open ticket memo with focused audit evidence', () => {
  const state = fixture();
  const [original] = state.tickets;
  const action = {type:'saveTicketNote',ticketId:original.id,note:'  お連れ様をお待ちです  '};
  assert.doesNotThrow(() => verifyCommand('staff',action));
  assert.throws(() => verifyCommand('cast',action),{code:'forbidden'});
  assert.throws(() => verifyCommand('staff',{...action,note:'あ'.repeat(401)}),{code:'invalid-command'});
  const noted = apply(state,action,now,staff);
  assert.equal(noted.tickets[0].note,'お連れ様をお待ちです');
  assert.deepEqual(noted.auditLog[0].actor,staff);
  assert.deepEqual(noted.auditLog[0].before,{note:null});
  assert.deepEqual(noted.auditLog[0].after,{note:'お連れ様をお待ちです'});
  assert.equal(validateSnapshot(noted).tickets[0].note,'お連れ様をお待ちです');
  const unchanged = apply(noted,action,now,staff);
  assert.deepEqual(unchanged.auditLog,noted.auditLog);
  const cleared = apply(noted,{...action,note:''},now,staff);
  assert.equal(cleared.tickets[0].note,undefined);
  assert.equal(cleared.auditLog[0].before.note,'お連れ様をお待ちです');
  assert.equal(cleared.auditLog[0].after.note,null);
  const settled = apply(noted,{type:'settle',ticketId:original.id,
    payments:[{method:'cash',amount:quote(noted,original.id).remaining}]},now);
  assert.throws(() => apply(settled,action,now,staff),/会計前/);
  assert.equal(settled.tickets[0].note,'お連れ様をお待ちです');
});

test('manager end-time adjustment preserves fees and rebases automatic extension without charging backwards', () => {
  const state = fixture();
  const [original] = state.tickets;
  const action = {type:'adjustTicketEnd',ticketId:original.id,minutes:-31,reason:'お客様のご希望'};
  assert.doesNotThrow(() => verifyCommand('manager',action));
  assert.throws(() => verifyCommand('staff',action),{code:'forbidden'});
  assert.throws(() => apply(state,action,now,staff),/権限/);
  assert.throws(() => apply(state,{...action,minutes:-61},now,manager),/来店時刻以降/);
  assert.throws(() => apply(state,{...action,reason:''},now,manager),/理由/);
  const shortened = apply(state,action,now,manager);
  const [ticket] = shortened.tickets;
  assert.equal(ticket.endsAt,now - minute);
  assert.equal(ticket.autoExtensionResumedAt,now);
  assert.equal(getTicketAutoExtensionAt(shortened,ticket),now + 30 * minute);
  assert.deepEqual(ticket.lines,original.lines);
  assert.deepEqual(quote(shortened,ticket.id),quote(state,ticket.id));
  assert.equal(shortened.auditLog[0].before.endsAt,original.endsAt);
  assert.equal(shortened.auditLog[0].after.endsAt,ticket.endsAt);
  assert.equal(shortened.auditLog[0].reason,action.reason);
  const beforeDue = apply(shortened,{type:'syncAutoExtensions'},now + 29 * minute);
  assert.equal(beforeDue.tickets[0].lines.length,original.lines.length);
  const extended = apply(beforeDue,{type:'syncAutoExtensions'},now + 30 * minute);
  assert.equal(extended.tickets[0].lines.length,original.lines.length + 1);
  assert.equal(extended.tickets[0].endsAt,now + 60 * minute);

  const paused = apply(state,{type:'pauseVisitAutoExtension',ticketId:original.id,source:'manual'},now,manager);
  const adjusted = apply(paused,{...action,minutes:30},now,manager);
  assert.equal(adjusted.tickets[0].endsAt,now + 60 * minute);
  assert.equal(getTicketAutoExtensionAt(adjusted,adjusted.tickets[0]),null);
});
