import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fetch_cocorahs import add_target, align_days, parse_csv, pick_stations, qualifying  # noqa: E402
from fetch_forecasts import parse_response  # noqa: E402

HEADER = (
    "ObservationDate,ObservationTime,EntryDateTime,StationNumber,StationName,Latitude,Longitude,"
    "TotalPrecipAmt,NewSnowDepth,NewSnowSWE,TotalSnowDepth,TotalSnowSWE,DateTimeStamp"
)


def csv(*rows):
    # the export pads every field after the first with a space
    return "\n".join([HEADER] + [", ".join(r) for r in rows]) + "\n"


def row(date, time="07:00 AM", entry=None, site="CO-DN-1", precip="0.00", snow="0.0", swe="NA", depth="NA", depth_swe="NA"):
    entry = entry or f"{date} 07:05 AM"
    return [date, time, entry, site, "Denver 1.0 N", "39.75", "-104.99", precip, snow, swe, depth, depth_swe, f"{date} 02:05 PM"]


def test_na_is_missing_and_t_is_trace():
    df = parse_csv(csv(row("2024-01-12", precip="T", snow="T", swe="NA", depth="3.5")))
    r = df.iloc[0]
    assert r.precip_in == 0.0 and r.precip_trace
    assert r.snow_in == 0.0 and r.snow_trace
    assert np.isnan(r.snow_swe_in) and not r.snow_swe_trace
    assert r.depth_in == 3.5 and not r.depth_trace
    assert np.isnan(r.depth_swe_in)


def test_duplicate_report_keeps_latest_entry():
    df = parse_csv(
        csv(
            row("2024-01-12", entry="2024-01-12 03:00 PM", precip="0.40"),
            row("2024-01-12", entry="2024-01-12 07:05 AM", precip="0.10"),
            row("2024-01-13"),
        )
    )
    assert len(df) == 2
    assert df.set_index("obs_date").loc["2024-01-12", "precip_in"] == pytest.approx(0.40)


def test_morning_report_is_labelled_with_the_day_its_window_starts():
    # 7am MST = 6am PST, so the Jan 12 report covers Jan 11 06:00 -> Jan 12 06:00 PST
    df = align_days(parse_csv(csv(row("2024-01-12"), row("2024-01-13"))))
    assert df.day_start_h.tolist() == [6, 6]
    assert df.end_pst.iloc[0] == pd.Timestamp("2024-01-12 06:00")
    assert df.date.tolist() == [pd.Timestamp("2024-01-11"), pd.Timestamp("2024-01-12")]


def test_daylight_time_report_stays_on_the_same_day():
    # 7am MDT (Nov 2, before the switch) is 5am PST: within drift of the station's 6am PST day
    df = align_days(parse_csv(csv(row("2024-11-02"), row("2024-11-04"), row("2024-11-05"))))
    assert df.end_pst.iloc[0] == pd.Timestamp("2024-11-02 05:00")
    assert df.date.tolist() == [pd.Timestamp(d) for d in ("2024-11-01", "2024-11-03", "2024-11-04")]


def test_midnight_observer_and_odd_reading_times():
    site = "CO-LR-9"
    rows = [row(f"2024-01-{d:02d}", time="12:00 AM", site=site) for d in (10, 11, 12)]
    rows.append(row("2024-01-13", time="05:00 PM", site=site))  # read 17h late: window doesn't line up
    df = align_days(parse_csv(csv(*rows)))
    # midnight MST = 23:00 PST the evening before; the Jan 10 report covers Jan 8 23:00 -> Jan 9 23:00 PST
    assert df.day_start_h.unique().tolist() == [23]
    assert df.date.tolist() == [pd.Timestamp(d) for d in ("2024-01-08", "2024-01-09", "2024-01-10")]


def test_shifted_forecast_day_matches_report_window():
    hours = pd.date_range("2024-01-11 00:00", "2024-01-12 23:00", freq="h")
    precip = [1.0 if pd.Timestamp("2024-01-11 06:00") <= h < pd.Timestamp("2024-01-12 06:00") else 0.0 for h in hours]
    hourly = {"time": [h.strftime("%Y-%m-%dT%H:%M") for h in hours]}
    hourly["precipitation_previous_day1_ncep_hrrr_conus"] = precip
    hourly["snowfall_previous_day1_ncep_hrrr_conus"] = [0.0] * len(hours)
    hourly["temperature_2m_previous_day1_ncep_hrrr_conus"] = [-5.0] * len(hours)
    out = parse_response({"hourly": hourly}, "CO-DN-1", day_start_h=6)
    # Jan 10 06:00 -> Jan 11 06:00 has only 6 hours here, Jan 12 only 18: both dropped as partial
    assert out.date.tolist() == [pd.Timestamp("2024-01-11")]
    assert out.precip_mm.iloc[0] == pytest.approx(24.0)
    assert out.source.iloc[0] == "previous_runs"


def test_target_snow_dry_rain():
    df = parse_csv(
        csv(
            row("2024-01-10", precip="0.50", snow="5.0", swe="0.45"),  # NewSnowSWE wins
            row("2024-01-11", precip="0.30", snow="3.0", swe="NA"),  # falls back to the gauge
            row("2024-01-12", precip="0.00", snow="0.0"),  # dry
            row("2024-01-13", precip="0.20", snow="0.0"),  # rain: not a snow day
            row("2024-01-14", precip="T", snow="T"),  # trace snow: 0 SWE
            row("2024-01-15", precip="NA", snow="NA"),  # nothing reported
        )
    )
    df = add_target(df)
    assert df.kind.tolist() == ["snow", "snow", "dry", "rain", "snow", "unknown"]
    assert df.obs_mm.iloc[0] == pytest.approx(0.45 * 25.4)
    assert df.obs_mm.iloc[1] == pytest.approx(0.30 * 25.4)
    assert df.obs_mm.iloc[2] == 0.0
    assert np.isnan(df.obs_mm.iloc[3])
    assert df.obs_mm.iloc[4] == 0.0
    assert np.isnan(df.obs_mm.iloc[5])


def test_qualifying_needs_enough_reports_per_season():
    days = pd.date_range("2023-11-01", periods=90)
    busy = pd.DataFrame({"site": "A", "name": "a", "latitude": 40.0, "longitude": -105.0, "date": days, "kind": "dry"})
    sparse = busy.iloc[:30].assign(site="B")
    q = qualifying(pd.concat([busy, sparse]))
    assert q.site.tolist() == ["A"]


def test_pick_stations_two_per_town_below_9k():
    towns = pd.DataFrame({"town": ["t1", "t2"], "lat": [40.0, 39.0], "lon": [-105.0, -105.0]})
    cands = pd.DataFrame(
        {
            "site": ["a", "b", "c", "hi", "d", "e", "f"],
            "latitude": [40.01, 40.02, 40.03, 40.005, 39.01, 39.02, 39.03],
            "longitude": [-105.0] * 7,
            "elev_ft": [5000, 5100, 5200, 9500, 6000, 6100, 6200],
        }
    )
    sel = pick_stations(cands, towns, target=4)
    assert sorted(sel.site) == ["a", "b", "d", "e"]  # "hi" is above 9,000 ft
    sel = pick_stations(cands, towns, target=40)
    assert sorted(sel.site) == ["a", "b", "c", "d", "e", "f"]
