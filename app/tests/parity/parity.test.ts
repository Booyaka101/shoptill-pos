// Creates real orders on a dev store and checks the till's offline totals match WooCommerce to the cent.
// SHOPTILL_URL=http://localhost:8088 SHOPTILL_TOKEN=<basic token> npx vitest run tests/parity
import { describe, expect, it } from 'vitest';
import { calculate, type TaxConfig } from '../../src/totals';

const url = process.env.SHOPTILL_URL;
// Carts carry manual discounts and price changes, which are staff work now;
// parity checks the maths, so it sells as whoever is allowed to make them.
const token = process.env.SHOPTILL_ADMIN_TOKEN ?? process.env.SHOPTILL_TOKEN;
const carts = Number(process.env.PARITY_CARTS ?? 40);

async function api(path: string, body?: unknown) {
  const res = await fetch(`${url}/wp-json/shoptill/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.message}`);
  return json;
}

// Small deterministic PRNG so a failing cart can be replayed.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

describe.skipIf(!url || !token)('totals parity with WooCommerce', () => {
  it(`matches ${carts} random carts`, { timeout: 600_000 }, async () => {
    const boot = await api('bootstrap');
    const tax: TaxConfig = boot.tax;
    const { products } = await api('products?per_page=250');
    // A product sold individually can't take a random quantity, so it stays out of random carts.
    const sellable = products.filter((p: any) => p.type !== 'variable' && p.price !== null && !p.sold_individually);
    const classes = Object.keys(tax.classes);
    const rand = rng(Number(process.env.PARITY_SEED ?? 7));
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const mismatches: string[] = [];
    let compared = 0;
    let withCoupons = 0;

    for (let n = 0; n < carts; n++) {
      const lines: any[] = [];
      const count = 1 + Math.floor(rand() * 5);
      for (let i = 0; i < count; i++) {
        const discount = rand() < 0.3 ? Math.round(rand() * 300) / 100 : 0;
        if (rand() < 0.15) {
          lines.push({ name: 'Custom', price: Math.round(rand() * 2000) / 100, qty: 1 + Math.floor(rand() * 3), tax_class: pick(classes), discount, _taxable: true });
        } else {
          const p = pick(sellable) as any;
          const price = rand() < 0.1 ? Math.round(rand() * 5000) / 100 : undefined;
          lines.push({ product_id: p.id, qty: 1 + Math.floor(rand() * 4), price, discount, _p: p });
        }
      }
      const coupons = rand() < 0.3 ? [pick(['TENOFF', 'FIVEOFF', 'CUP2'])] : [];
      const wire = lines.map(({ _p, _taxable, ...rest }) => rest);

      let couponDiscounts = lines.map(() => 0);
      if (coupons.length) {
        try {
          const preview = await api('orders/preview', { lines: wire, coupons });
          couponDiscounts = preview.lines.map((l: any) => l.coupon_discount);
        } catch {
          continue; // Coupon not valid for this cart (e.g. CUP2 without a cup); nothing to compare.
        }
      }

      const local = calculate(
        lines.map((l, i) => ({
          price: l.price ?? l._p.price,
          qty: l.qty,
          taxable: l._p ? l._p.tax_status === 'taxable' : true,
          taxClass: l._p ? l._p.tax_class : l.tax_class,
          discount: l.discount,
          couponDiscount: couponDiscounts[i],
        })),
        tax,
      );

      const order = await api('orders', {
        client_id: `parity-${Date.now()}-${n}`,
        register_id: boot.registers[0].id,
        lines: wire,
        coupons,
        payments: [{ method: 'cash', amount: Math.max(local.total, 0.01) }],
        expected_total: local.total,
      });

      compared++;
      if (coupons.length) withCoupons++;
      const checks: [string, number, number][] = [
        ['total', local.total, order.total],
        ['tax', local.tax, order.total_tax],
        ['subtotal', local.subtotal, order.subtotal],
        ['discount', local.discount, order.discount_total],
      ];
      if (tax.enabled && tax.prices_include_tax) {
        // With tax in the price, the customer pays what's on the shelf less the discounts, to the cent.
        const shelf = lines.reduce((s, l, i) => s + Math.max(0, Math.round(((l.price ?? l._p.price) * l.qty - couponDiscounts[i] - l.discount) * 100)), 0) / 100;
        checks.push(['shelf', shelf, order.total]);
      }
      for (const [name, mine, theirs] of checks) {
        if (Math.abs(mine - theirs) > 0.001) {
          mismatches.push(`cart ${n} ${name}: till ${mine} vs woo ${theirs} :: ${JSON.stringify({ wire, coupons })}`);
        }
      }
    }

    console.log(`compared ${compared} carts, ${withCoupons} with coupons`);
    expect(compared).toBeGreaterThan(carts * 0.7);
    expect(mismatches).toEqual([]);
  });

  it('matches delivery charges, with their tax', { timeout: 300_000 }, async () => {
    const boot = await api('bootstrap');
    const tax: TaxConfig = boot.tax;
    const { products } = await api('products?per_page=250');
    // A product sold individually can't take a random quantity, so it stays out of random carts.
    const sellable = products.filter((p: any) => p.type !== 'variable' && p.price !== null && !p.sold_individually);
    const rand = rng(Number(process.env.PARITY_SEED ?? 17));
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const to = { first_name: 'Ana', last_name: 'Ruiz', address_1: '9 Rue Neuve', city: 'Lyon', postcode: '69001', country: 'FR' };
    const mismatches: string[] = [];

    for (let n = 0; n < 15; n++) {
      const lines: any[] = [];
      for (let i = 0, count = 1 + Math.floor(rand() * 3); i < count; i++) {
        const p = pick(sellable) as any;
        lines.push({ product_id: p.id, qty: 1 + Math.floor(rand() * 3), price: rand() < 0.1 ? Math.round(rand() * 5000) / 100 : undefined, _p: p });
      }
      const charge = Math.round(rand() * 600) / 100;
      const wire = lines.map(({ _p, ...rest }) => rest);

      const local = calculate(
        lines.map((l) => ({ price: l.price ?? l._p.price, qty: l.qty, taxable: l._p.tax_status === 'taxable', taxClass: l._p.tax_class, discount: 0, couponDiscount: 0 })),
        tax,
        charge,
      );

      const order = await api('orders', {
        client_id: `parity-ship-${Date.now()}-${n}`,
        register_id: boot.registers[0].id,
        lines: wire,
        fulfil: 'deliver',
        ship_to: to,
        delivery_charge: charge,
        payments: [{ method: 'cash', amount: local.total }],
        expected_total: local.total,
      });

      const checks: [string, number, number][] = [
        ['total', local.total, order.total],
        ['tax', local.tax, order.total_tax],
        ['subtotal', local.subtotal, order.subtotal],
      ];
      if (order.shipping_total <= 0) mismatches.push(`cart ${n}: no shipping on the order`);
      for (const [name, mine, theirs] of checks) {
        if (Math.abs(mine - theirs) > 0.001) mismatches.push(`cart ${n} ${name}: till ${mine} vs woo ${theirs} :: charge ${charge} ${JSON.stringify({ wire })}`);
      }
    }

    console.log(`compared 15 carts with delivery charges`);
    expect(mismatches).toEqual([]);
  });
});
