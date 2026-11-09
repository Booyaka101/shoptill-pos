// Checks the REST API's rules for sales against a dev store: what it refuses online, what it accepts from a
// till that was offline, idempotency, pay later and what a till token can reach.
// SHOPTILL_URL=http://localhost:8088 SHOPTILL_TOKEN=<cashier token> SHOPTILL_ADMIN_TOKEN=<admin token> npx vitest run tests/server
import { describe, expect, it } from 'vitest';
import { editProduct, wp } from '../wp';

const url = process.env.SHOPTILL_URL;
const token = process.env.SHOPTILL_TOKEN;
const adminToken = process.env.SHOPTILL_ADMIN_TOKEN;

async function call(path: string, body?: unknown, root = 'shoptill/v1/', as = token): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}/wp-json/${root}${path}`, {
    method: body ? 'POST' : 'GET',
    // Apache drops a keep-alive socket idle for 5s, which a wp() call outlasts, and a reused one can reset.
    headers: { Authorization: `Basic ${as}`, 'Content-Type': 'application/json', Connection: 'close' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

/** Runs `fn` with a must-use plugin on the shop, for behaviour no setting switches on. */
async function withPlugin(php: string, fn: () => Promise<void>) {
  const code = Buffer.from(`<?php ${php}`).toString('base64');
  wp('eval', `wp_mkdir_p(WPMU_PLUGIN_DIR); file_put_contents(WPMU_PLUGIN_DIR . '/shoptill-test.php', base64_decode('${code}'));`);
  try {
    await fn();
  } finally {
    wp('eval', `@unlink(WPMU_PLUGIN_DIR . '/shoptill-test.php'); delete_option('shoptill_test_die');`);
  }
}

/** A sale lands after the stock check, immediately before WooCommerce writes the adjustment. */
const withSaleDuringStockWrite = (id: number, fn: () => Promise<void>) => withPlugin(
  `add_filter('woocommerce_update_product_stock_query', function ($sql, $id, $quantity, $operation) {
    static $sold = false;
    if (!$sold && $id === ${id} && in_array($operation, array('set', 'increase'), true)) {
      $sold = true;
      wc_update_product_stock($id, 1, 'decrease');
    }
    return $sql;
  }, 10, 4);`,
  fn,
);

/** Stands in for a hook that times out: the next request dies there, and the till never hears back. */
const dieOnce = (hook: string, fn: () => Promise<void>) =>
  withPlugin(`add_action('${hook}', function () { if (get_option('shoptill_test_die')) { delete_option('shoptill_test_die'); exit; } }, 20);`, async () => {
    wp('eval', `update_option('shoptill_test_die', 1);`);
    await fn();
    expect(wp('eval', `echo get_option('shoptill_test_die') ? 'armed' : 'died';`).toString()).toBe('died');
  });

/** The subjects of mail WordPress sent to `to` while `fn` ran. */
async function mailTo(to: string, fn: () => Promise<void>) {
  await withPlugin(
    `add_filter('pre_wp_mail', function ($sent, $atts) { if (in_array('${to}', (array) $atts['to'], true)) update_option('shoptill_test_mail', array_merge(get_option('shoptill_test_mail', array()), array($atts['subject']))); return $sent; }, 10, 2);`,
    fn,
  );
  return JSON.parse(wp('eval', `echo wp_json_encode(get_option('shoptill_test_mail', array())); delete_option('shoptill_test_mail');`).toString()) as string[];
}

/** Signs in with a password the way the till's login screen does, and returns the till token. */
async function signIn(username: string, password: string) {
  const res = await fetch(`${url}/wp-json/shoptill/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, device: 'test' }),
  });
  return ((await res.json()) as { token: string }).token;
}

const now = () => Math.floor(Date.now() / 1000);
const round2 = (n: number) => Math.round(n * 100) / 100;
const clientId = () => `test-${Math.random().toString(36).slice(2, 12)}`;

