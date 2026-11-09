# Changelog

## Unreleased

- Preserve POS manual line discounts when WooCommerce adds, removes or recalculates coupons, applying them after coupon discounts and before taxes are saved. Repeated recalculation does not compound discounts; ordinary line edits and non-POS order behavior are unchanged. Store net discount amounts on new sales and use recorded tax terms for older orders.
- Apply stock counts as atomic adjustments through WooCommerce, preserving sales that land during a count save, including stock shared by variations. Reject malformed stock baselines before saving any accompanying changes.
- Refuse new POS device credentials on unsupported WordPress Multisite installations and reject existing till tokens where ShopTill is active. Existing tokens still need revoking before a site is converted to Multisite.
- Add server coverage for short and long daylight-saving report days and an isolated WooCommerce/browser integration job in CI.
- Keep small tips and other fees out of the product-sales rounding adjustment in daily reports.
- Use the shop's named timezone for receipts, order times and the report date, including daylight-saving changes while a device stays signed in. Keep fixed-offset shops and older cached settings working.
- Keep connection, sign-in and rate-limit failure reasons and attempt counts on queued sales without discarding them or stopping future retries.
- Show tips separately in the daily report and CSV, matching the totals already returned by the server.
- Update Vite and Vitest dependencies to clear the current dependency audit findings. Add queue and timezone regression tests.
- Correct the known-limitations list to reflect existing USB thermal printing support.

## 0.10.1 (2026-10-14)

- Normalize category lists from the API and cached bootstrap data to prevent the sell-screen crash.
- Prevent delayed logout and stale stock responses from affecting a newer login. Leave a username being entered alone when the remembered username arrives late.
- Include tips in payment suggestions after selecting a tip or removing a split payment. Show fee breakdowns on original, reprinted, and thermal receipts, but not gift receipts.
- Stop held quantity-button timers when their dialog closes.
- Reject malformed and overflowing prices, quantities, discounts, tips, payments, costs, and stock counts instead of treating them as zero or accepting infinity.
- Update source-map-js to 1.2.2 and add CI for unit tests, production builds, dependency auditing, and PHP syntax on 7.4 and 8.3.

## 0.10.0 (2026-10-12)

The refund round: the flow a shop leans on when something comes back.

- All items, one tap: the refund dialog offers the whole-order return as a single button — the common case, previously a row of plusses. The footer keeps saying what will be paid out as the picking changes.
- The refund's −/+ steppers repeat under a held press, like the line editor's — and both now share one part. This also fixes a quiet fault in 0.9.0's line-editor repeat: the held press captured its starting value, so it advanced once and stuck; the shared stepper builds each step on the last.
- When picked items are worth more than is left to pay out (an amount refund already took some of it), the dialog says so plainly instead of silently paying the smaller figure.
- Order times read the way a counter does: "just now", "4 min ago", the clock time for earlier today, then the full date — in the shop's clock, as the till's times always are.

## 0.9.0 (2026-10-11)

The counter-flow release: less reaching, less retyping, less second-guessing.

- The keys reach the grid. Down from the search walks onto the first tile; the arrows move between them a column at a time; Enter on a tile rings it up; Esc climbs back to the search. A fast burst ending in Enter is still a scanner's code, exactly as before — human-paced typing never trips it.
- A Recent chip, beside Pinned: whatever this device has actually sold, freshest first, kept on the device. A search still looks past it, and it is never the opening screen — Pinned and All stay in charge of that. Variations count as their parent.
- Custom items come again. The custom-item dialog remembers the last few this device rang up and offers them as one-tap chips (name · price), carrying their quantity and tax class. The shop that sells the same bespoke thing all day stops retyping it.
- The line editor answers while you type: a live line total follows the quantity, price and discount as they're entered (a mistyped number shows a dash rather than a guess). The quantity steppers repeat under a press that stays down — one step for a tap, then a step every 110ms — so quantity 12 is one press, not eleven.
- Undo instead of confirm. Clearing the sale or removing a line happens at once, with a six-second Undo in the toast that follows. Only an empty sale can be brought back, so a newer one is never overwritten; the toast itself stays click-through except for its Undo.
- The accent colour can be the shop's own hex, not just the five presets — a colour well in Settings, mixed darker for the light theme and lifted for the dark so any colour stays legible. Picking a preset hands control back.
- Solid panels instead of glass (Settings → Appearance, per device): for older screens and wall-mounted tablets where blur stutters. The token does the work; the overlay and tile badges lose their blur too.
- The open sale now also writes itself out with the page (pagehide), a best-effort companion to the 300ms debounce — closing the tab right after ringing a line up is less likely to lose it.

