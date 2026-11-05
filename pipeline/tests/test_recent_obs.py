import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recent_obs import (  # noqa: E402
    calendar_months, calibrate, day_totals, match_stations, parse_locations, recent_new_snow, report_events, season_start,
    station_pool, storm_increments,
)


def locs(*rows):
    return pd.DataFrame(rows, columns=["id", "name", "kind", "lat", "lon", "base_ft", "summit_ft"])


def cands(*rows):
    return pd.DataFrame(rows, columns=["type", "id", "name", "lat", "lon", "elev_ft"])


def test_parse_locations_reads_resorts_towns_and_passes():
    df = parse_locations()
    wolf = df[df.id == "wolf-creek"].iloc[0]
    assert (wolf.kind, wolf.base_ft, wolf.summit_ft) == ("resort", 10300, 11904)
    littleton = df[df.id == "littleton"].iloc[0]
    assert littleton.base_ft == littleton.summit_ft == 5351
    assert set(df.kind) == {"resort", "town", "pass"}


def test_resorts_prefer_snotel_towns_prefer_cocorahs():
    c = cands(
        ("snotel", "1:CO:SNTL", "Ridge SNOTEL", 39.01, -106.0, 10500),
        ("cocorahs", "CO-1", "Town gauge", 39.0, -106.0, 9900),
    )
    m = match_stations(locs(("r", "R", "resort", 39.0, -106.0, 9500, 11500), ("t", "T", "town", 39.0, -106.0, 9800, 9800)), c)
    assert m["r"]["type"] == "snotel"
    assert m["t"]["type"] == "cocorahs"


def test_rejects_far_or_wrong_elevation_stations():
    c = cands(("snotel", "far", "Far", 40.0, -106.0, 10000), ("snotel", "high", "High", 39.0, -106.01, 11500))
    m = match_stations(locs(("town", "Town", "town", 39.0, -106.0, 5300, 5300)), c)
    assert m["town"] is None


def test_unknown_elevation_only_matches_very_close_gauges():
    c = cands(("cocorahs", "near", "Near", 39.0, -106.001, np.nan), ("cocorahs", "mid", "Mid", 39.08, -106.0, np.nan))
    m = match_stations(locs(("a", "A", "town", 39.0, -106.0, 5300, 5300), ("b", "B", "town", 39.06, -106.1, 5300, 5300)), c)
    assert m["a"]["id"] == "near" and m["a"]["elevFt"] is None
    assert m["b"] is None


def test_resorts_pick_mid_mountain_station_towns_pick_nearest():
    c = cands(
        ("snotel", "valley", "Valley SNOTEL", 39.02, -106.0, 9700),  # ~2 km, near the base
        ("snotel", "mid", "Mid SNOTEL", 39.12, -106.0, 11300),  # ~13 km, mid-mountain height
    )
    m = match_stations(locs(("r", "R", "resort", 39.0, -106.0, 9700, 12400), ("p", "P", "pass", 39.0, -106.0, 11000, 11000)), c)
    assert m["r"]["id"] == "mid" and m["p"]["id"] == "mid"
    # Same elevation: the nearer one wins.
    c2 = cands(("snotel", "a", "A", 39.02, -106.0, 11000), ("snotel", "b", "B", 39.1, -106.0, 11000))
    assert match_stations(locs(("r", "R", "resort", 39.0, -106.0, 9700, 12400)), c2)["r"]["id"] == "a"


def series(vals, start="2026-11-01 00:00"):
    return pd.Series(np.asarray(vals, dtype=float), index=pd.date_range(start, periods=len(vals), freq="h"))


def test_storm_increments_ignore_flicker_and_count_real_rises():
    assert storm_increments(series(np.tile([0.0, 1.0], 30))).sum() == 0  # 1" sensor flicker
    assert storm_increments(series(np.tile([3.0, 4.0, 3.0], 20))).sum() == 0
    # 6" storm, settles to 4", then 5" more on top: 11" of snowfall although depth only reached 9".
    s = series(np.r_[np.full(10, 0.0), np.full(10, 6.0), np.full(10, 4.0), np.full(10, 9.0)])
    assert storm_increments(s).sum() == 11.0
    # Snow that melts back to bare ground and falls again counts both times.
    s = series(np.r_[np.full(6, 0.0), np.full(6, 3.0), np.full(6, 0.0), np.full(6, 3.0)])
    assert storm_increments(s).sum() == 6.0
    # A one-hour spike is damped by the 3-hour median.
    spike = np.full(20, 5.0)
    spike[10] = 30.0
    assert storm_increments(series(spike)).sum() == 0
    # Afternoon blips over bare ground that last up to 3 hours (Porphyry Creek Oct 12, Mineral Creek Oct 22).
    assert storm_increments(series([0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1, 0, 0, 0])).sum() == 0
    assert storm_increments(series([0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 1, 0, 1, 2, 2, 2, 1, 0, 0, 0, 0])).sum() == 0
    # Real snow builds and stays (Wolf Creek Summit, Nov 2).
    assert storm_increments(series([18, 18, 19, 20, 21, 21, 22, 23, 22, 22, 22, 22, 22, 22, 22, 22])).sum() == 4.0


