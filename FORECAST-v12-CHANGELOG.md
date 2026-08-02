# AI Demand Planner — v12 accuracy fixes

Measured on a 15-SKU synthetic daily history (516 days) with a known generating process,
scored on the 60 days after the cutoff. "vs expectation" compares against noiseless expected
demand, which isolates systematic bias from single-draw noise.

| Build | WMAPE vs expectation | WMAPE vs realized |
|---|---|---|
| v10 as shipped | 12.8% | 15.8% |
| **v12 patched** | **5.3%** | **8.1%** |
| naive seasonal-mean benchmark | — | 16.7% |

Error more than halved. Every change is tagged `FIX(v12)` inline.

---

## 1. Launch detection — a new SKU was forecast at zero

`computeSKU`, time-series branch.

A SKU that went live part-way through the export carries a long run of leading zeros.
`classifyDemand` read that as *intermittent*, TSB returned ≈0, and the SKU was forecast at
**0 units against 2,013 units of real demand**. A seller launching a product was told to stock
nothing.

Cold-start seeding existed but sat only in the snapshot branch, unreachable for any dated file.

Fix: detect the launch point and trim pre-launch zeros when demand has been sustained since
(≥50% non-zero after launch, prefix ≥8% of the series). Trailing zeros are untouched, so dead
stock still reads as dead.

Result: 0 → 2,137 against 1,979 expected. This single SKU was 41% of all error.

## 2. Stockouts were only detected from columns almost nobody exports

`buildSkuMap`, dated-row aggregation.

`rowAvailability` looked for a stockout flag, in-stock days, available minutes or days-out-of-stock.
Marketplace exports carry none of those — they carry an **on-hand quantity**. So a row with zero
sales and zero sellable stock was read as genuine zero demand, deflating the level. The
censored-demand reconstruction in the v9 notes effectively never fired in production.

Fix: on a dated row with zero net sales and zero on-hand stock, treat availability as 0.

Result: the censored SKU went 0.72 → 0.97 of expectation, and its confidence rose to High.

## 3. Trend was unreachable on daily data

`buildForecaster`, model selection.

The gate was `|slope| / level > 0.05` on a **per-period** slope. A genuine 4%/month decline on
daily data scores 0.0014 and never trips it, so the trend model could not be selected on exactly
the granularity most sellers upload.

Fix: measure the slope's effect across the fitted window, not per period.

## 4. Damping killed the trend within ten days

`phi = 0.9` applied regardless of granularity. On daily data the damped trend is exhausted after
~10 days, so a 60-day forecast was effectively flat and a declining SKU never came down.

Fix: `phi` tied to granularity — 0.985 daily, 0.95 weekly, 0.9 monthly.

## 5. The level was anchored a year in the past

`linreg` was fitted over the whole series, so on a 516-day history the intercept sat far in the
past, lagging a growing SKU and holding up a declining one.

Fix: fit level and slope on the recent regime (25% of a daily series, min 56 points). The seasonal
index still uses the full-series phase, so weekday alignment is unchanged.

## 6. Trend weight now scales with trend strength

The blend was a fixed `0.6 × holt + 0.4 × level`. The level term carries no trend, so it held a
declining SKU up. Now ramps 0.6 → 0.85 as the fitted move grows.

## 7. TSB swung on whether the last few days were quiet

`tsbForecast` returned the end-state smoothed occurrence rate. With `b = 0.1` that is an effective
10-period window — far too reactive for a 60-day total on lumpy demand.

Fix: blend the smoothed rate 50/50 with the long-run rate. Lumpy SKU went 0.45 → 0.76 of expectation.

## 8. "Auto (AI selects best)" did not select

Auto was a hand-written heuristic, and it **lost to plain "Trend + Seasonality"** (5.7% vs 4.9%).
The file already contains a rolling-origin back-test.

Fix: Auto now scores every candidate out-of-sample and keeps the lowest WMAPE, requiring a 0.5pp
improvement before switching. Auto: 5.7% → 5.3%.

## 9. Dead stock was seeded as a new product

`computeSKU`, snapshot branch.

With no sales in the window, a SKU was seeded from category-median velocity and labelled
"Cold-start" — including a genuinely dead SKU sitting on 610 units of stock, which was handed a
699-unit forecast. Their own header notes list this as known and unfixed.

Fix: stock on hand distinguishes the two. A product holding inventory that sold nothing is dead,
not new, and is routed to dead stock instead of being seeded.

## 10. A stale file silently forecast a different period

`handler` / `buildSummary`, plus the dashboard.

The forecast origin is **today**, but nothing checked how old the file was. A history ending two
months ago with festival mode on had a festive-sale uplift applied to a window the data never saw
— inflating every SKU by ~40% with no warning, which reads to the user as a broken model.

Fix: the newest date in the file is now computed and exposed as `summary.dataEndDate` and
`summary.forecastOriginGapDays`. A gap over 7 days pushes a first-position data-quality warning
naming the festive interaction, and the dashboard shows an amber banner.

## 11. Two identical columns in the forecast table

With the horizon at 60, the table showed `Next 60 Days` **and** `Next 60d` — identical values —
next to `Next 90d`. Exporting the wrong one is a ~50% ordering error.

Fix: the horizon column is labelled "your horizon" and carries a tooltip; the CSV header is now
`Forecast (selected horizon)` rather than the ambiguous `Forecast`.

---

## Verified

- All 5 forecast methods run clean; Trend + Seasonality 4.9%, Auto 5.3%, Moving Average 7.3%
- Horizon binds correctly: 30/60/90 → 1,794 / 3,590 / 5,409
- Snapshot mode (no date column) still processes all rows
- Festival on and off both run without error
- Dead stock forecasts 0; duplicate SKU keys de-duped; multi-warehouse stock summed once;
  cancelled lines excluded; returns netted

## Not fixed, and why

- **Declining SKUs still read ~15% high.** The trend model is additive, real decay is
  multiplicative. I implemented a log-space trend and it scored *worse* (6.2% vs 5.3%), so I
  discarded it rather than ship a change that lost on the evidence. Worth revisiting with a
  proper Holt damped-multiplicative form.
- **Festive uplift magnitudes are not validated.** The test data uses the engine's own calendar,
  so festive behaviour is a shared assumption rather than an independent check.
- **Nothing here is validated against real marketplace exports.** These fixes address the
  arithmetic, not the messiness of a live Flipkart or Meesho file.
