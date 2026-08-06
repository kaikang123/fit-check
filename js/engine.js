// Comparison engine. Predicts a garment's flat main width (chest for tops,
// waist for bottoms) from the best available source, compares it to the
// profile's reference garment of the same family, and returns a verdict with
// an explicit confidence level and reasons.
//
// Source hierarchy (best first):
//   1. Direct measurement (photo tool) — garment-to-garment, high confidence
//   2. Chart + personal offset learned from the user's own closet logs — high
//   3. Bundled brand chart + ease assumption — medium
//   4. Anything vintage — low, with drift correction applied

import {
  BRANDS, CATEGORIES, FAMILIES, CUTS, FEEL_CM, ERAS,
  FIT_PREFERENCES, FAMILY_BAND_SCALE,
} from './data.js';
import { fmt, fmtSigned as fmtSignedUnit } from './units.js';

export function brandById(id) {
  return BRANDS.find(b => b.id === id) || null;
}

function avg(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Number of logs before a brand's correction is treated as well-established.
export const CONFIDENT_SAMPLE = 3;

// Half of the entries' influence is lost every this many days, so a brand
// re-sized two years ago stops dominating what it does today.
const HALF_LIFE_DAYS = 540;

function recencyWeight(dateStr) {
  if (!dateStr) return 1;
  const days = (Date.now() - new Date(dateStr).getTime()) / 86400000;
  if (!Number.isFinite(days) || days <= 0) return 1;
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

// Weighted median: the robustness of a median with recency taken into account.
// A single mistaken log can shift a mean arbitrarily far; it cannot do that
// here, which matters because every log is a human judgement call.
function weightedMedian(pairs) {
  const sorted = [...pairs].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, p) => sum + p.weight, 0);
  if (!total) return median(sorted.map(p => p.value));
  let acc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc >= total / 2) return p.value;
  }
  return sorted[sorted.length - 1].value;
}

// Chart-derived flat width for a brand/dept/category/size, before any
// personal offset.
export function chartFlat(brand, dept, category, size, cut) {
  const cat = CATEGORIES[category];
  const chart = brand.charts[dept]?.[cat.family];
  if (!chart || !(size in chart)) return null;
  return (chart[size] + cat.ease + CUTS[cut].mod) / 2;
}

// Personal offset for a brand+dept+family, learned from this profile's closet
// logs. Each log implies where that garment's real flat width sits relative
// to the reference ("just right" = same as reference, each feel step ≈ FEEL_CM).
function personalOffset(profile, ref, brand, dept, family) {
  const logs = profile.closet.filter(l =>
    l.brandId === brand.id && l.dept === dept && CATEGORIES[l.category].family === family);
  const pairs = [];
  for (const log of logs) {
    const cf = chartFlat(brand, dept, log.category, log.size, 'regular');
    if (cf == null) continue;
    pairs.push({ value: ref.main + log.feel * FEEL_CM - cf, weight: recencyWeight(log.date) });
  }
  if (!pairs.length) return null;

  const values = pairs.map(p => p.value);
  const offset = weightedMedian(pairs);
  // Spread across the logs. Wide disagreement means the brand is inconsistent
  // (or a log was a mistake), and the UI should not present it as settled.
  const spread = values.length > 1
    ? Math.max(...values) - Math.min(...values)
    : 0;
  return { offset, count: pairs.length, spread, mean: avg(values) };
}

// Everything this profile's model has worked out so far, per brand and family.
// Each entry is a real learned correction to that brand's published sizing —
// the thing that makes one person's predictions differ from another's even
// when their measurements match.
export function learnedOffsets(profile) {
  const ref = { tops: null, bottoms: null };
  for (const family of Object.keys(ref)) {
    ref[family] = profile.refs.find(r => r.id === profile.activeRefs?.[family])
      || profile.refs.find(r => r.family === family) || null;
  }

  const out = [];
  for (const brand of BRANDS) {
    for (const dept of ['men', 'women']) {
      for (const family of ['tops', 'bottoms']) {
        if (!ref[family]) continue;
        const personal = personalOffset(profile, ref[family], brand, dept, family);
        if (!personal) continue;
        out.push({
          brandId: brand.id, brandName: brand.name,
          dept, family,
          offset: personal.offset, count: personal.count, spread: personal.spread,
          settled: personal.count >= CONFIDENT_SAMPLE,
          // Logs that disagree by more than a size step aren't really telling
          // one story about this brand.
          inconsistent: personal.spread > FEEL_CM * 2,
          // Positive offset means the garment runs wider than the chart implies.
          direction: personal.offset > 0.25 ? 'large' : personal.offset < -0.25 ? 'small' : 'true',
        });
      }
    }
  }
  return out.sort((a, b) => b.count - a.count || Math.abs(b.offset) - Math.abs(a.offset));
}

