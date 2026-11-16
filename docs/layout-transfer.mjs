function previewConfiguration({ layout, settings }, fileName, escape, icon) {
  const counts = new Map(layout.areas.map((area) => [area, 0]));
  for (const table of layout.tables) counts.set(table.area, counts.get(table.area) + 1);
  const totals = [['エリア', layout.areas.length], ['卓', layout.tables.length]];
  if (settings) {
    const sets = settings.menu.filter((item) => item.category === 'セット').length;
    const extensions = settings.menu.filter((item) => item.category === '延長').length;
    totals.push(['メニュー', settings.menu.length - sets - extensions], ['キャスト', settings.cast.length],
      ['セット', sets], ['延長料金', extensions]);
    if (settings.stock) totals.push(['在庫品目', settings.stock.length]);
  }

  return `<section class="layout-transfer-preview" aria-labelledby="layout-transfer-preview-heading" aria-live="polite">
    <div class="layout-transfer-preview-head">
      <div class="layout-transfer-preview-label">${icon('check', 15)}<h4 id="layout-transfer-preview-heading">読み込み内容</h4></div>
      ${fileName ? `<p class="layout-transfer-filename" title="${escape(fileName)}">${escape(fileName)}</p>` : ''}
    </div>
    <dl class="layout-transfer-totals">
      ${totals.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}
    </dl>
    ${counts.size ? `<ul class="layout-transfer-area-list" aria-label="エリア別の卓数"${counts.size > 4 ? ' tabindex="0"' : ''}>
      ${[...counts].map(([name, count]) => `<li><span>${escape(name)}</span><strong>${count}卓</strong></li>`).join('')}
    </ul>` : ''}
  </section>`;
}

export function renderLayoutTransfer({ fileName, configuration, error, loading, fresh }, { escape, icon }) {
  const result = loading
    ? `<p class="layout-transfer-loading" role="status">${icon('clock', 16)}ファイルを確認しています…</p>`
    : error
      ? `<p class="layout-transfer-error" id="layout-transfer-error" role="alert">${icon('alert', 17)}<span>${escape(error)}</span></p>`
      : configuration ? previewConfiguration(configuration, fileName, escape, icon) : '';

  return `<div class="layout-transfer-body">
    <section class="layout-transfer-export" aria-labelledby="layout-transfer-export-heading">
      <span class="layout-transfer-icon layout-transfer-icon-download">${icon('arrow-right', 18)}</span>
      <div class="layout-transfer-export-copy"><h3 id="layout-transfer-export-heading">書き出し</h3>
      <p>メニュー・料金・歩合・在庫品目と卓レイアウトを一つのファイルに保存します。</p></div>
      <button type="button" class="btn btn-secondary layout-transfer-export-button" data-action="layout-export">設定を書き出す</button>
    </section>
    <section class="layout-transfer-import" aria-labelledby="layout-transfer-import-heading">
      <div class="layout-transfer-import-head">
        <span class="layout-transfer-icon">${icon('move', 18)}</span>
        <div><h3 id="layout-transfer-import-heading">読み込み</h3><p id="layout-transfer-file-help">NP POSで書き出したJSONファイルを選んでください。</p></div>
      </div>
      <label class="layout-transfer-file-label" for="layout-transfer-file">設定ファイル</label>
      <input type="file" class="layout-transfer-file" id="layout-transfer-file" name="layout-file" accept=".json,application/json" aria-describedby="layout-transfer-file-help${error && !loading ? ' layout-transfer-error' : ''}"${error && !loading ? ' aria-invalid="true"' : ''}>
      <div class="layout-transfer-result">${result}</div>
      ${configuration && !error && !loading ? `<p class="layout-transfer-replace">この端末の${configuration.settings ? '店舗設定と卓配置' : '卓配置'}を更新します。${configuration.settings?.stock ? '在庫数はこの端末の記録を引き継ぎます。' : ''}</p>` : ''}
    </section>
    ${fresh ? `<p class="layout-transfer-fresh">${icon('info', 16)}<span>初回は開店前の状態から始めます。</span></p>` : ''}
  </div>`;
}
