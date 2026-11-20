"""Seth's Weather Report: a human forecaster's snow calls, read from his Facebook page via a feed.

Facebook pages can't be read directly by a script, so the page is turned into a feed by an RSS
bridge (rss.app, FetchRSS, or similar) and its URL is given in SETH_FEED_URL. RSS 2.0, Atom and
JSON Feed all work. A post can also be added by hand with --text (the workflow's "post_text" input),
for when the bridge misses one.

Each new post is read by Claude, which turns the prose ("Summit County 6-10 inches Friday into
Saturday, Front Range foothills 2-4") into calls: which app locations, which days, low-high inches.
Posts without numbers (photos, "storm coming next week, details soon") yield no calls.

Skill: once a call's days have passed, its midpoint is scored against what the location's station
measured (past-snowfall.json "a"), next to our own day-before forecast for the same days ("p").
The weight the app gives Seth is his share of a two-way inverse-MAE² blend against our forecast,
shrunk toward PRIOR_WEIGHT (about one model's share) until SHRINK_N pairs have been scored. Our
side is a day-before forecast, usually a shorter lead than his, so the comparison is a tough one.

Output: app/public/data/seth-forecasts.json. Only a short summary of each post written by Claude is
kept, plus the link, not the post's text.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import requests
from pydantic import BaseModel

from common import LOCATIONS_TS, ROOT

OUT_JSON = ROOT.parent / "app" / "public" / "data" / "seth-forecasts.json"
PAST_JSON = ROOT.parent / "app" / "public" / "data" / "past-snowfall.json"
PAGE_URL = "https://www.facebook.com/share/1A5SEVwpDz/"
HEADERS = {"User-Agent": "SnowCastCO/1.0 (personal snowfall app)"}
MOUNTAIN = ZoneInfo("America/Denver")
MODEL = "claude-opus-5-5"
VERSION = 1
KEEP_DAYS = 120
MAX_NEW_POSTS = 20
MAX_WINDOW_DAYS = 10

PRIOR_WEIGHT = 0.15
SHRINK_N = 10
MIN_WEIGHT, MAX_WEIGHT = 0.05, 0.6

LOC_RE = re.compile(r"(resort|town|pass)\('([^']+)',\s*'([^']+)',[^)]*'([^']+)'\)")


def parse_locations(path: Path = LOCATIONS_TS) -> list[dict]:
    return [
        {"id": lid, "name": name, "kind": kind, "region": region}
        for kind, lid, name, region in LOC_RE.findall(path.read_text(encoding="utf-8"))
    ]


# ---------------------------------------------------------------- feed


def strip_html(s: str) -> str:
    s = re.sub(r"<br\s*/?>|</p>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&quot;", '"'), ("&#39;", "'"), ("&lt;", "<"), ("&gt;", ">")):
        s = s.replace(a, b)
    return re.sub(r"[ \t]+", " ", s).strip()


def post_id(url: str, text: str) -> str:
    return hashlib.sha1((url or text).encode()).hexdigest()[:16]


def parse_feed(body: bytes, content_type: str = "") -> list[dict]:
    """Feed bytes -> [{id, url, published (ISO, UTC), text}], newest first."""
    posts = []
    if "json" in content_type or body.lstrip()[:1] == b"{":
        feed = json.loads(body)
        for it in feed.get("items", []):
            text = it.get("content_text") or strip_html(it.get("content_html") or "") or it.get("title") or ""
            url = it.get("url") or ""
            published = it.get("date_published") or it.get("date_modified")
            posts.append({"id": str(it.get("id") or post_id(url, text)), "url": url, "published": published, "text": text})
    else:
        import feedparser

        feed = feedparser.parse(body)
        for e in feed.entries:
            raw = (e.get("content") or [{}])[0].get("value") or e.get("summary") or e.get("title") or ""
            text = strip_html(raw)
            url = e.get("link") or ""
            t = e.get("published_parsed") or e.get("updated_parsed")
            published = dt.datetime(*t[:6], tzinfo=dt.timezone.utc).isoformat() if t else None
            posts.append({"id": str(e.get("id") or post_id(url, text)), "url": url, "published": published, "text": text})
    for p in posts:
        p["published"] = normalize_time(p["published"])
    posts = [p for p in posts if p["text"].strip()]
    return sorted(posts, key=lambda p: p["published"], reverse=True)


def normalize_time(s: Optional[str]) -> str:
    if not s:
        return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=MOUNTAIN)
    return t.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


def fetch_feed(url: str) -> list[dict]:
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return parse_feed(r.content, r.headers.get("content-type", ""))


# ---------------------------------------------------------------- extraction


class Call(BaseModel):
    location_ids: list[str]
    start_date: str
    end_date: str
    low_in: float
    high_in: float


class Extraction(BaseModel):
    summary: str
    calls: list[Call]


def build_prompt(text: str, published: str, locations: list[dict]) -> str:
    local = dt.datetime.fromisoformat(published).astimezone(MOUNTAIN)
    loc_lines = "\n".join(f"- {l['id']}: {l['name']} ({l['kind']}, {l['region']})" for l in locations)
    return f"""Below is a Facebook post from "Seth's Weather Report", a Colorado weather forecaster. It was \
