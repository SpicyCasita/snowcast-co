"""Resort-reported snowfall: each resort's own morning snow report, as republished by OnTheSnow.

One page (onthesnow.com/colorado/skireport) carries every Colorado resort's latest report: new snow
over the last 24/48/72 h and base depth (in cm), whether the resort is open, and when the report
was updated. This script reads it and merges into app/public/data/resort-reports.json, which keeps a
rolling history so the app can show the resort's number next to the station's and our forecast's.

Day convention: a report's 24 h total is dated by the day the snow fell, taken as the report time
(Mountain Time) minus 12 hours, so a 6am Tuesday report counts as Monday's snow. Only reports
updated within FRESH_HOURS are recorded, whatever the open flag says (Wolf Creek posts daily while
flagged 3, apparently weekends-only); a resort that hasn't posted adds nothing rather than repeating
an old number.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

from common import ROOT

URL = "https://www.onthesnow.com/colorado/skireport"
OUT_JSON = ROOT.parent / "app" / "public" / "data" / "resort-reports.json"
MOUNTAIN = ZoneInfo("America/Denver")
CM_PER_IN = 2.54
FRESH_HOURS = 30
KEEP_DAYS = 60

# App resort id -> OnTheSnow slug. The four Aspen Snowmass mountains share one report.
SLUGS = {
    "abasin": "arapahoe-basin-ski-area",
    "aspen-mtn": "aspen-snowmass",
    "aspen-highlands": "aspen-snowmass",
    "beaver-creek": "beaver-creek",
    "breckenridge": "breckenridge",
    "buttermilk": "aspen-snowmass",
    "copper": "copper-mountain-resort",
    "crested-butte": "crested-butte-mountain-resort",
    "echo": "echo-mountain",
    "eldora": "eldora-mountain-resort",
    "granby-ranch": "ski-granby-ranch",
    "keystone": "keystone",
    "loveland": "loveland",
    "monarch": "monarch-mountain",
    "powderhorn": "powderhorn",
    "purgatory": "durango-mountain-resort",
    "silverton": "silverton-mountain",
    "ski-cooper": "ski-cooper",
    "snowmass": "aspen-snowmass",
    "steamboat": "steamboat",
    "sunlight": "sunlight-mountain-resort",
    "telluride": "telluride",
    "vail": "vail",
    "winter-park": "winter-park-resort",
    "wolf-creek": "wolf-creek-ski-area",
}

PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)')
ROW_RE = re.compile(r"^([0-9a-f]+):([\[{].*)$")


def rsc_rows(html: str) -> dict[str, object]:
    """Next.js flight payload -> {row id: parsed JSON}. Rows that aren't plain JSON are skipped."""
    text = "".join(json.loads(s) for s in PUSH_RE.findall(html))
    rows: dict[str, object] = {}
    for line in text.split("\n"):
        m = ROW_RE.match(line)
        if not m:
            continue
        try:
            rows[m.group(1)] = json.loads(m.group(2))
        except json.JSONDecodeError:
            pass
    return rows


def resolve(v, rows: dict[str, object], depth: int = 0):
    """Follow "$id" references between rows."""
    if depth > 6:
        return v
    if isinstance(v, str) and v.startswith("$") and v[1:] in rows:
        return resolve(rows[v[1:]], rows, depth + 1)
    if isinstance(v, dict):
        return {k: resolve(x, rows, depth + 1) for k, x in v.items()}
    if isinstance(v, list):
        return [resolve(x, rows, depth + 1) for x in v]
    return v


def cm_to_in(v) -> float | None:
    return None if v is None else round(float(v) / CM_PER_IN, 1)


def parse_reports(html: str) -> dict[str, dict]:
    """OnTheSnow slug -> latest report fields."""
    rows = rsc_rows(html)
    out: dict[str, dict] = {}
    for row in rows.values():
        if not (isinstance(row, dict) and "slug" in row and "snow" in row and "updatedAt" in row):
            continue
        r = resolve(row, rows)
        snow, status = r.get("snow") or {}, r.get("status") or {}
        if not isinstance(snow, dict):
            continue
        out[r["slug"]] = {
            "name": r.get("title_short") or r.get("title"),
            "updatedAt": r.get("updatedAt"),
            "open": status.get("openFlag") == 1 if isinstance(status, dict) else False,
            "openingDate": status.get("openingDate") if isinstance(status, dict) else None,
            "new24In": cm_to_in(snow.get("last24")),
            "new48In": cm_to_in(snow.get("last48")),
            "new72In": cm_to_in(snow.get("last72")),
            # Base-area depth, else mid-mountain (A-Basin only reports mid).
            "depthIn": cm_to_in(snow.get("base") if snow.get("base") is not None else snow.get("middle")),
        }
    return out


def snow_day(updated_at: str) -> str:
    t = dt.datetime.fromisoformat(updated_at).astimezone(MOUNTAIN)
    return (t - dt.timedelta(hours=12)).date().isoformat()


def merge(doc: dict, reports: dict[str, dict], now: dt.datetime) -> dict:
    resorts = doc.setdefault("resorts", {})
    cutoff = (now.astimezone(MOUNTAIN).date() - dt.timedelta(days=KEEP_DAYS)).isoformat()
    for rid, slug in SLUGS.items():
        prev = resorts.get(rid, {})
        days = {d: v for d, v in prev.get("days", {}).items() if d >= cutoff}
        rep = reports.get(slug)
        entry = {"slug": slug, "days": days, "latest": prev.get("latest"), "open": prev.get("open", False), "openingDate": prev.get("openingDate")}
        if rep:
            entry.update(open=rep["open"], openingDate=rep["openingDate"])
            fresh = rep["updatedAt"] and now - dt.datetime.fromisoformat(rep["updatedAt"]) <= dt.timedelta(hours=FRESH_HOURS)
            if fresh and rep["new24In"] is not None:
                entry["latest"] = {k: rep[k] for k in ("updatedAt", "new24In", "new48In", "new72In", "depthIn")}
                days[snow_day(rep["updatedAt"])] = rep["new24In"]
        entry["days"] = dict(sorted(days.items()))
        resorts[rid] = entry
    doc.update(version=1, source="Resort-reported via OnTheSnow", dayConvention="date = day the snow fell (report time in Mountain Time minus 12 h)", generated=now.replace(microsecond=0).isoformat())
    return doc


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(OUT_JSON))
    ap.add_argument("--html", help="parse a saved page instead of fetching")
    args = ap.parse_args()

    if args.html:
        html = Path(args.html).read_text(encoding="utf-8")
    else:
        res = requests.get(URL, headers={"User-Agent": "SnowCastCO/1.0 (personal snowfall app; github.com/SpicyCasita/snowcast-co)"}, timeout=60)
        res.raise_for_status()
        html = res.text
    reports = parse_reports(html)
    missing = sorted({s for s in SLUGS.values() if s not in reports})
    if len(missing) == len(set(SLUGS.values())):
        raise SystemExit("no resort reports found: the page layout probably changed")
    if missing:
        print(f"  not on the page: {', '.join(missing)}")

    out = Path(args.out)
    doc = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    doc = merge(doc, reports, dt.datetime.now(dt.timezone.utc))
    out.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    reporting = [rid for rid, e in doc["resorts"].items() if e["latest"] and e["latest"]["updatedAt"] in {r["updatedAt"] for r in reports.values()}]
    print(f"wrote {out}: {len(reports)} reports on the page, {len(reporting)} of {len(SLUGS)} app resorts with a current report")


if __name__ == "__main__":
    main()
