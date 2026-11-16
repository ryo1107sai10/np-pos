import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createDemo, quote, summary } from '../docs/engine.mjs';
import { getPracticeStatus, searchOperationsGuide } from '../docs/practice-guide.mjs';

test('practice tracks each real action and does not count the automatic set fee as an order', () => {
  const date = '2026-11-17';
  const at = Date.parse(date + 'T20:00:00+09:00');
  let state = createDemo('closed',at);
  const step = (action) => { state = apply(state,action,at); };
  assert.equal(getPracticeStatus(state).nextStep,0);
  step({type:'open',date,openingCash:20_000});
  assert.equal(getPracticeStatus(state).nextStep,1);
  step({type:'seat',tableIds:['a1'],guests:2,setId:'set60'});
  const [ticket] = state.tickets;
  assert.equal(getPracticeStatus(state).nextStep,2);
  step({type:'order',ticketId:ticket.id,items:[{menuId:'highball',quantity:1}]});
  assert.equal(getPracticeStatus(state).nextStep,3);
  step({type:'settle',ticketId:ticket.id,payments:[{method:'cash',amount:quote(state,ticket.id).total}]});
  assert.equal(getPracticeStatus(state).nextStep,4);
  step({type:'depart',ticketId:ticket.id});
  assert.equal(getPracticeStatus(state).nextStep,5);
  step({type:'close',actualCash:summary(state).expectedCash});
  const progress = getPracticeStatus(state);
  assert.equal(progress.completed,6);
  assert.equal(progress.nextStep,-1);
});

test('local guide recognizes ordinary Japanese questions and fullwidth accounting keywords', () => {
  assert.equal(searchOperationsGuide('レシートを印刷したい')[0].title,'会計・レシート・領収書');
  assert.equal(searchOperationsGuide('ＣＳＶ')[0].title,'閉店と日報を確認する');
  assert.deepEqual(searchOperationsGuide('検索結果のない文字列'),[]);
});
