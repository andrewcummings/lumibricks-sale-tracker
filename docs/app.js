// LumiBricks Sale Tracker — dashboard. Vanilla JS, no build step.
// Reads the JSON files produced by scripts/check.mjs and renders the page.

const $ = (sel) => document.querySelector(sel);

const EVENT_META = {
  SALE_START:   { ico: "🔥", tag: "sale", word: "On sale" },
  SALE_END:     { ico: "🏷️", tag: "mut",  word: "Sale ended" },
  PRICE_DROP:   { ico: "⬇️", tag: "drop", word: "Price drop" },
  PRICE_RISE:   { ico: "⬆️", tag: "mut",  word: "Price up" },
  RESTOCK:      { ico: "📦", tag: "good", word: "Back in stock" },
  OUT_OF_STOCK: { ico: "🚫", tag: "mut",  word: "Out of stock" },
  NEW_PRODUCT:  { ico: "✨", tag: "good", word: "New set" },
  REMOVED:      { ico: "❌", tag: "mut",  word: "Removed" },
};

const money = (n) => (n == null ? "—" : "$" + Number(n).toFixed(2));

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function thumb(url) {
  // Shopify lets us request a smaller rendition by inserting _NNNx before ext.
  if (!url) return "";
  return url.replace(/(\.[a-z]+)(\?.*)?$/i, "_400x$1$2");
}

let STATE = { products: [], history: { products: {} }, amazonHistory: { products: {} } };
let sortKey = "discountPct";
let sortDir = "desc";

// --- Preferences: theme filter, toggles, and a manual watchlist -------------
// Persisted to localStorage AND encoded in the URL hash, so bookmarking the page
// keeps your filters and watchlist.
const PREFS_KEY = "lumibricks:prefs";
const PREFS = { q: "", theme: "", watchedOnly: false, onSaleOnly: false, inStockOnly: false, watch: new Set() };
const isWatched = (id) => PREFS.watch.has(String(id));

function loadPrefs() {
  // Start from stored prefs (localStorage).
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "null"); } catch { /* ignore */ }

  // Overlay ONLY recognized keys that are actually present in the URL hash. A
  // bare anchor like "#activity" must NOT be parsed as an empty pref set — doing
  // so used to wipe every filter and, via the next savePrefs(), erase the saved
  // watchlist from localStorage too.
  const overlay = {};
  if (location.hash.length > 1) {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has("q")) overlay.q = p.get("q") || "";
    if (p.has("theme")) overlay.theme = p.get("theme") || "";
    if (p.has("watched")) overlay.watchedOnly = p.get("watched") === "1";
    if (p.has("onsale")) overlay.onSaleOnly = p.get("onsale") === "1";
    if (p.has("instock")) overlay.inStockOnly = p.get("instock") === "1";
    if (p.has("watch")) overlay.watch = (p.get("watch") || "").split(",").filter(Boolean);
  }

  if (!stored && Object.keys(overlay).length === 0) return; // nothing to apply
  const raw = { ...(stored || {}), ...overlay }; // URL prefs win over stored
  PREFS.q = raw.q || "";
  PREFS.theme = raw.theme || "";
  PREFS.watchedOnly = !!raw.watchedOnly;
  PREFS.onSaleOnly = !!raw.onSaleOnly;
  PREFS.inStockOnly = !!raw.inStockOnly;
  PREFS.watch = new Set((raw.watch || []).map(String));
}

function savePrefs() {
  const watch = [...PREFS.watch];
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...PREFS, watch }));
  } catch { /* ignore */ }
  const p = new URLSearchParams();
  if (PREFS.q) p.set("q", PREFS.q);
  if (PREFS.theme) p.set("theme", PREFS.theme);
  if (PREFS.watchedOnly) p.set("watched", "1");
  if (PREFS.onSaleOnly) p.set("onsale", "1");
  if (PREFS.inStockOnly) p.set("instock", "1");
  if (watch.length) p.set("watch", watch.join(","));
  const hash = p.toString();
  history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search);
}

function applyPrefsToControls() {
  $("#search").value = PREFS.q;
  $("#theme-filter").value = PREFS.theme;
  $("#watched-only").checked = PREFS.watchedOnly;
  $("#onsale-only").checked = PREFS.onSaleOnly;
  $("#instock-only").checked = PREFS.inStockOnly;
}

