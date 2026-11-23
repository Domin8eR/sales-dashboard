# Sales Dashboard: Excel → SQLite → Web Dashboard

This project loads `customers.xlsx` and `orders.xlsx` into a relational database, joins them on `Customer_ID`, and serves a one-page interactive sales dashboard. The dashboard has every required KPI and chart, five filters, and two bonus items: a top-five-products view and a repeat-customer metric.

The project is split into a **backend** (database, data loading, API, tests) and a **frontend** (the dashboard page). The backend server serves both the API and the frontend files from one address.

## Quick start

You need Python 3.9+. The only dependency is `openpyxl`. Run every command from the `sales-dashboard` folder.

**Windows (Command Prompt):**

```
python -m venv .venv
.venv\Scripts\activate
pip install -r backend\requirements.txt
python backend\etl\load_data.py
python backend\api\server.py
```

**macOS / Linux:**

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
python backend/etl/load_data.py
python backend/api/server.py
```

Then open **http://127.0.0.1:8000** in a browser. Press Ctrl+C in the terminal to stop the server.

**Without a server:** `python backend/scripts/build_static.py` writes `dist/dashboard.html`. This is one self-contained file that opens straight from disk (see [Two ways to run the dashboard](#two-ways-to-run-the-dashboard)).

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Database | **SQLite 3.37+** (STRICT tables) | No server or credentials to set up, and the whole database is one file. STRICT mode enforces the declared column types. The SQL is standard and ports to PostgreSQL with only small changes (see notes). |
| Loading (ETL) | **Python + openpyxl** (`backend/etl/load_data.py`) | Gives explicit type conversion, header checks, a single transaction and a reconciliation report. |
| API | **Python standard library** `http.server` (`backend/api/server.py`, `backend/api/queries.py`) | A small REST API returning JSON. It runs parameterised SQL on every filter change and needs no framework. |
| Frontend | **HTML, CSS, vanilla JavaScript** (`frontend/`) | Layout, styling (light and dark mode, phone layout) and interactivity, with no framework. |
| Charts | **Chart.js 4.4.1** (included locally in `frontend/vendor`) | Line and bar charts that work offline. |
| Tests | Python `unittest` (`backend/tests/test_metrics.py`) | 17 tests covering the load, constraints, metrics and engine parity. |

## Project layout

```
backend/
  api/queries.py           the SQL behind the dashboard, with filters as bound parameters
  api/server.py            web server: serves frontend/ plus /api/options and /api/dashboard
  etl/load_data.py         Excel → SQLite loader with validation and reconciliation
  sql/01_schema.sql        table-creation SQL: types, primary keys, foreign key, CHECKs, indexes
  sql/02_views.sql         v_order_details (the joined dataset) and v_customer_summary
  sql/03_metrics.sql       reference query for every KPI and chart
  scripts/build_static.py  builds the single-file dashboard in dist/dashboard.html
  scripts/run_sql.py       runs a .sql file and prints the results (if the sqlite3 CLI is missing)
  tests/test_metrics.py    load, constraint, metric and parity tests
  requirements.txt         Python dependency (openpyxl)
  sales.db                 the database, created by load_data.py
frontend/
  index.html, styles.css, app.js   the dashboard page
  local-engine.js          browser copy of the query rules, used by the single-file build
  vendor/chart.umd.min.js
data/                      the two input Excel files
dist/                      the built single-file dashboard
```

## Database design

```
customers                          orders
─────────────────────              ─────────────────────────
Customer_ID  TEXT  PK  ◄──────┐    Order_ID        TEXT     PK
Customer_Name TEXT            └─── Customer_ID     TEXT     FK → customers, NOT NULL
Email        TEXT  UNIQUE          Order_Date      TEXT     ISO date, CHECK valid
City         TEXT                  Product_ID      TEXT
State        TEXT                  Product_Name    TEXT
Customer_Segment TEXT              Category        TEXT
Join_Date    TEXT  ISO date        Quantity        INTEGER  CHECK > 0
Acquisition_Channel TEXT           Unit_Price_INR  INTEGER  CHECK ≥ 0
                                   Discount_Rate   REAL     CHECK 0 ≤ x < 1
                                   Net_Amount_INR  INTEGER  CHECK ≥ 0
                                   Payment_Method  TEXT
                                   Order_Status    TEXT     CHECK IN (Completed, Returned, Cancelled)
                                   CHECK (Order_Status <> 'Cancelled' OR Net_Amount_INR = 0)
