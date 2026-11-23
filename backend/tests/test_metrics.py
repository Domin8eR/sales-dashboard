"""Checks for the load, the relationships and every dashboard metric.

    python -m unittest discover -s tests -v

1. Load: row counts reconcile and the join loses no orders.
2. Constraints: the database rejects an orphan order, a duplicate key and a
   cancelled order with revenue.
3. Metrics: every number the dashboard shows is recomputed straight from the
   Excel files (no SQL) and compared with the SQL result.
4. Parity: the standalone build's JavaScript engine gives the same output as
   the SQL for a set of filter combinations (skipped if Node.js is missing).
"""

from __future__ import annotations

import collections
from contextlib import closing
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(ROOT / "scripts"))

import load_data  # noqa: E402
import queries  # noqa: E402
import build_static  # noqa: E402

CUSTOMERS_XLSX = ROOT.parent / "data" / "customers.xlsx"
ORDERS_XLSX = ROOT.parent / "data" / "orders.xlsx"


def excel_rows(path, columns):
    names = list(columns)
    return [dict(zip(names, r)) for r in load_data.read_sheet(path, columns)]


class LoadedDatabase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.db = Path(cls.tmp) / "test.db"
        load_data.load(cls.db, CUSTOMERS_XLSX, ORDERS_XLSX)
        cls.customers = excel_rows(CUSTOMERS_XLSX, load_data.CUSTOMER_COLUMNS)
        cls.orders = excel_rows(ORDERS_XLSX, load_data.ORDER_COLUMNS)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def connect(self):
        conn = sqlite3.connect(self.db)
        conn.execute("PRAGMA foreign_keys = ON")
        return conn


class TestLoad(LoadedDatabase):
    def test_row_counts(self):
        with closing(self.connect()) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM customers").fetchone()[0], len(self.customers))
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0], len(self.orders))

    def test_join_keeps_every_order(self):
        with closing(self.connect()) as conn:
            joined = conn.execute("SELECT COUNT(*) FROM v_order_details").fetchone()[0]
            self.assertEqual(joined, len(self.orders))

    def test_customer_summary_keeps_customers_without_orders(self):
        with closing(self.connect()) as conn:
            n = conn.execute("SELECT COUNT(*) FROM v_customer_summary").fetchone()[0]
            self.assertEqual(n, len(self.customers))

    def test_declared_relationship(self):
        with closing(self.connect()) as conn:
            fks = conn.execute("PRAGMA foreign_key_list(orders)").fetchall()
            self.assertEqual([(f[2], f[3], f[4]) for f in fks], [("customers", "Customer_ID", "Customer_ID")])
            self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])


class TestConstraints(LoadedDatabase):
    def insert_order(self, conn, **overrides):
        row = {
            "Order_ID": "OTEST", "Customer_ID": self.customers[0]["Customer_ID"], "Order_Date": "2026-01-15",
            "Product_ID": "P001", "Product_Name": "Wireless Mouse", "Category": "Accessories", "Quantity": 1,
            "Unit_Price_INR": 899, "Discount_Rate": 0.0, "Net_Amount_INR": 899, "Payment_Method": "UPI",
            "Order_Status": "Completed",
        }
        row.update(overrides)
        conn.execute(f"INSERT INTO orders ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})", list(row.values()))

    def assertRejected(self, **overrides):
        conn = self.connect()
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                self.insert_order(conn, **overrides)
        finally:
            conn.rollback()
            conn.close()

    def test_orphan_order_rejected(self):
        self.assertRejected(Customer_ID="C9999")

    def test_duplicate_order_id_rejected(self):
        self.assertRejected(Order_ID=self.orders[0]["Order_ID"])

    def test_cancelled_order_with_revenue_rejected(self):
        self.assertRejected(Order_Status="Cancelled", Net_Amount_INR=500)

    def test_unknown_status_rejected(self):
        self.assertRejected(Order_Status="Shipped")

    def test_bad_date_rejected(self):
        self.assertRejected(Order_Date="2026-02-30")

    def test_customer_with_orders_cannot_be_deleted(self):
        conn = self.connect()
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("DELETE FROM customers WHERE Customer_ID = ?", (self.orders[0]["Customer_ID"],))
        finally:
            conn.rollback()
            conn.close()


