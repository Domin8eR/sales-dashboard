/*
 * local-engine.js - in-browser mirror of app/queries.py.
 *
 * Used only by the standalone build (dist/dashboard.html), where there is no
 * server: the rows of v_order_details are exported from the database once and
 * embedded in the page, and this file applies the same filters and the same
 * aggregation rules as the SQL. tests/test_metrics.py checks that the two give
 * identical results for a set of filter combinations.
 */
(function (root) {
  "use strict";

  var LIST_FILTERS = {
    category: "Category",
    segment: "Customer_Segment",
    city: "City",
    status: "Order_Status",
  };

  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function applyFilters(rows, f) {
    return rows.filter(function (r) {
      if (f.start && r.Order_Date < f.start) return false;
      if (f.end && r.Order_Date > f.end) return false;
      for (var key in LIST_FILTERS) {
        var vals = f[key];
        if (vals && vals.length && vals.indexOf(r[LIST_FILTERS[key]]) === -1) return false;
      }
      return true;
    });
  }

  function distinct(rows, col) {
    var seen = {};
    rows.forEach(function (r) { seen[r[col]] = true; });
    return Object.keys(seen).sort(cmp);
  }

  // GROUP BY one key; each group keeps net revenue and a set of order ids
  function groupBy(rows, keyFn) {
    var groups = {};
    rows.forEach(function (r) {
      var k = keyFn(r);
      var g = groups[k] || (groups[k] = { key: k, rows: [], net: 0, orders: {} });
      g.rows.push(r);
      g.net += r.Net_Amount_INR;
      g.orders[r.Order_ID] = true;
    });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }

  function count(obj) { return Object.keys(obj).length; }

  function byRevenue(rows, col) {
    return groupBy(rows, function (r) { return r[col]; })
      .map(function (g) { return { label: g.key, net_revenue: g.net, orders: count(g.orders) }; })
      .sort(function (a, b) { return b.net_revenue - a.net_revenue || cmp(a.label, b.label); });
  }

  function options(rows) {
    var dates = rows.map(function (r) { return r.Order_Date; }).sort(cmp);
    return {
      min_date: dates[0] || null,
      max_date: dates[dates.length - 1] || null,
      category: distinct(rows, "Category"),
      segment: distinct(rows, "Customer_Segment"),
      city: distinct(rows, "City"),
      status: distinct(rows, "Order_Status"),
    };
  }

  function dashboard(allRows, f) {
    var rows = applyFilters(allRows, f || {});
    var orders = {}, customers = {}, nonCancelled = {}, returned = {};
    var net = 0, returnedNet = 0;
    var perCustomer = {};

    rows.forEach(function (r) {
      net += r.Net_Amount_INR;
      orders[r.Order_ID] = true;
      customers[r.Customer_ID] = true;
      if (!r.Is_Cancelled) {
        nonCancelled[r.Order_ID] = true;
        (perCustomer[r.Customer_ID] || (perCustomer[r.Customer_ID] = {}))[r.Order_ID] = true;
      }
      if (r.Is_Returned) {
        returned[r.Order_ID] = true;
        returnedNet += r.Net_Amount_INR;
      }
    });

    var nNonCancelled = count(nonCancelled);
    var purchasing = Object.keys(perCustomer);
    var repeat = purchasing.filter(function (c) { return count(perCustomer[c]) >= 2; }).length;

    var monthly = groupBy(rows, function (r) { return r.Order_Month; })
      .map(function (g) { return { month: g.key, net_revenue: g.net, orders: count(g.orders) }; })
      .sort(function (a, b) { return cmp(a.month, b.month); });

    var daily = groupBy(rows, function (r) { return r.Order_Date; })
      .map(function (g) { return { day: g.key, net_revenue: g.net, orders: count(g.orders) }; })
      .sort(function (a, b) { return cmp(a.day, b.day); });

    var byStatus = groupBy(rows, function (r) { return r.Order_Status; })
      .map(function (g) { return { label: g.key, orders: count(g.orders), net_revenue: g.net }; })
      .sort(function (a, b) { return b.orders - a.orders || cmp(a.label, b.label); });

    var topProducts = groupBy(rows, function (r) { return r.Product_ID; })
      .map(function (g) {
        var units = 0;
        g.rows.forEach(function (r) { if (!r.Is_Cancelled) units += r.Quantity; });
        return { id: g.key, label: g.rows[0].Product_Name, category: g.rows[0].Category,
                 net_revenue: g.net, units: units };
      })
      .sort(function (a, b) { return b.net_revenue - a.net_revenue || cmp(a.id, b.id); })
      .slice(0, 5);

    var returnedOrders = rows.filter(function (r) { return r.Is_Returned; })
      .sort(function (a, b) { return cmp(b.Order_Date, a.Order_Date) || cmp(a.Order_ID, b.Order_ID); })
      .map(function (r) {
        return { order_id: r.Order_ID, date: r.Order_Date, customer: r.Customer_Name,
                 city: r.City, product: r.Product_Name, net_revenue: r.Net_Amount_INR };
      });

    return {
      kpis: {
        net_revenue: net,
        orders: count(orders),
        customers: count(customers),
        non_cancelled_orders: nNonCancelled,
        aov: nNonCancelled ? net / nNonCancelled : null,
        returned_revenue: returnedNet,
        returned_orders: count(returned),
        repeat_customers: repeat,
        purchasing_customers: purchasing.length,
      },
      monthly: monthly,
      daily: daily,
      by_category: byRevenue(rows, "Category"),
      by_segment: byRevenue(rows, "Customer_Segment"),
      by_city: byRevenue(rows, "City"),
      by_status: byStatus,
      top_products: topProducts,
      returned_orders: returnedOrders,
    };
  }

  var api = { options: options, dashboard: dashboard, applyFilters: applyFilters };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LocalEngine = api;
})(typeof window !== "undefined" ? window : this);