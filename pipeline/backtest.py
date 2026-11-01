"""Walk-forward backtest of the raw models and the blends against observed SWE gain.

Scores, per lead day, month and season:
  each raw model    archived QPF as is (seamless copies of another model dropped)
  equal             equal-weight mean of the raw models
  default           the app's heuristic blend (port of defaultWeight in app/src/forecast/blend.ts)
  tuned             the SNOTEL-tuned blend (port of skillModel in app/src/forecast/skill.ts)

The tuned blend is scored walk-forward: every month is predicted with bias and
weights fit (bias.fit) only on pairs dated before the first of that month, so
no observation it is scored against was used to tune it.

Days are those bias.load_pairs keeps (snow season, cold, wet by the obs or any
model). Metrics are in SWE inches: MAE, mean bias (forecast - obs), and for
days with at least EVENT_IN of SWE the hit rate (POD) and false-alarm ratio.

Like bias.py, weights are fit on every observation network (SNOTEL and, once
fetched, CoCoRaHS), and each network is scored separately.

Writes data/backtest.json; verify.py folds it into app/public/data/verification.json.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

import bias
from common import DATA, MODELS

VERSION = 1
MM_PER_IN = 25.4
EVENT_IN = 0.5
MIN_CELL_N = 100  # skill.ts MIN_CELL_N: a cell is used only if every model has this many days
MAX_LEAD_DAY = 7
BLENDS = ["tuned", "default", "equal"]
MONTHLY_LEADS = (1, 2, 3)
BACKTEST_JSON = DATA / "backtest.json"  # intermediate; verify.py publishes it


# --- ports of the app's weighting -------------------------------------------------------------

def default_weight(model: str, lead_h: float) -> float:
    """blend.ts defaultWeight."""
    h = max(0.0, lead_h)
    if model == "ncep_hrrr_conus":
        return 3 if h <= 18 else 2 if h <= 48 else 0
    if model == "ncep_nam_conus":
        return 1.5 if h <= 36 else 1 if h <= 60 else 0
    if model == "ecmwf_ifs025":
        return 2 if h <= 72 else 2.5
    if model == "gfs_seamless":
        return 0 if h <= 24 else 1.2
    if model in ("gem_seamless", "icon_seamless"):
        return 1
    if model == "nws":
        return 1.5 if h <= 168 else 0
    return 0


def default_day_weight(model: str, lead_day: int) -> float:
    """defaultWeight averaged over the hours of a lead day (the archive is daily totals)."""
    hours = range((lead_day - 1) * 24 + 1, lead_day * 24 + 1)
    return float(np.mean([default_weight(model, h) for h in hours]))


def pick_cell(doc: dict, region: str, band: str, lead: int, min_cell_n: int = MIN_CELL_N) -> dict | None:
    """skillModel's cell choice: the most specific cell where every model has enough days."""
    w = doc.get("weights", {})
    for r, b in ((region, band), (region, "ALL"), ("ALL", band), ("ALL", "ALL")):
        c = w.get(r, {}).get(b, {}).get(str(min(lead, MAX_LEAD_DAY)))
        if c and all(s["n"] >= min_cell_n for s in c.values()):
            return c
    return None


def tuned_params(doc: dict, region: str, band: str, lead: int, models: list[str], min_cell_n: int = MIN_CELL_N) -> dict[str, tuple[float, float]]:
    """skillModel: (weight, bias) per model for one region x band x lead day."""
    aliases = doc.get("aliases", {})
    cell = pick_cell(doc, region, band, lead, min_cell_n)
    mass = sum(default_day_weight(m, lead) for m in cell) if cell else 0.0
    out = {}
    for m in models:
        base = default_day_weight(m, lead)
        if str(min(lead, MAX_LEAD_DAY)) in aliases.get(m, {}):
            out[m] = (0.0, 1.0)
            continue
        s = cell.get(m) if cell else None
        if not s or base <= 0:
            out[m] = (base, 1.0)
            continue
        out[m] = (s["weight"] * mass, s["bias"] if s["mae"] <= s["maeRaw"] else 1.0)
    return out


# --- data ---------------------------------------------------------------------------------------

def forecast_wide() -> pd.DataFrame:
    """The forecasts bias.py fits on (historical lead 1 only where it passed), one column per model."""
    fc, overlap = bias.load_forecasts()
    fc = bias.select_forecasts(fc, bias.compare_sources(fc, overlap, bias.load_obs(fc)))
    # Prefer the lead-day archive where a historical row covers the same key.
    fc = fc.sort_values("source", key=lambda s: s != "previous_runs")
    wide = fc.pivot_table(index=["site", "date", "lead_day"], columns="model", values="precip_mm", aggfunc="first")
    wide.columns.name = None
    return wide


def score_days(pairs: pd.DataFrame, wide: pd.DataFrame) -> pd.DataFrame:
    """One row per site/date/lead_day with the obs and every model's forecast.

    load_pairs keeps a model row when the obs or that model is wet, so its keys are the days wet
    by the obs or any model; the dry models' values come back from the full archive.
    """
    keys = pairs[["site", "date", "lead_day", "region", "band", "obs_mm"]].drop_duplicates(["site", "date", "lead_day"])
    return keys.merge(wide.reset_index(), on=["site", "date", "lead_day"], how="left").reset_index(drop=True)


