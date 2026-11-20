import datetime as dt
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_seth  # noqa: E402
from fetch_seth import PRIOR_WEIGHT, Call, Extraction, clean_calls, parse_feed, parse_locations, score  # noqa: E402

RSS = b"""<?xml version="1.0"?>
<rss version="2.0"><channel><title>Seth's Weather Report</title>
<item><guid>fb-1</guid><link>https://www.facebook.com/p/1</link>
<pubDate>Thu, 19 Nov 2026 22:15:00 GMT</pubDate>
<description><![CDATA[<p>Storm Friday!<br/>Summit County 6-10&quot;</p>]]></description></item>
<item><guid>fb-0</guid><link>https://www.facebook.com/p/0</link>
<pubDate>Mon, 16 Nov 2026 15:00:00 GMT</pubDate><description>Sunset photo</description></item>
</channel></rss>"""

JSON_FEED = {
    "version": "https://jsonfeed.org/version/1.1",
    "items": [{"id": "x", "url": "https://fb/x", "date_published": "2026-11-18T08:00:00-07:00", "content_html": "<p>Up to 8\" Wolf Creek</p>"}],
}


def test_parse_rss_newest_first_and_strips_html():
    posts = parse_feed(RSS, "application/rss+xml")
    assert [p["id"] for p in posts] == ["fb-1", "fb-0"]
    assert posts[0]["published"] == "2026-11-19T22:15:00+00:00"
    assert posts[0]["text"] == 'Storm Friday!\nSummit County 6-10"'


def test_parse_json_feed():
    (p,) = parse_feed(json.dumps(JSON_FEED).encode(), "application/feed+json")
    assert p["published"] == "2026-11-18T15:00:00+00:00"
    assert p["text"] == 'Up to 8" Wolf Creek'


def test_locations_parse_from_app():
    locs = {l["id"]: l for l in parse_locations()}
    assert locs["breckenridge"]["region"] == "Central Mtns"
    assert locs["denver"]["kind"] == "town"
    assert len(locs) > 40


def test_clean_calls_filters_bad_ids_dates_and_amounts():
    ex = Extraction(summary="s", calls=[
        Call(location_ids=["breckenridge", "nowhere"], start_date="2026-11-20", end_date="2026-11-21", low_in=10, high_in=6),
        Call(location_ids=["nowhere"], start_date="2026-11-20", end_date="2026-11-21", low_in=1, high_in=2),
        Call(location_ids=["vail"], start_date="2026-11-22", end_date="2026-11-20", low_in=1, high_in=2),
        Call(location_ids=["vail"], start_date="2026-11-01", end_date="2026-11-02", low_in=1, high_in=2),
        Call(location_ids=["vail"], start_date="Friday", end_date="2026-11-21", low_in=1, high_in=2),
    ])
    calls = clean_calls(ex, "2026-11-19T22:15:00+00:00", {"breckenridge", "vail"})
    assert calls == [{"locations": ["breckenridge"], "start": "2026-11-20", "end": "2026-11-21", "lowIn": 6, "highIn": 10}]


def past(days):
    return {"locations": {"vail": {"days": [{"d": d, "a": a, "p": p} for d, a, p in days]}}}


def post(published, calls):
    return {"id": published, "published": published, "calls": calls}


def test_score_prior_without_data():
    s = score([], None, dt.date(2026, 11, 20))
    assert s["n"] == 0 and s["weight"] == PRIOR_WEIGHT


def test_score_uses_latest_call_and_moves_weight_toward_better_forecaster():
    obs = past([("2026-11-10", 6, 2), ("2026-11-11", 4, 1)])  # 10" fell; we said 3"
    old = post("2026-11-08T12:00:00+00:00", [{"locations": ["vail"], "start": "2026-11-10", "end": "2026-11-11", "lowIn": 1, "highIn": 2}])
    new = post("2026-11-09T12:00:00+00:00", [{"locations": ["vail"], "start": "2026-11-10", "end": "2026-11-11", "lowIn": 8, "highIn": 12}])
    s = score([old, new], obs, dt.date(2026, 11, 20))
    assert s["n"] == 1
    assert s["sethMaeIn"] == 0 and s["oursMaeIn"] == 7
    assert PRIOR_WEIGHT < s["weight"] < 0.3  # one good call nudges, doesn't take over


def test_score_skips_unfinished_and_missing_days():
    obs = past([("2026-11-19", 3, 2)])
    calls = [
        {"locations": ["vail"], "start": "2026-11-19", "end": "2026-11-20", "lowIn": 4, "highIn": 8},  # ends today
        {"locations": ["vail"], "start": "2026-11-18", "end": "2026-11-19", "lowIn": 4, "highIn": 8},  # 18th missing
    ]
    assert score([post("2026-11-17T00:00:00+00:00", calls)], obs, dt.date(2026, 11, 20))["n"] == 0


def test_main_extracts_new_posts_only(tmp_path, monkeypatch):
    out = tmp_path / "seth.json"
    monkeypatch.setattr(fetch_seth, "OUT_JSON", out)
    monkeypatch.setattr(fetch_seth, "PAST_JSON", tmp_path / "missing.json")
    monkeypatch.setattr(fetch_seth, "fetch_feed", lambda url: parse_feed(RSS))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    now = dt.datetime(2026, 11, 20, 12, tzinfo=dt.timezone.utc)
    monkeypatch.setattr(fetch_seth, "KEEP_DAYS", (dt.datetime.now(dt.timezone.utc) - now).days + 30)
    seen = []

    def fake_extract(client, text, published, locations):
        seen.append(text)
        calls = [Call(location_ids=["breckenridge"], start_date="2026-11-20", end_date="2026-11-21", low_in=6, high_in=10)] if "Summit" in text else []
        return Extraction(summary="A storm." if calls else "A photo.", calls=calls)

    monkeypatch.setattr(fetch_seth, "extract", fake_extract)
    monkeypatch.setitem(sys.modules, "anthropic", SimpleNamespace(Anthropic=lambda: None, APIStatusError=RuntimeError, APIConnectionError=OSError))
    assert fetch_seth.main(["--feed", "x"]) == 0
    data = json.loads(out.read_text())
    assert [p["id"] for p in data["posts"]] == ["fb-1", "fb-0"]
    assert data["posts"][0]["calls"][0]["locations"] == ["breckenridge"]
    assert "text" not in data["posts"][0]
    assert fetch_seth.main(["--feed", "x"]) == 0
    assert len(seen) == 2  # second run reads nothing new
