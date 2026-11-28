import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recent_obs import (  # noqa: E402
    backed_hours, calendar_months, calibrate, day_totals, match_stations, parse_locations, recent_new_snow,
    resort_groups, season_start, snow_rises, station_pool, station_snow, storm_increments, storm_spans,
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


def daily(**vals):
    return pd.Series(list(vals.values()), index=[k.replace("_", "-")[1:] for k in vals])


def daily_from(days, vals):
    return pd.Series([float(v) for v in vals], index=days)


def test_calibrate_switches_only_when_another_station_clearly_matches():
    # Three storms the resort reported: 6" on Nov 1, 4" on Nov 5 and 3" on Nov 9.
    days = [f"2026-11-{d:02d}" for d in range(1, 11)]
    resort = dict(zip(days, [6.0, 0, 0, 0, 4.0, 0, 0, 0, 3.0, 0]))
    far = daily_from(days, [11.0, 8.0, 0, 0, 9.0, 0, 0, 0, 7.0, 0])  # 35" vs 13" reported
    close = daily_from(days, [5.0, 0, 0, 0, 4.0, 0, 0, 0, 3.0, 0])
    so_so = daily_from(days, [7.5, 0, 0, 0, 4.0, 0, 0, 0, 3.0, 0])
    chosen, stats, diag = calibrate("red", {"red": far, "idarado": close}, resort)
    assert chosen == "idarado"
    assert stats == {"reportedIn": 13.0, "stationIn": 12.0, "days": 10, "storms": 3, "errIn": 1.0}
    assert [d["id"] for d in diag] == ["idarado", "red"] and diag[1]["errIn"] == 22.0
    # The incumbent stays when it agrees, and when the alternative is only a little better.
    assert calibrate("idarado", {"idarado": close, "red": far}, resort)[0] == "idarado"
    assert calibrate("so-so", {"so-so": so_so, "idarado": close}, resort)[0] == "so-so"
    # Not enough reported snow, or under three storms: no verdict at all.
    assert calibrate("red", {"red": far, "idarado": close}, {"2026-11-01": 2.0})[:2] == ("red", None)
    two = {d: v for d, v in resort.items() if d < "2026-11-08"}
    assert calibrate("red", {"red": far, "idarado": close}, two)[:2] == ("red", None)
    # An incumbent with no data over the reports loses to one that has it.
    assert calibrate("red", {"red": pd.Series(dtype=float), "idarado": close}, resort)[0] == "idarado"


def test_calibrate_breaks_near_ties_toward_the_incumbent_then_the_closer_station():
    days = [f"2026-11-{d:02d}" for d in range(1, 11)]
    resort = dict(zip(days, [6.0, 0, 0, 0, 4.0, 0, 0, 0, 3.0, 0]))
    bad = daily_from(days, [1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0, 0])  # 10" off
    near = daily_from(days, [5.0, 0, 0, 0, 3.5, 0, 0, 0, 3.0, 0])  # 1.5" off
    far = daily_from(days, [6.0, 0, 0, 0, 4.0, 0, 0, 0, 2.5, 0])  # 0.5" off, but within the tie
    assert calibrate("bad", {"bad": bad, "near": near, "far": far}, resort)[0] == "near"


def test_calibrate_charges_snow_the_resort_never_reported():
    # Matches the storms, but also logs 8" over a week the resort reported nothing (Ski Cooper's
    # Ivanhoe pick read 22" to the resort's 5"); the old event-window check never saw those days.
    days = [f"2026-11-{d:02d}" for d in range(1, 21)]
    resort = dict(zip(days, [0, 5.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4.0, 0, 0, 0, 0, 3.0, 0, 0, 0]))
    noisy = daily_from(days, [0, 5.0, 0, 0, 3.0, 0, 0, 5.0, 0, 0, 0, 4.0, 0, 0, 0, 0, 3.0, 0, 0, 0])
    honest = daily_from(days, [0, 4.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3.0, 0, 0, 0, 0, 3.0, 0, 0, 0])
    chosen, stats, _ = calibrate("noisy", {"noisy": noisy, "honest": honest}, resort)
    assert chosen == "honest" and stats["errIn"] == 2.0


def test_calibrate_ignores_days_before_the_resort_measured():
    # Closed resorts often post zeros without measuring: before `since` they don't count.
    days = [f"2026-11-{d:02d}" for d in range(1, 18)]
    resort = dict(zip(days, [0, 0, 0, 0, 0, 0, 0, 0, 5.0, 0, 0, 4.0, 0, 0, 3.0, 0, 0]))
    station = daily_from(days, [0, 9.0, 0, 0, 0, 0, 0, 0, 5.0, 0, 0, 4.0, 0, 0, 3.0, 0, 0])
    other = daily_from(days, [0, 0, 0, 0, 0, 0, 0, 0, 4.0, 0, 0, 3.5, 0, 0, 2.5, 0, 0])
    assert calibrate("station", {"station": station, "other": other}, resort)[0] == "other"
    chosen, stats, _ = calibrate("station", {"station": station, "other": other}, resort, since="2026-11-08")
    assert chosen == "station" and stats["errIn"] == 0.0 and stats["days"] == 10


def test_measured_from_is_opening_day_or_first_snow_report():
    from recent_obs import measured_from
    # Winter Park reported its 4" storm on Nov 2 while closed; it opened Nov 13.
    assert measured_from({"openingDate": "2026-11-13", "days": {"2026-11-01": 0.0, "2026-11-02": 4.0}}) == "2026-11-02"
    # Copper posted zeros until it opened.
    assert measured_from({"openingDate": "2026-11-13", "days": {"2026-11-02": 0.0, "2026-11-14": 3.0}}) == "2026-11-13"
    assert measured_from({"days": {"2026-11-02": 0.0}}) is None
    assert measured_from({"days": {"2026-11-05": 2.0}}) == "2026-11-05"


def test_resorts_without_a_nearby_snotel_reach_further_before_settling_for_a_valley_gauge():
    c = cands(
        ("snotel", "far", "Far", 39.18, -106.0, 11000),  # ~20 km
        ("cocorahs", "valley", "Valley", 39.03, -106.0, 8800),  # ~3 km, in range
        ("snotel", "pass", "Pass", 39.19, -106.0, 11000),  # ~21 km
    )
    m = match_stations(locs(("r", "R", "resort", 39.0, -106.0, 9700, 12400), ("t", "T", "town", 39.0, -106.0, 8800, 8800)), c)
    assert m["r"]["id"] == "far" and m["t"]["id"] == "valley"
    # With a SNOTEL inside 15 km, a better-matched elevation further out doesn't win.
    c2 = cands(("snotel", "near", "Near", 39.07, -106.0, 12500), ("snotel", "far", "Far", 39.19, -106.0, 11050))
    assert match_stations(locs(("r", "R", "resort", 39.0, -106.0, 9700, 12400)), c2)["r"]["id"] == "near"


def test_storm_spans_merge_pad_and_union_sources():
    days = [f"2026-11-{d:02d}" for d in range(1, 13)]
    a = {"2026-11-03": 4.0, "2026-11-05": 2.0, "2026-11-10": 0.5}
    b = {"2026-11-10": 3.0}
    assert storm_spans(days, a) == [["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]]
    assert storm_spans(days, a, b)[1] == ["2026-11-09", "2026-11-10", "2026-11-11"]
    assert storm_spans(["2026-11-01"], {"2026-11-01": 2.0}) == [["2026-11-01"]]


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


GOLDEN = Path(__file__).parent / "fixtures" / "snow-rises.json"


def golden_series(start, vals):
    if vals is None:
        return None
    return pd.Series([np.nan if v is None else float(v) for v in vals], index=pd.date_range(start, periods=len(vals), freq="h"))


def test_snow_rises_match_the_shared_cases():
    """The same cases app/src/recent.test.ts runs, so the live windows and the daily file agree."""
    import json
    doc = json.loads(GOLDEN.read_text())
    t0 = pd.Timestamp(doc["start"])
    for case in doc["cases"]:
        series = {el: golden_series(t0, case.get(k)) for el, k in (("SNWD", "depth"), ("PREC", "prec"), ("WTEQ", "swe"), ("TOBS", "temp"))}
        inc, pending = station_snow({k: v for k, v in series.items() if v is not None})
        got = [[int((t - t0) / pd.Timedelta(hours=1)), round(float(v), 2)] for t, v in inc.items() if v != 0]
        assert got == case["increments"], case["name"]
        assert (None if pending is None else [int((pending[0] - t0) / pd.Timedelta(hours=1)), round(pending[1], 2)]) == case["pending"], case["name"]


def test_backed_hours_need_water_and_cold():
    idx = pd.date_range("2026-11-27", periods=8, freq="h")
    wet = series([2.0, 2.0, 2.0, 2.1, 2.1, 2.1, 2.1, 2.1], "2026-11-27 00:00")
    cold = series([28.0] * 8, "2026-11-27 00:00")
    warm = series([39.0] * 8, "2026-11-27 00:00")
    # Smoothed like the depth, so the gauge has to hold its gain a reading before it counts.
    assert backed_hours(idx, prec=wet, temp=cold).tolist() == [False, False, False, True, True, True, True, True]
    assert not backed_hours(idx, prec=wet, temp=warm).any()
    # Six hours later the gain has aged out of the lookback.
    late = pd.date_range("2026-11-27 12:00", periods=2, freq="h")
    assert not backed_hours(late, prec=wet, temp=cold).any()
    assert not backed_hours(idx).any()


def test_recent_new_snow_includes_a_backed_rise_in_progress():
    inc = storm_increments(series(np.full(30, 4.0)))
    end = inc.index.max()
    assert recent_new_snow(inc, 24, end) == 0.0
    assert recent_new_snow(inc, 24, end, pending=(end - pd.Timedelta(hours=1), 1.5)) == 1.5
    assert recent_new_snow(inc, 24, end, pending=(end - pd.Timedelta(hours=30), 1.5)) == 0.0


def test_resorts_sharing_a_report_form_one_group():
    groups = resort_groups({"aspen-mtn": "aspen-snowmass", "snowmass": "aspen-snowmass", "vail": "vail", "buttermilk": "aspen-snowmass"})
    assert groups == [["aspen-mtn", "buttermilk", "snowmass"], ["vail"]]


def test_previous_stations_from_a_file_built_another_way_keep_only_snotel(tmp_path):
    import json
    from recent_obs import ACTUAL_VERSION, load_previous_stations
    st = {"type": "snotel", "id": "1186:CO:SNTL", "name": "Fool Creek SNOTEL"}
    gauge = {"type": "cocorahs", "id": "CO-PT-23", "name": "Woody Creek 1.4 SE"}
    f = tmp_path / "past.json"
    f.write_text(json.dumps({"actualVersion": ACTUAL_VERSION, "locations": {"winter-park": {"station": st}, "snowmass": {"station": gauge}, "frisco": {"station": None}}}))
    assert load_previous_stations(f) == {"winter-park": st, "snowmass": gauge}
    f.write_text(json.dumps({"locations": {"winter-park": {"station": st}, "snowmass": {"station": gauge}}}))  # built before sources were recorded
    assert load_previous_stations(f) == {"winter-park": st}
    assert load_previous_stations(tmp_path / "missing.json") == {}
