"""Build dist/dashboard.html: the dashboard as one self-contained file.

The rows of v_order_details are exported from the database and embedded in the
page together with the CSS, Chart.js and the app scripts, so the file opens
from disk or any static host with no server. Filtering runs in the browser via
app/static/local-engine.js, which applies the same rules as app/queries.py
(tests/test_metrics.py checks they agree).

Usage:  python scripts/build_static.py [--db sales.db] [--out dist/dashboard.html] [--cdn]
        --cdn loads Chart.js from cdnjs instead of inlining it (smaller file for web hosting)
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT.parent / "frontend"

EXPORT_COLUMNS = [
    "Order_ID", "Order_Date", "Order_Month", "Order_Status", "Is_Cancelled", "Is_Returned",
    "Product_ID", "Product_Name", "Category", "Quantity", "Net_Amount_INR",
    "Customer_ID", "Customer_Name", "City", "Customer_Segment",
]


def export_rows(db: Path) -> list[dict]:
    conn = sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        cur = conn.execute(f"SELECT {', '.join(EXPORT_COLUMNS)} FROM v_order_details ORDER BY Order_Date, Order_ID")
        return [dict(zip(EXPORT_COLUMNS, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def safe_script(text: str) -> str:
    # keep "</script>" inside inlined code or JSON from closing the tag
    return text.replace("</script", "<\\/script")


CHART_CDN = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"


def build(db: Path, out: Path, cdn: bool = False) -> None:
    rows = export_rows(db)
    payload = {
        "meta": {"exported_at": dt.date.today().isoformat(), "rows": len(rows), "source": "v_order_details"},
        "rows": rows,
    }
    html = (STATIC / "index.html").read_text(encoding="utf-8")

    def inline_script(match: re.Match) -> str:
        src = match.group(1)
        return "<script>\n" + safe_script((STATIC / src).read_text(encoding="utf-8")) + "\n</script>"

    css = (STATIC / "styles.css").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="styles.css">', "<style>\n" + css + "\n</style>")
    data_tag = "<script>window.EMBEDDED_DATA = " + safe_script(json.dumps(payload, separators=(",", ":"))) + ";</script>\n"
    html = html.replace('<script src="vendor/chart.umd.min.js"></script>',
                        data_tag + '<script src="vendor/chart.umd.min.js"></script>')
    if cdn:
        html = html.replace('<script src="vendor/chart.umd.min.js"></script>', f'<script src="{CHART_CDN}"></script>')
    html = re.sub(r'<script src="((?!https?:)[^"]+)"></script>', inline_script, html)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(rows)} rows)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=ROOT / "sales.db")
    parser.add_argument("--out", type=Path, default=ROOT.parent / "dist" / "dashboard.html")
    parser.add_argument("--cdn", action="store_true", help="load Chart.js from cdnjs instead of inlining it")
    args = parser.parse_args()
    if not args.db.exists():
        print(f"{args.db} not found - run: python etl/load_data.py", file=sys.stderr)
        return 1
    build(args.db, args.out, args.cdn)
    return 0


if __name__ == "__main__":
    sys.exit(main())