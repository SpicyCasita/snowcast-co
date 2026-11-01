"""Fit per-model QPF bias and skill weights against SNOTEL 24h SWE gain.

For each model x region x elevation band x lead day:
  bias   multiplicative QPF correction (multiply model precip by this)
  mae    mean absolute error (mm SWE) of the bias-corrected forecast
  weight inverse-MAE^2 skill weight, normalised over the models in the cell
  n      wet days used (observed or forecast >= one SWE sensor step)

Sparse cells are shrunk toward the pooled model x lead estimate, and that
toward bias 1.0, so a handful of days can't produce extreme numbers. Pooled
fallbacks are emitted under region "ALL" and/or band "ALL".

Verification is limited to snow-season days (Nov-Apr) with a mean station
temperature at or below 34F, where SWE gain is a fair proxy for precipitation.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

from common import BANDS, FORECASTS_PARQUET, LEAD_DAYS, MODELS, REGIONS, SNOTEL_PARQUET, STATIONS_PARQUET, WEIGHTS_JSON

VERSION = 1
SEASON_MONTHS = {11, 12, 1, 2, 3, 4}
MAX_TAVG_F = 34.0
WET_MM = 2.54  # SNOTEL SWE resolution is 0.1 in
BIAS_PRIOR_MM = 50.0  # pseudo-forecast mm pulling bias toward its parent
MAE_PRIOR_N = 30  # pseudo-days pulling MAE toward its parent
BIAS_CLAMP = (0.25, 4.0)


def load_pairs() -> pd.DataFrame:
    obs = pd.read_parquet(SNOTEL_PARQUET, columns=["site", "date", "dswe_in", "tavg_f"])
    fc = pd.read_parquet(FORECASTS_PARQUET, columns=["site", "date", "model", "lead_day", "precip_mm"])
    st = pd.read_parquet(STATIONS_PARQUET, columns=["site", "region", "band"])
    df = fc.merge(obs, on=["site", "date"]).merge(st, on="site")
    df["obs_mm"] = df.dswe_in.clip(lower=0) * 25.4
    keep = (
        df.date.dt.month.isin(SEASON_MONTHS)
        & (df.tavg_f <= MAX_TAVG_F)
        & df.obs_mm.notna()
        & df.precip_mm.notna()
        & ((df.obs_mm >= WET_MM) | (df.precip_mm >= WET_MM))
    )
    return df.loc[keep, ["site", "date", "region", "band", "model", "lead_day", "precip_mm", "obs_mm"]]


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

    pairs = load_pairs()
    if pairs.empty:
        raise SystemExit("no overlapping forecast/observation pairs")
    aliases = find_aliases(pairs)
    pairs = drop_aliases(pairs, aliases)
    weights = fit(pairs)
    present = sorted(pairs.model.unique())
    doc = {
        "version": VERSION,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "regions": {name: {"bbox": bbox, "order": i} for i, (name, bbox) in enumerate(REGIONS.items())},
        "bands": {label: [None if np.isinf(lo) else lo, None if np.isinf(hi) else hi] for label, lo, hi in BANDS},
        "meta": {
            "target": "24h SNOTEL SWE gain (mm), PST day",
            "bboxFormat": "[minLon, minLat, maxLon, maxLat]; first match in 'order' wins",
            "bandUnits": "ft",
            "seasonMonths": sorted(SEASON_MONTHS),
            "maxTavgF": MAX_TAVG_F,
            "wetThresholdMm": WET_MM,
            "dateRange": [pairs.date.min().date().isoformat(), pairs.date.max().date().isoformat()],
            "sites": int(pairs.site.nunique()),
            "modelsWithData": present,
            "modelsWithoutData": [m for m in MODELS if m not in present],
            "aliases": aliases,
            "aliasNote": "aliases[model][lead] = model whose forecast it duplicates; use that entry and don't count both",
            "fallback": "missing region/band -> 'ALL'; missing model or lead -> app heuristic",
        },
        "weights": weights,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1))
    print(f"wrote {out} ({len(pairs):,} wet forecast-days, {pairs.site.nunique()} sites)")
    table = mae_table(pairs, weights)
    print(table.to_string(index=False))


if __name__ == "__main__":
    main()
