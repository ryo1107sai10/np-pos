const nativeFormats = ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf','qr_code','data_matrix'];
const fallbackSource = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.2.1/umd/zxing-browser.min.js';
const fallbackIntegrity = 'sha384-HRtzk9lZgkbSgvUyQrnfC/GxiXZgwaNyD7hC9wcXlsBpDhkS80ISl73juef2FRuf';
let fallbackLoad;

export function scannedBarcode(raw) {
  const value = typeof raw === 'string' ? raw.trim().normalize('NFKC') : '';
  return value && value.length <= 64 && !/[\p{C}\u2028\u2029]/u.test(value) ? value : null;
}

export function barcodeScannerAvailable() {
  return Boolean(globalThis.isSecureContext && globalThis.navigator?.mediaDevices?.getUserMedia);
}

function loadFallback() {
  fallbackLoad ??= new Promise((resolve,reject) => {
    const script = document.createElement('script');
    script.src = fallbackSource;
    script.integrity = fallbackIntegrity;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.onload = () => resolve(globalThis.ZXingBrowser);
    script.onerror = () => reject(new Error('バーコードの読み取り機能に接続できませんでした。'));
    document.head.append(script);
  }).catch((error) => { fallbackLoad = undefined; throw error; });
  return fallbackLoad;
}

async function nativeDetector(Detector) {
  if (typeof Detector !== 'function') return null;
  try {
    const supported = await Detector.getSupportedFormats();
    if (nativeFormats.some((format) => !supported.includes(format))) return null;
    return new Detector({formats:nativeFormats});
  } catch { return null; }
}

async function readNative(detector,video,signal,onCode) {
  while (!signal.aborted) {
    const results = video.readyState >= 2 ? await detector.detect(video) : [];
    const value = results.map(({rawValue}) => scannedBarcode(rawValue)).find(Boolean);
    if (!signal.aborted && value) { onCode(value); return; }
    await new Promise((resolve) => setTimeout(resolve,150));
  }
}

export async function startBarcodeReader({video,signal,onCode}, {
  mediaDevices = globalThis.navigator?.mediaDevices, Detector = globalThis.BarcodeDetector, loadDecoder = loadFallback,
} = {}) {
  if (!mediaDevices?.getUserMedia) throw new Error('このブラウザーではカメラを利用できません。');
  const stream = await mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
  let controls;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { controls?.stop(); }
    finally {
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
  };
  if (signal.aborted) { release(); return; }
  signal.addEventListener('abort',release,{once:true});
  try {
    video.srcObject = stream;
    await video.play();
    if (signal.aborted) return;
    const detector = await nativeDetector(Detector);
    if (detector) {
      try { await readNative(detector,video,signal,onCode); return; }
      catch { /* Use the portable decoder if the native decoder fails. */ }
    }
    if (signal.aborted) return;
    const decoder = await loadDecoder();
    if (signal.aborted) return;
    if (!decoder?.BrowserMultiFormatReader) throw new Error('バーコードの読み取り機能を起動できませんでした。');
    const reader = new decoder.BrowserMultiFormatReader();
    controls = await reader.decodeFromVideoElement(video,(result) => {
      const value = scannedBarcode(result?.getText());
      if (!signal.aborted && value) onCode(value);
    });
    if (signal.aborted) controls.stop();
  } catch (error) {
    release();
    throw error;
  }
}

export function openBarcodeScanner() {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal np-barcode-dialog';
  dialog.setAttribute('aria-labelledby','barcode-dialog-title');
  dialog.innerHTML = `<header class="modal-head"><h2 id="barcode-dialog-title">バーコードを読み取る</h2>
    <button type="button" class="btn">閉じる</button></header><div class="modal-body">
    <video muted autoplay playsinline aria-label="バーコード読み取り用のカメラ"></video>
    <p role="status">バーコードをカメラの中央に合わせてください。</p></div>`;
  document.body.append(dialog);
  const controller = new AbortController();
  let barcode = null;
  const close = () => { if (dialog.open) dialog.close(); };
  const closeOnHidden = () => { if (document.hidden) close(); };
  const result = new Promise((resolve) => {
    dialog.addEventListener('close',() => {
      controller.abort();
      document.removeEventListener('visibilitychange',closeOnHidden);
      dialog.remove();
      resolve(barcode);
    },{once:true});
  });
  dialog.querySelector('button').addEventListener('click',close);
  document.addEventListener('visibilitychange',closeOnHidden);
  dialog.showModal();
  startBarcodeReader({video:dialog.querySelector('video'),signal:controller.signal,onCode(value) {
    barcode = value;
    close();
  }}).catch(() => {
    if (dialog.open) {
      dialog.querySelector('video').hidden = true;
      dialog.querySelector('[role=status]').textContent = 'カメラで読み取れませんでした。カメラへのアクセスを確認するか、閉じてコードを直接入力してください。';
    }
  });
  return {result,close};
}
