# Kiosk setup: a till that boots into itself

The ShopTill web app installs as a PWA (Install in the browser's menu, or the install
icon in the address bar), runs full screen in Kiosk mode, and keeps working offline.
This page covers the last mile: making a whole *device* behave as a till, so nobody
at the counter ever sees a desktop.

## In the till itself

Settings → Kiosk:

- **Kiosk mode** — full screen, the screen never sleeps, right-click and text
  dragging are off, and the cursor hides itself while idle. Esc leaves full
  screen; the next tap brings it back.
- **Sign out after five minutes untouched** — for a shared counter, so a till is
  never left signed in over lunch.

## Windows: assigned access (boot to the till, nothing else)

Tested on Windows 11; Windows 10 is similar.

1. Install the till in Edge or Chrome: open `https://your-shop/pos/`, then the
   browser's Install / Apps menu → *Install this site as an app*. It now appears
   in the Start menu as "Your Shop POS". Launch it once, sign in, and switch
   Kiosk mode on in Settings.
2. Settings → Accounts → Other users → Set up a kiosk (Assigned access).
3. Choose an account (create a dedicated local one, e.g. `till`), then choose
   the installed POS app as the only app it may open.
4. The device signs in to that account and launches the till full screen at
   boot. Ctrl+Alt+Del still works for the admin to get out and maintain it.

The kiosk account should auto sign-in: netplwiz or a registry `DefaultUserName`
on the kiosk account. A power cut is fine: the till comes back by itself.

## Android: screen pinning (quick) or a dedicated device (proper)

Quick: open the till in Chrome, Install app, then pin it — swipe up and hold,
tap the icon, Pin. Unpinning needs the unlock pattern, so customers can't wander.

Proper for a counter tablet: a device-manager profile with a single-app kiosk
(AnyDesk/Hexnode/Google's dedicated devices) locked to the POS app.

## The exits

There is always an exit, by design:

- Full screen: Esc, or F11.
- Assigned access: the three-finger Ctrl+Alt+Del.
- Idle sign-out (if switched on): sign back in with the cashier's card or code.

A till you can only leave by pulling the power is a till you will someday need
to leave in a hurry.
