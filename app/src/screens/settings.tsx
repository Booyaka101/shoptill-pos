import { useState } from 'preact/hooks';
import { config } from '../api';
import { clearAll } from '../db';
import { connectPrinter, escposReceipt, kick, printer, printBytes, resumePrinter } from '../escpos';
import { idleSignout, kiosk } from '../kiosk';
import { ACCENTS, accent, accentCustom, density, haptics, solid, sounds, textSize, trueBlack } from '../prefs';
import { boot, lastSync, pendingCount, products, register, syncing, theme } from '../state';
import { chooseRegister, loadQueue, pollStock, signOut, syncCatalogue } from '../sync';
import { Spinner } from '../ui';

export function Settings() {
  const [message, setMessage] = useState('');
  const b = boot.value!;

  const resync = async () => {
    setMessage('');
    try {
      await syncCatalogue(true);
      await pollStock();
      setMessage(`Synced ${products.value.size} products.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  // Read from the device, not this tab's copy: another tab may have queued sales since.
  const logout = async () => {
    const pending = (await loadQueue()).length;
    if (pending && !confirm(`${pending} sale${pending === 1 ? ' has' : 's have'} not synced yet. They stay on this device and sync after the next sign-in. Sign out?`)) return;
    await signOut();
  };

  const reset = async () => {
    const unsynced = () => alert('Sync or discard the unsynced sales first.');
    if ((await loadQueue()).length) return unsynced();
    if (!confirm('Remove all shop data from this device and sign out?')) return;
    if (!(await clearAll())) return unsynced();
    await signOut();
    location.reload();
  };

  return (
    <main class="settings">
      <section>
        <h2>Till</h2>
        <label>
          Register
          <select
            value={register.value?.id}
            onChange={(e) => {
              const r = b.registers.find((x) => x.id === e.currentTarget.value);
              if (r) chooseRegister(r);
            }}
          >
            {b.registers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.outlet ? ` (${r.outlet})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Appearance
          <select value={theme.value} onChange={(e) => (theme.value = e.currentTarget.value as typeof theme.value)}>
            <option value="system">Match device</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <div class="field">
          Accent colour
          <div class="swatches">
            {ACCENTS.map((a) => (
              <button
                key={a}
                type="button"
                class={`swatch${!accentCustom.value && accent.value === a ? ' active' : ''}`}
                data-swatch={a}
                aria-label={`${a[0].toUpperCase()}${a.slice(1)} accent`}
                aria-pressed={!accentCustom.value && accent.value === a}
                onClick={() => {
                  accentCustom.value = null;
                  accent.value = a;
                }}
              />
            ))}
            {/* The shop's own colour, whatever it is; it wins over the presets. */}
            <input
              type="color"
              class={`swatch colour${accentCustom.value ? ' active' : ''}`}
              aria-label="Custom colour"
              title="Custom colour"
              value={accentCustom.value ?? '#0891b2'}
              onInput={(e) => (accentCustom.value = e.currentTarget.value)}
            />
          </div>
        </div>
        <label>
          Product tiles
          <select value={density.value} onChange={(e) => (density.value = e.currentTarget.value as typeof density.value)}>
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact — more on screen</option>
          </select>
        </label>
        <label>
          Text size
          <select value={textSize.value} onChange={(e) => (textSize.value = e.currentTarget.value as typeof textSize.value)}>
            <option value="standard">Standard</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label class="check">
          <input type="checkbox" checked={trueBlack.value} onChange={(e) => (trueBlack.value = e.currentTarget.checked)} />
          True black dark theme (OLED screens)
        </label>
        <label class="check">
          <input type="checkbox" checked={solid.value} onChange={(e) => (solid.value = e.currentTarget.checked)} />
          Solid panels instead of glass (easier on older screens)
        </label>
        <label class="check">
          <input type="checkbox" checked={sounds.value} onChange={(e) => (sounds.value = e.currentTarget.checked)} />
          Play a chime when a sale completes
        </label>
        <label class="check">
          <input type="checkbox" checked={haptics.value} onChange={(e) => (haptics.value = e.currentTarget.checked)} />
          Buzz the phone when an item is added
        </label>
      </section>

      <section>
        <h2>Kiosk</h2>
        <label class="check">
          <input type="checkbox" checked={kiosk.value} onChange={(e) => (kiosk.value = e.currentTarget.checked)} />
          Kiosk mode (full screen, screen stays on, right-click and dragging off)
        </label>
        <label class="check">
          <input type="checkbox" checked={idleSignout.value} onChange={(e) => (idleSignout.value = e.currentTarget.checked)} />
          Sign out after five minutes untouched
        </label>
        <p class="muted small">
          For a till that boots into itself and nothing else, set the device up with Windows assigned access or Android screen
          pinning: see Kiosk setup in the plugin's docs folder. Esc leaves full screen; the next tap returns.
        </p>
      </section>

      <section>
        <h2>Receipt printer</h2>
        {printer.connected.value ? (
          <p>
            Connected to <strong>{printer.name.value}</strong>. Receipts print straight to it, the drawer kicks on cash
            sales, and the browser's print dialog is only a fallback.
          </p>
        ) : 'usb' in navigator ? (
          <p class="muted">A thermal printer on USB: receipts print with one tap and the cash drawer kicks on cash sales, no print dialog.</p>
        ) : (
          <p class="muted">This browser cannot talk to USB printers (Chrome or Edge can). Receipts keep using the browser's print dialog.</p>
        )}
        <div class="row-actions">
          {'usb' in navigator && (
            <>
              <button onClick={() => void connectPrinter()} disabled={printer.connected.value}>
                {printer.connected.value ? 'Connected' : 'Connect printer'}
              </button>
              <button
                onClick={() =>
                  void printBytes([
                    ...escposReceipt(
                      {
                        client_id: 'test', number: null, date: Date.now(),
                        lines: [{ name: 'Printer test', qty: 1, unit: 0, total: 0, discount: 0, sku: '', meta: '' }],
                        subtotal: 0, discount: 0, coupons: [], taxes: [], tax: 0, total: 0,
                        prices_include_tax: false, payments: [], customer: '', email: '', note: '',
                        register: register.value?.name ?? '', cashier: boot.value?.user.name ?? '',
                        refunded: 0,
                      },
                      { name: config.shopName, footer: 'If you can read this, the printer is set up.' },
                    ),
                  ])
                }
                disabled={!printer.connected.value}
              >
                Test print
              </button>
              <button onClick={() => void kick()} disabled={!printer.connected.value}>
                Kick drawer
              </button>
            </>
          )}
        </div>
      </section>

      <section>
        <h2>Sync</h2>
        <p>
          {products.value.size} products on this device. Last synced {lastSync.value ? new Date(lastSync.value * 1000).toLocaleString() : 'never'}.
        </p>
        <p>{pendingCount.value ? `${pendingCount.value} sales waiting to sync.` : 'No sales waiting.'}</p>
        <button onClick={resync} disabled={syncing.value}>
          {syncing.value ? <Spinner /> : 'Re-sync products'}
        </button>
        {message && <p class="muted">{message}</p>}
      </section>

      <section>
        <h2>Account</h2>
        <p>
          Signed in as <strong>{b.user.name}</strong> on {b.store.store_name}.
        </p>
        <div class="row-actions">
          <button onClick={logout}>Sign out</button>
          <button class="danger" onClick={reset}>
            Remove shop data from this device
          </button>
        </div>
        <p class="muted small">ShopTill {config.version}</p>
      </section>
    </main>
  );
}
