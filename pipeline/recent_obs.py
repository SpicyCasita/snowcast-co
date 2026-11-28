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
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from common import CACHE, LOCATIONS_TS, OBS_TZ, OUT
from fetch_cocorahs import add_target, align_days, fetch_elevations, fetch_month, haversine_km, parse_csv
from fetch_resort_reports import OUT_JSON as RESORT_REPORTS_JSON, SLUGS
from fetch_snotel import fetch_stations, get_json

RECENT_OBS_JSON = OUT / "recent-obs.json"
PAST_SNOWFALL_JSON = RESORT_REPORTS_JSON.parent / "past-snowfall.json"
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
# A rise with water behind it (backed_hours) counts at this size after this many readings. Replaying
# Nov 2026 at the 9 open resorts: station total 87" -> 101" against the resorts' 114", storm-by-storm
# error 61" -> 55", 3" more snow on storms the resorts didn't report.
BACKED_STEP_IN = 1.0
BACKED_HOLD_H = 2
# Water behind a rise: the precip gauge or snow pillow gained one sensor step (0.1") within this many
# hours, while the air averaged at or below freezing-ish.
WATER_STEP_IN = 0.1
WATER_LOOKBACK_H = 6
SNOW_MAX_TAVG_F = 34.0
EPS = 1e-9
# Hourly elements: depth for the snow, the rest to tell snowfall from sensor noise.
HOURLY_ELEMENTS = ("SNWD", "WTEQ", "PREC", "TOBS")
# The depth machine always starts this many days before the season, so a day's total never depends
# on the date the pipeline ran (a start that moved daily shifted Loveland Basin's season by 3").
CALC_LEAD_DAYS = 7
# app/scripts/past-snowfall.ts ACTUAL_VERSION. From a file built another way only last run's SNOTEL
# stations are kept: they include picks checked against resort reports (Telluride's Alta Lakes), while
# its CoCoRaHS picks include valley gauges standing in for ski mountains (Aspen's Woody Creek).
ACTUAL_VERSION = 2
# Observation days start at this hour PST (7am MST), like resort reports and CoCoRaHS.
DAY_START_H = 6
# Resort/pass choice: score = |elev - mid-mountain| / 1000 ft + DIST_WEIGHT * km / MAX_KM.
DIST_WEIGHT = 0.3
# Checking stations against resort reports: SNOTEL search radius, reported snow needed before a
# switch is considered, and how clearly the alternative must win (absolute and relative error).
CAL_KM = 25.0
CAL_MIN_IN = 3.0
CAL_MIN_EVENTS = 3
# Candidates within this much (or CAL_TIE_SHARE of the reported snow) of the best error are a tie,
# won by the incumbent, then by the station that fits the location best (the pool's order).
CAL_TIE_IN = 1.0
CAL_TIE_SHARE = 0.1
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
    """cands: type, id, name, lat, lon, elev_ft. Returns location id -> default station (or None).
    A resort with no SNOTEL within MAX_KM looks out to CAL_KM before settling for a gauge in the
    valley town below (Aspen Mountain was measured at a 7,585' CoCoRaHS gauge with Chapman Tunnel
    SNOTEL in reach); one with a SNOTEL nearby keeps it (Lizard Head Pass, 21 km off, out-scored
    Purgatory's Spud Mountain at 8 km on elevation alone)."""
    out: dict[str, dict | None] = {}
    for loc in locs.itertuples():
        pool = station_pool(loc, cands)
        if loc.kind == "resort" and (pool.empty or pool.iloc[0].type != "snotel"):
            far = station_pool(loc, cands, snotel_km=CAL_KM)
            far = far[far.type == "snotel"]
            if len(far):
                pool = far
        out[loc.id] = as_station(pool.iloc[0]) if len(pool) else None
    return out


def smooth(s: pd.Series | None) -> pd.Series:
    """3-reading centred median over the readings that exist (gaps skipped, ends use two readings).
    app/src/recent.ts median3 does the same, so live and daily numbers agree."""
    if s is None:
        return pd.Series(dtype=float)
    vals = s.astype(float).dropna().sort_index()
    return vals.rolling(SMOOTH_H, center=True, min_periods=1).median()