// Total number of signals the model has been trained on.
export function trainingSignals(profile) {
  const fromOutcomes = profile.history.filter(h => h.outcome != null).length;
  return { closet: profile.closet.length, outcomes: fromOutcomes };
}

// Predict flat main width for a manual-entry check. `unit` affects only how
// the human-readable reasons are worded; all maths stays in centimetres.
export function predict(profile, ref, { brandId, dept, category, size, cut, era }, unit = 'cm') {
  const brand = brandById(brandId);
  if (!brand) return null;
  const base = chartFlat(brand, dept, category, size, cut);
  if (base == null) return null;

  const cat = CATEGORIES[category];
  const fam = FAMILIES[cat.family];
  const reasons = [];
  let flat = base;
  let confidence = 'medium';

  reasons.push(`${brand.name} chart: ${dept === 'men' ? "men's" : "women's"} ${size} ≈ ${fmt(brand.charts[dept][cat.family][size], unit)} body ${fam.mainShort} (bundled approximate chart)`);
  reasons.push(`${cat.label}, ${CUTS[cut].label.toLowerCase()}: assumed ${fmt(cat.ease + CUTS[cut].mod, unit)} ease — charts describe bodies, not garments`);

  const personal = personalOffset(profile, ref, brand, dept, cat.family);
  if (personal) {
    flat += personal.offset;
    // One log is a data point, not a pattern. Claiming high confidence off a
    // single entry was overselling it — and contradicted the fit-model screen,
    // which has always called anything under three garments "early".
    const settled = personal.count >= CONFIDENT_SAMPLE;
    confidence = settled ? 'high' : 'medium';
    reasons.push(`Adjusted ${fmtSignedUnit(personal.offset, unit)} from ${personal.count} ${brand.name} ${fam.label.toLowerCase()} garment${personal.count > 1 ? 's' : ''} in your closet log`);
    if (!settled) {
      reasons.push(`Only ${personal.count} log${personal.count > 1 ? 's' : ''} for this brand so far — ${CONFIDENT_SAMPLE - personal.count} more and this becomes a confident correction`);
    }
  }

  const eraInfo = ERAS[era] || ERAS.current;
  if (eraInfo.shift !== 0) {
    flat += eraInfo.shift;
    confidence = 'low';
    reasons.push(`${eraInfo.label} garment: sizing has drifted since — estimate shifted ${fmtSignedUnit(eraInfo.shift, unit)}, treat with caution`);
  }

  return applyReferenceConfidence({ flat, confidence, reasons }, ref);
}

// Verdict thresholds in flat cm. Bottoms are tighter because 1 cm flat at the
// waist matters more than 1 cm flat at the chest.
const THRESHOLDS = {
  tops:    { tight2: -4,   tight1: -2,    fit: 2,    loose1: 4.5 },
  bottoms: { tight2: -2.5, tight1: -1.25, fit: 1.25, loose1: 3 },
};

