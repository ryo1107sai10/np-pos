import assert from 'node:assert/strict';
import test from 'node:test';
import { eposLanEndpoint, epsonAssistantLink, makeEposReceipt, normalizeReceiptPrinter, readReceiptPrinter, saveReceiptPrinter, sendEposLan } from '../docs/receipt-printer.mjs';

const lan = {mode:'epson-lan',protocol:'https',ip:'192.168.1.101',port:'8443',device:'local_printer'};

test('receipt connections are opt-in, kept by scope and limited to local IP print endpoints', () => {
  const values = new Map();
  const storage = {getItem:(key) => values.get(key),setItem:(key,value) => values.set(key,value)};
  saveReceiptPrinter(storage,'store-a',lan);
  assert.deepEqual(readReceiptPrinter(storage,'store-a'),lan);
  assert.equal(readReceiptPrinter(storage,'store-b').mode,'browser');
  assert.equal(eposLanEndpoint(lan),'https://192.168.1.101:8443/cgi-bin/epos/service.cgi?devid=local_printer&timeout=8000');
  for (const ip of ['192.168.1.101/path','192.168.1.999','8.8.8.8','127.0.0.1','172.32.0.1','example.test']) {
    assert.throws(() => normalizeReceiptPrinter({...lan,ip}),/ローカルIP/);
  }
  assert.throws(() => normalizeReceiptPrinter({...lan,device:'../../?'}),/デバイスID/);
});

test('print XML keeps Japanese text, wraps to the selected width, and encodes a device handoff', () => {
  const receipt = ['再発行','団体 <A> & "B"','漢'.repeat(19),'領収書 … ¥13,200'];
  const narrow = makeEposReceipt([receipt,['店舗控え']],58);
  const wide = makeEposReceipt([receipt],80);
  assert.match(narrow,/lang="ja"/);
  assert.match(narrow,/再発行&#10;団体 &lt;A&gt; &amp; &quot;B&quot;/);
  assert(narrow.includes('漢'.repeat(15) + '&#10;' + '漢'.repeat(4)));
  assert(wide.includes('漢'.repeat(19)));
  assert.equal(narrow.match(/<cut type="feed"\/>/g).length,2);
  const link = new URL(epsonAssistantLink(narrow));
  assert.equal(link.protocol,'tmprintassistant:');
  assert.equal(link.hostname,'tmprintassistant.epson.com');
  assert.equal(link.searchParams.get('data-type'),'eposprintxml');
  assert.equal(link.searchParams.get('data'),narrow);
});

test('LAN sends only the ePOS envelope and treats unknown outcomes as errors without resending', async () => {
  const document = makeEposReceipt([['NP POS テスト']],58);
  let sent = 0;
  await sendEposLan(lan,document,{request:async (url,options) => {
    sent++;
    assert.equal(new URL(url).hostname,lan.ip);
    assert.equal(options.redirect,'error');
    assert.equal(options.credentials,'omit');
    assert.equal(options.method,'POST');
    assert(options.body.includes('<s:Body>' + document + '</s:Body>'));
    return new Response('<s:Envelope><response success="true" code=""/></s:Envelope>');
  }});
  await assert.rejects(sendEposLan(lan,document,{request:async () => {
    sent++;
    return new Response('<response success="false" code="PrinterOffline"/>');
  }}),/印刷完了/);
  assert.equal(sent,2);
});
