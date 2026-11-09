import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { boot, cart, failedCount, online, openToPack, pendingCount, queue, register, screen, syncing, toast, toPack, type Screen } from './state';
import { chooseRegister, signedIn, updateReady } from './sync';
import { Login } from './screens/login';
import { Orders } from './screens/orders';
import { PrintRoot } from './screens/receipt';
import { Reports } from './screens/reports';
import { Sell } from './screens/sell';
import { Settings } from './screens/settings';
import { Spinner } from './ui';

const NAV: [Screen, string][] = [
  ['sell', 'Sell'],
  ['orders', 'Orders'],
  ['reports', 'Reports'],
  ['settings', 'Settings'],
];

function RegisterPicker() {
  return (
    <main class="login">
      <div class="form">
        <h1>Which register is this?</h1>
        {boot.value!.registers.map((r) => (
          <button key={r.id} class="row-button big" onClick={() => chooseRegister(r)}>
            <strong>{r.name}</strong>
            {r.outlet && <span class="muted">{r.outlet}</span>}
          </button>
        ))}
      </div>
    </main>
  );
}

const LATE = 30 * 60_000;

function SyncStatus() {
  // Ticks, so a sale stuck on the device gets noticed even when nothing else changes.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const pending = pendingCount.value;
  const failed = failedCount.value;
  const waited = pending ? now - Math.min(...queue.value.filter((q) => q.status === 'pending').map((q) => q.created_at)) : 0;
  const late = waited > LATE;
  const minutes = Math.round(waited / 60_000);
  const age = minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  let text = online.value ? 'Online' : 'Offline';
  if (failed) text = `${failed} failed`;
  else if (late) text = `${pending} to sync, oldest ${age}`;
  else if (pending) text = `${pending} to sync`;
  let title = online.value ? 'Connected to the shop' : 'Sales are saved on this device and sync when the connection is back';
  if (late) title = `A sale has been waiting ${age} to reach the shop. Until it does, it isn't in the shop's stock or reports.`;
  return (
    <button class={`status-pill ${failed ? 'bad' : late || !online.value ? 'off' : 'ok'}`} onClick={() => (screen.value = 'orders')} title={title}>
      {syncing.value ? <Spinner /> : <span class="dot" />} <span class="status-text">{text}</span>
    </button>
  );
}

export function App() {
  if (signedIn.value === null) return <main class="login"><Spinner /></main>;
  if (!signedIn.value) return <Login />;
  if (!register.value) return <RegisterPicker />;
  const waiting = toPack.value.web + toPack.value.later;

  return (
    <>
      <div class="app">
        <header class="topbar">
          <nav>
            {NAV.map(([key, label]) => (
              <Fragment key={key}>
                <button class={screen.value === key ? 'active' : ''} onClick={() => (screen.value = key)}>
                  {label}
                </button>
                {key === 'orders' && waiting > 0 && (
                  <button
                    class="badge"
                    aria-label={`${waiting} order${waiting === 1 ? '' : 's'} to pack`}
                    onClick={() => {
                      screen.value = 'orders';
                      openToPack.value = toPack.value.web ? 'web' : 'later';
                    }}
                  >
                    {waiting}
                  </button>
                )}
              </Fragment>
            ))}
          </nav>
          <span class="register-name">{register.value.name}</span>
          {updateReady.value && (
            <button
              class="status-pill"
              disabled={cart.value.lines.length > 0}
              onClick={() => location.reload()}
              title={cart.value.lines.length ? 'Finish or park this sale first' : 'A newer version of ShopTill is installed on the shop'}
            >
              Update
            </button>
          )}
          <SyncStatus />
        </header>
        {screen.value === 'sell' && <Sell />}
        {screen.value === 'orders' && <Orders />}
        {screen.value === 'reports' && <Reports />}
        {screen.value === 'settings' && <Settings />}
      </div>
      {/* Mounted before anything is said in them, or screen readers may not announce it. */}
      <div role="status">
        {toast.value?.kind === 'info' && (
          <div class={`toast info${toast.value.undo ? ' can-touch' : ''}`}>
            {toast.value.text}
            {toast.value.undo && (
              <button
                class="undo"
                onClick={() => {
                  const undo = toast.value!.undo!;
                  toast.value = null;
                  undo();
                }}
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>
      <div role="alert">{toast.value?.kind === 'error' && <div class="toast error">{toast.value.text}</div>}</div>
      <PrintRoot />
    </>
  );
}
