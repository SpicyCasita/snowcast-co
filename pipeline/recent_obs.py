"""Recent observed snowfall at each app location, from a suitable nearby station.

Writes out/recent-obs.json, which app/scripts/past-snowfall.ts turns into the app's
past-snowfall.json (adding our day-before forecasts and model estimates).

Station matching, per location in app/src/data/locations.ts:
  - SNOTEL (mountains) or CoCoRaHS (towns) within MAX_KM, and within ELEV_SLACK_FT of the
    location's elevation range (base..summit for resorts). Resorts and passes prefer SNOTEL,
    towns prefer CoCoRaHS.
  - Towns take the nearest qualifying station. Resorts and passes take the one whose elevation is
    closest to mid-mountain, with distance as a lesser factor.
  - Resorts that have posted snow reports (app/public/data/resort-reports.json) are then checked
    against them: if another station within CAL_KM clearly matches the resort's own numbers better,
    it replaces the default. Telluride's default, Red Mountain Pass, sits across the range in the
    snowiest drainage in Colorado and read well above Telluride's reports; Alta Lakes, on the ridge
    just south of the ski area, matched them.
  - CoCoRaHS gauges must have reported on at least MIN_REPORT_SHARE of recent days.
  - No match -> station null; the app script fills in a labelled model estimate.

Days run 6am to 6am PST (7am MST), the window resort snow reports and CoCoRaHS observers use, and
are dated by the day they start, so all three line up.

New snow:
  - SNOTEL: rises in the snow-depth sensor, from hourly 3-hour medians that have to move STEP_IN
    and hold for HOLD_H readings (see storm_increments). Precipitation gauges aren't used:
    converting their water to snow tracked resort reports 2-4x too high in Nov 2026 (rain at Wolf
    Creek during a 100-year flood, snow melting on warm ground, graupel), while depth rises matched
    single-day resort reports within an inch or two. Depth does settle as a storm goes on, so over a
    multi-day storm it reads below resort boards, which measure each day's new snow before it
    settles (Wolf Creek's board: 17" in 72 h on Nov 2, 2026; its summit sensor rose about 11").
  - CoCoRaHS: the observer's measured new snow.
  - last24/last48: SNOTEL from the same hourly increments; CoCoRaHS from the latest one or two
    morning reports when they are from today.
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
from fetch_resort_reports import OUT_JSON as RESORT_REPORTS_JSON
from fetch_snotel import fetch_stations, get_json

RECENT_OBS_JSON = OUT / "recent-obs.json"
GAUGE_ELEV_JSON = CACHE / "cocorahs" / "gauge-elevations.json"
HISTORY_DAYS = 60
MAX_KM = 15.0
CLOSE_KM = 5.0
ELEV_SLACK_FT = 1000.0
MIN_REPORT_SHARE = 0.5
SMOOTH_H = 3
# Depth must move this much (in) from the running level to count as new snow or as settling. The
# sensors report whole inches and flicker by one; at 1.0 that flicker added 30-45" a season.
STEP_IN = 1.5
# ...and hold there this many hourly readings (see storm_increments). Several sensors read 2" over
# bare ground for up to 3 hours on sunny afternoons; real snow stays.
HOLD_H = 4
# Observation days start at this hour PST (7am MST), like resort reports and CoCoRaHS.
DAY_START_H = 6
# Resort/pass choice: score = |elev - mid-mountain| / 1000 ft + DIST_WEIGHT * km / MAX_KM.
DIST_WEIGHT = 0.3
# Checking stations against resort reports: SNOTEL search radius, reported snow needed before a
# switch is considered, and how clearly the alternative must win (absolute and relative error).
CAL_KM = 25.0
CAL_MIN_IN = 3.0
CAL_MARGIN_IN = 2.0
CAL_RATIO = 0.5
CAL_COVERAGE = 0.8
STALE_H = 6
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


def station_pool(loc, cands: pd.DataFrame, snotel_km: float = MAX_KM) -> pd.DataFrame:
    """Qualifying stations for one location, best first. SNOTEL may come from up to `snotel_km`."""
    km = haversine_km(loc.lat, loc.lon, cands.lat.to_numpy(), cands.lon.to_numpy())
    in_range = (cands.elev_ft >= loc.base_ft - ELEV_SLACK_FT) & (cands.elev_ft <= loc.summit_ft + ELEV_SLACK_FT)
    reach = np.where(cands.type == "snotel", snotel_km, MAX_KM)
    # Unknown elevation (lookup failed): only trust gauges right next to the location.
    ok = ((km <= reach) & in_range) | ((km <= CLOSE_KM) & cands.elev_ft.isna())
    pool = cands[ok].assign(km=km[ok])
    prefer = "cocorahs" if loc.kind == "town" else "snotel"
    pool = pool.assign(rank=(pool.type != prefer).astype(int))
    if loc.kind == "town":
        return pool.sort_values(["rank", "km"])
    mid = (loc.base_ft + loc.summit_ft) / 2
    score = (pool.elev_ft - mid).abs().fillna(5000) / 1000 + DIST_WEIGHT * pool.km / MAX_KM
    return pool.assign(score=score).sort_values(["rank", "score"])


def as_station(row) -> dict:
    return {
        "type": row.type,
        "id": str(row.id),
        "name": str(row["name"]),
        "lat": round(float(row.lat), 4),
        "lon": round(float(row.lon), 4),
        "elevFt": int(round(float(row.elev_ft))) if pd.notna(row.elev_ft) else None,
        "km": round(float(row.km), 1),
    }


def match_stations(locs: pd.DataFrame, cands: pd.DataFrame) -> dict[str, dict | None]:
    """cands: type, id, name, lat, lon, elev_ft. Returns location id -> default station (or None)."""
    out: dict[str, dict | None] = {}
    for loc in locs.itertuples():
        pool = station_pool(loc, cands)
        out[loc.id] = as_station(pool.iloc[0]) if len(pool) else None
    return out


def storm_increments(snwd: pd.Series, step: float = STEP_IN, hold: int = HOLD_H) -> pd.Series:
    """Hourly new snow (in) from a depth sensor: rises of the 3-hour-median depth above a running level.

    A move counts only once the depth has stayed at least `step` from the level for `hold` readings,
    and then only as far as its lowest (or, going down, highest) point in that stretch. That ignores
    the sensors' flicker, including the daytime blips some show over bare ground (Porphyry Creek and
    Mineral Creek read 2" for one to three hours on many October afternoons). The level follows
    settling and melt down the same way, so snow that falls and melts later still counts, which a
    day-over-day depth difference would miss. Each rise is credited to the hour it began, so the
    newest `hold` - 1 hours can't count yet.
    """
    vals = snwd.astype(float).rolling(SMOOTH_H, center=True, min_periods=1).median().dropna()
    v = vals.to_numpy()
    inc = np.zeros(len(v))
    if not len(v):
        return pd.Series(inc, index=vals.index)
    level, up, down = v[0], None, None
    for i in range(1, len(v)):
        if v[i] >= level + step:
            up, down = (i if up is None else up), None
            if i - up + 1 >= hold:
                new = v[up : i + 1].min()
                inc[up] += new - level
                level, up = new, None
        elif v[i] <= level - step:
            up, down = None, (i if down is None else down)
            if i - down + 1 >= hold:
                level, down = v[down : i + 1].max(), None
        else:
            up = down = None
    return pd.Series(inc, index=vals.index)


def day_totals(inc: pd.Series) -> pd.Series:
    """Increments summed per observation day (from DAY_START_H PST), indexed by the ISO date it
    starts; only days with readings. A reading covers the hour before it, so the 6am one still
    belongs to the day before."""
    if inc.empty:
        return pd.Series(dtype=float)
    s = inc.groupby((inc.index - pd.Timedelta(hours=DAY_START_H + 1)).normalize()).sum().round(1)
    s.index = [d.date().isoformat() for d in s.index]
    return s


def recent_new_snow(inc: pd.Series, hours: int, now: dt.datetime | None = None) -> float | None:
    """New snow over the last `hours`; None when the record doesn't reach back that far or has gone stale."""
    if inc.empty:
        return None
    end = inc.index.max()
    if inc.index.min() > end - pd.Timedelta(hours=hours) or (now is not None and end < pd.Timestamp(now) - pd.Timedelta(hours=STALE_H)):
        return None
    return round(float(inc[inc.index > end - pd.Timedelta(hours=hours)].sum()), 1)


