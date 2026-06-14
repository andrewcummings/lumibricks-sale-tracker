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
scripts/lib/                   # amazon-parse, webscraping, sets helpers
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
[WebScrapingAPI](https://www.webscrapingapi.com) — its free tier renews **5,000
requests/month** and bills Amazon at the flat 1-credit rate, so a daily check of
~90 sets (~2,700/mo) fits comfortably. **Until you add a key, the Amazon workflows
no-op and the dashboard stays LumiBricks-only.**

### Setup
1. **Get a free key:** sign up at [webscrapingapi.com](https://www.webscrapingapi.com) (no card) and copy your API key.
2. **Add it as a secret:** repo **Settings → Secrets and variables → Actions → New repository secret**, name **`WEBSCRAPING_API_KEY`**, paste the key.
3. **Build the ASIN map:** **Actions tab → "Discover Amazon ASINs" → Run workflow** (start with the default cap of 40; re-run to finish the rest). Then skim `docs/data/asin-map.json` — for any row with a wrong/low-confidence match, set the right `asin` and `"status": "manual"` so it's locked in and re-checked daily.
4. Done. The **"Check Amazon prices"** workflow then runs daily and the dashboard fills in the Amazon columns.

### Notes & tuning
- **ASIN discovery cost:** controlled by `DISCOVER_MAX` (workflow input) and `DISCOVER_MIN_SCORE` (env). Daily check volume is capped by `AMAZON_MAX` (env in `amazon.yml`).
- **Cadence:** Amazon checks daily by default (`cron` in `amazon.yml`). Lower frequency = less quota used.
- **Heads-up:** scraping Amazon is against Amazon's ToS regardless of the tool; this is intended for personal price-tracking. Free tiers are marketing funnels and can change — the cadence/scope are kept as easy-to-edit config.

## Tuning

- **Check frequency:** edit the `cron` in `.github/workflows/check.yml` (e.g. `*/30 * * * *` for every 30 min).
- **Want phone push too?** The `events.json` log is the natural hook — a few lines in `check.mjs`/`amazon.mjs` could POST new `SALE_START`/`PRICE_DROP` events to a Telegram bot or Discord webhook. Ask and I'll wire it in.