describe.skipIf(!url || !token)('sales API', () => {
  let product: { id: number; price: number; regular_price: number; sku: string };
  let stocked: { id: number; price: number; regular_price: number; stock_quantity: number; pinned: boolean };
  let register: string;
  let total: number;

  const sale = (extra: Record<string, unknown>) =>
    call('orders', {
      client_id: clientId(),
      register_id: register,
      lines: [{ product_id: product.id, qty: 1, price: product.price }],
      payments: [{ method: 'cash', amount: total }],
      created_at: now(),
      ...extra,
    });
  const onAccount = async (qty: number) => {
    const { json: customers } = await call('customers?search=jo');
    return (await sale({ lines: [{ product_id: product.id, qty, price: product.price }], payments: [], customer_id: customers[0].id, pay_later: true })).json;
  };
  // A sale paid a cent is refused with the total it needed, which also tells us a product's price with tax.
  const due = async (extra: Record<string, unknown>) => (await sale({ ...extra, payments: [{ method: 'cash', amount: 0.01 }] })).json.data.total as number;
  const refund = (order: { id: number }, body: Record<string, unknown>) =>
    call(`orders/${order.id}/refund`, { method: 'cash', register_id: register, ...body }, undefined, adminToken);
  const cashRefunds = async () =>
    (await call(`reports/summary?register_id=${register}`)).json.by_method.find((m: any) => m.method === 'cash')?.refunds ?? 0;

  it('loads the shop', async () => {
    const boot = (await call('bootstrap')).json;
    register = boot.registers[0].id;
    const { products } = (await call('products?per_page=100')).json;
    product = products.find((p: any) => p.type === 'simple' && p.price && !p.manage_stock);
    stocked = products.find((p: any) => p.type === 'simple' && p.price && p.manage_stock && !p.on_sale);
    expect(product && stocked).toBeTruthy();
    total = await due({});
    expect(total).toBeGreaterThan(0);
  });

  it('refuses malformed line amounts instead of silently turning them into a free sale', async () => {
    for (const price of [[], {}, 'bad', '1e999', null, -1]) {
      const response = await sale({ lines: [{ product_id: product.id, qty: 1, price }], payments: [] });
      expect(response.status).toBe(422);
      expect(response.json.code).toBe('shoptill_price');
    }
  });

  it('refuses malformed quantities, discounts, and non-list items', async () => {
    for (const key of ['qty', 'discount']) {
      const response = await sale({ lines: [{ product_id: product.id, qty: 1, [key]: '1e999' }] });
      expect(response.status).toBe(422);
      expect(response.json.code).toBe(`shoptill_${key}`);
    }
    for (const lines of [[null], ['bad'], { 7: { product_id: product.id, qty: 1, discount: 1 } }]) {
      const response = await sale({ lines });
      expect(response.status).toBe(422);
      expect(response.json.code).toBe('shoptill_line');
    }
  });

  it('refuses invalid tips and payment amounts before saving an order', async () => {
    for (const tip of [-1, [], 'bad', '1e999']) {
      const response = await sale({ tip });
      expect(response.status).toBe(422);
      expect(response.json.code).toBe('shoptill_tip');
    }
    for (const amount of [[], 'bad', '1e999', null]) {
      const response = await sale({ payments: [{ method: 'cash', amount }] });
      expect(response.status).toBe(422);
      expect(response.json.code).toBe('shoptill_payment');
    }
  });

  it('refuses overflowing catalogue prices and stock counts without changing the product', async (ctx) => {
    if (!adminToken) ctx.skip();
    const before = (await call(`products/${stocked.id}`, {}, undefined, adminToken)).json;
    for (const key of ['regular_price', 'sale_price', 'stock']) {
      const response = await call(`products/${stocked.id}`, { [key]: '1e999' }, undefined, adminToken);
      expect(response.status).toBe(422);
    }
    const after = (await call(`products/${stocked.id}`, {}, undefined, adminToken)).json;
    expect(after).toEqual(before);
  });

  it('gives a coupon use back when the sale is refused', async () => {
    for (const _ of [1, 2]) expect((await sale({ coupons: ['ONCE'], payments: [{ method: 'cash', amount: 0.01 }] })).json.code).toBe('shoptill_underpaid');
    const preview = await call('orders/preview', { lines: [{ product_id: product.id, qty: 1 }], coupons: ['ONCE'] });
    expect(preview.status).toBe(200);
  });

  it('refuses an overpaid sale made online', async () => {
    const r = await sale({ payments: [{ method: 'cash', amount: total + 1 }] });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('shoptill_overpaid');
  });

  it('refuses an underpaid sale made online', async () => {
    const r = await sale({ payments: [{ method: 'cash', amount: 0.01 }] });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('shoptill_underpaid');
  });

  it('keeps a sale whose coupon came to something else by the time it synced, as the till charged it', async () => {
    const lines = [{ product_id: product.id, qty: 5, price: product.price }];
    const full = await due({ lines });
    // Charged with no discount showing, as a coupon the shop couldn't price leaves it.
    const over = await sale({ lines, coupons: ['FIVEOFF'], payments: [{ method: 'cash', amount: full }], expected_total: full });
    expect(over.status).toBe(200);
    expect(over.json.total).toBeLessThan(full);
    // Charged a discount the coupon no longer gives, the rest is owed.
    const short = round2(over.json.total - 2);
    const under = await sale({ lines, coupons: ['FIVEOFF'], payments: [{ method: 'cash', amount: short }], expected_total: short });
    expect(under.json.status).toBe('on-hold');
    expect(under.json.owed).toBeCloseTo(2, 2);
    expect((await sale({ lines, coupons: ['FIVEOFF'], payments: [{ method: 'cash', amount: full }] })).json.code).toBe('shoptill_overpaid');
  });

  it('keeps an underpaid sale that was queued offline, on hold with the balance owed', async () => {
    const r = await sale({ payments: [{ method: 'cash', amount: 0.01 }], created_at: now() - 3600 });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('on-hold');
    expect(r.json.owed).toBeGreaterThan(0);
  });

  it('keeps an offline sale whose register and payment method are gone', async () => {
    const r = await sale({ register_id: 'long-gone', payments: [{ method: 'bank', amount: total }], created_at: now() - 3600 });
    expect(r.status).toBe(200);
    expect(r.json.register.name).toBe('long-gone');
  });

  it('keeps a deleted tax-free product tax-free when its offline sale syncs', async () => {
    const lines = [{ product_id: 99999999, qty: 2, price: 5, name: 'Gift card', tax_class: '', taxable: false }];
    const r = await sale({ lines, payments: [{ method: 'cash', amount: 10 }], created_at: now() - 3600 });
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(10);
    expect(r.json.total_tax).toBe(0);
    expect(r.json.status).toBe('completed');
  });

  it('keeps an offline custom item whose tax class has since been removed', async () => {
    const lines = [{ qty: 1, price: 5, name: 'Old stock', tax_class: 'long-gone-rate' }];
    expect((await sale({ lines, payments: [{ method: 'cash', amount: 5 }] })).json.code).toBe('shoptill_custom_item');
    const r = await sale({ lines, payments: [{ method: 'cash', amount: 5 }], created_at: now() - 3600 });
    expect(r.status).toBe(200);
    expect(r.json.items[0].name).toBe('Old stock');
  });

  it('leaves no half-made order behind when the first try at a sale died after its first save', async () => {
    const since = now() - 1;
    const client_id = clientId();
    await dieOnce('woocommerce_new_order', async () => {
      await sale({ client_id }).catch(() => null);
      expect((await sale({ client_id })).status).toBe(200);
    });
    const pending = wp('eval', `echo count(wc_get_orders(array('limit' => -1, 'status' => 'pending', 'date_created' => '>=' . ${since}, 'return' => 'ids')));`).toString();
    expect(pending).toBe('0');
  }, 60_000);

  it('makes the sale again when the first try died between saving its details and its status', async () => {
    // The legacy store saves an order's meta before its status, and HPOS the other way round.
    for (const died of [`$o->set_status('pending');`, `$o->delete_meta_data('_shoptill_client_id');`]) {
      const client_id = clientId();
      const first = (await sale({ client_id })).json;
      wp('eval', `$o = wc_get_order(${first.id}); ${died} $o->save();`);
      const again = await sale({ client_id });
      expect(again.status).toBe(200);
      expect(again.json.id).not.toBe(first.id);
      expect(again.json.status).not.toBe('pending');
      expect(wp('eval', `echo wc_get_order(${first.id}) ? 'kept' : 'gone';`).toString()).toBe('gone');
    }
  }, 60_000);

  it('saves a sale once however many times it is sent at once', async () => {
    const body = { client_id: clientId(), register_id: register, lines: [{ product_id: product.id, qty: 1, price: product.price }], payments: [{ method: 'cash', amount: total }], created_at: now() };
    const results = await Promise.all([1, 2, 3].map(() => call('orders', body)));
    expect(results.every((r) => r.status === 200 || r.json.code === 'shoptill_in_progress')).toBe(true);
    const saved = wp('eval', `echo count(wc_get_orders(array('limit' => -1, 'meta_key' => '_shoptill_client_id', 'meta_value' => '${body.client_id}', 'return' => 'ids')));`).toString();
    expect(saved).toBe('1');
  });

  it('leaves refunds to staff who may give them', async () => {
    const a = (await sale({})).json;
    const r = await call(`orders/${a.id}/refund`, { lines: [{ item_id: a.items[0].id, qty: 1 }], method: 'cash' });
    expect(r.status).toBe(403);
  });

  it.skipIf(!adminToken)('refunds only lines of the order being refunded', async () => {
    const a = (await sale({})).json;
    const b = (await sale({})).json;
    const r = await refund(a, { lines: [{ item_id: b.items[0].id, qty: 1 }] });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('shoptill_refund_line');
  });

  it.skipIf(!adminToken)('refunds a line unit by unit to exactly what it cost', async () => {
    // The discount on the line makes this staff's sale: cashiers no longer give discounts.
    // The owed amount is probed as staff for the same reason (a cashier probe is refused outright).
    const lines = [{ product_id: product.id, qty: 3, price: product.price, discount: 0.01 }];
    const owed = (await call('orders', { client_id: clientId(), register_id: register, lines, payments: [{ method: 'cash', amount: 0.01 }] }, undefined, adminToken)).json.data.total as number;
    const order = (await call('orders', { client_id: clientId(), register_id: register, lines, payments: [{ method: 'cash', amount: owed }] }, undefined, adminToken)).json;
    for (const _ of [1, 2, 3]) expect((await refund(order, { lines: [{ item_id: order.items[0].id, qty: 1 }] })).status).toBe(200);
    const after = (await call(`orders/${order.id}`)).json;
    expect(after.refunded).toBe(order.total);
    expect(after.status).toBe('refunded');
  });

  it.skipIf(!adminToken)('takes back an item that was given away', async () => {
    const order = (await sale({ lines: [{ product_id: product.id, qty: 1, price: 0 }], payments: [] })).json;
    expect(order.total).toBe(0);
    const r = await refund(order, { lines: [{ item_id: order.items[0].id, qty: 1 }], restock: true });
    expect(r.status).toBe(200);
    expect((await refund(order, { amount: 0 })).status).toBe(422);
  });

  it('finds a customer by first and last name', async () => {
    for (const search of ['Bloggs', 'Jo Bloggs']) {
      const { json } = await call(`customers?search=${encodeURIComponent(search)}`);
      expect(json.map((c: any) => `${c.first_name} ${c.last_name}`)).toContain('Jo Bloggs');
    }
  });

  it('keeps a sale queued for more than 30 days as a late one, dated today', async () => {
    const r = await sale({ register_id: 'long-gone', created_at: now() - 31 * 86400 });
    expect(r.status).toBe(200);
    expect(r.json.register.name).toBe('long-gone');
    expect(r.json.date).toBeGreaterThan(now() - 600);
  });

  it('takes a later payment only at a register the shop has', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    const order = await onAccount(1);
    expect((await call(`orders/${order.id}/pay`, { payments: [{ method: 'card', amount: 1 }] })).json.code).toBe('shoptill_register');
  });

  it('applies a retried payment once', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    const order = await onAccount(1);
    const pay = () => call(`orders/${order.id}/pay`, { payments: [{ method: 'card', amount: 1 }], register_id: register, request_id: 'pay-once' });
    expect((await pay()).status).toBe(200);
    const again = await pay();
    expect(again.status).toBe(200);
    expect(again.json.payments).toHaveLength(1);
    expect(again.json.owed).toBeCloseTo(order.total - 1, 2);
  });

  it.skipIf(!adminToken)('settles an order once when the payment that paid it off died after saving', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    const order = await onAccount(1);
    await dieOnce('woocommerce_update_order', async () => {
      const pay = () => call(`orders/${order.id}/pay`, { payments: [{ method: 'card', amount: order.owed }], register_id: register, request_id: 'pay-died' });
      await pay().catch(() => null);
      expect((await pay()).status).toBe(200);
    });
    const paid = (await call(`orders/${order.id}`)).json;
    expect(paid.status).not.toBe('on-hold');
    expect(paid.owed).toBe(0);
  }, 60_000);

  it.skipIf(!adminToken)('applies a retried refund once', async () => {
    const order = (await sale({})).json;
    const once = () => refund(order, { amount: 1, request_id: 'refund-once' });
    expect((await once()).status).toBe(200);
    const again = await once();
    expect(again.status).toBe(200);
    expect(again.json.refunds).toHaveLength(1);
  });

  it.skipIf(!adminToken)('applies a refund once when the first try died after saving it', async () => {
    const order = (await sale({})).json;
    const before = await cashRefunds();
    await dieOnce('woocommerce_order_refunded', async () => {
      const once = () => refund(order, { amount: 1, request_id: 'refund-died' });
      await once().catch(() => null);
      const again = await once();
      expect(again.status).toBe(200);
      expect(again.json.refunds).toHaveLength(1);
    });
    // Still counted against the drawer it came out of.
    expect(await cashRefunds()).toBeCloseTo(before + 1, 2);
  }, 60_000);

  it.skipIf(!adminToken)('makes the refund on the retry when the first try died before saving it', async () => {
    const order = (await sale({})).json;
    await dieOnce('woocommerce_before_order_refund_object_save', async () => {
      const once = () => refund(order, { amount: 1, request_id: 'refund-died-early' });
      await once().catch(() => null);
      const again = await once();
      expect(again.status).toBe(200);
      expect(again.json.refunds).toHaveLength(1);
    });
  }, 60_000);

  it.skipIf(!adminToken)('takes a refused request again under the same id', async () => {
    const order = (await sale({})).json;
    expect((await refund(order, { amount: 1, method: 'barter', request_id: 'fix-then-retry' })).json.code).toBe('shoptill_refund_method');
    expect((await refund(order, { amount: 1, request_id: 'fix-then-retry' })).json.refunds).toHaveLength(1);
  });

  it.skipIf(!adminToken)('scales the lines of a refund cut down to what is left', async () => {
    const lines = [{ product_id: product.id, qty: 2, price: product.price }];
    const order = (await sale({ lines, payments: [{ method: 'cash', amount: await due({ lines }) }] })).json;
    expect((await refund(order, { amount: round2(order.total - 1) })).status).toBe(200);
    const r = await refund(order, { lines: [{ item_id: order.items[0].id, qty: 1 }], restock: true });
    const cut = r.json.refunds.find((x: { amount: number }) => x.amount === 1);
    const tax = -Number(wp('eval', `echo wc_get_order(${cut.id})->get_total_tax();`).toString());
    // One of the money back's worth of tax, not a whole item's.
    expect(Math.abs(tax - order.total_tax / order.total)).toBeLessThanOrEqual(0.011);
  }, 30_000);

  it.skipIf(!adminToken)('takes items back after an amount refund has paid them out', async () => {
    const order = (await sale({})).json;
    expect((await refund(order, { amount: order.total })).status).toBe(200);
    const r = await refund(order, { lines: [{ item_id: order.items[0].id, qty: 1 }], restock: true });
    expect(r.status).toBe(200);
    expect(r.json.items[0].qty_refunded).toBe(1);
    expect(r.json.refunded).toBeCloseTo(order.total, 2);
  });

  it.skipIf(!adminToken)('refuses money back with no way to pay it', async () => {
    const order = (await sale({})).json;
    expect((await refund(order, { amount: 1, method: 'barter' })).json.code).toBe('shoptill_refund_method');
  });

  it.skipIf(!adminToken)('takes refunded tax off the tax collected', async () => {
    const before = (await call('reports/summary')).json.totals;
    const order = (await sale({})).json;
    expect(order.total_tax).toBeGreaterThan(0);
    expect((await call('reports/summary')).json.totals.tax).toBeCloseTo(before.tax + order.total_tax, 2);
    expect((await refund(order, { lines: [{ item_id: order.items[0].id, qty: 1 }] })).status).toBe(200);
    const after = (await call('reports/summary')).json.totals;
    expect(after.tax).toBeCloseTo(before.tax, 2);
  }, 30_000);

  it('lets cashiers refund once the shop allows it', async () => {
    const order = (await sale({})).json;
    const body = { amount: 1, method: 'cash', register_id: register };
    expect((await call(`orders/${order.id}/refund`, body)).status).toBe(403);
    wp('option', 'update', 'shoptill_cashier_refunds', 'yes');
    try {
      expect((await call('bootstrap')).json.user.can_refund).toBe(true);
      expect((await call(`orders/${order.id}/refund`, body)).status).toBe(200);
      // One cashier refused refunds on purpose stays refused.
      wp('eval', `get_user_by('login', 'cashier')->add_cap('shoptill_refund', false);`);
      try {
        expect((await call(`orders/${order.id}/refund`, body)).status).toBe(403);
      } finally {
        wp('eval', `get_user_by('login', 'cashier')->remove_cap('shoptill_refund');`);
      }
    } finally {
      wp('option', 'update', 'shoptill_cashier_refunds', 'no');
    }
    expect((await call(`orders/${order.id}/refund`, body)).status).toBe(403);
  }, 90_000);

  it.skipIf(!adminToken)('changes price and stock from the till for staff who may edit products', async () => {
    const edit = (body: unknown, as = adminToken) => call(`products/${stocked.id}`, body, undefined, as);
    expect(stocked.pinned).toBe(false);
    expect((await edit({ stock: 1 }, token)).status).toBe(403);
    expect((await call('bootstrap', undefined, undefined, adminToken)).json.user.can_edit).toBe(true);
    try {
      const r = await edit({ regular_price: stocked.regular_price + 1, sale_price: stocked.regular_price, stock: 42 });
      expect(r.status).toBe(200);
      expect(r.json.price).toBe(stocked.regular_price);
      expect(r.json.on_sale).toBe(true);
      expect(r.json.stock_quantity).toBe(42);
      expect((await edit({ sale_price: stocked.regular_price + 2 })).json.code).toBe('shoptill_price');
      expect((await edit({ stock: 5 }, adminToken)).json.stock_quantity).toBe(5);
      expect((await edit({ regular_price: 'abc' })).json.code).toBe('shoptill_price');
      expect((await edit({ sale_price: -1 })).json.code).toBe('shoptill_price');
      expect((await edit({ stock: 'lots' })).json.code).toBe('shoptill_stock');

      // Refused as a whole: the price sent with an uncountable stock figure isn't saved either.
      const untracked = await call(`products/${product.id}`, { regular_price: product.price + 1, stock: 5 }, undefined, adminToken);
      expect(untracked.json.code).toBe('shoptill_stock_untracked');
      expect((await call(`products/${product.id}`, {}, undefined, adminToken)).json.price).toBe(product.price);

      // A count taken against stock that has moved since is refused, and nothing else in it is saved.
      const moved = await edit({ stock: 9, stock_was: 4, regular_price: stocked.regular_price + 3 });
      expect(moved.status).toBe(409);
      expect(moved.json.code).toBe('shoptill_stock_changed');
      expect((await edit({})).json.regular_price).toBe(stocked.regular_price + 1);
      expect((await edit({ stock: 9, stock_was: 5 })).json.stock_quantity).toBe(9);

      // A sale set at the till starts now, whatever schedule the product had.
      editProduct(stocked.id, "$p->set_sale_price(''); $p->set_date_on_sale_from(strtotime('+10 days'));");
      expect((await edit({ sale_price: stocked.regular_price })).json.on_sale).toBe(true);
    } finally {
      expect((await edit({ regular_price: stocked.regular_price, sale_price: '', stock: stocked.stock_quantity })).status).toBe(200);
      expect((await call(`products/${product.id}`, { regular_price: product.regular_price }, undefined, adminToken)).status).toBe(200);
    }
    expect((await edit({})).json).toMatchObject({ price: stocked.price, stock_quantity: stocked.stock_quantity });
  }, 30_000);

  it.skipIf(!adminToken).each([9, 2, 5])('keeps a sale that lands while stock is counted to %s', async (counted) => {
    const edit = (body: unknown) => call(`products/${stocked.id}`, body, undefined, adminToken);
    try {
      expect((await edit({ stock: 5 })).status).toBe(200);
      await withSaleDuringStockWrite(
        stocked.id,
        async () => {
          const result = await edit({ stock: counted, stock_was: 5 });
          expect(result.status).toBe(200);
          expect(result.json.stock_quantity).toBe(counted - 1);
          expect((await call('stock')).json.find((row: any) => row.id === stocked.id).stock_quantity).toBe(counted - 1);
        },
      );
    } finally {
      await edit({ stock: stocked.stock_quantity });
    }
  }, 60_000);

  it.skipIf(!adminToken)('preserves concurrent sales when counting stock shared by a variation’s parent', async () => {
    const [parent, variation] = JSON.parse(wp('eval', `
      $p = new WC_Product_Variable();
      $p->set_name('Stock count race fixture');
      $p->set_status('publish');
      $p->set_manage_stock(true);
      $p->set_stock_quantity(5);
      $p->save();
      $v = new WC_Product_Variation();
      $v->set_parent_id($p->get_id());
      $v->set_status('publish');
      $v->set_regular_price(10);
      $v->save();
      WC_Product_Variable::sync($p);
      echo wp_json_encode(array($p->get_id(), $v->get_id()));
    `).toString()) as number[];
    try {
      await withSaleDuringStockWrite(parent, async () => {
        const result = await call(`products/${variation}`, { stock: 9, stock_was: 5 }, undefined, adminToken);
        expect(result.status).toBe(200);
        expect(result.json.stock_id).toBe(parent);
        expect(result.json.stock_quantity).toBe(8);
        const stock = (await call('stock')).json;
        expect(stock.find((row: any) => row.id === parent).stock_quantity).toBe(8);
        expect(stock.find((row: any) => row.id === variation).stock_quantity).toBe(8);
      });
    } finally {
      wp('eval', `foreach (array(${variation}, ${parent}) as $id) { $p = wc_get_product($id); if ($p) $p->delete(true); }`);
    }
  }, 60_000);

  it.skipIf(!adminToken)('refuses malformed stock baselines without saving accompanying price changes', async () => {
    try {
      for (const stock_was of [null, false, [], {}, 'bad', '1e999']) {
        const result = await call(`products/${stocked.id}`, { stock: 9, stock_was, regular_price: stocked.regular_price + 3 }, undefined, adminToken);
        expect(result.status).toBe(422);
        expect(result.json.code).toBe('shoptill_stock');
      }
      const current = (await call(`products/${stocked.id}`, {}, undefined, adminToken)).json;
      expect(current.regular_price).toBe(stocked.regular_price);
      expect(current.stock_quantity).toBe(stocked.stock_quantity);
    } finally {
      await call(`products/${stocked.id}`, { stock: stocked.stock_quantity, regular_price: stocked.regular_price }, undefined, adminToken);
    }
  }, 30_000);

  it.skipIf(!adminToken)('keeps the charged total and net manual discount when coupons are recalculated', async () => {
    let id: number | undefined;
    try {
      const body = {
        client_id: clientId(), register_id: register, created_at: now(),
        lines: [{ product_id: product.id, qty: 2, price: product.price, discount: 1 }],
        coupons: ['TENOFF'], payments: [{ method: 'cash', amount: 0.01 }],
      };
      const quoted = await call('orders', body, undefined, adminToken);
      expect(quoted.json.code).toBe('shoptill_underpaid');
      const result = await call('orders', {
        ...body, client_id: clientId(), payments: [{ method: 'cash', amount: quoted.json.data.total }],
      }, undefined, adminToken);
      id = result.json.id;
      expect(result.status, JSON.stringify(result.json)).toBe(200);
      const recalculated = JSON.parse(wp('eval', `
        $order = wc_get_order(${id});
        $item = current($order->get_items());
        $net = (float) $item->get_meta('_shoptill_discount_ex_tax');
        $order->recalculate_coupons();
        $first = (float) $order->get_total();
        $order->recalculate_coupons();
        $order->calculate_totals();
        echo wp_json_encode(array('net' => $net, 'first' => $first, 'second' => (float) $order->get_total()));
      `).toString());
      expect(recalculated.net).toBeGreaterThan(0);
      expect(recalculated.net).toBeLessThanOrEqual(1);
      expect(recalculated.first).toBeCloseTo(result.json.total, 2);
      expect(recalculated.second).toBeCloseTo(result.json.total, 2);
    } finally {
      if (id) wp('eval', `wc_get_order(${id})->delete(true);`);
    }
  }, 60_000);

  it('keeps a one-cent tip out of product sales instead of treating it as tax rounding', async () => {
    const before = (await call('reports/summary')).json;
    let id: number | undefined;
    try {
      const result = await sale({ tip: 0.01, payments: [{ method: 'cash', amount: round2(total + 0.01) }] });
      id = result.json.id;
      expect(result.status).toBe(200);
      const after = (await call('reports/summary')).json;
      const productSales = (report: any) => report.by_product.find((row: any) => row.key === String(product.id))?.sales ?? 0;
      expect(after.totals.tips - before.totals.tips).toBeCloseTo(0.01, 2);
      expect(after.totals.gross - before.totals.gross).toBeCloseTo(total + 0.01, 2);
      expect(productSales(after) - productSales(before)).toBeCloseTo(total, 2);
    } finally {
      if (id) wp('eval', `wc_get_order(${id})->delete(true);`);
    }
  }, 30_000);

  describe('with overselling off', () => {
    it('sells the last unit once when two tills ring it up at the same moment', async () => {
      const lines = [{ product_id: stocked.id, qty: 1, price: stocked.price }];
      const amount = await due({ lines });
      try {
        wp('option', 'update', 'shoptill_allow_oversell', 'no');
        editProduct(stocked.id, '$p->set_stock_quantity(1);');
        const results = await Promise.all([1, 2].map(() => sale({ lines, payments: [{ method: 'cash', amount }] })));
        expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
        expect((await call('stock')).json.find((r: any) => r.id === stocked.id).stock_quantity).toBe(0);
      } finally {
        editProduct(stocked.id, `$p->set_stock_quantity(${stocked.stock_quantity});`);
        wp('option', 'update', 'shoptill_allow_oversell', 'yes');
      }
    }, 60_000);

    it('refuses stock held for an online checkout still being paid for', async () => {
      const lines = [{ product_id: stocked.id, qty: 1, price: stocked.price }];
      const amount = await due({ lines });
      let held = '';
      try {
        wp('option', 'update', 'shoptill_allow_oversell', 'no');
        editProduct(stocked.id, '$p->set_stock_quantity(1);');
        held = wp(
          'eval',
          `$o = wc_create_order(); $o->add_product(wc_get_product(${stocked.id}), 1); $o->save(); wc_reserve_stock_for_order($o); echo $o->get_id();`,
        ).toString();
        const r = await sale({ lines, payments: [{ method: 'cash', amount }] });
        expect(r.json.code).toBe('shoptill_stock');
      } finally {
        if (held) wp('eval', `wc_release_stock_for_order(${held}); wc_get_order(${held})->delete(true);`);
        editProduct(stocked.id, `$p->set_stock_quantity(${stocked.stock_quantity});`);
        wp('option', 'update', 'shoptill_allow_oversell', 'yes');
      }
    }, 60_000);

    it('refuses a product marked out of stock that the shop does not count', async () => {
      try {
        wp('option', 'update', 'shoptill_allow_oversell', 'no');
        editProduct(product.id, "$p->set_stock_status('outofstock');");
        const r = await sale({});
        expect(r.status).toBe(422);
        expect(r.json.code).toBe('shoptill_stock');
      } finally {
        editProduct(product.id, "$p->set_stock_status('instock');");
        wp('option', 'update', 'shoptill_allow_oversell', 'yes');
      }
    }, 60_000);
  });

  it('finds orders by a phone number that is not an order number', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    await onAccount(1);
    const { orders } = (await call('orders?search=0412555123')).json;
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o: any) => o.customer === 'Jo Bloggs')).toBe(true);
  });

  it('lists a full page of orders for a phone number, not just the first ten matches', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    for (let i = 0; i < 11; i++) await onAccount(1);
    const { orders } = (await call('orders?search=0412555123')).json;
    expect(orders.length).toBeGreaterThan(10);
  }, 30_000);

  it('breaks the day down by product and cashier', async () => {
    const { totals, by_product, by_cashier } = (await call('reports/summary')).json;
    expect(by_product.length).toBeGreaterThan(0);
    const sum = (rows: any[], key: string) => rows.reduce((n: number, r: any) => n + r[key], 0);
    // Delivery charges and tips are in gross but not among the products.
    expect(sum(by_product, 'sales')).toBeCloseTo(totals.gross - totals.shipping - (totals.tips || 0), 2);
    expect(sum(by_product, 'qty')).toBe(totals.items);
    expect(sum(by_cashier, 'orders')).toBe(totals.orders);
    // The cost column adds up to the day's cost, both net of refunds, when this account sees costs.
    if (adminToken) {
      const staff = (await call('reports/summary', undefined, undefined, adminToken)).json;
      if (staff.by_product.some((p: any) => p.cost !== undefined)) {
        expect(sum(staff.by_product, 'cost')).toBeCloseTo(staff.totals.cost, 2);
      }
    }
    expect(by_cashier.map((c: any) => c.name)).toContain('Casey Cashier');
  }, 30_000);

  it('counts a till sale moved to a status another plugin added', async () => {
    await withPlugin(
      `add_action('init', function () { register_post_status('wc-ready', array('label' => 'Ready', 'public' => true)); }); add_filter('wc_order_statuses', function ($s) { $s['wc-ready'] = 'Ready'; return $s; });`,
      async () => {
        const before = (await call('reports/summary')).json.totals.orders;
        const order = (await sale({})).json;
        wp('eval', `$o = wc_get_order(${order.id}); $o->set_status('ready'); $o->save();`);
        expect(wp('eval', `echo wc_get_order(${order.id})->get_status();`).toString()).toBe('ready');
        expect((await call('reports/summary')).json.totals.orders).toBe(before + 1);
      },
    );
  }, 60_000);

  it('refuses a report for a day that does not exist', async () => {
    expect((await call('reports/summary?date=2026-02-30')).status).toBe(400);
  });

  const drawerCash = async () => {
    const day = (await call(`reports/summary?register_id=${register}`)).json;
    const cash = day.by_method.find((m: any) => m.method === 'cash');
    return { day, cash: round2((cash ? cash.sales - cash.refunds : 0) + day.totals.paid_in - day.totals.paid_out) };
  };

  it('checks a drawer count against the cash the register took', async () => {
    const expected = round2(50 + (await drawerCash()).cash);
    const close = await call('reports/close', { register_id: register, float: 50, counted: round2(expected - 2) });
    expect(close.json.expected).toBeCloseTo(expected, 2);
    expect(close.json.difference).toBeCloseTo(-2, 2);
    // A recount doesn't wipe the one that came up short.
    const recount = await call('reports/close', { register_id: register, float: 50, counted: expected });
    expect(recount.json.difference).toBeCloseTo(0, 2);
    expect((await call(`reports/summary?register_id=${register}`)).json.closes.slice(-2)).toEqual([close.json, recount.json]);
    expect((await call('reports/close', { register_id: 'nowhere', counted: 1 })).status).toBe(400);
    expect((await call('reports/close', { register_id: register, counted: -1 })).status).toBe(400);
    expect((await call('reports/close', { register_id: register, counted: '1e999' })).status).toBe(400);
  }, 60_000);

  it('counts the drawer once when the count is sent again', async () => {
    const body = { register_id: register, float: 0, counted: 1, request_id: clientId() };
    const first = await call('reports/close', body);
    expect((await call('reports/close', body)).json).toEqual(first.json);
    const closes = (await call(`reports/summary?register_id=${register}`)).json.closes;
    expect(closes.filter((c: { request_id?: string }) => c.request_id === body.request_id)).toHaveLength(1);
  }, 60_000);

  it('counts cash paid in and out of the drawer in what it should hold, once each', async () => {
    const before = (await drawerCash()).day;
    const out = { date: before.date, register_id: register, amount: -12.5, reason: 'Milk', request_id: clientId() };
    const moved = await call('reports/cash', out);
    expect(moved.json).toMatchObject({ amount: -12.5, reason: 'Milk', register_id: register });
    expect((await call('reports/cash', out)).json).toEqual(moved.json);
    expect((await call('reports/cash', { date: before.date, register_id: register, amount: 40, reason: 'Change from the bank' })).status).toBe(200);
    const { day, cash } = await drawerCash();
    expect(day.totals.paid_out).toBeCloseTo(before.totals.paid_out + 12.5, 2);
    expect(day.totals.paid_in).toBeCloseTo(before.totals.paid_in + 40, 2);
    expect(day.cash_moves.slice(-2).map((m: { reason: string }) => m.reason)).toEqual(['Milk', 'Change from the bank']);
    expect((await call('reports/close', { register_id: register, float: 0, counted: 0 })).json.expected).toBeCloseTo(cash, 2);
    for (const bad of [{ amount: 0 }, { amount: 'abc' }, { amount: [5] }, { amount: 5, reason: ' ' }, { amount: 5, register_id: 'nowhere' }]) {
      expect((await call('reports/cash', { date: before.date, register_id: register, reason: 'Float', ...bad })).status).toBe(400);
    }
  }, 60_000);

  it('takes cash sent for another day only as a retry of what that day already has', async () => {
    const id = clientId();
    wp('eval', `update_option('shoptill_cash_2020-01-01', array(array('register_id' => '${register}', 'amount' => -3, 'reason' => 'Stamps', 'request_id' => '${id}')), false);`);
    try {
      const body = { date: '2020-01-01', register_id: register, amount: -3, reason: 'Stamps' };
      expect((await call('reports/cash', { ...body, request_id: id })).json).toMatchObject({ reason: 'Stamps', request_id: id });
      const late = await call('reports/cash', { ...body, request_id: clientId() });
      expect(late.status).toBe(409);
      expect((await call('reports/cash', { ...body, date: undefined, request_id: clientId() })).status).toBe(409);
      expect((await call('reports/summary?date=2020-01-01')).json.cash_moves).toHaveLength(1);
    } finally {
      wp('eval', `delete_option('shoptill_cash_2020-01-01');`);
    }
  }, 60_000);

  it('keeps a cash movement reason short, and says so when the day could not be saved', async () => {
    const { date } = (await call('reports/summary')).json;
    const long = await call('reports/cash', { date, register_id: register, amount: 1, reason: 'x'.repeat(500) });
    expect(long.json.reason).toHaveLength(200);
    await withPlugin(`add_filter('pre_update_option', function ($value, $option, $old) { return 0 === strpos($option, 'shoptill_cash_') ? $old : $value; }, 10, 3);`, async () => {
      expect((await call('reports/cash', { date, register_id: register, amount: 1, reason: 'Lost' })).status).toBe(500);
    });
  }, 60_000);

  it('refuses a drawer count for a day still to come', async () => {
    expect((await call('reports/close', { register_id: register, counted: 1, date: '2099-01-01' })).status).toBe(400);
    expect(wp('eval', `echo get_option('shoptill_closes_2099-01-01') ? 'saved' : 'none';`).toString()).toBe('none');
  });

  it.skipIf(!adminToken)('counts a refund made in WooCommerce on an unpaid sale as off what is owed, not money out', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    const out = async () => (await call('reports/summary')).json.by_method.reduce((sum: number, m: { refunds: number }) => sum + m.refunds, 0);
    const before = await out();
    const owed = await onAccount(2);
    wp('eval', `wc_create_refund(array('order_id' => ${owed.id}, 'amount' => 1));`);
    expect(await out()).toBeCloseTo(before, 2);
    expect((await call(`orders/${owed.id}`)).json.owed).toBeCloseTo(owed.total - 1, 2);
    // One on a sale that was paid did give money back.
    const paid = (await sale({})).json;
    wp('eval', `wc_create_refund(array('order_id' => ${paid.id}, 'amount' => 1));`);
    expect(await out()).toBeCloseTo(before + 1, 2);
  }, 60_000);

  it.skipIf(!adminToken)('treats a trashed order as gone', async () => {
    const order = (await sale({})).json;
    wp('eval', `wc_get_order(${order.id})->delete(false);`);
    try {
      expect((await call(`orders/${order.id}`, undefined, undefined, adminToken)).status).toBe(404);
      expect((await call(`orders?search=%23${order.id}`, undefined, undefined, adminToken)).json.orders).toEqual([]);
      expect((await refund(order, { amount: 1 })).status).toBe(404);
    } finally {
      wp('eval', `wc_get_order(${order.id})->delete(true);`);
    }
  }, 60_000);

  it.skipIf(!adminToken)('still counts a refund after its sale is cancelled', async () => {
    const order = (await sale({})).json;
    const before = await cashRefunds();
    expect((await refund(order, { amount: 1 })).status).toBe(200);
    wp('eval', `wc_get_order(${order.id})->update_status('cancelled');`);
    expect(await cashRefunds()).toBeCloseTo(before + 1, 2);
  }, 60_000);

  it('pages the catalogue past a product deleted mid-download', async () => {
    const ids = wp(
      'eval',
      `foreach (array(1, 2, 3) as $n) { $p = new WC_Product_Simple(); $p->set_name("Keyset $n"); $p->set_regular_price('1'); $p->save(); echo $p->get_id(), ' '; }`,
    )
      .toString()
      .trim()
      .split(' ')
      .map(Number);
    try {
      const first = (await call(`products?per_page=1&after=${ids[0] - 1}`)).json;
      expect(first.products.map((p: any) => p.id)).toEqual([ids[0]]);
      wp('eval', `wc_get_product(${ids[0]})->delete(true);`);
      const next = (await call(`products?per_page=1&after=${first.next_after}`)).json;
      expect(next.products.map((p: any) => p.id)).toEqual([ids[1]]);
    } finally {
      wp('eval', `foreach (array(${ids.join(', ')}) as $id) { $p = wc_get_product($id); if ($p) { $p->delete(true); } }`);
    }
  }, 60_000);

  it('writes the shop address the way its country does', async () => {
    const { store, currency } = (await call('bootstrap')).json;
    expect(store.address).toEqual(['12 Market Lane', currency.code === 'AUD' ? 'Sydney New South Wales 2000' : 'San Jose, CA 95112']);
  });

  it('prints the shop address as text', async () => {
    wp('option', 'update', 'woocommerce_store_address', '12 Market &amp; Lane');
    try {
      expect((await call('bootstrap')).json.store.address[0]).toBe('12 Market & Lane');
    } finally {
      wp('option', 'update', 'woocommerce_store_address', '12 Market Lane');
    }
  });

  it('serves the till at one address, and not inside another site', async () => {
    const bare = await fetch(`${url}/pos`, { redirect: 'manual' });
    expect(bare.status).toBe(301);
    expect(new URL(bare.headers.get('location')!).pathname).toBe('/pos/');
    const page = await fetch(`${url}/pos/`);
    expect(page.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('serves the till under plain permalinks too, on the query string', async () => {
    const structure = wp('option', 'get', 'permalink_structure').toString();
    wp('option', 'update', 'permalink_structure', '');
    try {
      const page = await fetch(`${url}/?shoptill_app=index`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('window.SHOPTILL=');
      const sw = await fetch(`${url}/?shoptill_app=sw.js`);
      expect(sw.headers.get('service-worker-allowed')).toBe('/');
      // With no /pos/ to serve, anything else asking for the till is pointed at its one address.
      const away = await fetch(`${url}/some-page/?shoptill_app=index`, { redirect: 'manual' });
      expect(away.status).toBe(301);
      expect(new URL(away.headers.get('location')!).search).toContain('shoptill_app=index');
    } finally {
      wp('option', 'update', 'permalink_structure', structure);
    }
  });

  it('polls stock only for products that track it', async () => {
    const rows = (await call('stock')).json;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.stock_quantity !== null)).toBe(true);
  });

  it('confines a till token to the ShopTill API', async () => {
    const r = await call('users/me', undefined, 'wp/v2/');
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('shoptill_token_scope');
  });

  it('lists only POS orders for a cashier, even when web orders are asked for', async () => {
    const { orders } = (await call('orders?source=web&per_page=50')).json;
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o: any) => o.pos)).toBe(true);
  });

  it('puts a sale on account and settles it once, even from two tills at once', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    const order = await onAccount(1);
    expect(order.status).toBe('on-hold');
    expect(order.owed).toBe(order.total);

    const over = await call(`orders/${order.id}/pay`, { payments: [{ method: 'card', amount: order.owed + 1 }], register_id: register });
    expect(over.status).toBe(422);

    const settle = () => call(`orders/${order.id}/pay`, { payments: [{ method: 'card', amount: order.owed }], register_id: register });
    const results = await Promise.all([settle(), settle()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    const paid = (await call(`orders/${order.id}`)).json;
    expect(paid.status).not.toBe('on-hold');
    expect(paid.owed).toBe(0);
    expect(paid.payments).toHaveLength(1);
  });

  it('keeps a drawer count another till saved while this one was counting', async () => {
    const count = async () => (await call('reports/summary')).json.closes.length;
    const before = await count();
    // The other till's close lands between this request's summary and its lock.
    await withPlugin(
      `add_filter('query', function ($sql) {
        static $done = false;
        global $wpdb;
        if ($done || !preg_match('/GET_LOCK\\(.*(shoptill_closes_[0-9-]+)/', $sql, $m)) return $sql;
        $done = true;
        $closes = maybe_unserialize($wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $m[1]))) ?: array();
        $closes[] = array('register_id' => 'elsewhere', 'float' => 0, 'counted' => 1, 'expected' => 1, 'difference' => 0, 'cashier' => 0, 'cashier_name' => 'Other till', 'at' => time());
        $wpdb->replace($wpdb->options, array('option_name' => $m[1], 'option_value' => serialize($closes), 'autoload' => 'off'));
        return $sql;
      });`,
      async () => {
        expect((await call('reports/close', { register_id: register, counted: 1 })).status).toBe(200);
      },
    );
    expect(await count()).toBe(before + 2);
  }, 60_000);

  it.skipIf(!adminToken)('refuses a refund at a register the shop does not have', async () => {
    const order = (await sale({})).json;
    expect((await refund(order, { amount: 1, register_id: 'nowhere' })).json.code).toBe('shoptill_register');
    expect((await call(`orders/${order.id}`)).json.refunds).toHaveLength(0);
  }, 30_000);

  it.skipIf(!adminToken)('refuses an amount that is not a number', async () => {
    const order = (await sale({})).json;
    // PHP reads an array as 1, which would have refunded 1.00.
    expect((await refund(order, { amount: [5] })).status).toBe(422);
    expect((await call(`orders/${order.id}`)).json.refunds).toHaveLength(0);
  }, 30_000);

  const webOrder = (status = 'processing', gateway = '', qty = 1) =>
    wp(
      'eval',
      `$o = wc_create_order(); $o->add_product(wc_get_product(${product.id}), ${qty}); $o->set_shipping_first_name('Sam'); $o->set_shipping_address_1('Flat 2 & 3'); $o->set_shipping_city('Leeds'); $o->set_shipping_country('GB'); $o->set_billing_phone('0113 496 0000'); $o->set_payment_method('${gateway}'); $o->calculate_totals(); $o->set_status('${status}'); $o->save(); echo $o->get_id();`,
    ).toString();

  it.skipIf(!adminToken)('lists the web orders waiting to be packed, and not till sales in the same status', async () => {
    const id = Number(webOrder());
    const till = (await sale({})).json;
    wp('eval', `$o = wc_get_order(${till.id}); $o->set_status('processing'); $o->save();`);
    const list = async (query: string, as = adminToken) => (await call(`orders?${query}`, undefined, undefined, as)).json;
    const web = await list('source=web&status=processing');
    const ids = web.orders.map((o: { id: number }) => o.id);
    expect(ids).toContain(id);
    expect(ids).not.toContain(till.id);
    expect(web.orders.every((o: { status: string; pos: boolean }) => o.status === 'processing' && !o.pos)).toBe(true);
    expect(web.total).toBeGreaterThanOrEqual(web.orders.length);
    expect((await list('source=all&status=wc-processing')).orders.map((o: { id: number }) => o.id)).toEqual(expect.arrayContaining([id, till.id]));
    // A cashier still only sees till sales.
    expect((await list('source=web', token)).orders.every((o: { pos: boolean }) => o.pos)).toBe(true);
  }, 60_000);

  it.skipIf(!adminToken)('counts a web order refunded at the till in its drawer, and not against the till sales', async () => {
    const id = webOrder();
    const before = await cashRefunds();
    const totals = async () => (await call(`reports/summary?register_id=${register}`)).json.totals;
    const was = await totals();
    expect((await refund({ id: Number(id) }, { amount: 1 })).status).toBe(200);
    expect(await cashRefunds()).toBeCloseTo(before + 1, 2);
    const after = await totals();
    // Its sale was never in gross, so its refund stays out of refunds, net and tax too.
    expect([after.refunds, after.net, after.tax]).toEqual([was.refunds, was.net, was.tax]);
    expect(after.web_refunds).toBeCloseTo((was.web_refunds ?? 0) + 1, 2);
  }, 60_000);

  it.skipIf(!adminToken)('moves a web order along, and leaves a till sale as it is', async () => {
    const id = webOrder();
    const order = (await call(`orders/${id}`, undefined, undefined, adminToken)).json;
    expect(order.shipping_address).toContain('Flat 2 & 3');
    expect(order.phone).toBe('0113 496 0000');
    // A cashier doesn't see web orders at all.
    expect((await call(`orders/${id}/status`, { status: 'completed' })).status).toBe(404);
    expect((await call(`orders/${id}/status`, { status: 'refunded' }, undefined, adminToken)).status).toBe(422);
    const done = await call(`orders/${id}/status`, { status: 'completed' }, undefined, adminToken);
    expect(done.json.status).toBe('completed');
    // A till sale's status says whether it is paid, so it stays put.
    const sold = (await sale({})).json;
    expect((await call(`orders/${sold.id}/status`, { status: 'processing' }, undefined, adminToken)).status).toBe(409);
    // A bank transfer waiting for its money isn't marked paid from the till.
    const waiting = webOrder('on-hold');
    expect((await call(`orders/${waiting}/status`, { status: 'completed' }, undefined, adminToken)).status).toBe(409);
    expect((await call(`orders/${waiting}`, undefined, undefined, adminToken)).json.status).toBe('on-hold');
  }, 60_000);

  it.skipIf(!adminToken)('takes payment at the till for a web order still waiting for it', async () => {
    const id = webOrder('on-hold', 'bacs');
    const order = (await call(`orders/${id}`, undefined, undefined, adminToken)).json;
    expect(order.owed).toBeCloseTo(order.total, 2);
    const repaid = async () => (await call(`reports/summary?register_id=${register}`)).json.totals.repaid as number;
    const before = await repaid();
    const pay = (amount: number) => call(`orders/${id}/pay`, { payments: [{ method: 'cash', amount }], register_id: register }, undefined, adminToken);
    const part = await pay(1);
    expect(part.json.status).toBe('on-hold');
    expect(part.json.owed).toBeCloseTo(order.total - 1, 2);
    const paid = await pay(round2(order.total - 1));
    expect(paid.json.status).toBe('processing');
    expect(paid.json.owed).toBe(0);
    expect(await repaid()).toBeCloseTo(before + order.total, 2);
    expect((await call(`orders/${id}/status`, { status: 'completed' }, undefined, adminToken)).status).toBe(200);
    // Cash on delivery waits in processing; a card payment has already been taken.
    expect((await call(`orders/${webOrder('processing', 'cod')}`, undefined, undefined, adminToken)).json.owed).toBeGreaterThan(0);
    expect((await call(`orders/${webOrder('processing', 'stripe')}`, undefined, undefined, adminToken)).json.owed).toBe(0);
  }, 60_000);

  it.skipIf(!adminToken)('takes refunds made in WooCommerce or at the till off what a web order owes', async () => {
    const id = webOrder('on-hold', 'bacs', 3);
    const order = (await call(`orders/${id}`, undefined, undefined, adminToken)).json;
    const unit = round2(order.total / 3);
    // An item the shop couldn't supply, taken off in WooCommerce before the customer came in.
    wp('eval', `wc_create_refund(array('order_id' => ${id}, 'amount' => ${unit}));`);
    const part = await call(`orders/${id}/pay`, { payments: [{ method: 'cash', amount: unit }], register_id: register }, undefined, adminToken);
    expect(part.json.owed).toBeCloseTo(order.total - 2 * unit, 1);
    const back = await refund({ id: Number(id) }, { lines: [{ item_id: order.items[0].id, qty: 1 }] });
    expect(back.json.owed).toBe(0);
    expect(back.json.status).toBe('processing');
  }, 60_000);

  it.skipIf(!adminToken)('leaves a paid sale a manager put on hold alone when part of it comes back', async () => {
    const lines = [{ product_id: product.id, qty: 2, price: product.price }];
    const order = (await sale({ lines, payments: [{ method: 'cash', amount: await due({ lines }) }] })).json;
    wp('eval', `wc_get_order(${order.id})->update_status('on-hold', 'Waiting on an ID check.');`);
    const back = await refund(order, { lines: [{ item_id: order.items[0].id, qty: 1 }] });
    expect(back.status).toBe(200);
    expect(back.json.status).toBe('on-hold');
  });

  it('makes one account for a customer two tills add at once, and does not email it', async () => {
    const email = `${clientId()}@example.com`;
    let ids: number[] = [];
    const mail = await mailTo(email, async () => {
      const made = await Promise.all([1, 2, 3, 4].map(() => call('customers', { email, first_name: 'Walk', last_name: 'In' })));
      expect(made.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      ids = made.map((r) => r.json.id);
    });
    const users = wp('eval', `echo count(get_users(array('search' => '${email}', 'search_columns' => array('user_email'), 'fields' => 'ID')));`).toString();
    wp('eval', `require_once ABSPATH . 'wp-admin/includes/user.php'; wp_delete_user(${ids[0]});`);
    expect(new Set(ids).size).toBe(1);
    expect(users).toBe('1');
    expect(mail).toEqual([]);
  }, 60_000);

  it('shows a customer with what they have bought, and saves changes to their details', async () => {
    const made = (await call('customers', { email: `${clientId()}@example.com`, first_name: 'Pat', last_name: 'Lee' })).json;
    try {
      const order = (await sale({ customer_id: made.id })).json;
      const profile = (await call(`customers/${made.id}`)).json;
      expect(profile.order_count).toBe(1);
      expect(profile.total_spent).toBeCloseTo(order.total, 2);
      const address = { address_1: '4 Hill St', address_2: '', city: 'York', postcode: 'YO1 7HH', state: '', country: 'GB' };
      const saved = await call(`customers/${made.id}`, { first_name: 'Patricia', phone: '01904 000000', address });
      expect(saved.status).toBe(200);
      expect([saved.json.first_name, saved.json.last_name, saved.json.phone]).toEqual(['Patricia', 'Lee', '01904000000']);
      expect(saved.json.address).toEqual(address);
      expect(wp('eval', `echo get_user_meta(${made.id}, 'billing_first_name', true), '|', get_userdata(${made.id})->display_name;`).toString()).toBe('Patricia|Patricia Lee');
      // Only their own orders, even when the number searched for is someone else's.
      expect((await call(`orders?source=all&customer_id=${made.id}`)).json.orders.map((o: { id: number }) => o.id)).toEqual([order.id]);
      const other = (await sale({})).json;
      expect((await call(`orders?source=all&customer_id=${made.id}&search=${other.id}`)).json.orders.map((o: { id: number }) => o.id)).not.toContain(other.id);
    } finally {
      wp('eval', `require_once ABSPATH . 'wp-admin/includes/user.php'; wp_delete_user(${made.id});`);
    }
  }, 60_000);

  it('moves a customer to another email only for staff who can edit users, and never onto one in use', async () => {
    const email = `${clientId()}@example.com`;
    const made = (await call('customers', { email, first_name: 'Sam' })).json;
    const taken = (await call('customers', { email: `${clientId()}@example.com` })).json;
    try {
      const fresh = `${clientId()}@example.com`;
      expect((await call(`customers/${made.id}`, { email: fresh })).status).toBe(403);
      // The same address in capitals is no change.
      expect((await call(`customers/${made.id}`, { email: email.toUpperCase(), last_name: 'Hill' })).json.last_name).toBe('Hill');
      expect((await call(`customers/${made.id}`, { address: { address_1: '1 High St', city: 'Leeds', country: 'ZZ' } })).status).toBe(422);
      if (adminToken) {
        expect((await call(`customers/${made.id}`, { email: taken.email }, undefined, adminToken)).status).toBe(409);
        expect((await call(`customers/${made.id}`, { email: fresh }, undefined, adminToken)).json.email).toBe(fresh);
        // A staff account is never shown or changed from the till, whoever asks.
        expect((await call('customers/1', undefined, undefined, adminToken)).status).toBe(404);
        expect((await call('customers/1', { first_name: 'Eve' }, undefined, adminToken)).status).toBe(404);
      }
      expect((await call('customers/1')).status).toBe(404);
      // Nor a colleague who also buys from the shop.
      wp('eval', `get_userdata(${taken.id})->add_role('shoptill_cashier');`);
      expect((await call(`customers/${taken.id}`)).status).toBe(404);
      expect((await call(`customers/${taken.id}`, { first_name: 'Eve' })).status).toBe(404);
    } finally {
      wp('eval', `require_once ABSPATH . 'wp-admin/includes/user.php'; wp_delete_user(${made.id}); wp_delete_user(${taken.id});`);
    }
  }, 60_000);

  it('keeps a sale to collect later waiting until the cashier hands it over', async () => {
    const order = (await sale({ fulfil: 'collect' })).json;
    expect([order.status, order.fulfil]).toEqual(['processing', 'collect']);
    const later = async (query: string) => (await call(`orders?source=later&${query}`)).json.orders.map((o: { id: number }) => o.id);
    expect(await later('status=processing')).toContain(order.id);
    expect(await later(`search=${order.id}`)).toEqual([order.id]);
    const plain = (await sale({})).json;
    expect(await later(`search=${plain.id}`)).not.toContain(plain.id);
    // A sale the customer took away keeps the status that says it was paid.
    expect((await call(`orders/${plain.id}/status`, { status: 'completed' })).status).toBe(409);
    expect((await call(`orders/${order.id}/status`, { status: 'on-hold' })).status).toBe(422);
    expect((await call(`orders/${order.id}/status`, { status: 'completed' })).json.status).toBe('completed');
    // Back to waiting, when it was marked by mistake.
    expect((await call(`orders/${order.id}/status`, { status: 'processing' })).json.status).toBe('processing');
    expect((await call(`orders/${order.id}/status`, { status: 'completed' })).status).toBe(200);
  }, 60_000);

  it('taxes a delivery where the shop is, and keeps where it goes', async () => {
    const to = { first_name: 'Ana', last_name: 'Ruiz', address_1: '9 Rue Neuve', city: 'Lyon', postcode: '69001', country: 'FR' };
    // Taxed by where it was shipped, a delivery abroad would come to other than what the till charged.
    await withPlugin(`add_filter('pre_option_woocommerce_tax_based_on', function () { return 'shipping'; });`, async () => {
      const plain = (await sale({})).json;
      expect(plain.total_tax).toBeGreaterThan(0);
      const sent = await sale({ fulfil: 'deliver', ship_to: to });
      expect(sent.status).toBe(200);
      await call(`orders/${sent.json.id}/status`, { status: 'completed' });
      expect(sent.json.total_tax).toBe(plain.total_tax);
      expect(sent.json.fulfil).toBe('deliver');
      expect(sent.json.shipping_address.join('\n')).toContain('9 Rue Neuve');
      expect((await sale({ fulfil: 'deliver', ship_to: { ...to, address_1: '' } })).status).toBe(422);
      expect((await sale({ fulfil: 'deliver', ship_to: { ...to, country: 'ZZ' } })).status).toBe(422);
      expect((await sale({ fulfil: 'post' })).status).toBe(422);
    });
  }, 60_000);

  it('keeps a delivery queued offline without an address as one to collect, and says why', async () => {
    const order = (await sale({ created_at: now() - 3600, fulfil: 'deliver', ship_to: { city: 'Leeds' } })).json;
    await call(`orders/${order.id}/status`, { status: 'completed' });
    expect([order.status, order.fulfil, order.shipping_address]).toEqual(['processing', 'collect', []]);
    expect(order.notes.map((n: { content: string }) => n.content).join('\n')).toContain('So it waits to be collected.');
  });

  it('keeps a sale on account to collect on hold until it is paid, then waiting to be collected', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    const { json: customers } = await call('customers?search=jo');
    const order = (await sale({ payments: [], customer_id: customers[0].id, pay_later: true, fulfil: 'collect' })).json;
    expect(order.status).toBe('on-hold');
    expect((await call(`orders/${order.id}/status`, { status: 'completed' })).status).toBe(409);
    const paid = await call(`orders/${order.id}/pay`, { payments: [{ method: 'cash', amount: order.total }], register_id: register });
    expect(paid.json.status).toBe('processing');
    expect((await call(`orders/${order.id}/status`, { status: 'completed' })).json.status).toBe('completed');
  }, 60_000);

  it('keeps a staff note off the receipt, and adds a note sent twice once', async () => {
    const order = (await sale({ note: 'Check the box for cracks', note_private: true })).json;
    expect(order.note).toBe('');
    expect(order.notes.find((n: { content: string }) => n.content === 'Check the box for cracks')).toMatchObject({ customer: false, by: 'Casey Cashier' });
    const add = () => call(`orders/${order.id}/note`, { note: 'Collecting on Friday', request_id: `note-${order.id}` });
    expect((await add()).status).toBe(200);
    const added = (await add()).json.notes.filter((n: { content: string }) => n.content === 'Collecting on Friday');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ customer: false, by: 'Casey Cashier' });
    expect((await call(`orders/${order.id}/note`, { note: '  ', request_id: clientId() })).status).toBe(422);
    // A cashier doesn't see web orders at all.
    if (adminToken) expect((await call(`orders/${webOrder()}/note`, { note: 'Hello', request_id: clientId() })).status).toBe(404);
  });

  it('emails a note to the customer only when the till sends customer emails', async () => {
    const email = `${clientId()}@example.com`;
    const customer = (await call('customers', { email, first_name: 'Noa' })).json;
    const was = wp('eval', `echo get_option('shoptill_email_customer', 'no');`).toString();
    const order = (await sale({ customer_id: customer.id })).json;
    const note = (text: string) => call(`orders/${order.id}/note`, { note: text, customer: true, request_id: clientId() });
    try {
      wp('eval', `update_option('shoptill_email_customer', 'no');`);
      let added!: Awaited<ReturnType<typeof note>>;
      expect(await mailTo(email, async () => void (added = await note('Your order is ready')))).toEqual([]);
      expect(added.status).toBe(200);
      expect(added.json.notes.find((n: { content: string }) => n.content === 'Your order is ready').customer).toBe(true);
      wp('eval', `update_option('shoptill_email_customer', 'yes');`);
      expect(await mailTo(email, async () => void (await note('Still ready')))).toHaveLength(1);
      // Counted with the receipts emailed for the order, so a note can't send without limit.
      for (let i = 0; i < 4; i++) expect((await note(`Ready ${i}`)).status).toBe(200);
      expect((await note('Ready again')).status).toBe(429);
    } finally {
      wp('eval', `update_option('shoptill_email_customer', '${was}'); require_once ABSPATH . 'wp-admin/includes/user.php'; wp_delete_user(${customer.id});`);
    }
  }, 60_000);

  it('emails the customer nothing when a sale on account fails', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    const order = await onAccount(1);
    const mail = await mailTo(order.email, async () => {
      wp('eval', `wc_get_order(${order.id})->update_status('failed');`);
    });
    expect(order.email).toBeTruthy();
    expect(mail).toEqual([]);
  }, 60_000);

  it('leaves a product hidden from the till out of its catalogue', async () => {
    const listed = async () => (await call('products/ids')).json.includes(product.id);
    const page = async () => (await call(`products?after=${product.id - 1}&per_page=1`)).json.products.map((p: any) => p.id);
    // What the checkbox on the product screen saves.
    editProduct(product.id, `$_POST['_shoptill_hidden'] = 'yes'; do_action('woocommerce_admin_process_product_object', $p);`);
    try {
      expect(await listed()).toBe(false);
      expect(await page()).not.toContain(product.id);
    } finally {
      editProduct(product.id, `do_action('woocommerce_admin_process_product_object', $p);`);
    }
    expect(await listed()).toBe(true);
    expect(await page()).toContain(product.id);
  }, 60_000);

  it('signs the tills out when the password changes, and not when the profile does', async () => {
    const login = clientId();
    const id = wp('user', 'create', login, `${login}@example.com`, '--role=shoptill_cashier', '--user_pass=first-pass', '--porcelain').toString().trim();
    const works = async (as: string) => (await call('bootstrap', undefined, undefined, as)).status === 200;
    try {
      const first = await signIn(login, 'first-pass');
      expect(await works(first)).toBe(true);
      wp('eval', `wp_update_user(array('ID' => ${id}, 'display_name' => 'Renamed'));`);
      expect(await works(first)).toBe(true);
      wp('eval', `wp_update_user(array('ID' => ${id}, 'user_pass' => 'second-pass'));`);
      expect(await works(first)).toBe(false);
      // A lost-password reset goes another way.
      const second = await signIn(login, 'second-pass');
      expect(await works(second)).toBe(true);
      wp('eval', `reset_password(get_userdata(${id}), 'third-pass');`);
      expect(await works(second)).toBe(false);
    } finally {
      wp('eval', `require_once ABSPATH . 'wp-admin/includes/user.php'; wp_delete_user(${id});`);
    }
  }, 60_000);

  it('keeps the tills signed in when WordPress rehashes a password that has not changed', async () => {
    const login = clientId();
    const id = wp('user', 'create', login, `${login}@example.com`, '--role=shoptill_cashier', '--user_pass=first-pass', '--porcelain').toString().trim();
    const works = async (as: string) => (await call('bootstrap', undefined, undefined, as)).status === 200;
    try {
      const first = await signIn(login, 'first-pass');
      // An old phpass hash, which WordPress replaces at the next sign-in.
      wp('eval', `require_once ABSPATH . WPINC . '/class-phpass.php'; global $wpdb; $wpdb->update($wpdb->users, array('user_pass' => (new PasswordHash(8, true))->HashPassword('first-pass')), array('ID' => ${id})); clean_user_cache(${id});`);
      expect(await works(await signIn(login, 'first-pass'))).toBe(true);
      expect(wp('eval', `echo substr(get_userdata(${id})->user_pass, 0, 3);`).toString()).not.toBe('$P$');
      expect(await works(first)).toBe(true);
      // Another plugin firing the hook without the user as it was.
      wp('eval', `do_action('profile_update', ${id}, array());`);
      expect(await works(first)).toBe(true);
    } finally {
      wp('eval', `require_once ABSPATH . 'wp-admin/includes/user.php'; wp_delete_user(${id});`);
    }
  }, 60_000);

  const freshMailCaps = async () => {
    // The caps count per clock hour, so a run crossing one would start again part way.
    const left = 3600 - (now() % 3600);
    if (left < 20) await new Promise((done) => setTimeout(done, (left + 1) * 1000));
    wp('eval', `global $wpdb; $wpdb->query("DELETE FROM {$wpdb->options} WHERE option_name LIKE '%transient%shoptill_mail_%'");`);
  };

  it('stops emailing one order its receipt after five in an hour, even when they are sent at once', async () => {
    const order = (await sale({})).json;
    await freshMailCaps();
    const statuses = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(async () => (await call(`orders/${order.id}/email`, { email: 'walkin@example.com' })).status));
    expect(statuses.sort()).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
  }, 60_000);

  it('stops a cashier emailing receipts after 60 in an hour', async () => {
    await freshMailCaps();
    const user = (await call('bootstrap')).json.user.id;
    wp('eval', `set_transient('shoptill_mail_${user}_' . intdiv(time(), HOUR_IN_SECONDS), 59, HOUR_IN_SECONDS);`);
    try {
      const statuses: number[] = [];
      for (const _ of [1, 2]) statuses.push((await call(`orders/${(await sale({})).json.id}/email`, { email: 'walkin@example.com' })).status);
      expect(statuses).toEqual([200, 429]);
    } finally {
      await freshMailCaps();
    }
  }, 60_000);

  it('says so when a receipt email could not be sent, and keeps the address off the order', async () => {
    const order = (await sale({})).json;
    await freshMailCaps();
    const email = () => wp('eval', `echo wc_get_order(${order.id})->get_billing_email();`).toString();
    await withPlugin(`add_filter('pre_wp_mail', '__return_false');`, async () => {
      const r = await call(`orders/${order.id}/email`, { email: 'walkin@example.com' });
      expect(r.status).toBe(502);
      expect(r.json.code).toBe('shoptill_email_failed');
    });
    const noted = () => wp('eval', `echo count(array_filter(wc_get_order_notes(array('order_id' => ${order.id})), function ($n) { return false !== strpos($n->content, 'Receipt emailed'); }));`).toString();
    expect(noted()).toBe('0');
    expect(email()).toBe('');
    expect((await call(`orders/${order.id}/email`, { email: 'walkin@example.com' })).status).toBe(200);
    expect(noted()).toBe('1');
    expect(email()).toBe('walkin@example.com');
  }, 60_000);

  it('checks a minimum spend against the price with tax in the preview, as the sale does', async (ctx) => {
    if (!(await call('bootstrap')).json.tax.prices_include_tax) ctx.skip();
    const code = clientId();
    const id = wp('eval', `$c = new WC_Coupon(); $c->set_code('${code}'); $c->set_amount(1); $c->set_minimum_amount(${round2(total - 0.01)}); echo $c->save();`).toString();
    try {
      const lines = [{ product_id: product.id, qty: 1, price: product.price }];
      expect((await call('orders/preview', { lines, coupons: [code] })).status).toBe(200);
      expect((await sale({ coupons: [code], payments: [{ method: 'cash', amount: 0.01 }] })).json.code).not.toBe('shoptill_coupon');
    } finally {
      wp('eval', `wp_delete_post(${id}, true);`);
    }
  }, 60_000);

  it('refuses coupon codes and tax classes that are not text, rather than failing', async () => {
    expect((await sale({ coupons: [['TENOFF']] })).status).toBe(200);
    const custom = [{ qty: 1, price: 5, name: 'Odd', tax_class: ['reduced-rate'] }];
    expect((await sale({ lines: custom, payments: [{ method: 'cash', amount: await due({ lines: custom }) }] })).status).toBe(200);
    expect((await call('customers?search[]=jo')).status).toBe(200);
  }, 30_000);

  it('uses an individual-use coupon only on its own', async () => {
    const lines = [{ product_id: product.id, qty: 2, price: product.price }];
    for (const coupons of [['SOLO', 'TENOFF'], ['TENOFF', 'SOLO']]) {
      const r = await call('orders/preview', { lines, coupons });
      expect(r.status).toBe(422);
      expect(r.json.data.code).toBe(coupons[1].toLowerCase());
      expect((await sale({ lines, coupons, payments: [{ method: 'cash', amount: 0.01 }] })).json.code).toBe('shoptill_coupon');
    }
    expect((await call('orders/preview', { lines, coupons: ['SOLO'] })).status).toBe(200);
  }, 30_000);

  it("checks a coupon for certain customers against the customer's email, not the cashier's", async () => {
    const lines = [{ product_id: product.id, qty: 1, price: product.price }];
    const { json: customers } = await call('customers?search=jo');
    expect((await call('orders/preview', { lines, coupons: ['STAFF'] })).status).toBe(422);
    expect((await call('orders/preview', { lines, coupons: ['JOONLY'], customer_id: customers[0].id })).status).toBe(200);
  }, 30_000);

  it('needs a customer on the sale for a coupon limited per customer', async () => {
    const lines = [{ product_id: product.id, qty: 1, price: product.price }];
    const { json: customers } = await call('customers?search=jo');
    expect((await call('orders/preview', { lines, coupons: ['ONEEACH'] })).status).toBe(422);
    expect((await sale({ coupons: ['ONEEACH'], payments: [{ method: 'cash', amount: 0.01 }] })).json.code).toBe('shoptill_coupon');
    expect((await call('orders/preview', { lines, coupons: ['ONEEACH'], customer_id: customers[0].id })).status).toBe(200);
  }, 30_000);

  it('takes no payment on a sale that died half way through saving', async () => {
    const client_id = clientId();
    // Past the first save, which only makes the empty order, to the one that gives it its total.
    await dieOnce('woocommerce_update_order', async () => {
      await sale({ client_id }).catch(() => null);
    });
    const id = wp('eval', `echo implode(',', wc_get_orders(array('limit' => 1, 'status' => 'pending', 'meta_key' => '_shoptill_attempt', 'meta_value' => '${client_id}', 'return' => 'ids')));`).toString();
    expect(id).not.toBe('');
    expect((await call(`orders/${id}`)).json.owed).toBe(0);
    expect((await call(`orders/${id}/pay`, { payments: [{ method: 'cash', amount: total }], register_id: register })).json.code).toBe('shoptill_not_owed');
    expect((await sale({ client_id })).status).toBe(200);
  }, 60_000);

  it('sends a product the shop published on schedule in the next catalogue update', async () => {
    // Edited after it was scheduled, so its modified date is before the till's last sync and its publish date after.
    const id = wp('eval', `$p = new WC_Product_Simple(); $p->set_name('Scheduled'); $p->set_regular_price('3'); $p->set_status('future'); $p->set_date_created(time() + 600); $p->save(); $p->set_regular_price('4'); echo $p->save();`).toString();
    try {
      const synced = (await call('bootstrap')).json.server_time + 5;
      // What cron does when the date comes, which leaves the modified date alone.
      wp('eval', `wp_publish_post(${id});`);
      const { products } = (await call(`products?after=0&per_page=250&modified_after=${synced}`)).json;
      expect(products.map((p: { id: number }) => p.id)).toContain(Number(id));
    } finally {
      wp('eval', `wp_delete_post(${id}, true);`);
    }
  }, 60_000);

  it.skipIf(!adminToken)('takes a return off what is owed rather than paying out money never taken', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    const order = await onAccount(2);
    const before = await cashRefunds();
    const refunded = await refund(order, { lines: [{ item_id: order.items[0].id, qty: 1 }] });
    expect(refunded.status).toBe(200);
    expect(refunded.json.status).toBe('on-hold');
    expect(refunded.json.owed).toBeCloseTo(order.total - refunded.json.refunded, 2);
    expect(await cashRefunds()).toBeCloseTo(before, 2);

    const over = await call(`orders/${order.id}/pay`, { payments: [{ method: 'card', amount: order.total }], register_id: register });
    expect(over.status).toBe(422);
  }, 30_000);

  it.skipIf(!adminToken)('completes an order once a return covers what was still owed', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    const order = await onAccount(2);
    const half = Math.round((order.total / 2) * 100) / 100;
    await call(`orders/${order.id}/pay`, { payments: [{ method: 'card', amount: half }], register_id: register });
    const before = await cashRefunds();
    const r = await refund(order, { lines: [{ item_id: order.items[0].id, qty: 1 }] });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('completed');
    expect(r.json.owed).toBe(0);
    expect(Math.abs((await cashRefunds()) - before)).toBeLessThan(0.02);
  }, 30_000);

  it.skipIf(!adminToken)('completes an order a return paid off when the first try died after making the refund', async (ctx) => {
    if (!(await call('bootstrap')).json.pay_later) ctx.skip();
    const order = await onAccount(2);
    const half = Math.round((order.total / 2) * 100) / 100;
    await call(`orders/${order.id}/pay`, { payments: [{ method: 'card', amount: half }], register_id: register });
    await dieOnce('woocommerce_order_partially_refunded', async () => {
      const once = () => refund(order, { lines: [{ item_id: order.items[0].id, qty: 1 }], request_id: 'return-died' });
      await once().catch(() => null);
      const again = await once();
      expect(again.status).toBe(200);
      expect(again.json.refunds).toHaveLength(1);
      expect(again.json.status).toBe('completed');
      expect(again.json.owed).toBe(0);
    });
  }, 60_000);

  it('refuses two of a product sold individually, and notes it when one arrives late', async () => {
    const { products } = (await call('products?per_page=100')).json;
    const solo = products.find((p: any) => p.sku === 'SIGNED-PRINT');
    expect(solo?.sold_individually).toBe(true);
    // Earlier runs may have sold their way through it.
    editProduct(solo.id, `$p->set_stock_quantity(20); $p->set_stock_status('instock');`);
    const line = { product_id: solo.id, qty: 1, price: solo.price };
    const each = await due({ lines: [line] });
    const once = await sale({ lines: [line], payments: [{ method: 'cash', amount: each }] });
    expect(once.status).toBe(200);
    // Two on one line, or one each on two, add up to the same refusal.
    expect((await sale({ lines: [line, line] })).json.code).toBe('shoptill_individual');
    expect((await sale({ lines: [{ ...line, qty: 2 }] })).json.code).toBe('shoptill_individual');
    // The money was taken, so a late one is kept — whatever it comes to — and the shop is told.
    const late = await sale({
      created_at: now() - 3600,
      lines: [{ ...line, qty: 2 }],
      payments: [{ method: 'cash', amount: each * 2 }],
    });
    expect(late.status).toBe(200);
    expect(late.json.notes.map((n: { content: string }) => n.content).join('\n')).toContain('sold one at a time');
  }, 60_000);

  it('refuses a price change from an account that may not make one', async () => {
    const admin = adminToken!;
    const shelf = (await call('products?per_page=100')).json.products.find((p: any) => p.id === product.id).price;
    const changed = { product_id: product.id, qty: 1, price: Number((shelf - 1).toFixed(2)), price_changed: true };
    // The amount a till would charge: a staff sale paid 0.01 is refused with what's owed in its body.
    const owed = (await call('orders', { client_id: clientId(), register_id: register, lines: [changed], payments: [{ method: 'cash', amount: 0.01 }] }, undefined, admin)).json.data.total as number;
    const amount = owed;

    // A cashier's deliberate price change is refused while online, kept late with a note.
    expect((await sale({ lines: [changed] })).status).toBe(422);
    const late = await sale({ created_at: now() - 3600, lines: [changed], payments: [{ method: 'cash', amount }] });
    expect(late.status).toBe(200);
    expect(late.json.notes.map((n: { content: string }) => n.content).join('\n')).toContain('may not change prices');

    // Staff may change it, and a discount is a price change by another name.
    const staff = await call('orders', { client_id: clientId(), register_id: register, lines: [changed], payments: [{ method: 'cash', amount }] }, undefined, admin);
    expect(staff.status).toBe(200);
    expect((await sale({ lines: [{ product_id: product.id, qty: 1, price: shelf, discount: 1 }] })).status).toBe(422);

    // The shop can let cashiers haggle after all.
    wp('option', 'update', 'shoptill_cashier_prices', 'yes');
    try {
      expect((await sale({ lines: [changed], payments: [{ method: 'cash', amount }] })).status).toBe(200);
    } finally {
      wp('option', 'update', 'shoptill_cashier_prices', 'no');
    }
    // And the till's answer to "may this account change prices" follows the setting.
    expect((await call('bootstrap')).json.may_change_prices).toBe(false);
    expect((await call('bootstrap', undefined, undefined, admin)).json.may_change_prices).toBe(true);
  }, 60_000);

  it('shows a wp-admin refund of a till sale on that register\'s report', async () => {
    const admin = adminToken!;
    const before = (await call(`reports/summary?register_id=${register}`, undefined, undefined, admin)).json.totals;
    const line = { product_id: product.id, qty: 1, price: product.price };
    const order = (await sale({ lines: [line], payments: [{ method: 'cash', amount: await due({ lines: [line] }) }] })).json;
    expect(order.status).toBe('completed');
    // Refunded in wp-admin, not at the till: no register meta on the refund itself.
    wp('eval', `wc_create_refund(array('order_id' => ${order.id}, 'refund_payment' => false, 'amount' => ${order.total}));`);
    // The day accumulates floats across runs, so the delta is compared at a cent's tolerance.
    await expect
      .poll(async () => Number(((await call(`reports/summary?register_id=${register}`, undefined, undefined, admin)).json.totals.refunds - before.refunds).toFixed(1)), { timeout: 8_000 })
      .toBeCloseTo(Number(Number(order.total).toFixed(1)), 1);
  }, 60_000);

  it('adds a tip as a fee on the order, taxed like the sale', async () => {
    wp('option', 'update', 'shoptill_tips', 'yes');
    try {
      expect((await call('bootstrap')).json.tips).toBe(true);
      const line = { product_id: product.id, qty: 1, price: product.price };
      const base = await due({ lines: [line] });
      // The owed probe carries no tip; the sale adds 1.00 on top.
      const tipped = await sale({
        lines: [line],
        payments: [{ method: 'cash', amount: round2(base + 1) }],
        tip: 1,
      });
      expect(tipped.status).toBe(200);
      expect(tipped.json.total).toBeCloseTo(round2(base + 1), 2);
      // The order carries the fee line
      const fees = wp('eval', `$o = wc_get_order(${tipped.json.id}); foreach ($o->get_fees() as $f) { echo $f->get_name() . '=' . $f->get_total(); }`).toString();
      expect(fees).toContain('Tip=1');
    } finally {
      wp('option', 'update', 'shoptill_tips', 'no');
    }
  }, 60_000);

  it('adds a delivery charge as shipping on the order, taxed like the rest of the sale', async () => {
    const to = { first_name: 'Ana', last_name: 'Ruiz', address_1: '9 Rue Neuve', city: 'Lyon', postcode: '69001', country: 'FR' };
    const plain = await due({});
    const charge = 4.5;
    const withCharge = await due({ fulfil: 'deliver', ship_to: to, delivery_charge: charge });
    expect(withCharge).toBeGreaterThan(plain + charge - 0.01);
    const order = await sale({ fulfil: 'deliver', ship_to: to, delivery_charge: charge, payments: [{ method: 'cash', amount: withCharge }] });
    expect(order.status).toBe(200);
    expect(order.json.total).toBe(withCharge);
    expect(order.json.shipping_method).toBe('Delivery');
    expect(order.json.shipping_total).toBeGreaterThan(0);
    expect(order.json.remaining_refund).toBeCloseTo(order.json.total, 2);
    // A charge with nowhere to go, or that isn't an amount, is refused.
    expect((await sale({ delivery_charge: charge })).json.code).toBe('shoptill_delivery_charge');
    expect((await sale({ delivery_charge: -1, fulfil: 'deliver', ship_to: to })).json.code).toBe('shoptill_delivery_charge');
    expect((await sale({ delivery_charge: [charge], fulfil: 'deliver', ship_to: to })).json.code).toBe('shoptill_delivery_charge');
    // One that arrives late with an address the shop can no longer deliver to loses its charge, and says so.
    const late = await sale({
      created_at: now() - 3600,
      fulfil: 'deliver',
      ship_to: { city: 'Leeds' },
      delivery_charge: charge,
      payments: [{ method: 'cash', amount: plain }],
    });
    expect(late.status).toBe(200);
    expect([late.json.fulfil, late.json.shipping_total]).toEqual(['collect', 0]);
    expect(late.json.notes.map((n: { content: string }) => n.content).join('\n')).toContain('delivery charge was dropped');
  }, 60_000);

  it('flags cash moved after the drawer was counted', async () => {
    // The shop's day, read again for each entry so a midnight under the test doesn't scatter them —
    // and one whole retry, for the day turning between them.
    const day = async () => (await call(`reports/summary?register_id=${register}`)).json.date;
    const r = () => clientId();
    let flagged = false;
    let before: boolean | undefined = true;
    for (const attempt of [1, 2]) {
      let used = '';
      const ids = { in: `in-${r()}`, close: `close-${r()}`, out: `out-${r()}` };
      const post = async (path: string, body: Record<string, unknown>) => {
        used = await day();
        const res = await call(path, { ...body, date: used });
        expect(res.status, `${path} ${res.status} ${JSON.stringify(res.json)}`).toBe(200);
      };
      await post('reports/cash', { register_id: register, amount: 5, reason: 'float from the bank', request_id: ids.in });
      await post('reports/close', { register_id: register, float: 10, counted: 10, request_id: ids.close });
      await post('reports/cash', { register_id: register, amount: -5, reason: 'window cleaner', request_id: ids.out });
      // Earlier runs left their own moves on the day, so these are told apart by their request.
      const moves = (await call(`reports/summary?register_id=${register}&date=${used}`)).json.cash_moves as { request_id: string; after_close?: boolean }[];
      before = moves.find((m) => m.request_id === ids.in)?.after_close;
      flagged = moves.find((m) => m.request_id === ids.out)?.after_close === true;
      if (flagged) break;
    }
    expect(before).toBeUndefined();
    expect(flagged).toBe(true);
  }, 60_000);

  it('carries the cost plugin onto till sales, and shows profit to staff alone', async (ctx) => {
    if (!(await call('bootstrap')).json.cogs) ctx.skip();
    const admin = adminToken!;
    // A cost on the sale's product, and none on the card, which is sold without one.
    editProduct(product.id, `update_post_meta(${product.id}, '_alg_wc_cog_cost', '1.10');`);
    try {
      // Cashiers never see a cost; staff who may edit products do.
      const mine = (await call('products?per_page=100')).json.products.find((p: any) => p.id === product.id);
      expect('cost' in mine).toBe(false);
      const seen = (await call('products?per_page=100', undefined, undefined, admin)).json.products.find((p: any) => p.id === product.id);
      expect(seen.cost).toBe(1.1);

      // Staff can set a cost from the till, and clear it with an empty string.
      expect((await call(`products/${product.id}`, { cost: '1.25' }, undefined, admin)).json.cost).toBe(1.25);
      expect((await call(`products/${product.id}`, { cost: '' }, undefined, admin)).json.cost).toBeNull();
      expect((await call(`products/${product.id}`, { cost: '1.10' }, undefined, admin)).json.cost).toBe(1.1);

      // The sale stamps the cost on its items in the plugin's own meta, which its reports read.
      const before = (await call('reports/summary?register_id=' + register, undefined, undefined, admin)).json.totals;
      const two = { product_id: product.id, qty: 2, price: product.price };
      const sale2 = (await sale({ lines: [two], payments: [{ method: 'cash', amount: await due({ lines: [two] }) }] })).json;
      const itemCost = wp('eval', `$o = wc_get_order(${sale2.id}); foreach ($o->get_items() as $i) { echo $i->get_meta('_alg_wc_cog_item_cost'); }`).toString();
      expect(Number(itemCost)).toBe(1.1);

      // The staff report counts the cost, keeps what was sold without one apart, and reports profit.
      const read = async () => (await call('reports/summary?register_id=' + register, undefined, undefined, admin)).json;
      // The report pages through the day's orders, and the other suites write to the same shop as it
      // reads, so a fresh read a moment later is what settles a sale that has just been made.
      let after = await read();
      if (after.totals.orders === before.orders) {
        await new Promise((r) => setTimeout(r, 300));
        after = await read();
      }
      expect({
        sales_in_report: after.totals.orders - before.orders,
        cost_added: Number((after.totals.cost - before.cost).toFixed(2)),
        row_cost: after.by_product.find((p: any) => p.sku === product.sku)?.cost,
      }).toEqual({ sales_in_report: 1, cost_added: 2.2, row_cost: expect.any(Number) });
      expect(after.totals.profit).toBeCloseTo(after.totals.net - after.totals.cost, 2);
      const cardLine = { product_id: (await call('products?per_page=100')).json.products.find((p: any) => p.sku === 'GIFT-CARD').id, qty: 1 };
      expect((await sale({ lines: [cardLine], payments: [{ method: 'cash', amount: await due({ lines: [cardLine] }) }] })).status).toBe(200);
      await expect
        .poll(async () => (await read()).by_product.find((p: any) => p.sku === 'GIFT-CARD')?.uncosted, { timeout: 20_000 })
        .toBe(true);

      // A refund gives the goods back, so the day's cost no longer counts them, in the totals
      // and in the product's own row, which now moves with them. The shop carries earlier runs'
      // sales of this product on the same day, so both are checked by how much they change.
      const refunded = await refund(sale2, { lines: [{ item_id: sale2.items[0].id, qty: 1 }] });
      expect(refunded.status).toBe(200);
      const rowBefore = after.by_product.find((p: any) => p.sku === product.sku)?.cost ?? 0;
      await expect
        .poll(
          async () => {
            const row = (await read()).by_product.find((p: any) => p.sku === product.sku)?.cost;
            return row === undefined ? NaN : Number((row - rowBefore).toFixed(1));
          },
          { timeout: 10_000 },
        )
        .toBeCloseTo(-1.1, 1);
      const final = (await read()).totals;
      expect(final.cost).toBeCloseTo(after.totals.cost - 1.1, 2);

      // A cashier's report has none of it.
      const blind = (await call('reports/summary?register_id=' + register)).json;
      expect('cost' in blind.totals || 'profit' in blind.totals || 'uncosted' in blind.totals).toBe(false);
      expect(blind.by_product.every((p: any) => !('cost' in p))).toBe(true);
    } finally {
      wp('eval', `delete_post_meta(${product.id}, '_alg_wc_cog_cost');`);
    }
  }, 120_000);

  it('refuses a cost to an account the cost plugin keeps out of its numbers', async (ctx) => {
    if (!(await call('bootstrap')).json.cogs) ctx.skip();
    const admin = adminToken!;
    editProduct(product.id, `update_post_meta(${product.id}, '_alg_wc_cog_cost', '1.10');`);
    // The cost plugin's own answer to "may this account see costs", stood up as a shop that keeps
    // staff out of its margins would have it. Its role list is skipped for administrators, so the
    // decision is taken at the filter it applies to everyone.
    await withPlugin(
      `add_filter('wpfcogs_is_user_allowed', '__return_false');`,
      async () => {
        // Staff who may edit products, and are kept out of the costs by the plugin.
        const seen = (await call('products?per_page=100', undefined, undefined, admin)).json.products.find((p: any) => p.id === product.id);
        expect('cost' in seen).toBe(false);
        expect((await call('reports/summary?register_id=' + register, undefined, undefined, admin)).json.totals.cost).toBeUndefined();

        // Setting a cost is the same privilege as seeing one, so it is refused and nothing is saved.
        const refused = await call(`products/${product.id}`, { cost: '9.99' }, undefined, admin);
        expect(refused.status).toBe(403);
        expect(refused.json.code).toBe('shoptill_cost_forbidden');
        expect(Number(wp('eval', `echo get_post_meta(${product.id}, '_alg_wc_cog_cost', true);`).toString())).toBe(1.1);

        // A price is still theirs to change: the plugin's list is about costs only.
        expect((await call(`products/${product.id}`, { sale_price: '' }, undefined, admin)).status).toBe(200);
      },
    );
    // With the plugin's answer back as it was, the same change goes through.
    expect((await call(`products/${product.id}`, { cost: '1.10' }, undefined, admin)).json.cost).toBe(1.1);
    wp('eval', `delete_post_meta(${product.id}, '_alg_wc_cog_cost');`);
  }, 120_000);

  it('costs a late sale at the cost the till froze when it was made', async (ctx) => {
    if (!(await call('bootstrap')).json.cogs) ctx.skip();
    const admin = adminToken!;
    editProduct(product.id, `update_post_meta(${product.id}, '_alg_wc_cog_cost', '5.00');`);
    try {
      const line = { product_id: product.id, qty: 1, price: product.price };
      const amount = await due({ lines: [line] });
      const itemCostOf = (id: number) =>
        Number(wp('eval', `$o = wc_get_order(${id}); foreach ($o->get_items() as $i) { echo $i->get_meta('_alg_wc_cog_item_cost'); }`).toString());

      // Staff sold it three days ago with the cost the catalogue carried then; the shop's has since moved.
      const late = await call('orders', {
        client_id: clientId(),
        register_id: register,
        created_at: now() - 3 * 24 * 3600,
        lines: [{ ...line, cost: 4.4 }],
        payments: [{ method: 'cash', amount }],
      }, undefined, admin);
      expect(late.status).toBe(200);
      expect(itemCostOf(late.json.id)).toBe(4.4);

      // A cashier's till has no costs to freeze, and one it claims is not believed.
      const cashiers = await sale({ lines: [{ ...line, cost: 0.01 }], payments: [{ method: 'cash', amount }] });
      expect(cashiers.status).toBe(200);
      expect(itemCostOf(cashiers.json.id)).toBe(5);

      // A cost that is not a number, from an account that may set costs, is refused.
      const bad = await call('orders', {
        client_id: clientId(),
        register_id: register,
        lines: [{ ...line, cost: 'abc' }],
        payments: [{ method: 'cash', amount }],
      }, undefined, admin);
      expect(bad.status).toBe(422);
      expect(bad.json.code).toBe('shoptill_cost');
    } finally {
      wp('eval', `delete_post_meta(${product.id}, '_alg_wc_cog_cost');`);
    }
  }, 120_000);
});