def snotel_hourly_depth(session: requests.Session, triplets: list[str], begin: dt.datetime, end: dt.datetime, batch: int = 5) -> dict[str, pd.Series]:
    """Hourly snow depth (in) per station, PST timestamps, impossible values blanked."""
    out: dict[str, pd.Series] = {}
    for i in range(0, len(triplets), batch):
        payload = get_json(
            session,
            "data",
            {"stationTriplets": ",".join(triplets[i : i + batch]), "elements": "SNWD", "duration": "HOURLY",
             "beginDate": begin.strftime("%Y-%m-%d %H:00"), "endDate": end.strftime("%Y-%m-%d %H:00"), "periodRef": "START"},
        )
        for st in payload:
            for el in st.get("data", []):
                s = pd.Series({pd.Timestamp(v["date"]): v.get("value") for v in el.get("values", [])}, dtype=float).sort_index()
                s[(s < 0) | (s > 400)] = np.nan
                out[st["stationTriplet"]] = s
    return out


def report_events(days: dict[str, float], min_in: float = 1.0) -> list[list[str]]:
    """Days around each resort-reported snowfall: [d-1, d+1] windows, merged where they overlap and
    limited to days the resort has a report for. The padding absorbs storms that straddle the
    morning report, which the resort and a station may split differently."""
    groups: list[list[dt.date]] = []
    for d in sorted(dt.date.fromisoformat(k) for k, v in days.items() if v >= min_in):
        lo, hi = d - dt.timedelta(days=1), d + dt.timedelta(days=1)
        if groups and lo <= groups[-1][1]:
            groups[-1][1] = max(groups[-1][1], hi)
        else:
            groups.append([lo, hi])
    out = []
    for lo, hi in groups:
        span = [(lo + dt.timedelta(days=i)).isoformat() for i in range((hi - lo).days + 1)]
        out.append([d for d in span if d in days])
    return out