def backed_hours(index: pd.DatetimeIndex, prec: pd.Series | None = None, swe: pd.Series | None = None,
                 temp: pd.Series | None = None, lookback_h: int = WATER_LOOKBACK_H) -> np.ndarray:
    """Which depth readings have water behind them: over the `lookback_h` hours up to the reading, the
    precipitation gauge or the snow pillow gained WATER_STEP_IN (one sensor step) above its lowest
    smoothed value, and the air averaged SNOW_MAX_TAVG_F or colder (unknown temperature passes).

    Sunny-afternoon blips over bare ground and sensor flicker come with no water, so they still need
    the full STEP_IN/HOLD_H; real snowfall almost always moves one of the water gauges too. A gauge
    reset (PREC restarts each Oct 1) only lowers the minimum, so it never counts as a gain."""
    ns = lambda ix: pd.DatetimeIndex(ix).as_unit("ns").asi8  # noqa: E731 - indexes come in us or ns
    t = ns(index)
    span = pd.Timedelta(hours=lookback_h).value

    def gain(s: pd.Series | None) -> np.ndarray:
        out = np.zeros(len(t))
        m = smooth(s)
        if m.empty:
            return out
        mt, mv = ns(m.index), m.to_numpy()
        for k, ti in enumerate(t):
            lo, hi = np.searchsorted(mt, ti - span, "left"), np.searchsorted(mt, ti, "right")
            if hi > lo:
                out[k] = mv[hi - 1] - mv[lo:hi].min()
        return out

    wet = (gain(prec) >= WATER_STEP_IN - EPS) | (gain(swe) >= WATER_STEP_IN - EPS)
    tt = temp.astype(float).dropna().sort_index() if temp is not None else pd.Series(dtype=float)
    if tt.empty:
        return wet
    ttm, ttv = ns(tt.index), tt.to_numpy()
    cold = np.ones(len(t), dtype=bool)
    for k, ti in enumerate(t):
        lo, hi = np.searchsorted(ttm, ti - span, "left"), np.searchsorted(ttm, ti, "right")
        if hi > lo:
            cold[k] = ttv[lo:hi].mean() <= SNOW_MAX_TAVG_F + EPS
    return wet & cold


def snow_rises(snwd: pd.Series, backed: np.ndarray | pd.Series | None = None, step: float = STEP_IN, hold: int = HOLD_H,
               backed_step: float = BACKED_STEP_IN, backed_hold: int = BACKED_HOLD_H) -> tuple[pd.Series, tuple[pd.Timestamp, float] | None]:
    """New snow (in) from a depth sensor, credited to the hour each rise began, plus the rise still in
    progress at the end of the record (start, inches) when it has water behind it.

    The 3-reading median depth has to rise `step` above a running level and stay there `hold`
    readings, and then counts only as far as its lowest point in that stretch. That ignores the
    sensors' flicker and the daytime blips some show over bare ground (Porphyry Creek and Mineral
    Creek read 2" for one to three hours on many October afternoons). Where the reading has water
    behind it (backed_hours), `backed_step` and `backed_hold` apply instead: a 1" rise counts after
    two readings, so snowfall shows within an hour or two rather than after half a day, and light
    snow that never gains 1.5" before settling still counts. The level follows settling and melt down
    the same way, so snow that falls and melts later still counts, which a day-over-day depth
    difference would miss. app/src/recent.ts stormIncrements is the same machine.
    """
    vals = smooth(snwd)
    v = vals.to_numpy()
    n = len(v)
    inc = np.zeros(n)
    if not n:
        return pd.Series(inc, index=vals.index), None
    if backed is None:
        b = np.zeros(n, dtype=bool)
    elif isinstance(backed, pd.Series):
        b = backed.reindex(vals.index).fillna(False).to_numpy(dtype=bool)
    else:
        b = np.asarray(backed, dtype=bool)
    level, up, down = v[0], None, None
    for i in range(1, n):
        s, h = (backed_step, backed_hold) if b[i] else (step, hold)
        if v[i] >= level + s - EPS:
            up, down = (i if up is None else up), None
            if i - up + 1 >= h:
                new = v[up : i + 1].min()
                inc[up] += new - level
                level, up = new, None
        elif v[i] <= level - step + EPS:
            up, down = None, (i if down is None else down)
            if i - down + 1 >= hold:
                level, down = v[down : i + 1].max(), None
        else:
            up = down = None
    pending = None
    if up is not None and b[-1] and v[up:].min() - level >= backed_step - EPS:
        pending = (vals.index[up], float(v[up:].min() - level))
    return pd.Series(inc, index=vals.index), pending


