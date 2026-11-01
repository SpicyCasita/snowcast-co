"""Fetch Colorado SNOTEL daily observations from the NRCS AWDB REST API.

Writes:
  data/stations.parquet  one row per station (lat/lon/elevation, region, band)
  data/snotel.parquet    one row per station x date with raw and derived values

Daily SNOTEL WTEQ/SNWD/PREC are start-of-day (midnight PST) readings, so the
accumulation *during* date D is value[D+1] - value[D]. TAVG is the mean over D.
"""
from __future__ import annotations

import argparse
import datetime as dt
import time

import numpy as np
import pandas as pd
import requests

from common import DATA, SNOTEL_PARQUET, STATIONS_PARQUET, assign_band, assign_region

API = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1"
ELEMENTS = ["WTEQ", "SNWD", "PREC", "TAVG"]
DEFAULT_START = "2021-10-01"

# Day-over-day changes beyond these are sensor jumps, not weather.
MAX_DSWE_IN = 6.0
MAX_DSNWD_IN = 40.0
# Small negative precip increments are gauge noise (evaporation, temperature drift).
PREC_NOISE_IN = 0.1


def get_json(session: requests.Session, path: str, params: dict, tries: int = 4):
    for attempt in range(tries):
        try:
            r = session.get(f"{API}/{path}", params=params, timeout=120)
            if r.status_code < 500:
                r.raise_for_status()
                return r.json()
        except requests.RequestException:
            if attempt == tries - 1:
                raise
        time.sleep(2 ** attempt)
    r.raise_for_status()


def fetch_stations(session: requests.Session) -> pd.DataFrame:
    rows = get_json(
        session,
        "stations",
        {
            "stationTriplets": "*:CO:SNTL",
            "activeOnly": "true",
            "returnForecastPointMetadata": "false",
            "returnReservoirMetadata": "false",
            "returnStationElements": "false",
        },
    )
    df = pd.DataFrame(rows)[["stationTriplet", "stationId", "name", "latitude", "longitude", "elevation", "beginDate"]]
    df = df.rename(columns={"stationTriplet": "triplet", "stationId": "site", "elevation": "elev_ft", "beginDate": "begin_date"})
    df = df.dropna(subset=["latitude", "longitude", "elev_ft"])
    df["region"] = [assign_region(la, lo) for la, lo in zip(df.latitude, df.longitude)]
    df["band"] = df.elev_ft.map(assign_band)
    df["elev_m"] = (df.elev_ft * 0.3048).round(1)
    return df.sort_values("site", key=lambda s: s.astype(int)).reset_index(drop=True)


def parse_data_response(payload: list[dict]) -> pd.DataFrame:
    """Flatten an AWDB /data response into long rows (triplet, element, date, value).

    Values that are absent, null or non-numeric become NaN.
    """
    rows = []
    for station in payload or []:
        triplet = station.get("stationTriplet")
        for series in station.get("data") or []:
            element = (series.get("stationElement") or {}).get("elementCode")
            if element not in ELEMENTS:
                continue
            for v in series.get("values") or []:
                val = v.get("value")
                try:
                    val = float(val) if val is not None else np.nan
                except (TypeError, ValueError):
                    val = np.nan
                rows.append((triplet, element, v.get("date"), val))
    df = pd.DataFrame(rows, columns=["triplet", "element", "date", "value"])
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    return df


def water_year(dates: pd.Series) -> pd.Series:
    return dates.dt.year + (dates.dt.month >= 10).astype(int)


