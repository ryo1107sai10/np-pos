import { getOperationsGuideTopic } from '../docs/practice-guide.mjs';
import { resultRow } from './db-queries.mjs';
import { requireCondition } from './policy.mjs';

const dailyLimit = 30;
const tokyoDay = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'});

export async function getGuideAccess(db, env, actor, storeId) {
  const member = await resultRow(db,'SELECT role FROM np_store_access WHERE store_id = ? AND uid = ?',storeId,actor.uid);
  requireCondition(member && member.role !== 'trainee',403,'store-access','この店舗へのアクセス権がありません。');
  const enabledStores = (env.OPENAI_GUIDE_STORE_IDS ?? '').split(',').map((id)=>id.trim());
  return {role:member.role,enabled:Boolean(env.OPENAI_API_KEY && env.OPENAI_GUIDE_MODEL && enabledStores.includes(storeId))};
}

export function guideTopicAllowed(topic,role) {
  if (!topic) return false;
  if (role === 'cast') return topic.page === 'cast-workspace';
  if (topic.page === 'cast-workspace') return false;
  if (topic.adminOnly || topic.page === 'payroll') return role === 'admin';
  return topic.page === 'floor' || topic.action === 'cloud-groups' || ['admin','manager'].includes(role);
}

export async function answerGuideTopic(db, env, storeId, access, topicId, {
  send = globalThis.fetch, now = Date.now(),
} = {}) {
  requireCondition(access.enabled,409,'guide-disabled','この店舗ではAI操作アシストを有効にしていません。');
  const topic = getOperationsGuideTopic(topicId);
  requireCondition(guideTopicAllowed(topic,access.role),400,'invalid-guide-topic','案内するテーマを選び直してください。');
  const day = tokyoDay.format(now);
  const usage = await resultRow(db,`INSERT INTO np_guide_usage (store_id, date, requests) VALUES (?, ?, 1)
    ON CONFLICT (store_id, date) DO UPDATE SET requests = requests + 1
      WHERE requests < ? RETURNING requests`,storeId,day,dailyLimit);
  requireCondition(usage,429,'guide-limit','この店舗の本日のAI操作アシストは上限に達しました。操作ガイドを参照してください。');
  const response = await send('https://api.openai.com/v1/responses', {
    method:'POST',
    headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
    signal:AbortSignal.timeout(10_000),
    body:JSON.stringify({
      model:env.OPENAI_GUIDE_MODEL,store:false,max_output_tokens:700,
      instructions:'NP POSの操作マニュアルを日本語で案内します。渡された見出しと手順だけを使い、画面名と作業順が分かる短い番号付きの手順に整えてください。記載のないボタンや機能、店の情報は補完せず、操作の実行も約束しないでください。Markdownの装飾は付けません。',
      input:`${topic.title}\n${topic.text}`,
    }),
  }).catch(()=>null);
  const payload = response?.ok ? await response.json().catch(()=>null) : null;
  const answer = payload?.output?.flatMap(({type,content})=>type === 'message' && Array.isArray(content) ? content : [])
    .filter(({type,text})=>type === 'output_text' && typeof text === 'string').map(({text})=>text).join('\n').trim();
  requireCondition(answer,502,'guide-unavailable','AI操作アシストに接続できませんでした。操作ガイドを参照してください。');
  return {answer:answer.slice(0,1800)};
}
