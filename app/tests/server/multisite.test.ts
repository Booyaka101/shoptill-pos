import { describe, expect, it } from 'vitest';
import { wp } from '../wp';

const url = process.env.SHOPTILL_URL;
const token = process.env.SHOPTILL_ADMIN_TOKEN;

// Run only after converting the disposable test shop, never against a normal single-site fixture.
describe.skipIf(process.env.SHOPTILL_MULTISITE !== '1' || !url || !token)('unsupported Multisite credentials', () => {
  it('does not issue or accept till credentials after the site becomes Multisite', async () => {
    expect(wp('eval', 'echo is_multisite() ? "network" : "single";').toString()).toBe('network');
    // Conversion does not copy this single-site option. Enable core authentication so the
    // existing credential reaches ShopTill's guard instead of being rejected by WordPress first.
    wp('site', 'option', 'update', 'using_application_passwords', '1');
    const passwordCount = () => wp('eval', `echo count(WP_Application_Passwords::get_user_application_passwords(get_user_by('login', 'admin')->ID));`).toString();
    const before = passwordCount();
    const login = await fetch(`${url}/wp-json/shoptill/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin', device: 'unsupported network' }),
    });
    expect(login.status).toBe(501);
    expect((await login.json()).code).toBe('shoptill_multisite');
    const existing = await fetch(`${url}/wp-json/shoptill/v1/bootstrap`, {
      headers: { Authorization: `Basic ${token}` },
    });
    expect(existing.status).toBe(403);
    expect((await existing.json()).code).toBe('shoptill_multisite');
    expect(passwordCount()).toBe(before);
  }, 60_000);
});
