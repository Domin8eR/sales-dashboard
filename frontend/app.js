/*
 * app.js - dashboard UI.
 *
 * Data comes from one of two providers with the same interface:
 *   api      - the Python server (app/server.py) runs SQL against sales.db
 *   embedded - the standalone build: rows exported from v_order_details are
 *              embedded in the page and aggregated by local-engine.js
 */
(function () {
  "use strict";

  var DIMS = ["category", "segment", "city", "status"];
  var DIM_LABEL = { category: "Category", segment: "Segment", city: "City", status: "Status" };

  var state = {
    filters: emptyFilters(),
    options: null,
    data: null,
    custDim: "segment",
    tableView: {},          // card name -> true when showing the table instead of the chart
  };
  var charts = {};
  var provider;
  var requestSeq = 0;

  function emptyFilters() {
    return { start: null, end: null, category: [], segment: [], city: [], status: [] };
  }

  // ------------------------------------------------------------------ format
  var inrFull = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  var numFull = new Intl.NumberFormat("en-IN");
  function inr(v) { return v == null ? "–" : inrFull.format(Math.round(v)); }
  function num(v) { return v == null ? "–" : numFull.format(v); }
  function inrCompact(v) {
    var a = Math.abs(v);
    if (a >= 1e7) return "₹" + trim(v / 1e7, 2) + " Cr";
    if (a >= 1e5) return "₹" + trim(v / 1e5, 2) + " L";
    if (a >= 1e3) return "₹" + trim(v / 1e3, 1) + "K";
    return "₹" + Math.round(v);
  }
  function trim(v, d) { return String(+v.toFixed(d)); }
  function pct(part, whole) { return whole ? (100 * part / whole).toFixed(1) + "%" : "–"; }
  function monthLabel(ym, withYear) {
    var p = ym.split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, 1));
    var m = d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
    return withYear ? m + " " + p[0] : m;
  }
  function fmtDate(iso) {
    var p = iso.split("-");
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]))
      .toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function alpha(hex, a) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
    var n = parseInt(h, 16);
    return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")";
  }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (text != null) e.textContent = text;   // never innerHTML for data
    return e;
  }
  function $(id) { return document.getElementById(id); }

  // --------------------------------------------------------------- providers
  function fetchJSON(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || r.statusText);
        return body;
      });
    });
  }
  function toQuery(f) {
    var q = new URLSearchParams();
    if (f.start) q.set("start", f.start);
    if (f.end) q.set("end", f.end);
    DIMS.forEach(function (d) { f[d].forEach(function (v) { q.append(d, v); }); });
    return q.toString();
  }
  function apiProvider() {
    return {
      kind: "api",
      options: function () { return fetchJSON("api/options"); },
      dashboard: function (f) { return fetchJSON("api/dashboard?" + toQuery(f)); },
    };
  }
  function embeddedProvider(payload) {
    return {
      kind: "embedded",
      meta: payload.meta,
      options: function () { return Promise.resolve(LocalEngine.options(payload.rows)); },
      dashboard: function (f) { return Promise.resolve(LocalEngine.dashboard(payload.rows, f)); },
    };
  }

  // ------------------------------------------------------------- URL state
  function readHash() {
    try {
      var q = new URLSearchParams(location.hash.replace(/^#/, ""));
      var f = emptyFilters();
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.get("start") || "")) f.start = q.get("start");
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.get("end") || "")) f.end = q.get("end");
      DIMS.forEach(function (d) { f[d] = q.getAll(d); });
      if (q.get("by") === "city") state.custDim = "city";
      return f;
    } catch (e) { return emptyFilters(); }
  }
  function writeHash() {
    try {
      var q = toQuery(state.filters);
      if (state.custDim === "city") q += (q ? "&" : "") + "by=city";
      history.replaceState(null, "", q ? "#" + q : location.pathname + location.search);
    } catch (e) { /* sandboxed frames may refuse; state still works */ }
  }

  // --------------------------------------------------------------- filters
  function datePresets(o) {
    var presets = [{ id: "all", label: "All dates", start: null, end: null }];
    if (!o.max_date) return presets;
    function shift(iso, days) {
      var d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    }
    presets.push({ id: "l30", label: "Last 30 days", start: shift(o.max_date, -29), end: o.max_date });
    presets.push({ id: "l90", label: "Last 90 days", start: shift(o.max_date, -89), end: o.max_date });
    // one preset per calendar quarter in the data
    var y = +o.min_date.slice(0, 4), q = Math.floor((+o.min_date.slice(5, 7) - 1) / 3);
    var endKey = o.max_date.slice(0, 7);
    for (var guard = 0; guard < 40; guard++) {
      var sm = q * 3 + 1, em = sm + 2;
      var s = y + "-" + String(sm).padStart(2, "0") + "-01";
      var e = new Date(Date.UTC(y, em, 0)).toISOString().slice(0, 10);
      presets.push({ id: "q" + y + (q + 1), label: "Q" + (q + 1) + " " + y, start: s, end: e });
      if (e.slice(0, 7) >= endKey) break;
      q++; if (q === 4) { q = 0; y++; }
    }
    presets.push({ id: "custom", label: "Custom range", start: null, end: null, custom: true });
    return presets;
  }

  function buildFilters() {
    var o = state.options;
    var presets = datePresets(o);
    var sel = $("f-preset");
    presets.forEach(function (p) { sel.appendChild(el("option", { value: p.id }, p.label)); });
    sel.addEventListener("change", function () {
      var p = presets.filter(function (x) { return x.id === sel.value; })[0];
      if (!p || p.custom) return;
      state.filters.start = p.start; state.filters.end = p.end;
      refresh();
    });
    [$("f-start"), $("f-end")].forEach(function (inp) {
      inp.min = o.min_date; inp.max = o.max_date;
      inp.addEventListener("change", function () {
        var s = $("f-start").value || null, e = $("f-end").value || null;
        if (s && e && s > e) { var t = s; s = e; e = t; }
        // the boxes display the full data range when unfiltered; that range means "no filter"
        if (s === o.min_date) s = null;
        if (e === o.max_date) e = null;
        state.filters.start = s; state.filters.end = e;
        refresh();
      });
    });
    state._presets = presets;

    DIMS.forEach(function (dim) {
      var host = document.querySelector('[data-filter="' + dim + '"]');
      var details = el("details", { class: "ms" });
      var summary = el("summary", { "aria-label": DIM_LABEL[dim] + " filter" });
      summary.appendChild(el("span", { class: "ms-text" }, "All"));
      details.appendChild(summary);
      var panel = el("div", { class: "ms-panel" });
      o[dim].forEach(function (value) {
        var cb = el("input", { type: "checkbox", value: value });
        cb.addEventListener("change", function () {
          var list = state.filters[dim];
          var i = list.indexOf(value);
          if (cb.checked && i === -1) list.push(value);
          if (!cb.checked && i !== -1) list.splice(i, 1);
          refresh();
        });
        var lab = el("label");
        lab.appendChild(cb);
        lab.appendChild(el("span", null, value));
        panel.appendChild(lab);
      });
      var foot = el("div", { class: "ms-foot" });
      foot.appendChild(el("button", { type: "button", class: "link", onclick: function () {
        state.filters[dim] = o[dim].slice(); refresh(); } }, "Select all"));
      foot.appendChild(el("button", { type: "button", class: "link", onclick: function () {
        state.filters[dim] = []; refresh(); } }, "Clear"));
      panel.appendChild(foot);
      details.appendChild(panel);
      details.addEventListener("toggle", function () {
        if (details.open) document.querySelectorAll(".ms[open]").forEach(function (d) { if (d !== details) d.open = false; });
      });
      host.appendChild(details);
    });
    document.addEventListener("click", function (ev) {
      document.querySelectorAll(".ms[open]").forEach(function (d) { if (!d.contains(ev.target)) d.open = false; });
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") document.querySelectorAll(".ms[open]").forEach(function (d) { d.open = false; });
    });
    $("f-reset").addEventListener("click", function () { state.filters = emptyFilters(); refresh(); });
  }

  function syncFilterControls() {
    var f = state.filters, o = state.options;
    $("f-start").value = f.start || o.min_date || "";
    $("f-end").value = f.end || o.max_date || "";
    var match = state._presets.filter(function (p) { return !p.custom && p.start === f.start && p.end === f.end; })[0];
    $("f-preset").value = match ? match.id : "custom";

    DIMS.forEach(function (dim) {
      var host = document.querySelector('[data-filter="' + dim + '"]');
      var list = f[dim];
      host.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = list.indexOf(cb.value) !== -1; });
      var text = !list.length || list.length === o[dim].length ? "All" :
        list.length === 1 ? list[0] : list.length + " selected";
      host.querySelector(".ms-text").textContent = text;
    });

    var chips = $("chips");
    chips.textContent = "";
    function chip(text, onRemove) {
      var c = el("span", { class: "chip" }, text);
      c.appendChild(el("button", { type: "button", "aria-label": "Remove " + text, onclick: onRemove }, "×"));
      chips.appendChild(c);
    }
    if (f.start || f.end) {
      chip((f.start ? fmtDate(f.start) : "Start") + " – " + (f.end ? fmtDate(f.end) : "End"),
        function () { f.start = f.end = null; refresh(); });
    }
    DIMS.forEach(function (dim) {
      f[dim].forEach(function (v) {
        chip(DIM_LABEL[dim] + ": " + v, function () { f[dim] = f[dim].filter(function (x) { return x !== v; }); refresh(); });
      });
    });
  }

  function toggleFilter(dim, value) {
    var list = state.filters[dim];
    var i = list.indexOf(value);
    if (i === -1) list.push(value); else list.splice(i, 1);
    refresh();
  }

  // ------------------------------------------------------------- tooltip
  var tip = $("tooltip");
  function showTip(x, y, title, rows) {
    tip.textContent = "";
    tip.appendChild(el("div", { class: "tt-title" }, title));
    rows.forEach(function (r) {
      var row = el("div", { class: "tt-row" });
      if (r.color) { var k = el("span", { class: "tt-key" }); k.style.background = r.color; row.appendChild(k); }
      row.appendChild(el("span", { class: "tt-val" }, r.value));
      row.appendChild(el("span", { class: "tt-lab" }, r.label));
      tip.appendChild(row);
    });
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = Math.min(Math.max(8, x + 14), window.innerWidth - w - 8);
    var top = y - h - 12 < 8 ? y + 14 : y - h - 12;
    tip.style.left = left + "px"; tip.style.top = top + "px";
  }
  function hideTip() { tip.hidden = true; }
  function externalTooltip(describe) {
    return function (ctx) {
      var t = ctx.tooltip;
      if (!t || t.opacity === 0 || !t.dataPoints || !t.dataPoints.length) return hideTip();
      var rect = ctx.chart.canvas.getBoundingClientRect();
      var d = describe(t.dataPoints[0].dataIndex);
      showTip(rect.left + t.caretX, rect.top + t.caretY, d.title, d.rows);
    };
  }

  // --------------------------------------------------------- chart plugins
  // value at the tip of each horizontal bar
  var barValues = {
    id: "barValues",
    afterDatasetsDraw: function (chart, _args, opts) {
      if (!opts || !opts.format) return;
      var ctx = chart.ctx, meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = "500 12px " + css("--font");
      ctx.fillStyle = css("--text-2");
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      meta.data.forEach(function (bar, i) {
        ctx.fillText(opts.format(chart.data.datasets[0].data[i], i), bar.x + 6, bar.y);
      });
      ctx.restore();
    },
  };
  // vertical hairline that snaps to the hovered month
  var crosshair = {
    id: "crosshair",
    afterDatasetsDraw: function (chart, _args, opts) {
      if (!opts || !opts.enabled) return;
      var active = chart.getActiveElements();
      if (!active.length) return;
      var x = active[0].element.x, area = chart.chartArea, ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = css("--axis");
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, area.top); ctx.lineTo(x + 0.5, area.bottom); ctx.stroke();
      ctx.restore();
    },
  };
  // value label at the end of the line
  var endLabel = {
    id: "endLabel",
    afterDatasetsDraw: function (chart, _args, opts) {
      if (!opts || !opts.format) return;
      var meta = chart.getDatasetMeta(0), pts = meta.data;
      if (!pts.length) return;
      var p = pts[pts.length - 1], v = chart.data.datasets[0].data[pts.length - 1];
      var ctx = chart.ctx;
      ctx.save();
      ctx.font = "600 12px " + css("--font");
      ctx.fillStyle = css("--text-1");
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(opts.format(v), p.x, p.y - 10);
      ctx.restore();
    },
  };
  Chart.register(barValues, crosshair, endLabel);

  function baseOptions() {
    Chart.defaults.font.family = css("--font");
    Chart.defaults.font.size = 12;
    Chart.defaults.color = css("--muted");
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    };
  }

  function barChart(id, rows, opts) {
    var o = baseOptions();
    o.indexAxis = "y";
    o.layout = { padding: { right: opts.padRight || 64 } };
    o.scales = {
      x: { display: false, beginAtZero: true, grace: 0 },
      y: { grid: { display: false }, border: { color: css("--axis") },
           ticks: { color: css("--text-2"), font: { size: 12 }, autoSkip: false,
             // shorten long names on narrow screens; the tooltip and table keep the full name
             callback: function (_v, i) {
               var s = rows[i] ? String(rows[i].label) : "";
               var max = this.chart.width < 380 ? 13 : 24;
               return s.length > max ? s.slice(0, max - 1) + "…" : s;
             } } },
    };
    o.interaction = { mode: "nearest", axis: "y", intersect: false };
    o.plugins.barValues = { format: opts.format };
    o.plugins.tooltip.external = externalTooltip(opts.describe);
    o.onHover = function (ev, els) { ev.native.target.style.cursor = els.length && opts.onClick ? "pointer" : "default"; };
    if (opts.onClick) o.onClick = function (_e, els) { if (els.length) opts.onClick(rows[els[0].index]); };

    var colors = rows.map(function (r, i) { return opts.color ? opts.color(r, i) : css("--series-1"); });
    return new Chart($(id), {
      type: "bar",
      data: {
        labels: rows.map(function (r) { return r.label; }),
        datasets: [{
          data: rows.map(opts.value),
          backgroundColor: colors,
          hoverBackgroundColor: colors.map(function (c) { return alpha(c, 0.8); }),
          borderRadius: 4,
          borderSkipped: "start",
          maxBarThickness: 24,
          categoryPercentage: 0.8,
          barPercentage: 0.9,
        }],
      },
      options: o,
    });
  }

  // fill months with no orders as zero so the trend has no silent gaps
  function monthSeries(monthly) {
    var o = state.options, f = state.filters;
    var start = (f.start || o.min_date || "").slice(0, 7);
    var end = (f.end || o.max_date || "").slice(0, 7);
    var byMonth = {};
    monthly.forEach(function (m) { byMonth[m.month] = m; });
    var out = [];
    if (!start || !end) return monthly;
    var y = +start.slice(0, 4), m = +start.slice(5, 7);
    for (var guard = 0; guard < 240; guard++) {
      var key = y + "-" + String(m).padStart(2, "0");
      out.push(byMonth[key] || { month: key, net_revenue: 0, orders: 0 });
      if (key >= end) break;
      m++; if (m === 13) { m = 1; y++; }
    }
    return out;
  }

  // -------------------------------------------------------------- render
  function renderKpis() {
    var k = state.data.kpis;
    $("k-revenue").textContent = inr(k.net_revenue);
    $("k-revenue-note").textContent = k.returned_orders
      ? "Includes " + inr(k.returned_revenue) + " from " + num(k.returned_orders) + " returned orders"
      : "No returned orders in view";
    $("k-orders").textContent = num(k.orders);
    $("k-orders-note").textContent = num(k.non_cancelled_orders) + " non-cancelled · " +
      num(k.orders - k.non_cancelled_orders) + " cancelled";
    $("k-customers").textContent = num(k.customers);
    $("k-aov").textContent = k.aov == null ? "–" : inrFull.format(Math.round(k.aov));
    $("k-aov-note").textContent = "Net revenue ÷ " + num(k.non_cancelled_orders) + " non-cancelled orders";
    $("k-returned").textContent = num(k.returned_orders);
    $("k-returned-note").textContent = inr(k.returned_revenue) + " · " + pct(k.returned_revenue, k.net_revenue) + " of revenue";
    $("k-repeat").textContent = num(k.repeat_customers);
    $("k-repeat-note").textContent = pct(k.repeat_customers, k.purchasing_customers) +
      " of " + num(k.purchasing_customers) + " buyers placed 2+ non-cancelled orders";
  }

  var STATUS_COLOR = { Completed: "--series-1", Returned: "--series-2", Cancelled: "--neutral-mark" };

  // Card definitions: the chart and the equivalent table for each card
  var CARDS = {
    monthly: {
      // The trend follows the selected range: one point per day for ranges up
      // to 62 days, one point per month for anything longer.
      rows: function () {
        var o = state.options, f = state.filters;
        var start = f.start || o.min_date, end = f.end || o.max_date;
        var days = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
        this.daily = days <= 62;

        var card = document.querySelector('[data-card="monthly"]');
        card.querySelector("h2").textContent = this.daily ? "Daily net revenue" : "Monthly net revenue";
        card.querySelector(".c-sub").textContent = "Net_Amount_INR by order " + (this.daily ? "date" : "month");
        this.table = [[this.daily ? "Date" : "Month", function (r) { return r.day ? fmtDate(r.day) : monthLabel(r.month, true); }],
                      ["Net revenue", function (r) { return inr(r.net_revenue); }, true],
                      ["Orders", function (r) { return num(r.orders); }, true]];

        if (!this.daily) return monthSeries(state.data.monthly);
        // every day in the range, with ₹0 for days that had no orders
        var byDay = {};
        state.data.daily.forEach(function (d) { byDay[d.day] = d; });
        var out = [];
        for (var t = Date.parse(start); t <= Date.parse(end); t += 864e5) {
          var key = new Date(t).toISOString().slice(0, 10);
          out.push(byDay[key] || { day: key, net_revenue: 0, orders: 0 });
        }
        return out;
      },
      table: null, // set in rows()
      chart: function (rows) {
        var daily = this.daily;
        var multiYear = !daily && rows.length && rows[0].month.slice(0, 4) !== rows[rows.length - 1].month.slice(0, 4);
        var label = function (r) {
          return daily
            ? new Date(r.day + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })
            : monthLabel(r.month, multiYear);
        };
        var line = css("--series-1");
        var o = baseOptions();
        o.layout = { padding: { top: 18, right: 8 } };
        o.interaction = { mode: "index", intersect: false };
        o.scales = {
          x: { offset: rows.length === 1, grid: { display: false }, border: { color: css("--axis") },
               ticks: { color: css("--muted"), maxRotation: 0, autoSkip: true, maxTicksLimit: daily ? 8 : 12 } },
          y: { beginAtZero: true, border: { display: false }, grid: { color: css("--grid") },
               ticks: { color: css("--muted"), maxTicksLimit: 5, callback: function (v) { return inrCompact(v); } } },
        };
        o.plugins.crosshair = { enabled: true };
        o.plugins.endLabel = { format: inrCompact };
        o.plugins.tooltip.external = externalTooltip(function (i) {
          var r = rows[i];
          return { title: daily ? fmtDate(r.day) : monthLabel(r.month, true), rows: [
            { color: line, value: inr(r.net_revenue), label: "net revenue" },
            { value: num(r.orders), label: "orders" }] };
        });
        return new Chart($("ch-monthly"), {
          type: "line",
          data: {
            labels: rows.map(label),
            datasets: [{
              data: rows.map(function (r) { return r.net_revenue; }),
              borderColor: line, borderWidth: 2, borderJoinStyle: "round", borderCapStyle: "round",
              backgroundColor: alpha(line, 0.10), fill: "origin", tension: 0,
              pointRadius: daily ? (rows.length > 31 ? 0 : 3) : 4, pointHoverRadius: 6, pointHitRadius: 14,
              pointBackgroundColor: line, pointBorderColor: css("--surface"), pointBorderWidth: 2,
            }],
          },
          options: o,
        });
      },
    },
    status: {
      rows: function () { return state.data.by_status; },
      table: [["Status", function (r) { return r.label; }],
              ["Orders", function (r) { return num(r.orders); }, true],
              ["Share", function (r) { return pct(r.orders, state.data.kpis.orders); }, true],
              ["Net revenue", function (r) { return inr(r.net_revenue); }, true]],
      chart: function (rows) {
        var total = state.data.kpis.orders;
        return barChart("ch-status", rows, {
          value: function (r) { return r.orders; },
          color: function (r) { return css(STATUS_COLOR[r.label] || "--series-1"); },
          format: function (v) { return num(v) + " · " + pct(v, total); },
          padRight: 84,
          describe: function (i) {
            var r = rows[i];
            return { title: r.label, rows: [
              { color: css(STATUS_COLOR[r.label] || "--series-1"), value: num(r.orders), label: "orders (" + pct(r.orders, total) + ")" },
              { value: inr(r.net_revenue), label: "net revenue" }] };
          },
          onClick: function (r) { toggleFilter("status", r.label); },
        });
      },
    },
    category: {
      rows: function () { return state.data.by_category; },
      table: revenueTable("Category"),
      chart: function (rows) { return revenueBars("ch-category", rows, "category"); },
    },
    customer: {
      rows: function () { return state.custDim === "city" ? state.data.by_city : state.data.by_segment; },
      table: null, // set dynamically
      chart: function (rows) { return revenueBars("ch-customer", rows, state.custDim); },
    },
    products: {
      rows: function () { return state.data.top_products; },
      table: [["Product", function (r) { return r.label; }],
              ["Category", function (r) { return r.category; }],
              ["Units sold", function (r) { return num(r.units); }, true],
              ["Net revenue", function (r) { return inr(r.net_revenue); }, true]],
      chart: function (rows) {
        return barChart("ch-products", rows, {
          value: function (r) { return r.net_revenue; },
          format: inrCompact,
          describe: function (i) {
            var r = rows[i];
            return { title: r.label + " · " + r.category, rows: [
              { color: css("--series-1"), value: inr(r.net_revenue), label: "net revenue" },
              { value: num(r.units), label: "units sold (non-cancelled)" }] };
          },
        });
      },
    },
  };

  function revenueTable(name) {
    return [[name, function (r) { return r.label; }],
            ["Net revenue", function (r) { return inr(r.net_revenue); }, true],
            ["Share", function (r) { return pct(r.net_revenue, state.data.kpis.net_revenue); }, true],
            ["Orders", function (r) { return num(r.orders); }, true]];
  }
  function revenueBars(id, rows, dim) {
    var total = state.data.kpis.net_revenue;
    return barChart(id, rows, {
      value: function (r) { return r.net_revenue; },
      format: inrCompact,
      describe: function (i) {
        var r = rows[i];
        return { title: r.label, rows: [
          { color: css("--series-1"), value: inr(r.net_revenue), label: "net revenue (" + pct(r.net_revenue, total) + ")" },
          { value: num(r.orders), label: "orders" }] };
      },
      onClick: function (r) { toggleFilter(dim, r.label); },
    });
  }

  function buildTable(columns, rows) {
    var t = el("table"), thead = el("thead"), tr = el("tr");
    columns.forEach(function (c) { tr.appendChild(el("th", c[2] ? { class: "num" } : null, c[0])); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody");
    rows.forEach(function (r) {
      var row = el("tr");
      columns.forEach(function (c) { row.appendChild(el("td", c[2] ? { class: "num" } : null, c[1](r))); });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    return t;
  }

  function setupCardTools() {
    Object.keys(CARDS).forEach(function (name) {
      var card = document.querySelector('[data-card="' + name + '"]');
      var btn = el("button", { type: "button", "aria-pressed": "false" }, "Table");
      btn.addEventListener("click", function () {
        state.tableView[name] = !state.tableView[name];
        renderCharts();
      });
      card.querySelector(".c-tools").appendChild(btn);
      var tableHost = el("div", { class: "table-wrap", hidden: "" });
      card.querySelector(".c-body").appendChild(tableHost);
    });
    document.querySelectorAll(".seg-toggle button").forEach(function (b) {
      b.addEventListener("click", function () {
        state.custDim = b.getAttribute("data-dim");
        writeHash();
        renderCharts();
      });
    });
  }

  function renderCharts() {
    hideTip();
    CARDS.customer.table = revenueTable(state.custDim === "city" ? "City" : "Segment");
    $("cust-dim-label").textContent = state.custDim;
    document.querySelectorAll(".seg-toggle button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-dim") === state.custDim));
    });

    Object.keys(CARDS).forEach(function (name) {
      var def = CARDS[name];
      var card = document.querySelector('[data-card="' + name + '"]');
      var canvasBox = card.querySelector(".c-canvas");
      var tableHost = card.querySelector(".c-body > .table-wrap");
      var btn = card.querySelector(".c-tools button");
      var rows = def.rows();
      var asTable = !!state.tableView[name];
      btn.textContent = asTable ? "Chart" : "Table";
      btn.setAttribute("aria-pressed", String(asTable));

      if (charts[name]) { charts[name].destroy(); delete charts[name]; }
      var old = card.querySelector(".empty"); if (old) old.remove();

      var hasData = rows.some(function (r) { return (r.net_revenue || r.orders); });
      if (!rows.length || (!hasData && name !== "monthly")) {
        canvasBox.hidden = true; tableHost.hidden = true;
        card.querySelector(".c-body").appendChild(el("div", { class: "empty" }, "No orders match these filters"));
        return;
      }
      canvasBox.hidden = asTable;
      tableHost.hidden = !asTable;
      if (asTable) {
        tableHost.textContent = "";
        tableHost.appendChild(buildTable(def.table, rows));
      } else {
        charts[name] = def.chart(rows);
      }
    });
    renderReturns();
  }

  function renderReturns() {
    var rows = state.data.returned_orders;
    $("returns-count").textContent = "· " + num(rows.length);
    var host = $("returns-table");
    host.textContent = "";
    if (!rows.length) {
      host.appendChild(el("div", { class: "empty" },
        state.filters.status.length && state.filters.status.indexOf("Returned") === -1
          ? "Returned orders are excluded by the status filter" : "No returned orders match these filters"));
      return;
    }
    host.appendChild(buildTable([
      ["Order ID", function (r) { return r.order_id; }],
      ["Order date", function (r) { return fmtDate(r.date); }],
      ["Customer", function (r) { return r.customer; }],
      ["City", function (r) { return r.city; }],
      ["Product", function (r) { return r.product; }],
      ["Net amount", function (r) { return inr(r.net_revenue); }, true],
    ], rows));
  }

  function refresh() {
    syncFilterControls();
    writeHash();
    var seq = ++requestSeq;
    $("main").classList.add("loading");
    return provider.dashboard(state.filters).then(function (data) {
      if (seq !== requestSeq) return;       // a newer request superseded this one
      state.data = data;
      renderKpis();
      renderCharts();
    }).catch(function (err) {
      $("footer").textContent = "Could not load data: " + err.message;
    }).then(function () {
      if (seq === requestSeq) $("main").classList.remove("loading");
    });
  }

  // ---------------------------------------------------------------- init
  function init() {
    provider = window.EMBEDDED_DATA ? embeddedProvider(window.EMBEDDED_DATA) : apiProvider();

    state.filters = readHash();
    provider.options().then(function (o) {
      state.options = o;
      // drop any filter values from the URL that don't exist in the data
      DIMS.forEach(function (d) {
        state.filters[d] = state.filters[d].filter(function (v) { return o[d].indexOf(v) !== -1; });
      });
      buildFilters();
      setupCardTools();
      return refresh();
    }).catch(function (err) {
      $("footer").textContent = "Could not load data: " + err.message;
    });

    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onScheme = function () { if (state.data) renderCharts(); };
    if (mq.addEventListener) mq.addEventListener("change", onScheme);
    new MutationObserver(onScheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("scroll", hideTip, { passive: true });
  }

  init();
})();