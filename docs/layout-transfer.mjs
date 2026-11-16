function previewLayout(layout, fileName, escape, icon) {
  const counts = new Map(layout.areas.map((area) => [area, 0]));
  for (const table of layout.tables) counts.set(table.area, counts.get(table.area) + 1);

  return `<section class="layout-transfer-preview" aria-labelledby="layout-transfer-preview-heading" aria-live="polite">
    <div class="layout-transfer-preview-head">
      <div class="layout-transfer-preview-label">${icon('check', 15)}<h4 id="layout-transfer-preview-heading">読み込み内容</h4></div>
      ${fileName ? `<p class="layout-transfer-filename" title="${escape(fileName)}">${escape(fileName)}</p>` : ''}
    </div>
    <dl class="layout-transfer-totals">
      <div><dt>エリア</dt><dd>${layout.areas.length}</dd></div>
      <div><dt>卓</dt><dd>${layout.tables.length}</dd></div>
    </dl>
    ${counts.size ? `<ul class="layout-transfer-area-list" aria-label="エリア別の卓数"${counts.size > 4 ? ' tabindex="0"' : ''}>
      ${[...counts].map(([name, count]) => `<li><span>${escape(name)}</span><strong>${count}卓</strong></li>`).join('')}
    </ul>` : ''}
  </section>`;
}

export function renderLayoutTransfer({ fileName, layout, error, loading, fresh }, { escape, icon }) {
  const result = loading
    ? `<p class="layout-transfer-loading" role="status">${icon('clock', 16)}ファイルを確認しています…</p>`
    : error
      ? `<p class="layout-transfer-error" id="layout-transfer-error" role="alert">${icon('alert', 17)}<span>${escape(error)}</span></p>`
      : layout ? previewLayout(layout, fileName, escape, icon) : '';

  return `<div class="layout-transfer-body">
    <section class="layout-transfer-export" aria-labelledby="layout-transfer-export-heading">
      <span class="layout-transfer-icon layout-transfer-icon-download">${icon('arrow-right', 18)}</span>
      <div class="layout-transfer-export-copy"><h3 id="layout-transfer-export-heading">書き出し</h3>
      <p>卓名・定員・エリア・配置を設定ファイルに保存します。</p></div>
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
      ${layout && !error && !loading ? '<p class="layout-transfer-replace">読み込むと、この端末の卓配置が置き換わります。</p>' : ''}
    </section>
    ${fresh ? `<p class="layout-transfer-fresh">${icon('info', 16)}<span>初回は開店前の状態から始めます。</span></p>` : ''}
  </div>`;
}
