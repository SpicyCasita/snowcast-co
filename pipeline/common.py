"""Shared constants and helpers for the SnowCast CO pipeline."""
from __future__ import annotations

from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = ROOT / "out"
CACHE = DATA / "cache"

STATIONS_PARQUET = DATA / "stations.parquet"
SNOTEL_PARQUET = DATA / "snotel.parquet"
FORECASTS_PARQUET = DATA / "forecasts.parquet"
# Historical Forecast API rows for dates Previous Runs also covers; kept apart
# so forecasts.parquet stays unique on (site, date, model, lead_day).
OVERLAP_PARQUET = DATA / "forecasts_overlap.parquet"
COCORAHS_PARQUET = DATA / "cocorahs.parquet"
COCORAHS_STATIONS_PARQUET = DATA / "cocorahs_stations.parquet"
LOCATIONS_TS = ROOT.parent / "app" / "src" / "data" / "locations.ts"
WEIGHTS_JSON = OUT / "weights.json"

# SNOTEL reports daily values in Pacific Standard Time for every station
# (AWDB dataTimeZone = -8), so forecasts are aggregated in the same fixed zone.
OBS_TZ = "Etc/GMT+8"

MODELS = [
    "ncep_hrrr_conus",
    "ncep_nam_conus",
    "gfs_seamless",
    "ecmwf_ifs025",
    "gem_seamless",
    "icon_seamless",
]
LEAD_DAYS = list(range(1, 8))

# Regions are matched in this order; the first bbox containing the point wins.
# bbox = [minLon, minLat, maxLon, maxLat]
REGIONS: dict[str, list[float]] = {
    "Front Range foothills": [-105.85, 38.6, -102.0, 41.01],
    "Sangre de Cristo": [-106.0, 36.99, -102.0, 38.6],
    "San Juans": [-109.06, 36.99, -106.0, 38.5],
    "Northern Mtns": [-109.06, 39.8, -105.85, 41.01],
    "Central Mtns": [-109.06, 36.99, -105.85, 41.01],
}

# Elevation bands in feet: (label, lower bound inclusive, upper bound exclusive)
BANDS = [("lt9k", float("-inf"), 9000.0), ("9to11k", 9000.0, 11000.0), ("gt11k", 11000.0, float("inf"))]


def station_list(path: Path = STATIONS_PARQUET) -> pd.DataFrame:
    """stations.parquet with the optional columns filled for SNOTEL-only files.

    source       'snotel' or 'cocorahs'
    day_start_h  hour (in OBS_TZ) at which the station's observation day
                 starts; 0 for SNOTEL, the usual morning reading for CoCoRaHS
    """
    st = pd.read_parquet(path)
    st["source"] = st["source"].fillna("snotel") if "source" in st else "snotel"
    st["day_start_h"] = st["day_start_h"].fillna(0).astype(int) if "day_start_h" in st else 0
    return st


def assign_region(lat: float, lon: float) -> str | None:
    for name, (min_lon, min_lat, max_lon, max_lat) in REGIONS.items():
        if min_lon <= lon <= max_lon and min_lat <= lat <= max_lat:
            return name
    return None


def assign_band(elev_ft: float) -> str:
    for label, lo, hi in BANDS:
        if lo <= elev_ft < hi:
            return label
    raise ValueError(f"bad elevation {elev_ft}")
