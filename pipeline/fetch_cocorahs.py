"""Fetch Colorado CoCoRaHS daily reports and pick low-elevation town stations.

Source: the CoCoRaHS CSV export (statewide, one request per calendar month).
Amounts are inches; "NA" is missing and "T" is trace (stored as 0 with a
*_trace flag). A station that files a report twice for one day keeps the
latest entry.

Day alignment: a report dated R at the morning reading (about 7am MST) covers
the 24h ending then. SNOTEL days are PST calendar days (common.OBS_TZ), so the
report end time is converted to PST and each station gets day_start_h, its
usual reading hour in PST (6 for a 7am MST observer). The report is labelled
D = the day its window starts, so it covers [D + day_start_h, D + 1 +
day_start_h) PST, and fetch_forecasts.py sums the model hours over that same
window. Reports read more than MAX_TIME_DRIFT_H away from the station's usual
hour are dropped.

Target (obs_mm, mm SWE), matching SNOTEL's 24h SWE gain:
  snow day (new snow > 0 or trace)  NewSnowSWE, else TotalPrecipAmt
  dry day (no precip, no snow)      0
  rain day (precip, no snow)        NaN (not a snow verification day)

Stations: below 9,000 ft, with at least MIN_REPORTS reports in at least half of
the fetched seasons, the 2-3 nearest each town in app/src/data/locations.ts.
The selection is kept in data/cocorahs_stations.parquet (re-pick with
--reselect) and merged into data/stations.parquet with source="cocorahs".

Writes data/cocorahs.parquet: one row per selected station x report.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import io
import re
import time

import numpy as np
import pandas as pd
import requests

from common import (
    CACHE,
    COCORAHS_PARQUET,
    COCORAHS_STATIONS_PARQUET,
    LOCATIONS_TS,
    OBS_TZ,
    STATIONS_PARQUET,
    assign_band,
    assign_region,
    station_list,
)

EXPORT = "https://data.cocorahs.org/export/exportreports.aspx"
ELEVATION_API = "https://api.open-meteo.com/v1/elevation"
LOCAL_TZ = "America/Denver"
SEASON_MONTHS = {11, 12, 1, 2, 3, 4}
DEFAULT_START = "2021-11-01"
FRESH_DAYS = 8  # observers can enter or fix reports for about a week
MAX_TIME_DRIFT_H = 3
MAX_ELEV_FT = 9000.0
MIN_REPORTS = 60
MAX_KM = 30.0
PER_TOWN = (2, 3)  # always take the 2 nearest, a 3rd while under TARGET_STATIONS
TARGET_STATIONS = 40
IN_TO_MM = 25.4

CACHE_DIR = CACHE / "cocorahs"

COLUMNS = {
    "ObservationDate": "obs_date",
    "ObservationTime": "obs_time",
    "EntryDateTime": "entry",
    "StationNumber": "site",
    "StationName": "name",
    "Latitude": "latitude",
    "Longitude": "longitude",
    "TotalPrecipAmt": "precip_in",
    "NewSnowDepth": "snow_in",
    "NewSnowSWE": "snow_swe_in",
    "TotalSnowDepth": "depth_in",
    "TotalSnowSWE": "depth_swe_in",
}
AMOUNTS = ["precip_in", "snow_in", "snow_swe_in", "depth_in", "depth_swe_in"]


def season_of(dates: pd.Series) -> pd.Series:
    """Snow season label = year it starts (Nov 2023 - Apr 2024 -> 2023)."""
    return dates.dt.year - (dates.dt.month <= 6).astype(int)


def month_chunks(start: dt.date, end: dt.date) -> list[tuple[dt.date, dt.date]]:
    chunks = []
    cur = dt.date(start.year, start.month, 1)
    while cur <= end:
        nxt = dt.date(cur.year + cur.month // 12, cur.month % 12 + 1, 1)
        if cur.month in SEASON_MONTHS:
            chunks.append((max(cur, start), min(nxt - dt.timedelta(days=1), end)))
        cur = nxt
    return chunks


def fetch_month(session: requests.Session, a: dt.date, b: dt.date, today: dt.date) -> str:
    """CSV text for one month, from cache unless the month may still be changing."""
    path = CACHE_DIR / f"{a:%Y-%m}.csv.gz"
    stamp = CACHE_DIR / f"{a:%Y-%m}.fetched"
    if path.exists():
        fetched = dt.date.fromisoformat(stamp.read_text().strip()) if stamp.exists() else today
        if (fetched - b).days > FRESH_DAYS or fetched == today:
            with gzip.open(path, "rt", encoding="utf-8") as f:
                return f.read()
    params = {
        "ReportType": "Daily",
        "dtf": "1",
        "Format": "CSV",
        "State": "CO",
        "ReportDateType": "reportdate",
        "StartDate": f"{a.month}/{a.day}/{a.year}",
        "EndDate": f"{b.month}/{b.day}/{b.year}",
        "TimesInGMT": "False",
    }
    for attempt in range(5):
        try:
            r = session.get(EXPORT, params=params, timeout=300)
            if r.status_code == 200 and r.text.startswith("ObservationDate"):
                break
            print(f"    CoCoRaHS {a:%Y-%m}: HTTP {r.status_code}; retrying")
        except requests.RequestException as e:
            print(f"    CoCoRaHS {a:%Y-%m}: {e}; retrying")
        time.sleep(10 * (attempt + 1))
    else:
        raise RuntimeError(f"CoCoRaHS export for {a:%Y-%m} kept failing")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write(r.text)
    stamp.write_text(today.isoformat())
    return r.text


def parse_amount(s: pd.Series) -> tuple[pd.Series, pd.Series]:
    """'NA' -> NaN, 'T' -> 0.0 with trace=True, numbers as float."""
    s = s.astype("string").str.strip()
    trace = s.str.upper().eq("T").fillna(False).astype(bool)
    value = pd.to_numeric(s.mask(trace, "0"), errors="coerce")
    return value.astype(float), trace


def parse_csv(text: str) -> pd.DataFrame:
    """Raw export text -> one cleaned row per station x observation date."""
    raw = pd.read_csv(io.StringIO(text), dtype=str, skipinitialspace=True, keep_default_na=False)
    raw.columns = [c.strip() for c in raw.columns]
    df = raw[[c for c in COLUMNS if c in raw]].rename(columns=COLUMNS)
    for col in df.columns:
        df[col] = df[col].astype("string").str.strip()
    out = pd.DataFrame({"site": df.site, "name": df["name"]})
    out["obs_date"] = pd.to_datetime(df.obs_date, format="%Y-%m-%d", errors="coerce")
    out["latitude"] = pd.to_numeric(df.latitude, errors="coerce").astype(float)
    out["longitude"] = pd.to_numeric(df.longitude, errors="coerce").astype(float)
    for col in AMOUNTS:
        out[col], out[col.replace("_in", "_trace")] = parse_amount(df[col]) if col in df else (np.nan, False)
    local = pd.to_datetime(df.obs_date + " " + df.obs_time, format="%Y-%m-%d %I:%M %p", errors="coerce")
    end = local.dt.tz_localize(LOCAL_TZ, ambiguous="NaT", nonexistent="shift_forward").dt.tz_convert(OBS_TZ)
    out["end_pst"] = end.dt.tz_localize(None)
    out["entry"] = pd.to_datetime(df.entry, format="%Y-%m-%d %I:%M %p", errors="coerce") if "entry" in df else pd.NaT
    out = out.dropna(subset=["site", "obs_date", "end_pst"])
    # a report re-entered for the same day: keep the latest entry
    out = out.sort_values(["site", "obs_date", "entry"], na_position="first")
    out = out.drop_duplicates(["site", "obs_date"], keep="last")
    return out.reset_index(drop=True)


def _hour_of_day(ts: pd.Series) -> pd.Series:
    """Hour in [-6, 18) so midnight-ish readings (23:xx and 00:xx) stay together."""
    h = (ts - ts.dt.normalize()) / pd.Timedelta(hours=1)
    return h.where(h < 18, h - 24)


def align_days(df: pd.DataFrame) -> pd.DataFrame:
    """Add day_start_h per station and date = the PST day each report's window starts."""
    h = _hour_of_day(df.end_pst)
    start_h = h.groupby(df.site).transform("median").round().astype(int)
    df = df.assign(day_start_h=start_h % 24)
    drift = (h - start_h).abs()
    df = df[drift <= MAX_TIME_DRIFT_H].copy()
    shifted = df.end_pst - pd.to_timedelta(df.day_start_h, unit="h") + pd.Timedelta(hours=12)
    df["date"] = shifted.dt.normalize() - pd.Timedelta(days=1)
    return df.reset_index(drop=True)


