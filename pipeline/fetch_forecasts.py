"""Fetch archived per-model forecasts at each SNOTEL site for lead days 1-7.

Source: Open-Meteo Previous Runs API. Hourly `<var>_previous_dayN` holds the
value forecast by the run issued N days before that hour. Summing those hours
over a calendar day (in SNOTEL's fixed PST day) gives a lead-N daily forecast.
Requests pass the station elevation so Open-Meteo applies its downscaling.

Archive coverage observed as of Nov 2026 (missing combos come back as nulls
and are dropped):
  - GFS / ICON / GEM: from about Jan 2024; ECMWF IFS from about Mar 2024
  - HRRR: lead day 1 only; ICON: lead days 1-6
  - NAM: not archived at all, so it never appears in the output

Responses are cached per site x month under data/cache/forecasts so reruns and
multi-day backfills only download what is missing.

Writes data/forecasts.parquet: site, date, model, lead_day, precip_mm,
snowfall_cm, tavg_c, n_hours.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import math
import time

import numpy as np
import pandas as pd
import requests

from common import CACHE, FORECASTS_PARQUET, LEAD_DAYS, MODELS, OBS_TZ, SNOTEL_PARQUET, STATIONS_PARQUET

API = "https://previous-runs-api.open-meteo.com/v1/forecast"
ARCHIVE_START = dt.date(2024, 1, 1)
VARS = {"precipitation": "precip_mm", "snowfall": "snowfall_cm", "temperature_2m": "tavg_c"}
DEFAULT_MONTHS = "10,11,12,1,2,3,4,5,6"
# A daily sum needs nearly the full day; partial days would bias QPF low.
MIN_HOURS = 20
# Months whose last day is newer than this may still be filling in upstream.
FRESH_DAYS = 8
# Free tier: 600/min, 5k/hour, 10k/day. Requests with many variables or long
# ranges count as several calls, so we pace by estimated call weight.
MAX_WEIGHT_PER_MIN = 400

CACHE_DIR = CACHE / "forecasts"


class StopFetching(Exception):
    """Stop downloading for this run (budget used, API limit hit, or API unavailable); the cache is still used."""


def hourly_vars() -> list[str]:
    return [f"{v}_previous_day{n}" for v in VARS for n in LEAD_DAYS]


def call_weight(n_vars: int, n_days: int) -> float:
    """Open-Meteo's fractional call count: >10 variables or >14 days cost more."""
    return max(1.0, n_vars / 10) * max(1.0, n_days / 14)