function populateThemes(products) {
  const themes = [...new Set(products.map((p) => p.productType).filter(Boolean))].sort();
  $("#theme-filter").innerHTML =
    '<option value="">All themes</option>' + themes.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  $("#theme-filter").value = PREFS.theme; // re-select now that the option exists
}

function toggleWatch(id) {
  id = String(id);
  if (PREFS.watch.has(id)) PREFS.watch.delete(id);
  else PREFS.watch.add(id);
  savePrefs();
  renderAll();
}

function renderAll() {
  renderSales(STATE.products);
  renderTable();
}

async function load() {
  try {
    const [current, events, history, amazon, amazonHistory] = await Promise.all([
      fetch("./data/current.json").then((r) => r.json()),
      fetch("./data/events.json").then((r) => r.json()).catch(() => ({ events: [] })),
      fetch("./data/history.json").then((r) => r.json()).catch(() => ({ products: {} })),
      fetch("./data/amazon-current.json").then((r) => r.json()).catch(() => ({ products: {} })),
      fetch("./data/amazon-history.json").then((r) => r.json()).catch(() => ({ products: {} })),
    ]);
    mergeAmazon(current.products, amazon);
    const amazonActive = Object.keys(amazon.products || {}).length > 0;
    STATE = { products: current.products, history, amazonHistory };
    document.body.classList.toggle("has-amazon", amazonActive);
    populateThemes(current.products);
    applyPrefsToControls();
    renderUpdated(current.generatedAt, amazonActive ? amazon.generatedAt : null);
    renderStats(current.totals, current.products, amazonActive);
    renderActivity(events.events || []);
    renderAll();
    $("#product-count").textContent =
      `Tracking ${current.products.length} sets` +
      (amazonActive ? ` · Amazon prices on ${Object.keys(amazon.products).length}.` : ".");
  } catch (err) {
    $("#updated").textContent = "Couldn't load data yet — the first check may not have run.";
    console.error(err);
  }
}

// Attach Amazon prices to each Shopify product and compute the lowest channel.
function mergeAmazon(products, amazon) {
  const amap = amazon.products || {};
  for (const p of products) {
    const a = amap[String(p.id)] || null;
    p.amazon = a;
    p.amazonPrice = a && a.price != null ? a.price : null;
    const cands = [];
    if (p.available && p.price != null) cands.push({ price: p.price, source: "shopify" });
    if (a && a.available && a.price != null) cands.push({ price: a.price, source: "amazon" });
    if (cands.length === 0) { // nothing in stock — compare listed prices anyway
      if (p.price != null) cands.push({ price: p.price, source: "shopify" });
      if (a && a.price != null) cands.push({ price: a.price, source: "amazon" });
    }
    cands.sort((x, y) => x.price - y.price);
    p.bestPrice = cands.length ? cands[0].price : null;
    p.bestSource = cands.length ? cands[0].source : null;
    p.cheaperOnAmazon = a && a.price != null && p.price != null && a.price < p.price;
  }
}

function renderUpdated(iso, amazonIso) {
  // "Updated", not "Last checked": the checker now only rewrites data (and bumps
  // generatedAt) when something actually changed, so this is the last-change time.
  let txt = `Updated ${timeAgo(iso)} · ${new Date(iso).toLocaleString()}`;
  if (amazonIso) txt += ` · Amazon ${timeAgo(amazonIso)}`;
  $("#updated").textContent = txt;
}

function renderStats(t, products, amazonActive) {
  const items = [
    { big: t.products, lbl: "sets tracked" },
    { big: t.onSale, lbl: amazonActive ? "on sale (LumiBricks)" : "on sale now", hot: t.onSale > 0 },
    { big: t.maxDiscountPct ? `${t.maxDiscountPct}%` : "—", lbl: "biggest discount", hot: t.maxDiscountPct > 0 },
  ];
  if (amazonActive) {
    const cheaper = products.filter((p) => p.cheaperOnAmazon).length;
    items.push({ big: cheaper, lbl: "cheaper on Amazon", hot: cheaper > 0 });
  }
  $("#stats").innerHTML = items
    .map((s) => `<div class="stat ${s.hot ? "hot" : ""}"><div class="big">${s.big}</div><div class="lbl">${s.lbl}</div></div>`)
    .join("");
}

