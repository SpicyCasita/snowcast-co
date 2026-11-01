import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import assign_band, assign_region  # noqa: E402
from fetch_snotel import clean_station, parse_data_response, water_year  # noqa: E402


def payload(element, values, triplet="335:CO:SNTL"):
    return [{"stationTriplet": triplet, "data": [{"stationElement": {"elementCode": element}, "values": values}]}]


def wide(**cols):
    idx = pd.to_datetime(cols.pop("dates"))
    return pd.DataFrame(cols, index=idx)


def test_parse_missing_null_and_garbage_values():
    df = parse_data_response(
        payload(
            "WTEQ",
            [
                {"date": "2024-01-01", "value": 5.0},
                {"date": "2024-01-02"},  # value key absent
                {"date": "2024-01-03", "value": None},
                {"date": "2024-01-04", "value": "NaN?"},
            ],
        )
    )
    assert len(df) == 4
    assert df.value.iloc[0] == 5.0
    assert df.value.iloc[1:].isna().all()


def test_parse_ignores_unknown_elements_and_empty_payloads():
    assert parse_data_response([]).empty
    assert parse_data_response(None).empty
    df = parse_data_response(payload("WSPDV", [{"date": "2024-01-01", "value": 3}]))
    assert df.empty
    assert parse_data_response([{"stationTriplet": "x", "data": None}]).empty


def test_gaps_become_explicit_rows_and_break_deltas():
    w = wide(dates=["2024-01-01", "2024-01-02", "2024-01-04"], WTEQ=[5.0, 5.5, 6.0], SNWD=[20, 24, 26])
    out = clean_station(w, pd.Timestamp("2024-01-01"), pd.Timestamp("2024-01-04"))
    assert len(out) == 4
    assert out.wteq_in.isna().sum() == 1
    # D accumulation = start of D+1 minus start of D
    assert out.dswe_in.iloc[0] == pytest.approx(0.5)
    # no delta across the missing day, and none for the last day
    assert np.isnan(out.dswe_in.iloc[1]) and np.isnan(out.dswe_in.iloc[2]) and np.isnan(out.dswe_in.iloc[3])


def test_negative_and_spike_values_dropped():
    w = wide(
        dates=pd.date_range("2024-02-01", periods=4),
        WTEQ=[10.0, -99.9, 10.2, 30.0],  # sentinel, then a 20" sensor jump
        SNWD=[40, 41, 120, 42],  # 79" depth spike
        TAVG=[20.0, -99.9, 25.0, 140.0],
    )
    out = clean_station(w, pd.Timestamp("2024-02-01"), pd.Timestamp("2024-02-04"))
    assert np.isnan(out.wteq_in.iloc[1])
    assert np.isnan(out.dswe_in.iloc[2])  # 10.2 -> 30.0 is a jump
    assert np.isnan(out.dsnwd_in.iloc[1]) and np.isnan(out.dsnwd_in.iloc[2])
    assert out.tavg_f.isna().tolist() == [False, True, False, True]


def test_melt_out_and_depth_reset_are_kept_as_real_losses():
    w = wide(dates=pd.date_range("2024-05-28", periods=3), WTEQ=[0.8, 0.1, 0.0], SNWD=[6, 0, 0])
    out = clean_station(w, pd.Timestamp("2024-05-28"), pd.Timestamp("2024-05-30"))
    assert out.dswe_in.iloc[0] == pytest.approx(-0.7)
    assert out.dsnwd_in.iloc[0] == -6
    assert out.dsnwd_in.iloc[1] == 0


def test_precip_accumulator_resets_on_water_year():
    w = wide(dates=pd.date_range("2023-09-29", periods=4), PREC=[30.0, 30.2, 0.1, 0.4])
    out = clean_station(w, pd.Timestamp("2023-09-29"), pd.Timestamp("2023-10-02"))
    # Sep 30 -> Oct 1 crosses the reset: increment is the new reading, not -30.1
    assert out.dprec_in.tolist()[:3] == pytest.approx([0.2, 0.1, 0.3])
    assert out.water_year.tolist() == [2023, 2023, 2024, 2024]


def test_precip_noise_zeroed_but_real_drops_flagged():
    w = wide(dates=pd.date_range("2024-01-01", periods=3), PREC=[10.0, 9.95, 8.0])
    out = clean_station(w, pd.Timestamp("2024-01-01"), pd.Timestamp("2024-01-03"))
    assert out.dprec_in.iloc[0] == 0.0
    assert np.isnan(out.dprec_in.iloc[1])


def test_station_with_no_data_yields_all_nan_calendar():
    out = clean_station(pd.DataFrame(), pd.Timestamp("2024-01-01"), pd.Timestamp("2024-01-05"))
    assert len(out) == 5
    assert out[["wteq_in", "snwd_in", "prec_in", "tavg_f", "dswe_in"]].isna().all().all()


def test_water_year():
    s = pd.Series(pd.to_datetime(["2023-09-30", "2023-10-01", "2024-01-15"]))
    assert water_year(s).tolist() == [2023, 2024, 2024]


@pytest.mark.parametrize(
    "lat,lon,region",
    [
        (40.04, -105.58, "Front Range foothills"),  # Niwot
        (37.48, -106.80, "San Juans"),  # Wolf Creek Summit
        (37.20, -105.20, "Sangre de Cristo"),  # Culebra
        (40.35, -106.70, "Northern Mtns"),  # Steamboat area
        (39.60, -106.30, "Central Mtns"),  # Vail Pass area
    ],
)
def test_assign_region(lat, lon, region):
    assert assign_region(lat, lon) == region


def test_assign_band_edges():
    assert assign_band(8999) == "lt9k"
    assert assign_band(9000) == "9to11k"
    assert assign_band(11000) == "gt11k"
