# CLAUDE.md — dev context for the LumiBricks Sale Tracker

A zero-dependency price/sale tracker for **lumibricks.com** (a Shopify store).
Hourly checker → static dashboard on GitHub Pages, plus optional Amazon
cross-channel tracking. Node 20+ ESM, built-in `fetch`, vanilla-JS frontend, no
build step, no framework. Repo is **public**; dashboard at
`https://andrewcummings.github.io/lumibricks-sale-tracker/`.

## Layout
```
scripts/check.mjs            # LumiBricks checker (hourly): products.json + cart discounts → summarize → data
scripts/amazon.mjs           # Amazon price check (1st & 15th): ScraperAPI structured endpoint
scripts/discover-asins.mjs   # set→ASIN map; NEW_ONLY (scheduled weekly) vs full (manual)
scripts/keepa-backfill.mjs   # ONE-TIME: seed true all-time-low Amazon price from Keepa (KEEPA_KEY)
scripts/lib/cart.mjs         # Shopify Storefront GraphQL cart-discount detection (cartCreate)
scripts/lib/scraperapi.mjs   # ScraperAPI client (structured Amazon product/search)
scripts/lib/amazon-parse.mjs # parseMoney / normalizeProduct / extractSearchResults / titleMatchScore
scripts/lib/sets.mjs         # isTrackableSet (skips accessories/points-only items)
scripts/lib/keepa.mjs        # Keepa product API client + lowestNewFromProduct (all-time low)
docs/index.html|app.js|style.css   # dashboard (served by Pages from /docs)
docs/data/*.json             # AUTO-GENERATED, committed by workflows — do NOT hand-edit except asin-map.json
.github/workflows/*.yml      # check (hourly), amazon (1st/15th), amazon-discover (weekly + manual)
```

## How sales are detected (two mechanisms — both matter)
1. **`compare_at_price` markdowns** — visible in `products.json`. Plain.
2. **Automatic / cart-level discounts** (e.g. `FATHERS_DAY10`, `SPECIALOFF30`) —
   NOT in products.json. **This is where most LumiBricks sales actually live.**
   Read via the official **Storefront GraphQL API** (`cart.mjs`): `cartCreate`
   with one variant per set, read each line's `discountAllocations` +
   `cost.amountPerQuantity` (original) vs `cost.totalAmount` (final).
   - Why Storefront API and not the AJAX cart (`/cart.js`)? The AJAX cart is
     bot-blocked (429) from datacenter/CI IPs. Storefront API is not.
   - Public storefront token is scraped from the homepage HTML
     (`"accessToken":"…32hex…"`), fallback constant in `cart.mjs`, override via
     `STOREFRONT_TOKEN`. API version `2024-10`.

`summarize(product, cart)` in check.mjs unifies both into one
`{price, compareAt, onSale, discountPct, promo, available}`.

## Data-flow contracts (don't break these)
- Keys are **Shopify product id as a string** everywhere: `current.json` products,
  `amazon-current.json`, `asin-map.json`, `history.json`/`amazon-history.json`,
  and `cartMap` from `fetchCartDiscounts`. (Not variant id, not ASIN.)
- `docs/data/events.json` is **written by BOTH check.mjs and amazon.mjs**
  (read-merge-write, `source: "shopify"|"amazon"`, sliced to `MAX_EVENTS=500`).
- `amazon.mjs` reads `current.json` (produced by check.mjs) and `asin-map.json`.
- `lowestEver`/`atLowestEver` (in `amazon-current.json`) = min over that set's
  logged `amazon-history.json` points **plus** an optional `keepaLow` floor on the
  history entry (one-time Keepa backfill — true all-time low predating our logs).
  `amazon.mjs` re-folds `keepaLow` every run so the floor survives; `keepaLow` is a
  metadata field, NOT a charted point, so the modal price chart stays our-data-only.
  Status: **dormant** — needs a paid `KEEPA_KEY` nobody's added yet, so no entry
  carries `keepaLow` and the fold is a no-op. For the visual all-time low without a
  key, the modal embeds Keepa's free chart image (`graph.keepa.com/pricehistory.png`,
  see `keepaChart` in `app.js`) — no key, no credits, not numeric.
- `app.js` fetches current/history/events + amazon-current/amazon-history and
  merges client-side (`mergeAmazon`); preferences persist in localStorage **and**
  the URL hash (bookmarkable).

## Secrets / config
- **`SCRAPERAPI_KEY`** — GitHub Actions secret (free tier: 1,000 credits/mo,
  renews; Amazon = 5 credits/req). Was pasted in an old chat once → **rotate it**.
- **`STOREFRONT_TOKEN`** — optional override; otherwise scraped from the theme.
- **`KEEPA_KEY`** — only for `keepa-backfill.mjs` (one-time, run locally). Keepa is
  a paid token-bucket API; the backfill is ~1 token/ASIN (~96 total, one request).
  Not used by any workflow — no GitHub secret needed unless you re-run it in CI.
- Budget: twice-monthly Amazon sweep ≈ 96×5×2 = 960 credits/mo (tight vs 1,000).

## New sets
- LumiBricks side: automatic (hourly check picks up the full catalog + fires a
  `NEW_PRODUCT` event).
- Amazon side: `amazon-discover.yml` runs weekly in NEW_ONLY mode to map new sets
  cheaply; never re-searches the known-unmatched. Manual run = full pass.

## ASIN map (`docs/data/asin-map.json`) — the one data file humans edit
Statuses: `matched` (auto), `manual` (human-locked), `skip` (rejected/wrong/not
on Amazon — never re-searched), `unmatched`/`error` (retried by manual runs).
Auto-matches can be wrong (generic-title collisions); fix by setting the right
`asin` + `"status":"manual"`. A wildly-off Amazon price is the tell.

## Local dev / testing
- `node scripts/check.mjs` — needs no key for the LumiBricks side; the Storefront
  cart call usually works locally. **Caution:** hammering the store rate-limits
  your IP (429 on products.json/cart); back off and let GitHub Actions (clean IP)
  validate instead. Amazon scripts no-op without `SCRAPERAPI_KEY`.
- Parser tests were ad-hoc in `/tmp` (not committed). `summarize` is exported
  from check.mjs for unit testing; importing check.mjs does NOT run `main()`.
- Trigger workflows: `gh workflow run check.yml -R andrewcummings/lumibricks-sale-tracker`
  (also `amazon.yml`, `amazon-discover.yml`). Watch: `gh run list/view`.

## Known issues
See **`REVIEW-TODO.local.md`** (local-only, gitignored) for the prioritized list
of 15 reviewed bugs and fix sketches.