function renderSales(products) {
  const onSale = products.filter(
    (p) => p.onSale && (!PREFS.theme || p.productType === PREFS.theme) && (!PREFS.watchedOnly || isWatched(p.id))
  );
  const filtered = PREFS.theme || PREFS.watchedOnly;
  $("#sale-count").textContent = onSale.length ? `(${onSale.length}${filtered ? " filtered" : ""})` : "";
  $("#no-sales").hidden = onSale.length > 0;
  $("#no-sales").textContent = filtered
    ? "No sets match your filters are on sale right now."
    : "No sets are on sale right now. This page updates automatically — check back soon.";
  $("#sales").innerHTML = onSale
    .map(
      (p) => `
      <a class="card" href="${p.url}" target="_blank" rel="noopener" title="${esc(p.title)}">
        <div class="thumb" style="background-image:url('${thumb(p.image)}')">
          <span class="badge">-${p.discountPct}%</span>
          ${p.atLowestEver ? '<span class="low">LOWEST EVER</span>' : ""}
        </div>
        <div class="body">
          <div class="name">${esc(p.title)}</div>
          <div class="prices"><span class="now">${money(p.price)}</span><span class="was">${money(p.compareAt)}</span></div>
          ${p.promo ? `<div class="promo">🏷️ ${esc(p.promo)}</div>` : ""}
          ${p.saleSince ? `<div class="since">since ${timeAgo(p.saleSince)}</div>` : ""}
        </div>
      </a>`
    )
    .join("");
}

function renderActivity(events) {
  $("#activity-count").textContent = events.length ? `(${events.length})` : "";
  $("#no-activity").hidden = events.length > 0;
  $("#activity").innerHTML = events
    .slice(0, 40)
    .map((e) => {
      const m = EVENT_META[e.type] || { ico: "•", tag: "mut", word: e.type };
      let detail = "";
      if (e.type === "SALE_START") detail = `now ${money(e.price)} <span class="was-sm">${money(e.compareAt)}</span> <span class="tag sale">-${e.discountPct}%</span>${e.promo ? ` <span class="tag promo">${esc(e.promo)}</span>` : ""}`;
      else if (e.type === "PRICE_DROP") detail = `${money(e.from)} → <b>${money(e.price)}</b>`;
      else if (e.type === "PRICE_RISE") detail = `${money(e.from)} → ${money(e.price)}`;
      else if (e.price != null) detail = money(e.price);
      const chan = e.source === "amazon"
        ? '<span class="chan amz">Amazon</span>'
        : '<span class="chan lb">LumiBricks</span>';
      return `<li>
        <span class="ev-ico">${m.ico}</span>
        <span class="ev-text">${chan} <span class="tag ${m.tag}">${m.word}</span> <b><a href="${e.url}" target="_blank" rel="noopener">${esc(e.title)}</a></b> ${detail}</span>
        <span class="ev-time">${timeAgo(e.t)}</span>
      </li>`;
    })
    .join("");
}

function amazonCell(p) {
  const a = p.amazon;
  if (!a || a.price == null) return '<span class="dash">—</span>';
  const link = `<a href="${a.url}" target="_blank" rel="noopener">${money(a.price)}</a>`;
  const disc = a.discountPct ? ` <span class="disc">-${a.discountPct}%</span>` : "";
  const flag = p.cheaperOnAmazon ? ' <span class="cheap" title="Cheaper on Amazon">▼</span>' : "";
  const oos = a.available === false ? ' <span class="out">·out</span>' : "";
  return link + disc + flag + oos;
}