posted {local:%A %Y-%m-%d %H:%M} Mountain Time.

Extract every quantitative snowfall forecast it makes, as calls. A call is a snow total (low and high, in \
inches) over a range of calendar days, for a set of places. Map each place or area he names (towns, ski \
areas, passes, counties, corridors such as I-70, "the foothills", "the northern mountains", "Denver metro", \
etc.) to the location ids below that lie in it. Use only ids from this list; leave out areas with no match.

Rules:
- Resolve relative days ("tonight", "Friday", "this weekend") against the posting date. start_date and \
end_date are ISO dates (YYYY-MM-DD), inclusive, in Mountain Time.
- A single number ("about 6 inches") is low = high = that number. "Up to 8" is 0 to 8. "A dusting" is 0 to 1. \
"1-2 feet" is 12 to 24.
- If he gives different amounts for different areas, make one call per area.
- Skip vague statements with no amount, rain-only forecasts, and recaps of snow that already fell.
- If the post has no snow forecast with amounts, return an empty calls list.

summary: one sentence in your own words saying what the post forecasts (no quotes from it), or what it is \
about if it forecasts nothing.

Locations:
{loc_lines}

Post:
<post>
{text}
</post>"""


def extract(client, text: str, published: str, locations: list[dict]) -> Optional[Extraction]:
    response = client.beta.messages.parse(
        model=MODEL,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": build_prompt(text, published, locations)}],
        output_format=Extraction,
    )
    if response.stop_reason == "refusal":
        print(f"  declined: {getattr(response.stop_details, 'category', None)}", file=sys.stderr)
        return None
    return response.parsed_output


def clean_calls(ex: Extraction, published: str, valid_ids: set[str]) -> list[dict]:
    """Drop ids not in the app, impossible dates and nonsense amounts."""
    posted = dt.datetime.fromisoformat(published).astimezone(MOUNTAIN).date()
    calls = []
    for c in ex.calls:
        ids = sorted({i for i in c.location_ids if i in valid_ids})
        try:
            a = dt.date.fromisoformat(c.start_date)
            b = dt.date.fromisoformat(c.end_date)
        except ValueError:
            continue
        lo, hi = sorted((c.low_in, c.high_in))
        if not ids or b < a or a < posted - dt.timedelta(days=1) or (b - a).days >= MAX_WINDOW_DAYS:
            continue
        if lo < 0 or hi > 120:
            continue
        calls.append({"locations": ids, "start": a.isoformat(), "end": b.isoformat(), "lowIn": round(lo, 1), "highIn": round(hi, 1)})
    return calls


# ---------------------------------------------------------------- skill


def daterange(a: str, b: str) -> list[str]:
    d0, d1 = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
    return [(d0 + dt.timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]


def score(posts: list[dict], past: Optional[dict], today: dt.date) -> dict:
    """Seth's call midpoints vs station-measured snow, beside our day-before forecast for the same days."""
    seth_err, our_err = [], []
    days_by_loc = {}
    if past:
        for lid, loc in past.get("locations", {}).items():
            days_by_loc[lid] = {d["d"]: d for d in loc.get("days", [])}
    # When Seth updates a storm, only his latest call for each location and day range counts.
    latest: dict[tuple, tuple[str, dict]] = {}
    for p in posts:
        for c in p.get("calls", []):
            for lid in c["locations"]:
                key = (lid, c["start"], c["end"])
                if key not in latest or p["published"] > latest[key][0]:
                    latest[key] = (p["published"], c)
    for (lid, start, end), (_, c) in latest.items():
        if dt.date.fromisoformat(end) >= today or lid not in days_by_loc:
            continue
        days = [days_by_loc[lid].get(d) for d in daterange(start, end)]
        if any(d is None or d.get("a") is None or d.get("p") is None for d in days):
            continue
        actual = sum(d["a"] for d in days)
        ours = sum(d["p"] for d in days)
        seth = (c["lowIn"] + c["highIn"]) / 2
        if max(actual, ours, seth) < 1:
            continue
        seth_err.append(abs(seth - actual))
        our_err.append(abs(ours - actual))
    n = len(seth_err)
    if n == 0:
        return {"n": 0, "sethMaeIn": None, "oursMaeIn": None, "weight": PRIOR_WEIGHT, "prior": PRIOR_WEIGHT}
    s = sum(seth_err) / n
    o = sum(our_err) / n
    eps = 0.25  # inches; keeps a perfect score on a handful of calls from taking over
    learned = (o + eps) ** 2 / ((o + eps) ** 2 + (s + eps) ** 2)
    w = (PRIOR_WEIGHT * SHRINK_N + learned * n) / (SHRINK_N + n)
    return {
        "n": n,
        "sethMaeIn": round(s, 2),
        "oursMaeIn": round(o, 2),
        "weight": round(min(MAX_WEIGHT, max(MIN_WEIGHT, w)), 3),
        "prior": PRIOR_WEIGHT,
    }