class TestMetrics(LoadedDatabase):
    """Recompute everything from the Excel rows in plain Python and compare."""

    def expected(self, keep=lambda o, c: True):
        cust = {c["Customer_ID"]: c for c in self.customers}
        rows = [o for o in self.orders if keep(o, cust[o["Customer_ID"]])]
        non_cancelled = [o for o in rows if o["Order_Status"] != "Cancelled"]
        net = sum(o["Net_Amount_INR"] for o in rows)

        def revenue_by(key):
            acc = collections.Counter()
            for o in rows:
                acc[key(o)] += o["Net_Amount_INR"]
            return dict(acc)

        per_customer = collections.Counter(o["Customer_ID"] for o in non_cancelled)
        return {
            "net_revenue": net,
            "orders": len({o["Order_ID"] for o in rows}),
            "customers": len({o["Customer_ID"] for o in rows}),
            "aov": net / len({o["Order_ID"] for o in non_cancelled}),
            "returned_orders": sum(o["Order_Status"] == "Returned" for o in rows),
            "repeat_customers": sum(1 for n in per_customer.values() if n >= 2),
            "monthly": revenue_by(lambda o: o["Order_Date"][:7]),
            "daily": revenue_by(lambda o: o["Order_Date"]),
            "by_category": revenue_by(lambda o: o["Category"]),
            "by_segment": revenue_by(lambda o: cust[o["Customer_ID"]]["Customer_Segment"]),
            "by_city": revenue_by(lambda o: cust[o["Customer_ID"]]["City"]),
            "by_status": dict(collections.Counter(o["Order_Status"] for o in rows)),
        }

    def check(self, filters: queries.Filters, keep):
        exp = self.expected(keep)
        with closing(self.connect()) as conn:
            got = queries.dashboard(conn, filters)
        k = got["kpis"]
        self.assertEqual(k["net_revenue"], exp["net_revenue"])
        self.assertEqual(k["orders"], exp["orders"])
        self.assertEqual(k["customers"], exp["customers"])
        self.assertAlmostEqual(k["aov"], exp["aov"], places=6)
        self.assertEqual(k["returned_orders"], exp["returned_orders"])
        self.assertEqual(k["repeat_customers"], exp["repeat_customers"])
        self.assertEqual({r["month"]: r["net_revenue"] for r in got["monthly"]}, exp["monthly"])
        self.assertEqual({r["day"]: r["net_revenue"] for r in got["daily"]}, exp["daily"])
        for key in ("by_category", "by_segment", "by_city"):
            self.assertEqual({r["label"]: r["net_revenue"] for r in got[key]}, exp[key], key)
        self.assertEqual({r["label"]: r["orders"] for r in got["by_status"]}, exp["by_status"])

    def test_unfiltered(self):
        self.check(queries.Filters(), lambda o, c: True)

    def test_headline_numbers(self):
        # Pinned values for the supplied files, also quoted in the README.
        with closing(self.connect()) as conn:
            k = queries.dashboard(conn, queries.Filters())["kpis"]
        self.assertEqual(k["net_revenue"], 1_159_206)
        self.assertEqual(k["orders"], 240)
        self.assertEqual(k["customers"], 59)
        self.assertEqual(k["non_cancelled_orders"], 204)
        self.assertEqual(round(k["aov"], 2), 5682.38)

    def test_cancelled_orders_carry_no_revenue(self):
        with closing(self.connect()) as conn:
            got = queries.dashboard(conn, queries.Filters(lists={"status": ["Cancelled"]}))
        self.assertEqual(got["kpis"]["net_revenue"], 0)
        self.assertIsNone(got["kpis"]["aov"])  # no non-cancelled orders -> no AOV, not a divide-by-zero

    def test_date_and_category_filter(self):
        self.check(
            queries.Filters(start="2026-03-01", end="2026-04-30", lists={"category": ["Electronics", "Office"]}),
            lambda o, c: "2026-03-01" <= o["Order_Date"] <= "2026-04-30" and o["Category"] in ("Electronics", "Office"),
        )

    def test_segment_city_status_filter(self):
        self.check(
            queries.Filters(lists={"segment": ["Corporate"], "city": ["Hyderabad", "Pune"], "status": ["Completed", "Returned"]}),
            lambda o, c: c["Customer_Segment"] == "Corporate" and c["City"] in ("Hyderabad", "Pune")
            and o["Order_Status"] in ("Completed", "Returned"),
        )

    def test_filter_injection_is_inert(self):
        with closing(self.connect()) as conn:
            got = queries.dashboard(conn, queries.Filters(lists={"city": ["Pune' OR '1'='1"]}))
        self.assertEqual(got["kpis"]["orders"], 0)


FILTER_CASES = [
    {},
    {"start": "2026-02-01", "end": "2026-05-31"},
    {"category": ["Electronics"], "status": ["Returned"]},
    {"segment": ["Consumer", "Small Business"], "city": ["Mumbai", "Delhi", "Chennai"]},
    {"start": "2026-06-01", "category": ["Lifestyle", "Office"], "status": ["Completed", "Cancelled"]},
    {"city": ["Nowhere"]},
]


@unittest.skipUnless(shutil.which("node"), "Node.js not installed")
class TestStaticParity(LoadedDatabase):
    """The standalone page's JS engine must match the SQL exactly."""

    def test_js_engine_matches_sql(self):
        rows = build_static.export_rows(self.db)
        engine = ROOT.parent / "frontend" / "local-engine.js"
        script = (
            "const e=require(process.argv[1]);let s='';process.stdin.on('data',d=>s+=d);"
            "process.stdin.on('end',()=>{const p=JSON.parse(s);"
            "console.log(JSON.stringify(p.cases.map(f=>e.dashboard(p.rows,f))))})"
        )
        out = subprocess.run(["node", "-e", script, str(engine)], input=json.dumps({"rows": rows, "cases": FILTER_CASES}),
                             capture_output=True, text=True, check=True)
        js_results = json.loads(out.stdout)

        for case, js in zip(FILTER_CASES, js_results):
            params = {k: (v if isinstance(v, list) else [v]) for k, v in case.items()}
            with closing(self.connect()) as conn:
                sql = queries.dashboard(conn, queries.Filters.from_query(params))
            with self.subTest(filters=case):
                js_k, sql_k = js.pop("kpis"), sql.pop("kpis")
                for key in sql_k:
                    if key == "aov" and sql_k[key] is not None:
                        self.assertAlmostEqual(js_k[key], sql_k[key], places=6)
                    else:
                        self.assertEqual(js_k[key], sql_k[key], key)
                self.assertEqual(js, sql)


if __name__ == "__main__":
    unittest.main()