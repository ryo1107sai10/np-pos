const modes = new Set(['browser','epson-lan','epson-assistant']);
const namespace = 'http://www.epson-pos.com/schemas/2011/03/epos-print';
const defaultSettings = Object.freeze({mode:'browser',protocol:'https',ip:'',port:'',device:'local_printer'});
const storagePrefix = 'np-pos.receipt-printer.v1:';

function isPrivateIpv4(ip) {
  const fields = ip.split('.');
  if (fields.length !== 4 || fields.some((value) => !/^(?:0|[1-9]\d{0,2})$/.test(value) || Number(value) > 255)) return false;
  const [first,second] = fields.map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first === 169 && second === 254);
}

export function normalizeReceiptPrinter(settings) {
  const mode = settings?.mode ?? 'browser';
  if (!modes.has(mode)) throw new Error('プリンターの接続方式を確認してください。');
  if (mode !== 'epson-lan') return {...defaultSettings,mode};
  const ip = String(settings.ip ?? '').trim();
  const protocol = settings.protocol;
  const port = String(settings.port ?? '').trim();
  const device = String(settings.device ?? '').trim() || defaultSettings.device;
  if (!isPrivateIpv4(ip) || !['https','http'].includes(protocol) || (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535))
    || !/^[A-Za-z0-9_.-]{1,64}$/.test(device)) throw new Error('プリンターのローカルIP・ポート・デバイスIDを確認してください。');
  return {mode,protocol,ip,port,device};
}

export function readReceiptPrinter(storage,scope) {
  try { return normalizeReceiptPrinter(JSON.parse(storage.getItem(storagePrefix + scope))); }
  catch { return {...defaultSettings}; }
}

export function saveReceiptPrinter(storage,scope,settings) {
  storage.setItem(storagePrefix + scope,JSON.stringify(normalizeReceiptPrinter(settings)));
}

export function receiptPrinterFromForm(data) {
  return normalizeReceiptPrinter({mode:data.get('receiptPrinterMode'),ip:data.get('receiptPrinterIp'),
    protocol:data.get('receiptPrinterProtocol'),port:data.get('receiptPrinterPort'),device:data.get('receiptPrinterDevice')});
}

export function renderReceiptPrinterFields(settings,{escape}) {
  const options = {'browser':'ブラウザーの印刷','epson-lan':'Epson ePOS LAN','epson-assistant':'Epson TM Print Assistant（Bluetoothなど）'};
  const select = (name,values,selected) => `<select name="${name}">${Object.entries(values).map(([value,label]) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
  return `<section class="np-print-test-tools"><h3>この端末のプリンター</h3>
    <div class="form-grid"><label class="field"><span>接続方式</span>${select('receiptPrinterMode',options,settings.mode)}</label>
    <label class="field"><span>LANの通信方式</span>${select('receiptPrinterProtocol',{https:'HTTPS',http:'HTTP'},settings.protocol)}</label>
    <label class="field"><span>プリンターのローカルIP</span><input name="receiptPrinterIp" placeholder="192.168.1.100" value="${escape(settings.ip)}" inputmode="decimal"></label>
    <label class="field"><span>ポート（任意）</span><input name="receiptPrinterPort" inputmode="numeric" value="${escape(settings.port)}"></label>
    <label class="field"><span>デバイスID</span><input name="receiptPrinterDevice" maxlength="64" value="${escape(settings.device)}"></label></div>
    <p class="field-help">LANはEpson ePOS-Print対応機種で、ブラウザーからプリンターに接続できるよう設定してください。BluetoothはスマホのEpson TM Print Assistantでプリンターを登録します。</p>
    <button type="button" class="btn btn-secondary" data-action="receipt-printer-test">接続先へテスト印刷</button></section>`;
}

export function eposLanEndpoint(settings) {
  const {mode,protocol,ip,port,device} = normalizeReceiptPrinter(settings);
  if (mode !== 'epson-lan') throw new Error('LAN接続を選んでください。');
  const endpoint = new URL(`${protocol}://${ip}${port ? ':' + port : ''}/cgi-bin/epos/service.cgi`);
  endpoint.searchParams.set('devid',device);
  endpoint.searchParams.set('timeout','8000');
  return endpoint.href;
}

function xml(value) {
  return String(value).replace(/[\u0000-\u001F\u007F\uFFFE\uFFFF]/gu,' ').replace(/[&<>"']/g,
    (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[char]);
}

export function makeEposReceipt(documents,width) {
  const columns = Number(width) === 80 ? 42 : 30;
  const body = documents.map((document) => {
    const rows = [];
    for (const line of document) {
      let part = '';
      let used = 0;
      for (const character of String(line)) {
        const units = /^[\x20-\x7E\uFF61-\uFF9F]$/u.test(character) ? 1 : 2;
        if (used + units > columns) {
          rows.push(part);
          part = '';
          used = 0;
        }
        part += character;
        used += units;
      }
      rows.push(part);
    }
    return `<text>${rows.map(xml).join('&#10;')}&#10;</text><cut type="feed"/>`;
  }).join('');
  if (!body) throw new Error('送信する印字データがありません。');
  const output = `<epos-print xmlns="${namespace}"><text lang="ja" font="font_a"/>${body}</epos-print>`;
  if (new TextEncoder().encode(output).length > 60_000) throw new Error('印字データが長いため、ブラウザー印刷を使用してください。');
  return output;
}

export function eposReceiptDocuments(root) {
  const block = new Set(['ARTICLE','HEADER','SECTION','H3','H4','P','LI','UL','DL','DIV','BR']);
  function read(node) {
    if (node.nodeType === 3) return node.textContent.trim();
    if (node.nodeType !== 1) return '';
    const content = Array.from(node.childNodes,read).filter(Boolean).join(' ');
    return block.has(node.tagName) ? '\n' + content + '\n' : content;
  }
  return Array.from(root.querySelectorAll('.np-print-paper'), (paper) => read(paper).split(/\n+/)
    .map((line) => line.trim().replace(/\s+/gu,' ')).filter(Boolean));
}

export function epsonAssistantLink(document) {
  const link = 'tmprintassistant://tmprintassistant.epson.com/print?ver=1&data-type=eposprintxml&error-dialog=yes&data='
    + encodeURIComponent(document);
  if (link.length > 100_000) throw new Error('印字データが長いため、ブラウザー印刷を使用してください。');
  return link;
}

export async function sendEposLan(settings,document,{request = globalThis.fetch} = {}) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${document}</s:Body></s:Envelope>`;
  let response;
  try {
    response = await request(eposLanEndpoint(settings),{method:'POST',body,headers:{'Content-Type':'text/xml; charset=utf-8',
      SOAPAction:''},redirect:'error',credentials:'omit',signal:AbortSignal.timeout(11_000)});
  } catch {
    throw new Error('プリンターの応答を確認できませんでした。用紙を確認してから、ネットワーク・IP・ブラウザーの接続許可を確認してください。');
  }
  const result = response.ok ? await response.text() : '';
  if (!/<(?:[\w.-]+:)?response(?:\s|>)[^>]*\bsuccess=(["'])(?:true|1)\1/i.test(result)) {
    throw new Error('プリンターから印刷完了の応答が返りませんでした。用紙と機器の状態を確認してください。');
  }
}
