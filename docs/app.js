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

let STATE = { products: [], history: { products: {} } };
let sortKey = "discountPct";
let sortDir = "desc";

async function load() {
  try {
    const [current, events, history] = await Promise.all([
      fetch("./data/current.json").then((r) => r.json()),
      fetch("./data/events.json").then((r) => r.json()).catch(() => ({ events: [] })),
      fetch("./data/history.json").then((r) => r.json()).catch(() => ({ products: {} })),
    ]);
    STATE = { products: current.products, history };
    renderUpdated(current.generatedAt);
    renderStats(current.totals);
    renderSales(current.products);
    renderActivity(events.events || []);
    renderTable();
    $("#product-count").textContent = `Tracking ${current.products.length} sets.`;
  } catch (err) {
    $("#updated").textContent = "Couldn't load data yet — the first check may not have run.";
    console.error(err);
  }
}

function renderUpdated(iso) {
  $("#updated").textContent = `Last checked ${timeAgo(iso)} · ${new Date(iso).toLocaleString()}`;
}

function renderStats(t) {
  const items = [
    { big: t.products, lbl: "sets tracked" },
    { big: t.onSale, lbl: "on sale now", hot: t.onSale > 0 },
    { big: t.maxDiscountPct ? `${t.maxDiscountPct}%` : "—", lbl: "biggest discount", hot: t.maxDiscountPct > 0 },
  ];
  $("#stats").innerHTML = items
    .map((s) => `<div class="stat ${s.hot ? "hot" : ""}"><div class="big">${s.big}</div><div class="lbl">${s.lbl}</div></div>`)
    .join("");
}

