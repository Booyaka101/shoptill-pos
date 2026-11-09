import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** WP-CLI on the dev shop, for what a till can't change itself. */
export const wp = (...args: string[]) =>
  execFileSync('docker', ['compose', 'run', '--rm', 'cli', ...args], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    stdio: 'pipe',
  });

/** Runs PHP against one product as `$p`, then saves it. */
export const editProduct = (id: number, php: string) => wp('eval', `$p = wc_get_product(${id}); ${php} $p->save();`);