def storm_increments(snwd: pd.Series, backed: np.ndarray | pd.Series | None = None, step: float = STEP_IN, hold: int = HOLD_H) -> pd.Series:
    """Hourly new snow (in), credited to the hour each rise began (see snow_rises). Without `backed`
    every rise needs the full `step` and `hold`."""
    return snow_rises(snwd, backed, step, hold)[0]


def station_snow(series: dict[str, pd.Series]) -> tuple[pd.Series, tuple[pd.Timestamp, float] | None]:
    """snow_rises for one station's hourly SNWD/WTEQ/PREC/TOBS (any may be missing)."""
    depth = series.get("SNWD", pd.Series(dtype=float))
    idx = smooth(depth).index
    backed = backed_hours(idx, series.get("PREC"), series.get("WTEQ"), series.get("TOBS"))
    return snow_rises(depth, backed)


def day_totals(inc: pd.Series) -> pd.Series:
    """Increments summed per observation day (from DAY_START_H PST), indexed by the ISO date it
    starts; only days with readings. A reading covers the hour before it, so the 6am one still
    belongs to the day before."""
    if inc.empty:
        return pd.Series(dtype=float)
    s = inc.groupby((inc.index - pd.Timedelta(hours=DAY_START_H + 1)).normalize()).sum().round(1)
    s.index = [d.date().isoformat() for d in s.index]
    return s


def recent_new_snow(inc: pd.Series, hours: int, now: dt.datetime | None = None,
                    pending: tuple[pd.Timestamp, float] | None = None) -> float | None:
    """New snow over the last `hours`, including a backed rise still in progress; None when the
    record doesn't reach back that far or has gone stale."""
    if inc.empty:
        return None
    end = inc.index.max()
    if inc.index.min() > end - pd.Timedelta(hours=hours) or (now is not None and end < pd.Timestamp(now) - pd.Timedelta(hours=STALE_H)):
        return None
    start = end - pd.Timedelta(hours=hours)
    total = float(inc[inc.index > start].sum()) + (pending[1] if pending and pending[0] > start else 0.0)
    return round(total, 1)


# Plausible ranges (in, °F); AWDB passes sensor faults through as huge or negative numbers.
VALID = {"SNWD": (0, 400), "WTEQ": (0, 200), "PREC": (0, 300), "TOBS": (-60, 100)}


def snotel_hourly(session: requests.Session, triplets: list[str], begin: dt.datetime, end: dt.datetime,
                  elements: tuple[str, ...] = HOURLY_ELEMENTS, batch: int = 5) -> dict[str, dict[str, pd.Series]]:
    """Hourly series per station and element, PST timestamps, impossible values blanked."""
    out: dict[str, dict[str, pd.Series]] = {}
    for i in range(0, len(triplets), batch):
        payload = get_json(
            session,
            "data",
            {"stationTriplets": ",".join(triplets[i : i + batch]), "elements": ",".join(elements), "duration": "HOURLY",
             "beginDate": begin.strftime("%Y-%m-%d %H:00"), "endDate": end.strftime("%Y-%m-%d %H:00"), "periodRef": "START"},
        )
        for st in payload:
            d = out.setdefault(st["stationTriplet"], {})
            for el in st.get("data", []):
                code = el.get("stationElement", {}).get("elementCode", "SNWD")
                s = pd.Series({pd.Timestamp(v["date"]): v.get("value") for v in el.get("values", [])}, dtype=float).sort_index()
                lo, hi = VALID.get(code, (-np.inf, np.inf))
                s[(s < lo) | (s > hi)] = np.nan
                d[code] = s
    return out


def storm_spans(days: list[str], *series: dict[str, float], min_in: float = 1.0) -> list[list[str]]:
    """Storms over `days` (sorted ISO dates): days where any series had `min_in`+, merged when at
    most one day apart and padded a day each side, limited to `days`. Scoring storm totals rather
    than single days means a storm dated a day differently by two sources isn't two misses."""
    have = set(days)
    marks = sorted(d for d in days if any((s.get(d) or 0) >= min_in for s in series))
    groups: list[list[dt.date]] = []
    for d in (dt.date.fromisoformat(x) for x in marks):
        if groups and (d - groups[-1][1]).days <= 2:
            groups[-1][1] = d
        else:
            groups.append([d, d])
    out = []
    for lo, hi in groups:
        span = [(lo + dt.timedelta(days=i)).isoformat() for i in range(-1, (hi - lo).days + 2)]
        out.append([d for d in span if d in have])
    return out


