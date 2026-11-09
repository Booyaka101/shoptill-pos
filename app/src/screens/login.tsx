import { useEffect, useRef, useState } from 'preact/hooks';
import { config } from '../api';
import { getKv, setKv } from '../db';
import { signIn } from '../sync';
import { Spinner } from '../ui';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const usernameEdited = useRef(false);

  // The device knows who was last here; typing a username is the slowest part
  // of starting a shift, and it is almost always the same person.
  useEffect(() => {
    let active = true;
    void getKv<string>('lastUser').then((u) => {
      if (active && !usernameEdited.current && u) setUsername(u);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signIn(username.trim(), password);
      void setKv('lastUser', username.trim()).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="login">
      <form onSubmit={submit}>
        <h1>{config.shopName}</h1>
        <p class="muted">Sign in with your shop account.</p>
        <label>
          Username or email
          <input value={username} onInput={(e) => { usernameEdited.current = true; setUsername(e.currentTarget.value); }} autocomplete="username" autofocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} autocomplete="current-password" required />
        </label>
        {error && <p class="error">{error}</p>}
        <button class="primary big" disabled={busy}>
          {busy ? <Spinner /> : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
