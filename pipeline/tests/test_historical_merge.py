import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_forecasts  # noqa: E402
from bias import compare_sources, select_forecasts  # noqa: E402
from fetch_forecasts import Fetcher, StopFetching, parse_historical, run_jobs, split_overlap, tidy  # noqa: E402

DAYS = pd.date_range("2024-12-01", periods=80)


def rows(source, precip, model="icon_seamless", lead=1, dates=DAYS, site="303"):
    return pd.DataFrame(
        {"site": site, "date": dates, "model": model, "lead_day": lead, "precip_mm": precip, "source": source, "n_hours": 24, "tavg_c": -5.0, "snowfall_cm": 0.0}
    )


@pytest.fixture
def obs():
    rng = np.random.default_rng(0)
    return pd.DataFrame({"site": "303", "date": DAYS, "obs_mm": rng.gamma(1.5, 4.0, len(DAYS)), "obs_source": "snotel"})


def noisy(obs, scale=0.8):
    rng = np.random.default_rng(1)
    return np.clip(obs.obs_mm.values * scale + rng.normal(0, 3, len(obs)), 0, None)


def test_close_sources_are_merged(obs):
    prev = noisy(obs)
    fc = rows("previous_runs", prev)
    overlap = rows("historical", prev * 1.03)
    cmp = compare_sources(fc, overlap, obs)
    assert cmp.set_index("model").loc["icon_seamless", "merge"]
    assert cmp.n.iloc[0] > 40


def test_different_bias_keeps_historical_out(obs):
    prev = noisy(obs)
    fc = rows("previous_runs", prev)
    overlap = rows("historical", prev * 1.4)
    cmp = compare_sources(fc, overlap, obs)
    assert not cmp["merge"].any()
    old = rows("historical", np.ones(10), dates=pd.date_range("2022-12-01", periods=10))
    kept = select_forecasts(pd.concat([fc, old]), cmp)
    assert set(kept.source) == {"previous_runs"}


def test_too_few_overlap_days_is_not_merged(obs):
    prev = noisy(obs)
    fc = rows("previous_runs", prev)
    overlap = rows("historical", prev).iloc[:20]
    assert not compare_sources(fc, overlap, obs)["merge"].any()


def test_merge_is_per_model(obs):
    prev = noisy(obs)
    fc = pd.concat([rows("previous_runs", prev), rows("previous_runs", prev, model="gem_seamless")])
    overlap = pd.concat([rows("historical", prev), rows("historical", prev * 2, model="gem_seamless")])
    cmp = compare_sources(fc, overlap, obs).set_index("model")["merge"]
    assert cmp.to_dict() == {"gem_seamless": False, "icon_seamless": True}
    old = pd.concat([rows("historical", np.ones(5), dates=pd.date_range("2022-12-01", periods=5), model=m) for m in ("gem_seamless", "icon_seamless")])
    kept = select_forecasts(pd.concat([fc, old]), cmp.reset_index())
    assert set(kept[kept.source == "historical"].model) == {"icon_seamless"}


def test_overlap_rows_leave_the_main_table_unique():
    pre = rows("historical", np.ones(5), dates=pd.date_range("2023-12-28", periods=5))  # straddles 2024-01-01
    post = rows("previous_runs", np.ones(3), dates=pd.date_range("2024-01-01", periods=3))
    main, overlap = split_overlap(tidy(pd.concat([pre, post])))
    assert overlap.date.min() >= pd.Timestamp("2024-01-01") and set(overlap.source) == {"historical"}
    assert not main.duplicated(["site", "date", "model", "lead_day"]).any()
    assert set(main[main.source == "historical"].date) == set(pd.date_range("2023-12-28", periods=4))


def test_parse_historical_is_lead_one():
    hours = pd.date_range("2022-12-01", periods=48, freq="h")
    hourly = {"time": [h.strftime("%Y-%m-%dT%H:%M") for h in hours]}
    hourly["precipitation_ncep_hrrr_conus"] = [0.5] * 48
    hourly["snowfall_ncep_hrrr_conus"] = [0.3] * 48
    hourly["temperature_2m_ncep_hrrr_conus"] = [-3.0] * 48
    hourly["precipitation_gem_seamless"] = [None] * 48  # not archived yet: dropped
    out = parse_historical({"hourly": hourly}, "303")
    assert out.model.unique().tolist() == ["ncep_hrrr_conus"]
    assert out.lead_day.unique().tolist() == [1] and out.source.unique().tolist() == ["historical"]
    assert out.precip_mm.tolist() == pytest.approx([12.0, 12.0])


class Station:
    def __init__(self, site):
        self.site, self.latitude, self.longitude, self.elev_m, self.day_start_h = site, 40.0, -105.0, 3000.0, 0


def test_previous_runs_have_priority_and_stop_keeps_cache(monkeypatch):
    calls = []

    def fake_load_or_fetch(fetcher, st, a, b, today, source):
        weight = 28 if source == "previous_runs" else 3
        if fetcher.spent + weight > fetcher.budget:
            raise StopFetching(f"budget of {fetcher.budget:.0f} calls used")
        fetcher.spent += weight
        calls.append(source)
        return {"hourly": {}}

    cached = {("historical", "old")}
    monkeypatch.setattr(fetch_forecasts, "load_or_fetch", fake_load_or_fetch)
    monkeypatch.setattr(fetch_forecasts, "load_cached", lambda site, month, source: {"hourly": {}} if (source, site) in cached else None)
    a, b = dt.date(2024, 12, 1), dt.date(2024, 12, 31)
    prev_jobs = [("previous_runs", Station(s), a, b) for s in ("x", "y")]
    hist_jobs = [("historical", Station(s), a, b) for s in ("new", "old")]

    f = Fetcher(budget=60)
    frames, stopped = run_jobs(f, prev_jobs, dt.date(2026, 11, 1))
    assert stopped is None and calls == ["previous_runs", "previous_runs"]
    hist, stopped = run_jobs(f, hist_jobs, dt.date(2026, 11, 1), stopped)
    # 56 spent: one 3-call historical month fits, then the budget stops downloads and "old" comes from cache
    assert calls == ["previous_runs", "previous_runs", "historical"]
    assert "budget" in stopped and len(hist) == 2

    calls.clear()
    f = Fetcher(budget=30)
    frames, stopped = run_jobs(f, prev_jobs, dt.date(2026, 11, 1))
    assert "budget" in stopped and calls == ["previous_runs"]
    hist, stopped = run_jobs(f, hist_jobs, dt.date(2026, 11, 1), stopped)
    # no historical downloads once previous runs used the budget, but cached months still load
    assert calls == ["previous_runs"] and len(hist) == 1
