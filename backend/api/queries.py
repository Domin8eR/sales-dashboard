"""SQL behind every dashboard visual, with the active filters applied.

Each query reads the joined view v_order_details. Filters are turned into a
parameterised WHERE clause; column names come only from the FILTER_COLUMNS
whitelist, and every user-supplied value is bound as a parameter.
"""

from __future__ import annotations

import datetime as dt
import sqlite3
from dataclasses import dataclass, field

# filter key in the URL -> column in v_order_details
FILTER_COLUMNS = {
    "category": "Category",
    "segment": "Customer_Segment",
    "city": "City",
    "status": "Order_Status",
}


@dataclass
class Filters:
    start: str | None = None          # inclusive, YYYY-MM-DD
    end: str | None = None            # inclusive, YYYY-MM-DD
    lists: dict[str, list[str]] = field(default_factory=dict)

    @classmethod
    def from_query(cls, params: dict[str, list[str]]) -> "Filters":
        def date_or_none(key):
            raw = (params.get(key) or [""])[0].strip()
            if not raw:
                return None
            return dt.date.fromisoformat(raw).isoformat()  # raises ValueError if bad

        lists = {}
        for key in FILTER_COLUMNS:
            # one value per repeated parameter (?city=Pune&city=Delhi)
            values = [v.strip() for v in params.get(key, []) if v.strip()]
            if values:
                lists[key] = list(dict.fromkeys(values))  # de-duplicate, keep order
        return cls(start=date_or_none("start"), end=date_or_none("end"), lists=lists)

    def where(self) -> tuple[str, list]:
        clauses, args = [], []
        if self.start:
            clauses.append("Order_Date >= ?")
            args.append(self.start)
        if self.end:
            clauses.append("Order_Date <= ?")
            args.append(self.end)
        for key, values in self.lists.items():
            column = FILTER_COLUMNS[key]
            clauses.append(f"{column} IN ({', '.join('?' for _ in values)})")
            args.extend(values)
        return ("WHERE " + " AND ".join(clauses)) if clauses else "", args


def _rows(conn: sqlite3.Connection, sql: str, args: list) -> list[dict]:
    cur = conn.execute(sql, args)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def options(conn: sqlite3.Connection) -> dict:
    """Values for the filter controls, plus the full date range."""
    distinct = lambda col: [r[0] for r in conn.execute(  # noqa: E731
        f"SELECT DISTINCT {col} FROM v_order_details ORDER BY {col}")]
    lo, hi = conn.execute("SELECT MIN(Order_Date), MAX(Order_Date) FROM v_order_details").fetchone()
    return {
        "min_date": lo,
        "max_date": hi,
        "category": distinct("Category"),
        "segment": distinct("Customer_Segment"),
        "city": distinct("City"),
        "status": distinct("Order_Status"),
    }


def dashboard(conn: sqlite3.Connection, filters: Filters) -> dict:
    where, args = filters.where()
    src = f"FROM v_order_details {where}"

    kpis = _rows(conn, f"""
        SELECT
            COALESCE(SUM(Net_Amount_INR), 0)                                AS net_revenue,
            COUNT(DISTINCT Order_ID)                                        AS orders,
            COUNT(DISTINCT Customer_ID)                                     AS customers,
            COUNT(DISTINCT CASE WHEN Is_Cancelled = 0 THEN Order_ID END)    AS non_cancelled_orders,
            1.0 * COALESCE(SUM(Net_Amount_INR), 0)
                / NULLIF(COUNT(DISTINCT CASE WHEN Is_Cancelled = 0 THEN Order_ID END), 0)
                                                                            AS aov,
            COALESCE(SUM(CASE WHEN Is_Returned = 1 THEN Net_Amount_INR END), 0) AS returned_revenue,
            COUNT(DISTINCT CASE WHEN Is_Returned = 1 THEN Order_ID END)     AS returned_orders
        {src}""", args)[0]

    repeat = _rows(conn, f"""
        SELECT
            COALESCE(SUM(CASE WHEN n >= 2 THEN 1 ELSE 0 END), 0) AS repeat_customers,
            COUNT(*)                                             AS purchasing_customers
        FROM (
            SELECT Customer_ID, COUNT(DISTINCT Order_ID) AS n
            {src} {'AND' if where else 'WHERE'} Is_Cancelled = 0
            GROUP BY Customer_ID
        )""", args)[0]
    kpis.update(repeat)

    return {
        "kpis": kpis,
        "monthly": _rows(conn, f"""
            SELECT Order_Month AS month,
                   SUM(Net_Amount_INR) AS net_revenue,
                   COUNT(DISTINCT Order_ID) AS orders
            {src} GROUP BY Order_Month ORDER BY Order_Month""", args),
        "daily": _rows(conn, f"""
            SELECT Order_Date AS day,
                   SUM(Net_Amount_INR) AS net_revenue,
                   COUNT(DISTINCT Order_ID) AS orders
            {src} GROUP BY Order_Date ORDER BY Order_Date""", args),
        "by_category": _rows(conn, f"""
            SELECT Category AS label, SUM(Net_Amount_INR) AS net_revenue,
                   COUNT(DISTINCT Order_ID) AS orders
            {src} GROUP BY Category ORDER BY net_revenue DESC, label""", args),
        "by_segment": _rows(conn, f"""
            SELECT Customer_Segment AS label, SUM(Net_Amount_INR) AS net_revenue,
                   COUNT(DISTINCT Order_ID) AS orders
            {src} GROUP BY Customer_Segment ORDER BY net_revenue DESC, label""", args),
        "by_city": _rows(conn, f"""
            SELECT City AS label, SUM(Net_Amount_INR) AS net_revenue,
                   COUNT(DISTINCT Order_ID) AS orders
            {src} GROUP BY City ORDER BY net_revenue DESC, label""", args),
        "by_status": _rows(conn, f"""
            SELECT Order_Status AS label, COUNT(DISTINCT Order_ID) AS orders,
                   SUM(Net_Amount_INR) AS net_revenue
            {src} GROUP BY Order_Status ORDER BY orders DESC, label""", args),
        "top_products": _rows(conn, f"""
            SELECT Product_ID AS id, Product_Name AS label, Category AS category,
                   SUM(Net_Amount_INR) AS net_revenue,
                   SUM(CASE WHEN Is_Cancelled = 0 THEN Quantity ELSE 0 END) AS units
            {src} GROUP BY Product_ID, Product_Name, Category
            ORDER BY net_revenue DESC, id LIMIT 5""", args),
        "returned_orders": _rows(conn, f"""
            SELECT Order_ID AS order_id, Order_Date AS date, Customer_Name AS customer,
                   City AS city, Product_Name AS product, Net_Amount_INR AS net_revenue
            {src} {'AND' if where else 'WHERE'} Is_Returned = 1
            ORDER BY Order_Date DESC, Order_ID""", args),
    }