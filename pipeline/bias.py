"""Fit per-model QPF bias and skill weights against observed 24h SWE.

Observations come from two networks:
  snotel    24h SNOTEL SWE gain (mostly 9,000 ft and up)
  cocorahs  CoCoRaHS NewSnowSWE, else TotalPrecipAmt on snow days, 0 on dry
            days (towns, mostly below 9,000 ft); see fetch_cocorahs.py

For each model x region x elevation band x lead day:
  bias   multiplicative QPF correction (multiply model precip by this)
  mae    mean absolute error (mm SWE) of the bias-corrected forecast
  weight inverse-MAE^2 skill weight, normalised over the models in the cell
  n      wet days used (observed or forecast >= one SWE sensor step)

Sparse cells are shrunk toward the pooled model x lead estimate, and that
toward bias 1.0, so a handful of days can't produce extreme numbers. Pooled
fallbacks are emitted under region "ALL" and/or band "ALL".

Verification is limited to snow-season days (Nov-Apr). SNOTEL days need a
mean station temperature at or below 34F, where SWE gain is a fair proxy for
precipitation. CoCoRaHS has no temperature, so its snow days are used as
reported and its dry days only when the lead-1 model-mean temperature is at
or below 34F; rain days are left out.

Lead day 1 before 2024 comes from the Historical Forecast API
(source="historical"). It is merged with previous_day1 per model only if, on
the 2024-25 overlap season, its multiplicative bias is within
SOURCE_BIAS_TOL and its MAE within SOURCE_MAE_TOL of previous_day1 over at
least SOURCE_MIN_N matched wet days; otherwise it is left out of the fit.

The snow-to-liquid ratio (new snow depth / new snow SWE) observed by CoCoRaHS
is summarised by temperature band under the optional top-level "snowRatio".
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

from common import (
    BANDS,
    COCORAHS_PARQUET,
    FORECASTS_PARQUET,
    LEAD_DAYS,
    MODELS,
    REGIONS,
    SNOTEL_PARQUET,
    STATIONS_PARQUET,
    WEIGHTS_JSON,
    station_list,
)

VERSION = 1
OBS_SOURCES = ("snotel", "cocorahs")
SEASON_MONTHS = {11, 12, 1, 2, 3, 4}
MAX_TAVG_F = 34.0
WET_MM = 2.54  # SNOTEL SWE resolution is 0.1 in
BIAS_PRIOR_MM = 50.0  # pseudo-forecast mm pulling bias toward its parent
MAE_PRIOR_N = 30  # pseudo-days pulling MAE toward its parent
BIAS_CLAMP = (0.25, 4.0)
# historical lead 1 is merged with previous_day1 only when it behaves the same on the overlap
SOURCE_BIAS_TOL = 0.10
SOURCE_MAE_TOL = 0.15
SOURCE_MIN_N = 50
# snow-to-liquid ratio
SLR_TEMP_EDGES_F = [-np.inf, 15.0, 20.0, 25.0, 30.0, 34.0, np.inf]
SLR_MIN_SNOW_IN = 1.0
SLR_MIN_SWE_IN = 0.10
SLR_RANGE = (2.0, 50.0)


def c_to_f(c):
    return c * 9 / 5 + 32


def load_forecasts() -> tuple[pd.DataFrame, pd.DataFrame]:
    """forecasts.parquet and the historical overlap rows (empty if not fetched yet)."""
    fc = pd.read_parquet(FORECASTS_PARQUET)
    if "source" not in fc:
        fc["source"] = "previous_runs"
    # written next to forecasts.parquet by fetch_forecasts.py (common.OVERLAP_PARQUET)
    overlap_path = Path(FORECASTS_PARQUET).with_name("forecasts_overlap.parquet")
    overlap = pd.read_parquet(overlap_path) if overlap_path.exists() else fc.iloc[:0]
    return fc, overlap


def model_tavg_f(fc: pd.DataFrame) -> pd.Series:
    """Lead-1 model-mean 2 m temperature (F) per site x date, for stations without a thermometer."""
    l1 = fc[fc.lead_day == 1]
    return c_to_f(l1.groupby(["site", "date"]).tavg_c.mean()).rename("tavg_f")


def load_cocorahs() -> pd.DataFrame | None:
    return pd.read_parquet(COCORAHS_PARQUET) if COCORAHS_PARQUET.exists() else None


def load_obs(fc: pd.DataFrame, sources=OBS_SOURCES) -> pd.DataFrame:
    """Verification days from the given networks: site, date, obs_mm, obs_source."""
    sn = pd.read_parquet(SNOTEL_PARQUET, columns=["site", "date", "dswe_in", "tavg_f"])
    sn["obs_mm"] = sn.dswe_in.clip(lower=0) * 25.4
    sn = sn[(sn.tavg_f <= MAX_TAVG_F) & sn.obs_mm.notna()]
    frames = [sn.assign(obs_source="snotel")[["site", "date", "obs_mm", "obs_source"]]]
    co = load_cocorahs() if "cocorahs" in sources else None
    if co is not None and len(co):
        co = co.merge(model_tavg_f(fc).reset_index(), on=["site", "date"], how="left")
        keep = co.obs_mm.notna() & ((co.kind == "snow") | ((co.kind == "dry") & (co.tavg_f <= MAX_TAVG_F)))
        frames.append(co.loc[keep].assign(obs_source="cocorahs")[["site", "date", "obs_mm", "obs_source"]])
    obs = pd.concat(frames, ignore_index=True)
    obs["date"] = obs.date.astype("datetime64[us]")
    return obs[obs.date.dt.month.isin(SEASON_MONTHS)]


def is_wet(obs_mm: pd.Series, precip_mm: pd.Series) -> pd.Series:
    return (obs_mm >= WET_MM) | (precip_mm >= WET_MM)


def compare_sources(fc: pd.DataFrame, overlap: pd.DataFrame, obs: pd.DataFrame) -> pd.DataFrame:
    """Historical lead 1 vs previous_day1 on the same site-days, both against observations.

    One row per model: n matched wet days, bias (sum obs / sum forecast) and raw
    MAE for each source, and whether historical passes the merge criterion.
    """
    cols = ["site", "date", "model", "precip_mm"]
    prev = fc[(fc.lead_day == 1) & (fc.source == "previous_runs")][cols]
    m = overlap[cols].merge(prev, on=["site", "date", "model"], suffixes=("_hist", "_prev")).merge(obs, on=["site", "date"])
    m = m[is_wet(m.obs_mm, m.precip_mm_hist) | is_wet(m.obs_mm, m.precip_mm_prev)]
    rows = []
    for model, g in m.groupby("model"):
        r = {"model": model, "n": len(g)}
        for src in ("prev", "hist"):
            p = g[f"precip_mm_{src}"]
            r[f"bias_{src}"] = g.obs_mm.sum() / p.sum() if p.sum() > 0 else np.nan
            r[f"mae_{src}"] = (p - g.obs_mm).abs().mean()
        r["merge"] = bool(
            r["n"] >= SOURCE_MIN_N
            and abs(r["bias_hist"] / r["bias_prev"] - 1) <= SOURCE_BIAS_TOL
            and abs(r["mae_hist"] / r["mae_prev"] - 1) <= SOURCE_MAE_TOL
        )
        rows.append(r)
    return pd.DataFrame(rows, columns=["model", "n", "bias_prev", "mae_prev", "bias_hist", "mae_hist", "merge"])


def select_forecasts(fc: pd.DataFrame, comparison: pd.DataFrame) -> pd.DataFrame:
    """Keep historical rows only for models that passed the overlap comparison."""
    merged = set(comparison.loc[comparison["merge"], "model"]) if len(comparison) else set()
    return fc[(fc.source != "historical") | fc.model.isin(merged)]


def make_pairs(fc: pd.DataFrame, obs: pd.DataFrame) -> pd.DataFrame:
    st = station_list(STATIONS_PARQUET)[["site", "region", "band"]]
    df = fc[["site", "date", "model", "lead_day", "precip_mm", "source"]].rename(columns={"source": "fc_source"})
    df = df.merge(obs, on=["site", "date"]).merge(st, on="site")
    keep = df.precip_mm.notna() & is_wet(df.obs_mm, df.precip_mm)
    return df.loc[keep, ["site", "date", "region", "band", "model", "lead_day", "precip_mm", "obs_mm", "obs_source", "fc_source"]]


def load_pairs(sources=("snotel",)) -> pd.DataFrame:
    """Forecast/obs pairs for the given networks (SNOTEL only by default, as backtest.py expects).

    Historical lead 1 is included only for models that pass compare_sources,
    which always judges against every network's observations.
    """
    fc, overlap = load_forecasts()
    obs = load_obs(fc)
    pairs = make_pairs(select_forecasts(fc, compare_sources(fc, overlap, obs)), obs)
    return pairs[pairs.obs_source.isin(sources)]


def explain_empty() -> None:
    """Print what each input holds and how many rows each join/filter step keeps."""
    fc, _ = load_forecasts()
    obs = load_obs(fc)
    st = station_list(STATIONS_PARQUET)[["site", "region", "band"]]
    for name, df in (("obs", obs), ("forecasts", fc), ("stations", st)):
        span = f"{df.date.min()} .. {df.date.max()}" if "date" in df else ""
        print(f"{name}: {len(df):,} rows, {df.site.nunique()} sites ({df.site.dtype}, e.g. {df.site.iloc[:3].tolist()}) {span}")
    print(f"date dtypes: obs {obs.date.dtype}, forecasts {fc.date.dtype}")
    print(f"obs by source: {obs.obs_source.value_counts().to_dict()}")
    df = fc.merge(obs, on=["site", "date"])
    print(f"forecasts x obs: {len(df):,}")
    df = df.merge(st, on="site")
    print(f"  x stations: {len(df):,}")
    for label, mask in (
        ("precip present", df.precip_mm.notna()),
        ("wet day", is_wet(df.obs_mm, df.precip_mm)),
    ):
        print(f"  passing {label}: {int(mask.sum()):,}")


def find_aliases(pairs: pd.DataFrame) -> dict[str, dict[str, str]]:
    """Detect model series that are byte-identical copies of another model.

    Seamless products stitch in regional models (gfs_seamless at lead 1 is
    HRRR over CONUS), so the same forecast would be weighted twice. The
    seamless copy is dropped and recorded as an alias of the specific model.
    """
    aliases: dict[str, dict[str, str]] = {}
    for lead, g in pairs.groupby("lead_day"):
        wide = g.pivot_table(index=["site", "date"], columns="model", values="precip_mm")
        cols = sorted(wide.columns, key=lambda m: "seamless" in m)
        for i, keep in enumerate(cols):
            for other in cols[i + 1 :]:
                both = wide[[keep, other]].dropna()
                if len(both) >= 30 and (both[keep] - both[other]).abs().max() < 1e-6 and "seamless" in other:
                    aliases.setdefault(other, {})[str(lead)] = keep
    return aliases


def drop_aliases(pairs: pd.DataFrame, aliases: dict[str, dict[str, str]]) -> pd.DataFrame:
    mask = pd.Series(False, index=pairs.index)
    for model, leads in aliases.items():
        mask |= (pairs.model == model) & pairs.lead_day.astype(str).isin(leads)
    return pairs[~mask]


def fit_group(g: pd.DataFrame, parent_bias: float, parent_mae: float | None) -> dict:
    n = len(g)
    bias = (g.obs_mm.sum() + BIAS_PRIOR_MM * parent_bias) / (g.precip_mm.sum() + BIAS_PRIOR_MM)
    bias = float(np.clip(bias, *BIAS_CLAMP))
    mae = float((bias * g.precip_mm - g.obs_mm).abs().mean())
    mae_raw = float((g.precip_mm - g.obs_mm).abs().mean())
    mae_s = mae if parent_mae is None else (n * mae + MAE_PRIOR_N * parent_mae) / (n + MAE_PRIOR_N)
    return {"bias": bias, "mae": mae_s, "maeRaw": mae_raw, "n": n}


def fit(pairs: pd.DataFrame) -> dict:
    weights: dict = {}

    def put(region: str, band: str, lead: int, model: str, stats: dict) -> None:
        weights.setdefault(region, {}).setdefault(band, {}).setdefault(str(lead), {})[model] = stats

    for (model, lead), g in pairs.groupby(["model", "lead_day"]):
        top = fit_group(g, 1.0, None)
        put("ALL", "ALL", lead, model, top)
        for region, gr in g.groupby("region"):
            put(region, "ALL", lead, model, fit_group(gr, top["bias"], top["mae"]))
        for band, gb in g.groupby("band"):
            put("ALL", band, lead, model, fit_group(gb, top["bias"], top["mae"]))
        for (region, band), gc in g.groupby(["region", "band"]):
            put(region, band, lead, model, fit_group(gc, top["bias"], top["mae"]))

    for bands in weights.values():
        for leads in bands.values():
            for cell in leads.values():
                inv = {m: 1.0 / max(s["mae"], 0.1) ** 2 for m, s in cell.items()}
                total = sum(inv.values())
                for m, s in cell.items():
                    s["weight"] = inv[m] / total
                    s["bias"] = round(s["bias"], 3)
                    s["mae"] = round(s["mae"], 2)
                    s["maeRaw"] = round(s["maeRaw"], 2)
                    s["weight"] = round(s["weight"], 3)
                    cell[m] = {k: s[k] for k in ("bias", "weight", "mae", "maeRaw", "n")}
    return weights


def fit_snow_ratio(co: pd.DataFrame | None, fc: pd.DataFrame) -> dict | None:
    """Observed new-snow depth / new-snow SWE by lead-1 model-mean temperature band."""
    if co is None or co.empty:
        return None
    d = co[(co.snow_in >= SLR_MIN_SNOW_IN) & (co.snow_swe_in >= SLR_MIN_SWE_IN)]
    d = d.assign(ratio=d.snow_in / d.snow_swe_in)
    d = d[d.ratio.between(*SLR_RANGE)].merge(model_tavg_f(fc).reset_index(), on=["site", "date"])
    if d.empty:
        return None

    def summary(r: pd.Series) -> dict:
        return {"median": round(float(r.median()), 1), "p25": round(float(r.quantile(0.25)), 1), "p75": round(float(r.quantile(0.75)), 1), "n": int(len(r))}

    bands = []
    labels = pd.cut(d.tavg_f, SLR_TEMP_EDGES_F, right=False)
    for interval, g in d.groupby(labels, observed=True):
        lo, hi = interval.left, interval.right
        bands.append({"tempF": [None if np.isinf(lo) else lo, None if np.isinf(hi) else hi], **summary(g.ratio)})
    return {
        "source": "cocorahs",
        "definition": "NewSnowDepth / NewSnowSWE (in/in) on reports with >= 1 in new snow and >= 0.10 in SWE",
        "tempSource": "lead-1 model-mean 2 m temperature over the report's 24h window, F; band = [lo, hi)",
        "all": summary(d.ratio),
        "bands": bands,
    }


def source_counts(pairs: pd.DataFrame, comparison: pd.DataFrame) -> dict:
    obs = {}
    for src, g in pairs.groupby("obs_source"):
        obs[src] = {"sites": int(g.site.nunique()), "days": int(g[["site", "date"]].drop_duplicates().shape[0]), "pairs": int(len(g))}
    fcs = {}
    for src, g in pairs.groupby("fc_source"):
        fcs[src] = {"pairs": int(len(g)), "dateRange": [g.date.min().date().isoformat(), g.date.max().date().isoformat()]}
    hist = fcs.setdefault("historical", {"pairs": 0})
    hist["leads"] = [1]
    hist["mergedModels"] = sorted(comparison.loc[comparison["merge"], "model"]) if len(comparison) else []
    hist["criterion"] = (
        f"per model on the 2024-25 overlap: >= {SOURCE_MIN_N} matched wet days, |bias_hist/bias_prev - 1| <= {SOURCE_BIAS_TOL}, "
        f"|mae_hist/mae_prev - 1| <= {SOURCE_MAE_TOL}"
    )
    hist["overlap"] = {
        r.model: {"n": int(r.n), "biasPrev": round(r.bias_prev, 3), "biasHist": round(r.bias_hist, 3), "maePrev": round(r.mae_prev, 2), "maeHist": round(r.mae_hist, 2)}
        for r in comparison.itertuples()
    }
    return {"observations": obs, "forecasts": fcs}


def mae_table(pairs: pd.DataFrame, weights: dict) -> pd.DataFrame:
    rows = []
    for model in MODELS:
        for lead in LEAD_DAYS:
            s = weights.get("ALL", {}).get("ALL", {}).get(str(lead), {}).get(model)
            if s:
                rows.append({"model": model, "lead": lead, "n": s["n"], "mae_raw": s["maeRaw"], "mae_corr": s["mae"], "bias": s["bias"]})
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(WEIGHTS_JSON))
    args = ap.parse_args()

    fc, overlap = load_forecasts()
    obs = load_obs(fc)
    comparison = compare_sources(fc, overlap, obs)
    print("historical vs previous_day1 on the overlap (raw forecasts vs obs, wet days):")
    print(comparison.round(3).to_string(index=False) if len(comparison) else "  no overlap rows yet")
    pairs = make_pairs(select_forecasts(fc, comparison), obs)
    if pairs.empty:
        explain_empty()
        raise SystemExit("no overlapping forecast/observation pairs")
    aliases = find_aliases(pairs)
    pairs = drop_aliases(pairs, aliases)
    weights = fit(pairs)
    present = sorted(pairs.model.unique())
    sources = source_counts(pairs, comparison)
    doc = {
        "version": VERSION,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "regions": {name: {"bbox": bbox, "order": i} for i, (name, bbox) in enumerate(REGIONS.items())},
        "bands": {label: [None if np.isinf(lo) else lo, None if np.isinf(hi) else hi] for label, lo, hi in BANDS},
        "meta": {
            "target": "24h SWE (mm): SNOTEL gain over the PST day; CoCoRaHS new-snow SWE over the morning-to-morning window",
            "bboxFormat": "[minLon, minLat, maxLon, maxLat]; first match in 'order' wins",
            "bandUnits": "ft",
            "seasonMonths": sorted(SEASON_MONTHS),
            "maxTavgF": MAX_TAVG_F,
            "wetThresholdMm": WET_MM,
            "dateRange": [pairs.date.min().date().isoformat(), pairs.date.max().date().isoformat()],
            # SNOTEL only, as the app labels it "N SNOTEL sites"; all networks are in sources
            "sites": sources["observations"].get("snotel", {}).get("sites", 0),
            "sources": sources,
            "modelsWithData": present,
            "modelsWithoutData": [m for m in MODELS if m not in present],
            "aliases": aliases,
            "aliasNote": "aliases[model][lead] = model whose forecast it duplicates; use that entry and don't count both",
            "fallback": "missing region/band -> 'ALL'; missing model or lead -> app heuristic",
        },
        "weights": weights,
    }
    snow_ratio = fit_snow_ratio(load_cocorahs(), fc)
    if snow_ratio:
        doc["snowRatio"] = snow_ratio
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1))
    print(f"wrote {out} ({len(pairs):,} wet forecast-days, {pairs.site.nunique()} sites)")
    print(f"sources: {json.dumps({k: {s: v.get('pairs') for s, v in d.items()} for k, d in sources.items()})}")
    print(mae_table(pairs, weights).to_string(index=False))
    if snow_ratio:
        print("snow ratio by temperature:", [(b["tempF"], b["median"], b["n"]) for b in snow_ratio["bands"]])


if __name__ == "__main__":
    main()
