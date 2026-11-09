/**
 * ESC/POS receipt building and printing over WebUSB.
 *
 * Thermal printers sold to shops speak Epson's ESC/POS command set over USB:
 * bytes in, paper out, no driver and no print dialog. This module turns the
 * same Receipt the on-screen preview renders into that byte stream, plus the
 * two commands a shop can hear across the counter: the cash-drawer kick and
 * the auto-cutter.
 */


// The stock DOM lib in this build predates WebUSB's types; the surface the
// till uses is declared here so the rest of the module stays typed.
declare global {
interface USBEndpoint {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
}
interface USBAlternateInterface {
  interfaceClass: number;
  endpoints: USBEndpoint[];
}
interface USBInterface {
  interfaceNumber: number;
  alternates: USBAlternateInterface[];
}
interface USBConfiguration {
  interfaces: USBInterface[];
}
interface USBDevice {
  opened?: boolean;
  productName?: string;
  configuration: USBConfiguration | null;
  open(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<unknown>;
}
interface USBConnectionEvent extends Event {
  device: USBDevice;
}
interface USB {
  requestDevice(opts: { filters: { classCode?: number }[] }): Promise<USBDevice>;
  getDevices(): Promise<USBDevice[]>;
  addEventListener(t: 'connect' | 'disconnect', f: (e: USBConnectionEvent) => void): void;
}
interface Navigator {
  usb?: USB;
}
}

import type { Receipt } from './db';
import { money } from './money';
import { signal } from '@preact/signals';

// -- command helpers (bytes assembled with plain arrays; no deps) --

const ESC = 0x1b;
const GS = 0x1d;

const init = () => [ESC, 0x40]; // ESC @ : reset to defaults
const align = (n: 0 | 1 | 2) => [ESC, 0x61, n];
const bold = (on: boolean) => [ESC, 0x45, on ? 1 : 0];
const size = (w: 1 | 2, h: 1 | 2) => [GS, 0x21, (w - 1) << 4 | (h - 1)];
const feed = (n: number) => [ESC, 0x64, n]; // feed n lines
const cut = () => [GS, 0x56, 66, 0]; // partial cut
/** Kick drawer pin 2 for ~100ms: the standard pulse for Epson-compatible drawers. */
const kickDrawer = () => [ESC, 0x70, 0, 25, 250];

/**
 * ESC/POS printers are 8-bit, not UTF-8. Most receipt text fits CP437 after
 * transliterating the common accents; anything unmappable becomes '?', which
 * prints, rather than mojibake, which doesn't.
 */
export function encodeText(s: string): number[] {
  const map: Record<string, string> = {
    '€': 'EUR', '£': 'GBP', '×': 'x', '−': '-', '–': '-', '—': '-', '’': "'", '‘': "'",
    '“': '"', '”': '"', '…': '...', '•': '*', '→': '->', 'é': 'e', 'è': 'e', 'ê': 'e',
    'ë': 'e', 'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ç': 'c', 'í': 'i', 'ì': 'i',
    'î': 'i', 'ï': 'i', 'ó': 'o', 'ò': 'o', 'ô': 'o', 'ö': 'o', 'ú': 'u', 'ù': 'u',
    'û': 'u', 'ü': 'u', 'ñ': 'n', 'ß': 'ss', '°': '\u00b0',
  };
  const upper: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) upper[k.toUpperCase()] = v.toUpperCase();
  const all = { ...map, ...upper };
  const out: number[] = [];
  for (const ch of s.replace(/\t/g, '    ')) {
    const code = ch.codePointAt(0)!;
    if (code < 128) {
      out.push(code);
    } else if (all[ch]) {
      for (const c of all[ch]) out.push(c.codePointAt(0)!);
    } else if (code === 0xb0) {
      out.push(0xf8); // CP437 degree sign
    } else {
      out.push(0x3f); // '?'
    }
  }
  return out;
}

const WIDTH = 42; // 80mm paper prints ~42 columns; 58mm printers scale down themselves
const text = (s: string) => [...encodeText(s), 0x0a];
const textNoBreak = (s: string) => encodeText(s);

/** Left column and right column on one line, single line of padding between. */
const columns = (left: string, right: string): number[] => {
  const l = left.slice(0, WIDTH - 1);
  const r = right.slice(0, Math.max(0, WIDTH - encodeText(l).length - 1));
  const gap = Math.max(1, WIDTH - encodeText(l).length - encodeText(r).length);
  return [...encodeText(l), ...new Array<number>(gap).fill(0x20), ...encodeText(r), 0x0a];
};

/** Word-wrap a paragraph to the paper width, for addresses and notes. */
const wrapped = (s: string): number[] => {
  const out: number[] = [];
  for (const paragraph of s.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if ((line + (line ? ' ' : '') + word).length > WIDTH) {
        out.push(...text(line));
        line = word;
      } else {
        line += (line ? ' ' : '') + word;
      }
    }
    out.push(...text(line));
  }
  return out;
};

