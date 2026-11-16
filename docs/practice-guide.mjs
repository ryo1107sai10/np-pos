const lessons = [
  {id:'seat',page:'floor',title:'開店して卓を選ぶ',keywords:'ホール 営業 釣銭 来店 座席 卓 移動 連結',text:'ホールの「開店する」で釣銭準備金を登録します。空席を選び、人数と初回セットを指定して来店を確定します。'},
  {id:'order',page:'floor',title:'注文・歩合を登録する',keywords:'カート 注文 商品 ボトル 指名 同伴 バック 歩合 キャスト',text:'利用中の伝票で「注文」を開きます。商品ごとに数量と担当キャストを選んでカートに追加し、注文をまとめて確定します。'},
  {id:'extension',page:'floor',title:'延長を登録する',keywords:'延長 自動 一括 時間 超過 セット 見積',text:'伝票の「延長」でプランと追加料金を確認します。終了時刻を過ぎた卓では、店舗設定に従って超過分の一括延長を選べます。'},
  {id:'receipt',page:'floor',title:'会計・レシート・領収書',keywords:'レシート 領収書 印刷 前受金 会計 現金 カード 釣銭 退店',text:'「会計へ進む」で支払方法と金額を確認します。確定後の会計内訳から印刷でき、「退店・卓を解放」で空席に戻ります。'},
  {id:'reports',page:'reports',title:'閉店と日報を確認する',keywords:'閉店 レジ 日報 金種 差額 CSV 仕訳 freee 経費 入出金',text:'伝票の会計と退店を済ませ、「閉店処理」でレジの実残高を登録します。日報の期間を指定して売上や締め結果を確認し、CSVを出力できます。'},
  {id:'stock',page:'stock',title:'入庫・廃棄・棚卸を記録する',keywords:'棚卸 在庫 入庫 仕入 廃棄 ロス 原価 ボトル 数量',text:'「在庫」で品目を選び、「調整」から仕入れ・廃棄・消費を記録します。「棚卸」には実際に数えた数量を入れます。'},
  {id:'customers',page:'customers',title:'顧客と来店履歴を確認する',keywords:'顧客 誕生日 指名 連絡先 ボトル キープ 写真 来店',text:'「顧客管理」で顧客を検索し、来店・指名履歴やキープボトルを確認できます。受付では登録済みの顧客を検索して伝票にひもづけます。'},
  {id:'my-pay',page:'cast-workspace',title:'打刻・勤務希望・支給明細',keywords:'出勤 退勤 打刻 休憩 シフト 給与 支給 明細 日払い 勤怠 通知',text:'キャストは「マイページ」で打刻・勤務希望・日払いを操作できます。給与が確定すると同じ画面にお知らせが表示され、「明細を確認」から開けます。'},
  {id:'payroll',page:'payroll',title:'給与・支給明細を管理する',keywords:'給与 計算 時給 支給 PDF ZIP 歩合 キャスト 管理者 手当 控除 日付 期間 締め',text:'店舗管理者は「給与・支給明細」で試算・確定ができます。任意期間で実績を集計し、給与月の確定明細を個人別PDFのZIPで保存できます。'},
  {id:'companion',page:'tickets',adminOnly:true,title:'会計後に同席者を訂正する',keywords:'会計 済み 過去 履歴 同席 代表 同伴 訂正 解除 理由 修正',text:'「伝票履歴」で会計済み伝票を開き、「同席者を訂正」を選びます。理由を入力して同席者を追加・解除すると、対象の来店履歴と監査ログに反映されます。'},
  {id:'prepayments',page:'floor',title:'前受金に決済手数料を適用する',keywords:'前受 預り 入金 ブランド 手数料 カード QR 税 タックス 差額',text:'利用中の伝票で「前受金」を開き、会計に充当する額と支払方法を入力します。決済ブランドを選ぶと、設定済みの手数料とお客様から受け取る合計を確認できます。'},
  {id:'groups',action:'cloud-groups',title:'複数店舗の権限を管理する',keywords:'複数 店舗 グループ 役職 権限 追加 切替 招待 本店 支店',text:'メニューの「店舗グループ」でグループを作り、自分が開設した店舗を追加します。招待したマネージャー・スタッフは、割り当てた店舗を同じアカウントで切り替えられます。'},
];