```

* **One-to-many relationship:** `orders.Customer_ID REFERENCES customers(Customer_ID)`, with `ON DELETE RESTRICT` so a customer who has orders cannot be deleted. Foreign-key checks are switched on for every connection.
* **Business rules enforced as constraints:** the database rejects an unknown status, and it rejects a cancelled order with a non-zero amount.
* **Indexes:** on the join key and on every filtered or grouped column.
* **Column names:** they match the Excel headers exactly, so the source-to-table mapping is one-to-one.

## Loading steps (`backend/etl/load_data.py`)

1. Run `01_schema.sql`, which drops and recreates the tables, so it is safe to rerun.
2. Read each workbook, check that all expected headers are present, then convert every cell to its database type:
   * text is trimmed and inner whitespace collapsed
   * Excel dates become ISO `YYYY-MM-DD`
   * money values must be whole numbers
   * blank cells are rejected
3. Insert customers, then orders, in **one transaction**. Any primary-key, foreign-key or CHECK failure rolls back the whole load.
4. Create the views and print a reconciliation:

```
customers: 60 rows read, 60 loaded
orders:    240 rows read, 240 loaded
joined view rows: 240 (should equal orders loaded)
customers with no orders: 1
foreign key violations: 0
net amount mismatches vs qty x price x (1 - discount): 0
```

The last line is a soft check: `Net_Amount_INR = round(Quantity × Unit_Price_INR × (1 − Discount_Rate))` holds for every non-cancelled order.

## Joined dataset (`backend/sql/02_views.sql`)

```sql
CREATE VIEW v_order_details AS
SELECT o.Order_ID, o.Order_Date, strftime('%Y-%m', o.Order_Date) AS Order_Month,
       o.Order_Status,
       CASE WHEN o.Order_Status = 'Cancelled' THEN 1 ELSE 0 END AS Is_Cancelled,
       CASE WHEN o.Order_Status = 'Returned'  THEN 1 ELSE 0 END AS Is_Returned,
       o.Product_ID, o.Product_Name, o.Category, o.Quantity, o.Unit_Price_INR,
       o.Discount_Rate, o.Quantity * o.Unit_Price_INR AS Gross_Amount_INR,
       o.Net_Amount_INR, o.Payment_Method,
       c.Customer_ID, c.Customer_Name, c.City, c.State, c.Customer_Segment,
       c.Acquisition_Channel, c.Join_Date
