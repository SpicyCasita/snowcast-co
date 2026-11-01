import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backtest  # noqa: E402
import bias  # noqa: E402

MODELS = ["ecmwf_ifs025", "gem_seamless", "ncep_hrrr_conus", "gfs_seamless"]


@pytest.fixture
def synthetic(tmp_path, monkeypatch):
    """Two sites, Nov 2024 - Mar 2025, every day wet-ish; ECMWF 30% low, GEM noisy, gfs = HRRR at lead 1."""
    rng = np.random.default_rng(0)
    dates = pd.date_range("2024-11-01", "2025-03-31", freq="D")
    sites = ["s1", "s2"]
    obs_rows, fc_rows = [], []
    for site in sites:
        swe = rng.gamma(1.5, 0.25, len(dates))  # inches
        for d, o in zip(dates, swe):
            obs_rows.append({"site": site, "date": d, "dswe_in": o, "tavg_f": 20.0})
            mm = o * 25.4
            for lead in (1, 2, 3):
                ec = mm * 0.7 + rng.normal(0, 1)
                gem = mm + rng.normal(0, 6)
                hrrr = mm + rng.normal(0, 2)
                vals = {"ecmwf_ifs025": ec, "gem_seamless": gem}
                if lead == 1:
                    vals["ncep_hrrr_conus"] = hrrr
                    vals["gfs_seamless"] = hrrr
                else:
                    vals["gfs_seamless"] = mm + rng.normal(0, 4)
                for m, v in vals.items():
                    fc_rows.append({"site": site, "date": d, "model": m, "lead_day": lead, "precip_mm": max(0.0, v), "tavg_c": -6.0})
    obs = pd.DataFrame(obs_rows)
    fc = pd.DataFrame(fc_rows)
    st = pd.DataFrame({"site": sites, "region": ["Central Mtns"] * 2, "band": ["9to11k", "gt11k"]})
    paths = {}
    for name, df in (("snotel", obs), ("forecasts", fc), ("stations", st)):
        paths[name] = tmp_path / f"{name}.parquet"
        df.to_parquet(paths[name])
    monkeypatch.setattr(bias, "SNOTEL_PARQUET", paths["snotel"])
    monkeypatch.setattr(bias, "FORECASTS_PARQUET", paths["forecasts"])
    monkeypatch.setattr(bias, "STATIONS_PARQUET", paths["stations"])
    monkeypatch.setattr(bias, "COCORAHS_PARQUET", tmp_path / "missing.parquet")
    return paths


def frames(min_cell_n=20, perturb_from=None):
    pairs = bias.load_pairs(sources=bias.OBS_SOURCES)
    if perturb_from is not None:
        # Wildly different "future": if any of it leaked into earlier fits, earlier months would change.
        late = pairs.date >= perturb_from
        pairs.loc[late, "obs_mm"] = pairs.loc[late, "obs_mm"] * 7 + 40
    wide = backtest.forecast_wide()
    aliases = bias.find_aliases(pairs)
    df = backtest.score_days(bias.load_pairs(), wide)
    months = sorted(set(backtest.month_start(df.date)))
    docs = backtest.walk_forward_docs(pairs, months)
    return backtest.predict(df, docs, aliases, min_cell_n), docs


def test_default_day_weights_match_blend_ts():
    assert backtest.default_day_weight("gfs_seamless", 1) == 0
    assert backtest.default_day_weight("gfs_seamless", 2) == pytest.approx(1.2)
    # HRRR: 3 for hours 1-18, 2 for 19-24.
    assert backtest.default_day_weight("ncep_hrrr_conus", 1) == pytest.approx((18 * 3 + 6 * 2) / 24)
    assert backtest.default_day_weight("ncep_hrrr_conus", 3) == 0
    assert backtest.default_day_weight("ecmwf_ifs025", 4) == pytest.approx(2.5)