/** The full receipt byte stream. Exposed for the byte-level unit tests. */
export function escposReceipt(r: Receipt, store: { name: string; address?: string[]; footer?: string }): number[] {
  const out: number[] = [];
  const push = (...rows: (number | number[])[]) => {
    for (const row of rows) out.push(...(Array.isArray(row) ? row : [row]));
  };

  push(init(), align(1), bold(true), size(2, 2), text(store.name.toUpperCase()), size(1, 1), bold(false));
  if (store.address?.length) push(align(1), ...wrapped(store.address.join('\n')));
  push(align(1), text(''));
  const when = new Date(r.date);
  push(
    align(0),
    columns(when.toLocaleDateString(), when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    columns(r.number ? `Order ${r.number}` : 'Receipt', `${r.register} - ${r.cashier}`),
    text('------------------------------------------'),
  );

  for (const l of r.lines) {
    push(columns(`${l.qty} x ${l.name}`, money(l.total)));
    if (l.meta) push(...wrapped(`    ${l.meta}`));
    if (l.discount > 0.005) push(columns(`    less discount`, `-${money(l.discount)}`));
  }
  push(text('------------------------------------------'));
  if (!r.gift) {
    if (r.subtotal - r.discount > r.total - (r.prices_include_tax ? r.tax : 0) + 0.005 || r.discount > 0.005) {
      push(columns('Subtotal', money(r.subtotal)));
      if (r.discount > 0.005) push(columns('Discount', `-${money(r.discount)}`));
      for (const c of r.coupons) push(columns(`  ${c.code}`, `-${money(c.discount)}`));
    }
    for (const t of r.taxes) {
      push(columns(r.prices_include_tax ? `Includes ${t.label}` : t.label, money(t.amount)));
    }
    if (r.delivery) push(columns(r.delivery.label || 'Delivery', money(r.delivery.amount)));
    for (const f of r.fees ?? []) push(columns(f.label, money(f.amount)));
    push(bold(true), size(2, 1), columns('TOTAL', money(r.total)), size(1, 1), bold(false));
    for (const p of r.payments) {
      push(columns(p.label, money(p.amount)));
      if (p.tendered !== undefined && p.change !== undefined && p.change > 0.005) {
        push(columns('    tendered', money(p.tendered)), columns('    change', money(p.change)));
      }
    }
    if (r.owed && r.owed > 0.005) push(columns('Still owed', money(r.owed)));
  }
  if (r.fulfil) {
    push(text(''), bold(true), text(r.fulfil.how === 'collect' ? 'TO COLLECT' : 'TO DELIVER'), bold(false));
    push(...wrapped(r.fulfil.to.join(', ')));
  }
  if (r.customer) push(columns('Customer', r.customer));
  if (r.note) push(text(''), ...wrapped(`Note: ${r.note}`));
  if (r.copy) push(align(1), text('** COPY **'));
  if (r.gift) push(align(1), text('** GIFT RECEIPT **'));
  if (store.footer) push(align(1), text(''), ...wrapped(store.footer));
  push(align(1), feed(3), cut());
  return out;
}

// -- WebUSB transport --

export const printer = {
  connected: signal(false),
  name: signal<string | null>(null),
};

let device: USBDevice | null = null;
let endpoint: USBEndpoint | null = null;
let interfaceNumber = -1;

/**
 * Ask the user to pick the printer (a browser gesture is required for WebUSB
 * the first time; "always allow" in Chrome's picker covers later sessions,
 * but reconnecting on boot still needs one tap on the pill, so it is shown).
 */
export async function connectPrinter(): Promise<boolean> {
  if (!navigator.usb) return false;
  try {
    device = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] }); // 7 = printer class
  } catch {
    return false; // the user closed the picker
  }
  return await openDevice();
}

async function openDevice(): Promise<boolean> {
  if (!device) return false;
  try {
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    await device.claimInterface(interfaceNumber === -1 ? findInterface(device) : interfaceNumber);
    printer.connected.value = true;
    printer.name.value = device.productName || 'USB printer';
    return true;
  } catch {
    printer.connected.value = false;
    return false;
  }
}

function findInterface(d: USBDevice): number {
  for (const iface of d.configuration?.interfaces ?? []) {
    for (const alt of iface.alternates) {
      const ep = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
      if (ep) {
        endpoint = ep;
        interfaceNumber = iface.interfaceNumber;
        return interfaceNumber;
      }
    }
  }
  // Some cheap printers expose a vendor-specific interface instead of class 7.
  return d.configuration?.interfaces?.[0]?.interfaceNumber ?? 0;
}

navigator.usb?.addEventListener?.('connect', async (e) => {
  if (!device && (e as USBConnectionEvent).device.configuration?.interfaces?.some((i) => i.alternates.some((a) => a.interfaceClass === 7))) {
    device = (e as USBConnectionEvent).device;
    await openDevice();
  }
});
navigator.usb?.addEventListener?.('disconnect', () => {
  if (device) {
    device = null;
    endpoint = null;
    interfaceNumber = -1;
    printer.connected.value = false;
    printer.name.value = null;
  }
});

/** Reconnect a previously paired printer on boot, without a picker. */
export async function resumePrinter(): Promise<void> {
  if (!navigator.usb) return;
  try {
    const devices = await navigator.usb.getDevices();
    const prior = devices[0];
    if (prior) {
      device = prior;
      await openDevice();
    }
  } catch {
    // WebUSB refused (permissions): the Settings button still works.
  }
}

export async function printBytes(bytes: number[]): Promise<boolean> {
  if (!device || !printer.connected.value) return false;
  try {
    const data = new Uint8Array(bytes);
    if (device.opened === false) await openDevice();
    // Send in 4KB chunks: some printers' buffers choke on larger transfers.
    for (let i = 0; i < data.length; i += 4096) {
      await device.transferOut(endpoint?.endpointNumber ?? 1, data.slice(i, i + 4096));
    }
    return true;
  } catch {
    printer.connected.value = false;
    return false;
  }
}

/** The one-tap path: receipt to paper, then the drawer if asked. */
export async function printReceipt(r: Receipt, store: { name: string; address?: string[]; footer?: string }): Promise<boolean> {
  return await printBytes(escposReceipt(r, store));
}

export async function kick(): Promise<boolean> {
  return await printBytes(kickDrawer());
}
