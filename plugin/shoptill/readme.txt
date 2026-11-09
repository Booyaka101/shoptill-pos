=== ShopTill POS for WooCommerce ===
Contributors: booyaka101
Tags: point of sale, pos, woocommerce, retail, till, offline
Requires at least: 6.2
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.10.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A point of sale for WooCommerce that sells straight from your shop's own catalogue, keeps stock in sync, and keeps selling when the internet does not.

== Description ==

ShopTill is a till for shops that already run on WooCommerce. Every sale is a normal WooCommerce order, so stock, taxes, coupons, reports, emails and refunds all go through the systems you already have. Nothing needs reconciling afterwards.

**The till itself**

* Product grid with categories, search by name, SKU or barcode, variation picker, stock badges, pinned items, a Recent chip of what this device last sold, and a count on each tile of what's already on the sale — all reachable from the keyboard too
* Barcode scanning with any keyboard-wedge scanner or the phone camera
* Split payments across cash, card, bank transfer and more
* Offline: the catalogue lives on the device and sales queue until the connection returns, applied exactly once
* Receipts on 80mm or 58mm thermal paper (direct to a USB printer, or through the browser's print dialog) or A4, and by email
* Refunds by item or amount — the whole order in one tap — with web orders paid off at the till and sales on account
* Collect or deliver later, with delivery charges taxed like the sale
* Tips on the charge screen as preset percentages
* End-of-day report per register: takings by method, tax, discounts, refunds, expected cash, cost of goods and profit (with a cost-of-goods plugin active)
* Drawer count at close, cash paid in and out
* Cashiers see the takings; managers see the margins
* A kiosk mode for a device that boots into the till and nothing else
* The till's look is the shop's own: light and dark, five accent presets or the shop's own colour, compact or comfortable tiles, solid panels for older screens, and a sale chime, per device
* Larger text for staff who read the till at arm's length, and a true-black dark theme for OLED screens
* Sale lines carry the product's photo, `/` on a keyboard goes to the search, and the sale panel drags wider with the products adjusting around it
* Works from anywhere on earth your shop is reachable: the owner in Hong Kong, the shop in Cape Town

**Under the hood**

* Every sale is a WooCommerce order (`created_via = shoptill`), on both order storage modes (HPOS and legacy)
* Prices, stock and costs editable from the till by staff who may edit products
* Costs read from and written to "Cost of Goods for WooCommerce" (WPFactory) or "WooCommerce Cost of Goods" (SkyVerge), frozen at sale time for late-syncing sales
* The API is scoped: a till's token works for the ShopTill API only, not the rest of WordPress
* Translatable: 155 strings in the pot file, ready for your language

== Installation ==

1. Upload the `shoptill` folder to `/wp-content/plugins/` and activate. WooCommerce 8.0+ and WordPress 6.2+ are required.
2. Go to WooCommerce > Settings > ShopTill and set up registers, payment methods, the receipt, and the order status for POS sales.
3. Give counter staff the POS Cashier role. Administrators and shop managers can use the till already.
4. Open `/pos/` on the device and sign in with the WordPress username and password.

The site needs HTTPS for sign-in (application passwords are switched off without it), and pretty permalinks for the `/pos/` address.

== Frequently Asked Questions ==

= Does it process card payments? =

No, and on purpose. Card payments run on your existing standalone terminal, exactly as they do today. ShopTill records that the sale was paid by card and for how much, and the money path is unchanged. No PCI scope, no gateway fees, no lock-in.

= What happens when the internet goes down? =

The till keeps selling. The catalogue lives on the device in IndexedDB, sales queue locally, and each sale is applied exactly once when the connection returns. A retried sync can never double-charge.

= Does it work with my WooCommerce products? =

Yes, directly: simple products, variable products with variations, stock management, tax classes, coupons, GTIN barcodes, scale labels (EAN-13 starting 28 or 29). Products hidden from the till stay sellable online.

= Can I use it on more than one device? =

Yes. Each device signs in with the same shop account and gets its own API token. Two tills can close the same register at the same moment and both counts are kept.

= How do I print receipts? =

Connect a USB thermal printer under Settings in the till (Chrome or Edge), and receipts print with one tap, no dialog. Without one, the browser's print dialog works. The cash drawer kicks on cash sales when a printer is connected.

= How much does it cost? =

Nothing. This is the free core. A pro add-on with cost-of-goods analytics, timeclock and priority support is planned.

== Changelog ==

= 0.10.1 =

* Fix category lists from the API and device cache that could crash the till.
* Fix delayed logout, stale stock replies, and remembered usernames interfering with a new login.
* Keep tips in payment suggestions and show them on original, reprinted, and thermal receipts.
* Stop held quantity-button timers when their dialog closes.
* Reject malformed and overflowing monetary inputs, and update a vulnerable build dependency.

= 0.10.0 =

* Refunds: an All items button for the whole-order return, steppers that keep counting under a held press, and a plain note when a payout is capped by an earlier amount refund.
* Order times read the way a counter does: just now, minutes ago, the time today.
* The quantity steppers (line editor and refunds) share one part now, and the held press truly repeats — each step builds on the last.

= 0.9.0 =

* The keys reach the grid: down from the search walks the tiles, arrows move between them, Enter rings one up.
* A Recent chip holds what this device actually sells, freshest first — no searching for the third coffee of the morning.
* Custom items come again as one-tap chips; the line editor previews its total while you type, and its steppers repeat under a held press.
* Clearing the sale or removing a line is one tap with a moment of Undo, instead of a confirm in the way.
* The accent colour can be the shop's own hex, not just a preset, and panels can be solid instead of glass for older screens.

= 0.8.0 =

* Cart lines carry the product's photo, so a long sale reads at a glance.
* Larger text for staff who read the till at arm's length, and a true-black dark theme for OLED screens.
* A short buzz on the phone when an item lands on the sale, and `/` on a keyboard goes to the search.

= 0.7.0 =

* The till's look, its way: five accent colours, compact or comfortable product tiles, and a sale chime — all per device, in Settings.
* Product tiles show how many are already on the sale, so a glance at the grid says what's rung up.

= 0.6.0 =

* Tips on the charge screen, as preset percentages or a typed amount.
* Thermal printing and the cash drawer straight over USB (ESC/POS over WebUSB).
* A kiosk mode for a device that boots into the till and nothing else.
* Translatable: 155 strings in the pot file.

= 0.5.0 =

* Cost of goods and profit in the staff report, read from the shop's cost plugin and frozen at sale time.
* Price changes and discounts restricted to staff who may edit products.
* A refund taken in wp-admin counts on its sale's register.

= 0.4.0 =

* First public release: catalogue, selling, payments, receipts, refunds, offline queue, reports with drawer counts, kiosk mode.

== Upgrade Notice ==

= 0.10.1 =
Fixes category crashes, login races, tip payments and receipts, and input validation. Existing offline sales stay on the device.

= 0.10.0 =
Refunds get an All-items button, repeating steppers, and honest notes about capped payouts; order times read like a counter reads them.