export const practiceSteps = Object.freeze([
  {title:'開店',hint:'釣銭準備金を確認し、開店を確定します。',cta:'開店画面を開く'},
  {title:'来店',hint:'空席を選び、人数と初回セットを登録します。',cta:'来店画面を開く'},
  {title:'注文',hint:'メニューを選び、少なくとも1商品を確定します。',cta:'注文画面を開く'},
  {title:'会計',hint:'支払方法と金額を確認して会計を確定します。',cta:'会計画面を開く'},
  {title:'退店',hint:'会計が終わった卓を解放します。',cta:'退店画面を開く'},
  {title:'閉店・日報',hint:'レジ残高を確認して閉店し、日報を開きます。',cta:'閉店画面を開く'},
]);

const normalize = (text) => text.normalize('NFKC').toLocaleLowerCase('ja-JP');
const particles = /(?:にする|したい|できますか|できる|どうやって|どこで|方法|使い方|教えて|について|を|の)/gu;

export function getOperationsGuideTopic(id) {
  return lessons.find((lesson)=>lesson.id === id);
}

export function searchOperationsGuide(query, allows = () => true) {
  const normalizedQuery = normalize(query ?? '').replace(particles,' ').replace(/[?？。、]/gu,' ').trim();
  const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
  const available = lessons.filter(allows);
  if (!tokens.length) return available;
  return available.map((lesson) => {
    const source = normalize(lesson.title + ' ' + lesson.keywords + ' ' + lesson.text);
    const matches = tokens.filter((token) => source.includes(token)).length;
    return {lesson,matches};
  }).filter(({matches}) => matches > 0).sort((first,second) => second.matches - first.matches).map(({lesson}) => lesson);
}

export function renderGuideResults(query, escape, {allows, actions} = {}) {
  const matches = searchOperationsGuide(query,allows);
  return matches.length ? `<ol class="ops-guide">${matches.map((lesson) =>
    `<li><strong>${escape(lesson.title)}</strong><p>${escape(lesson.text)}</p>${actions?.(lesson) ?? ''}</li>`).join('')}</ol>`
    : '<p class="field-help">該当する操作が見つかりません。注文、印刷、給与などの短いキーワードで探してください。</p>';
}

export function getPracticeStatus(state) {
  const opened = state.day.status === 'open' || state.closedDays.length > 0;
  const tickets = [...state.tickets,...state.closedDays.flatMap((day) => day.ticketSnapshots ?? [])]
    .filter(({status}) => ['open','paid','departed'].includes(status));
  const open = tickets.find(({status}) => status === 'open');
  const paid = tickets.find(({status}) => status === 'paid');
  const ordered = (ticket) => ticket.lines.some(({menuId,category,cancelledAt}) =>
    cancelledAt == null && !['セット','延長'].includes(category) && menuId);
  const milestones = [opened,tickets.length > 0,tickets.some(ordered),
    tickets.some(({status}) => status !== 'open'),tickets.some(({status}) => status === 'departed'),state.closedDays.length > 0];
  const nextStep = milestones.findIndex((done) => !done);
  return {milestones,completed:milestones.filter(Boolean).length,nextStep,open,paid};
}

export function renderPracticeProgress(model, {button,escape,icon}) {
  const next = practiceSteps[model.nextStep];
  return `<section class="ops-practice" aria-label="体験クエスト">
    <div class="ops-practice-head"><div>
      <h2>${icon('check',18)} 体験クエスト <small>${model.completed}/${practiceSteps.length}</small></h2>
      <p aria-live="polite">${next ? escape(next.hint) : 'すべての操作を体験しました。日報で確定売上と締め結果を確認できます。'}</p></div>
      <div class="ops-actions">${next ? button(next.cta,'practice-next',{tone:'primary'}) : button('日報を見る','practice-report',{tone:'primary'})}
      ${button('練習を終了','practice-stop',{tone:'quiet'})}</div></div>
    <ol class="ops-practice-steps">${practiceSteps.map(({title},index) => `<li
      ${model.milestones[index] ? ' class="is-complete"' : ''}${model.nextStep === index ? ' aria-current="step"' : ''}>${model.milestones[index] ? icon('check',13) : ''}${escape(title)}</li>`).join('')}</ol>
  </section>`;
}