def calibrate(default_id: str, cands: dict[str, pd.Series], resort_days: dict[str, float]) -> tuple[str, dict | None]:
    """The candidate whose new snow best matches the resort's own reports, and how well it matches.

    cands: station id -> daily new snow (ISO-date index), in preference order with the default first.
    Totals are compared over report events. The default is kept unless another station is clearly
    closer (by CAL_MARGIN_IN and to within CAL_RATIO of its error), so one odd storm can't flip it.
    Returns (default_id, None) when the resort hasn't reported CAL_MIN_IN yet.
    """
    days = sorted({d for ev in report_events(resort_days) for d in ev})
    reported = round(sum(resort_days[d] for d in days), 1)
    if reported < CAL_MIN_IN:
        return default_id, None
    totals = {}
    for sid, s in cands.items():
        if sum(d in s.index for d in days) >= CAL_COVERAGE * len(days):
            totals[sid] = round(float(s.reindex(days).fillna(0).sum()), 1)
    if not totals:
        return default_id, None
    err = {sid: abs(t - reported) for sid, t in totals.items()}
    best = min(err, key=err.__getitem__)
    d_err = err.get(default_id, float("inf"))
    chosen = best if d_err - err[best] >= CAL_MARGIN_IN and err[best] <= CAL_RATIO * d_err else default_id
    if chosen not in totals:
        return default_id, None
    return chosen, {"reportedIn": reported, "stationIn": totals[chosen], "days": len(days)}