def test_day_totals_run_from_the_morning_report_and_recent_windows():
    inc = storm_increments(series(np.r_[np.full(34, 0.0), np.full(26, 8.0)]))  # 8" at 10am Nov 2; ends 11am Nov 3
    assert day_totals(inc).to_dict() == {"2026-10-31": 0.0, "2026-11-01": 0.0, "2026-11-02": 8.0, "2026-11-03": 0.0}
    # The 6am reading covers 5-6am, before the morning report, so it belongs to the day before.
    at6 = storm_increments(series(np.r_[np.full(30, 0.0), np.full(10, 8.0)]))
    assert day_totals(at6).to_dict()["2026-11-01"] == 8.0
    end = inc.index.max().to_pydatetime()
    assert recent_new_snow(inc, 24, end) == 0.0
    assert recent_new_snow(inc, 36, end) == 8.0
    assert recent_new_snow(inc, 72, end) is None  # the record doesn't reach back 72 h
    assert recent_new_snow(inc, 36, end + dt.timedelta(hours=12)) is None  # stale


def test_report_events_pad_merge_and_keep_reported_days():
    days = {"2026-10-30": 0.0, "2026-10-31": 5.0, "2026-11-01": 0.0, "2026-11-02": 6.0, "2026-11-03": 0.0, "2026-11-10": 0.5}
    assert report_events(days) == [["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]]
    assert report_events({"2026-11-02": 6.0}) == [["2026-11-02"]]
    assert report_events({"2026-11-10": 0.5}) == []


def daily(**vals):
    return pd.Series(list(vals.values()), index=[k.replace("_", "-")[1:] for k in vals])


def test_calibrate_switches_only_when_another_station_clearly_matches():
    resort = {"2026-10-31": 0.0, "2026-11-01": 6.0, "2026-11-02": 0.0}
    far = daily(_2026_10_31=2.0, _2026_11_01=11.0, _2026_11_02=8.0)  # 21" vs 6" reported
    close = daily(_2026_10_31=0.0, _2026_11_01=5.0, _2026_11_02=0.0)
    so_so = daily(_2026_10_31=0.0, _2026_11_01=7.5, _2026_11_02=0.0)
    chosen, stats = calibrate("red", {"red": far, "idarado": close}, resort)
    assert chosen == "idarado" and stats == {"reportedIn": 6.0, "stationIn": 5.0, "days": 3}
    # The default stays when it agrees, and when the alternative is only a little better.
    assert calibrate("idarado", {"idarado": close, "red": far}, resort)[0] == "idarado"
    assert calibrate("so-so", {"so-so": so_so, "idarado": close}, resort)[0] == "so-so"
    # Not enough reported snow yet: no verdict at all.
    assert calibrate("red", {"red": far, "idarado": close}, {"2026-11-01": 2.0}) == ("red", None)
    # A default with no data over the reports loses to one that has it.
    assert calibrate("red", {"red": pd.Series(dtype=float), "idarado": close}, resort)[0] == "idarado"


def test_station_pool_reaches_further_for_snotel_only():
    c = cands(
        ("snotel", "near", "Near", 39.05, -106.0, 11000),  # ~5.6 km
        ("snotel", "far", "Far", 39.18, -106.0, 11000),  # ~20 km
        ("cocorahs", "gauge", "Gauge", 39.18, -106.0, 10000),  # ~20 km
    )
    loc = next(locs(("r", "R", "resort", 39.0, -106.0, 9700, 12400)).itertuples())
    assert list(station_pool(loc, c).id) == ["near"]
    assert list(station_pool(loc, c, snotel_km=25).id) == ["near", "far"]


def test_calendar_months_cover_every_month():
    months = calendar_months(dt.date(2026, 9, 2), dt.date(2026, 11, 1))
    assert months == [(dt.date(2026, 9, 2), dt.date(2026, 9, 30)), (dt.date(2026, 10, 1), dt.date(2026, 10, 31)), (dt.date(2026, 11, 1), dt.date(2026, 11, 1))]


def test_season_starts_october_first():
    assert season_start(dt.date(2026, 11, 1)) == dt.date(2026, 10, 1)
    assert season_start(dt.date(2027, 3, 1)) == dt.date(2026, 10, 1)
