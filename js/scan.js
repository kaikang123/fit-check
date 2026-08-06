// Barcode scanning via the browser's native BarcodeDetector, with a typed
// fallback for browsers that lack it (Safari/Firefox today).
//
// A scanned code is looked up against codes the user has linked on this
// device. Unknown codes are not a dead end: the user picks the matching
// catalog entry and the link is saved, which is how the barcode dataset
// actually grows.

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];

export function isSupported() {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

export class BarcodeScanner {
  constructor({ video, onResult, onError }) {
    this.video = video;
    this.onResult = onResult;
    this.onError = onError;
    this.stream = null;
    this.timer = null;
    this.detector = null;
  }

  async start() {
    if (!isSupported()) {
      this.onError('This browser has no built-in barcode scanner. Type the number below instead.');
      return false;
    }
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats?.();
      const formats = supported ? FORMATS.filter(f => supported.includes(f)) : FORMATS;
      this.detector = new window.BarcodeDetector({ formats: formats.length ? formats : undefined });
    } catch (e) {
      this.onError('Could not start the barcode scanner. Type the number below instead.');
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } },
      });
    } catch (e) {
      this.onError(`Could not open the camera (${e.name || 'error'}). Check permissions, or type the number below.`);
      return false;
    }
    this.video.srcObject = this.stream;
    this.timer = setInterval(() => this.tick(), 350);
    return true;
  }

  async tick() {
    if (!this.detector || !this.video.videoWidth) return;
    try {
      const codes = await this.detector.detect(this.video);
      if (codes.length) {
        const value = codes[0].rawValue;
        this.stop();
        this.onResult(value);
      }
    } catch (e) { /* transient decode failures are expected between frames */ }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }
}

// Barcodes are 8-14 digits; reject anything else before looking it up.
export function normalizeBarcode(raw) {
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}
