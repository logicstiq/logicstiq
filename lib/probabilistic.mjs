// ═══════════════════════════════════════════════════════════════════════════════════════════
// probabilistic.js — LogicstIQ AI Demand Planner — PROBABILISTIC FORECASTING (God-mode add-on v1)
// ─────────────────────────────────────────────────────────────────────────────
// The keystone accuracy upgrade: return a DISTRIBUTION of demand (P50/P90/P95), not a
// single point. This unlocks (a) fan-chart risk views and (b) newsvendor ordering —
// "stock to the 90th-percentile of lead-time demand" — which is the correct, coherent
// replacement for a bolted-on safety-stock step.
//
// Two regimes:
//   • data-rich / high-mean  → Normal band from bootstrapped one-step residuals, √h-scaled
//   • sparse / intermittent  → count distribution (Poisson, or Negative-Binomial if overdispersed)
//
// Also ships coverage() so you can PROVE calibration ("our 90% band is 91% accurate on your
// data") and newsvendorReorderPoint() to feed the reorder logic.
//
// 100% ADDITIVE, self-contained, no imports, no visual/copy changes.
// ─────────────────────────────────────────────────────────────────────────────

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.map(x => (x - m) ** 2).reduce((x, y) => x + y, 0) / (a.length - 1)); };

