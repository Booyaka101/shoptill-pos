// Drives the built till at /pos against the dev shop: a full online sale, a refund, and an offline
// sale that syncs once the connection comes back.
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { editProduct, wp } from '../wp';

const adminToken = process.env.SHOPTILL_ADMIN_TOKEN ?? readFileSync(new URL('../../../dev/.admintoken', import.meta.url), 'utf8').trim();

async function rest(request: APIRequestContext, path: string) {
  const res = await request.get(`/wp-json/shoptill/v1/${path}`, { headers: { Authorization: `Basic ${adminToken}` } });
  expect(res.ok(), `${path} ${res.status()}`).toBeTruthy();
  return res.json();
}

async function signIn(page: Page, user: string, pass: string, first = 'Butter croissant') {
  await page.goto('/pos/');
  await page.getByLabel('Username or email').fill(user);
  await page.getByLabel('Password').fill(pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(tile(page, first)).toBeVisible();
}

const productId = async (request: APIRequestContext, sku: string) =>
  (await rest(request, 'products?per_page=100')).products.find((p: { sku: string }) => p.sku === sku).id as number;

const tile = (page: Page, name: string) => page.locator('button.tile', { hasText: name });
const cart = (page: Page) => page.locator('aside.cart');
const modal = (page: Page) => page.locator('.modal').last();
const grandTotal = async (page: Page) => (await cart(page).locator('dd.grand').innerText()).trim();

let orderNumber = '';

test.describe.configure({ mode: 'serial' });

test('the device remembers who signed in last, and the charge button carries the total', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'admin', 'admin');
  // The money button says what it will charge, so the eye never leaves it.
  await tile(page, 'Long black').click();
  await expect(cart(page).locator('button.charge')).toContainText(/Charge/);
  await expect(cart(page).locator('button.charge')).toContainText(await grandTotal(page));
  await cart(page).getByRole('button', { name: 'Clear', exact: true }).click();
  // Sign out, and the username is already typed for the next shift.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Username or email')).toHaveValue('admin', { timeout: 10000 });
});

test('a remembered username arriving late leaves the username being entered alone', async ({ page }) => {
  await signIn(page, 'admin', 'admin');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Username or email')).toHaveValue('admin');
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = get.call(this, key);
      if (this.name === 'kv' && key === 'lastUser') {
        let delayed = false;
        request.addEventListener('success', (event) => {
          if (delayed) return;
          delayed = true;
          event.stopImmediatePropagation();
          setTimeout(() => {
            request.dispatchEvent(new Event('success'));
            (window as unknown as { rememberedRead: boolean }).rememberedRead = true;
          }, 1000);
        });
      }
      return request;
    };
  });
  await page.reload();
  await page.getByLabel('Username or email').fill('cashier');
  await expect.poll(() => page.evaluate(() => (window as unknown as { rememberedRead: boolean }).rememberedRead)).toBe(true);
  await expect(page.getByLabel('Username or email')).toHaveValue('cashier');
  await page.getByLabel('Password').fill('cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(tile(page, 'Butter croissant')).toBeVisible();
});

test('kiosk mode locks the device to being a till and survives a reload', async ({ page }) => {  await signIn(page, 'admin', 'admin');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const kioskToggle = page.getByLabel(/Kiosk mode/);
  await kioskToggle.setChecked(true);
  await expect(page.locator('html')).toHaveClass(/(^|\s)kiosk(\s|$)/);
  // The device remembers: reload and the kiosk class is back before sign-in finishes.
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/(^|\s)kiosk(\s|$)/, { timeout: 15000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel(/Kiosk mode/).setChecked(false);
  await expect(page.locator('html')).not.toHaveClass(/(^|\s)kiosk(\s|$)/);
});

test('the device takes the shop\u2019s colours and tile size, and tiles count what is on the sale', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'admin', 'admin');

  // A tile counts what is rung up on it, so the grid answers without opening the cart.
  await tile(page, 'Long black').click();
  await expect(tile(page, 'Long black').locator('.badge.in-sale')).toHaveText('×1');
  await tile(page, 'Long black').click();
  await expect(tile(page, 'Long black').locator('.badge.in-sale')).toHaveText('×2');
  await cart(page).getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(tile(page, 'Long black').locator('.badge.in-sale')).toHaveCount(0);

  // Accent and tile density are per-device choices, and they survive a reload.
  const navColour = () => page.evaluate(() => getComputedStyle(document.querySelector('.topbar nav button.active')!).color);
  const columns = () => page.evaluate(() => getComputedStyle(document.querySelector('.grid')!).gridTemplateColumns.split(' ').length);
  const comfortable = await columns();
  const cyan = await navColour();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Violet accent' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'violet');
  expect(await navColour()).not.toBe(cyan);

  await page.getByLabel('Product tiles').selectOption('compact');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await page.getByRole('button', { name: 'Sell', exact: true }).click();
  expect(await columns()).toBeGreaterThan(comfortable);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'violet', { timeout: 15000 });
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(tile(page, 'Long black')).toBeVisible({ timeout: 15000 });

  // Back the way it was, for the tests that follow.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Cyan accent' }).click();
  await page.getByLabel('Product tiles').selectOption('comfortable');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'cyan');
});

test('the sale reads at a glance: thumbnails, larger text, true black, and / goes to the search', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'admin', 'admin');

  // The line carries the product's photo, so a long sale scans at a glance.
  await tile(page, 'Flat white').click();
  await expect(cart(page).locator('.line img').first()).toBeVisible();

  // '/' reaches the search from anywhere outside a field, and a dialog doesn't have to be closed for it.
  await page.locator('body').click({ position: { x: 5, y: 790 } });
  await page.keyboard.press('/');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Search products');
  await page.keyboard.type('croiss');
  await expect(page.locator('.grid button.tile')).toHaveCount(1);
  await page.getByLabel('Search products').fill('');

  // Text size and true black are per-device choices, and they survive a reload.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Text size').selectOption('large');
  await expect(page.locator('html')).toHaveAttribute('data-text', 'large');
  await expect(page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).resolves.toBe('17.5px');

  await page.getByLabel(/True black/).setChecked(true);
  await expect(page.locator('html')).toHaveAttribute('data-black', 'true');

  // The open sale is saved to the device on a short debounce; let it settle before reloading.
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-text', 'large', { timeout: 15000 });
  await expect(page.locator('html')).toHaveAttribute('data-black', 'true');

  // Back the way it was, with an empty sale, for the tests that follow.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Text size').selectOption('standard');
  await page.getByLabel(/True black/).setChecked(false);
  await page.getByRole('button', { name: 'Sell', exact: true }).click();
  await cart(page).getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(cart(page)).toContainText('Tap a product');
});

test('the sale panel drags wider and the products make room for it, remembered on the device', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'admin', 'admin');

  const width = () => page.evaluate(() => document.getElementById('cart')!.offsetWidth);
  const columns = () => page.evaluate(() => getComputedStyle(document.querySelector('.grid')!).gridTemplateColumns.split(' ').length);
  const before = await width();
  const colsBefore = await columns();

  // Drag the divider left: the sale panel grows and the grid gives back a column at a time.
  const handle = page.locator('.divider');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 260, 200, { steps: 10 });
  await page.mouse.up();
  expect(await width()).toBeGreaterThan(before + 200);
  expect(await columns()).toBeLessThan(colsBefore);

  // The width is the device's, not the tab's.
  const dragged = await width();
  await page.reload();
  await expect(tile(page, 'Butter croissant')).toBeVisible({ timeout: 15000 });
  expect(await width()).toBe(dragged);

  // A double-click takes it back to the default.
  await handle.dblclick();
  expect(Math.abs((await width()) - before)).toBeLessThanOrEqual(2);
});