def month_chunks(start: dt.date, end: dt.date, months: set[int]) -> list[tuple[dt.date, dt.date]]:
    chunks = []
    cur = dt.date(start.year, start.month, 1)
    while cur <= end:
        nxt = dt.date(cur.year + cur.month // 12, cur.month % 12 + 1, 1)
        if cur.month in months:
            chunks.append((max(cur, start), min(nxt - dt.timedelta(days=1), end)))
        cur = nxt
    return chunks


class Fetcher:
    def __init__(self, budget: float):
        self.session = requests.Session()
        self.budget = budget
        self.spent = 0.0
        self.window: list[tuple[float, float]] = []

    def _pace(self, weight: float) -> None:
        now = time.monotonic()
        self.window = [(t, w) for t, w in self.window if now - t < 60]
        while self.window and sum(w for _, w in self.window) + weight > MAX_WEIGHT_PER_MIN:
            time.sleep(max(0.5, 60 - (now - self.window[0][0])))
            now = time.monotonic()
            self.window = [(t, w) for t, w in self.window if now - t < 60]
        self.window.append((now, weight))

    def get(self, params: dict, weight: float) -> dict:
        if self.spent + weight > self.budget:
            raise StopFetching(f"budget of {self.budget:.0f} calls used")
        for attempt in range(6):
            self._pace(weight)
            try:
                r = self.session.get(API, params=params, timeout=120)
            except requests.RequestException as e:
                print(f"    network error {e}; retrying")
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code == 429:
                reason = r.text.lower()
                # Waiting out an hourly or daily limit isn't worth the runner time; resume next run.
                if "daily" in reason or "hourly" in reason:
                    raise StopFetching(r.text)
                print("    rate limited; sleeping 60s")
                time.sleep(60)
                continue
            if r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code == 400:
                raise ValueError(f"Open-Meteo 400: {r.text}")
            r.raise_for_status()
            self.spent += weight
            try:
                return r.json()
            except ValueError:
                # Occasionally a 200 arrives with an empty or truncated body.
                print("    unreadable response; retrying")
                time.sleep(5 * (attempt + 1))
        raise StopFetching("Open-Meteo request kept failing")


def cache_path(site: str, month_start: dt.date):
    return CACHE_DIR / f"{site}_{month_start:%Y-%m}.json.gz"


def load_or_fetch(fetcher: Fetcher, st: pd.Series, a: dt.date, b: dt.date, today: dt.date) -> dict | None:
    path = cache_path(st.site, a.replace(day=1))
    if path.exists():
        with gzip.open(path, "rt") as f:
            cached = json.load(f)
        if cached.get("_end") == b.isoformat() and (today - b).days > FRESH_DAYS:
            return cached
        if cached.get("_end") == b.isoformat() and cached.get("_fetched") == today.isoformat():
            return cached
    variables = hourly_vars()
    params = {
        "latitude": st.latitude,
        "longitude": st.longitude,
        "elevation": st.elev_m,
        "hourly": ",".join(variables),
        "models": ",".join(MODELS),
        "start_date": a.isoformat(),
        "end_date": b.isoformat(),
        "timezone": OBS_TZ,
    }
    weight = call_weight(len(variables) * len(MODELS), (b - a).days + 1)
    data = fetcher.get(params, weight)
    data["_end"] = b.isoformat()
    data["_fetched"] = today.isoformat()
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt") as f:
        json.dump(data, f)
    return data


def parse_response(data: dict, site: str) -> pd.DataFrame:
    """Hourly previous-run response -> daily long rows (one per date x model x lead)."""
    hourly = data.get("hourly") or {}
    if "time" not in hourly:
        return pd.DataFrame()
    times = pd.to_datetime(hourly["time"])
    dates = times.normalize()
    pieces = []
    for model in MODELS:
        for n in LEAD_DAYS:
            cols = {out: hourly.get(f"{var}_previous_day{n}_{model}") for var, out in VARS.items()}
            if cols["precip_mm"] is None or all(v is None for v in cols["precip_mm"]):
                continue
            frame = pd.DataFrame({k: np.array(v if v is not None else [None] * len(times), dtype=float) for k, v in cols.items()})
            frame["date"] = dates
            g = frame.groupby("date")
            daily = pd.DataFrame(
                {
                    "precip_mm": g.precip_mm.sum(min_count=1),
                    "snowfall_cm": g.snowfall_cm.sum(min_count=1),
                    "tavg_c": g.tavg_c.mean(),
                    "n_hours": g.precip_mm.count(),
                }
            )
            daily = daily[daily.n_hours >= MIN_HOURS].reset_index()
            daily["model"] = model
            daily["lead_day"] = n
            pieces.append(daily)
    if not pieces:
        return pd.DataFrame()
    out = pd.concat(pieces, ignore_index=True)
    out.insert(0, "site", site)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default=ARCHIVE_START.isoformat())
    ap.add_argument("--end", default=(dt.date.today() - dt.timedelta(days=1)).isoformat())
    ap.add_argument("--months", default=DEFAULT_MONTHS, help="calendar months to fetch (snow season by default)")
    ap.add_argument("--sites", default="obs", help="'obs' = sites present in snotel.parquet, 'all', or comma-separated ids")
    ap.add_argument("--budget", type=float, default=9000, help="max estimated API calls this run (free tier is 10k/day)")
    args = ap.parse_args()

    today = dt.date.today()
    start = max(dt.date.fromisoformat(args.start), ARCHIVE_START)
    end = dt.date.fromisoformat(args.end)
    months = {int(m) for m in args.months.split(",")}

    stations = pd.read_parquet(STATIONS_PARQUET)
    if args.sites == "obs":
        stations = stations[stations.site.isin(pd.read_parquet(SNOTEL_PARQUET, columns=["site"]).site.unique())]
    elif args.sites != "all":
        stations = stations[stations.site.isin(args.sites.split(","))]

    chunks = month_chunks(start, end, months)
    # newest first, so a budget-limited run still gets the freshest data
    jobs = [(st, a, b) for a, b in reversed(chunks) for _, st in stations.iterrows()]
    print(f"{len(stations)} sites x {len(chunks)} months = {len(jobs)} site-months")

    fetcher = Fetcher(args.budget)
    frames = []
    stopped = None
    for i, (st, a, b) in enumerate(jobs, 1):
        try:
            data = load_or_fetch(fetcher, st, a, b, today)
        except StopFetching as e:
            stopped = str(e)
            break
        frames.append(parse_response(data, st.site))
        if i % 25 == 0:
            print(f"  {i}/{len(jobs)} site-months, ~{fetcher.spent:.0f} calls spent")
    if stopped:
        # still assemble everything already cached so partial backfills accumulate
        print(f"stopping downloads: {stopped}; using cache for the rest")
        for st, a, b in jobs[len(frames):]:
            path = cache_path(st.site, a.replace(day=1))
            if path.exists():
                with gzip.open(path, "rt") as f:
                    frames.append(parse_response(json.load(f), st.site))

    frames = [f for f in frames if len(f)]
    if not frames:
        raise SystemExit("no forecast data fetched")
    fc = pd.concat(frames, ignore_index=True)
    fc = fc.drop_duplicates(["site", "date", "model", "lead_day"], keep="last")
    fc = fc.sort_values(["site", "date", "model", "lead_day"]).reset_index(drop=True)
    fc["n_hours"] = fc.n_hours.astype("int16")
    fc["lead_day"] = fc.lead_day.astype("int8")
    FORECASTS_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    fc.to_parquet(FORECASTS_PARQUET, index=False)
    print(f"wrote {len(fc):,} rows ({fc.site.nunique()} sites, ~{fetcher.spent:.0f} calls) -> {FORECASTS_PARQUET}")
    print(fc.groupby(["model", "lead_day"]).size().unstack(fill_value=0))


if __name__ == "__main__":
    main()
