-- =====================================================================
-- 03_metrics.sql  —  Reference queries for every dashboard visual
--
-- These are the unfiltered versions. The API server (app/queries.py) runs
-- the same statements with a parameterised WHERE clause appended for the
-- active filters. Run this file directly to check the headline numbers:
--     sqlite3 sales.db < sql/03_metrics.sql
-- =====================================================================
.headers on
.mode column

-- KPI tiles -------------------------------------------------------------
-- AOV = net revenue / non-cancelled orders (returned orders count, since
-- they remain in the data and carry their net amount).
SELECT
    SUM(Net_Amount_INR)                                         AS total_net_revenue,
    COUNT(DISTINCT Order_ID)                                    AS total_orders,
    COUNT(DISTINCT Customer_ID)                                 AS unique_customers,
    COUNT(DISTINCT CASE WHEN Is_Cancelled = 0 THEN Order_ID END) AS non_cancelled_orders,
    ROUND(1.0 * SUM(Net_Amount_INR)
          / NULLIF(COUNT(DISTINCT CASE WHEN Is_Cancelled = 0 THEN Order_ID END), 0), 2)
                                                                AS average_order_value,
    SUM(CASE WHEN Is_Returned = 1 THEN Net_Amount_INR ELSE 0 END) AS returned_net_revenue,
    COUNT(DISTINCT CASE WHEN Is_Returned = 1 THEN Order_ID END) AS returned_orders
FROM v_order_details;

-- Monthly revenue trend -------------------------------------------------
SELECT Order_Month,
       SUM(Net_Amount_INR)      AS net_revenue,
       COUNT(DISTINCT Order_ID) AS orders
FROM v_order_details
GROUP BY Order_Month
ORDER BY Order_Month;

-- Revenue by product category --------------------------------------------
SELECT Category, SUM(Net_Amount_INR) AS net_revenue, COUNT(DISTINCT Order_ID) AS orders
FROM v_order_details
GROUP BY Category
ORDER BY net_revenue DESC;

-- Revenue by customer segment --------------------------------------------
SELECT Customer_Segment, SUM(Net_Amount_INR) AS net_revenue,
       COUNT(DISTINCT Customer_ID) AS customers
FROM v_order_details
GROUP BY Customer_Segment
ORDER BY net_revenue DESC;

-- Revenue by city ----------------------------------------------------------
SELECT City, SUM(Net_Amount_INR) AS net_revenue, COUNT(DISTINCT Customer_ID) AS customers
FROM v_order_details
GROUP BY City
ORDER BY net_revenue DESC;

-- Order count by status ----------------------------------------------------
SELECT Order_Status, COUNT(DISTINCT Order_ID) AS orders, SUM(Net_Amount_INR) AS net_revenue
FROM v_order_details
GROUP BY Order_Status
ORDER BY orders DESC;

-- Bonus: top five products by net revenue ---------------------------------
SELECT Product_ID, Product_Name, Category,
       SUM(Net_Amount_INR) AS net_revenue,
       SUM(CASE WHEN Is_Cancelled = 0 THEN Quantity ELSE 0 END) AS units_sold
FROM v_order_details
GROUP BY Product_ID, Product_Name, Category
ORDER BY net_revenue DESC, Product_ID
LIMIT 5;

-- Bonus: repeat customers --------------------------------------------------
-- A repeat customer has two or more non-cancelled orders.
SELECT
    SUM(CASE WHEN n >= 2 THEN 1 ELSE 0 END)                         AS repeat_customers,
    COUNT(*)                                                        AS purchasing_customers,
    ROUND(100.0 * SUM(CASE WHEN n >= 2 THEN 1 ELSE 0 END) / COUNT(*), 1) AS repeat_rate_pct
FROM (
    SELECT Customer_ID, COUNT(DISTINCT Order_ID) AS n
    FROM v_order_details
    WHERE Is_Cancelled = 0
    GROUP BY Customer_ID
);