FROM orders o
INNER JOIN customers c ON c.Customer_ID = o.Customer_ID;
```

**INNER JOIN:** every order has a customer (the foreign key guarantees it), so the join keeps all 240 orders. The view has one row per order, so `COUNT(DISTINCT Order_ID)` and `SUM(Net_Amount_INR)` are never inflated.

**`v_customer_summary`:** this second view uses a LEFT JOIN from customers, so it also keeps the one customer with no orders.

## Metric definitions

| Metric | SQL (over the filtered `v_order_details`) |
|---|---|
| Total net revenue | `SUM(Net_Amount_INR)` |
| Total orders | `COUNT(DISTINCT Order_ID)` |
| Unique customers | `COUNT(DISTINCT Customer_ID)` |
| Average order value | `SUM(Net_Amount_INR) / COUNT(DISTINCT Order_ID) WHERE status <> 'Cancelled'` (NULL when there are none) |
| Revenue trend | `GROUP BY Order_Month`, or `GROUP BY Order_Date` when the date range is 62 days or less |
| Revenue by category / segment / city | `GROUP BY Category` / `Customer_Segment` / `City` |
| Orders by status | `COUNT(DISTINCT Order_ID) GROUP BY Order_Status` |
| Top five products (bonus) | `SUM(Net_Amount_INR) GROUP BY Product_ID ORDER BY 1 DESC LIMIT 5` |
| Repeat customers (bonus) | customers with ≥ 2 non-cancelled orders ÷ customers with ≥ 1 |

**Results on the supplied data (no filters):**

| Total net revenue | Orders | Unique customers | AOV | Returned | Repeat customers |
|---|---|---|---|---|---|
| ₹11,59,206 | 240 (204 non-cancelled) | 59 | ₹5,682.38 | 40 orders, ₹1,98,890 | 48 of 54 buyers (88.9%) |

`python backend/scripts/run_sql.py backend/sql/03_metrics.sql` prints the full breakdowns.

## Dashboard

**KPI row:**
* Total net revenue
* Total orders (split into non-cancelled and cancelled)
* Unique customers
* Average order value
* Returned orders (count, revenue and share of revenue)
* Repeat customers

**Charts:**
* Net revenue trend: daily for date ranges of up to 62 days, monthly for longer ranges
* Orders by status
* Revenue by category
* Revenue by segment, with a toggle to switch to city
* Top five products
* A table of returned orders, so returns can be identified and reviewed

**Filters** (all scope every number on the page):
* Date range, with presets for all dates, last 30 or 90 days and each quarter, plus custom start and end dates
* Category, segment, city and order status, each with multi-select

**Usability:**
* Clicking a bar in the status, category or segment/city chart toggles that filter.
* Active filters appear as removable chips, and *Reset filters* clears them all.
* The filters are kept in the URL hash, so a filtered view can be bookmarked or shared.
* Every chart has a **Table** toggle that shows the same numbers as a table.
* Hovering a chart shows tooltips.
* The layout adapts to phones, and the page follows the system's light or dark mode.

### Two ways to run the dashboard

* **Live (`backend/api/server.py`):** every filter change calls `/api/dashboard`, which runs the SQL in `backend/api/queries.py` against `backend/sales.db`. Filter values are always bound parameters, and column names come from a fixed whitelist.
* **Standalone (`dist/dashboard.html`):** `backend/scripts/build_static.py` exports the rows of `v_order_details` and embeds them in one HTML file. In that file, `frontend/local-engine.js` applies the same filters and aggregation rules in the browser. This version can be emailed, opened from disk or put on any static host. A test confirms it gives **exactly** the same output as the SQL for six filter combinations.

## Assumptions

1. **Returned orders count as revenue.** The brief says to use `Net_Amount_INR` and that returned orders remain in the data, so total revenue (₹11,59,206) includes ₹1,98,890 from 40 returned orders. The dashboard shows that amount next to the headline. Selecting *Completed* in the status filter gives revenue excluding returns.
2. **The AOV denominator includes returned orders.** The rule is "non-cancelled orders", and returned orders are not cancelled: 1,159,206 ÷ 204 = ₹5,682.38.
3. **Total orders includes cancelled orders.** Each unique `Order_ID` counts as one order.
4. **Unique customers means customers with at least one order in the current view.** That gives 59. One registered customer, C0060, has no orders: they appear in `customers` and `v_customer_summary` but not in the order-level metrics.
5. **The date filter applies to `Order_Date`.** It is inclusive at both ends. Days or months with no orders inside the selected range are shown as ₹0 rather than skipped.
6. **A repeat customer has two or more non-cancelled orders.** Five customers whose only orders were cancelled are not counted as buyers.
7. **Money is stored as whole rupees (INTEGER).** Every amount in the source is a whole number. The loader rejects fractional values rather than rounding them silently.
8. **Product attributes stay on `orders`.** The brief asks for two tables. A third `products` table (Product_ID → name, category, list price) would be the next normalisation step. The product data is already consistent: each Product_ID has one name, category and price.
9. **Data quality.** The supplied files have no duplicate keys, orphan orders, blank cells or amount mismatches. The loader and tests would catch any of these in a future file.

## Notes on porting to PostgreSQL

* Change `TEXT` dates to `DATE` and money to `NUMERIC(12,2)` or `INTEGER`.
* Drop `STRICT`.
* Change `strftime('%Y-%m', d)` to `to_char(d, 'YYYY-MM')`.
* Replace the date CHECKs with the `DATE` type.

Everything else, including the views, metric queries and constraints, is standard SQL.

## Tests

```bash
python -m unittest discover -s backend/tests -v
```

There are 17 tests:

* **Load:** row counts reconcile, the join keeps every order, and the foreign key is declared and clean.
* **Constraints:** the database rejects an orphan order, a duplicate key, revenue on a cancelled order, an unknown status, an invalid date, and deleting a customer who has orders.
* **Metrics:** every KPI and breakdown, including the daily and monthly trend, is recomputed from the Excel files in plain Python (no SQL) and compared with the SQL, unfiltered and with filters. The headline numbers are pinned, and the tests check that SQL injection through a filter value has no effect.
* **Parity:** the JavaScript engine matches the SQL exactly. This test needs Node.js and is skipped if it isn't installed. 