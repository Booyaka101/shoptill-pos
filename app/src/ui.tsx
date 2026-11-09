import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { listenForScans, SCAN_GAP } from './barcode';
import { uid } from './cart';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function Modal(props: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean; footer?: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      const modals = document.querySelectorAll('.modal');
      if (modals[modals.length - 1] !== ref.current) return;
      if (e.key === 'Escape') onClose.current();
      else if (e.key === 'Tab') {
        // Keep keyboard focus inside the top dialog instead of the till behind it.
        const items = [...ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
        e.preventDefault();
        items[next].focus();
      }
    };
    window.addEventListener('keydown', onKey);
    (ref.current?.querySelector<HTMLElement>('[autofocus]') ?? ref.current)?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  // Only a press that starts on the backdrop closes it, not a text selection dragged out of the dialog.
  const downOnBackdrop = useRef(false);
  return (
    <div
      class="overlay"
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => e.target === e.currentTarget && downOnBackdrop.current && props.onClose()}
    >
      <div class={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref} tabIndex={-1}>
        <header>
          <h2>{props.title}</h2>
          <button class="icon" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </header>
        <div class="modal-body">{props.children}</div>
        {props.footer && <footer>{props.footer}</footer>}
      </div>
    </div>
  );
}

const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '⌫'];

/**
 * Cash-register style entry: digits fill from the right, so 1 2 5 0 reads 12.50. Works with a
 * physical keyboard too. A suggested amount is replaced by the first digit typed, not added to;
 * change `suggestion` whenever the parent suggests a new amount.
 */
export function Keypad(props: { cents: string; suggestion?: unknown; onChange: (cents: string) => void; onEnter: (cents: string) => void }) {
  const pad = useRef<HTMLDivElement>(null);
  // Keys can arrive faster than re-renders, so build on the last value typed, not the last rendered.
  const value = useRef(props.cents);
  value.current = props.cents;
  const fresh = useRef(true);
  const seen = useRef(props.suggestion);
  if (seen.current !== props.suggestion) {
    seen.current = props.suggestion;
    fresh.current = true;
  }
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;

  const press = (k: string) => {
    const cents = fresh.current && k !== '⌫' ? '' : value.current;
    if (k !== '⌫' && cents.length >= 10) return;
    fresh.current = false;
    value.current = k === '⌫' ? cents.slice(0, -1) : (cents + k).replace(/^0+/, '');
    onChange.current(value.current);
  };

  // A barcode scanned while the keypad has the keyboard types digits into it; put the entry back.
  const beforeBurst = useRef({ value: value.current, fresh: true, at: 0 });
  useEffect(
    () =>
      listenForScans(() => {
        const b = beforeBurst.current;
        if (performance.now() - b.at > SCAN_GAP) return;
        value.current = b.value;
        fresh.current = b.fresh;
        onChange.current(b.value);
      }),
    [],
  );

  // The button last tapped, which leaves Enter to the keypad; one tabbed to takes Enter as its own press.
  const tapped = useRef<Element | null>(null);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      tapped.current = e.target instanceof Element ? e.target.closest('button, a') : null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') tapped.current = null;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const modals = document.querySelectorAll('.modal');
      if (modals.length && !modals[modals.length - 1].contains(pad.current)) return;
      const now = performance.now();
      if (now - beforeBurst.current.at > SCAN_GAP) beforeBurst.current = { value: value.current, fresh: fresh.current, at: now };
      else beforeBurst.current.at = now;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('⌫');
      else if (e.key === 'Enter') {
        const button = e.target instanceof Element ? e.target.closest('button, a') : null;
        if (button && button !== tapped.current && !pad.current?.contains(button)) return;
        // Also stops Enter from re-clicking whichever keypad button has focus.
        e.preventDefault();
        // What was typed, which may not have rendered yet.
        props.onEnter(value.current);
      }
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey);
    };
  });
  return (
    <div class="keypad" ref={pad}>
      {KEYS.map((k) => (
        <button key={k} type="button" onClick={() => press(k)} aria-label={k === '⌫' ? 'Backspace' : k}>
          {k}
        </button>
      ))}
    </div>
  );
}

export const centsToAmount = (cents: string, decimals: number) => Number(cents || '0') / 10 ** decimals;
export const amountToCents = (amount: number, decimals: number) => String(Math.round(amount * 10 ** decimals) || '');

const unanswered = new Map<string, { body: string; id: string }>();

/**
 * The same id for the same request sent again, so a retry after a lost answer isn't made twice, even from
 * the dialog opened again. Once it is answered, the same request made later is a new one.
 */
export function requestIds(scope: string) {
  return {
    id(body: object) {
      const key = JSON.stringify(body);
      let last = unanswered.get(scope);
      if (last?.body !== key) unanswered.set(scope, (last = { body: key, id: uid() }));
      return last.id;
    },
    // Only the request that was answered, not a different one started while it was on its way.
    answered: (id: string) => unanswered.get(scope)?.id === id && unanswered.delete(scope),
  };
}

export function Spinner() {
  return <span class="spinner" aria-label="Loading" />;
}

/**
 * −/+ around whatever sits between them (an editable input, or a plain count).
 * A tap steps once; a press that stays down keeps stepping — one step for the
 * tap, then a step every 110ms — so quantity 12 is one press, not eleven.
 * The live value is read through a ref, so the repeats build on each other
 * rather than the one captured when the press began.
 */
export function Stepper(props: {
  value: number;
  onChange: (n: number) => void;
  max?: number;
  less: string;
  more: string;
  children: ComponentChildren;
}) {
  const live = useRef(props);
  live.current = props;
  const hold = useRef<{ timeout: number; interval: number } | null>(null);
  const repeated = useRef(false);

  const step = (dir: 1 | -1) => {
    const { value, onChange, max } = live.current;
    const next = Math.max(0, Math.min(max ?? Infinity, value + dir));
    if (next !== value) onChange(next);
  };
  const stop = () => {
    if (!hold.current) return;
    clearTimeout(hold.current.timeout);
    clearInterval(hold.current.interval);
    hold.current = null;
  };
  useEffect(() => stop, []);
  const start = (e: PointerEvent, dir: 1 | -1) => {
    if (e.button !== 0) return;
    stop();
    repeated.current = false;
    const timeout = window.setTimeout(() => {
      hold.current!.interval = window.setInterval(() => {
        repeated.current = true;
        step(dir);
      }, 110);
    }, 420);
    hold.current = { timeout, interval: 0 };
  };

  const key = (dir: 1 | -1, label: string) => (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(e) => start(e, dir)}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onClick={() => {
        if (repeated.current) {
          repeated.current = false;
          return;
        }
        step(dir);
      }}
    >
      {dir < 0 ? '−' : '+'}
    </button>
  );

  return (
    <div class="stepper">
      {key(-1, props.less)}
      {props.children}
      {key(1, props.more)}
    </div>
  );
}
