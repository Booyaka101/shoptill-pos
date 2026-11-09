# ShopTill

Source, bug reports and contributions:
[Booyaka101/shoptill-pos](https://github.com/Booyaka101/shoptill-pos).

A point of sale for small shops that sells straight from a WooCommerce catalogue, the way FooSales does. It has two parts:

- `plugin/shoptill` is a WordPress plugin. It adds a REST API under `/wp-json/shoptill/v1`, POS settings, registers, a cashier role and receipt emails, and it serves the till at `https://your-shop/pos/`.
- `app` is the till itself, a Preact PWA. It runs in a browser on a tablet, laptop or phone, stores the catalogue in IndexedDB, and keeps selling when the connection drops.

Every sale is a normal WooCommerce order (`created_via = shoptill`). Stock, taxes, coupons, reports, emails and refunds all go through WooCommerce, so nothing needs reconciling afterwards.

## Install

ShopTill's original plugin, till app, development tools and documentation are
licensed under **GPL-2.0-or-later**, unless a file states otherwise. Third-party
components retain their own licenses and notices. See [LICENSE](LICENSE),
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Software is
provided without warranty.

Runtime dependency notices are included in
[THIRD-PARTY-NOTICES.md](plugin/shoptill/THIRD-PARTY-NOTICES.md) and ship with
the plugin.

1. Build the app: `cd app && npm ci && npm run build`. This writes to `plugin/shoptill/app`.
2. Zip `plugin/shoptill` and upload it under Plugins, or copy it to `wp-content/plugins/`. On Windows, `powershell -NoProfile -ExecutionPolicy Bypass -File dev\zip.ps1` builds `shoptill.zip` with the forward-slash entry names WordPress's uploader needs. Then activate it. WooCommerce 8.0+ and WordPress 6.2+ are required. Both order storage modes work (HPOS and legacy posts).
3. Go to WooCommerce > Settings > ShopTill and set up registers, payment methods, the receipt, and the order status for POS sales.
4. Give staff the POS Cashier role. Administrators and shop managers can use the till already. Only they can refund, unless Cashier refunds is switched on in the settings.
5. Open `/pos/` on the device and sign in with the WordPress username and password.

If the shop uses plain permalinks there is no `/pos/` address; the till lives on the home page with a query string, which WooCommerce > Settings > ShopTill shows. With pretty permalinks it is served at `/pos/` — if that shows a 404, re-save Settings > Permalinks once. `/pos` redirects to `/pos/`, and the page refuses to be framed by another site and asks search engines not to index it.

### Requirements on the server

Signing in creates a WordPress application password for that device, and the till sends it as HTTP Basic auth. For that to work:

- The site needs HTTPS. WordPress switches application passwords off without it, except when `WP_ENVIRONMENT_TYPE` is `local`.
- Security plugins that disable application passwords will block sign-in. The till says so when it happens.
- Some Apache/CGI hosts strip the `Authorization` header. The stock WordPress `.htaccess` already passes it through. If yours doesn't, add this above the WordPress block:

  ```apache
  RewriteEngine On
  RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
  ```

Each device shows up under the user's profile as "ShopTill POS (device name)". Revoke it there to sign a lost tablet out. Changing a user's password signs out their tills too, though editing the rest of the profile doesn't. Deactivating the plugin revokes every till's password, so tills sign in again after it's switched back on. The passwords stay confined to the till's API while WooCommerce is switched off. WordPress Multisite is not supported: device sign-in is refused rather than issuing a network-wide credential that a site-local plugin cannot safely confine. Before converting an existing shop to Multisite, revoke its ShopTill application passwords from the users' profiles.

A till's password only works for the ShopTill API, not the rest of the WordPress REST API. Sign-in locks for 15 minutes after 10 failed attempts on one username from one IP address, or 50 on any usernames from that address. Failures keep counting until 15 minutes pass without one, signing in with an account that has no POS access counts as one, and a good sign-in clears the username's count but not the address's. Behind a proxy that doesn't pass the client's address through, every till shares one address, so a day of scattered typos can reach 50 and lock everyone out for the 15 minutes. Cashiers see POS orders only, and customer search leaves out staff accounts.

## What the till does

- Product grid with categories, search by name, SKU or GTIN, variation picker, stock badges. Featured products show under a Pinned chip, which is the first screen when the shop has any, and a Recent chip holds what this device last sold, freshest first. A search still looks through everything. From the keys, Down walks onto the grid, the arrows move between tiles and Enter rings one up. Selling out-of-stock items can be switched off, and products that take backorders keep selling either way. With it switched off, a line can't go above the stock left. A sold-individually product goes on a sale once, and the API holds any other client to the same rule. Custom items remember their last few selves and come again as one-tap chips.
- Barcode scanning with any keyboard-wedge scanner, or with the camera where the browser has `BarcodeDetector` (Chrome on Android, for example). A scan is picked up wherever focus is, and whatever field it typed into is put back as it was. The coupon field and customer search are the exceptions: a code scanned into them stays there. Scanners set to end the code with Tab work as well as Enter. UPC-E codes are matched through the UPC-A they expand to, and an EAN-13 starting 28 or 29 is read as a scale label: the item code it carries finds the product (by SKU), the weight it carries becomes the quantity and its price per kilo, or the price it carries is what is charged.
- Line edits for quantity, price override, and discount (amount or %), with a live line total while the numbers are typed and steppers that repeat under a held press. Price overrides and discounts, on a line or the whole sale, are for staff who can edit products unless Cashiers may change prices is switched on in the settings; a cashier's till hides the fields and the shop refuses a deliberate change from an account that may not make one, while a sale that synced after such a change, with the money already taken, is kept as charged and noted. A stale price on the till is not an override: the customer paid what the shelf said, so it goes through. A discount for the whole sale, custom items with their own tax class, WooCommerce coupons, and an order note. Amounts take a comma or a point for the decimals, and a mistyped one such as "3.5.0" is refused rather than read as something else; in a currency without decimals, a typed fraction such as "12.50" is refused rather than rounded. Coupons follow WooCommerce's rules: an individual-use coupon goes on its own, and a coupon for certain email addresses or limited per customer needs that customer on the sale. Clearing the sale and removing a line are one tap with a moment of Undo, not a confirm in the way.
- Customers: search by name (first, last or both), email or phone, or create a new one. WooCommerce's new-account email isn't sent for customers made at the till. Offline, only customers already used on that device can be picked. Details on a customer shows their order count, what they've spent and their last five orders, and edits their name, phone and billing address. Moving a customer to another email needs staff who can edit users, and an account with any role but customer or subscriber is never shown or edited from the till.
- Split payments across cash, card, bank transfer, cheque and one custom method, with quick-cash buttons and change due. Enter takes the amount on the keypad, unless focus was moved to another button with Tab, in which case Enter presses that button. The method names are translatable.
- Pay later for regulars, when the shop switches it on (see below).
- Park a sale and pick it up again later. Parked sales show their totals and stay on the device when someone else signs in.
- Receipts sized for 80mm or 58mm thermal paper, or A4. Print them through the browser's print dialog, or email them with WooCommerce's order email, walk-in sales included. With a USB thermal printer connected (Settings → Receipt printer; Chrome or Edge), receipts print straight to it with one tap and no dialog, and the cash drawer kicks on cash sales. Times on receipts and in order history and reports are the shop's, not the device's. A receipt emailed while the sale is still queued goes out once it syncs. Reprint from order history, marked as a copy. A gift receipt, after the sale or from order history, leaves out the prices, payments and customer, and one printed from order history leaves out what's been refunded. The shop sends five emails per order and 60 per user in each clock hour, counting sends that failed and notes sent to the customer, and the till says so when WordPress couldn't send the mail. The shop's address is laid out the way its country writes addresses. WooCommerce's own customer emails for a till sale (processing, completed, on hold, refunded, partially refunded, failed, cancelled and invoice) are off unless Customer emails is switched on in the ShopTill settings, since the customer was standing there. The admin New order email for a till sale has its own setting, Admin new-order emails, and is off by default too.
- Order history for the shop, filtered by status and, for staff who can edit orders, to till sales, web orders or both, with times said the way a counter reads them (just now, minutes ago, the time today). Refund by item with restock — one tap picks the whole order, and the steppers repeat under a held press — or by amount, with a plain note when a payout is capped by an earlier amount refund. Items can still be taken back after an amount refund, up to what's left to refund. A payment or refund retried after a dropped response is applied once. The till works out a refund by items the way WooCommerce will, so the last unit of a line gives back whatever the earlier ones left of it. A web order refunded at the till pays its cash out of that register's drawer, and the report shows it as a web refund, apart from the till's own sales and their tax.
- Web orders show where they're going: the shipping address and method, and the customer's billing address, phone and email. Staff who can edit orders see how many web orders are waiting to be packed next to Orders, checked every minute, and a message when a new one comes in. Tapping the count lists them. They can also move one between processing, on hold and completed from the till (`POST /orders/{id}/status`). A till sale's status says whether it's paid, so it can't be changed there unless it's waiting to be collected or delivered (see below), and nor can a web order on hold that hasn't been paid (a bank transfer still to arrive, for example). A customer who brings the money in can pay it at the till instead: a web order placed with bank transfer, cheque or cash on delivery shows what's owed until it's paid, takes part payments, and moves on to processing once it's paid in full, as it would when its payment arrived. The payment counts in that register's drawer on the day it was taken.
- End-of-day report per register or for all registers: transactions, items, takings by payment method, refunds, tax, discounts, delivery charges, expected cash, what is still owed and earlier sales paid off that day — and, for staff, the day's cost of goods and profit. Sales by product and by cashier, and a CSV download of the lot that opens in Excel with accented names intact. A till sale counts in every status except pending, failed, cancelled and draft, including statuses added by other plugins. A refund counts on the day it was given, whatever became of its sale afterwards, and a refund taken in wp-admin counts on the register its sale was rung up on, since that is where the goods and the day's numbers came from.
- Drawer count at close. Enter the opening float and the cash counted on a register's report, and the shop works out what should be there from the day's cash sales and refunds and the cash paid in or out. The report shows each count with who made it and whether the drawer balanced, was over or was short. A recount is added below the first one; it doesn't replace it, and it starts from the same float. Two tills closing at the same moment both keep their count, and a count sent again after its answer was lost is saved once.
- Cash paid into or out of the drawer outside a sale, such as change from the bank or the window cleaner, is recorded on the register's report with what it was for (`POST /reports/cash`). It shows on the report, in the CSV and in what the drawer should hold. It goes on today's report only: one sent for a day that has ended is refused, unless it's a retry of one that day already has. Cash moved after the drawer was counted is marked on the report as such, since the count didn't see it: count again to include it.
- Staff who can edit products in WooCommerce can change a product's price, sale price and stock from the line editor while online, and its cost when a cost-of-goods plugin is active (see below). Lines already on the sale at the old shelf price follow the new one. Stock can't be counted while that till still has sales of the product to sync, because they would come off twice. A count is refused if the stock moved while it was being taken, and the editor shows the new figure to count against. Fields left alone aren't sent, so a sync landing under the open editor doesn't get undone.
- A product can be kept off the till with Hide from the till on its WooCommerce product screen. It still sells online, and a sale of it already queued on a till still syncs.
- Order notes. A note on the sale prints on the receipt, unless it's marked Staff only. Orders adds notes to any order the user can see, and Send to the customer emails one through WooCommerce, when the shop sends customer emails. A note added at the till says who wrote it.
- Light and dark themes, tablet and phone layouts. The dark theme is the counter look, a deep space base with a cyan accent and a green money button; the light theme is the day look. Product tiles are square photo cards with the name and price on a gradient, the cart and dialogs are translucent, and every control answers a touch with movement unless the device asks for reduced motion. On a phone the cart is a sheet over the products, with the sale's total and a Charge button on its tab, pulled up to edit the sale. The sign-in screen remembers the last username on the device, and a line added to the sale slides in with a glow so the tap visibly landed. Per device, the accent colour (five presets) and the tile density (comfortable or compact) are the shop's own, a sale completes with a chime that can be switched off, and a tile shows how many of its product are already on the sale. Sale lines carry the product's photo, the grand total pops when it moves, `/` on a keyboard goes to the search, larger text is one setting away, and the dark theme has a true-black variant for OLED screens. The sale panel itself drags wider or narrower at the handle between it and the products, and the grid gives it room a column at a time. The accent colour can be the shop's own hex rather than a preset, and panels can be solid instead of glass where blur costs more than it gives.
- Kiosk mode (Settings, per device): full screen, a screen that never sleeps, no right-click or dragging, the cursor hidden while idle, optional sign-out after five minutes untouched, and install icons that make the till a real app on Windows and Android. For a device that boots into the till and nothing else, docs/kiosk-setup.md covers Windows assigned access and Android screen pinning.

### Cost of goods and profit

With a cost-of-goods plugin active — "Cost of Goods for WooCommerce" by WPFactory (any generation), or "WooCommerce Cost of Goods" by SkyVerge — ShopTill reads and writes costs where that plugin keeps them, so the till and the plugin's own profit reports agree:

- A till sale freezes each item's unit cost onto the order in the plugin's own meta (`_alg_wc_cog_item_cost`, or `_wc_cog_item_cost`). The plugin doesn't stamp items of orders that appear straight at their final status, which is exactly what a till sale is, so ShopTill does it after saving. Its per-product profit reports therefore count till sales. A staff till freezes the cost it had when the sale was made, so a sale that syncs days later is costed as the stock it actually sold, not as whatever the product costs by then.
- Staff who may edit products see each product's cost in the product editor and can change it there; a blank cost clears it. A variation without its own cost falls back to its parent's, as both plugins do. Costs go out with the catalogue for staff alone — a cashier's catalogue has none, and the price override and stock count are unchanged.
- The end-of-day report adds the day's **cost of goods**, **profit** (net less cost, with the margin as a percentage) and **what was sold without a cost**, and the per-product table adds a cost column — all for staff who may edit products. The cost column is net of returns, like the day's totals, so the table adds up to them; its sold count and sales stay gross like the day's gross, with returned units shown beside the count. A product with no cost set is shown as a dash rather than as free to sell. Refunded units go back on the shelf, so their cost comes off the day too.
- Where the plugin keeps its own list of who may see costs, ShopTill follows it. Freezing a cost onto a sale is the same privilege as seeing one, so a till signed in as an account that list keeps out has its claimed costs ignored.

### Collect or deliver later

Collect or deliver on the cart marks a sale the customer isn't taking away. It's paid as usual, then waits in processing until the cashier marks it completed from Orders, and it can go back to processing if that was a mistake. Orders lists these under Collect or deliver, and the count next to Orders includes them, for cashiers too. Choosing a customer fills a delivery in from their details. A delivery needs a street, a town and a country the shop ships to, and the receipt shows where it goes. It's taxed where the shop is, whatever WooCommerce's tax is based on, because that's what the till charged. A delivery can carry a charge, which becomes a shipping line on the order named Delivery, taxed at the standard rate like the rest of the sale, whatever the shop's shipping tax class, and shown on its own row on the receipt, the report and the CSV. A sale on account to collect stays on hold until it's paid, then waits to be collected. A delivery queued offline without an address is kept as one to collect, with a note saying why, and a charge that can no longer be delivered is dropped with a note of its own.

### Pay later

Switch it on under WooCommerce > Settings > ShopTill. A sale with a customer can then be finished with Pay later. It's saved on hold with the amount owed, and the receipt shows what's still to pay. Take the payment later from Orders on any till. Part payments are fine, and once it's paid in full the order takes the shop's status for POS sales, or waits to be collected or delivered. Two tills can't both take the same debt.

The report counts a later payment in the drawer and on the day it was taken, not with the original sale. A return on an order that's still owed comes off the debt first, and only the rest is paid back to the customer. A refund made in WooCommerce on an order still owed comes off the debt too. An order that returns leave owing nothing is marked paid, even when the first try at the return died part way, but a paid sale that a manager put on hold stays on hold.

### Offline

The catalogue, customers and parked sales live in IndexedDB, and a service worker caches the app. Once a device has signed in, `/pos/` opens and sells with no connection at all.

A finished sale goes into a queue first, whether the till is online or not. The queue retries on reconnect and every 15 seconds. Each sale carries a client id, so a retry after a dropped response can't create a duplicate order. Only ShopTill's own refusals stop a sale retrying. A server error, a proxy error page or a security plugin blocking the request leaves it queued with the reason on the receipt, and the till keeps trying. With the till open in more than one tab, only one sends the queue at a time, and the others see the stock it took and the order numbers straight away. Remove shop data from this device, in Settings, won't run while a sale is still waiting to sync, even one queued in another tab.

Stock shown on the device counts sales still in the queue, so an offline till won't sell the last one twice, and it's refreshed from the shop every minute. Product changes are picked up every five minutes, or straight away with Settings > Re-sync. Each line carries the price it was rung up at, so a price change in WooCommerce before the sale syncs doesn't change what the customer paid.

The shop is strict with a sale made online and lenient with one that arrives late. A sale that reaches the shop more than two minutes after it was made has already left with the customer, so problems go in a note on the order instead of refusing it: a register or payment method that has since been removed, a product that was deleted (kept as a custom item at the price paid), a custom item whose tax class was removed (taxed at the standard rate), stock that ran out, or a coupon that no longer applies. If its payments don't cover the total, it goes on hold with the balance owed. The till corrects its clock to the shop's each time it syncs, so a tablet with its clock wrong doesn't change which rules apply. A sale dated in the future is dated when it arrived. One made more than 30 days before it synced is dated the day it arrived, with a note giving the day it was made, so it can't land in a period that's already been closed.

With selling out of stock switched off, the shop saves sales one at a time, so two tills can't both sell the last one. Stock held for an online customer who is still paying counts as gone. Sales with a coupon are saved one at a time too.

Editing coupons on an existing POS order keeps its manual line discounts after the coupons, including when the last coupon is removed. Recalculating again does not apply the manual discount twice. New sales record the discount without tax as well as the entered amount; older sales use their recorded line tax to recover that amount, rather than today's price settings. Ordinary line-total edits are left alone until coupons are explicitly rebuilt. Other extensions' custom order classes are not replaced, so those classes need their own integration to preserve POS discounts during coupon recalculation.

Offline, the till calculates totals itself using the same tax maths as WooCommerce (tested to the cent against real orders). Coupons are checked with the shop, so new coupons can't be added offline. A coupon already on the sale is re-checked when the sale syncs. If WooCommerce then rejects a sale, for example because the coupon's usage limit has run out, the sale stays in Orders > Not yet synced with the reason, and it can be retried or discarded there. If the shop's total differs from the one the till showed, the order is kept and a note is added to it. That includes a coupon that came to something else by the time the sale synced, online too: the customer paid what the till showed, so the order is kept as charged, on hold with the balance owed if the coupon now takes off less. Once checkout is open the coupon isn't priced again, even if the connection comes back or an answer turns up late, so the total can't change under payments already taken.

The status bar shows how many sales are waiting to sync. Once the oldest has waited 30 minutes it says how long, because until it syncs it isn't in the shop's stock or reports.

The catalogue downloads in pages ordered by product id, so a product deleted or added while it downloads doesn't make it skip another one.

A sale open in one tab of the till shows in the others. While a tab is taking payment, changes from other tabs wait until it's done. If another tab changed or finished the sale in the meantime, this one won't save it, so the same sale can't be charged twice. A sale left open is still there after signing out and back in. Signing in while the last user's product sync is still running stops that sync before it writes anything, and a request the last user sent can't sign the new one out. A sale that died after its first save leaves nothing behind for the retry to trip over.

If the device's storage can't be opened (because the browser has site storage switched off, for example), the till says so with a Try again button instead of a blank page.

When the shop has a newer version of the till, an Update button appears in the status bar. It's greyed out while a sale is in progress.

## Uninstall

Deleting the plugin removes its settings, the POS Cashier role, its capabilities — including any granted to one user at a time — and every till's application password. Orders taken at the till stay in WooCommerce.

## Development

The Docker stack is for disposable local testing only. Its credentials are
public fixtures, HTTP authentication is enabled for development, and its web
port is bound to `127.0.0.1`. Never expose it to a network, reuse its passwords
in production, or import real customer data.

```sh
docker compose up -d                # WordPress + WooCommerce on http://localhost:8088
docker compose run --rm cli eval-file /dev-scripts/seed.php exclusive   # or: inclusive [yes]
cd app && npm run dev               # Vite on :5173, proxies /wp-json to :8088
```

On first run, install WordPress and WooCommerce in the container (admin/admin) and activate the plugin. `seed.php` sets up products, tax rates, coupons, a cashier (`cashier` / `cashier-pass`) and a customer. From Git Bash, prefix docker commands with `MSYS_NO_PATHCONV=1`.

Tests:

```sh
npm test                            # unit tests (totals, cart, money, stock, CSV)
npm run build && npm run e2e        # Playwright against the built app at localhost:8088/pos
SHOPTILL_URL=http://localhost:8088 SHOPTILL_TOKEN=$(cat ../dev/.token) SHOPTILL_ADMIN_TOKEN=$(cat ../dev/.admintoken) \
  npx vitest run tests/parity tests/server
```

The test files run one after another because they share the dev shop and read its day totals.

CI also builds a fresh Docker WordPress shop with WooCommerce 11.2.2 and WPFactory Cost of Goods 4.2.3, runs the server and totals-parity suites with pay later enabled, checks tax-inclusive subtotal rounding and coupon minimums, then reseeds it for the Chromium browser suite. Finally it converts only that disposable shop to Multisite to check that device credentials are refused. Its device credentials belong only to the test shop. Unit tests and dependency auditing remain separate checks.

The tokens are what `POST /wp-json/shoptill/v1/auth/login` returns for `cashier` and `admin`, saved to `dev/.token` and `dev/.admintoken`. The e2e suite reads the admin one.

The e2e suite reseeds the dev shop and switches pay later on. It covers:

- a mixed sale with a scanned barcode, variation, custom item, coupon and card/cash split;
- an admin refund with restock, plus the All-items refund, the repeating refund steppers and the order list saying just now;
- a sale made offline after reloading the app with the network off, then synced;
- the checkout keypad against a barcode scan, and a double tap that must save one order;
- a receipt emailed for an offline sale, sent once it syncs;
- a pay-later sale settled from Orders;
- the daily report, its product and cashier tables and the CSV;
- parked sales kept when a different user signs in;
- tapping the Quantity caption in the line editor, which must not change the quantity;
- pinned products as the first screen, with search still finding the rest;
- a second tab of the till picking up the stock a sale took without waiting for the next poll;
- staff changing a price and stock from the till, and the line on the sale following it;
- the editor sending only what the cashier changed, after another till sold some while it was open;
- a refund whose response was lost applied once on retry, and a changed amount not taken for the retry;
- the keyboard reaching every button in a dialog, Enter pressing a button tabbed to, and Enter on the keypad after a tapped one;
- a coupon scanned into its field kept, a scan with the line editor open staying out of the quantity, and a drag out of a dialog leaving it open;
- a sale started in one tab showing in another;
- a sale charged in one tab not charged again in another, a coupon sale going through with another tab open, a change made in another tab during payment reaching this one without being sent back, and a sale left open kept across signing out;
- a till whose storage won't open showing why;
- a web order's address shown in Orders and marked completed, from the count of orders to pack, which goes down after;
- an order note keeping its text through a barcode scan;
- a drawer count checked against the register's cash, with the float kept for a recount;
- cash paid out of the drawer coming off what the count expects;
- a mistyped price refused, and a sale emptied of its lines still cleared of its discount and note;
- a coupon priced offline, or answered late, keeping the total once checkout is open;
- signing in while the last user's sync is still running;
- a stock count started before another till sold some sent back to be counted again;
- a reprint from order history marked as a copy, a double tap on Reprint opening one print dialog with the receipt in it, and a gift receipt without the money;
- a customer edited from the till, with the email locked for a cashier, and their address filling in a delivery that shows in Orders;
- a sale to collect with a staff note kept off the receipt, found from the count next to Orders, given a note by the cashier and marked completed, and the count going down after;
- a delivery charge on a sale to deliver, with the shipping line on the order and Delivery on the receipt;
- a phone carrying the sale in the cart sheet and charging from its collapsed tab;
- the device's accent colour and tile density, kept over a reload, and the grid counting what is already on the sale;
- a sale line carrying the product's photo, `/` reaching the search, and larger text and true black kept over a reload;
- the sale panel dragged wider with the product grid giving back its columns, kept over a reload and reset by a double-click;
- the keys reaching the grid from the search, the Recent chip holding this device's selling order over a reload, a custom item offered again as a chip, the line editor's live total and repeating steppers, and Undo putting back a cleared sale and a removed line;
- a custom colour and solid panels kept over a reload, with a preset taking over again;
- staff setting a cost from the product editor, the sale carrying it into the cost plugin's own meta, the report's cost and profit for staff, and none of it for a cashier.

The parity test creates random carts as real orders and checks that the till's totals match WooCommerce's, including carts carrying a delivery charge with its tax. The server tests check the API's rules directly: online refusals, what a late sale is allowed, idempotency under parallel requests, token scope, refund permissions, pay later with returns against what's owed, order search by phone number, customer search by name, retried payments and refunds applied once (including a refund that died before or after it was saved, one that died after saving still reported under its register, a payment that paid off the order and died after saving, and a refused one retried under the same id), refunds after an amount refund with their lines and tax scaled to what's left, refunded tax in the report, the cashier refunds setting and a per-user deny that it doesn't override, product edits from the till (bad prices, untracked stock and a moved stock count refused with nothing saved), a sale synced more than 30 days late, two tills racing for the last one with overselling off, stock held for an online checkout, two of a product sold individually refused and a late one kept with a note, a delivery charge taxed like the rest of the sale and dropped when its delivery can't be taken, cash moved after a drawer count flagged on the report, and the cost plugin's figures: costs stamped onto a till sale's items in the plugin's own meta, cost and profit in the staff report and absent from a cashier's, refunded units off the day's cost and off the product's row, products sold without a cost kept apart, a cost an excluded account claims ignored, and a late sale costed at the cost the till froze when it was made. A price change from an account that may not make one is refused online, kept late with a note, staff and the setting pass, and a discount counts as a price change. Also: a till sale in a status another plugin added, a refund on a sale later cancelled, a date that doesn't exist, drawer counts and recounts (negative and overflowing amounts refused, and a count kept when another till closed at the same moment), a refund at an unknown register and an amount sent as an array refused, a web order refunded at the till counted in the drawer, web order status changes and who may make them (an unpaid order on hold stays there), a customer added by two tills at once made once and not emailed, no customer email when a sale on account fails, a sale whose coupon drifted before it synced kept as charged, an offline custom item whose tax class was removed, no half-made order left by a sale that died after its first save, a drawer count sent twice saved once, a web order paid at the till (with refunds made in WooCommerce or at the till off what it owes), a paid sale put on hold left there by a return, the day broken down by product and cashier with delivery charges apart from it, and the till served under plain permalinks. a return that cleared a debt and died before settling it, a product hidden from the till left out of the catalogue, catalogue paging past a deleted product, the shop address as its country writes it with HTML entities decoded, and the `/pos/` redirect and headers. And: the web orders waiting to be packed, cash paid in and out counted once each in what the drawer should hold, cash sent for a day that has ended taken only as a retry, tills signed out by a password change and not by a profile edit, receipt emails capped per order and saying when they fail, coupon codes and tax classes that aren't text refused, individual-use, email-restricted and per-customer coupons, no payment taken on a sale that died half way through saving, and a product published on schedule sent in the next catalogue update. Then: a customer's profile, orders and edits (their display name kept in step), an email change only for staff who can edit users and never onto one in use, staff accounts never shown or edited, sales to collect waiting in processing and moved back and forth by the cashier, a delivery taxed where the shop is, a delivery queued offline without an address kept as one to collect, a sale on account to collect on hold until paid, staff notes with their writer and added once when sent twice, and notes to the customer emailed only when the till sends customer emails and counted against the email limit. There's also a report whose product and cashier breakdowns add up to its totals. Run both once for each seed mode.

## Not done yet

- Card terminals (Stripe Terminal, Square). Card payments are recorded as a method but not taken through a reader.
- Direct thermal printing on browsers without WebUSB (including Safari and Firefox). Chrome and Edge support ESC/POS USB printing and cash drawer kick; other browsers use the print dialog.
- Offline sign-in for a user who hasn't signed in on that device before.
- POS orders using another extension's custom order class need that extension to preserve ShopTill's manual line discounts when it rebuilds coupons. ShopTill leaves custom order and refund classes untouched.
- Translations beyond the text domain being in place.
- Sales are attributed to the signed-in user. Two cashiers sharing one sign-in show up as one in the report.
- The end-of-day report reads the day's orders, refunds and later payments a hundred at a time, so its memory stays flat, but it still reads every one. It takes about 6 seconds on the dev shop with 7,300 orders in a day, and gets slower as the day's orders grow.
- A cash on delivery order the till marks completed is taken as paid, as WooCommerce takes it, without the money going through the till.
- A stock count opened while that till still had sales of the product to sync starts from the figure it opened with. Once they sync, the first save is sent back with the new figure to count against.
- A sale is complete when it's paid to within a cent per line, plus one, which covers WooCommerce's rounding. A sale short by less than that completes as paid.
- A sale the shop refuses is created and then deleted, so webhooks and plugins that act on new orders see it briefly.
- On iOS before 13 the browser doesn't fire `afterprint`, so the receipt stays on screen until the next print or a reload.
- Multisite support. New device sign-ins are blocked on Multisite, and existing till tokens are refused where ShopTill is active. Old application passwords must still be revoked before converting a single-site shop: sites without ShopTill cannot enforce its token restrictions.
- A sale the shop refused, then retried by hand from Not yet synced more than two minutes after it was made, gets the lenient late-sale rules. The money was taken, so the order is kept with a note rather than refused again.
- A sale made offline that syncs after the shop switched between prices with and without tax is priced by the till's old setting and flagged only by the total check.
- A shop configured with a fixed UTC offset instead of a named timezone does not follow daylight-saving changes automatically. Older cached till settings use the fixed offset until refreshed.
- A sale that syncs late from a cashier's till, or of a product that had no cost at the time, is costed at the product's cost when it reaches the shop, which is the best that till can do. A staff till freezes the cost it had, so only its products without one fall back this way.
- The report's cost covers what the plugin stores per item. Handling fees the cost plugin holds per product, and the plugin's own extra-cost options, are not in it, so its profit figures may differ from the report's on those.
- A delivery charge on a sale refunded by items doesn't come back with them; refund it by amount instead.
- Scale labels are matched by their item code as a SKU, and read as grams and cents whatever the shop's currency.
