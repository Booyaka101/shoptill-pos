import { render } from 'preact';
import { App } from './app';
import { config } from './api';
import { startKiosk } from './kiosk';
import { startPrefs } from './prefs';
import { startRecent } from './recent';
import { persist } from './state';
import { restore, startBackgroundSync } from './sync';
import './styles.css';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // swUrl is where the shop serves the worker, which with plain permalinks is not under appUrl.
  navigator.serviceWorker.register(config.swUrl ?? `${config.appUrl}sw.js`, { scope: config.appUrl }).catch(() => {});
}

startKiosk();
startPrefs();
startRecent();

const root = document.getElementById('app')!;
render(<App />, root);

restore().then(
  () => {
    persist();
    startBackgroundSync();
  },
  (e) =>
    render(
      <main class="login">
        <p class="error">This device's storage could not be opened, so the till can't start: {e instanceof Error ? e.message : String(e)}</p>
        <button class="primary" onClick={() => location.reload()}>Try again</button>
      </main>,
      root,
    ),
);