def clean_station(wide: pd.DataFrame, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    """Clean one station's wide daily frame (index = date) and derive daily changes.

    - reindexes to a complete daily calendar so gaps are explicit NaN rows
    - drops physically impossible values (negative SWE/depth, absurd temps)
    - PREC is a water-year accumulator that resets on Oct 1: the Oct 1
      increment is the reading itself, negative non-reset steps are gauge noise
    - day-over-day SWE/depth changes are computed only between valid
      consecutive readings; sensor jumps become NaN
    """
    idx = pd.date_range(start, end, freq="D", name="date")
    w = wide.reindex(idx).astype(float)
    for col in ELEMENTS:
        if col not in w:
            w[col] = np.nan
    w.loc[w.WTEQ < 0, "WTEQ"] = np.nan
    w.loc[w.SNWD < 0, "SNWD"] = np.nan
    w.loc[w.PREC < 0, "PREC"] = np.nan
    w.loc[(w.TAVG < -60) | (w.TAVG > 100), "TAVG"] = np.nan

    out = pd.DataFrame(index=idx)
    out["water_year"] = water_year(idx.to_series())
    out["wteq_in"] = w.WTEQ
    out["snwd_in"] = w.SNWD
    out["prec_in"] = w.PREC
    out["tavg_f"] = w.TAVG

    # accumulation during D = start of D+1 minus start of D
    dswe = w.WTEQ.shift(-1) - w.WTEQ
    dswe[dswe.abs() > MAX_DSWE_IN] = np.nan
    out["dswe_in"] = dswe

    dsnwd = w.SNWD.shift(-1) - w.SNWD
    dsnwd[dsnwd.abs() > MAX_DSNWD_IN] = np.nan
    out["dsnwd_in"] = dsnwd

    nxt = w.PREC.shift(-1)
    dprec = nxt - w.PREC
    next_day = idx + pd.Timedelta(days=1)
    reset = (next_day.month == 10) & (next_day.day == 1)
    # across the reset the accumulator restarts near zero, so the next reading is the increment
    dprec[reset] = nxt[reset]
    dprec[(dprec < 0) & (dprec >= -PREC_NOISE_IN)] = 0.0
    dprec[dprec < -PREC_NOISE_IN] = np.nan
    out["dprec_in"] = dprec
    return out.reset_index()


def fetch_snotel(stations: pd.DataFrame, start: str, end: str, batch: int = 10) -> pd.DataFrame:
    session = requests.Session()
    start_ts, end_ts = pd.Timestamp(start), pd.Timestamp(end)
    frames = []
    triplets = stations.triplet.tolist()
    for i in range(0, len(triplets), batch):
        chunk = triplets[i : i + batch]
        print(f"  SNOTEL {i + 1}-{i + len(chunk)} of {len(triplets)}")
        payload = get_json(
            session,
            "data",
            {
                "stationTriplets": ",".join(chunk),
                "elements": ",".join(ELEMENTS),
                "duration": "DAILY",
                "beginDate": start,
                "endDate": end,
                "periodRef": "START",
            },
        )
        long = parse_data_response(payload)
        for triplet in chunk:
            sub = long[long.triplet == triplet]
            wide = sub.pivot_table(index="date", columns="element", values="value", aggfunc="last") if len(sub) else pd.DataFrame()
            df = clean_station(wide, start_ts, end_ts)
            df.insert(0, "site", triplet.split(":")[0])
            frames.append(df)
    return pd.concat(frames, ignore_index=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--end", default=dt.date.today().isoformat())
    ap.add_argument("--sites", type=int, default=0, help="limit to the first N stations (0 = all)")
    ap.add_argument("--site-ids", default="", help="comma-separated station ids to fetch")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)
    stations = fetch_stations(requests.Session())
    print(f"{len(stations)} active CO SNOTEL stations")
    stations.to_parquet(STATIONS_PARQUET, index=False)

    sel = stations
    if args.site_ids:
        sel = sel[sel.site.isin(args.site_ids.split(","))]
    elif args.sites:
        sel = sel.head(args.sites)
    obs = fetch_snotel(sel, args.start, args.end)
    obs.to_parquet(SNOTEL_PARQUET, index=False)
    print(f"wrote {len(obs):,} rows for {obs.site.nunique()} sites -> {SNOTEL_PARQUET}")


if __name__ == "__main__":
    main()
