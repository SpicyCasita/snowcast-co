"""Fetch archived per-model forecasts at each observing site for lead days 1-7.

Source 1 (source="previous_runs"): Open-Meteo Previous Runs API. Hourly
`<var>_previous_dayN` holds the value forecast by the run issued N days before
that hour. Summing those hours over a calendar day (in SNOTEL's fixed PST day)
gives a lead-N daily forecast. Requests pass the station elevation so
Open-Meteo applies its downscaling.

Archive coverage observed as of Nov 2026 (missing combos come back as nulls
and are dropped):
  - GFS / ICON / GEM: from about Jan 2024; ECMWF IFS from about Mar 2024
  - HRRR: lead day 1 only; ICON: lead days 1-6
  - NAM: not archived at all, so it never appears in the output

Source 2 (source="historical"): Open-Meteo Historical Forecast API, a series
stitched from the first hours of each run, stored as lead_day=1. It reaches
back before 2024: HRRR and gfs_seamless from Nov 2021, GEM and ICON from 2022,
no ECMWF IFS. It is fetched for the Nov-Apr seasons before Previous Runs
starts, plus one overlap season (2024-25) that bias.py uses to decide whether
historical lead 1 behaves like previous_day1. Previous Runs months are always
downloaded first; historical months only use budget that is left over.

Sites whose observation day doesn't start at midnight (CoCoRaHS reads at
about 7am) carry day_start_h in stations.parquet, and their hours are summed
over [D + day_start_h, D + 1 + day_start_h) in OBS_TZ, labelled D.

Responses are cached per site x month under data/cache/forecasts and
data/cache/historical so reruns and multi-day backfills only download what is
missing.

Writes data/forecasts.parquet: site, date, model, lead_day, precip_mm,
snowfall_cm, tavg_c, n_hours, source; unique on (site, date, model, lead_day).
Historical rows for dates Previous Runs also covers go to
data/forecasts_overlap.parquet instead.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import time

import numpy as np
import pandas as pd
import requests

from common import (
    CACHE,
    COCORAHS_PARQUET,
    FORECASTS_PARQUET,
    LEAD_DAYS,
    MODELS,
    OBS_TZ,
    OVERLAP_PARQUET,
    SNOTEL_PARQUET,
    station_list,
)

API = "https://previous-runs-api.open-meteo.com/v1/forecast"
ARCHIVE_START = dt.date(2024, 1, 1)
HIST_API = "https://historical-forecast-api.open-meteo.com/v1/forecast"
# ECMWF IFS isn't in the historical archive before 2024 and NAM isn't archived at all.
HIST_MODELS = ["ncep_hrrr_conus", "gfs_seamless", "gem_seamless", "icon_seamless"]
HIST_START = dt.date(2021, 11, 1)
HIST_END = ARCHIVE_START - dt.timedelta(days=1)
HIST_MONTHS = {11, 12, 1, 2, 3, 4}
# season used to compare historical with previous_day1 before merging them
OVERLAP = (dt.date(2024, 11, 1), dt.date(2025, 4, 30))
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
HIST_CACHE_DIR = CACHE / "historical"


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

    def get(self, params: dict, weight: float, url: str = API) -> dict:
        if self.spent + weight > self.budget:
            raise StopFetching(f"budget of {self.budget:.0f} calls used")
        for attempt in range(6):
            self._pace(weight)
            try:
                r = self.session.get(url, params=params, timeout=120)
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


def cache_path(site: str, month_start: dt.date, source: str = "previous_runs"):
    folder = HIST_CACHE_DIR if source == "historical" else CACHE_DIR
    return folder / f"{site}_{month_start:%Y-%m}.json.gz"


def load_cached(site: str, month_start: dt.date, source: str = "previous_runs") -> dict | None:
    path = cache_path(site, month_start, source)
    if not path.exists():
        return None
    with gzip.open(path, "rt") as f:
        return json.load(f)


def day_start(st) -> int:
    v = getattr(st, "day_start_h", 0)
    return 0 if v is None or pd.isna(v) else int(v)


def load_or_fetch(fetcher: Fetcher, st: pd.Series, a: dt.date, b: dt.date, today: dt.date, source: str = "previous_runs") -> dict | None:
    cached = load_cached(st.site, a.replace(day=1), source)
    if cached is not None:
        if cached.get("_end") == b.isoformat() and (today - b).days > FRESH_DAYS:
            return cached
        if cached.get("_end") == b.isoformat() and cached.get("_fetched") == today.isoformat():
            return cached
    # a shifted day ends after midnight, so the month's last day needs the next morning too
    end = b + dt.timedelta(days=1) if day_start(st) else b
    if source == "historical":
        variables, models, url = list(VARS), HIST_MODELS, HIST_API
    else:
        variables, models, url = hourly_vars(), MODELS, API
    params = {
        "latitude": st.latitude,
        "longitude": st.longitude,
        "elevation": st.elev_m,
        "hourly": ",".join(variables),
        "models": ",".join(models),
        "start_date": a.isoformat(),
        "end_date": end.isoformat(),
        "timezone": OBS_TZ,
    }
    weight = call_weight(len(variables) * len(models), (end - a).days + 1)
    data = fetcher.get(params, weight, url)
    data["_end"] = b.isoformat()
    data["_fetched"] = today.isoformat()
    path = cache_path(st.site, a.replace(day=1), source)
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt") as f:
        json.dump(data, f)
    return data


def _daily(cols: dict, dates: pd.DatetimeIndex) -> pd.DataFrame | None:
    """Hourly columns for one model x lead -> complete-day sums (None if the series is empty)."""
    if cols["precip_mm"] is None or all(v is None for v in cols["precip_mm"]):
        return None
    frame = pd.DataFrame({k: np.array(v if v is not None else [None] * len(dates), dtype=float) for k, v in cols.items()})
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
    return daily[daily.n_hours >= MIN_HOURS].reset_index()


def _day_labels(hourly: dict, day_start_h: int) -> pd.DatetimeIndex:
    return (pd.to_datetime(hourly["time"]) - pd.Timedelta(hours=day_start_h)).normalize()


def parse_response(data: dict, site: str, day_start_h: int = 0) -> pd.DataFrame:
    """Hourly previous-run response -> daily long rows (one per date x model x lead)."""
    hourly = data.get("hourly") or {}
    if "time" not in hourly:
        return pd.DataFrame()
    dates = _day_labels(hourly, day_start_h)
    pieces = []
    for model in MODELS:
        for n in LEAD_DAYS:
            daily = _daily({out: hourly.get(f"{var}_previous_day{n}_{model}") for var, out in VARS.items()}, dates)
            if daily is None:
                continue
            daily["model"] = model
            daily["lead_day"] = n
            pieces.append(daily)
    if not pieces:
        return pd.DataFrame()
    out = pd.concat(pieces, ignore_index=True)
    out.insert(0, "site", site)
    out["source"] = "previous_runs"
    return out


def parse_historical(data: dict, site: str, day_start_h: int = 0) -> pd.DataFrame:
    """Hourly historical-forecast response -> daily rows stored as lead day 1."""
    hourly = data.get("hourly") or {}
    if "time" not in hourly:
        return pd.DataFrame()
    dates = _day_labels(hourly, day_start_h)
    pieces = []
    for model in HIST_MODELS:
        daily = _daily({out: hourly.get(f"{var}_{model}") for var, out in VARS.items()}, dates)
        if daily is None:
            continue
        daily["model"] = model
        daily["lead_day"] = 1
        pieces.append(daily)
    if not pieces:
        return pd.DataFrame()
    out = pd.concat(pieces, ignore_index=True)
    out.insert(0, "site", site)
    out["source"] = "historical"
    return out


PARSERS = {"previous_runs": parse_response, "historical": parse_historical}


def run_jobs(fetcher: Fetcher, jobs: list, today: dt.date, stopped: str | None = None) -> tuple[list[pd.DataFrame], str | None]:
    """Fetch (or read from cache) each (source, station, start, end) job in order.

    After the first StopFetching nothing more is downloaded, but cached months
    are still parsed, so partial backfills accumulate across runs.
    """
    frames = []
    for i, (source, st, a, b) in enumerate(jobs, 1):
        data = None
        if stopped is None:
            try:
                data = load_or_fetch(fetcher, st, a, b, today, source)
            except StopFetching as e:
                stopped = str(e)
                print(f"stopping downloads: {stopped}; using cache for the rest")
        if stopped is not None:
            data = load_cached(st.site, a.replace(day=1), source)
        if data is not None:
            frames.append(PARSERS[source](data, st.site, day_start(st)))
        if i % 25 == 0:
            print(f"  {i}/{len(jobs)} {source} site-months, ~{fetcher.spent:.0f} calls spent")
    return frames, stopped


def split_overlap(fc: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Historical rows on dates Previous Runs covers move out of the main table."""
    overlap = (fc.source == "historical") & (fc.date >= pd.Timestamp(ARCHIVE_START))
    return fc[~overlap].reset_index(drop=True), fc[overlap].reset_index(drop=True)


