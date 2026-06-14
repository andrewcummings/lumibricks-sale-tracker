# 💡 LumiBricks Sale Tracker

A zero-cost, zero-server tracker that watches **every set on [lumibricks.com](https://www.lumibricks.com)** and tells you the moment something goes on sale or drops in price.

- **Checker** — a tiny dependency-free Node script reads the store's public Shopify feed, computes each set's price and discount, and records changes (sale started/ended, price drop/rise, restock, new/removed set).
- **Dashboard** — a static webpage (no build step) showing what's on sale now, recent activity, an all-sets table, and per-set price-history charts.
- **Automation** — a GitHub Actions cron runs the checker hourly and commits the refreshed data. GitHub Pages serves the dashboard for free.

```
scripts/check.mjs           # the price checker
docs/index.html             # dashboard (served by GitHub Pages)
docs/app.js, docs/style.css
docs/data/*.json            # current.json, history.json, events.json (auto-updated)
.github/workflows/check.yml # hourly cron + commit
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

## Tuning

- **Check frequency:** edit the `cron` in `.github/workflows/check.yml` (e.g. `*/30 * * * *` for every 30 min).
- **Want phone push too?** The `events.json` log is the natural hook — a few lines in `check.mjs` could POST new `SALE_START` events to a Telegram bot or Discord webhook. Ask and I'll wire it in.