test('the keys reach the grid, and the Recent chip holds what this device sells', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'admin', 'admin');

  // Down from the search walks the grid; Enter on a tile rings it up. Typed at
  // human speed: a fast burst ending in Enter is a scanner's code, by design.
  await page.getByLabel('Search products').click();
  await page.keyboard.type('croiss', { delay: 60 });
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('tile') ?? false)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(cart(page)).toContainText('Butter croissant');
  await page.keyboard.press('Escape');
  await page.getByLabel('Search products').fill('');

  // The Recent chip is this device's own, freshest first, and it survives a reload.
  await tile(page, 'Long black').click();
  const recent = page.getByRole('button', { name: 'Recent', exact: true });
  await expect(recent).toBeVisible();
  await recent.click();
  await expect(tile(page, 'Butter croissant')).toBeVisible();
  await expect(tile(page, 'Long black')).toBeVisible();
  await expect(tile(page, 'Sourdough loaf')).toBeHidden();
  const names = await page.locator('.grid button.tile .name').allInnerTexts();
  expect(names.indexOf('Long black')).toBeLessThan(names.indexOf('Butter croissant'));

  // The open sale is saved on a short debounce; let it settle before reloading.
  await page.waitForTimeout(600);
  await page.reload();
  await expect(tile(page, 'Butter croissant')).toBeVisible({ timeout: 15000 });
  await expect(recent).toBeVisible();
  await cart(page).getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(cart(page)).toContainText('Tap a product');
});

test('custom items come again, the line editor previews, and what leaves comes back', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'admin', 'admin');

  // A custom item is offered again as a one-tap chip.
  await cart(page).getByRole('button', { name: 'Custom item' }).click();
  await page.getByLabel('Description').fill('Gift wrap');
  await page.getByLabel('Price').fill('2.50');
  await page.getByRole('button', { name: 'Add to sale' }).click();
  await expect(cart(page).locator('.line')).toHaveCount(1);
  await cart(page).getByRole('button', { name: 'Custom item' }).click();
  await page.getByRole('button', { name: 'Add Gift wrap again' }).click();
  await expect(cart(page).locator('.line')).toHaveCount(2);

  // The line editor previews its total as the numbers are typed.
  await cart(page).locator('.line').first().click();
  const editor = modal(page);
  await editor.getByLabel('Quantity').fill('3');
  await expect(editor).toContainText('Line total');
  await expect(editor.locator('.num')).toHaveText('$7.50');

  // Press and hold on a stepper keeps stepping.
  const plus = editor.getByRole('button', { name: 'One more' });
  const box = (await plus.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();
  await expect(editor.getByLabel('Quantity')).not.toHaveValue('3');

  // Removed, then back where it was.
  await editor.getByRole('button', { name: 'Remove' }).click();
  await expect(cart(page).locator('.line')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(cart(page).locator('.line')).toHaveCount(2);

  // Cleared, then back too.
  await cart(page).getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(cart(page)).toContainText('Tap a product');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(cart(page).locator('.line')).toHaveCount(2);
  await cart(page).getByRole('button', { name: 'Clear', exact: true }).click();
});

test('a custom colour and solid panels are the device\u2019s, kept over a reload', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'admin', 'admin');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const navColour = () => page.evaluate(() => getComputedStyle(document.querySelector('.topbar nav button.active')!).color);
  const before = await navColour();

  await page.getByLabel('Custom colour').fill('#e11d48');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom');
  expect(await navColour()).not.toBe(before);

  await page.getByLabel(/Solid panels/).setChecked(true);
  await expect(page.locator('html')).toHaveAttribute('data-solid', 'true');
  await expect(page.evaluate(() => getComputedStyle(document.querySelector('.topbar')!).backdropFilter)).resolves.toBe('none');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom', { timeout: 15000 });
  await expect(page.locator('html')).toHaveAttribute('data-solid', 'true');

  // A preset takes over from the custom colour again.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Cyan accent' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'cyan');
  await page.getByLabel(/Solid panels/).setChecked(false);
});