def tidy(fc: pd.DataFrame) -> pd.DataFrame:
    fc = fc.drop_duplicates(["site", "date", "model", "lead_day", "source"], keep="last")
    fc = fc.sort_values(["site", "date", "model", "lead_day", "source"]).reset_index(drop=True)
    fc["n_hours"] = fc.n_hours.astype("int16")
    fc["lead_day"] = fc.lead_day.astype("int8")
    return fc


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default=ARCHIVE_START.isoformat())
    ap.add_argument("--end", default=(dt.date.today() - dt.timedelta(days=1)).isoformat())
    ap.add_argument("--months", default=DEFAULT_MONTHS, help="calendar months to fetch (snow season by default)")
    ap.add_argument("--sites", default="obs", help="'obs' = sites in snotel.parquet or cocorahs.parquet, 'all', or comma-separated ids")
    ap.add_argument("--budget", type=float, default=9000, help="max estimated API calls this run (free tier is 10k/day)")
    ap.add_argument("--hist-start", default=HIST_START.isoformat(), help="first day of the historical (pre-2024) lead-1 series")
    ap.add_argument("--hist-end", default=HIST_END.isoformat())
    ap.add_argument("--no-historical", action="store_true", help="skip the Historical Forecast API entirely")
    args = ap.parse_args()

    today = dt.date.today()
    start = max(dt.date.fromisoformat(args.start), ARCHIVE_START)
    end = dt.date.fromisoformat(args.end)
    months = {int(m) for m in args.months.split(",")}

    stations = station_list()
    if args.sites == "obs":
        obs_sites = set(pd.read_parquet(SNOTEL_PARQUET, columns=["site"]).site.unique())
        if COCORAHS_PARQUET.exists():
            obs_sites |= set(pd.read_parquet(COCORAHS_PARQUET, columns=["site"]).site.unique())
        stations = stations[stations.site.isin(obs_sites)]
    elif args.sites != "all":
        stations = stations[stations.site.isin(args.sites.split(","))]

    chunks = month_chunks(start, end, months)
    # newest first, so a budget-limited run still gets the freshest data
    jobs = [("previous_runs", st, a, b) for a, b in reversed(chunks) for _, st in stations.iterrows()]
    print(f"{len(stations)} sites x {len(chunks)} months = {len(jobs)} previous-runs site-months")
    hist_jobs = []
    if not args.no_historical:
        hist_chunks = month_chunks(dt.date.fromisoformat(args.hist_start), dt.date.fromisoformat(args.hist_end), HIST_MONTHS)
        hist_chunks = sorted(set(hist_chunks + month_chunks(*OVERLAP, HIST_MONTHS)), reverse=True)
        hist_jobs = [("historical", st, a, b) for a, b in hist_chunks for _, st in stations.iterrows()]
        print(f"{len(stations)} sites x {len(hist_chunks)} months = {len(hist_jobs)} historical site-months (leftover budget)")

    fetcher = Fetcher(args.budget)
    # Previous Runs first; historical months only get the budget that is left.
    frames, stopped = run_jobs(fetcher, jobs, today)
    hist_frames, stopped = run_jobs(fetcher, hist_jobs, today, stopped)

    frames = [f for f in frames + hist_frames if len(f)]
    if not frames:
        raise SystemExit("no forecast data fetched")
    fc, overlap = split_overlap(tidy(pd.concat(frames, ignore_index=True)))
    FORECASTS_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    fc.to_parquet(FORECASTS_PARQUET, index=False)
    overlap.to_parquet(OVERLAP_PARQUET, index=False)
    print(f"wrote {len(fc):,} rows ({fc.site.nunique()} sites, ~{fetcher.spent:.0f} calls) -> {FORECASTS_PARQUET}")
    print(f"wrote {len(overlap):,} historical overlap rows -> {OVERLAP_PARQUET}")
    print(fc.groupby(["source", "model", "lead_day"]).size().unstack(fill_value=0))


if __name__ == "__main__":
    main()