## 0.8.0 (2026-10-11)

The at-a-glance release: the sale itself becomes readable from a step away.

- Cart lines carry the product's photo (a rounded thumbnail beside the quantity), so a long sale scans at a glance and "did the right thing go on?" is answered by looking, not reading. Custom items keep the space they had; the seed shop's flat white now carries a photo so the dev till shows one.
- Larger text (Settings → Appearance, per device): the whole skin is rem-based, so one root size carries it — for staff who read the till at arm's length or through glasses.
- A true black dark theme (Settings → Appearance, per device), for OLED counters: pure blacks cost no light, so the screen sits quieter in a dim shop and the battery lasts a shift. The light theme is untouched.
- A short buzz on the phone when an item lands on the sale (its own toggle, next to the chime). On tills without a buzzer it costs nothing.
- `/` on a keyboard goes to the product search from anywhere outside a field or a dialog, for shops that live on a scanner and a keyboard.
- The sale panel is the shop's own width: drag the handle between the products and the sale (or arrow-key it) and the product grid gives it room a column at a time. The width is per device, and a double-click takes it back to the default.
- The grand total in the cart pops when it changes — a discount, a price override, a coupon — the way the item count on the phone's tab already does. Reduced-motion preferences keep turning it off.

## 0.7.0 (2026-10-11)

The customization release: the till's look becomes the shop's own.

- Accent colour (Settings → Appearance, per device): five presets — cyan (as it was), violet, magenta, amber and blue — recolour the nav, chips, keypad glow and fills. The glows and shadows are mixed from the accent itself rather than hard-coded cyan, so every choice looks meant. The money button stays green whatever the shop picks: on a till, green means one thing.
- Product tiles, comfortable or compact (Settings → Appearance, per device). Compact fits more of the catalogue on screen at once — smaller squares, tighter gaps — for big lists and small counters.
- A sale chime: two soft notes and a buzz on the phone when a sale completes, the sound a shop knows as money's in the drawer. Switched off under Settings → Appearance; a device that can't play it just gets the visual.
- The grid now says what's rung up: a tile shows ×N while the product is on the sale, top-left so the stock badges keep their corner, appearing with a pop so a tap or a scan visibly lands there too. A variable parent counts what its variations put on.
- Small polish: a search that finds nothing says what was searched for; the change on the sale-done screen pops as it appears.

## 0.6.0 (2026-10-07)

Tips, the wp.org readme, and the report that counts them.

- Tips on the charge screen (Settings, Ask for tips): preset percentages or a typed amount, added to the order as a WooCommerce fee item that is not taxed (a gratuity, not a sale). The tip rides the order total, the payment, the receipt and the day's takings, and the report keeps it apart from products like a delivery charge. With the setting off, nothing appears.
- readme.txt in the wordpress.org format: the description, FAQ (including the honest "does it process card payments?" answer), the changelog, and the upgrade notice.
- The report's per-product breakdown now subtracts tips as well as delivery charges, so the table adds up to the day's gross.

## 0.5.1 (2026-10-07)

The sellability release: licensing, translations, a demo.

- The plugin is GPL v2 or later, with the proper license header in the plugin file, a LICENSE in the plugin folder, and a selling guide (docs/SELLING.md) covering the free-core-plus-pro-addon model, the wp.org submission checklist and the positioning against FooSales and Square.
- languages/shoptill.pot: 155 translatable strings extracted, so the till can speak the shop's language. Drop a .po/.po compiled to .mo in languages/ and WordPress picks it up.
- docs/demo-sale.gif: a real sale rung up and charged on the dev shop, recorded end to end, for the listing page and the landing page.

