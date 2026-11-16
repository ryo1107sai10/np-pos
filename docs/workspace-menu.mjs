const groups = ['営業', '顧客・資金', '分析・レポート', 'スタッフ管理', '店舗設定', 'アカウント'];

export function renderWorkspaceMenu({pages, page, ready, isOpen, hasTables, storeName, role, cloud, showOverview}, {escape, icon, canOpenPage, permittedAction}) {
  const routes = ready ? Object.entries(pages).filter(([id]) => canOpenPage(id)).map(([id, route]) => ({
    id, title:route.title, glyph:route.icon, group:route.group, action:'navigate',
  })) : [];
  const shortcuts = ready ? [
    {group:'営業', title:isOpen?'閉店処理':'開店する', glyph:isOpen?'checkout':'power', action:isOpen?'close':'open'},
    ...(isOpen && hasTables ? [{group:'営業', title:'来店登録', glyph:'plus', action:'seat'}] : []),
    {group:'営業', title:'営業のお知らせ', glyph:'alert', action:'ops-notices'},
    {group:'顧客・資金', title:'顧客を登録', glyph:'plus', action:'customer-new'},
    ...(isOpen ? [{group:'顧客・資金', title:'入出金を記録', glyph:'cash', action:'record-cash'}] : []),
    {group:'分析・レポート', title:'監査ログ', glyph:'history', action:'audit-log'},
    {group:'店舗設定', title:'卓とフロアの配置', glyph:'table', action:'edit-layout'},
    {group:'店舗設定', title:'メニュー設定', glyph:'store', action:'store-settings', id:'menu'},
    {group:'店舗設定', title:'セット・延長料金', glyph:'clock', action:'store-settings', id:'plans'},
    {group:'店舗設定', title:'時間帯別セット', glyph:'calendar', action:'set-schedule'},
    {group:'店舗設定', title:'キャスト歩合設定', glyph:'users', action:'store-settings', id:'cast'},
    {group:'店舗設定', title:'在庫品目設定', glyph:'box', action:'stock-settings'},
    {group:'店舗設定', title:'自動延長設定', glyph:'clock', action:'billing-settings', id:'auto'},
    ...(hasTables ? [{group:'店舗設定', title:'卓別の自動延長', glyph:'table', action:'table-auto-extension'}] : []),
    {group:'店舗設定', title:'カード会計加算', glyph:'card', action:'billing-settings', id:'card'},
    {group:'店舗設定', title:'税・サービス料', glyph:'wallet', action:'calculation-settings'},
    {group:'店舗設定', title:'運用設定', glyph:'settings', action:'ops-settings'},
    {group:'店舗設定', title:'印刷設定', glyph:'printer', action:'print-settings'},
    {group:'店舗設定', title:'設定の移行', glyph:'download', action:'layout-transfer'},
  ] : [];
  const account = [
    ...(showOverview ? [{group:'分析・レポート',title:'複数店舗の営業状況',glyph:'chart',action:'cloud-overview'}] : []),
    {group:'アカウント', title:'店舗・アカウント', glyph:'user', action:'cloud-open'},
    ...(ready ? [{group:'アカウント', title:'操作ガイド', glyph:'ticket', action:'ops-guide'}] : []),
    ...(!cloud ? [{group:'アカウント', title:'サンプル操作', glyph:'refresh', action:'demo'}] : []),
  ];
  const entries = [...routes,...shortcuts,...account].filter(({action}) => permittedAction(action));
  const sections = groups.map((group,index) => {
    const items = entries.filter((entry) => entry.group === group);
    if (!items.length) return '';
    return `<section aria-labelledby="workspace-menu-group-${index}"><h3 id="workspace-menu-group-${index}">${group}</h3><ul>${items.map(({id,title,action,glyph}) => {
      const current = action === 'navigate' && id === page ? ' aria-current="page"' : '';
      return `<li><button type="button" class="workspace-menu-item" data-action="${action}"${id ? ` data-id="${escape(id)}"` : ''}${current}>${icon(glyph,18)}<span>${escape(title)}</span>${icon('chevron-right',14)}</button></li>`;
    }).join('')}</ul></section>`;
  }).join('');
  return `<div class="workspace-menu-panel"><header class="workspace-menu-head">
    <img src="np-pos.svg" alt="" width="40" height="40"><div><h2 id="workspace-menu-title">メニュー</h2><p>${escape(storeName)} · ${escape(role)}</p></div>
    <button type="button" class="icon-btn workspace-menu-close" data-action="close-workspace-menu" aria-label="メニューを閉じる">${icon('x',20)}</button>
  </header><nav class="workspace-menu-nav" aria-label="すべての機能">${sections}</nav></div>`;
}
