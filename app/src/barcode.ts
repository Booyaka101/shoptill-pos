import type { Product } from './api';

/** Keys closer together than this are a scanner, not a person. */
export const SCAN_GAP = 50;

const subscribers = new Set<(code: string) => void>();

/**
 * USB and Bluetooth scanners act as keyboards: a burst of keys a few ms apart, then Enter. Humans
 * don't type that fast, so a burst ending in Enter is a scan wherever focus is.
 */
export function listenForScans(onScan: (code: string) => void) {
  if (!subscribers.size) window.addEventListener('keydown', onKey, true);
  subscribers.add(onScan);
  return () => {
    subscribers.delete(onScan);
    if (!subscribers.size) window.removeEventListener('keydown', onKey, true);
  };
}

let buffer = '';
let last = 0;
// The field focused when the burst began, as it was, so a scan typed over its selected text can be undone.
let before: { field: HTMLInputElement | HTMLTextAreaElement; value: string } | null = null;

function onKey(e: KeyboardEvent) {
  const now = performance.now();
  if (now - last > SCAN_GAP) buffer = '';
  last = now;
  // Scanners can be set to end the code with Enter or Tab; a person can't type this fast either way.
  if (e.key === 'Enter' || e.key === 'Tab') {
    // A field marked data-scan (a coupon, a loyalty card) is asking for the code, so it keeps it.
    if (buffer.length >= 4 && !(e.target instanceof HTMLInputElement && 'scan' in e.target.dataset)) {
      e.preventDefault();
      e.stopPropagation();
      // The scanner also typed into whatever field had focus; put it back.
      if (before && before.field.value !== before.value) {
        before.field.value = before.value;
        before.field.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const code = buffer;
      [...subscribers].forEach((fn) => fn(code));
    }
    buffer = '';
    return;
  }
  if (e.key.length !== 1) return;
  if (!buffer) before = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement ? { field: e.target, value: e.target.value } : null;
  buffer += e.key;
}

// A UPC-A code is an EAN-13 with a leading zero, and scanners and shops write it either way.
const gtinKey = (s: string) => (/^\d+$/.test(s) ? s.replace(/^0+/, '') : s);

/** Expands a UPC-E code to the UPC-A it stands for, or leaves anything else alone. */
function upceToUpca(code: string): string {
  // Eight digits with a number system of 0 or 1, or seven without one, is a compressed UPC-A.
  if (!/^\d+$/.test(code) || (code.length !== 7 && (code.length !== 8 || !/^[01]/.test(code)))) return code;
  const ns = code.length === 8 ? code[0] : '0';
  const d = code.slice(-7, -1);
  const body =
    '012'.includes(d[5]) ? d.slice(0, 2) + d[5] + '0000' + d.slice(2, 5)
    : d[5] === '3' ? d.slice(0, 3) + '00000' + d.slice(3, 5)
    : d[5] === '4' ? d.slice(0, 4) + '00000' + d[4]
    : d.slice(0, 5) + '0000' + d[5];
  // The check digit the UPC-E carries is the UPC-A's.
  return ns + body + code.slice(-1);
}

/** What a scanned code means for the sale: which code to look the product up by, and any weight or price it carries. */
export function decodeScan(code: string): { lookup: string; qty?: number; price?: number } {
  const c = code.trim();
  // An EAN-13 starting 28 or 29 is a scale label: two digits for the shop, five for the item, five for the amount.
  const scale = /^2[89]\d{11}$/.exec(c);
  if (scale) {
    const embedded = Number(c.slice(7, 12));
    return c[1] === '8'
      ? // A weight label carries grams, and the product's price is per kilo.
        { lookup: c.slice(2, 7), qty: Math.round((embedded / 1000) * 1000) / 1000 }
      : // A price label: the shelf price is whatever the scale printed, in cents.
        { lookup: c.slice(2, 7), price: embedded / 100 };
  }
  return { lookup: upceToUpca(c) };
}

export function findByCode(products: Iterable<Product>, code: string): Product | undefined {
  const decoded = decodeScan(code);
  const key = gtinKey(decoded.lookup);
  let bySku: Product | undefined;
  for (const p of products) {
    if (p.type === 'variable') continue;
    if (p.gtin && gtinKey(p.gtin) === key) return p;
    if (!bySku && p.sku && p.sku.toLowerCase() === decoded.lookup.toLowerCase()) bySku = p;
  }
  return bySku;
}

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

export function cameraScanSupported() {
  return 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
}

/** Scans with the device camera until a code is read or `signal` aborts. */
export async function scanWithCamera(video: HTMLVideoElement, signal: AbortSignal): Promise<string | null> {
  const Ctor = (window as unknown as { BarcodeDetector: new (o: object) => Detector }).BarcodeDetector;
  const detector = new Ctor({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  try {
    video.srcObject = stream;
    await video.play();
    while (!signal.aborted) {
      const codes = await detector.detect(video).catch(() => []);
      if (codes.length) return codes[0].rawValue;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}