# --- predictions --------------------------------------------------------------------------------

def blend_rows(df: pd.DataFrame, params_for) -> pd.Series:
    """Weighted mean of bias-corrected model precip; params_for(region, band, lead) -> {model: (w, b)}."""
    models = [m for m in MODELS if m in df]
    out = pd.Series(np.nan, index=df.index)
    for (region, band, lead), g in df.groupby(["region", "band", "lead_day"]):
        p = params_for(region, band, int(lead))
        num = np.zeros(len(g))
        den = np.zeros(len(g))
        for m in models:
            w, b = p.get(m, (0.0, 1.0))
            if w <= 0:
                continue
            v = g[m].to_numpy(dtype=float)
            ok = ~np.isnan(v)
            num[ok] += w * b * v[ok]
            den[ok] += w
        out.loc[g.index] = np.where(den > 0, num / np.where(den > 0, den, 1), np.nan)
    return out


def mask_aliases(df: pd.DataFrame, aliases: dict) -> pd.DataFrame:
    """Null out seamless series that copy another model at that lead, so nothing counts twice."""
    df = df.copy()
    for m, leads in aliases.items():
        if m in df:
            df.loc[df.lead_day.astype(str).isin(leads), m] = np.nan
    return df


def month_start(d: pd.Series) -> pd.Series:
    return d.dt.to_period("M").dt.to_timestamp()


def walk_forward_docs(pairs: pd.DataFrame, months: list[pd.Timestamp]) -> dict[pd.Timestamp, dict]:
    """Fit bias/weights for each month using only pairs dated before it."""
    docs = {}
    for m in months:
        train = pairs[pairs.date < m]
        if train.empty:
            docs[m] = {"weights": {}, "aliases": {}, "trainDays": 0}
            continue
        aliases = bias.find_aliases(train)
        docs[m] = {"weights": bias.fit(bias.drop_aliases(train, aliases)), "aliases": aliases, "trainDays": int(len(train))}
    return docs


def predict(df: pd.DataFrame, docs: dict[pd.Timestamp, dict], aliases: dict, min_cell_n: int = MIN_CELL_N) -> pd.DataFrame:
    """Adds equal, default and walk-forward tuned predictions (mm) to the scoring frame."""
    df = mask_aliases(df, aliases)
    models = [m for m in MODELS if m in df]
    df["equal"] = df[models].mean(axis=1)
    df["default"] = blend_rows(df, lambda r, b, lead: {m: (default_day_weight(m, lead), 1.0) for m in models})
    df["tuned"] = np.nan
    df["tuned_cell"] = False
    ms = month_start(df.date)
    for m, g in df.groupby(ms):
        doc = docs[m]
        df.loc[g.index, "tuned"] = blend_rows(g, lambda r, b, lead, doc=doc: tuned_params(doc, r, b, lead, models, min_cell_n))
        for (r, b, lead), gg in g.groupby(["region", "band", "lead_day"]):
            df.loc[gg.index, "tuned_cell"] = pick_cell(doc, r, b, int(lead), min_cell_n) is not None
    return df


# --- metrics ------------------------------------------------------------------------------------

def metrics(fc_mm: np.ndarray, obs_mm: np.ndarray) -> dict | None:
    ok = ~np.isnan(fc_mm) & ~np.isnan(obs_mm)
    if not ok.any():
        return None
    f = fc_mm[ok] / MM_PER_IN
    o = obs_mm[ok] / MM_PER_IN
    ev_o = o >= EVENT_IN
    ev_f = f >= EVENT_IN
    return {
        "n": int(ok.sum()),
        "mae": round(float(np.abs(f - o).mean()), 3),
        "bias": round(float((f - o).mean()), 3),
        "events": int(ev_o.sum()),
        "hitRate": round(float((ev_f & ev_o).sum() / ev_o.sum()), 3) if ev_o.any() else None,
        "falseAlarm": round(float((ev_f & ~ev_o).sum() / ev_f.sum()), 3) if ev_f.any() else None,
    }


def season_of(d: pd.Timestamp) -> str:
    y = d.year if d.month >= 7 else d.year - 1
    return f"{y}-{(y + 1) % 100:02d}"