// Acklam's inverse normal CDF (probit). Accurate to ~1e-9. z for a probability p∈(0,1).
export function probit(p) {
  if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl; let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function normalQuantile(m, sigma, level) { return Math.max(0, m + probit(level) * sigma); }

// Poisson quantile by CDF accumulation (mean m). Bounded iterations.
function poissonQuantile(m, level) {
  if (m <= 0) return 0;
  let pmf = Math.exp(-m), cdf = pmf, k = 0;
  const cap = Math.ceil(m + 12 * Math.sqrt(m + 1) + 20);
  while (cdf < level && k < cap) { k++; pmf *= m / k; cdf += pmf; }
  return k;
}

// Negative-Binomial quantile for overdispersed counts (mean m, variance v>m).
function nbQuantile(m, v, level) {
  if (m <= 0) return 0;
  if (v <= m * 1.05) return poissonQuantile(m, level);
  const r = (m * m) / (v - m);          // number of "successes"
  const p = r / (r + m);                // success probability
  let pmf = Math.pow(p, r), cdf = pmf, k = 0;
  const cap = Math.ceil(m + 14 * Math.sqrt(v) + 30);
  while (cdf < level && k < cap) { k++; pmf *= ((k - 1 + r) / k) * (1 - p); cdf += pmf; }
  return k;
}

/**
 * quantileForecast(demands, opts) → probabilistic horizon demand.
 *   demands: per-period historical demand (non-negative numbers)
 *   opts.gap: days per period (default 30)
 *   opts.horizonDays: horizon to forecast (default 30)
 *   opts.levels: quantile levels (default [0.5, 0.9, 0.95])
 *   opts.centre: engine point forecast for the horizon total (keeps the P50 consistent
 *                with the existing engine number); if omitted, derived from the series
 *   opts.pattern: 'intermittent'|'lumpy'|'new' forces the count regime
 *   opts.alpha: SES smoothing for residual generation (default 0.4)
 */
export function quantileForecast(demands, opts = {}) {
  const gap = opts.gap || 30;
  const horizonDays = opts.horizonDays || 30;
  const levels = (opts.levels || [0.5, 0.9, 0.95]).slice().sort((a, b) => a - b);
  const alpha = opts.alpha != null ? opts.alpha : 0.4;
  const clean = (demands || []).map(Number).filter(d => isFinite(d) && d >= 0);
  const n = clean.length;
  const steps = Math.max(1, Math.round(horizonDays / gap));

  // SES level as the per-period point estimate
  let lvl = clean[0] || 0;
  for (let i = 1; i < n; i++) lvl = alpha * clean[i] + (1 - alpha) * lvl;
  const perPeriodMean = n ? Math.max(0, lvl) : 0;

  // One-step rolling residuals for the empirical error distribution
  const resid = [];
  if (n >= 4) {
    const start = Math.max(2, Math.floor(n / 3));
    for (let t = start; t < n; t++) {
      let l = clean[0]; for (let i = 1; i < t; i++) l = alpha * clean[i] + (1 - alpha) * l;
      resid.push(clean[t] - Math.max(0, l));
    }
  }
  let residSigma = resid.length >= 2 ? std(resid) : std(clean);
  if (!isFinite(residSigma) || residSigma <= 0) residSigma = Math.max(perPeriodMean * 0.2, 0.5 * Math.sqrt(perPeriodMean + 1));

  const horizonMean = opts.centre != null ? Math.max(0, opts.centre) : perPeriodMean * steps;
  const horizonSigma = residSigma * Math.sqrt(steps);

  const intermittent = ['intermittent', 'lumpy', 'new'].includes(opts.pattern);
  const useCounts = intermittent || horizonMean < 20;

  let dist, quantiles = {};
  if (useCounts) {
    const v = Math.max(horizonMean * 1.1, horizonSigma * horizonSigma);
    dist = v > horizonMean * 1.05 ? 'nb' : 'poisson';
    for (const L of levels) quantiles['p' + Math.round(L * 100)] = nbQuantile(horizonMean, v, L);
    quantiles['p50'] = quantiles['p50'] != null ? quantiles['p50'] : nbQuantile(horizonMean, v, 0.5);
  } else {
    dist = 'normal';
    for (const L of levels) quantiles['p' + Math.round(L * 100)] = Math.round(normalQuantile(horizonMean, horizonSigma, L));
  }
  // Enforce monotonicity (quantiles must be non-decreasing in level)
  let prev = -Infinity;
  for (const L of levels) { const k = 'p' + Math.round(L * 100); quantiles[k] = Math.max(prev, quantiles[k]); prev = quantiles[k]; }

  return {
    dist, steps, gap, horizonDays,
    perPeriodMean: Math.round(perPeriodMean * 100) / 100,
    horizonMean: Math.round(horizonMean * 10) / 10,
    horizonSigma: Math.round(horizonSigma * 10) / 10,
    levels, quantiles,
    p50: quantiles.p50, p90: quantiles.p90, p95: quantiles.p95,
  };
}

/**
 * coverage(actuals, lowers, uppers) → fraction of actuals inside [lower, upper].
 * Use in back-tests to PROVE calibration of the prediction intervals.
 */
export function coverage(actuals, lowers, uppers) {
  const n = Math.min(actuals.length, lowers.length, uppers.length);
  if (!n) return null;
  let hit = 0;
  for (let i = 0; i < n; i++) if (actuals[i] >= lowers[i] && actuals[i] <= uppers[i]) hit++;
  return Math.round((hit / n) * 1000) / 1000;
}

/**
 * newsvendorReorderPoint(opts) — reorder point as an explicit service-level quantile of
 * lead-time demand. Coherent with the engine's combined demand + lead-time variance, but
 * expressed as P(serviceLevel) instead of a separate z×σ safety-stock add-on.
 */
export function newsvendorReorderPoint(opts = {}) {
  const v = Math.max(0, opts.dailyVelocity || 0);
  const sd = Math.max(0, opts.sigmaDaily || 0);
  const lt = Math.max(0, opts.leadTimeDays || 0);
  const ltVar = Math.max(0, opts.leadTimeVar || 0);
  let sl = opts.serviceLevel != null ? opts.serviceLevel : 0.95; if (sl > 1) sl /= 100;
  const muLT = v * lt;
  const sigmaLT = Math.sqrt(lt * sd * sd + v * v * ltVar * ltVar);
  const z = probit(Math.min(0.9995, Math.max(0.5, sl)));
  const rop = Math.ceil(muLT + z * sigmaLT);
  return { rop: Math.max(0, rop), muLT: Math.round(muLT * 10) / 10, sigmaLT: Math.round(sigmaLT * 10) / 10, z: Math.round(z * 100) / 100, serviceLevel: Math.round(sl * 100) };
}
