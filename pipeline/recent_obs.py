"""Recent observed snowfall at each app location, from its nearest suitable station.

Writes out/recent-obs.json, which app/scripts/past-snowfall.ts turns into the app's
past-snowfall.json (adding our day-before forecasts and model estimates).

Station matching, per location in app/src/data/locations.ts:
  - SNOTEL (mountains) or CoCoRaHS (towns) within MAX_KM, and within ELEV_SLACK_FT of the
    location's elevation range (base..summit for resorts). Resorts and passes prefer SNOTEL,
    towns prefer CoCoRaHS; otherwise the nearest qualifying station wins.
  - CoCoRaHS gauges must have reported on at least MIN_REPORT_SHARE of recent days.
  - No match -> station null; the app script fills in a labelled model estimate.

New snow:
  - SNOTEL: daily snow-depth gain (start of D+1 minus start of D, PST), clipped at 0. Settling
    makes this a slight undercount during long storms.
  - CoCoRaHS: the observer's measured new snow, dated by the day its window starts.
  - last24/last48: SNOTEL from hourly depth (3-hour medians to damp sensor noise); CoCoRaHS
    from the latest one or two morning reports when they are from today.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re

import numpy as np
import pandas as pd
import requests

from common import CACHE, LOCATIONS_TS, OBS_TZ, OUT
from fetch_cocorahs import add_target, align_days, fetch_elevations, fetch_month, haversine_km, parse_csv
from fetch_snotel import fetch_snotel, fetch_stations, get_json

RECENT_OBS_JSON = OUT / "recent-obs.json"
GAUGE_ELEV_JSON = CACHE / "cocorahs" / "gauge-elevations.json"
HISTORY_DAYS = 60
MAX_KM = 15.0
CLOSE_KM = 5.0
ELEV_SLACK_FT = 1000.0
MIN_REPORT_SHARE = 0.5
SMOOTH_H = 3
LOC_RE = re.compile(
    r"(resort|town|pass)\('([^']+)',\s*'([^']+)',\s*([-\d.]+),\s*([-\d.]+),\s*(\d+)(?:,\s*(\d+))?,\s*'([^']+)'\)"
)


def parse_locations(path=LOCATIONS_TS) -> pd.DataFrame:
    rows = []
    for m in LOC_RE.finditer(path.read_text(encoding="utf-8")):
        kind, lid, name, lat, lon, ft1, ft2, _region = m.groups()
        lo = float(ft1)
        hi = float(ft2) if ft2 else lo
        rows.append((lid, name, kind, float(lat), float(lon), lo, hi))
    return pd.DataFrame(rows, columns=["id", "name", "kind", "lat", "lon", "base_ft", "summit_ft"])


def calendar_months(start: dt.date, end: dt.date) -> list[tuple[dt.date, dt.date]]:
    """[first, last] day pairs for each calendar month touching start..end."""
    out = []
    a = start.replace(day=1)
    while a <= end:
        nxt = (a.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        out.append((max(a, start), min(nxt - dt.timedelta(days=1), end)))
        a = nxt
    return out


def season_start(today: dt.date) -> dt.date:
    return dt.date(today.year if today.month >= 10 else today.year - 1, 10, 1)


def match_stations(locs: pd.DataFrame, cands: pd.DataFrame) -> dict[str, dict | None]:
    """cands: type, id, name, lat, lon, elev_ft. Returns location id -> chosen station (or None)."""
    out: dict[str, dict | None] = {}
    for loc in locs.itertuples():
        km = haversine_km(loc.lat, loc.lon, cands.lat.to_numpy(), cands.lon.to_numpy())
        in_range = (cands.elev_ft >= loc.base_ft - ELEV_SLACK_FT) & (cands.elev_ft <= loc.summit_ft + ELEV_SLACK_FT)
        # Unknown elevation (lookup failed): only trust gauges right next to the location.
        ok = ((km <= MAX_KM) & in_range) | ((km <= CLOSE_KM) & cands.elev_ft.isna())
        if not ok.any():
            out[loc.id] = None
            continue
        pool = cands[ok].assign(km=km[ok])
        prefer = "cocorahs" if loc.kind == "town" else "snotel"
        pool = pool.assign(rank=(pool.type != prefer).astype(int)).sort_values(["rank", "km"])
        best = pool.iloc[0]
        out[loc.id] = {
            "type": best.type,
            "id": str(best.id),
            "name": str(best["name"]),
            "lat": round(float(best.lat), 4),
            "lon": round(float(best.lon), 4),
            "elevFt": int(round(float(best.elev_ft))) if pd.notna(best.elev_ft) else None,
            "km": round(float(best.km), 1),
        }
    return out


def depth_gain(hourly: pd.Series, hours: int) -> float | None:
    """Smoothed snow-depth gain over the last `hours`, clipped at 0; None without enough data."""
    s = hourly.dropna()
    if s.empty:
        return None
    end = s.index.max()
    now = s[s.index > end - pd.Timedelta(hours=SMOOTH_H)].median()
    before = s[(s.index > end - pd.Timedelta(hours=hours + SMOOTH_H)) & (s.index <= end - pd.Timedelta(hours=hours))]
    if before.empty:
        return None
    return round(max(0.0, float(now - before.median())), 1)


def snotel_hourly_depth(session: requests.Session, triplets: list[str], now: dt.datetime) -> dict[str, pd.Series]:
    begin = (now - dt.timedelta(hours=60)).strftime("%Y-%m-%d %H:00")
    payload = get_json(
        session,
        "data",
        {"stationTriplets": ",".join(triplets), "elements": "SNWD", "duration": "HOURLY", "beginDate": begin, "endDate": now.strftime("%Y-%m-%d %H:00"), "periodRef": "START"},
    )
    out: dict[str, pd.Series] = {}
    for st in payload:
        for el in st.get("data", []):
            vals = el.get("values", [])
            s = pd.Series({pd.Timestamp(v["date"]): v.get("value") for v in vals}, dtype=float)
            s[(s < 0) | (s > 400)] = np.nan
            out[st["stationTriplet"]] = s.sort_index()
    return out


def gauge_elevations(st: pd.DataFrame) -> pd.Series:
    """Elevation (ft) per gauge, cached since gauges don't move. NaN where the lookup failed."""
    cache = json.loads(GAUGE_ELEV_JSON.read_text()) if GAUGE_ELEV_JSON.exists() else {}
    missing = st[~st.site.isin(cache)]
    if len(missing):
        try:
            for site, m in zip(missing.site, fetch_elevations(missing.lat, missing.lon)):
                cache[site] = round(m * 3.28084)
            GAUGE_ELEV_JSON.parent.mkdir(parents=True, exist_ok=True)
            GAUGE_ELEV_JSON.write_text(json.dumps(cache))
        except requests.RequestException as e:
            print(f"  gauge elevation lookup failed ({e.__class__.__name__}); only very close gauges can match")
    return st.site.map(cache).astype(float)