def add_target(df: pd.DataFrame) -> pd.DataFrame:
    """Classify snow / dry / rain days and set obs_mm (mm SWE) as in the module docstring."""
    snow = (df.snow_in > 0) | df.snow_trace
    no_snow = (df.snow_in == 0) & ~df.snow_trace
    dry = no_snow & (df.precip_in == 0)
    rain = no_snow & (df.precip_in > 0)
    swe = df.snow_swe_in.where(df.snow_swe_in.notna(), df.precip_in)
    df = df.copy()
    df["kind"] = np.select([snow, dry, rain], ["snow", "dry", "rain"], default="unknown")
    df["obs_mm"] = np.where(snow, swe * IN_TO_MM, np.where(dry, 0.0, np.nan))
    return df


def parse_towns(path=LOCATIONS_TS) -> pd.DataFrame:
    pat = re.compile(r"town\('([^']+)',\s*'([^']+)',\s*([-\d.]+),\s*([-\d.]+),\s*(\d+),\s*'([^']+)'\)")
    rows = [(m[1], m[2], float(m[3]), float(m[4]), float(m[5]), m[6]) for m in pat.finditer(path.read_text(encoding="utf-8"))]
    return pd.DataFrame(rows, columns=["town", "town_name", "lat", "lon", "elev_ft", "app_region"])