# ---------------------------------------------------------------- main


def load_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--feed", default=os.environ.get("SETH_FEED_URL", ""), help="RSS/Atom/JSON feed of the Facebook page")
    ap.add_argument("--text", help="file holding one post's text, added by hand")
    ap.add_argument("--url", default="", help="link to the hand-added post")
    ap.add_argument("--published", help="when the hand-added post went up (ISO); default now")
    ap.add_argument("--rescore", action="store_true", help="only recompute the skill score")
    args = ap.parse_args(argv)

    old = load_json(OUT_JSON) or {}
    posts: list[dict] = old.get("posts", []) if old.get("version") == VERSION else []
    known = {p["id"] for p in posts}

    incoming: list[dict] = []
    if not args.rescore:
        if args.text:
            text = Path(args.text).read_text(encoding="utf-8").strip()
            if text:
                incoming.append({"id": post_id(args.url, text), "url": args.url, "published": normalize_time(args.published), "text": text})
        if args.feed:
            try:
                incoming += fetch_feed(args.feed)
            except (requests.RequestException, ValueError) as e:
                print(f"feed failed: {e}", file=sys.stderr)
        elif not args.text:
            print("SETH_FEED_URL is not set and no --text given; rescoring only.")
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=KEEP_DAYS)).isoformat()
    new = [p for p in incoming if p["id"] not in known and p["published"] >= cutoff][:MAX_NEW_POSTS]

    if new:
        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            print("ANTHROPIC_API_KEY is not set: can't read the posts. Add it as a repository secret.", file=sys.stderr)
            return 1
        import anthropic

        client = anthropic.Anthropic()
        locations = parse_locations()
        valid = {l["id"] for l in locations}
        for p in new:
            print(f"post {p['id']} ({p['published']})")
            try:
                ex = extract(client, p["text"], p["published"], locations)
            except anthropic.APIStatusError as e:
                print(f"  API error {e.status_code}; will retry next run", file=sys.stderr)
                continue
            except anthropic.APIConnectionError as e:
                print(f"  connection error: {e}; will retry next run", file=sys.stderr)
                continue
            if ex is None:
                continue
            calls = clean_calls(ex, p["published"], valid)
            print(f"  {len(calls)} call(s): {ex.summary}")
            posts.append({"id": p["id"], "url": p["url"], "published": p["published"], "summary": ex.summary.strip(), "calls": calls})

    posts = sorted((p for p in posts if p["published"] >= cutoff), key=lambda p: p["published"], reverse=True)
    today = dt.datetime.now(MOUNTAIN).date()
    out = {
        "version": VERSION,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": "Seth's Weather Report",
        "pageUrl": PAGE_URL,
        "skill": score(posts, load_json(PAST_JSON), today),
        "posts": posts,
    }
    if old and {k: v for k, v in old.items() if k != "generated"} == {k: v for k, v in out.items() if k != "generated"}:
        print("no change")
        return 0
    OUT_JSON.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT_JSON.name}: {len(posts)} posts, skill {out['skill']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