def load_resort_days(path=RESORT_REPORTS_JSON) -> dict[str, dict[str, float]]:
    """Resort id -> {snow day: resort-reported new snow}; empty when the file isn't there yet."""
    if not path.exists():
        return {}
    doc = json.loads(path.read_text(encoding="utf-8"))
    return {rid: {d: float(v) for d, v in r.get("days", {}).items() if v is not None} for rid, r in doc.get("resorts", {}).items()}


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
    cands = pd.concat([snotel_cands, coco_cands[snotel_cands.columns]], ignore_index=True)

    matches = match_stations(locs, cands)
    resort_days = load_resort_days()
    # Resorts with enough reported snow get every nearby station checked against their reports.
    check: dict[str, list[dict]] = {}
    for loc in locs[locs.kind == "resort"].itertuples():
        rd = resort_days.get(loc.id, {})
        if matches[loc.id] and sum(rd[d] for ev in report_events(rd) for d in ev) >= CAL_MIN_IN:
            pool = [as_station(r) for _, r in station_pool(loc, cands, snotel_km=CAL_KM).iterrows()]
            default = matches[loc.id]["id"]
            check[loc.id] = sorted(pool, key=lambda s: s["id"] != default)

    triplets = sorted({m["id"] for m in matches.values() if m and m["type"] == "snotel"}
                      | {s["id"] for pool in check.values() for s in pool if s["type"] == "snotel"})
    hourly = snotel_hourly_depth(session, triplets, dt.datetime.combine(start, dt.time()) - dt.timedelta(hours=SMOOTH_H), now_pst)
    increments = {t: storm_increments(s) for t, s in hourly.items()}
    daily: dict[str, pd.Series] = {t: day_totals(inc) for t, inc in increments.items()}
    for site, g in reports[reports.site.isin(cands[cands.type == "cocorahs"].id)].groupby("site"):
        snow = g.set_index("date").snow_in.where(g.kind.to_numpy() != "unknown").dropna()
        daily[str(site)] = pd.Series(snow.round(1).to_numpy(), index=[d.date().isoformat() for d in snow.index])

    for rid, pool in check.items():
        default = matches[rid]
        chosen, stats = calibrate(default["id"], {s["id"]: daily[s["id"]] for s in pool if s["id"] in daily}, resort_days[rid])
        if not stats:
            continue
        st = next(s for s in pool if s["id"] == chosen)
        matches[rid] = {**st, "resortCheck": stats, **({"matchedBy": "resort-reports", "replaced": default["name"]} if chosen != default["id"] else {})}
        if chosen != default["id"]:
            print(f"  {rid}: {st['name']} matches the resort's reports ({stats['stationIn']}\" vs {stats['reportedIn']}\" reported); "
                  f"default {default['name']} doesn't")

    print(f"{len(locs)} locations: {sum(1 for m in matches.values() if m and m['type'] == 'snotel')} SNOTEL, "
          f"{sum(1 for m in matches.values() if m and m['type'] == 'cocorahs')} CoCoRaHS, {sum(1 for m in matches.values() if not m)} unmatched, "
          f"{len(check)} checked against resort reports")

    out_locs = {}
    for loc in locs.itertuples():
        st = matches[loc.id]
        entry: dict = {"name": loc.name, "kind": loc.kind, "station": st, "days": {}, "last24In": None, "last48In": None}
        if st:
            days = daily.get(st["id"], pd.Series(dtype=float))
            entry["days"] = {d: float(v) for d, v in days.items() if d >= start.isoformat()}
            if st["type"] == "snotel" and st["id"] in increments:
                entry["last24In"] = recent_new_snow(increments[st["id"]], 24, now_pst)
                entry["last48In"] = recent_new_snow(increments[st["id"]], 48, now_pst)
            elif st["type"] == "cocorahs":
                g = reports[reports.site == st["id"]].sort_values("obs_date")
                fresh = g[g.obs_date >= pd.Timestamp(today - dt.timedelta(days=1))]
                if len(fresh):
                    entry["last24In"] = float(fresh.snow_in.iloc[-1]) if pd.notna(fresh.snow_in.iloc[-1]) else None
                    two = g[g.obs_date >= pd.Timestamp(today - dt.timedelta(days=2))].snow_in.tail(2)
                    entry["last48In"] = round(float(two.sum()), 1) if two.notna().all() else None
        out_locs[loc.id] = entry

    doc = {
        "version": 1,
        "generated": now_utc.replace(microsecond=0).isoformat(),
        "dayConvention": f"date = day the 24h window starts: {DAY_START_H}am {OBS_TZ} (7am MST) for SNOTEL, like resort reports; the observer's morning for CoCoRaHS",
        "seasonStart": season_start(today).isoformat(),
        "locations": out_locs,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
