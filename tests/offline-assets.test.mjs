import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const docs = new URL('../docs/', import.meta.url);
const read = (name) => readFileSync(new URL(name, docs));

test('published offline shell tracks all current public files and is installable beneath a project path', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/update-offline-assets.mjs', import.meta.url)), '--check']);
  const self = {};
  runInNewContext(read('offline-assets.js').toString(), {self});
  const names = new Set(self.npPosStatic.assets.map(([path]) => path));
  const manifest = JSON.parse(read('np-pos.webmanifest'));
  const published = new URL('https://example.test/np-pos/');
  assert.equal(new URL(manifest.start_url,published).href,'https://example.test/np-pos/#floor');
  for (const {src,sizes} of manifest.icons) {
    const size = Number(sizes.split('x')[0]);
    const png = read(src);
    assert.equal(png.readUInt32BE(16),size);
    assert.equal(png.readUInt32BE(20),size);
    assert.ok(names.has(src));
  }
  for (const filename of ['index.html','app.mjs','style.css','public-offline.mjs','np-pos.webmanifest','payroll-pdf.mjs','demo-backup.mjs']) {
    assert.ok(names.has(filename),filename);
  }
});
