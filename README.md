# SnowCast CO

The most accurate snowfall forecast we can build for Colorado, as an installable iPhone web app.

- **app/**: Vite + React + TypeScript PWA. It blends HRRR, NAM 3km, ECMWF, GFS, GEM, ICON and the NWS forecast for any resort, pass, town or map point. Snow is computed from each model's liquid precip with a temperature-based snow-to-liquid ratio.
- **pipeline/**: Python. It fetches Colorado SNOTEL observations and archived model forecasts, then fits per-model bias and skill weights by region × elevation band × lead day (`weights.json`). It runs nightly on GitHub Actions and commits refit weights to `app/public/data/`, which redeploys the app.
- **Past tab** (`pipeline/recent_obs.py` → `app/scripts/past-snowfall.ts`, the `past` workflow, after 5am and again after each morning resort-report run): measured snow is each resort's own morning report once it's open, else a nearby SNOTEL depth sensor (a rise backed by its precip gauge or snow pillow counts at 1" within two readings; unbacked rises need 1.5" held 4 hours) or CoCoRaHS observer. Days older than 3 days are kept as published. The 3–48 h windows come live from SNOTEL in the app, with snow still settling in shown as ≈.
- **Seth's Weather Report**: a Colorado forecaster who posts on Facebook. `pipeline/fetch_seth.py` (the `seth` workflow, every 3 h) reads his page through an RSS-bridge feed. Claude turns each post into snow calls (locations, days, low–high inches), and the app blends them in with a weight learned from how his past calls verified against measured snow (the resort's own reports where there are any). Setup: set the repo variable `SETH_FEED_URL` (an rss.app/FetchRSS feed of the page) and the secret `ANTHROPIC_API_KEY`. A missed post can be pasted in via *Actions → seth → Run workflow*.

## Install on iPhone
Open the GitHub Pages URL in Safari, tap **Share → Add to Home Screen**.

## Develop
```bash
cd app && npm install && npm run dev
npm test
npm run sync-weights   # copy pipeline/out/weights.json into the app
```
