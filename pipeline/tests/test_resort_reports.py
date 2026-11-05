import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fetch_resort_reports import merge, parse_reports, snow_day  # noqa: E402


def page(*rows: str) -> str:
    """A minimal Next.js flight payload, split across two pushes like the real page."""
    text = "\n".join(rows) + "\n"
    half = len(text) // 2
    return "".join(f"<script>self.__next_f.push([1,{json.dumps(part)}])</script>" for part in (text[:half], text[half:]))


HTML = page(
    '1b:{"title_short":"Copper Mountain","slug":"copper-mountain-resort","snow":"$1c","status":"$1d","updatedAt":"2026-11-05T13:10:00+00:00"}',
    '1c:{"base":null,"middle":45.72,"summit":null,"last24":12.7,"last48":15.24,"last72":15.24}',
    '1d:{"openFlag":1,"openingDate":"2026-11-06","closingDate":"2027-05-02"}',
    '2b:{"title_short":"Vail","slug":"vail","snow":"$2c","status":"$2d","updatedAt":"2026-10-19T16:00:00+00:00"}',
    '2c:{"base":null,"middle":null,"summit":null,"last24":0,"last48":0,"last72":0}',
    '2d:{"openFlag":2,"openingDate":"2026-11-13"}',
    "3a:I[1234,[],\"\"]",  # not JSON: skipped
)
NOW = dt.datetime(2026, 11, 5, 15, 0, tzinfo=dt.timezone.utc)


def test_parse_reports_resolves_refs_and_converts_cm():
    r = parse_reports(HTML)
    copper = r["copper-mountain-resort"]
    assert (copper["new24In"], copper["new48In"], copper["depthIn"]) == (5.0, 6.0, 18.0)
    assert copper["open"] is True and r["vail"]["open"] is False


def test_snow_day_is_the_day_before_a_morning_report():
    assert snow_day("2026-11-05T13:10:00+00:00") == "2026-11-04"  # 6:10am MST
    assert snow_day("2026-11-05T22:00:00+00:00") == "2026-11-05"  # 3pm MST


def test_merge_keeps_fresh_reports_and_skips_stale_ones():
    doc = {"resorts": {"copper": {"days": {"2026-08-01": 1.0, "2026-11-01": 2.0}}}}
    out = merge(doc, parse_reports(HTML), NOW)["resorts"]
    assert out["copper"]["days"] == {"2026-11-01": 2.0, "2026-11-04": 5.0}  # August aged out
    assert out["copper"]["latest"]["new24In"] == 5.0
    assert out["vail"]["latest"] is None and out["vail"]["days"] == {}  # Oct 19 report is stale
    assert out["aspen-mtn"]["days"] == {}  # not on the page at all