function renderTable() {
  const q = PREFS.q.trim().toLowerCase();
  let rows = STATE.products.filter((p) => {
    if (PREFS.theme && p.productType !== PREFS.theme) return false;
    if (PREFS.watchedOnly && !isWatched(p.id)) return false;
    if (PREFS.onSaleOnly && !p.onSale) return false;
    if (PREFS.inStockOnly && !p.available) return false;
    if (q && !(`${p.title} ${p.productType}`.toLowerCase().includes(q))) return false;
    return true;
  });
  updateFilterSummary(rows.length);

  rows.sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === "string") { av = av.toLowerCase(); bv = (bv || "").toLowerCase(); }
    if (av == null) av = -Infinity;
    if (bv == null) bv = -Infinity;
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return a.title.localeCompare(b.title);
  });

  if (rows.length === 0) {
    $("#all-body").innerHTML = `<tr><td colspan="9" class="empty-row">No sets match your filters. <a href="#" id="clear-filters">Clear filters</a></td></tr>`;
    $("#clear-filters")?.addEventListener("click", (e) => { e.preventDefault(); clearFilters(); });
    return;
  }

  $("#all-body").innerHTML = rows
    .map(
      (p) => `<tr>
        <td class="star-col"><button class="star ${isWatched(p.id) ? "on" : ""}" data-id="${p.id}" aria-pressed="${isWatched(p.id)}" title="${isWatched(p.id) ? "Watching — click to unwatch" : "Watch this set"}">${isWatched(p.id) ? "★" : "☆"}</button></td>
        <td><img class="row-thumb" loading="lazy" src="${thumb(p.image)}" alt=""></td>
        <td><span class="row-name" data-id="${p.id}">${esc(p.title)}</span></td>
        <td>${esc(p.productType) || '<span class="dash">—</span>'}</td>
        <td class="num ${p.bestSource === "shopify" ? "best" : ""}">${money(p.price)}${p.onSale ? `<span class="was-sm">${money(p.compareAt)}</span>` : ""}</td>
        <td class="num amz-col ${p.bestSource === "amazon" ? "best" : ""}">${amazonCell(p)}</td>
        <td class="num best-col">${p.bestPrice != null ? `${money(p.bestPrice)} <span class="src ${p.bestSource}">${p.bestSource === "amazon" ? "AMZ" : "LB"}</span>` : '<span class="dash">—</span>'}</td>
        <td class="num">${p.discountPct ? `<span class="disc">-${p.discountPct}%</span>` : '<span class="dash">—</span>'}</td>
        <td>${p.available ? '<span class="in">In stock</span>' : '<span class="out">Out</span>'}</td>
      </tr>`
    )
    .join("");

  document.querySelectorAll("#all-body .row-name").forEach((el) =>
    el.addEventListener("click", () => openModal(Number(el.dataset.id)))
  );
  document.querySelectorAll("#all-body .star").forEach((el) =>
    el.addEventListener("click", () => toggleWatch(el.dataset.id))
  );

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.toggle("asc", th.dataset.sort === sortKey && sortDir === "asc");
    th.classList.toggle("desc", th.dataset.sort === sortKey && sortDir === "desc");
  });
}

// --- Price history modal -----------------------------------------------------

function openModal(id) {
  const p = STATE.products.find((x) => x.id === id);
  if (!p) return;
  const shop = (STATE.history.products[String(id)]?.points || []).filter((pt) => pt.price != null);
  const amz = (STATE.amazonHistory?.products?.[String(id)]?.points || []).filter((pt) => pt.price != null);
  const series = [];
  if (shop.length) series.push({ label: "LumiBricks", color: "#ffb020", points: shop });
  if (amz.length) series.push({ label: "Amazon", color: "#6ab0ff", points: amz });

  const metaBits = [`LumiBricks ${money(p.price)}`];
  if (p.amazon?.price != null) metaBits.push(`Amazon ${money(p.amazon.price)}`);
  metaBits.push(`all-time low ${money(p.lowestEver)}`);

  const hasChart = series.some((s) => s.points.length >= 2);
  $("#modal-body").innerHTML = `
    <h3><a href="${p.url}" target="_blank" rel="noopener">${esc(p.title)}</a></h3>
    <div class="meta">${metaBits.join(" · ")}</div>
    ${hasChart ? chartSVG(series) : '<p class="empty">Not enough history yet — points accumulate over time as prices change.</p>'}
    ${p.amazon?.asin ? `<p class="amz-links">Amazon: <a href="${p.amazon.url}" target="_blank" rel="noopener">view listing</a> · <a href="https://keepa.com/#!product/1-${p.amazon.asin}" target="_blank" rel="noopener">full price history on Keepa</a></p>` : ""}
  `;
  $("#modal").hidden = false;
}

