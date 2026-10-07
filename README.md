# Rosebay ordering demo

A demonstration of QR table ordering for Rosebay Home Cooking & Café, built by
[O2 Design Studio](https://o2-designstudio.com/). One page: a guest picks a table, orders from the
menu, and the order appears on the kitchen screen, which moves it through accepted → preparing →
ready → served. A stats screen counts what was ordered.

**It is a design demonstration, not Rosebay's ordering system.** The restaurant did not commission
it, no payment is real, and the prices are historical figures read off photographs of the
restaurant's own printed menus — the restaurant has not confirmed them.

## Two copies, and the difference between them

- **This GitHub Pages copy.** Orders are kept in each visitor's own browser. Two people opening the
  page do not see each other's orders, because GitHub Pages serves files and cannot share data
  between devices. The page says so in its footer.
- **The Claude artifact copy.** Orders are shared: send one from a phone and it appears on the
  kitchen screen on another device. That version uses the artifact's own database.

## The photographs

All 58 items carry a photograph. 27 are the restaurant's own (its posts, its printed menu, its menu
card), 13 are owned by other people and say so, and 19 are sample images from free-licence libraries
that do not show the restaurant's food — each labelled "Sample image — not from the restaurant",
with its licence, and its creator where the licence requires credit. The provenance of every
photograph is recorded in the studio's private catalogue; the captions on this page are generated
from it. The menu page at <https://mpc0367.github.io/rosebay-menu-study/> carries the same
photographs with a fuller notice.

## Running it

It is plain HTML, CSS and one script with a JSON payload. Serve the folder with any static file
server. Opened straight from disk in Chromium the menu does not load, because the script fetches
`data.js` and Chromium does not fetch `file://` URLs.
