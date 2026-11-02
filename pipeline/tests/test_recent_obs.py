import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recent_obs import calendar_months, depth_gain, match_stations, parse_locations, season_start  # noqa: E402


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


def test_depth_gain_is_smoothed_and_clipped():
    idx = pd.date_range("2026-11-01 00:00", periods=60, freq="h")
    # 8" of new snow arrives 20 hours before the last reading.
    s = pd.Series(np.r_[np.full(40, 10.0), np.full(20, 18.0)], index=idx)
    s.iloc[-1] = 40.0  # one-hour sensor spike, damped by the 3-hour median
    assert depth_gain(s, 24) == 8.0
    assert depth_gain(pd.Series(np.linspace(20, 15, 60), index=idx), 24) == 0.0
    assert depth_gain(s.iloc[-5:], 24) is None


def test_calendar_months_cover_every_month():
    months = calendar_months(dt.date(2026, 9, 2), dt.date(2026, 11, 1))
    assert months == [(dt.date(2026, 9, 2), dt.date(2026, 9, 30)), (dt.date(2026, 10, 1), dt.date(2026, 10, 31)), (dt.date(2026, 11, 1), dt.date(2026, 11, 1))]


def test_season_starts_october_first():
    assert season_start(dt.date(2026, 11, 1)) == dt.date(2026, 10, 1)
    assert season_start(dt.date(2027, 3, 1)) == dt.date(2026, 10, 1)
