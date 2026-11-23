"""Tiny web server for the sales dashboard (Python standard library only).

  GET /                 -> dashboard page (app/static/index.html)
  GET /api/options      -> filter values and the date range
  GET /api/dashboard    -> every metric and chart series for the active filters
                           ?start=YYYY-MM-DD&end=YYYY-MM-DD
                           &category=..&segment=..&city=..&status=..  (repeat for several values)

Usage:  python app/server.py [--db sales.db] [--host 127.0.0.1] [--port 8000]
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sqlite3
import sys
from contextlib import closing
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import queries  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT.parent / "frontend"


def make_handler(db_path: Path):
    class Handler(BaseHTTPRequestHandler):
        def _connect(self) -> sqlite3.Connection:
            # read-only connection: the dashboard never writes
            conn = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)
            conn.execute("PRAGMA foreign_keys = ON")
            return conn

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, payload, status: int = 200) -> None:
            self._send(status, json.dumps(payload).encode(), "application/json")

        def do_GET(self):  # noqa: N802
            url = urlparse(self.path)
            try:
                if url.path == "/api/options":
                    with closing(self._connect()) as conn:
                        return self._json(queries.options(conn))
                if url.path == "/api/dashboard":
                    filters = queries.Filters.from_query(parse_qs(url.query))
                    with closing(self._connect()) as conn:
                        return self._json(queries.dashboard(conn, filters))
                return self._static(url.path)
            except ValueError as exc:
                return self._json({"error": f"bad parameter: {exc}"}, HTTPStatus.BAD_REQUEST)
            except sqlite3.Error as exc:
                return self._json({"error": f"database error: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

        def _static(self, path: str):
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            target = (STATIC / rel).resolve()
            if STATIC not in target.parents or not target.is_file():
                return self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            return self._send(HTTPStatus.OK, target.read_bytes(), ctype)

        def log_message(self, fmt, *args):
            sys.stderr.write(f"{self.address_string()} {fmt % args}\n")

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=ROOT / "sales.db")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not args.db.exists():
        print(f"{args.db} not found - run: python etl/load_data.py", file=sys.stderr)
        return 1
    server = ThreadingHTTPServer((args.host, args.port), make_handler(args.db.resolve()))
    print(f"Dashboard running at http://{args.host}:{args.port}  (db: {args.db})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())