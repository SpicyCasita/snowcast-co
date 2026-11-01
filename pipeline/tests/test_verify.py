import json
import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backtest  # noqa: E402
import verify  # noqa: E402

# 2026-01-10 00:00 PST = 08:00 UTC
START = int(pd.Timestamp("2026-01-10 08:00", tz="UTC").timestamp())


def record(site="303", run="2026-01-10T08:05Z", start=START, swe=0.6, chance=0.7, cov=1.0):
    return {
        "v": 1, "run": run, "id": f"snotel:{site}", "src": "snotel", "site": site, "start": start,
        "w": {"24": {"expected": 6.0, "low": 3.0, "high": 9.0, "confidence": 0.6, "bucket": [6, 12], "chance": {"1": 0.95, "6": chance}}},
        "d": [
            {"date": "2026-01-10", "lead": 1, "cov": cov, "swe": {"tuned": swe, "default": swe + 0.2, "m": {"ecmwf_ifs025": swe - 0.1}}, "snow": 6.0},
            {"date": "2026-01-11", "lead": 2, "cov": 1.0, "swe": {"tuned": 0.0, "default": 0.0, "m": {"ecmwf_ifs025": 0.0}}, "snow": 0.0},
        ],
    }


@pytest.fixture
def obs(tmp_path, monkeypatch):
    df = pd.DataFrame({
        "site": ["303", "303"], "date": pd.to_datetime(["2026-01-10", "2026-01-11"]),
        "dswe_in": [0.7, 0.0], "dsnwd_in": [8.0, -1.0], "tavg_f": [20.0, 22.0],
    })
    path = tmp_path / "snotel.parquet"
    df.to_parquet(path)
    monkeypatch.setattr(verify, "SNOTEL_PARQUET", path)
    monkeypatch.setattr(verify.bias, "COCORAHS_PARQUET", tmp_path / "missing.parquet")
    return verify.load_obs()


def test_window_alignment():
    assert verify.window_days(START, 24) == [pd.Timestamp("2026-01-10")]
    assert verify.window_days(START - 2 * 3600, 72)[0] == pd.Timestamp("2026-01-10")  # 22:00 PST the day before
    assert verify.window_days(START + 10 * 3600, 24) is None  # mid-morning runs don't match obs days
    # A CoCoRaHS day starting 06:00 PST lines up with a run at 06:00 PST, not one at midnight.
    assert verify.window_days(START + 6 * 3600, 24, day_start_h=6) == [pd.Timestamp("2026-01-10")]
    assert verify.window_days(START, 24, day_start_h=6) is None


def test_live_scores_and_dedupes(obs):
    recs = [record(), record(run="2026-01-10T15:00Z", swe=5.0), record(site="999")]
    live = verify.score_live(verify.live_days(recs), obs)
    # Only the first run for site 303 lead 1 counts; site 999 has no obs; day 2 is dry for everyone.
    assert live["n"] == 1
    assert live["overall"]["tuned"]["mae"] == pytest.approx(0.1, abs=1e-3)
    assert live["overall"]["default"]["mae"] == pytest.approx(0.1, abs=1e-3)
    assert live["overall"]["ecmwf_ifs025"]["mae"] == pytest.approx(0.2, abs=1e-3)


def test_partial_days_are_skipped(obs):
    live = verify.score_live(verify.live_days([record(cov=0.5)]), obs)
    assert live is None or live["n"] == 0


def test_calibration(obs):
    cal = verify.calibration([record()], obs)
    # 8" observed: >=1 and >=6 both happened; bucket 6-12 hit; inside 3-9.
    assert cal["chance"]["n"] == 2
    assert {b["freq"] for b in cal["chance"]["bins"]} == {1.0}
    assert cal["confidence"]["bins"][0]["freq"] == 1.0
    assert cal["range"]["inside"] == 1.0


def test_build_without_logs_keeps_backtest(tmp_path, obs, monkeypatch):
    bt = {"version": 1, "generated": "x", "primary": "snotel", "meta": {},
          "sources": {"snotel": {"n": 3, "sites": 1, "dateRange": ["a", "b"], "tunedActive": 1.0, "byLead": {}, "monthly": [], "bySeason": {},
                                 "leaderboard": [{"method": "tuned", "mae": 0.1, "skillVsTuned": 0.0, "tunedMae": 0.1},
                                                 {"method": "default", "mae": 0.12, "skillVsTuned": 0.167, "tunedMae": 0.1},
                                                 {"method": "ecmwf_ifs025", "mae": 0.11, "skillVsTuned": 0.09, "tunedMae": 0.1}]}}}
    bt_path = tmp_path / "backtest.json"
    bt_path.write_text(json.dumps(bt))
    doc = verify.build(app_data=tmp_path, backtest_json=bt_path)
    assert doc["version"] == 1 and doc["generated"]
    assert doc["summary"]["bestModel"] == "ecmwf_ifs025"
    assert doc["summary"]["vsDefault"] == 0.167
    assert doc["live"] is None and doc["calibration"] is None
    # Without a fresh backtest the previous file's tables carry over.
    again = verify.build(app_data=tmp_path, backtest_json=tmp_path / "none.json", previous=doc)
    assert again["leaderboard"] == doc["leaderboard"]