def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * np.arcsin(np.sqrt(a))


def qualifying(reports: pd.DataFrame) -> pd.DataFrame:
    """Stations with >= MIN_REPORTS valid reports in at least half the seasons fetched."""
    valid = reports[reports.kind != "unknown"]
    seasons = season_of(valid.date)
    counts = valid.groupby([valid.site, seasons]).size().unstack(fill_value=0)
    n_seasons = seasons.nunique()
    good = counts[(counts >= MIN_REPORTS).sum(axis=1) >= max(1, -(-n_seasons // 2))].index
    loc = reports.groupby("site").agg(name=("name", "last"), latitude=("latitude", "median"), longitude=("longitude", "median"))
    return loc.loc[loc.index.intersection(good)].reset_index()


def fetch_elevations(lats, lons) -> list[float]:
    """Open-Meteo elevation (90 m DEM), up to 100 points per request, metres."""
    session = requests.Session()
    out: list[float] = []
    lats, lons = list(lats), list(lons)
    for i in range(0, len(lats), 100):
        r = session.get(
            ELEVATION_API,
            params={"latitude": ",".join(f"{x:.5f}" for x in lats[i : i + 100]), "longitude": ",".join(f"{x:.5f}" for x in lons[i : i + 100])},
            timeout=60,
        )
        r.raise_for_status()
        out += r.json()["elevation"]
    return out


def pick_stations(cands: pd.DataFrame, towns: pd.DataFrame, target: int = TARGET_STATIONS) -> pd.DataFrame:
    """2 nearest qualifying stations per town, then 3rd-nearest ones while under target.

    `cands` needs site, latitude, longitude, elev_ft; stations above MAX_ELEV_FT
    or farther than MAX_KM from the town are skipped.
    """
    cands = cands[cands.elev_ft < MAX_ELEV_FT]
    ranked = {}
    for t in towns.itertuples():
        d = haversine_km(t.lat, t.lon, cands.latitude.values, cands.longitude.values)
        near = cands.assign(km=d)[d <= MAX_KM].sort_values("km")
        ranked[t.town] = near
    # Round-robin over towns so neighbouring towns (Denver, Littleton, Golden) each get their own stations.
    chosen: dict[str, tuple[str, float]] = {}
    for rank in range(PER_TOWN[1]):
        for town, near in ranked.items():
            if rank >= PER_TOWN[0] and len(chosen) >= target:
                break
            free = near[~near.site.isin(chosen)]
            if len(free):
                chosen[free.site.iloc[0]] = (town, float(free.km.iloc[0]))
    sel = cands[cands.site.isin(chosen)].copy()
    sel["town"] = sel.site.map(lambda s: chosen[s][0])
    sel["town_km"] = sel.site.map(lambda s: round(chosen[s][1], 1))
    return sel.sort_values(["town", "town_km"]).reset_index(drop=True)


def select_stations(reports: pd.DataFrame, towns: pd.DataFrame, target: int) -> pd.DataFrame:
    q = qualifying(reports)
    # Only look up elevations for stations that could be picked.
    near_any = np.zeros(len(q), dtype=bool)
    for t in towns.itertuples():
        near_any |= haversine_km(t.lat, t.lon, q.latitude.values, q.longitude.values) <= MAX_KM
    q = q[near_any].reset_index(drop=True)
    print(f"{len(q)} qualifying CoCoRaHS stations within {MAX_KM:.0f} km of a town")
    q["elev_m"] = np.round(fetch_elevations(q.latitude, q.longitude), 1)
    q["elev_ft"] = (q.elev_m / 0.3048).round(0)
    sel = pick_stations(q, towns, target)
    sel["region"] = [assign_region(la, lo) for la, lo in zip(sel.latitude, sel.longitude)]
    sel["band"] = sel.elev_ft.map(assign_band)
    sel["day_start_h"] = reports.groupby("site").day_start_h.first().reindex(sel.site).values.astype(int)
    sel["source"] = "cocorahs"
    sel["triplet"] = None
    sel["begin_date"] = None
    return sel[sel.region.notna()].reset_index(drop=True)


def merge_station_list(sel: pd.DataFrame) -> pd.DataFrame:
    """stations.parquet = SNOTEL rows (as fetch_snotel wrote them) + the CoCoRaHS selection."""
    st = station_list()
    st = st[st.source != "cocorahs"]
    cols = list(dict.fromkeys(list(st.columns) + ["town", "town_km"]))
    merged = pd.concat([st, sel.reindex(columns=cols)], ignore_index=True)
    merged["day_start_h"] = merged.day_start_h.astype(int)
    merged.to_parquet(STATIONS_PARQUET, index=False)
    return merged


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--end", default=dt.date.today().isoformat())
    ap.add_argument("--target", type=int, default=TARGET_STATIONS, help="about how many stations to pick")
    ap.add_argument("--towns", default="", help="comma-separated town ids to limit the selection (default: all towns)")
    ap.add_argument("--reselect", action="store_true", help="re-pick stations instead of reusing data/cocorahs_stations.parquet")
    args = ap.parse_args()

    today = dt.date.today()
    session = requests.Session()
    chunks = month_chunks(dt.date.fromisoformat(args.start), dt.date.fromisoformat(args.end))
    frames = []
    for a, b in chunks:
        df = parse_csv(fetch_month(session, a, b, today))
        print(f"  CoCoRaHS {a:%Y-%m}: {len(df):,} reports from {df.site.nunique()} stations")
        frames.append(df)
    reports = pd.concat(frames, ignore_index=True).drop_duplicates(["site", "obs_date"], keep="last")
    reports = add_target(align_days(reports))

    if COCORAHS_STATIONS_PARQUET.exists() and not args.reselect:
        sel = pd.read_parquet(COCORAHS_STATIONS_PARQUET)
        # day_start_h follows the latest reports in case an observer changed their reading time
        latest = reports.groupby("site").day_start_h.last()
        sel["day_start_h"] = sel.site.map(latest).fillna(sel.day_start_h).astype(int)
    else:
        towns = parse_towns()
        if args.towns:
            towns = towns[towns.town.isin(args.towns.split(","))]
        sel = select_stations(reports, towns, args.target)
    sel.to_parquet(COCORAHS_STATIONS_PARQUET, index=False)
    merge_station_list(sel)

    obs = reports[reports.site.isin(sel.site)].drop(columns=["name", "latitude", "longitude", "entry"])
    obs = obs.sort_values(["site", "date"]).reset_index(drop=True)
    obs.to_parquet(COCORAHS_PARQUET, index=False)
    print(f"wrote {len(obs):,} reports for {obs.site.nunique()} stations -> {COCORAHS_PARQUET}")
    print(sel[["site", "name", "town", "town_km", "elev_ft", "region", "band", "day_start_h"]].to_string(index=False))
    print(obs.groupby([season_of(obs.date), "kind"]).size().unstack(fill_value=0))


if __name__ == "__main__":
    main()
