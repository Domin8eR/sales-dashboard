"""Load customers.xlsx and orders.xlsx into the SQLite database.

Steps
  1. Apply sql/01_schema.sql (drops and recreates the tables, so reruns are safe).
  2. Read each workbook, check the headers, and convert every cell to the
     column's database type (trimmed text, ISO dates, integers, reals).
  3. Insert customers first, then orders, in one transaction. Primary key,
     foreign key and CHECK constraints reject bad rows; any failure rolls the
     whole load back.
  4. Apply sql/02_views.sql and print a reconciliation summary.

Usage
  python etl/load_data.py                       # defaults below
  python etl/load_data.py --db sales.db --customers data/customers.xlsx --orders data/orders.xlsx
"""

from __future__ import annotations

import argparse
import datetime as dt
import sqlite3
import sys
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent.parent
SQL_DIR = ROOT / "sql"

# column name -> converter. Order matters: it is the insert order.
CUSTOMER_COLUMNS = {
    "Customer_ID": "text",
    "Customer_Name": "text",
    "Email": "text",
    "City": "text",
    "State": "text",
    "Customer_Segment": "text",
    "Join_Date": "date",
    "Acquisition_Channel": "text",
}

ORDER_COLUMNS = {
    "Order_ID": "text",
    "Customer_ID": "text",
    "Order_Date": "date",
    "Product_ID": "text",
    "Product_Name": "text",
    "Category": "text",
    "Quantity": "int",
    "Unit_Price_INR": "int",
    "Discount_Rate": "real",
    "Net_Amount_INR": "int",
    "Payment_Method": "text",
    "Order_Status": "text",
}


class LoadError(Exception):
    pass


def convert(value, kind: str, where: str):
    """Convert one Excel cell to its database type, or raise LoadError."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        raise LoadError(f"{where}: empty value")
    if kind == "text":
        return " ".join(str(value).split())  # trim and collapse inner whitespace
    if kind == "date":
        if isinstance(value, dt.datetime):
            return value.date().isoformat()
        if isinstance(value, dt.date):
            return value.isoformat()
        try:
            return dt.date.fromisoformat(str(value).strip()[:10]).isoformat()
        except ValueError as exc:
            raise LoadError(f"{where}: not a date: {value!r}") from exc
    if kind == "int":
        number = float(value)
        if not number.is_integer():
            raise LoadError(f"{where}: expected a whole number, got {value!r}")
        return int(number)
    if kind == "real":
        return float(value)
    raise ValueError(kind)


def read_sheet(path: Path, columns: dict[str, str]) -> list[tuple]:
    """Read the first sheet of a workbook into typed tuples in `columns` order."""
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h is not None else "" for h in next(rows)]

    missing = [c for c in columns if c not in header]
    if missing:
        raise LoadError(f"{path.name}: missing columns {missing}")
    index = {name: header.index(name) for name in columns}

    records = []
    for line_no, row in enumerate(rows, start=2):
        if row is None or all(v is None for v in row):
            continue  # skip blank trailing rows
        records.append(tuple(
            convert(row[index[name]], kind, f"{path.name} row {line_no} {name}")
            for name, kind in columns.items()
        ))
    wb.close()
    return records


def run_sql_file(conn: sqlite3.Connection, name: str) -> None:
    conn.executescript((SQL_DIR / name).read_text(encoding="utf-8"))


def insert(conn: sqlite3.Connection, table: str, columns: dict[str, str], rows: list[tuple]) -> None:
    cols = ", ".join(columns)
    marks = ", ".join("?" for _ in columns)
    conn.executemany(f"INSERT INTO {table} ({cols}) VALUES ({marks})", rows)


def summarise(conn: sqlite3.Connection, n_customers: int, n_orders: int) -> None:
    q = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
    db_customers = q("SELECT COUNT(*) FROM customers")
    db_orders = q("SELECT COUNT(*) FROM orders")
    joined = q("SELECT COUNT(*) FROM v_order_details")
    no_orders = q("SELECT COUNT(*) FROM v_customer_summary WHERE Total_Orders = 0")
    fk_problems = conn.execute("PRAGMA foreign_key_check").fetchall()

    print(f"customers: {n_customers} rows read, {db_customers} loaded")
    print(f"orders:    {n_orders} rows read, {db_orders} loaded")
    print(f"joined view rows: {joined} (should equal orders loaded)")
    print(f"customers with no orders: {no_orders}")
    print(f"foreign key violations: {len(fk_problems)}")

    # Soft check: the stored net amount should match qty x price x (1 - discount)
    # for non-cancelled orders. Reported, not enforced, because the source owns it.
    mismatches = q("""
        SELECT COUNT(*) FROM orders
        WHERE Order_Status <> 'Cancelled'
          AND abs(Net_Amount_INR - round(Quantity * Unit_Price_INR * (1 - Discount_Rate))) > 1
    """)
    print(f"net amount mismatches vs qty x price x (1 - discount): {mismatches}")

    if db_customers != n_customers or db_orders != n_orders or joined != db_orders or fk_problems:
        raise LoadError("reconciliation failed")


def load(db_path: Path, customers_path: Path, orders_path: Path) -> None:
    customers = read_sheet(customers_path, CUSTOMER_COLUMNS)
    orders = read_sheet(orders_path, ORDER_COLUMNS)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        run_sql_file(conn, "01_schema.sql")
        with conn:  # one transaction: all rows or none
            insert(conn, "customers", CUSTOMER_COLUMNS, customers)
            insert(conn, "orders", ORDER_COLUMNS, orders)
        run_sql_file(conn, "02_views.sql")
        summarise(conn, len(customers), len(orders))
    except sqlite3.IntegrityError as exc:
        raise LoadError(f"constraint violation: {exc}") from exc
    finally:
        conn.close()
    print(f"database written to {db_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=ROOT / "sales.db")
    parser.add_argument("--customers", type=Path, default=ROOT.parent / "data" / "customers.xlsx")
    parser.add_argument("--orders", type=Path, default=ROOT.parent / "data" / "orders.xlsx")
    args = parser.parse_args(argv)
    try:
        load(args.db, args.customers, args.orders)
    except LoadError as exc:
        print(f"LOAD FAILED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())