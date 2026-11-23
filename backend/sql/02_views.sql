-- =====================================================================
-- 02_views.sql  —  Joined dataset used by the dashboard
-- =====================================================================

-- ---------------------------------------------------------------------
-- v_order_details: one row per order, enriched with its customer.
--
-- INNER JOIN on Customer_ID. Every order has a customer (the foreign key
-- guarantees it), so no orders are lost; customers with no orders do not
-- appear here because this view is order-grained. They are still in the
-- customers table and in v_customer_summary below.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_order_details;
CREATE VIEW v_order_details AS
SELECT
    o.Order_ID,
    o.Order_Date,
    strftime('%Y-%m', o.Order_Date)                       AS Order_Month,
    o.Order_Status,
    CASE WHEN o.Order_Status = 'Cancelled' THEN 1 ELSE 0 END AS Is_Cancelled,
    CASE WHEN o.Order_Status = 'Returned'  THEN 1 ELSE 0 END AS Is_Returned,

    o.Product_ID,
    o.Product_Name,
    o.Category,
    o.Quantity,
    o.Unit_Price_INR,
    o.Discount_Rate,
    o.Quantity * o.Unit_Price_INR                         AS Gross_Amount_INR,
    o.Net_Amount_INR,
    o.Payment_Method,

    c.Customer_ID,
    c.Customer_Name,
    c.City,
    c.State,
    c.Customer_Segment,
    c.Acquisition_Channel,
    c.Join_Date
FROM orders AS o
INNER JOIN customers AS c
        ON c.Customer_ID = o.Customer_ID;

-- ---------------------------------------------------------------------
-- v_customer_summary: one row per customer (LEFT JOIN keeps customers
-- with zero orders). Used for the repeat-customer bonus metric.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_customer_summary;
CREATE VIEW v_customer_summary AS
SELECT
    c.Customer_ID,
    c.Customer_Name,
    c.City,
    c.Customer_Segment,
    COUNT(o.Order_ID)                                                  AS Total_Orders,
    COUNT(CASE WHEN o.Order_Status <> 'Cancelled' THEN o.Order_ID END) AS Non_Cancelled_Orders,
    COALESCE(SUM(o.Net_Amount_INR), 0)                                 AS Net_Revenue_INR,
    MIN(o.Order_Date)                                                  AS First_Order_Date,
    MAX(o.Order_Date)                                                  AS Last_Order_Date
FROM customers AS c
LEFT JOIN orders AS o
       ON o.Customer_ID = c.Customer_ID
GROUP BY c.Customer_ID, c.Customer_Name, c.City, c.Customer_Segment;