## 0.5.0 (2026-10-07)

Thermal printing and the cash drawer, straight over USB. This is the release
where the till stops feeling like software with a printer attached and starts
feeling like a till.

- Settings → Receipt printer → Connect: a thermal printer on USB is driven directly (ESC/POS over WebUSB; Chrome or Edge). Receipts print with one tap and no dialog, in the same layout as the printed preview: shop heading, order and register, lines with quantities and amounts, taxes, total, payment and change, notes, the footer, the cut. A Test print and a Kick drawer button prove the wiring on the counter.
- The cash drawer kicks on cash sales when a printer is connected (ESC p pulse on pin 2). The drawer, the receipt and the charge become one gesture.
- Text is transliterated for the printer's 8-bit codepage (accents fold, unmappable characters print as a question mark rather than mojibake); the byte stream is unit-tested down to the cut command.
- Without a printer, nothing changes: the browser's print dialog carries on as before, and the same buttons fall back to it automatically.

## 0.4.1 (2026-10-07)

A usability pass over the flows a cashier repeats all day.

- The sign-in screen remembers the last username on the device, so starting a shift is a password and a tap.
- A line added to the sale announces itself: it slides in with a brief glow, and on a phone the item count on the collapsed tab pops, so a tap or a scan visibly landed even when the sheet is shut. Reduced-motion preferences turn both off.
- The cart's tool buttons on a phone meet the 44px touch target (they were 36px), a real difference with gloves or a hurry.

## 0.4.0 (2026-10-07)

The kiosk release: the till as an appliance rather than a web page.

- Kiosk mode (Settings, per device): full screen, the screen never sleeps (wake lock), right-click and text dragging off, the cursor hides itself while idle, and Esc's exit from full screen is undone by the next tap. Optional sign-out after five minutes untouched, so a counter is never left signed in.
- Real install icons (192, 512 and a maskable 512), so Windows and Android install the till as a proper app with a proper icon instead of a browser shortcut.
- Kiosk setup guide (docs/kiosk-setup.md): Windows assigned access for a device that boots into the till and nothing else, Android screen pinning and dedicated devices, and the deliberate exits.

## 0.3.0 (2026-10-07)

The cost-of-goods release, plus a till skin rebuilt for the counter.

- Costs read from and written to the shop's cost-of-goods plugin (WPFactory's, either generation, or SkyVerge's): costs on each item of a till sale, cost and profit in the staff report, none of it for a cashier. A staff till freezes the cost it had when the sale was made, so a sale that syncs days later is costed as the stock it actually sold. Freezing is the same privilege as seeing, so an account the cost plugin keeps out of its numbers has its claimed costs ignored.
- The report's per-product cost column is net of returns, like the day's totals, so the table adds up to them; returned units show beside the sold count, and the per-product profit column is gone in favour of the day's.
- Price overrides and discounts, on a line or the whole sale, are staff work unless Cashiers may change prices is switched on. A cashier's till hides the fields, the shop refuses a deliberate change from an account that may not make one, and a sale that synced after such a change is kept as charged and noted. A stale price is not an override: the customer paid what the shelf said.
- A refund taken in wp-admin now counts on the register its sale was rung up on; the parents are loaded together, so a busy day's report pays no per-refund query.
- Both themes rebuilt on one token set: dark as the counter look (deep base, cyan accent, green money button, glass cart and dialogs, square photo tiles with gradient scrims, keys that seat under a press), light as the day look. Reduced-motion preferences turn the movement off.

## 0.2.0 (2026-10-06)

- First complete release: catalogue, selling, payments, receipts, orders and refunds, pay later, collect and deliver, end-of-day reports with drawer counts, offline queue with idempotent sync, product editing from the till, cashier role, two seed modes and full test suites (server, parity, e2e, unit).