test('cashier rings up a mixed sale with a coupon and a split payment', async ({ page, request }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'cashier', 'cashier-pass');

  await tile(page, 'Flat white').click();
  await tile(page, 'Flat white').click();
  await expect(cart(page).locator('.line').first()).toContainText('2×');

  // A keyboard-wedge scanner types fast and ends with Enter.
  await page.locator('body').click({ position: { x: 5, y: 790 } });
  await page.keyboard.type('9300601000017', { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(cart(page)).toContainText('Butter croissant');

  await tile(page, 'Logo tee').click();
  await modal(page).getByRole('button', { name: /M/ }).click();
  await expect(cart(page)).toContainText('Logo tee');

  await cart(page).getByRole('button', { name: 'Custom item' }).click();
  await page.getByLabel('Description').fill('Gift wrap');
  await page.getByLabel('Price').fill('2.50');
  await page.getByRole('button', { name: 'Add to sale' }).click();
  await expect(cart(page).locator('.line')).toHaveCount(4);

  const before = await grandTotal(page);
  await cart(page).getByRole('button', { name: 'Coupon' }).click();
  await page.getByLabel('Coupon code').fill('TENOFF');
  await modal(page).getByRole('button', { name: 'Apply coupon' }).click();
  await expect(cart(page)).toContainText('TENOFF', { ignoreCase: true });
  await expect.poll(() => grandTotal(page)).not.toBe(before);
  const total = await grandTotal(page);

  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  const checkout = modal(page);
  await checkout.getByRole('button', { name: 'Card', exact: true }).click();
  for (const key of ['Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace']) await page.keyboard.press(key);
  await page.keyboard.type('1000');
  await checkout.getByRole('button', { name: /Take \$10\.00 \(split\)/ }).click();
  await expect(checkout).toContainText('Left to pay');
  await checkout.getByRole('button', { name: 'Cash', exact: true }).click();
  await checkout.locator('.quick button').last().click();

  const done = modal(page);
  await expect(done).toContainText('Sale complete');
  await expect(done.locator('.change')).toContainText('Change');
  await expect(done).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
  orderNumber = (await done.innerText()).match(/Saved as order #(\d+)/)![1];
  await expect(done.locator('.receipt')).toContainText(`Order #${orderNumber}`);
  await done.getByRole('button', { name: 'New sale' }).click();
  await expect(cart(page)).toContainText('Tap a product');

  const order = await rest(request, `orders/${orderNumber}`);
  expect(order.pos).toBe(true);
  expect(order.items).toHaveLength(4);
  expect(order.coupons.map((c: { code: string }) => c.code)).toEqual(['tenoff']);
  expect(`$${order.total.toFixed(2)}`).toBe(total);
  expect(order.payments.map((p: { method: string }) => p.method)).toEqual(['card', 'cash']);
  expect(order.payments[0].amount).toBe(10);
  expect(order.register.id).toBe('main');

  const { products } = await rest(request, 'products?per_page=100');
  expect(products.find((p: { sku: string }) => p.sku === 'CROISSANT').stock_quantity).toBe(39);
});

test('tips update the keypad, survive removing a split payment, and appear on receipts', async ({ page, request }) => {
  wp('option', 'update', 'shoptill_tips', 'yes');
  try {
    await signIn(page, 'admin', 'admin');
    await cart(page).getByRole('button', { name: 'Custom item' }).click();
    await page.getByLabel('Description').fill('Tip regression item');
    await page.getByLabel('Price').fill('10.00');
    await page.getByRole('button', { name: 'Add to sale' }).click();
    const base = Number((await grandTotal(page)).replace(/[^0-9.]/g, ''));
    const tip = Math.round(base * 20) / 100;
    const total = `$${(base + tip).toFixed(2)}`;
    await cart(page).getByRole('button', { name: /^Charge/ }).click();
    const checkout = modal(page);
    await checkout.getByRole('button', { name: '20%', exact: true }).click();
    await expect(checkout.locator('.entry')).toHaveText(total);
    await checkout.getByRole('button', { name: 'Card', exact: true }).click();
    await checkout.getByRole('button', { name: '1', exact: true }).click();
    await checkout.getByRole('button', { name: '0', exact: true }).click();
    await checkout.getByRole('button', { name: '0', exact: true }).click();
    await checkout.getByRole('button', { name: 'Take $1.00 (split)', exact: true }).click();
    await checkout.getByRole('button', { name: 'Remove Card payment of $1.00', exact: true }).click();
    await expect(checkout.locator('.entry')).toHaveText(total);
    await checkout.getByRole('button', { name: 'Cash', exact: true }).click();
    await checkout.getByRole('button', { name: `Take ${total}`, exact: true }).click();
    await expect(modal(page)).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
    const number = (await modal(page).innerText()).match(/Saved as order #(\d+)/)![1];
    await expect(modal(page).locator('.receipt')).toContainText('Tip');
    const order = await rest(request, `orders/${number}`);
    expect(order.total).toBeCloseTo(base + tip, 2);
    expect(order.fees).toEqual([{ name: 'Tip', total: tip, total_tax: 0 }]);
    await modal(page).getByRole('button', { name: 'New sale' }).click();
    await page.getByRole('button', { name: 'Orders', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(`#${number}\\b`) }).click();
    await page.evaluate(() => (window.print = () => {}));
    await modal(page).getByRole('button', { name: 'Reprint', exact: true }).click();
    await expect(page.locator('#print-root .receipt')).toContainText('Tip');
    await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    const report = page.locator('.report');
    await expect(report.getByText('Tips', { exact: true })).toBeVisible({ timeout: 30_000 });
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
    const download = await downloaded;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toMatch(/\r\nTips,\d/);
  } finally {
    wp('option', 'update', 'shoptill_tips', 'no');
  }
});

test('admin refunds an item and restocks it', async ({ page, request }) => {
  await signIn(page, 'admin', 'admin');
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByLabel('Search orders').fill(orderNumber);
  await page.getByRole('button', { name: new RegExp(`#${orderNumber}`) }).click();
  const detail = modal(page);
  await expect(detail).toContainText('Flat white');
  await detail.getByRole('button', { name: 'Refund' }).click();

  const refund = modal(page);
  await refund.getByRole('button', { name: 'More Butter croissant' }).click();
  await refund.getByLabel('Reason').fill('Dropped it');
  await refund.getByRole('button', { name: /^Refund \$/ }).click();
  await expect(page.locator('.modal')).toHaveCount(1);
  await expect(detail).toContainText('Dropped it');

  const order = await rest(request, `orders/${orderNumber}`);
  expect(order.refunds).toHaveLength(1);
  expect(order.items.find((i: { sku: string }) => i.sku === 'CROISSANT').qty_refunded).toBe(1);
  const { products } = await rest(request, 'products?per_page=100');
  expect(products.find((p: { sku: string }) => p.sku === 'CROISSANT').stock_quantity).toBe(40);
});

test('refunds: every item in one tap, a hold that keeps counting, and the list says just now', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'admin', 'admin');

  // A three-of-one sale, paid exactly.
  await tile(page, 'Flat white').click();
  await tile(page, 'Flat white').click();
  await tile(page, 'Flat white').click();
  await tile(page, 'Long black').click();
  const total = await grandTotal(page);
  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  await modal(page).getByRole('button', { name: 'Cash', exact: true }).click();
  await modal(page).locator('.quick button').last().click();

  const done = modal(page);
  await expect(done).toContainText('Sale complete');
  await expect(done).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
  const number = (await done.innerText()).match(/Saved as order #(\d+)/)![1];
  await done.getByRole('button', { name: 'New sale' }).click();

  // A sale made moments ago says so, in the shop's own clock.
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByLabel('Search orders').fill(number);
  await expect(page.locator('.order-list li').first()).toContainText('just now');

  await page.getByRole('button', { name: new RegExp(`#${number}`) }).click();
  const detail = modal(page);
  await detail.getByRole('button', { name: 'Refund' }).click();
  const refund = modal(page);

  // One tap picks the whole order.
  await refund.getByRole('button', { name: 'All items' }).click();
  await expect(refund.getByRole('button', { name: /^Refund \$/ })).toHaveText(`Refund ${total}`);

  // A press that stays down keeps counting: Flat white runs from 3 to 0 in one hold.
  const less = refund.getByRole('button', { name: 'Fewer Flat white' });
  const box = (await less.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();
  const rows = refund.locator('.refund-lines tr');
  await expect(rows.nth(0)).toContainText('0');
  // Taps still step one at a time: two back on.
  await refund.getByRole('button', { name: 'More Flat white' }).click();
  await refund.getByRole('button', { name: 'More Flat white' }).click();
  await expect(rows.nth(0)).toContainText('2');
  await expect(refund.getByRole('button', { name: /^Refund \$/ })).not.toHaveText(`Refund ${total}`);

  await refund.getByRole('button', { name: /^Refund \$/ }).click();
  await expect(page.locator('.modal')).toHaveCount(1);
  await expect(detail).toContainText('just now');
  await expect(detail).toContainText('2 refunded');
  await expect(detail).toContainText('1 refunded');
});

test('a refund whose answer was lost is applied once, and a changed one is not taken for it', async ({ page, request }) => {
  const remaining = async () => (await rest(request, `orders/${orderNumber}`)).remaining_refund as number;
  const start = await remaining();
  // The shop gets the first try of each, and the till never hears back.
  let drop = 0;
  await page.route('**/orders/*/refund', async (route) => {
    if (!drop) return route.continue();
    drop--;
    await route.fetch();
    await route.abort();
  });
  await signIn(page, 'admin', 'admin');
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByLabel('Search orders').fill(orderNumber);
  await page.getByRole('button', { name: new RegExp(`#${orderNumber}`) }).click();

  const byAmount = async (amount: string, retry?: string) => {
    drop = 1;
    await modal(page).getByRole('button', { name: 'Refund', exact: true }).click();
    const refund = modal(page);
    await refund.getByRole('button', { name: 'Amount', exact: true }).click();
    await refund.getByLabel(/^Amount/).fill(amount);
    await refund.getByRole('button', { name: /^Refund \$/ }).click();
    await expect(refund.locator('.error')).toBeVisible();
    if (retry) await refund.getByLabel(/^Amount/).fill(retry);
    await refund.getByRole('button', { name: /^Refund \$/ }).click();
    await expect(page.locator('.modal')).toHaveCount(1);
  };
  await byAmount('1.00');
  expect(await remaining()).toBeCloseTo(start - 1, 2);
  await byAmount('1.00', '0.50');
  expect(await remaining()).toBeCloseTo(start - 2.5, 2);
});

test('a sale made offline, even after a reload, syncs when the connection returns', async ({ page, context, request }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });

  await context.setOffline(true);
  await page.reload();
  await expect(tile(page, 'Butter croissant')).toBeVisible();
  await expect(page.locator('.topbar')).toContainText('Offline');

  await tile(page, 'Long black').click();
  await tile(page, 'Milk 2L').click();
  const total = await grandTotal(page);
  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  await modal(page).getByRole('button', { name: 'Exact' }).click();
  const done = modal(page);
  await expect(done).toContainText('kept on this device');
  await expect(done.locator('.receipt')).toContainText('Order pending sync');
  await done.getByRole('button', { name: 'Email receipt' }).click();
  await modal(page).getByLabel('Email').fill('walkin@example.com');
  await modal(page).getByRole('button', { name: 'Send' }).click();
  await expect(modal(page)).toContainText('as soon as the sale reaches the shop');
  await modal(page).getByRole('button', { name: 'Done' }).click();
  await done.getByRole('button', { name: 'New sale' }).click();

  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await expect(page.locator('main')).toContainText('Long black');

  await context.setOffline(false);
  await expect(page.locator('.topbar')).toContainText('Online', { timeout: 30_000 });
  await expect(page.locator('main')).not.toContainText('Long black', { timeout: 30_000 });
  await expect(page.locator('.toast')).toContainText('emailed to walkin@example.com', { timeout: 15_000 });

  const { orders } = await rest(request, 'orders?per_page=1');
  const order = await rest(request, `orders/${orders[0].id}`);
  expect(order.items.map((i: { sku: string }) => i.sku)).toEqual(['LONG-BLACK', 'MILK-2L']);
  expect(`$${order.total.toFixed(2)}`).toBe(total);
  expect(order.payments).toEqual([expect.objectContaining({ method: 'cash', amount: order.total })]);
  expect(order.email).toBe('walkin@example.com');
});

const latestOrderId = async (request: APIRequestContext) => (await rest(request, 'orders?per_page=1')).orders[0]?.id ?? 0;
const scan = async (page: Page, code: string) => {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
};

test('the keypad replaces the suggested amount, a scan leaves it alone, and a double tap sells once', async ({ page, request }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  const before = await latestOrderId(request);
  await tile(page, 'Long black').click();
  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  const checkout = modal(page);
  const entry = checkout.locator('.entry');
  await expect(entry).toHaveText('$4.66');

  // Typed at human speed: keys under SCAN_GAP apart would read as a scanner.
  await page.keyboard.press('2');
  await expect(entry).toHaveText('$0.02');
  await page.keyboard.type('000', { delay: 120 });
  await expect(entry).toHaveText('$20.00');
  await page.waitForTimeout(120);

  // A scanner firing while the checkout is open must not type into the amount, take a payment or add to the sale.
  await scan(page, '9300601000017');
  await expect(entry).toHaveText('$20.00');
  await expect(checkout).toContainText('To pay');
  await expect(cart(page)).not.toContainText('Butter croissant');

  await checkout.getByRole('button', { name: 'Exact' }).dblclick();
  const done = modal(page);
  await expect(done).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
  const { orders } = await rest(request, 'orders?per_page=5');
  expect(orders.filter((o: { id: number }) => o.id > before)).toHaveLength(1);

  // Scanning on the receipt screen starts the next sale with that item.
  await scan(page, '9300601000017');
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(cart(page)).toContainText('Butter croissant');
});

test('a regular takes it now and pays later at the till', async ({ page, request }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  await cart(page).getByRole('button', { name: '+ Customer' }).click();
  await page.getByLabel('Search customers').fill('jo');
  await modal(page).getByRole('button', { name: /jo@example\.com/ }).click();
  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  await modal(page).getByRole('button', { name: 'Pay later' }).click();

  const done = modal(page);
  await expect(done.locator('.change')).toContainText('To pay later $4.66');
  await expect(done.locator('.receipt')).toContainText('To pay later');
  await expect(done).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
  const number = (await done.innerText()).match(/Saved as order #(\d+)/)![1];
  expect((await rest(request, `orders/${number}`)).status).toBe('on-hold');
  await done.getByRole('button', { name: 'New sale' }).click();

  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByLabel('Search orders').fill(number);
  await page.getByRole('button', { name: new RegExp(`#${number}`) }).click();
  const detail = modal(page);
  await expect(detail).toContainText('Still owed');
  await detail.getByRole('button', { name: 'Take payment' }).click();
  const pay = modal(page);
  await pay.getByLabel('Paid with').selectOption('card');
  await pay.getByRole('button', { name: 'Take $4.66' }).click();
  await expect(page.locator('.modal')).toHaveCount(1);
  await expect(detail).not.toContainText('Still owed');

  const order = await rest(request, `orders/${number}`);
  expect(order.status).toBe('completed');
  expect(order.payments).toEqual([expect.objectContaining({ method: 'card', amount: 4.66 })]);
});

test('reports show the day for this register', async ({ page }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await page.getByRole('button', { name: 'Reports' }).click();
  const report = page.locator('.report');
  // The dev shop's day holds every test run's sales, thousands of them.
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report.locator('table').first()).toContainText('Cash');
  await expect(report.locator('table').first()).toContainText('Card');
  await expect(report).toContainText('Refunds');
  await expect(report).toContainText('Long black');
  await expect(report).toContainText('Casey Cashier');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const csv = readFileSync(await (await download).path(), 'utf8');
  // Excel needs the byte order mark to read the file as UTF-8.
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain('Product,SKU,Sold,Sales');
  expect(csv).toMatch(/Long black,LONG-BLACK,\d+,/);
});

test('parked sales stay on the till when someone else signs in', async ({ page }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  // A double tap parks the sale once, not an empty cart after it.
  await cart(page).getByRole('button', { name: 'Park', exact: true }).dblclick();
  await expect(cart(page).getByRole('button', { name: 'Parked (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn(page, 'admin', 'admin');
  await cart(page).getByRole('button', { name: 'Parked (1)' }).click();
  await modal(page).getByRole('button', { name: /Walk-in, 1 item/ }).click();
  await expect(cart(page)).toContainText('Long black');
});

test('tapping the Quantity caption leaves the quantity alone', async ({ page }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  await tile(page, 'Long black').click();
  await cart(page).locator('button.line').click();
  await modal(page).locator('label', { hasText: 'Quantity' }).click({ position: { x: 4, y: 4 } });
  await expect(modal(page).locator('.stepper input')).toHaveValue('2');
  await expect(modal(page).locator('.stepper input')).toBeFocused();
  await expect(modal(page).getByRole('textbox', { name: 'Quantity', exact: true })).toHaveValue('2');
  await expect(modal(page).getByRole('button', { name: 'Edit product' })).toHaveCount(0);
});

test('a mistyped price is refused, and a sale emptied of its lines can still be cleared', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  // Price changes and discounts are staff work now, so this runs signed in as staff.
  await signIn(page, 'admin', 'admin');
  await tile(page, 'Long black').click();
  await cart(page).locator('button.line').click();
  await modal(page).getByLabel('Unit price').fill('3.5.0');
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.toast')).toContainText('not a number');
  await modal(page).getByLabel('Unit price').fill('3,50');
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await cart(page).locator('button.line').click();
  await expect(modal(page).getByLabel('Unit price')).toHaveValue('3.5');
  await modal(page).getByRole('button', { name: 'Close' }).click();

  await cart(page).getByRole('button', { name: 'Discount', exact: true }).click();
  await modal(page).getByRole('button', { name: '20%' }).click();
  await cart(page).getByRole('button', { name: 'Note', exact: true }).click();
  await page.getByRole('textbox', { name: 'Order note' }).fill('Gift wrap');
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await cart(page).locator('button.line').click();
  await modal(page).getByRole('button', { name: 'Remove' }).click();
  // Or the discount and note go on the next customer's sale.
  await cart(page).getByRole('button', { name: 'Clear', exact: true }).click();
  await tile(page, 'Long black').click();
  await expect(cart(page).locator('dd.grand')).toBeVisible();
  await expect(cart(page)).not.toContainText('Sale discount');
  await cart(page).getByRole('button', { name: 'Note', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Order note' })).toHaveValue('');
});

test('Enter on the keypad takes what was typed, however fast', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  await tile(page, 'Long black').click();
  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  // Too few keys to be a scan, too fast for a render between them, as a macro key sends them.
  await page.keyboard.type('500');
  await page.keyboard.press('Enter');
  await expect(modal(page)).toContainText(/Cash\s*\$5\.00/);
  await modal(page).getByRole('button', { name: 'Close' }).click();
});

test('pinned products open the till, and a search still finds the rest', async ({ page, request }) => {
  const id = await productId(request, 'LONG-BLACK');
  editProduct(id, '$p->set_featured(true);');
  try {
    await signIn(page, 'cashier', 'cashier-pass', 'Long black');
    await expect(page.getByRole('button', { name: 'Pinned' })).toHaveClass(/active/);
    await expect(page.locator('button.tile')).toHaveCount(1);
    await page.getByLabel('Search products').fill('croiss');
    await expect(tile(page, 'Butter croissant')).toBeVisible();
    await page.getByLabel('Search products').fill('');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(tile(page, 'Reusable cup')).toBeVisible();
  } finally {
    editProduct(id, '$p->set_featured(false);');
  }
});

test('another tab of the till sees the stock a sale took straight away', async ({ page, context }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  const other = await context.newPage();
  await other.goto('/pos/');
  await expect(tile(other, 'Reusable cup')).toBeVisible();
  await expect(tile(other, 'Reusable cup')).not.toContainText('left');

  for (let i = 0; i < 3; i++) await tile(page, 'Reusable cup').click();
  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  await modal(page).getByRole('button', { name: 'Exact' }).click();
  await expect(modal(page)).toContainText(/Saved as order #\d+/, { timeout: 20_000 });

  // Well inside the minute between stock polls.
  await expect(tile(other, 'Reusable cup')).toContainText('5 left', { timeout: 10_000 });
});

test('staff change a price and count stock from the till', async ({ page, request }) => {
  const id = await productId(request, 'KEEPCUP');
  try {
    await signIn(page, 'admin', 'admin');
    await tile(page, 'Reusable cup').click();
    await cart(page).locator('button.line').click();
    await modal(page).getByRole('button', { name: 'Edit product' }).click();
    const editor = modal(page);
    await editor.getByLabel('Regular price').fill('21.50');
    await editor.getByLabel('In stock').fill('4');
    await editor.getByRole('button', { name: 'Save to shop' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(tile(page, 'Reusable cup')).toContainText('4 left');

    // The line was at the old shelf price, so it follows the new one.
    await cart(page).locator('button.line').click();
    await expect(modal(page).getByLabel('Unit price')).toHaveValue('21.5');
    const saved = (await rest(request, 'products?per_page=100')).products.find((p: { id: number }) => p.id === id);
    expect(saved.regular_price).toBe(21.5);
    expect(saved.stock_quantity).toBe(4);
  } finally {
    editProduct(id, "$p->set_regular_price('19.95'); $p->set_stock_quantity(8);");
  }
});

test('the product editor leaves alone what the cashier did not change', async ({ page, request }) => {
  const id = await productId(request, 'KEEPCUP');
  try {
    await signIn(page, 'admin', 'admin');
    await tile(page, 'Reusable cup').click();
    await cart(page).locator('button.line').click();
    await modal(page).getByRole('button', { name: 'Edit product' }).click();

    // Another till sells some while the dialog is open, and this till's next poll brings it in.
    editProduct(id, '$p->set_stock_quantity(5);');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(tile(page, 'Reusable cup')).toContainText('5 left');

    const editor = modal(page);
    await editor.getByLabel('Regular price').fill('');
    await editor.getByLabel('Sale price').fill('15');
    await editor.getByRole('button', { name: 'Save to shop' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);

    const saved = (await rest(request, 'products?per_page=100')).products.find((p: { id: number }) => p.id === id);
    expect(saved.regular_price).toBe(19.95);
    expect(saved.price).toBe(15);
    expect(saved.stock_quantity).toBe(5);
  } finally {
    editProduct(id, "$p->set_sale_price(''); $p->set_stock_quantity(8);");
  }
});

test('a stock count started before another till sold some is sent back to be counted again', async ({ page, request }) => {
  const id = await productId(request, 'KEEPCUP');
  try {
    await signIn(page, 'admin', 'admin');
    await tile(page, 'Reusable cup').click();
    await cart(page).locator('button.line').click();
    await modal(page).getByRole('button', { name: 'Edit product' }).click();
    const editor = modal(page);
    await expect(editor.getByLabel('In stock')).toHaveValue('8');

    editProduct(id, '$p->set_stock_quantity(5);');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(tile(page, 'Reusable cup')).toContainText('5 left');
    await editor.getByLabel('In stock').fill('4');
    await editor.getByRole('button', { name: 'Save to shop' }).click();
    await expect(editor).toContainText('The stock changed while you were counting');
    await expect(editor.getByLabel('In stock')).toHaveValue('5');

    await editor.getByLabel('In stock').fill('4');
    await editor.getByRole('button', { name: 'Save to shop' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    expect((await rest(request, 'products?per_page=100')).products.find((p: { id: number }) => p.id === id).stock_quantity).toBe(4);
  } finally {
    editProduct(id, '$p->set_stock_quantity(8);');
  }
});

test('the keyboard reaches every button in a dialog, and Enter presses the one it is on', async ({ page }) => {
  // The line editor's price and discount fields are staff's, and this test tabs through them.
  await signIn(page, 'admin', 'admin');
  await tile(page, 'Long black').click();
  await cart(page).locator('button.line').click();
  const editor = modal(page);
  await expect(editor.getByRole('textbox', { name: 'Quantity', exact: true })).toBeFocused();
  await editor.getByRole('button', { name: '%' }).focus();
  // The editor's buttons differ by what the account may edit, so Tab walks until Save.
  for (let i = 0; i < 5; i++) {
    if (await editor.getByRole('button', { name: 'Save' }).evaluate((el) => document.activeElement === el)) break;
    await page.keyboard.press('Tab');
  }
  await expect(editor.getByRole('button', { name: 'Save' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.modal')).toHaveCount(0);

  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  const checkout = modal(page);
  await checkout.getByRole('button', { name: 'Card', exact: true }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(checkout.getByRole('button', { name: 'Card', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(checkout).toContainText('To pay');

  // A tapped button keeps no claim on Enter, which still takes the payment.
  await checkout.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.keyboard.press('Enter');
  await expect(modal(page)).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
});

test('a scan with a dialog open stays out of its fields', async ({ page }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  await cart(page).locator('button.line').click();
  const qty = modal(page).getByRole('textbox', { name: 'Quantity', exact: true });
  await expect(qty).toBeFocused();
  await scan(page, '9300601000017');
  await expect(qty).toHaveValue('1');
  await modal(page).getByRole('button', { name: 'Close' }).click();

  await cart(page).getByRole('button', { name: 'Note', exact: true }).click();
  const note = page.getByRole('textbox', { name: 'Order note' });
  await note.fill('Oat milk');
  await scan(page, '9300601000017');
  await expect(note).toHaveValue('Oat milk');
});

test('a coupon scanned into its field is kept, and a drag out of a dialog leaves it open', async ({ page }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  await cart(page).getByRole('button', { name: 'Coupon' }).click();
  const field = page.getByLabel('Coupon code');
  await field.fill('selected text');
  // Selecting text in a field and letting go past the dialog's edge.
  const box = (await field.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(3, 3, { steps: 5 });
  await page.mouse.up();
  await expect(field).toBeVisible();

  await field.fill('');
  await scan(page, 'TENOFF');
  await expect(cart(page)).toContainText('TENOFF', { ignoreCase: true });
});

test('a sale open in one tab shows in the others', async ({ page, context }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  const other = await context.newPage();
  await other.goto('/pos/');
  await expect(tile(other, 'Long black')).toBeVisible();
  await tile(page, 'Long black').click();
  await expect(cart(other)).toContainText('Long black');
});

test('a sale charged in one tab is not charged again in another', async ({ page, context }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  const other = await context.newPage();
  await other.goto('/pos/');
  await expect(tile(other, 'Long black')).toBeVisible();
  await tile(page, 'Long black').click();
  await expect(cart(other)).toContainText('Long black');
  await cart(other).getByRole('button', { name: /^Charge/ }).click();

  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  await modal(page).getByRole('button', { name: 'Exact' }).click();
  await expect(modal(page)).toContainText(/Saved as order #\d+/, { timeout: 20_000 });

  await modal(other).getByRole('button', { name: 'Exact' }).click();
  await expect(other.locator('.toast')).toContainText('another tab');
  await expect(other.locator('.modal')).toHaveCount(0);
  await expect(cart(other).locator('.line')).toHaveCount(0);

  // The tab still showing its sale done follows the next sale started elsewhere.
  await tile(other, 'Flat white').click();
  await modal(page).getByRole('button', { name: 'New sale' }).click();
  await expect(cart(page)).toContainText('Flat white');
});

test('a coupon sale goes through with the till open in another tab', async ({ page, context }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  const other = await context.newPage();
  await other.goto('/pos/');
  await expect(tile(other, 'Long black')).toBeVisible();
  // The other tab works the coupon out again and sends the same sale back. Hold that until this tab is taking payment.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await other.route('**/orders/preview*', async (route) => {
    await held;
    await route.continue();
  });

  await tile(page, 'Long black').click();
  await cart(page).getByRole('button', { name: 'Coupon' }).click();
  await page.getByLabel('Coupon code').fill('TENOFF');
  await modal(page).getByRole('button', { name: 'Apply coupon' }).click();
  await expect(cart(page)).toContainText('TENOFF', { ignoreCase: true });
  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  await expect(modal(page).getByRole('button', { name: 'Exact' })).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { heard: number };
    w.heard = 0;
    new BroadcastChannel('shoptill-cart').onmessage = () => w.heard++;
  });
  release();
  await expect.poll(() => page.evaluate(() => (window as unknown as { heard: number }).heard)).toBeGreaterThan(0);

  await modal(page).getByRole('button', { name: 'Exact' }).click();
  await expect(modal(page)).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
});

test('a sale changed in another tab during payment reaches this one without coming back', async ({ page, context }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  const other = await context.newPage();
  await other.goto('/pos/');
  await expect(tile(other, 'Long black')).toBeVisible();
  await tile(page, 'Long black').click();
  await expect(cart(other)).toContainText('Long black');
  await cart(page).getByRole('button', { name: /^Charge/ }).click();

  await tile(other, 'Butter croissant').click();
  await cart(other).getByRole('button', { name: /^Charge/ }).click();
  await modal(page).getByRole('button', { name: 'Close' }).click();
  await expect(cart(page)).toContainText('Butter croissant');

  await modal(other).getByRole('button', { name: 'Exact' }).click();
  await expect(modal(other)).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
});

test('a coupon priced offline keeps the total being charged when the connection comes back', async ({ page, context }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  await cart(page).getByRole('button', { name: 'Coupon' }).click();
  await page.getByLabel('Coupon code').fill('TENOFF');
  await modal(page).getByRole('button', { name: 'Apply coupon' }).click();
  await expect(cart(page)).toContainText('TENOFF', { ignoreCase: true });
  await context.setOffline(true);
  await expect(page.locator('.topbar')).toContainText('Offline');
  await tile(page, 'Butter croissant').click();
  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  await expect(modal(page).getByRole('button', { name: 'Exact' })).toBeVisible();

  let previews = 0;
  page.on('request', (r) => void (r.url().includes('orders/preview') && previews++));
  await context.setOffline(false);
  await expect(page.locator('.topbar')).toContainText('Online', { timeout: 30_000 });
  await page.waitForTimeout(1000);
  expect(previews).toBe(0);
  await modal(page).getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => previews).toBeGreaterThan(0);
});

test('a coupon answer that arrives after checkout opened leaves the total being charged', async ({ page, context }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  await cart(page).getByRole('button', { name: 'Coupon' }).click();
  await page.getByLabel('Coupon code').fill('TENOFF');
  await modal(page).getByRole('button', { name: 'Apply coupon' }).click();
  await expect(cart(page)).toContainText('TENOFF', { ignoreCase: true });

  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let asked = 0;
  await page.route('**/shoptill/v1/orders/preview*', async (route) => {
    asked++;
    const res = await route.fetch();
    await held;
    await route.fulfill({ response: res });
  });
  await tile(page, 'Butter croissant').click();
  await expect.poll(() => asked).toBe(1);
  // The browser thinks the connection went, so the till stops waiting for the answer.
  await context.setOffline(true);
  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  await expect(modal(page).getByRole('button', { name: 'Exact' })).toBeVisible();
  const charged = await modal(page).innerText();
  release();
  await page.waitForTimeout(1000);
  expect(await modal(page).innerText()).toBe(charged);
  await context.setOffline(false);
});

test('signing in while the last user is still syncing leaves the till with the new user', async ({ page, request }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let boots = 0;
  await page.route('**/shoptill/v1/bootstrap*', async (route) => {
    if (boots++ === 0) await held;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Re-sync products' }).click();
  await expect.poll(() => boots).toBe(1);
  await page.getByRole('button', { name: 'Sign out' }).click();
  // The remembered username lands first; type over it once it has.
  await expect(page.getByLabel('Username or email')).toHaveValue('cashier');
  await page.getByLabel('Username or email').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => boots).toBe(2);
  release();

  // Still on Settings, where the till was when the last user signed out.
  await expect(page.locator('main')).toContainText(`Signed in as ${(await rest(request, 'bootstrap')).user.name}`);
  await expect(page.locator('main')).toContainText(/[1-9]\d* products on this device/);
});

test('a delayed logout cannot sign out the next cashier', async ({ page }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = false;
  await page.route('**/shoptill/v1/auth/logout*', async (route) => {
    started = true;
    await held;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => started).toBe(true);
  await expect(page.getByLabel('Username or email')).toHaveValue('cashier');
  await page.getByLabel('Username or email').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('main')).toContainText('Signed in as');
  const loggedOut = page.waitForResponse('**/shoptill/v1/auth/logout*');
  release();
  await loggedOut;
  await page.reload();
  await expect(tile(page, 'Butter croissant')).toBeVisible();
});

test('closing a quantity dialog stops its held-button timer', async ({ page }) => {
  await signIn(page, 'admin', 'admin');
  await tile(page, 'Long black').click();
  await cart(page).locator('.line').first().click();
  await page.evaluate(() => {
    const w = window as unknown as { repeating: Set<number> };
    w.repeating = new Set();
    const start = window.setInterval.bind(window);
    const stop = window.clearInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, delay?: number) => {
      const id = start(handler, delay);
      if (delay === 110) w.repeating.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (id !== undefined) w.repeating.delete(id);
      stop(id);
    }) as typeof window.clearInterval;
  });
  const button = await modal(page).getByRole('button', { name: 'One more', exact: true }).boundingBox();
  await page.mouse.move(button!.x + button!.width / 2, button!.y + button!.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => (window as unknown as { repeating: Set<number> }).repeating.size)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(modal(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { repeating: Set<number> }).repeating.size)).toBe(0);
  await page.mouse.up();
});

test('a sale left open is still there after signing out and back in', async ({ page }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  // The open sale is written to the device 300ms after it changes.
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Username or email')).toBeVisible();
  await signIn(page, 'cashier', 'cashier-pass');
  await expect(cart(page)).toContainText('Long black');
});

test('a till whose storage will not open says so', async ({ page }) => {
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new Error('Storage is switched off');
    };
  });
  await page.goto('/pos/');
  await expect(page.locator('main.login')).toContainText('Storage is switched off');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('staff see where a web order goes and mark it done', async ({ page }) => {
  const id = wp(
    'eval',
    `$o = wc_create_order(); $o->add_product(wc_get_product(wc_get_product_id_by_sku('LONG-BLACK')), 1); $o->set_shipping_first_name('Sam'); $o->set_shipping_address_1('12 Mill Lane'); $o->set_shipping_city('Leeds'); $o->set_shipping_country('GB'); $o->calculate_totals(); $o->set_status('processing'); $o->save(); echo $o->get_order_number();`,
  ).toString();
  await signIn(page, 'admin', 'admin');
  const toPack = page.getByRole('button', { name: /orders? to pack/ });
  await expect(toPack).toHaveText(/^\d+$/);
  const waiting = Number(await toPack.innerText());
  await toPack.click();
  await expect(page.getByLabel('Source')).toHaveValue('web');
  await expect(page.locator('main select[aria-label="Status"]')).toHaveValue('processing');
  await page.getByLabel('Search orders').fill(id);
  await page.getByRole('button', { name: new RegExp(`#${id}`) }).click();
  await expect(modal(page).locator('.fulfilment')).toContainText('12 Mill Lane');
  await modal(page).getByLabel('Status').selectOption('completed');
  await expect(modal(page).locator('.order-detail > p.muted')).toContainText('processing');
  await modal(page).getByRole('button', { name: 'Set status' }).click();
  await expect(modal(page).locator('.order-detail > p.muted')).toContainText('completed');
  await modal(page).getByRole('button', { name: 'Close' }).click();
  await (waiting > 1 ? expect(toPack).toHaveText(String(waiting - 1)) : expect(toPack).toHaveCount(0));
});

test('the drawer count is checked against the cash the register took', async ({ page }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await page.getByRole('button', { name: 'Reports' }).click();
  await page.getByLabel('Opening float').fill('100');
  // Earlier runs today closed this drawer too.
  const closes = page.locator('.report p', { hasText: 'counted against' });
  const before = await closes.count();
  await page.getByLabel('Cash counted').fill('100');
  await page.getByRole('button', { name: 'Close drawer' }).click();
  await expect(closes).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(closes.last()).toContainText(/\$100\.00 counted against \$[\d,.]+ expected, \$100\.00 of it float, by Casey Cashier/);
  // A recount starts from the same float.
  await expect(page.getByLabel('Opening float')).toHaveValue('100');
});

test('cash paid out of the drawer comes off what the count expects', async ({ page }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await page.getByRole('button', { name: 'Reports' }).click();
  await expect(page.getByLabel('Cash amount')).toBeVisible({ timeout: 30_000 });
  const expected = page.locator('.report p', { hasText: 'Cash expected in the drawer' }).locator('strong');
  const drawer = async () => ((await expected.count()) ? Number((await expected.innerText()).replace(/[^\d.-]/g, '')) : 0);
  const before = await drawer();
  // Earlier runs today paid the window cleaner too.
  const lines = page.locator('.report p', { hasText: 'for Window cleaner' });
  const paid = await lines.count();
  await page.getByLabel('Cash in or out').selectOption('out');
  await page.getByLabel('Cash amount').fill('7.50');
  await page.getByLabel('What the cash was for').fill('Window cleaner');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(lines).toHaveCount(paid + 1, { timeout: 30_000 });
  await expect(lines.last()).toContainText('$7.50 paid out for Window cleaner, by Casey Cashier');
  expect(await drawer()).toBeCloseTo(before - 7.5, 2);
  await expect(page.getByLabel('Cash amount')).toHaveValue('');
});

test('a reprint from order history says it is a copy, and a gift receipt leaves out the money', async ({ page }) => {
  await signIn(page, 'admin', 'admin');
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByLabel('Search orders').fill(orderNumber);
  await page.getByRole('button', { name: new RegExp(`#${orderNumber}`) }).click();
  await page.evaluate(() => {
    const w = window as unknown as { prints: boolean[] };
    w.prints = [];
    window.print = () => {
      w.prints.push(document.documentElement.classList.contains('printing-receipt'));
      dispatchEvent(new Event('afterprint'));
    };
  });
  await modal(page).getByRole('button', { name: 'Reprint' }).dblclick();
  await expect.poll(() => page.evaluate(() => (window as unknown as { prints: boolean[] }).prints)).toEqual([true]);
  await page.evaluate(() => (window.print = () => {}));
  await modal(page).getByRole('button', { name: 'Reprint' }).click();
  await expect(page.locator('#print-root .receipt')).toContainText('Copy');
  const total = page.locator('#print-root .receipt .total');
  await expect(total).toHaveCount(1);
  await page.evaluate(() => dispatchEvent(new Event('afterprint')));
  await modal(page).getByRole('button', { name: 'Gift receipt' }).click();
  const gift = page.locator('#print-root .receipt');
  await expect(gift).toContainText('Gift receipt');
  await expect(gift).toContainText('Flat white');
  await expect(gift).not.toContainText('$');
  await expect(total).toHaveCount(0);
});

test('a customer is edited from the till, and their address is where a delivery goes', async ({ page }) => {
  const email = `robin-${Date.now()}@example.com`;
  await signIn(page, 'cashier', 'cashier-pass');
  try {
    await tile(page, 'Long black').click();
    await cart(page).getByRole('button', { name: '+ Customer' }).click();
    await page.getByLabel('Search customers').fill('Robin Tester');
    await modal(page).getByRole('button', { name: '+ New customer' }).click();
    await modal(page).getByLabel('Email').fill(email);
    await modal(page).getByRole('button', { name: 'Create customer' }).click();
    await cart(page).getByRole('button', { name: 'Robin Tester' }).click();
    await modal(page).getByRole('button', { name: 'Details' }).click();
    await expect(modal(page)).toContainText('0 orders');
    await modal(page).getByRole('button', { name: 'Edit' }).click();
    await expect(modal(page).getByLabel('Email')).not.toBeEditable();
    await modal(page).getByLabel('Phone').fill('0113 496 0999');
    await modal(page).locator('summary', { hasText: 'Address' }).click();
    await modal(page).getByLabel('Street', { exact: true }).fill('1 High St');
    await modal(page).getByLabel('Town or city').fill('Leeds');
    await modal(page).getByLabel('Country').selectOption('GB');
    await modal(page).getByRole('button', { name: 'Save' }).click();
    await expect(modal(page)).toContainText('1 High St');
    await expect(modal(page)).toContainText('United Kingdom');
    await modal(page).getByRole('button', { name: 'Close' }).click();
    await modal(page).getByRole('button', { name: 'Close' }).click();

    await cart(page).getByRole('button', { name: 'Collect or deliver' }).click();
    await modal(page).getByRole('button', { name: 'Deliver', exact: true }).click();
    await expect(modal(page).getByLabel('Street', { exact: true })).toHaveValue('1 High St');
    await modal(page).getByRole('button', { name: 'Save' }).click();
    await expect(cart(page)).toContainText('To deliver to Robin Tester, 1 High St, Leeds, United Kingdom');

    await cart(page).getByRole('button', { name: /^Charge/ }).click();
    await modal(page).getByRole('button', { name: 'Cash', exact: true }).click();
    await modal(page).locator('.quick button').last().click();
    await expect(modal(page).locator('.receipt')).toContainText('Deliver to');
    await expect(modal(page)).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
    const number = (await modal(page).innerText()).match(/Saved as order #(\d+)/)![1];
    await modal(page).getByRole('button', { name: 'New sale' }).click();
    await page.getByRole('button', { name: 'Orders', exact: true }).click();
    await page.getByLabel('Search orders').fill(number);
    await page.getByRole('button', { name: new RegExp(`#${number}`) }).click();
    await expect(modal(page).locator('.fulfilment')).toContainText('Deliver to');
    await expect(modal(page).locator('.fulfilment')).toContainText('1 High St');
    await modal(page).getByLabel('Status').selectOption('completed');
    await modal(page).getByRole('button', { name: 'Set status' }).click();
    await expect(modal(page).locator('.order-detail > p.muted')).toContainText('completed');
  } finally {
    wp('eval', `require_once ABSPATH . 'wp-admin/includes/user.php'; $u = get_user_by('email', '${email}'); $u && wp_delete_user($u->ID);`);
  }
});

test('a sale to collect waits under Orders with its staff note until the cashier hands it over', async ({ page }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  await cart(page).getByRole('button', { name: 'Note', exact: true }).click();
  await modal(page).getByLabel('Order note').fill('Gift, wrap it');
  await modal(page).getByLabel('Staff only, not on the receipt').check();
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await cart(page).getByRole('button', { name: 'Collect or deliver' }).click();
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(cart(page)).toContainText('To be collected later.');
  await expect(cart(page)).toContainText('Staff note: Gift, wrap it');

  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  await modal(page).getByRole('button', { name: 'Cash', exact: true }).click();
  // The count of sales to collect as it stands once this one is in.
  const counted = page
    .waitForResponse((r) => r.request().method() === 'POST' && /[/]orders($|[?&])/.test(r.url()))
    .then(() => page.waitForResponse((r) => r.url().includes('source=later')))
    .then(async (r) => (await r.json()).total as number);
  await modal(page).locator('.quick button').last().click();
  const done = modal(page);
  await expect(done.locator('.receipt')).toContainText('To collect');
  await expect(done.locator('.receipt')).not.toContainText('Gift, wrap it');
  await expect(done).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
  const number = (await done.innerText()).match(/Saved as order #(\d+)/)![1];
  await done.getByRole('button', { name: 'New sale' }).click();

  const toPack = page.getByRole('button', { name: /orders? to pack/ });
  const waiting = await counted;
  await expect(toPack).toHaveText(String(waiting));
  await toPack.click();
  await expect(page.getByLabel('Source')).toHaveValue('later');
  await page.getByLabel('Search orders').fill(number);
  await page.getByRole('button', { name: new RegExp(`#${number}`) }).click();
  const detail = modal(page);
  await expect(detail.locator('.fulfilment')).toContainText('To collect');
  await detail.locator('summary', { hasText: 'Notes' }).click();
  await expect(detail.locator('.notes')).toContainText('Gift, wrap it');
  await detail.getByRole('button', { name: 'Add note' }).click();
  await modal(page).getByLabel('Note').fill('Rang, collecting Friday');
  await modal(page).getByRole('button', { name: 'Add note' }).click();
  await expect(page.locator('.modal')).toHaveCount(1);
  await expect(detail.locator('.notes')).toContainText('Rang, collecting Friday');
  await expect(detail.locator('.notes')).toContainText('Casey Cashier');

  await detail.getByLabel('Status').selectOption('completed');
  await detail.getByRole('button', { name: 'Set status' }).click();
  await expect(detail.locator('.order-detail > p.muted')).toContainText('completed');
  await detail.getByRole('button', { name: 'Close' }).click();
  await (waiting > 1 ? expect(toPack).toHaveText(String(waiting - 1)) : expect(toPack).toHaveCount(0));
});

test('a delivery charge goes on the sale, its receipt and the order', async ({ page, request }) => {
  await signIn(page, 'cashier', 'cashier-pass');
  await tile(page, 'Long black').click();
  await cart(page).getByRole('button', { name: 'Collect or deliver' }).click();
  await modal(page).getByRole('button', { name: 'Deliver', exact: true }).click();
  await modal(page).getByLabel('First name').fill('Ana');
  await modal(page).getByLabel('Street', { exact: true }).fill('9 Rue Neuve');
  await modal(page).getByLabel('Town or city').fill('Lyon');
  await modal(page).getByLabel('Postcode').fill('69001');
  await modal(page).getByLabel('Country').selectOption('FR');
  await modal(page).getByLabel('Delivery charge').fill('4.50');
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(cart(page)).toContainText('To deliver to Ana');
  await expect(cart(page)).toContainText(' for $4.50.');
  await expect(cart(page).locator('.totals')).toContainText('Delivery');

  const total = await grandTotal(page);
  await cart(page).getByRole('button', { name: /^Charge/ }).click();
  await modal(page).getByRole('button', { name: 'Cash', exact: true }).click();
  await modal(page).locator('.quick button').last().click();
  const done = modal(page);
  await expect(done).toContainText('Sale complete');
  const receipt = done.locator('.receipt');
  await expect(receipt).toContainText('Deliver to');
  await expect(receipt).toContainText('Delivery');
  await expect(receipt.locator('.row', { hasText: 'Delivery' })).toContainText('$4.50');
  await expect(done).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
  const number = (await done.innerText()).match(/Saved as order #(\d+)/)![1];
  await done.getByRole('button', { name: 'New sale' }).click();

  const order = await rest(request, `orders/${number}`);
  expect(order.fulfil).toBe('deliver');
  expect(order.shipping_method).toBe('Delivery');
  expect(order.shipping_total).toBeGreaterThan(0);
  expect(`$${order.total.toFixed(2)}`).toBe(total);
});

test('a phone carries the sale in a sheet and charges from it', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 360, height: 740 });
  await signIn(page, 'cashier', 'cashier-pass');

  await tile(page, 'Flat white').click();
  await tile(page, 'Long black').click();
  const sheet = cart(page);
  // Collapsed, the tab carries the sale and the lines stay tucked away.
  await expect(sheet.locator('.cart-tab')).toContainText('2 items');
  await expect(sheet).not.toHaveClass(/open/);
  await sheet.locator('.tab-info').click();
  await expect(sheet).toHaveClass(/open/);
  await expect(sheet.locator('.line').first()).toBeVisible();

  await sheet.locator('.tab-info').click();
  await expect(sheet).not.toHaveClass(/open/);
  await sheet.locator('.tab-charge').click();
  const checkout = modal(page);
  await expect(checkout).toContainText('Charge $');
  await checkout.getByRole('button', { name: 'Cash', exact: true }).click();
  await checkout.locator('.quick button').last().click();
  const done = modal(page);
  await expect(done).toContainText('Sale complete');
  await expect(done).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
  await done.getByRole('button', { name: 'New sale' }).click();
});

test('staff set a cost from the till and see the profit, cashiers do not', async ({ page, request }) => {
  const id = await productId(request, 'KEEPCUP');
  try {
    // The cost plugin's numbers on the day, before this test adds to them.
    const before = await rest(request, 'reports/summary?register_id=main');
    if (before.totals.cost === undefined) test.skip(true, 'no cost plugin');
    const costBefore = before.totals.cost as number;

    await signIn(page, 'admin', 'admin');
    await tile(page, 'Reusable cup').click();
    await cart(page).locator('button.line').click();
    await modal(page).getByRole('button', { name: 'Edit product' }).click();
    const editor = modal(page);
    await editor.getByLabel('Cost', { exact: true }).fill('9.40');
    await expect(editor.getByLabel('Regular price', { exact: true })).toHaveValue('19.95');
    await editor.getByRole('button', { name: 'Save to shop' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    const saved = (await rest(request, 'products?per_page=100')).products.find((p: { id: number }) => p.id === id);
    expect(saved.cost).toBe(9.4);

    // The sale carries the cost onto the order, in the cost plugin's own meta.
    const counted = page.waitForResponse((r) => r.request().method() === 'POST' && /[/]orders($|[?&])/.test(r.url()));
    await cart(page).getByRole('button', { name: /^Charge/ }).click();
    await modal(page).getByRole('button', { name: 'Cash', exact: true }).click();
    await modal(page).locator('.quick button').last().click();
    const done = modal(page);
    await expect(done).toContainText(/Saved as order #\d+/, { timeout: 20_000 });
    const number = (await done.innerText()).match(/Saved as order #(\d+)/)![1];
    await done.getByRole('button', { name: 'New sale' }).click();
    await counted;
    const stamped = wp('eval', `$o = wc_get_order(${number}); foreach ($o->get_items() as $i) { echo $i->get_meta('_alg_wc_cog_item_cost'); }`).toString();
    expect(stamped).toBe('9.4');
    // The report shows the staff the day's cost and profit, with the product's net cost beside its sales.
    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    await expect(page.locator('.stats')).toContainText('Cost of goods', { timeout: 20_000 });
    await expect(page.locator('.stats')).toContainText('Profit');
    const cells = page.getByRole('table').filter({ hasText: 'Reusable cup' }).first().locator('tr', { hasText: 'Reusable cup' }).locator('td');
    await expect(cells.nth(2)).toHaveText(/\$\d/);
    await expect(cells.nth(3)).toHaveText(/\$\d/);

    // A cashier sees neither the numbers nor the columns.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, 'cashier', 'cashier-pass');
    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    await expect(page.locator('.report')).not.toContainText('Cost of goods', { timeout: 20_000 });
    await expect(page.locator('.report')).not.toContainText('Profit');

    const after = await rest(request, 'reports/summary?register_id=main');
    // The day keeps what earlier runs put on it, so this only has to have grown by this sale's cost.
    expect(after.totals.cost).toBeGreaterThanOrEqual(costBefore + 9.4 - 0.005);
  } finally {
    wp('eval', `delete_post_meta(${id}, '_alg_wc_cog_cost');`);
  }
});
