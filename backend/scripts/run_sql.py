"""Run a .sql file against sales.db and print each result set.

A stand-in for the sqlite3 command-line shell, which is not always installed:
    python scripts/run_sql.py sql/03_metrics.sql [--db sales.db]
Shell dot-commands such as `.headers on` are skipped.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def statements(sql: str):
    sql = re.sub(r"^\s*\.\w+.*$", "", sql, flags=re.M)   # drop dot-commands
    buf = ""
    for line in sql.splitlines(keepends=True):
        buf += line
        if sqlite3.complete_statement(buf):
            if buf.strip():
                yield buf.strip()
            buf = ""


def print_table(cur: sqlite3.Cursor) -> None:
    names = [d[0] for d in cur.description]
    rows = [["" if v is None else str(v) for v in r] for r in cur.fetchall()]
    widths = [max(len(n), *(len(r[i]) for r in rows)) if rows else len(n) for i, n in enumerate(names)]
    print("  ".join(n.ljust(w) for n, w in zip(names, widths)))
    print("  ".join("-" * w for w in widths))
    for r in rows:
        print("  ".join(v.ljust(w) for v, w in zip(r, widths)))
    print()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path)
    parser.add_argument("--db", type=Path, default=ROOT / "sales.db")
    args = parser.parse_args()
    conn = sqlite3.connect(args.db.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        for stmt in statements(args.file.read_text(encoding="utf-8")):
            cur = conn.execute(stmt)
            if cur.description:
                print_table(cur)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())