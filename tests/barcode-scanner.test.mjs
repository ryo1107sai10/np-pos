import assert from 'node:assert/strict';
import test from 'node:test';
import { scannedBarcode, startBarcodeReader } from '../docs/barcode-scanner.mjs';

function camera() {
  let stops = 0;
  const stream = {getTracks:() => [{stop:() => stops++}]};
  return {
    stream,
    video:{readyState:4,srcObject:null,play:async () => {}},
    mediaDevices:{getUserMedia:async ({audio,video}) => {
      assert.equal(audio,false);
      assert.equal(video.facingMode.ideal,'environment');
      return stream;
    }},
    trackStops:() => stops,
  };
}

test('barcode reads preserve leading zeros and reject invalid store barcode input', () => {
  assert.equal(scannedBarcode(' ０１２３４５６７ '),'01234567');
  assert.equal(scannedBarcode('AB-987'), 'AB-987');
  assert.equal(scannedBarcode('A\u0000B'),null);
  assert.equal(scannedBarcode('A'.repeat(65)),null);
});

test('an available native detector reads without requesting the fallback and releases the camera', async () => {
  const {video,mediaDevices,trackStops} = camera();
  const controller = new AbortController();
  const received = [];
  class Detector {
    static async getSupportedFormats() {
      return ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf','qr_code','data_matrix'];
    }
    async detect() { return [{rawValue:'01234567'}]; }
  }
  await startBarcodeReader({video,signal:controller.signal,onCode(value) {
    received.push(value);
    controller.abort();
  }},{mediaDevices,Detector,loadDecoder:() => assert.fail('Fallback was loaded')});
  assert.deepEqual(received,['01234567']);
  assert.equal(trackStops(),1);
  assert.equal(video.srcObject,null);
});

test('an unsupported native detector uses the fallback and cancellation ignores any late result', async () => {
  const {video,mediaDevices,trackStops} = camera();
  const controller = new AbortController();
  const received = [];
  let callback;
  let stops = 0;
  class BrowserMultiFormatReader {
    async decodeFromVideoElement(element,onResult) {
      assert.equal(element,video);
      callback = onResult;
      return {stop:() => stops++};
    }
  }
  await startBarcodeReader({video,signal:controller.signal,onCode:value => received.push(value)},{
    mediaDevices,Detector:null,loadDecoder:async () => ({BrowserMultiFormatReader}),
  });
  callback({getText:() => '001234567'});
  controller.abort();
  callback({getText:() => '87654321'});
  assert.deepEqual(received,['001234567']);
  assert.equal(stops,1);
  assert.equal(trackStops(),1);
  assert.equal(video.srcObject,null);
});

test('closing during a camera request releases a late media stream', async () => {
  const {stream,video,trackStops} = camera();
  const controller = new AbortController();
  let grant;
  const mediaDevices = {getUserMedia:() => new Promise((resolve) => { grant = resolve; })};
  const starting = startBarcodeReader({video,signal:controller.signal,onCode:assert.fail},{mediaDevices,Detector:null});
  controller.abort();
  grant(stream);
  await starting;
  assert.equal(trackStops(),1);
  assert.equal(video.srcObject,null);
});
