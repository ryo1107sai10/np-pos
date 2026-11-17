import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAutoExtensionNotices } from '../docs/auto-extension.mjs';
import { apply, createDemo, getTableLabel } from '../docs/engine.mjs';
import { createBillingDemo } from '../docs/phase-two-demo.mjs';
import { formatVisitEndCountdown, getVisitEndNotices, recordVisitEndAnnouncements,
  renderVisitEndNotices, visitEndNoticesKey } from '../docs/visit-end-notices.mjs';

const minute = 60_000;
const now = Date.parse('2026-11-16T21:00:00+09:00');

test('open visits enter the warning at ten minutes, retain an overdue status and group linked tables once', () => {
  const state = createDemo('live',now);
  const approaching = state.tickets.find((ticket) => ticket.tableIds.includes('a2'));
  const vip = state.tickets.find((ticket) => ticket.tableIds.includes('v1'));
  vip.endsAt = now + 3 * minute;
  assert.ok(!getVisitEndNotices(state,approaching.endsAt - 10 * minute - 1).some(({ticketId}) => ticketId === approaching.id));
  assert.ok(getVisitEndNotices(state,approaching.endsAt - 10 * minute).some(({ticketId}) => ticketId === approaching.id));
  assert.deepEqual(getVisitEndNotices(state,now).map(({tableIds,overdue}) => [tableIds,overdue]),[
    [['b1'],true], [['v1','v2'],false], [['a2'],false],
  ]);
  assert.deepEqual(getVisitEndNotices(createDemo('closed',now),now),[]);
  assert.equal(getVisitEndNotices(state,approaching.endsAt).find(({ticketId}) => ticketId === approaching.id).overdue,true);
});

test('auto-extension warning takes precedence at the same deadline and paused or disabled visits still show', () => {
  const sample = createBillingDemo(now);
  const a1 = sample.tickets.find((ticket) => ticket.tableIds.includes('a1'));
  const a2 = sample.tickets.find((ticket) => ticket.tableIds.includes('a2'));
  assert.deepEqual(getAutoExtensionNotices(sample,now).map(({ticketId}) => ticketId),[a1.id]);
  assert.deepEqual(getVisitEndNotices(sample,now,getAutoExtensionNotices(sample,now)).map(({ticketId}) => ticketId),[a2.id]);
  const paused = apply(sample,{type:'pauseVisitAutoExtension',ticketId:a1.id,source:'manual'},now);
  assert.deepEqual(getVisitEndNotices(paused,now,getAutoExtensionNotices(paused,now)).map(({ticketId}) => ticketId),[a1.id,a2.id]);
});

test('notices announce an ending time once and expose an accessible action with an accurate countdown', () => {
  const state = createDemo('live',now);
  const tableName = (id) => getTableLabel(state,id);
  const notices = getVisitEndNotices(state,now);
  const announced = new Map();
  assert.deepEqual(recordVisitEndAnnouncements(notices,announced,tableName),['A-02']);
  assert.deepEqual(recordVisitEndAnnouncements(notices,announced,tableName),[]);
  const shifted = notices.map((notice) => ({...notice,deadline:notice.deadline + minute}));
  assert.deepEqual(recordVisitEndAnnouncements(shifted,announced,tableName),['A-02']);
  assert.notEqual(visitEndNoticesKey(notices),visitEndNoticesKey(shifted));
  assert.equal(formatVisitEndCountdown(now + 501,now),'残り 00:01');
  assert.equal(formatVisitEndCountdown(now,now),'超過 00:00');
  assert.equal(formatVisitEndCountdown(now - 91_500,now),'超過 01:31');
  const html = renderVisitEndNotices(notices,now,{escape:String,icon:() => '',tableName});
  assert.match(html,/終了時刻のお知らせ <small>2組/);
  assert.match(html,/A-02<span class="sr-only">の伝票を開く/);
  assert.match(html,/data-visit-ends="\d+">残り 06:00/);
  assert.match(html,/visit-end-overdue" data-visit-ends="\d+">超過 03:00/);
});