// Compare a predicted (or directly measured) flat width to the reference.
//
// `preference` slides the whole tolerance window. It deliberately does not
// touch `flat` or `ref.main`: the reference garment already embodies how this
// person likes clothes to sit, so shifting the measurement would count that
// twice. Moving the window instead changes only what we call a good fit.
export function verdict(flat, ref, predSecondary, unit = 'cm', preference = 'regular') {
  const fam = FAMILIES[ref.family];
  const base = THRESHOLDS[ref.family];
  const p = FIT_PREFERENCES[preference] ?? FIT_PREFERENCES.regular;
  const scale = FAMILY_BAND_SCALE[ref.family];
  const tightExt = p.tightExt * scale;
  const looseExt = p.looseExt * scale;
  const t = {
    tight2: base.tight2 - tightExt, tight1: base.tight1 - tightExt,
    fit: base.fit + looseExt, loose1: base.loose1 + looseExt,
  };
  const shift = tightExt || looseExt;

  const d = flat - ref.main;
  let band, title;
  if (d < t.tight2)      { band = 'tight2'; title = 'Too tight — skip it'; }
  else if (d < t.tight1) { band = 'tight1'; title = 'Runs snug for how you like things'; }
  else if (d <= t.fit)   { band = 'fit';    title = preference === 'regular' ? 'Likely fits — close to your reference' : `Likely fits — ${preference === 'baggy' ? 'roomy' : 'close-cut'}, how you like it`; }
  else if (d <= t.loose1){ band = 'loose1'; title = 'Slightly loose for how you like things'; }
  else                   { band = 'loose2'; title = 'Oversized for how you like things'; }

  let detail = `Estimated ${fmt(flat, unit)} across the ${fam.mainShort} vs your reference at ${fmt(ref.main, unit)} (${fmtSignedUnit(d, unit)}).`;
  if (shift !== 0) {
    detail += ` Judged against your ${FIT_PREFERENCES[preference].label.toLowerCase()} preference.`;
  }

  if (predSecondary != null && ref.secondary != null) {
    const dl = predSecondary - ref.secondary;
    if (dl > 3) detail += ` Also runs ${fmt(dl, unit)} longer in the ${fam.secondaryShort} than your reference.`;
    else if (dl < -3) detail += ` Also runs ${fmt(Math.abs(dl), unit)} shorter in the ${fam.secondaryShort} than your reference.`;
  }

  return { delta: d, band, title, detail, thresholds: t };
}

// Where a garment sits on the tolerance scale, as fractions of the gauge
// width, so the UI can draw it without duplicating any threshold logic.
export function gaugeGeometry(ref, delta, preference = 'regular') {
  const base = THRESHOLDS[ref.family];
  const p = FIT_PREFERENCES[preference] ?? FIT_PREFERENCES.regular;
  const scale = FAMILY_BAND_SCALE[ref.family];
  const t = {
    tight2: base.tight2 - p.tightExt * scale,
    tight1: base.tight1 - p.tightExt * scale,
    fit: base.fit + p.looseExt * scale,
    loose1: base.loose1 + p.looseExt * scale,
  };
  // Show a little beyond the outermost bands so extremes stay on the gauge.
  const span = Math.max(Math.abs(t.tight2), Math.abs(t.loose1)) * 1.6;
  const pos = v => Math.min(1, Math.max(0, (v + span) / (span * 2)));
  return {
    span,
    marker: pos(delta),
    clamped: Math.abs(delta) > span,
    stops: {
      tight2: pos(t.tight2), tight1: pos(t.tight1),
      fit: pos(t.fit), loose1: pos(t.loose1),
    },
  };
}

// A scan-derived reference is itself an estimate, so anything measured against
// it inherits that uncertainty no matter how good the garment data is.
const DOWNGRADE = { high: 'medium', medium: 'low', low: 'low' };

export function applyReferenceConfidence(pred, ref) {
  if (!pred || !ref?.derived) return pred;
  const level = DOWNGRADE[pred.confidence];
  return {
    ...pred,
    confidence: level,
    // Name the actual limiting factor: the reference, not the garment data.
    confidenceLabel: `${level === 'medium' ? 'Medium' : 'Low'} confidence — limited by your preliminary body scan`,
    reasons: [
      ...pred.reasons,
      'Your reference is a preliminary body-scan estimate — measure a garment that fits you well to firm this up',
    ],
  };
}

export const CONFIDENCE_LABELS = {
  high:   'High confidence — based on your own data',
  medium: 'Medium confidence — size-chart estimate',
  low:    'Low confidence — vintage sizing uncertainty',
};
