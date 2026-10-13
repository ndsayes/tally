// Live barcode scanning with the phone camera. iPhone Safari has no built-in
// BarcodeDetector, so this uses a WebAssembly port of the ZXing scanner (bundled in /vendor).
import { BarcodeDetector, prepareZXingModule } from '../vendor/barcode-detector.js';

const WASM_URL = new URL('../vendor/zxing_reader.wasm', import.meta.url).href;
prepareZXingModule({
  overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? WASM_URL : prefix + path) },
});

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
let detector;

// Starts the camera in `video` and calls onCode(code) once a barcode has been read
// twice in a row (guards against misreads). Returns { stop, ready }.
export function createScanner(video, onCode, onError) {
  let stream = null;
  let stopped = false;
  let timer = null;
  let last = null;
  let failures = 0;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  };

  const tick = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2) {
        const codes = await detector.detect(video);
        failures = 0;
        const hit = codes.find((c) => /^\d{8,14}$/.test(c.rawValue));
        if (hit && hit.rawValue === last) {
          stop();
          onCode(hit.rawValue);
          return;
        }
        last = hit?.rawValue ?? null;
      }
    } catch (err) {
      if (++failures > 20) {
        stop();
        onError?.(err);
        return;
      }
    }
    timer = setTimeout(tick, 120);
  };

  const ready = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-camera-api');
    detector ??= new BarcodeDetector({ formats: FORMATS });
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    if (stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    await video.play();
    tick();
  })();

  return { stop, ready };
}

export function cameraErrorText(err) {
  if (err?.name === 'NotAllowedError')
    return 'Camera access was blocked. Allow camera access for this app, or type the barcode number below.';
  if (err?.name === 'NotFoundError' || err?.message === 'no-camera-api')
    return 'No camera available here. Type the barcode number below.';
  return `The camera could not start (${err?.message || err}). Type the barcode number below.`;
}
