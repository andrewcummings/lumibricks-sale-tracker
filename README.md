# 💡 LumiBricks Sale Tracker

A zero-cost, zero-server tracker that watches **every set on [lumibricks.com](https://www.lumibricks.com)** and tells you the moment something goes on sale or drops in price.

- **Checker** — a tiny dependency-free Node script reads the store's public Shopify feed, computes each set's price and discount, and records changes (sale started/ended, price drop/rise, restock, new/removed set).
- **Dashboard** — a static webpage (no build step) showing what's on sale now, recent activity, an all-sets table, and per-set price-history charts.
- **Automation** — a GitHub Actions cron runs the checker hourly and commits the refreshed data. GitHub Pages serves the dashboard for free.
- **Amazon (optional)** — add a free scraper-API key and the dashboard also tracks each set's Amazon price, flags the cheaper channel, and shows Amazon price history. See [Amazon price tracking](#amazon-price-tracking-optional).

```
scripts/check.mjs              # the LumiBricks (Shopify) price checker
scripts/amazon.mjs             # daily Amazon price checker (optional, needs an API key)
scripts/discover-asins.mjs     # one-time-ish: maps each set to its Amazon ASIN
scripts/lib/                   # scraperapi client, amazon-parse, sets helpers
docs/index.html                # dashboard (served by GitHub Pages)
docs/app.js, docs/style.css
docs/data/*.json               # current/history/events + amazon-* + asin-map (auto-updated)
.github/workflows/check.yml    # hourly LumiBricks cron + commit
.github/workflows/amazon.yml   # daily Amazon cron (no-op until you add the key)
.github/workflows/amazon-discover.yml  # manual: build the ASIN map
```

## How a "sale" is detected

LumiBricks runs on Shopify, which exposes a public `products.json` feed. Each variant
has a `price` and an optional `compare_at_price`. A set is **on sale** when
`compare_at_price` is set above the current `price`; the discount is
`(compare_at − price) / compare_at`. Sets have regional variants (US/EU/CA/UK/Global),
so the checker aggregates them into one representative price and the **best** discount.

**Automatic (cart-level) discounts too — this is where most LumiBricks sales live.**
Many promos (e.g. `FATHERS_DAY10` 10% off, `SPECIALOFF30` 30% off) are Shopify
*automatic discounts* applied at checkout. They never set `compare_at_price`, so they're
invisible in `products.json` — a set can be 30% off and still look full-price there.
The checker reads them via the official **Storefront GraphQL API**: it creates a cart
(one stateless `cartCreate` call per ~50 variants, no cookies) and reads each line's
`discountAllocations` — the discounted price and promo title. These merge into sale
detection and show with a promo label (e.g. `🏷️ FATHERS_DAY10`).

Why the Storefront API and not the AJAX cart (`/cart.js`)? The AJAX cart endpoints are
bot-protected and return `429` from datacenter/CI IPs. The Storefront API is the
supported headless interface — not bot-blocked — using a public storefront token read
from the theme (overridable via the `STOREFRONT_TOKEN` env var). Still best-effort: if it
ever fails, the checker falls back to `compare_at`-only detection.

## Run it locally

```bash
node scripts/check.mjs        # fetches the feed, writes docs/data/*.json
cd docs && python3 -m http.server 8000   # then open http://localhost:8000
```

The first run seeds the data. Price-history charts fill in over time, as later runs
record changes.

## Deploy (one-time setup)

1. **Push this repo to GitHub.**
2. **Enable Pages:** repo **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**, then pick branch **`main`** and folder **`/docs`**. Save. Your dashboard will be at `https://<you>.github.io/<repo>/`.
3. **Enable Actions write access (usually already on):** **Settings → Actions → General → Workflow permissions → "Read and write permissions"**. This lets the hourly job commit the refreshed data.
4. That's it. The workflow runs every hour, or you can trigger it anytime from the **Actions** tab → *Check LumiBricks sales* → **Run workflow**.

> Note: GitHub disables scheduled workflows after ~60 days of no repo activity — the
> hourly commits keep it alive on their own, but if the repo ever goes idle, re-enable
> the workflow from the Actions tab.

## Amazon price tracking (optional)

LumiBricks also sells on Amazon, often at different prices. The dashboard can show
**LumiBricks vs Amazon side by side**, flag the cheaper channel, track Amazon price
history, and link to the full Keepa chart per set.

Amazon has no clean public feed and blocks direct scraping, so this routes through
[ScraperAPI](https://www.scraperapi.com)'s **structured Amazon endpoint** (returns
clean JSON — no HTML parsing). Its free tier is **permanent: 1,000 credits/month,
renews, no credit card**. Amazon costs 5 credits/request, so ~200 lookups/month —
enough for a **full-catalog sweep ~twice a month** (the default cadence). **Until
you add a key, the Amazon workflows no-op and the dashboard stays LumiBricks-only.**

### Setup
1. **Get a free key:** sign up at [scraperapi.com](https://www.scraperapi.com) (no card) and copy your API key from the dashboard.
2. **Add it as a secret:** repo **Settings → Secrets and variables → Actions → New repository secret**, name **`SCRAPERAPI_KEY`**, paste the key.
3. **Build the ASIN map:** **Actions tab → "Discover Amazon ASINs" → Run workflow.** 💡 Do this in your **first 7 days** — new accounts get a 5,000-credit trial that week, so discovery (~5 credits/set) won't eat your recurring 1,000/mo. Re-run to finish any gaps. Then skim `docs/data/asin-map.json` — for any wrong/low-confidence row, set the right `asin` and `"status": "manual"` to lock it in.
4. Done. The **"Check Amazon prices"** workflow runs on the 1st & 15th and fills in the Amazon columns.

### Notes & tuning
- **Budget math:** 1,000 credits/mo ÷ 5 = ~200 Amazon lookups. Two full sweeps of ~90 sets ≈ 900 credits. Discovery is one-time (~450 credits) — best spent during the trial week.
- **Want more frequent checks?** Either narrow to a watchlist (delete/`"status":"skip"` rows in `asin-map.json`) and raise the `cron` frequency in `amazon.yml`, or upgrade your ScraperAPI plan. Volume per run is capped by `AMAZON_MAX` (env in `amazon.yml`); discovery by `DISCOVER_MAX` / `DISCOVER_MIN_SCORE`.
- **Heads-up:** scraping Amazon is against Amazon's ToS regardless of the tool; this is intended for personal price-tracking. Free tiers can change — cadence/scope are kept as easy-to-edit config.

## Tuning

- **Check frequency:** edit the `cron` in `.github/workflows/check.yml` (e.g. `*/30 * * * *` for every 30 min).
- **Want phone push too?** The `events.json` log is the natural hook — a few lines in `check.mjs`/`amazon.mjs` could POST new `SALE_START`/`PRICE_DROP` events to a Telegram bot or Discord webhook. Ask and I'll wire it in.
