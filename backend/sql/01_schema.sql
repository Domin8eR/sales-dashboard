-- =====================================================================
-- 01_schema.sql  —  Sales dashboard database (SQLite 3.37+)
--
-- Two tables, one relationship:
--   customers (1) ──< orders (many)      via Customer_ID
--
-- STRICT tables make SQLite enforce the declared column types instead of
-- silently storing any value. Column names match the Excel headers so the
-- mapping from source to database is one-to-one.
--
-- Conventions
--   * Dates are stored as ISO-8601 text (YYYY-MM-DD), SQLite's native date
--     format; the CHECK rejects anything date() cannot round-trip.
--   * Money is stored as INTEGER rupees: every amount in the source is a
--     whole number of INR, so integers avoid floating-point drift in sums.
--   * Foreign keys are enforced per connection with PRAGMA foreign_keys = ON
--     (the loader and the API server both set it).
-- =====================================================================

PRAGMA foreign_keys = ON;

DROP VIEW  IF EXISTS v_customer_summary;
DROP VIEW  IF EXISTS v_order_details;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customers;

-- ---------------------------------------------------------------------
-- customers: one row per customer
-- ---------------------------------------------------------------------
CREATE TABLE customers (
    Customer_ID          TEXT    NOT NULL PRIMARY KEY,
    Customer_Name        TEXT    NOT NULL,
    Email                TEXT    NOT NULL UNIQUE,
    City                 TEXT    NOT NULL,
    State                TEXT    NOT NULL,
    Customer_Segment     TEXT    NOT NULL,
    Join_Date            TEXT    NOT NULL,
    Acquisition_Channel  TEXT    NOT NULL,

    CHECK (length(trim(Customer_ID)) > 0),
    CHECK (Email LIKE '%_@_%._%'),
    CHECK (Join_Date = date(Join_Date))
) STRICT;

-- ---------------------------------------------------------------------
-- orders: one row per order; Customer_ID references customers
-- ---------------------------------------------------------------------
CREATE TABLE orders (
    Order_ID         TEXT    NOT NULL PRIMARY KEY,
    Customer_ID      TEXT    NOT NULL
                     REFERENCES customers (Customer_ID)
                     ON UPDATE CASCADE
                     ON DELETE RESTRICT,
    Order_Date       TEXT    NOT NULL,
    Product_ID       TEXT    NOT NULL,
    Product_Name     TEXT    NOT NULL,
    Category         TEXT    NOT NULL,
    Quantity         INTEGER NOT NULL,
    Unit_Price_INR   INTEGER NOT NULL,
    Discount_Rate    REAL    NOT NULL,
    Net_Amount_INR   INTEGER NOT NULL,
    Payment_Method   TEXT    NOT NULL,
    Order_Status     TEXT    NOT NULL,

    CHECK (Order_Date = date(Order_Date)),
    CHECK (Quantity > 0),
    CHECK (Unit_Price_INR >= 0),
    CHECK (Discount_Rate >= 0 AND Discount_Rate < 1),
    CHECK (Net_Amount_INR >= 0),
    CHECK (Order_Status IN ('Completed', 'Returned', 'Cancelled')),
    -- Business rule: cancelled orders carry no revenue.
    CHECK (Order_Status <> 'Cancelled' OR Net_Amount_INR = 0)
) STRICT;

-- Indexes for the join key and the columns the dashboard filters/groups on.
CREATE INDEX ix_orders_customer_id ON orders (Customer_ID);
CREATE INDEX ix_orders_order_date  ON orders (Order_Date);
CREATE INDEX ix_orders_category    ON orders (Category);
CREATE INDEX ix_orders_status      ON orders (Order_Status);
CREATE INDEX ix_customers_segment  ON customers (Customer_Segment);
CREATE INDEX ix_customers_city     ON customers (City);