def cocorahs_candidates(reports: pd.DataFrame, today: dt.date, locs: pd.DataFrame) -> pd.DataFrame:
    recent = reports[reports.obs_date >= pd.Timestamp(today - dt.timedelta(days=30))]
    share = recent.groupby("site").obs_date.nunique() / 30
    keep = share[share >= MIN_REPORT_SHARE].index
    st = recent[recent.site.isin(keep)].groupby("site").agg(name=("name", "last"), lat=("latitude", "median"), lon=("longitude", "median")).reset_index()
    # Only gauges near some app location are worth an elevation lookup.
    near = np.zeros(len(st), dtype=bool)
    for loc in locs.itertuples():
        near |= haversine_km(loc.lat, loc.lon, st.lat.to_numpy(), st.lon.to_numpy()) <= MAX_KM
    st = st[near].reset_index(drop=True)
    st["elev_ft"] = gauge_elevations(st)
    return st.rename(columns={"site": "id"}).assign(type="cocorahs")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(RECENT_OBS_JSON))
    args = ap.parse_args()

    now_utc = dt.datetime.now(dt.timezone.utc)
    now_pst = now_utc.astimezone(dt.timezone(dt.timedelta(hours=-8))).replace(tzinfo=None)
    today = now_pst.date()
    start = min(season_start(today), today - dt.timedelta(days=HISTORY_DAYS))
    locs = parse_locations()
    session = requests.Session()

    snotel = fetch_stations(session)
    snotel_cands = pd.DataFrame({
        "type": "snotel", "id": snotel.triplet, "name": snotel["name"] + " SNOTEL",
        "lat": snotel.latitude, "lon": snotel.longitude, "elev_ft": snotel.elev_ft,
    })

    # Every calendar month, not just the snow season: gauge coverage is judged on the last 30 days.
    reports = add_target(align_days(pd.concat([parse_csv(fetch_month(session, a, b, today)) for a, b in calendar_months(start, today)], ignore_index=True)))
    coco_cands = cocorahs_candidates(reports, today, locs)

    matches = match_stations(locs, pd.concat([snotel_cands, coco_cands[snotel_cands.columns]], ignore_index=True))
    used = {m["id"] for m in matches.values() if m}
    triplets = sorted(t for t in used if t.endswith(":SNTL"))
    print(f"{len(locs)} locations: {sum(1 for m in matches.values() if m and m['type'] == 'snotel')} SNOTEL, "
          f"{sum(1 for m in matches.values() if m and m['type'] == 'cocorahs')} CoCoRaHS, {sum(1 for m in matches.values() if not m)} unmatched")

    daily: dict[str, dict[str, float]] = {}
    if triplets:
        st = snotel[snotel.triplet.isin(triplets)]
        obs = fetch_snotel(st, start.isoformat(), today.isoformat())
        site_to_triplet = dict(zip(st.site.astype(str), st.triplet))
        for site, g in obs.groupby("site"):
            gain = g.set_index("date").dsnwd_in.clip(lower=0).dropna()
            daily[site_to_triplet[str(site)]] = {d.date().isoformat(): round(float(v), 1) for d, v in gain.items()}
        hourly = snotel_hourly_depth(session, triplets, now_pst)
    else:
        hourly = {}

    coco = reports[reports.site.isin(used)]
    for site, g in coco.groupby("site"):
        snow = g.set_index("date").snow_in.where(g.kind.to_numpy() != "unknown").dropna()
        daily[str(site)] = {d.date().isoformat(): round(float(v), 1) for d, v in snow.items()}

    out_locs = {}
    for loc in locs.itertuples():
        st = matches[loc.id]
        entry: dict = {"name": loc.name, "kind": loc.kind, "station": st, "days": {}, "last24In": None, "last48In": None}
        if st:
            entry["days"] = daily.get(st["id"], {})
            if st["type"] == "snotel" and st["id"] in hourly:
                entry["last24In"] = depth_gain(hourly[st["id"]], 24)
                entry["last48In"] = depth_gain(hourly[st["id"]], 48)
            elif st["type"] == "cocorahs":
                g = coco[coco.site == st["id"]].sort_values("obs_date")
                fresh = g[g.obs_date >= pd.Timestamp(today - dt.timedelta(days=1))]
                if len(fresh):
                    entry["last24In"] = float(fresh.snow_in.iloc[-1]) if pd.notna(fresh.snow_in.iloc[-1]) else None
                    two = g[g.obs_date >= pd.Timestamp(today - dt.timedelta(days=2))].snow_in.tail(2)
                    entry["last48In"] = round(float(two.sum()), 1) if two.notna().all() else None
        out_locs[loc.id] = entry

    doc = {
        "version": 1,
        "generated": now_utc.replace(microsecond=0).isoformat(),
        "dayConvention": f"date = day the 24h window starts ({OBS_TZ} for SNOTEL, the observer's morning for CoCoRaHS)",
        "seasonStart": season_start(today).isoformat(),
        "locations": out_locs,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
