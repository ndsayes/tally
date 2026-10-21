# Tally – a simple calorie tracker

A personal calorie and macro tracker that runs as a web app on your iPhone home screen.
No server, no account, no subscription. Your diary is stored only on your phone.

## What it does

- **Summary** tab (the home screen): one coloured circle per day showing how close you
  came to your calorie goal: green = met (within 5%), yellow = 90%+, orange = 75–89%,
  red = further off (going over counts the same way). Switch between This week, Last week and
  Last 7 days; see today's numbers (tap **+** to add food, or **Today ›** to open the diary), plus the period's days on
  target and average calories and macros. Tap any day to open its log.
- Daily calorie goal and protein / carbs / fat targets
- Breakfast, Lunch, Dinner, Snacks
- **Scan barcode**: looks the product up in Open Food Facts (free)
- **Snap a label**: Claude reads a nutrition-label photo and saves it as one of your foods
  (if the barcode was unknown, it's linked to that barcode for next time)
- **Describe it**: "200 g Costco bulgogi with jasmine rice", "half the tray", etc. Mention a
  restaurant ("bone marrow burger from Bar Isabel", "pad thai from the place on King and Bay")
  and Claude searches the web for that dish on its menu, near the home city set in Settings.
  A lookup costs about 1–3 cents (web searches are $10 per 1,000); saving the dish to My
  Foods means the next time needs no search.
- **Photo of meal**: Claude estimates what's on the plate (estimates; check them)
- **Lego mode**: build one meal from its ingredients (e.g. a burger: scan the buns, the cheese
  and the patties, describe the sauce, quick-add the onions). It's logged as a single item.
  Tap it later in the diary → **Edit ingredients** to change amounts or swap parts.
- **Favorites**: save a meal you have often (e.g. yogurt + granola + honey, or a 7-ingredient
  shake) under one name, then log it with one tap or just say "my post-workout shake". Create
  one by ticking "Save as a favorite" after describing a meal, by tapping "Save this … as a
  favorite" under a meal on the Today screen, or by tapping ☆ on any food.
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
4. Tap ⚙︎ → set your targets → paste your Claude API key → **Test key**. Settings save automatically.

## Claude API key

1. Sign in at https://console.anthropic.com, add a small amount of prepaid credit under
   Billing, and set a low monthly spend limit there for peace of mind.
2. Create a key under **API keys** and paste it into Tally's settings.

The key is stored only on your phone and is sent only to Anthropic. With the default
model (Claude Haiku 5.5: $0.10 per million input tokens, $0.50 per million output tokens)
a label or photo log costs well under a tenth of a cent.

## Automatic backup to GitHub

Tally can save your diary to a **private** GitHub repository a few seconds after every
change, so it survives a lost or new phone. Every save is a commit, so old versions are kept.

1. On GitHub: **+** → **New repository** → name it `tally-data` → choose **Private** →
   Create. (Keep it separate from the public `tally` app repository.)
2. Create a token that can only touch that repository: profile photo → **Settings** →
   **Developer settings** → **Personal access tokens** → **Fine-grained tokens** →
   **Generate new token**.
   - Name: `Tally backup`. Expiration: the longest option offered.
   - Repository access: **Only select repositories** → `tally-data`.
   - Permissions → Repository permissions → **Contents: Read and write**.
   - Generate, then copy the token (it starts with `github_pat_`).
3. In Tally: ⚙︎ → Automatic backup → repository `your-username/tally-data`, paste the
   token → **Connect**.

**New phone:** install Tally, then connect the same repository and a token. Your diary
comes back automatically. **Expired token:** Tally shows a warning; make a new token and
use Settings → **Replace token**.

The token is stored only on your phone and never included in backups. Keep two-factor
authentication on for your GitHub account.

## Good to know

- You can also save a backup file (Settings → Export backup → save to Files). If you
  delete the home-screen app, its data on the phone goes with it.
- Barcode data © Open Food Facts contributors, Open Database License.
- Code layout: `js/app.js` (screens), `js/ai.js` (Claude prompts), `js/off.js` (barcode
  lookup), `js/scanner.js` (camera), `js/db.js` (on-phone storage), `js/cloud.js` (GitHub backup), `js/nutrition.js`
  (maths). Libraries are bundled in `vendor/` (Anthropic SDK 0.128.0, barcode-detector
  3.2.2 with ZXing WebAssembly).