def summarize(df: pd.DataFrame, methods: list[str]) -> dict:
    obs = df.obs_mm.to_numpy(dtype=float)

    def table(mask: np.ndarray) -> dict:
        out = {}
        for m in methods:
            s = metrics(np.where(mask, df[m].to_numpy(dtype=float), np.nan), obs)
            if s:
                out[m] = s
        return out

    by_lead = {str(int(lead)): table((df.lead_day == lead).to_numpy()) for lead in sorted(df.lead_day.unique())}
    short = df.lead_day.isin(MONTHLY_LEADS).to_numpy()
    ms = month_start(df.date)
    monthly = []
    for m in sorted(ms.unique()):
        t = table(short & (ms == m).to_numpy())
        if t:
            sel = short & (ms == m).to_numpy()
            monthly.append({"month": m.strftime("%Y-%m"), "n": max(s["n"] for s in t.values()),
                            # Share of days where the tuned blend had a trusted cell (else it equals default).
                            "tunedActive": round(float(df.tuned_cell[sel].mean()), 2),
                            "mae": {k: s["mae"] for k, s in t.items()}, "bias": {k: s["bias"] for k, s in t.items()}})
    seasons = df.date.map(season_of)
    by_season = {s: table((seasons == s).to_numpy()) for s in sorted(seasons.unique())}

    # Each method against the tuned blend on exactly the days both forecast, so models that only
    # cover some lead days (HRRR: day 1) are compared fairly.
    tuned = df.tuned.to_numpy(dtype=float)
    leaderboard = []
    for m in methods:
        v = df[m].to_numpy(dtype=float)
        both = ~np.isnan(v) & ~np.isnan(tuned)
        s = metrics(np.where(both, v, np.nan), obs)
        t = metrics(np.where(both, tuned, np.nan), obs)
        if not s:
            continue
        leads = sorted(int(x) for x in df.lead_day[both].unique())
        leaderboard.append({"method": m, **s, "tunedMae": t["mae"], "skillVsTuned": round(1 - t["mae"] / s["mae"], 3) if s["mae"] else None, "leads": leads})
    # Best first: a method the tuned blend beats by more ranks lower.
    leaderboard.sort(key=lambda r: r["skillVsTuned"] or 0)
    return {
        "n": int(len(df)),
        "sites": int(df.site.nunique()),
        "dateRange": [df.date.min().date().isoformat(), df.date.max().date().isoformat()],
        "tunedActive": round(float(df.tuned_cell.mean()), 3),
        "leaderboard": leaderboard,
        "byLead": by_lead,
        "monthly": monthly,
        "bySeason": by_season,
    }


def run(min_cell_n: int = MIN_CELL_N) -> dict:
    pairs = bias.load_pairs(sources=bias.OBS_SOURCES)
    if pairs.empty:
        bias.explain_empty()
        raise SystemExit("no overlapping forecast/observation pairs")
    wide = forecast_wide()
    aliases = bias.find_aliases(pairs)
    frames = {src: score_days(g, wide) for src, g in pairs.groupby("obs_source")}
    months = sorted(set().union(*(set(month_start(f.date)) for f in frames.values())))
    docs = walk_forward_docs(pairs, months)
    primary = "snotel" if "snotel" in frames else next(iter(frames))
    models = [m for m in MODELS if any(m in f and f[m].notna().any() for f in frames.values())]
    methods = BLENDS + models
    sources = {name: summarize(predict(f, docs, aliases, min_cell_n), [m for m in methods if m in f or m in BLENDS]) for name, f in frames.items()}
    return {
        "version": VERSION,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "primary": primary,
        "sources": sources,
        "meta": {
            "units": "SWE inches",
            "eventIn": EVENT_IN,
            "monthlyLeads": list(MONTHLY_LEADS),
            "minCellN": min_cell_n,
            "walkForward": "each month scored with bias/weights fit (on every network, as bias.py does) only on pairs dated before it",
            "seasonMonths": sorted(bias.SEASON_MONTHS),
            "maxTavgF": bias.MAX_TAVG_F,
            "wetThresholdIn": round(bias.WET_MM / MM_PER_IN, 2),
            "aliases": aliases,
            "models": models,
            "trainDaysByMonth": {m.strftime("%Y-%m"): d["trainDays"] for m, d in docs.items()},
        },
    }


def print_summary(doc: dict) -> None:
    for name, s in doc["sources"].items():
        print(f"\n[{name}] {s['n']:,} scored forecast-days, {s['sites']} sites, {s['dateRange'][0]} .. {s['dateRange'][1]}")
        print(f"{'method':18} {'leads':>8} {'n':>6} {'MAE in':>7} {'tuned':>7} {'skill':>6} {'bias':>7} {'POD':>5} {'FAR':>5}")
        for r in s["leaderboard"]:
            leads = f"{r['leads'][0]}-{r['leads'][-1]}" if len(r["leads"]) > 1 else str(r["leads"][0])
            fmt = lambda v: "  -  " if v is None else f"{v:5.2f}"  # noqa: E731
            print(f"{r['method']:18} {leads:>8} {r['n']:6d} {r['mae']:7.3f} {r['tunedMae']:7.3f} {r['skillVsTuned']:+6.1%} {r['bias']:+7.3f} {fmt(r['hitRate'])} {fmt(r['falseAlarm'])}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(BACKTEST_JSON))
    ap.add_argument("--min-cell-n", type=int, default=MIN_CELL_N, help="cell trust threshold (the app uses %(default)s)")
    args = ap.parse_args()
    doc = run(args.min_cell_n)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
    print_summary(doc)


if __name__ == "__main__":
    main()
