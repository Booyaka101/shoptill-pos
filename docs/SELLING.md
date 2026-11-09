# Selling ShopTill

## License: GPL v2 or later

The plugin code is GPL v2 or later — the WordPress-idiomatic license. This is
the license the WordPress.org plugin directory requires, and it is the license
every commercial WordPress plugin company (WooCommerce itself, Yoast, ACF)
ships under. GPL means anyone who receives a copy may study, modify and
redistribute it.

## How the paid version works under GPL

The model every WordPress business uses, and the one to copy:

1. **Free core on wordpress.org** (GPL): sells from the WooCommerce catalogue,
   offline queue, receipts, refunds, end-of-day reports, kiosk mode, thermal
   printing. Complete and useful on its own — that is what earns the reviews
   and the installs.
2. **Pro add-on, sold from your own site** (also GPL, but only buyers receive
   it): the shop-facing features — cost of goods and profit, multi-register
   analytics, timeclock, customer display, priority support. GPL lets buyers
   share a copy with a friend; in practice almost nobody does, and the ones
   who do weren't going to buy anyway. What they cannot share is updates and
   support.
3. **Services**: setup and data migration for shops moving off Square or
   Lightspeed, priced per till.

## Before submitting to wordpress.org

- [ ] `readme.txt` in the wp.org format (the current README.md is the repo's;
      wp.org wants its own with a stable tag and FAQ)
- [ ] SVN checkout of the plugin directory, initial import of `trunk/`
- [ ] Icons and banners (128×128 icon, 256×256, 800×400 banner)
- [ ] The demo GIF on the listing page (docs/demo-sale.gif in this repo)
- [ ] A tag per release: `svn cp trunk tags/0.5.0` and set the stable tag

## Positioning (the pitch in one line each)

- **vs FooSales ($19/month/device):** the same WooCommerce till, one-time,
  with cost-of-goods and a cash drawer FooSales does not kick.
- **vs Square ($60/month + hardware):** your shop, your data, your hardware,
  and it keeps selling when the internet does not.
- **vs a cash register:** stock, tax and the end-of-day count are already done
  by the till, not counted by hand at midnight.

## The channels, in the order to work them

1. **wordpress.org** — the install count is the top of the funnel for every
   WordPress plugin business. Free core, pro add-on upsell.
2. **The shop's own site** — a landing page with the demo GIF and a Buy button
   (Stripe or Gumroad) for the pro version.
3. **r/smallbusiness, r/woocommerce, Facebook WooCommerce groups** — honest
   "I built this, here is a 40-second GIF" posts. The GIF does the selling.
4. **YouTube** — a 3-minute setup video ranks for "WooCommerce point of sale"
   and the competition's videos are years old.
