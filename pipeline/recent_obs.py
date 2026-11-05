"""Recent observed snowfall at each app location, from its nearest suitable station.

Writes out/recent-obs.json, which app/scripts/past-snowfall.ts turns into the app's
past-snowfall.json (adding our day-before forecasts and model estimates).

Station matching, per location in app/src/data/locations.ts:
  - SNOTEL (mountains) or CoCoRaHS (towns) within MAX_KM, and within ELEV_SLACK_FT of the
    location's elevation range (base..summit for resorts). Resorts and passes prefer SNOTEL,
    towns prefer CoCoRaHS.
  - Towns take the nearest qualifying station. Resorts and passes take the one whose elevation is
    closest to mid-mountain, with distance as a lesser factor: Copper's base-area SNOTEL (2 km)
    recorded ~0" in a Nov 2026 storm while Fremont Pass at mid-mountain height (14 km) recorded inches.
  - CoCoRaHS gauges must have reported on at least MIN_REPORT_SHARE of recent days.
  - No match -> station null; the app script fills in a labelled model estimate.

New snow:
  - SNOTEL: the larger of (a) snow-depth gain (start of D+1 minus start of D, PST, clipped at 0)
    and (b) precipitation-gauge water x the app's temperature-based snow-to-liquid ratio. (a)
    misses snow that melts into warm early-season ground or settles; (b) misses wind undercatch.
  - CoCoRaHS: the observer's measured new snow, dated by the day its window starts.
  - last24/last48: SNOTEL from the same two estimates hourly (depth uses 3-hour medians); CoCoRaHS
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
# Resort/pass choice: score = |elev - mid-mountain| / 1000 ft + DIST_WEIGHT * km / MAX_KM.
DIST_WEIGHT = 0.3
# Snow-to-liquid ratio by air temperature (°F), mirroring snowToLiquidRatio in app/src/forecast/blend.ts.
SLR_TEMPS_F = [-10, 0, 10, 15, 20, 25, 30, 34]
SLR_RATIOS = [16, 18, 20, 19, 17, 14, 11, 8]
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
        pool = pool.assign(rank=(pool.type != prefer).astype(int))
        if loc.kind == "town":
            pool = pool.sort_values(["rank", "km"])
        else:
            mid = (loc.base_ft + loc.summit_ft) / 2
            score = (pool.elev_ft - mid).abs().fillna(5000) / 1000 + DIST_WEIGHT * pool.km / MAX_KM
            pool = pool.assign(score=score).sort_values(["rank", "score"])
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


def snow_fraction(temp_f: pd.Series) -> pd.Series:
    """Share of precip falling as snow; mirrors snowFraction in blend.ts."""
    return ((37 - temp_f) / 5).clip(0, 1)


def snow_ratio(temp_f: pd.Series) -> pd.Series:
    return pd.Series(np.interp(temp_f, SLR_TEMPS_F, SLR_RATIOS), index=temp_f.index)


def precip_snow(prec: pd.Series, temp_f: pd.Series) -> pd.Series:
    """Hourly new snow (in) from SNOTEL's accumulating precip gauge and air temperature.

    The accumulator only grows within a water year, so: smooth sensor jitter with 3-hour medians,
    treat a drop of more than 0.5" as a reset (Oct 1), take the running max within each segment and
    count its increases. Hours without a temperature assume 30°F.
    """
    p = prec.astype(float).rolling(3, center=True, min_periods=1).median()
    seg = (p.diff() < -0.5).cumsum()
    p = p.groupby(seg).cummax()
    water = p.groupby(seg).diff().clip(lower=0).fillna(0)
    t = temp_f.astype(float).reindex(water.index).interpolate(limit=3, limit_direction="both").fillna(30.0)
    return water * snow_fraction(t) * snow_ratio(t)


def snotel_hourly(session: requests.Session, triplets: list[str], begin: dt.datetime, end: dt.datetime, batch: int = 5) -> dict[str, pd.DataFrame]:
    """Hourly SNWD / PREC / TOBS per station (PST timestamps), impossible values blanked."""
    out: dict[str, pd.DataFrame] = {}
    for i in range(0, len(triplets), batch):
        payload = get_json(
            session,
            "data",
            {"stationTriplets": ",".join(triplets[i : i + batch]), "elements": "SNWD,PREC,TOBS", "duration": "HOURLY",
             "beginDate": begin.strftime("%Y-%m-%d %H:00"), "endDate": end.strftime("%Y-%m-%d %H:00"), "periodRef": "START"},
        )
        for st in payload:
            cols = {}
            for el in st.get("data", []):
                code = el["stationElement"]["elementCode"]
                cols[code] = pd.Series({pd.Timestamp(v["date"]): v.get("value") for v in el.get("values", [])}, dtype=float)
            df = pd.DataFrame(cols).sort_index()
            for col, lo, hi in (("SNWD", 0, 400), ("PREC", 0, 200), ("TOBS", -60, 100)):
                if col not in df:
                    df[col] = np.nan
                df.loc[(df[col] < lo) | (df[col] > hi), col] = np.nan
            out[st["stationTriplet"]] = df
    return out


def snotel_recent(df: pd.DataFrame, hours: int) -> float | None:
    """New snow over the last `hours`: the larger of depth gain and precip-derived snow."""
    vals = [depth_gain(df.SNWD, hours)]
    if df.PREC.notna().any():
        ps = precip_snow(df.PREC, df.TOBS)
        vals.append(round(float(ps[ps.index > df.index.max() - pd.Timedelta(hours=hours)].sum()), 1))
    vals = [v for v in vals if v is not None]
    return max(vals) if vals else None


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
        hourly = snotel_hourly(session, triplets, dt.datetime.combine(start, dt.time()) - dt.timedelta(hours=3), now_pst)
        for site, g in obs.groupby("site"):
            trip = site_to_triplet[str(site)]
            new = g.set_index("date").dsnwd_in.clip(lower=0)
            if trip in hourly and hourly[trip].PREC.notna().any():
                ps = precip_snow(hourly[trip].PREC, hourly[trip].TOBS)
                by_day = ps.groupby(ps.index.normalize()).sum()
                # Only days the depth record has, so the calendar matches the depth history.
                new = pd.concat([new, by_day.reindex(new.index)], axis=1).max(axis=1, skipna=True)
            daily[trip] = {d.date().isoformat(): round(float(v), 1) for d, v in new.dropna().items()}
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
                entry["last24In"] = snotel_recent(hourly[st["id"]], 24)
                entry["last48In"] = snotel_recent(hourly[st["id"]], 48)
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