def calibrate(incumbent_id: str, cands: dict[str, pd.Series], resort_days: dict[str, float],
              since: str | None = None) -> tuple[str, dict | None, list[dict]]:
    """The candidate whose new snow best matches the resort's own reports, how well it matches, and
    every candidate's numbers.

    cands: station id -> daily new snow (ISO-date index), the incumbent (last run's station) first.
    Scored on every day the resort reported from `since` (its opening day; closed resorts often post
    zeros without measuring), storm by storm with a day of slack (storm_spans over the resort's and the
    station's snow days), so a station is charged for snow the resort didn't see as well as for snow
    it missed. The incumbent is kept unless another station is clearly closer (by CAL_MARGIN_IN and to
    within CAL_RATIO of its error), so one odd storm can't flip it; nothing changes until the resort
    has reported CAL_MIN_IN over CAL_MIN_EVENTS storms.
    """
    days = sorted(d for d in resort_days if since is None or d >= since)
    reported = round(sum(resort_days[d] for d in days), 1)
    events = storm_spans(days, resort_days)
    if reported < CAL_MIN_IN or len(events) < CAL_MIN_EVENTS:
        return incumbent_id, None, []
    scores = {}
    for sid, s in cands.items():
        if sum(d in s.index for d in days) < CAL_COVERAGE * len(days):
            continue
        st = {d: float(v) for d, v in s.reindex(days).fillna(0).items()}
        err = sum(abs(sum(st[d] for d in span) - sum(resort_days[d] for d in span)) for span in storm_spans(days, resort_days, st))
        scores[sid] = {"id": sid, "stationIn": round(sum(st.values()), 1), "errIn": round(err, 1)}
    diag = sorted(scores.values(), key=lambda x: x["errIn"])
    if not scores:
        return incumbent_id, None, diag
    tie = diag[0]["errIn"] + max(CAL_TIE_IN, CAL_TIE_SHARE * reported)
    best = next(sid for sid in cands if sid in scores and scores[sid]["errIn"] <= tie)
    inc_err = scores.get(incumbent_id, {}).get("errIn", float("inf"))
    chosen = best if inc_err - scores[best]["errIn"] >= CAL_MARGIN_IN and scores[best]["errIn"] <= CAL_RATIO * inc_err else incumbent_id
    if chosen not in scores:
        return incumbent_id, None, diag
    return chosen, {"reportedIn": reported, "stationIn": scores[chosen]["stationIn"], "days": len(days),
                    "storms": len(events), "errIn": scores[chosen]["errIn"]}, diag


def load_resort_days(path=RESORT_REPORTS_JSON) -> dict[str, dict[str, float]]:
    """Resort id -> {snow day: resort-reported new snow}; empty when the file isn't there yet."""
    if not path.exists():
        return {}
    doc = json.loads(path.read_text(encoding="utf-8"))
    return {rid: {d: float(v) for d, v in r.get("days", {}).items() if v is not None} for rid, r in doc.get("resorts", {}).items()}


def measured_from(report: dict) -> str | None:
    """First day a resort's reports count as measurements: its opening day, or its first reported
    snowfall (1"+) if that came earlier. Many resorts measure before they open (Telluride, Crested
    Butte and Beaver Creek reported 17-28" in Nov 2026 while closed); others post zeros until they
    open while the snow falls (Copper: 0" to its station's 6"), and those zeros aren't measurements.
    app/scripts/past-snowfall.ts measuredFrom is the same rule."""
    first = min((d for d, v in (report.get("days") or {}).items() if v is not None and v >= 1.0), default=None)
    cands = [d for d in (report.get("openingDate"), first) if d]
    return min(cands) if cands else None


def load_measured_from(path=RESORT_REPORTS_JSON) -> dict[str, str]:
    """Resort id -> the first day its reports count (measured_from)."""
    if not path.exists():
        return {}
    doc = json.loads(path.read_text(encoding="utf-8"))
    return {rid: d for rid, r in doc.get("resorts", {}).items() if (d := measured_from(r))}


