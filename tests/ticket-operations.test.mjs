import assert from 'node:assert/strict';
import test from 'node:test';
import {getTicketAutoExtensionAt} from '../docs/auto-extension.mjs';
import {apply,createDemo,getLayoutAreas,getLayoutTables,getOverdueExtensionCount,quote,summary} from '../docs/engine.mjs';
import {getReportPeriod} from '../docs/report-period.mjs';
import {getTicketHistory} from '../docs/ticket-history.mjs';
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

test('headcount changes price only future extensions and preserve total historical visitors', () => {
  const initial = fixture();
  const [original] = initial.tickets;
  const change = (mode,count,reason = '卓の利用状況を確認') => ({type:'adjustTicketGuests',ticketId:original.id,mode,count,reason});
  assert.doesNotThrow(() => verifyCommand('manager',change('join',2)));
  assert.throws(() => verifyCommand('staff',change('join',2)),{code:'forbidden'});
  assert.throws(() => verifyCommand('manager',change('join',1.5)),{code:'invalid-command'});
  assert.throws(() => verifyCommand('manager',change('join',1,'')),{code:'reason-required'});
  assert.throws(() => apply(initial,change('join',1),now,staff),/権限/);
  assert.throws(() => apply(initial,change('join',3),now,manager),/定員/);
  assert.throws(() => apply(initial,change('leave',2),now,manager),/会計へ/);
  assert.throws(() => apply(initial,change('correct',2),now,manager),/異なる人数/);
  assert.throws(() => apply(initial,change('join',1,''),now,manager),/理由/);

  let state = apply(initial,change('correct',1,'  着席時の入力を訂正  '),now,manager);
  assert.deepEqual(state.auditLog[0].before,{guests:2,admittedGuests:2});
  assert.deepEqual(state.auditLog[0].after,{guests:1,admittedGuests:1,guestChangeMode:'correct'});
  assert.deepEqual(state.auditLog[0].actor,manager);
  assert.equal(state.auditLog[0].reason,'着席時の入力を訂正');
  state = apply(state,change('join',2),now + minute,manager);
  assert.deepEqual(quote(state,original.id),quote(initial,original.id));
  assert.deepEqual(state.tickets[0].lines,original.lines);
  state = apply(state,{type:'extend',ticketId:original.id,menuId:'extend30'},now + 2 * minute,staff);
  assert.equal(state.tickets[0].lines.at(-1).quantity,3);
  state = apply(state,change('leave',1),now + 3 * minute,manager);
  assert.equal(state.tickets[0].guests,2);
  assert.equal(state.tickets[0].admittedGuests,3);

  const deadline = getTicketAutoExtensionAt(state,state.tickets[0]);
  state = apply(state,{type:'syncAutoExtensions'},deadline,staff);
  assert.equal(state.tickets[0].lines.at(-1).quantity,2);
  assert.equal(state.tickets[0].lines.at(-1).autoExtension,true);
  assert.equal(state.tickets[0].lines[0].quantity,2);
  assert.equal(state.tickets[0].lines[1].quantity,3);
  assert.equal(validateSnapshot(state).tickets[0].admittedGuests,3);
  const invalid = structuredClone(state);
  invalid.tickets[0].admittedGuests = 1;
  assert.throws(() => validateSnapshot(invalid),{code:'invalid-snapshot'});

  const payment = quote(state,original.id).remaining;
  state = apply(state,{type:'settle',ticketId:original.id,payments:[{method:'cash',amount:payment}]},deadline + minute,staff);
  assert.equal(summary(state).guests,3);
  assert.throws(() => apply(state,change('join',1),deadline + minute,manager),/会計前/);
  state = apply(state,{type:'depart',ticketId:original.id},deadline + 2 * minute,staff);
  state = apply(state,{type:'close',actualCash:20_000 + payment},deadline + 3 * minute,manager);
  state = apply(state,{type:'open',date:'2026-11-17',openingCash:20_000},deadline + 4 * minute,manager);
  assert.equal(state.closedDays[0].ticketSnapshots[0].guests,2);
  assert.equal(getReportPeriod(state,{mode:'day',date}).totals.guests,3);
  assert.equal(getTicketHistory(state,{start:date,end:date}).rows[0].guests,3);
});