def test_walk_forward_has_no_leakage(synthetic):
    base, docs = frames()
    cut = pd.Timestamp("2025-02-01")
    perturbed, _ = frames(perturb_from=cut)
    before = base.date < cut
    # Every month before the cut is predicted identically whatever happens afterwards...
    np.testing.assert_array_equal(base.tuned[before].to_numpy(), perturbed.tuned[before].to_numpy())
    # ...and the perturbation is real: months that may see it do change.
    after = base.date >= pd.Timestamp("2025-03-01")
    assert not np.allclose(base.tuned[after].to_numpy(), perturbed.tuned[after].to_numpy())
    # Each month's fit saw only earlier days.
    pairs = bias.load_pairs(sources=bias.OBS_SOURCES)
    for m, doc in docs.items():
        assert doc["trainDays"] == int((pairs.date < m).sum())


def test_first_month_falls_back_to_default(synthetic):
    df, docs = frames()
    nov = df.date < pd.Timestamp("2024-12-01")
    assert docs[pd.Timestamp("2024-11-01")]["trainDays"] == 0
    np.testing.assert_allclose(df.tuned[nov], df["default"][nov])
    assert not df.tuned_cell[nov].any()


def test_tuned_learns_the_low_bias(synthetic):
    df, _ = frames()
    late = df.date >= pd.Timestamp("2025-02-01")
    obs = df.obs_mm[late]
    # ECMWF is 30% low; the tuned blend corrects it and beats default once it has history.
    assert (df.tuned[late] - obs).abs().mean() < (df["default"][late] - obs).abs().mean()
    assert df.tuned_cell[late].all()


def test_gfs_copy_of_hrrr_is_not_counted(synthetic):
    df, _ = frames()
    assert df.loc[df.lead_day == 1, "gfs_seamless"].isna().all()
    assert df.loc[df.lead_day == 2, "gfs_seamless"].notna().all()


def test_metrics_events():
    fc = np.array([0.6, 0.6, 0.1, 0.0]) * 25.4
    obs = np.array([0.7, 0.1, 0.8, 0.0]) * 25.4
    m = backtest.metrics(fc, obs)
    assert m["n"] == 4 and m["events"] == 2
    assert m["hitRate"] == 0.5  # one of two observed events forecast
    assert m["falseAlarm"] == 0.5  # one of two forecast events didn't happen
    assert m["mae"] == pytest.approx((0.1 + 0.5 + 0.7 + 0) / 4, abs=1e-3)


def test_run_end_to_end(synthetic):
    doc = backtest.run(min_cell_n=20)
    s = doc["sources"]["snotel"]
    methods = {r["method"] for r in s["leaderboard"]}
    assert {"tuned", "default", "equal", "ecmwf_ifs025", "ncep_hrrr_conus"} <= methods
    assert [m["month"] for m in s["monthly"]] == ["2024-11", "2024-12", "2025-01", "2025-02", "2025-03"]
    assert set(s["byLead"]) == {"1", "2", "3"}
    assert "cocorahs" not in doc["sources"]


def test_cocorahs_is_a_second_source(synthetic, tmp_path, monkeypatch):
    obs = pd.read_parquet(synthetic["snotel"])
    # fetch_cocorahs.py output: one gauge per SNOTEL site's forecasts, obs_mm target, snow/dry kind.
    co = pd.DataFrame({"site": "g-" + obs.site, "date": obs.date, "obs_mm": obs.dswe_in * 25.4 * 1.1, "kind": "snow", "snow_in": obs.dswe_in * 12})
    path = tmp_path / "cocorahs.parquet"
    co.to_parquet(path)
    monkeypatch.setattr(bias, "COCORAHS_PARQUET", path)
    fc = pd.read_parquet(synthetic["forecasts"])
    pd.concat([fc, fc.assign(site="g-" + fc.site)]).to_parquet(synthetic["forecasts"])
    st = pd.read_parquet(synthetic["stations"])
    pd.concat([st.assign(source="snotel"), st.assign(site="g-" + st.site, source="cocorahs")]).to_parquet(synthetic["stations"])
    doc = backtest.run(min_cell_n=20)
    assert doc["primary"] == "snotel"
    assert doc["sources"]["cocorahs"]["n"] > 0
    assert doc["sources"]["snotel"]["sites"] == 2