// Multi-series step chart (prices hold until the next recorded change).
function chartSVG(series) {
  const W = 500, H = 210, pad = 34;
  const all = series.flatMap((s) => s.points);
  const xs = all.map((p) => new Date(p.t).getTime());
  const ys = all.map((p) => p.price);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys) * 0.95, maxY = Math.max(...ys) * 1.05;
  const sx = (x) => pad + ((x - minX) / (maxX - minX || 1)) * (W - pad * 2);
  const sy = (y) => H - pad - ((y - minY) / (maxY - minY || 1)) * (H - pad * 2);

  const lines = series
    .map((s) => {
      const pts = s.points.slice().sort((a, b) => new Date(a.t) - new Date(b.t));
      let d = "";
      pts.forEach((p, i) => {
        const x = sx(new Date(p.t).getTime()), y = sy(p.price);
        if (i === 0) d += `M ${x} ${y}`;
        else d += ` L ${x} ${sy(pts[i - 1].price)} L ${x} ${y}`;
      });
      d += ` L ${sx(maxX)} ${sy(pts[pts.length - 1].price)}`;
      const dots = pts.map((p) => `<circle cx="${sx(new Date(p.t).getTime())}" cy="${sy(p.price)}" r="2.5" fill="${s.color}" />`).join("");
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" />${dots}`;
    })
    .join("");

  const yTicks = [minY, (minY + maxY) / 2, maxY].map((v) => `<text x="4" y="${sy(v) + 4}">$${v.toFixed(0)}</text>`).join("");
  const xLabels = `<text x="${pad}" y="${H - 8}">${new Date(minX).toLocaleDateString()}</text>
    <text x="${W - pad}" y="${H - 8}" text-anchor="end">${new Date(maxX).toLocaleDateString()}</text>`;
  const legend = series
    .map((s, i) => `<g transform="translate(${pad + i * 120}, 14)"><rect width="11" height="11" rx="2" fill="${s.color}" /><text x="16" y="10">${s.label}</text></g>`)
    .join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${legend}${yTicks}${xLabels}${lines}
  </svg>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function updateFilterSummary(shown) {
  const bits = [`Showing ${shown} of ${STATE.products.length}`, `${PREFS.watch.size} watched`];
  const active = [];
  if (PREFS.theme) active.push(`theme “${PREFS.theme}”`);
  if (PREFS.watchedOnly) active.push("watched only");
  if (PREFS.onSaleOnly) active.push("on sale only");
  if (PREFS.inStockOnly) active.push("in stock only");
  if (PREFS.q) active.push(`“${PREFS.q}”`);
  $("#filter-summary").textContent = bits.join(" · ") + (active.length ? " · " + active.join(", ") : "");
}

function clearFilters() {
  PREFS.q = ""; PREFS.theme = ""; PREFS.watchedOnly = false; PREFS.onSaleOnly = false; PREFS.inStockOnly = false;
  applyPrefsToControls();
  savePrefs();
  renderAll();
}

function flashBtn(sel, msg) {
  const el = $(sel); const orig = el.textContent;
  el.textContent = msg; setTimeout(() => (el.textContent = orig), 2200);
}

// --- Wiring ------------------------------------------------------------------

$("#search").addEventListener("input", (e) => { PREFS.q = e.target.value; savePrefs(); renderAll(); });
$("#theme-filter").addEventListener("change", (e) => { PREFS.theme = e.target.value; savePrefs(); renderAll(); });
$("#watched-only").addEventListener("change", (e) => { PREFS.watchedOnly = e.target.checked; savePrefs(); renderAll(); });
$("#onsale-only").addEventListener("change", (e) => { PREFS.onSaleOnly = e.target.checked; savePrefs(); renderAll(); });
$("#instock-only").addEventListener("change", (e) => { PREFS.inStockOnly = e.target.checked; savePrefs(); renderAll(); });
$("#copy-link").addEventListener("click", async () => {
  savePrefs();
  try { await navigator.clipboard.writeText(location.href); flashBtn("#copy-link", "✓ Copied — bookmark it!"); }
  catch { flashBtn("#copy-link", "Press Cmd/Ctrl+D to bookmark"); }
});

document.querySelectorAll("th.sortable").forEach((th) =>
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = k; sortDir = k === "title" || k === "productType" ? "asc" : "desc"; }
    renderTable();
  })
);
// React if the URL fragment changes (e.g. opening a bookmarked link in this tab).
window.addEventListener("hashchange", () => { loadPrefs(); applyPrefsToControls(); renderAll(); });

$("#modal-close").addEventListener("click", () => ($("#modal").hidden = true));
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#modal").hidden = true; });

loadPrefs();
load();