def resort_groups(slugs: dict[str, str] = SLUGS) -> list[list[str]]:
    """Resorts that share one snow report (the four Aspen Snowmass mountains), and every other resort
    on its own. A group gets one station, so mountains with one report don't show different snow."""
    by_slug: dict[str, list[str]] = {}
    for rid, slug in slugs.items():
        by_slug.setdefault(slug, []).append(rid)
    return [sorted(v) for _, v in sorted(by_slug.items())]


def load_previous_stations(path: Path) -> dict[str, dict]:
    """Location id -> the station the published past-snowfall.json used, for keeping it next run."""
    if not path.exists():
        return {}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    same = doc.get("actualVersion") == ACTUAL_VERSION
    return {lid: l["station"] for lid, l in doc.get("locations", {}).items()
            if l.get("station") and (same or l["station"].get("type") == "snotel")}


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


def with_km(st: dict, loc) -> dict:
    """A station entry with its distance from `loc` (group members share a station but not a spot)."""
    km = float(haversine_km(loc.lat, loc.lon, np.array([st["lat"]]), np.array([st["lon"]]))[0])
    return {**st, "km": round(km, 1)}


def obs_day(ts: pd.Timestamp) -> str:
    """Observation day (DAY_START_H PST start) of a PST timestamp; a reading covers the hour before it."""
    return (ts - pd.Timedelta(hours=DAY_START_H + 1)).normalize().date().isoformat()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(RECENT_OBS_JSON))
    ap.add_argument("--previous", default=str(PAST_SNOWFALL_JSON),
                    help="the published past-snowfall.json; its stations are kept unless another clearly matches better")
    args = ap.parse_args()

    now_utc = dt.datetime.now(dt.timezone.utc)
    now_pst = now_utc.astimezone(dt.timezone(dt.timedelta(hours=-8))).replace(tzinfo=None)
    today = now_pst.date()
    season = season_start(today)
    calc_start = season - dt.timedelta(days=CALC_LEAD_DAYS)
    start = min(season, today - dt.timedelta(days=HISTORY_DAYS))
    locs = parse_locations()
    by_id = {loc.id: loc for loc in locs.itertuples()}
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

    defaults = match_stations(locs, cands)
    matches = dict(defaults)
    # Keep last run's station while it still qualifies: a station change replaces a location's numbers.
    previous = load_previous_stations(Path(args.previous))
    for lid, prev in previous.items():
        loc = by_id.get(lid)
        if loc is None or not matches.get(lid) or str(prev["id"]) == matches[lid]["id"]:
            continue
        pool = station_pool(loc, cands, snotel_km=CAL_KM if loc.kind == "resort" else MAX_KM)
        row = pool[pool.id.astype(str) == str(prev["id"])]
        if len(row):
            matches[lid] = as_station(row.iloc[0])

    resort_days = load_resort_days()
    opening = load_measured_from()
    # Resorts that share a report share a station; ones with enough reported snow get every nearby
    # station checked against their reports.
    checks: list[tuple[list[str], dict, dict[str, dict]]] = []
    for group in resort_groups():
        members = [r for r in group if r in by_id]
        base = next((matches[m] for m in members if matches.get(m)), None)
        if not members or base is None:
            continue
        for m in members:
            matches[m] = with_km(base, by_id[m])
        rd = resort_days.get(members[0], {})
        if sum(rd.values()) >= CAL_MIN_IN:
            # Mountain stations only: a valley town's gauge can match a few storms by chance (Aspen's
            # four mountains were measured at Woody Creek, 7,585').
            pool: dict[str, dict] = {base["id"]: base}
            for m in members:
                for _, r in station_pool(by_id[m], cands, snotel_km=CAL_KM).iterrows():
                    if r.type == "snotel":
                        pool.setdefault(str(r.id), as_station(r))
            checks.append((members, base, pool))

    triplets = sorted({m["id"] for m in matches.values() if m and m["type"] == "snotel"}
                      | {sid for _, _, pool in checks for sid, s in pool.items() if s["type"] == "snotel"})
    hourly = snotel_hourly(session, triplets, dt.datetime.combine(calc_start, dt.time()) - dt.timedelta(hours=SMOOTH_H), now_pst)
    rises = {t: station_snow(h) for t, h in hourly.items()}
    daily: dict[str, pd.Series] = {}
    for t, (inc, pending) in rises.items():
        days = day_totals(inc)
        if pending:
            d = obs_day(pending[0])
            days.loc[d] = round(float(days.get(d, 0.0)) + pending[1], 1)
        daily[t] = days.sort_index()
    for site, g in reports[reports.site.isin(cands[cands.type == "cocorahs"].id)].groupby("site"):
        snow = g.set_index("date").snow_in.where(g.kind.to_numpy() != "unknown").dropna()
        daily[str(site)] = pd.Series(snow.round(1).to_numpy(), index=[d.date().isoformat() for d in snow.index])

    for members, base, pool in checks:
        order = [base["id"]] + [sid for sid in pool if sid != base["id"]]
        chosen, stats, diag = calibrate(base["id"], {sid: daily[sid] for sid in order if sid in daily}, resort_days[members[0]], since=opening.get(members[0]))
        if not stats:
            continue
        st = pool.get(chosen, base)
        stats["candidates"] = [{**d, "name": pool[d["id"]]["name"] if d["id"] in pool else d["id"]} for d in diag[:4]]
        for m in members:
            default = defaults.get(m)
            entry = {**with_km(st, by_id[m]), "resortCheck": stats}
            if default and default["id"] != chosen:
                entry.update(matchedBy="resort-reports", replaced=default["name"])
            matches[m] = entry
        if chosen != base["id"]:
            print(f"  {','.join(members)}: {st['name']} matches the resort's reports ({stats['stationIn']}\" vs {stats['reportedIn']}\" reported, "
                  f"off by {stats['errIn']}\" storm by storm); {base['name']} doesn't")

    print(f"{len(locs)} locations: {sum(1 for m in matches.values() if m and m['type'] == 'snotel')} SNOTEL, "
          f"{sum(1 for m in matches.values() if m and m['type'] == 'cocorahs')} CoCoRaHS, {sum(1 for m in matches.values() if not m)} unmatched, "
          f"{len(checks)} checked against resort reports, {len(triplets)} SNOTEL series from {calc_start}")

    out_locs = {}
    for loc in locs.itertuples():
        st = matches[loc.id]
        entry: dict = {"name": loc.name, "kind": loc.kind, "station": st, "days": {}, "last24In": None, "last48In": None, "asOf": None}
        if st:
            days = daily.get(st["id"], pd.Series(dtype=float))
            entry["days"] = {d: float(v) for d, v in days.items() if d >= start.isoformat()}
            if st["type"] == "snotel" and st["id"] in rises:
                inc, pending = rises[st["id"]]
                entry["last24In"] = recent_new_snow(inc, 24, now_pst, pending)
                entry["last48In"] = recent_new_snow(inc, 48, now_pst, pending)
                if len(inc):
                    entry["asOf"] = (inc.index.max() + pd.Timedelta(hours=8)).isoformat() + "Z"
                if pending:
                    entry["pending"] = {"d": obs_day(pending[0]), "in": round(pending[1], 1)}
            elif st["type"] == "cocorahs":
                g = reports[reports.site == st["id"]].sort_values("obs_date")
                fresh = g[g.obs_date >= pd.Timestamp(today - dt.timedelta(days=1))]
                if len(fresh):
                    entry["last24In"] = float(fresh.snow_in.iloc[-1]) if pd.notna(fresh.snow_in.iloc[-1]) else None
                    two = g[g.obs_date >= pd.Timestamp(today - dt.timedelta(days=2))].snow_in.tail(2)
                    entry["last48In"] = round(float(two.sum()), 1) if two.notna().all() else None
                if len(g):
                    entry["asOf"] = pd.Timestamp(g.obs_date.iloc[-1]).date().isoformat()
        out_locs[loc.id] = entry

    doc = {
        "version": 1,
        "generated": now_utc.replace(microsecond=0).isoformat(),
        "dayConvention": f"date = day the 24h window starts: {DAY_START_H}am {OBS_TZ} (7am MST) for SNOTEL, like resort reports; the observer's morning for CoCoRaHS",
        "seasonStart": season.isoformat(),
        "calcStart": calc_start.isoformat(),
        "locations": out_locs,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