function renderSales(products) {
  const onSale = products.filter((p) => p.onSale);
  $("#sale-count").textContent = onSale.length ? `(${onSale.length})` : "";
  $("#no-sales").hidden = onSale.length > 0;
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
          ${p.saleSince ? `<div class="since">since ${timeAgo(p.saleSince)}</div>` : ""}
        </div>
      </a>`
    )
    .join("");
}

function renderActivity(events) {
  $("#no-activity").hidden = events.length > 0;
  $("#activity").innerHTML = events
    .slice(0, 40)
    .map((e) => {
      const m = EVENT_META[e.type] || { ico: "•", tag: "mut", word: e.type };
      let detail = "";
      if (e.type === "SALE_START") detail = `now ${money(e.price)} <span class="was-sm">${money(e.compareAt)}</span> <span class="tag sale">-${e.discountPct}%</span>`;
      else if (e.type === "PRICE_DROP") detail = `${money(e.from)} → <b>${money(e.price)}</b>`;
      else if (e.type === "PRICE_RISE") detail = `${money(e.from)} → ${money(e.price)}`;
      else if (e.price != null) detail = money(e.price);
      return `<li>
        <span class="ev-ico">${m.ico}</span>
        <span class="ev-text"><span class="tag ${m.tag}">${m.word}</span> <b><a href="${e.url}" target="_blank" rel="noopener">${esc(e.title)}</a></b> ${detail}</span>
        <span class="ev-time">${timeAgo(e.t)}</span>
      </li>`;
    })
    .join("");
}

function renderTable() {
  const q = $("#search").value.trim().toLowerCase();
  const inStockOnly = $("#instock-only").checked;
  let rows = STATE.products.filter((p) => {
    if (inStockOnly && !p.available) return false;
    if (q && !(`${p.title} ${p.productType}`.toLowerCase().includes(q))) return false;
    return true;
  });

  rows.sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === "string") { av = av.toLowerCase(); bv = (bv || "").toLowerCase(); }
    if (av == null) av = -Infinity;
    if (bv == null) bv = -Infinity;
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return a.title.localeCompare(b.title);
  });

  $("#all-body").innerHTML = rows
    .map(
      (p) => `<tr>
        <td><img class="row-thumb" loading="lazy" src="${thumb(p.image)}" alt=""></td>
        <td><span class="row-name" data-id="${p.id}">${esc(p.title)}</span></td>
        <td>${esc(p.productType) || '<span class="dash">—</span>'}</td>
        <td class="num">${money(p.price)}${p.onSale ? `<span class="was-sm">${money(p.compareAt)}</span>` : ""}</td>
        <td class="num">${p.discountPct ? `<span class="disc">-${p.discountPct}%</span>` : '<span class="dash">—</span>'}</td>
        <td class="num">${money(p.lowestEver)}${p.atLowestEver ? ' <span class="lowflag">●</span>' : ""}</td>
        <td>${p.available ? '<span class="in">In stock</span>' : '<span class="out">Out</span>'}</td>
      </tr>`
    )
    .join("");

  document.querySelectorAll("#all-body .row-name").forEach((el) =>
    el.addEventListener("click", () => openModal(Number(el.dataset.id)))
  );

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.toggle("asc", th.dataset.sort === sortKey && sortDir === "asc");
    th.classList.toggle("desc", th.dataset.sort === sortKey && sortDir === "desc");
  });
}

// --- Price history modal -----------------------------------------------------

function openModal(id) {
  const p = STATE.products.find((x) => x.id === id);
  const entry = STATE.history.products[String(id)];
  if (!p) return;
  const points = (entry?.points || []).filter((pt) => pt.price != null);
  $("#modal-body").innerHTML = `
    <h3><a href="${p.url}" target="_blank" rel="noopener">${esc(p.title)}</a></h3>
    <div class="meta">${money(p.price)} now · all-time low ${money(p.lowestEver)} · ${points.length} price point${points.length === 1 ? "" : "s"} recorded</div>
    ${points.length >= 2 ? chartSVG(points) : '<p class="empty">Not enough history yet — points accumulate over time as prices change.</p>'}
  `;
  $("#modal").hidden = false;
}

function chartSVG(points) {
  const W = 500, H = 200, pad = 34;
  const xs = points.map((p) => new Date(p.t).getTime());
  const ys = points.map((p) => p.price);
  const cmp = points.map((p) => p.compareAt).filter((v) => v != null);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys, ...(cmp.length ? cmp : ys)) * 0.95;
  const maxY = Math.max(...ys, ...(cmp.length ? cmp : ys)) * 1.05;
  const sx = (x) => pad + ((x - minX) / (maxX - minX || 1)) * (W - pad * 2);
  const sy = (y) => H - pad - ((y - minY) / (maxY - minY || 1)) * (H - pad * 2);

  // Step line (prices hold until the next recorded change).
  let d = "";
  points.forEach((p, i) => {
    const x = sx(xs[i]), y = sy(p.price);
    if (i === 0) d += `M ${x} ${y}`;
    else d += ` L ${x} ${sy(points[i - 1].price)} L ${x} ${y}`;
  });
  d += ` L ${sx(maxX)} ${sy(points[points.length - 1].price)}`;

  const dots = points.map((p, i) => `<circle class="dot" cx="${sx(xs[i])}" cy="${sy(p.price)}" r="3" />`).join("");
  const yTicks = [minY, (minY + maxY) / 2, maxY]
    .map((v) => `<text x="4" y="${sy(v) + 4}">$${v.toFixed(0)}</text>`)
    .join("");
  const xLabels = `<text x="${pad}" y="${H - 8}">${new Date(minX).toLocaleDateString()}</text>
    <text x="${W - pad}" y="${H - 8}" text-anchor="end">${new Date(maxX).toLocaleDateString()}</text>`;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${yTicks}${xLabels}
    <path class="line" d="${d}" />
    ${dots}
  </svg>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- Wiring ------------------------------------------------------------------

$("#search").addEventListener("input", renderTable);
$("#instock-only").addEventListener("change", renderTable);
document.querySelectorAll("th.sortable").forEach((th) =>
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = k; sortDir = k === "title" || k === "productType" ? "asc" : "desc"; }
    renderTable();
  })
);
$("#modal-close").addEventListener("click", () => ($("#modal").hidden = true));
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#modal").hidden = true; });

load();
