"""Score the logged live forecasts and publish app/public/data/verification.json.

Inputs
  app/public/data/forecast-log-*.jsonl   written daily by app/scripts/log-forecasts.ts
  data/snotel.parquet (+ data/cocorahs.parquet if present)
  data/backtest.json                     written by backtest.py (else the previous file's backtest is kept)

Live track record: each logged PST day (lead 1-3) whose observation has arrived is scored like the
backtest (snow season, cold day, wet by obs or any forecast; SWE inches) for the tuned blend, the
default blend and each raw model.

Calibration: logged probabilities (chance of >= N inches, bucket confidence) and the low-high range
are checked against observed snow over the same window: SNOTEL daily snow-depth gain summed over the
window's PST days (settling makes this a lower bound on snowfall), or CoCoRaHS new snow when logged
at a gauge. Only windows starting within a few hours of the station's day start are used.

  python verify.py                    write verification.json
  python verify.py --export-stations  write data/log-stations.json for the logger
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

import backtest
import bias
from common import DATA, ROOT, SNOTEL_PARQUET, STATIONS_PARQUET, station_list

VERSION = 1
APP_DATA = ROOT.parent / "app" / "public" / "data"
VERIFICATION_JSON = APP_DATA / "verification.json"
LOG_STATIONS = DATA / "log-stations.json"
MIN_COVERAGE = 0.9  # share of the PST day still ahead when logged
ALIGN_HOURS = 3  # window start must be this close to 00:00 PST
PROB_BINS = np.linspace(0, 1, 11)
MAX_BYTES = 200_000


def export_stations(out: Path = LOG_STATIONS) -> int:
    """Every verification station (SNOTEL and CoCoRaHS) with its observation-day start hour."""
    st = station_list(STATIONS_PARQUET)
    rows = [{"source": r.source, "site": str(r.site), "name": str(r.name), "lat": r.latitude, "lon": r.longitude,
             "elevFt": r.elev_ft, "dayStartH": int(r.day_start_h)} for r in st.itertuples()]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows))
    return len(rows)


def load_log(app_data: Path = APP_DATA) -> list[dict]:
    recs = []
    for f in sorted(app_data.glob("forecast-log*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return recs


def load_obs() -> pd.DataFrame:
    """Daily obs per (src, site, date): swe_in, snow_in (depth or new snow), tavg_f."""
    frames = []
    if SNOTEL_PARQUET.exists():
        s = pd.read_parquet(SNOTEL_PARQUET, columns=["site", "date", "dswe_in", "dsnwd_in", "tavg_f"])
        frames.append(pd.DataFrame({"src": "snotel", "site": s.site.astype(str), "date": s.date,
                                    "swe_in": s.dswe_in.clip(lower=0), "snow_in": s.dsnwd_in.clip(lower=0), "tavg_f": s.tavg_f}))
    c = bias.load_cocorahs()
    if c is not None and len(c):
        # obs_mm is fetch_cocorahs's SWE target (NaN on rain days); snow_in is new snow depth.
        frames.append(pd.DataFrame({"src": "cocorahs", "site": c.site.astype(str), "date": c.date,
                                    "swe_in": c.obs_mm / backtest.MM_PER_IN, "snow_in": c.snow_in, "tavg_f": np.nan}))
    if not frames:
        return pd.DataFrame(columns=["src", "site", "date", "swe_in", "snow_in", "tavg_f"])
    obs = pd.concat(frames, ignore_index=True)
    obs["date"] = pd.to_datetime(obs.date).dt.normalize()
    return obs.drop_duplicates(["src", "site", "date"])


# --- live track record ----------------------------------------------------------------------------

def live_days(recs: list[dict]) -> pd.DataFrame:
    rows = []
    for r in recs:
        if r.get("src") not in ("snotel", "cocorahs") or not r.get("d"):
            continue
        for d in r["d"]:
            if (d.get("cov") or 0) < MIN_COVERAGE:
                continue
            swe = d.get("swe", {})
            row = {"src": r["src"], "site": str(r["site"]), "date": pd.Timestamp(d["date"]), "lead_day": int(d["lead"]),
                   "run": r["run"], "tuned": swe.get("tuned"), "default": swe.get("default")}
            for m, v in (swe.get("m") or {}).items():
                row[m] = v
            rows.append(row)
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    # A re-run on the same day (manual dispatch) doesn't count twice: keep the earliest.
    return df.sort_values("run").drop_duplicates(["src", "site", "date", "lead_day"]).reset_index(drop=True)


def score_live(days: pd.DataFrame, obs: pd.DataFrame) -> dict | None:
    if days.empty:
        return None
    df = days.merge(obs, on=["src", "site", "date"])
    if df.empty:
        return None
    methods = [m for m in ["tuned", "default"] + bias.MODELS if m in df]
    wet_in = bias.WET_MM / backtest.MM_PER_IN
    fc_cols = df[methods].apply(pd.to_numeric, errors="coerce")
    tavg = df.tavg_f.where(df.tavg_f.notna(), -99)  # gauges without a thermometer aren't filtered on it
    keep = (df.date.dt.month.isin(bias.SEASON_MONTHS) & (tavg <= bias.MAX_TAVG_F) & df.swe_in.notna()
            & ((df.swe_in >= wet_in) | (fc_cols >= wet_in).any(axis=1)))
    df = df[keep].reset_index(drop=True)
    if df.empty:
        return {"n": 0, "note": "no verifiable wet snow-season days yet"}
    obs_mm = df.swe_in.to_numpy(dtype=float) * backtest.MM_PER_IN

    def table(mask: np.ndarray) -> dict:
        out = {}
        for m in methods:
            s = backtest.metrics(np.where(mask, pd.to_numeric(df[m], errors="coerce").to_numpy(dtype=float) * backtest.MM_PER_IN, np.nan), obs_mm)
            if s:
                out[m] = s
        return out

    every = np.ones(len(df), bool)
    ms = backtest.month_start(df.date)
    monthly = []
    for m in sorted(ms.unique()):
        t = table((ms == m).to_numpy())
        monthly.append({"month": m.strftime("%Y-%m"), "n": max(s["n"] for s in t.values()), "mae": {k: s["mae"] for k, s in t.items()}})
    return {
        "n": int(len(df)),
        "sites": int(df.site.nunique()),
        "dateRange": [df.date.min().date().isoformat(), df.date.max().date().isoformat()],
        "overall": table(every),
        "byLead": {str(int(lead)): table((df.lead_day == lead).to_numpy()) for lead in sorted(df.lead_day.unique())},
        "monthly": monthly,
    }


# --- calibration ----------------------------------------------------------------------------------

def window_days(start: int, hours: int, day_start_h: int = 0) -> list[pd.Timestamp] | None:
    """Obs days a window starting at unix `start` covers, or None if it doesn't line up with them."""
    t = pd.Timestamp(start, unit="s") - pd.Timedelta(hours=8 + day_start_h)  # PST wall clock, shifted to the obs day
    midnight = t.normalize()
    if t - midnight <= pd.Timedelta(hours=ALIGN_HOURS):
        first = midnight
    elif midnight + pd.Timedelta(days=1) - t <= pd.Timedelta(hours=ALIGN_HOURS):
        first = midnight + pd.Timedelta(days=1)
    else:
        return None
    return [first + pd.Timedelta(days=i) for i in range(hours // 24)]


def calibration(recs: list[dict], obs: pd.DataFrame) -> dict | None:
    snow = obs.dropna(subset=["snow_in"]).set_index(["src", "site", "date"]).snow_in
    chance, conf, ranges = [], [], []
    seen = set()
    for r in sorted(recs, key=lambda r: r.get("run", "")):
        if r.get("src") not in ("snotel", "cocorahs") or "start" not in r:
            continue
        for key, win in (r.get("w") or {}).items():
            days = window_days(int(r["start"]), int(key), int(r.get("dayStartH", 0)))
            if not days or days[0].month not in bias.SEASON_MONTHS:
                continue
            ident = (r["src"], r["site"], days[0], key)
            if ident in seen:
                continue
            vals = [snow.get((r["src"], str(r["site"]), d)) for d in days]
            if any(v is None or pd.isna(v) for v in vals):
                continue
            seen.add(ident)
            o = float(sum(vals))
            for t, p in (win.get("chance") or {}).items():
                chance.append((float(p), o >= float(t)))
            if win.get("confidence") is not None and win.get("bucket"):
                lo, hi = win["bucket"]
                conf.append((float(win["confidence"]), o >= lo and (hi is None or o < hi)))
            if "low" in win and "high" in win:
                ranges.append(win["low"] <= o <= win["high"])
    if not (chance or conf or ranges):
        return None

    def bins(pairs: list[tuple[float, bool]]) -> dict | None:
        if not pairs:
            return None
        p = np.array([x for x, _ in pairs])
        y = np.array([v for _, v in pairs], dtype=float)
        idx = np.clip(np.digitize(p, PROB_BINS[1:-1]), 0, len(PROB_BINS) - 2)
        out = []
        for i in range(len(PROB_BINS) - 1):
            sel = idx == i
            if sel.any():
                out.append({"lo": round(PROB_BINS[i], 1), "hi": round(PROB_BINS[i + 1], 1), "n": int(sel.sum()),
                            "meanP": round(float(p[sel].mean()), 3), "freq": round(float(y[sel].mean()), 3)})
        clim = y.mean()
        brier = float(((p - y) ** 2).mean())
        ref = float(((clim - y) ** 2).mean())
        return {"n": len(pairs), "brier": round(brier, 4), "brierSkill": round(1 - brier / ref, 3) if ref > 0 else None, "bins": out}

    return {
        "obs": "SNOTEL snow-depth gain over the window (a lower bound on snowfall); CoCoRaHS new snow where logged",
        "chance": bins(chance),
        "confidence": bins(conf),
        "range": {"n": len(ranges), "inside": round(float(np.mean(ranges)), 3), "target": 0.8} if ranges else None,
    }


# --- publish --------------------------------------------------------------------------------------

def backtest_part(bt: dict | None, previous: dict | None) -> dict:
    if bt is None:
        keep = ("summary", "leaderboard", "monthly", "byLead", "bySeason", "otherSources", "backtestMeta")
        return {k: previous[k] for k in keep if previous and k in previous}
    primary = bt["sources"][bt["primary"]]
    board = primary["leaderboard"]
    by = {r["method"]: r for r in board}
    raw = [r for r in board if r["method"] not in backtest.BLENDS]
    best = min(raw, key=lambda r: r["skillVsTuned"]) if raw else None
    summary = {
        "generated": bt["generated"],
        "source": bt["primary"],
        "n": primary["n"],
        "sites": primary["sites"],
        "dateRange": primary["dateRange"],
        "tunedActive": primary["tunedActive"],
        "tunedMae": by["tuned"]["mae"],
        "defaultMae": by["default"]["mae"],
        "bestModel": best["method"] if best else None,
        "bestModelMae": best["mae"] if best else None,
        "bestModelTunedMae": best["tunedMae"] if best else None,
        # Positive = the tuned blend has lower MAE on the same days.
        "vsBestModel": best["skillVsTuned"] if best else None,
        "vsDefault": by["default"]["skillVsTuned"],
    }
    return {
        "summary": summary,
        "leaderboard": board,
        "monthly": primary["monthly"],
        "byLead": primary["byLead"],
        "bySeason": primary["bySeason"],
        "otherSources": {k: {x: v[x] for x in ("n", "sites", "dateRange", "leaderboard", "byLead")} for k, v in bt["sources"].items() if k != bt["primary"]},
        "backtestMeta": bt["meta"],
    }


def build(app_data: Path = APP_DATA, backtest_json: Path = backtest.BACKTEST_JSON, previous: dict | None = None) -> dict:
    bt = json.loads(backtest_json.read_text()) if backtest_json.exists() else None
    recs = load_log(app_data)
    obs = load_obs()
    runs = sorted({r["run"] for r in recs if "run" in r})
    live = score_live(live_days(recs), obs)
    if live is not None:
        live["runs"] = len(runs)
        live["firstRun"] = runs[0] if runs else None
        live["lastRun"] = runs[-1] if runs else None
    doc = {
        "version": VERSION,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        **backtest_part(bt, previous),
        "live": live,
        "logged": {"records": len(recs), "runs": len(runs), "firstRun": runs[0] if runs else None, "lastRun": runs[-1] if runs else None},
        "calibration": calibration(recs, obs) if recs else None,
    }
    return doc


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(VERIFICATION_JSON))
    ap.add_argument("--backtest", default=str(backtest.BACKTEST_JSON))
    ap.add_argument("--export-stations", action="store_true", help="write data/log-stations.json and exit")
    args = ap.parse_args()
    if args.export_stations:
        print(f"wrote {LOG_STATIONS} ({export_stations()} stations)")
        return
    out = Path(args.out)
    previous = None
    if out.exists():
        try:
            previous = json.loads(out.read_text())
        except json.JSONDecodeError:
            pass
    doc = build(backtest_json=Path(args.backtest), previous=previous)
    text = json.dumps(doc, separators=(",", ":"))
    if len(text) > MAX_BYTES:
        # Drop the per-season tables first; the page can live without them.
        doc.pop("bySeason", None)
        text = json.dumps(doc, separators=(",", ":"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    live = doc["live"] or {}
    print(f"wrote {out} ({len(text) / 1024:.0f} KB; {doc['logged']['records']} logged records, {live.get('n', 0)} verified live days)")


if __name__ == "__main__":
    main()
