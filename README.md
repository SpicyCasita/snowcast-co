# SnowCast CO

The most accurate snowfall forecast we can build for Colorado, as an installable iPhone web app.

- **app/**: Vite + React + TypeScript PWA. It blends HRRR, NAM 3km, ECMWF, GFS, GEM, ICON and the NWS forecast for any resort, pass, town or map point. Snow is computed from each model's liquid precip with a temperature-based snow-to-liquid ratio.
- **pipeline/**: Python. It fetches Colorado SNOTEL observations and archived model forecasts, then fits per-model bias and skill weights by region × elevation band × lead day (`weights.json`). It runs nightly on GitHub Actions and commits refit weights to `app/public/data/`, which redeploys the app.

## Install on iPhone
Open the GitHub Pages URL in Safari, tap **Share → Add to Home Screen**.

## Develop
```bash
cd app && npm install && npm run dev
npm test
npm run sync-weights   # copy pipeline/out/weights.json into the app
```
