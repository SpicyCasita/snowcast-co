# SnowCast CO

The most accurate snowfall forecast we can build for Colorado, as an installable iPhone web app.

- **app/**: Vite + React + TypeScript PWA. It blends HRRR, NAM 3km, ECMWF, GFS, GEM, ICON and the NWS forecast for any resort, pass, town or map point. Snow is computed from each model's liquid precip with a temperature-based snow-to-liquid ratio.
- **pipeline/**: Python. It fetches Colorado SNOTEL observations and archived model forecasts, then fits per-model bias and skill weights by region × elevation band × lead day (`weights.json`). It runs nightly on GitHub Actions and commits refit weights to `app/public/data/`, which redeploys the app.
- **Seth's Weather Report**: a Colorado forecaster who posts on Facebook. `pipeline/fetch_seth.py` (the `seth` workflow, every 3 h) reads his page through an RSS-bridge feed. Claude turns each post into snow calls (locations, days, low–high inches), and the app blends them in with a weight learned from how his past calls verified against station snow. Setup: set the repo variable `SETH_FEED_URL` (an rss.app/FetchRSS feed of the page) and the secret `ANTHROPIC_API_KEY`. A missed post can be pasted in via *Actions → seth → Run workflow*.

## Install on iPhone
Open the GitHub Pages URL in Safari, tap **Share → Add to Home Screen**.

## Develop
```bash
cd app && npm install && npm run dev
npm test
npm run sync-weights   # copy pipeline/out/weights.json into the app
```
