// Statistics for the calibration harness.
//
// The point of all of this: Fit Check's verdict bands (±2 cm for tops,
// ±1.25 cm for bottoms) were chosen by hand before anyone had measured a
// single real garment. If the engine's typical error is larger than the band,
// then "likely fits" is claiming a precision the model does not have — which
// is the one failure mode the product brief says is unrecoverable.
//
// Every function here is pure so it can be tested without a browser.

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function stdDev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1));
}

// One calibration sample: what we said, versus what the tape says.
// error > 0 means the engine predicted the garment WIDER than it really is.
export function errorOf(sample) {
  return sample.predictedFlat - sample.actualFlat;
}

// How often the current band would actually have been right. A prediction is
// "within band" when the error is small enough that the verdict it produced
// would not have been misleading.
export function coverage(samples, band) {
  if (!samples.length) return null;
  const inside = samples.filter(s => Math.abs(errorOf(s)) <= band).length;
  return inside / samples.length;
}

// The band width needed to be right `target` of the time — read straight off
// the observed error distribution rather than assumed.
export function bandForCoverage(samples, target = 0.8) {
  if (!samples.length) return null;
  const abs = samples.map(s => Math.abs(errorOf(s)));
  return quantile(abs, target);
}

export function summarize(samples) {
  if (!samples.length) return { n: 0 };
  const errors = samples.map(errorOf);
  const abs = errors.map(Math.abs);
  return {
    n: samples.length,
    // Signed: tells us whether the engine leans systematically big or small,
    // which is fixable with an offset. Unsigned tells us the noise floor,
    // which is not.
    bias: mean(errors),
    mae: mean(abs),
    median: quantile(abs, 0.5),
    p90: quantile(abs, 0.9),
    worst: Math.max(...abs),
    sd: stdDev(errors),
  };
}

// Break the error down by any key, so a single bad brand doesn't hide inside
// a decent-looking average.
export function groupBy(samples, keyFn) {
  const groups = new Map();
  for (const s of samples) {
    const k = keyFn(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({ key, ...summarize(items) }))
    .sort((a, b) => b.n - a.n || b.mae - a.mae);
}

// The headline judgement. Deliberately blunt, because the comfortable reading
// of a small sample is what would let a bad band survive.
export function verdictOnBand(samples, currentBand) {
  const s = summarize(samples);
  if (!s.n) return { state: 'empty', text: 'No measurements yet.' };
  if (s.n < 10) {
    return {
      state: 'insufficient',
      text: `${s.n} measurement${s.n === 1 ? '' : 's'} is too few to conclude anything. Aim for 15–20.`,
    };
  }
  const cov = coverage(samples, currentBand);
  const needed = bandForCoverage(samples, 0.8);
  if (cov >= 0.8) {
    return {
      state: 'ok',
      text: `The current ±${currentBand} cm band held for ${Math.round(cov * 100)}% of your garments. It is defensible.`,
      needed,
    };
  }
  return {
    state: 'too-tight',
    text: `The current ±${currentBand} cm band only held for ${Math.round(cov * 100)}% of your garments. `
      + `To be right 80% of the time it would need to be about ±${needed.toFixed(1)} cm — `
      + `so today's "likely fits" is claiming more precision than the model has.`,
    needed,
  };
}

export function toCsv(samples) {
  const head = 'date,brand,dept,category,size,source,predicted_cm,actual_cm,error_cm';
  const rows = samples.map(s => [
    s.date, s.brandId, s.dept, s.category, s.size, s.source,
    s.predictedFlat.toFixed(2), s.actualFlat.toFixed(2), errorOf(s).toFixed(2),
  ].join(','));
  return [head, ...rows].join('\n');
}
