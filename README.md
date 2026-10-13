# Tally – a simple calorie tracker

A personal calorie and macro tracker that runs as a web app on your iPhone home screen.
No server, no account, no subscription. Your diary is stored only on your phone.

## What it does

- Daily calorie goal and protein / carbs / fat targets
- Breakfast, Lunch, Dinner, Snacks
- **Scan barcode**: looks the product up in Open Food Facts (free)
- **Snap a label**: Claude reads a nutrition-label photo and saves it as one of your foods
  (if the barcode was unknown, it's linked to that barcode for next time)
- **Describe it**: "200 g Costco bulgogi with jasmine rice", "half the tray", etc.
- **Photo of meal**: Claude estimates what's on the plate (estimates; check them)
- My Foods with one-tap re-logging, quick add, edit/delete, past days
- Export/import a backup file

## Put it online (free)

The app is plain static files, so any free static host works. It must be served over
HTTPS for the camera to work. Upload everything in this folder except `README.md`.

**Option A – Netlify Drop (easiest):** go to https://app.netlify.com/drop, sign up
(free), and drag this folder onto the page. You get an `https://….netlify.app` address.
To update later, drag the folder onto your site's "Deploys" page again.

**Option B – GitHub Pages:** create a free GitHub account and a public repository, upload
these files, then turn on Settings → Pages → "Deploy from a branch" (main, root).

## Install on your iPhone

1. Open the site's address in **Safari**.
2. Tap the Share button → **Add to Home Screen** → Add.
3. Open Tally from the home screen icon (not from Safari, since the two keep separate data).
4. Tap ⚙︎ → set your targets → paste your Claude API key → **Test key** → **Save settings**.

## Claude API key

1. Sign in at https://console.anthropic.com, add a small amount of prepaid credit under
   Billing, and set a low monthly spend limit there for peace of mind.
2. Create a key under **API keys** and paste it into Tally's settings.

The key is stored only on your phone and is sent only to Anthropic. With the default
model (Claude Haiku 5.5: $0.10 per million input tokens, $0.50 per million output tokens)
a label or photo log costs well under a tenth of a cent.

## Good to know

- **Back up now and then** (Settings → Export backup → save to Files). If you delete the
  home-screen app, its data goes with it.
- Barcode data © Open Food Facts contributors, Open Database License.
- Code layout: `js/app.js` (screens), `js/ai.js` (Claude prompts), `js/off.js` (barcode
  lookup), `js/scanner.js` (camera), `js/db.js` (on-phone storage), `js/nutrition.js`
  (maths). Libraries are bundled in `vendor/` (Anthropic SDK 0.128.0, barcode-detector
  3.2.2 with ZXing WebAssembly).