test('table history follows linked, moved and deleted tables across close without double-counting a visit', () => {
  let state = fixture();
  const [ticket] = state.tickets;
  const ticketId = ticket.id;
  state = apply(state,{type:'move',ticketId,tableIds:['a2','b1']},now - 10 * minute,staff);
  state = apply(state,{type:'move',ticketId,tableIds:['a2','a1']},now - 5 * minute,staff);
  const total = quote(state,ticketId).total;
  state = apply(state,{type:'settle',ticketId,payments:[{method:'cash',amount:total}]},now,staff);
  state = apply(state,{type:'depart',ticketId},now + minute,staff);
  state = apply(state,{type:'close',actualCash:20_000 + total},now + 2 * minute,manager);
  state = apply(state,{type:'saveLayout',areas:getLayoutAreas(state),
    tables:getLayoutTables(state).filter((table) => table.id !== 'b1')},now + 3 * minute);
  state = apply(state,{type:'open',date:'2026-11-17',openingCash:0},now + 4 * minute,manager);

  const filters = {start:date,end:date};
  for (const [tableId,time] of [['a1','20:30'],['a2','20:50'],['b1','20:50']]) {
    const result = getTicketHistory(state,{...filters,tableId});
    assert.equal(result.rows.length,1);
    assert.equal(result.rows[0].time,time);
    assert.equal(result.rows[0].guests,2);
    assert.match(result.rows[0].room,/B-01/);
    assert.equal(result.total,total);
  }
  assert.equal(getTicketHistory(state,{...filters,tableId:'a3'}).count,0);
  assert.equal(getTicketHistory(state,filters).rows[0].time,'21:00');
  assert.equal(state.archivedTables[0].id,'b1');
});

test('manual overdue extension confirms a rounded-up interval count and adds one set and nomination fee per interval', () => {
  let state = fixture();
  const [ticket] = state.tickets;
  const adjustment = {type:'adjustTicketGuests',ticketId:ticket.id,mode:'join',count:1,reason:'追加のご来店'};
  state = apply(state,adjustment,now,manager);
  state = apply(state,{type:'order',ticketId:ticket.id,items:[{menuId:'nomination',quantity:1,castIds:['cast1']}]},now,staff);
  state = apply(state,{type:'pauseVisitAutoExtension',ticketId:ticket.id,source:'manual'},now,staff);
  const current = [state.tickets[0],state.menu.find(({id}) => id === 'extend30')];
  assert.equal(getOverdueExtensionCount(...current,ticket.endsAt),0);
  assert.equal(getOverdueExtensionCount(...current,ticket.endsAt + 60 * minute),2);
  assert.equal(getOverdueExtensionCount(...current,ticket.endsAt + 60 * minute + 1),3);
  const action = {type:'extendOverdue',ticketId:ticket.id,menuId:'extend30',expectedCount:2};
  assert.doesNotThrow(() => verifyCommand('staff',action));
  assert.throws(() => verifyCommand('cast',action),{code:'forbidden'});
  assert.throws(() => verifyCommand('staff',{...action,expectedCount:101}),{code:'invalid-command'});
  assert.throws(() => apply(state,action,ticket.endsAt,staff),/終了時刻を過ぎた/);
  assert.throws(() => apply(state,action,ticket.endsAt + 61 * minute,staff),/開き直して/);
  assert.throws(() => apply(state,action,ticket.endsAt + 100 * 30 * minute + 1,staff),/100回まで/);
  const overdue = ticket.endsAt + 45 * minute;
  const extendedState = apply(state,action,overdue,staff);
  const [extended] = extendedState.tickets;
  assert.equal(extended.endsAt,ticket.endsAt + 60 * minute);
  assert.deepEqual(extended.lines.slice(-4).map(({menuId,quantity,createdAt,autoExtension}) =>
    [menuId,quantity,createdAt,autoExtension]), [
    ['extend30',3,overdue,undefined],['nominationExtra',1,overdue,undefined],
    ['extend30',3,overdue,undefined],['nominationExtra',1,overdue,undefined],
  ]);
  assert.equal(extended.autoExtensionPausedAt,now);
  assert.equal(quote(extendedState,ticket.id).subtotal - quote(state,ticket.id).subtotal,17_000);
  assert.equal(extendedState.auditLog[0].after.extensionCount,2);
  assert.equal(extendedState.auditLog[0].after.endsAt,extended.endsAt);
  assert.deepEqual(extendedState.auditLog[0].actor,staff);
  assert.throws(() => apply(extendedState,action,overdue,staff),/終了時刻を過ぎた/);
});
