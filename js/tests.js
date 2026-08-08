// Test suite. No framework — open tests.html in a browser, or read
// window.FIT_CHECK_RESULTS after it runs.
//
// These cover the maths and the decision rules, which is where a silent
// regression would do real damage: a wrong verdict looks exactly like a right
// one to the user.

import {
  BRANDS, CATEGORIES, FAMILIES, CUTS, ERAS, FEEL_CM,
  FIT_PREFERENCES, FAMILY_BAND_SCALE,
} from './data.js';
import { UNITS, toCm, fmt, fmtSigned, bounds } from './units.js';
import {
  ellipseCircumference, circumferenceAt, scaleFrom, spanCm,
  derivedFlat, ASSUMED_DEPTH_RATIO,
} from './bodymath.js';
import {
  chartFlat, predict, verdict, brandById, applyReferenceConfidence,
  learnedOffsets, trainingSignals, gaugeGeometry, CONFIDENT_SAMPLE,
} from './engine.js';
import * as catalog from './catalog.js';
import * as store from './store.js';
import { mergeState, mergeUserGarments, mergeCalibration } from './syncmerge.js';
import {
  summarize, quantile, coverage, bandForCoverage, verdictOnBand, groupBy, errorOf, toCsv,
} from './calibmath.js';
import {
  parseTag, findBrand, findSize, findDept, findFibres, stretchOf, describe,
  findPrices, findCut, findGarmentType,
} from './tagparse.js';

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
  }
}

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function near(actual, expected, tolerance, msg = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg} expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

function truthy(v, msg = '') {
  if (!v) throw new Error(`${msg} expected truthy, got ${JSON.stringify(v)}`);
}

/* ---------- Fixtures ---------- */

const topsRef = { id: 'r1', family: 'tops', category: 'tshirt', main: 53, secondary: 70 };
const bottomsRef = { id: 'r2', family: 'bottoms', category: 'pants', main: 41, secondary: 76 };
const derivedRef = { ...topsRef, id: 'r3', derived: true };

function profile(overrides = {}) {
  return {
    id: 'p1', name: 'Test', dept: 'men',
    refs: [topsRef, bottomsRef], activeRefs: { tops: 'r1', bottoms: 'r2' },
    closet: [], history: [], ...overrides,
  };
}

/* ---------- Units ---------- */

test('cm is the identity unit', () => {
  eq(toCm(53, 'cm'), 53);
});

test('inches convert to cm exactly', () => {
  near(toCm(21, 'in'), 53.34, 1e-9);
});

test('unit round-trip does not drift', () => {
  const cm = toCm(21, 'in');
  near(cm * UNITS.in.perCm, 21, 1e-9);
});

test('fmt trims trailing zeros and appends the unit', () => {
  eq(fmt(53, 'cm'), '53 cm');
  eq(fmt(53.34, 'in'), '21 in');
});

test('fmtSigned uses a real minus sign for negatives', () => {
  truthy(fmtSigned(-2.5, 'cm').startsWith('−'), 'negative delta');
  truthy(fmtSigned(2.5, 'cm').startsWith('+'), 'positive delta');
});

test('bounds scale with the unit and entry mode', () => {
  eq(bounds('tops', 'flat', 'cm').max, 120);
  eq(bounds('tops', 'circ', 'cm').max, 240);
  eq(bounds('tops', 'flat', 'in').max, Math.ceil(120 / 2.54));
});

test('a 90+ cm chest is accepted as flat entry', () => {
  const b = bounds('tops', 'flat', 'cm');
  truthy(95 >= b.min && 95 <= b.max, '95 cm flat should be in range');
});

/* ---------- Body geometry ---------- */

test('a circle is the degenerate ellipse', () => {
  near(ellipseCircumference(30, 30), Math.PI * 30, 1e-9);
});

test('Ramanujan matches numerical integration', () => {
  const a = 16, b = 11.5;
  let exact = 0;
  const N = 100000;
  for (let i = 0; i < N; i++) {
    const t1 = 2 * Math.PI * i / N, t2 = 2 * Math.PI * (i + 1) / N;
    exact += Math.hypot(a * Math.cos(t2) - a * Math.cos(t1), b * Math.sin(t2) - b * Math.sin(t1));
  }
  near(ellipseCircumference(32, 23), exact, 1e-4);
});

test('circumference grows with depth', () => {
  truthy(ellipseCircumference(32, 25) > ellipseCircumference(32, 20), 'deeper torso is bigger');
});

test('skipping the side view assumes a depth and flags it', () => {
  const r = circumferenceAt('chest', 32, null);
  near(r.depth, 32 * ASSUMED_DEPTH_RATIO.chest, 1e-9);
  eq(r.estimatedDepth, true);
});

test('supplying a side view is not flagged as estimated', () => {
  eq(circumferenceAt('chest', 32, 23).estimatedDepth, false);
});

test('height calibration yields pixels per cm', () => {
  near(scaleFrom({ x: 0, y: 100 }, { x: 0, y: 1700 }, 178), 1600 / 178, 1e-9);
  eq(scaleFrom({ x: 0, y: 100 }, { x: 0, y: 100 }, 178), null, 'zero span is unusable');
});

test('spanCm converts pixel distance at scale', () => {
  near(spanCm({ x: 0, y: 0 }, { x: 100, y: 0 }, 10), 10, 1e-9);
});

test('fit preference shifts derived garment width', () => {
  const base = derivedFlat(96, CATEGORIES.tshirt.ease, FIT_PREFERENCES.regular.ease);
  const baggy = derivedFlat(96, CATEGORIES.tshirt.ease, FIT_PREFERENCES.baggy.ease);
  const tight = derivedFlat(96, CATEGORIES.tshirt.ease, FIT_PREFERENCES.tight.ease);
  eq(base, 52);
  truthy(baggy > base && base > tight, 'baggy > regular > tight');
});

/* ---------- Fit preference ---------- */

test('preference does not alter the measured difference', () => {
  const a = verdict(57, topsRef, null, 'cm', 'regular');
  const b = verdict(57, topsRef, null, 'cm', 'baggy');
  eq(a.delta, b.delta, 'the garment is the same size either way');
});

test('the reference garment itself always reads as a fit', () => {
  for (const p of Object.keys(FIT_PREFERENCES)) {
    eq(verdict(topsRef.main, topsRef, null, 'cm', p).band, 'fit', `${p}: exact match`);
    eq(verdict(bottomsRef.main, bottomsRef, null, 'cm', p).band, 'fit', `${p}: exact match, bottoms`);
  }
});

test('baggy tolerates room that regular calls oversized', () => {
  eq(verdict(58, topsRef, null, 'cm', 'regular').band, 'loose2');
  eq(verdict(58, topsRef, null, 'cm', 'baggy').band, 'fit');
});

test('tight flags room that regular accepts', () => {
  eq(verdict(55, topsRef, null, 'cm', 'regular').band, 'fit');
  eq(verdict(55, topsRef, null, 'cm', 'tight').band, 'loose1');
});

test('tight accepts snugness that regular flags', () => {
  eq(verdict(50, topsRef, null, 'cm', 'regular').band, 'tight1');
  eq(verdict(50, topsRef, null, 'cm', 'tight').band, 'fit');
});

test('baggy does not make snug garments more acceptable', () => {
  eq(verdict(50, topsRef, null, 'cm', 'baggy').band, 'tight1');
});

test('bottoms tolerance moves half as far as tops', () => {
  eq(FAMILY_BAND_SCALE.bottoms, 0.5);
  const topsGain = verdict(53 + 5, topsRef, null, 'cm', 'baggy').band;
  const bottomsSameGain = verdict(41 + 5, bottomsRef, null, 'cm', 'baggy').band;
  eq(topsGain, 'fit', '5 cm of extra room is fine on top for a baggy preference');
  truthy(bottomsSameGain !== 'fit', 'the same 5 cm at the waist is not');
});

test('an unknown preference falls back to regular', () => {
  eq(verdict(57, topsRef, null, 'cm', 'nonsense').band,
     verdict(57, topsRef, null, 'cm', 'regular').band);
});

test('preference is named in the detail only when it changes something', () => {
  truthy(!/preference/i.test(verdict(53, topsRef, null, 'cm', 'regular').detail), 'regular is silent');
  truthy(/preference/i.test(verdict(53, topsRef, null, 'cm', 'baggy').detail), 'baggy is stated');
});

test('every preference defines an ease and both tolerance extents', () => {
  for (const [key, p] of Object.entries(FIT_PREFERENCES)) {
    truthy(typeof p.ease === 'number', `${key} ease`);
    truthy(typeof p.tightExt === 'number', `${key} tightExt`);
    truthy(typeof p.looseExt === 'number', `${key} looseExt`);
    truthy(p.label, `${key} label`);
  }
});

/* ---------- Per-user model ---------- */

test('a fresh profile has learned nothing', () => {
  eq(learnedOffsets(profile()).length, 0);
  const s = trainingSignals(profile());
  eq(s.closet, 0);
  eq(s.outcomes, 0);
});

test('learnedOffsets reports the brand it has data for', () => {
  const p = profile({
    closet: [{ id: 'c1', brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', feel: -1 }],
  });
  const learned = learnedOffsets(p);
  eq(learned.length, 1);
  eq(learned[0].brandId, 'uniqlo');
  eq(learned[0].family, 'tops');
  eq(learned[0].count, 1);
});

test('a garment that runs small reads as small', () => {
  const p = profile({
    closet: [{ id: 'c1', brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', feel: -2 }],
  });
  eq(learnedOffsets(p)[0].direction, 'small');
});

test('learned offsets stay separated by brand', () => {
  const p = profile({
    closet: [
      { id: 'c1', brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', feel: -1 },
      { id: 'c2', brandId: 'zara', dept: 'men', category: 'tshirt', size: 'M', feel: 1 },
    ],
  });
  const learned = learnedOffsets(p);
  eq(learned.length, 2);
  truthy(new Set(learned.map(l => l.brandId)).size === 2, 'two distinct brands');
});

test('training signals count closet logs and reported outcomes separately', () => {
  const p = profile({
    closet: [{ id: 'c1', brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', feel: 0 }],
    history: [
      { id: 'h1', outcome: 0, band: 'fit' },
      { id: 'h2', outcome: null, band: 'fit' },
    ],
  });
  const s = trainingSignals(p);
  eq(s.closet, 1);
  eq(s.outcomes, 1, 'unanswered checks are not training data');
});

test('two identical bodies diverge once their logs differ', () => {
  const input = {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', cut: 'regular', era: 'current',
  };
  const runsSmall = profile({
    closet: [{ id: 'c1', brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', feel: -2 }],
  });
  const runsBig = profile({
    closet: [{ id: 'c1', brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', feel: 2 }],
  });
  const a = predict(runsSmall, topsRef, input);
  const b = predict(runsBig, topsRef, input);
  truthy(a.flat !== b.flat, 'same reference, same brand, different learned model');
});

/* ---------- Charts and ease ---------- */

test('chartFlat halves body circumference plus ease', () => {
  const uniqlo = brandById('uniqlo');
  const expected = (uniqlo.charts.men.tops.M + CATEGORIES.tshirt.ease + CUTS.regular.mod) / 2;
  near(chartFlat(uniqlo, 'men', 'tshirt', 'M', 'regular'), expected, 1e-9);
});

test('garment type changes the ease assumption', () => {
  const b = brandById('uniqlo');
  truthy(
    chartFlat(b, 'men', 'jacket', 'M', 'regular') > chartFlat(b, 'men', 'tshirt', 'M', 'regular'),
    'a jacket should be roomier than a tee at the same size',
  );
});

test('cut modifies ease', () => {
  const b = brandById('uniqlo');
  truthy(
    chartFlat(b, 'men', 'tshirt', 'M', 'relaxed') > chartFlat(b, 'men', 'tshirt', 'M', 'slim'),
    'relaxed > slim',
  );
});

test('unknown sizes return null rather than guessing', () => {
  eq(chartFlat(brandById('levis'), 'men', 'pants', 'M', 'regular'), null);
});

test('every brand chart covers both families and departments', () => {
  for (const brand of BRANDS) {
    for (const dept of ['men', 'women']) {
      truthy(brand.charts[dept]?.tops, `${brand.id} ${dept} tops`);
      truthy(brand.charts[dept]?.bottoms, `${brand.id} ${dept} bottoms`);
    }
  }
});

/* ---------- Verdicts ---------- */

test('a match on the reference reads as a fit', () => {
  eq(verdict(53, topsRef).band, 'fit');
});

test('tops bands step through tight to oversized', () => {
  eq(verdict(45, topsRef).band, 'tight2');
  eq(verdict(50, topsRef).band, 'tight1');
  eq(verdict(54, topsRef).band, 'fit');
  eq(verdict(56, topsRef).band, 'loose1');
  eq(verdict(60, topsRef).band, 'loose2');
});

test('bottoms use tighter thresholds than tops', () => {
  eq(verdict(43, bottomsRef).band, 'loose1');
  eq(verdict(43, { ...topsRef, main: 41 }).band, 'fit');
});

test('verdict detail respects the display unit', () => {
  truthy(verdict(53, topsRef, null, 'cm').detail.includes('cm'), 'cm');
  truthy(verdict(53, topsRef, null, 'in').detail.includes('in'), 'in');
});

test('secondary dimension is mentioned only when it differs materially', () => {
  truthy(!verdict(53, topsRef, 71, 'cm').detail.includes('longer'), '1 cm is not worth mentioning');
  truthy(verdict(53, topsRef, 80, 'cm').detail.includes('longer'), '10 cm is');
});

/* ---------- Prediction and personalisation ---------- */

test('a plain chart prediction is medium confidence', () => {
  const pred = predict(profile(), topsRef, {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', cut: 'regular', era: 'current',
  });
  eq(pred.confidence, 'medium');
});

test('a single closet log shifts the estimate without claiming certainty', () => {
  const p = profile({
    closet: [{ id: 'c1', brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', feel: -1 }],
  });
  const base = predict(profile(), topsRef, {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'L', cut: 'regular', era: 'current',
  });
  const tuned = predict(p, topsRef, {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'L', cut: 'regular', era: 'current',
  });
  truthy(tuned.flat !== base.flat, 'estimate should move');
  eq(tuned.confidence, 'medium', 'but one log is not yet a pattern');
});

test('a "runs small" log implies a narrower garment than the reference', () => {
  const chartM = chartFlat(brandById('uniqlo'), 'men', 'tshirt', 'M', 'regular');
  const implied = topsRef.main + -1 * FEEL_CM;
  const p = profile({
    closet: [{ id: 'c1', brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', feel: -1 }],
  });
  const pred = predict(p, topsRef, {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', cut: 'regular', era: 'current',
  });
  near(pred.flat, chartM + (implied - chartM), 1e-9);
});

test('closet logs do not leak across families', () => {
  const p = profile({
    closet: [{ id: 'c1', brandId: 'levis', dept: 'men', category: 'pants', size: 'W32', feel: -1 }],
  });
  const tops = predict(p, topsRef, {
    brandId: 'levis', dept: 'men', category: 'tshirt', size: 'M', cut: 'regular', era: 'current',
  });
  eq(tops.confidence, 'medium', 'a pants log must not tune shirts');
});

test('closet logs do not leak across brands', () => {
  const p = profile({
    closet: [{ id: 'c1', brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', feel: -1 }],
  });
  const other = predict(p, topsRef, {
    brandId: 'zara', dept: 'men', category: 'tshirt', size: 'M', cut: 'regular', era: 'current',
  });
  eq(other.confidence, 'medium');
});

test('vintage era lowers confidence and shrinks the estimate', () => {
  const now = predict(profile(), topsRef, {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', cut: 'regular', era: 'current',
  });
  const old = predict(profile(), topsRef, {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', cut: 'regular', era: '1990s',
  });
  eq(old.confidence, 'low');
  near(old.flat, now.flat + ERAS['1990s'].shift, 1e-9);
});

/* ---------- Reference confidence ---------- */

test('a derived reference downgrades confidence one level', () => {
  eq(applyReferenceConfidence({ confidence: 'high', reasons: [] }, derivedRef).confidence, 'medium');
  eq(applyReferenceConfidence({ confidence: 'medium', reasons: [] }, derivedRef).confidence, 'low');
  eq(applyReferenceConfidence({ confidence: 'low', reasons: [] }, derivedRef).confidence, 'low');
});

test('a real reference leaves confidence untouched', () => {
  const pred = { confidence: 'high', reasons: [] };
  eq(applyReferenceConfidence(pred, topsRef), pred);
});

test('downgraded confidence names the reference as the limit', () => {
  const out = applyReferenceConfidence({ confidence: 'high', reasons: [] }, derivedRef);
  truthy(/preliminary body scan/i.test(out.confidenceLabel), 'label names the cause');
  truthy(out.reasons.some(r => /measure a garment/i.test(r)), 'tells the user how to fix it');
});

test('predict applies the derived-reference downgrade end to end', () => {
  const pred = predict(profile(), derivedRef, {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', cut: 'regular', era: 'current',
  });
  eq(pred.confidence, 'low', 'medium chart estimate against a scan reference');
});

/* ---------- Catalog ---------- */

test('search finds the measured Gildan entry by brand', () => {
  truthy(catalog.search('gildan').some(e => e.id === 'gildan-g500'), 'found');
});

test('measured entries outrank estimates', () => {
  const first = catalog.search('gildan')[0];
  eq(first.kind, 'measured');
});

test('search matches on garment type', () => {
  truthy(catalog.search('pants').every(e => CATEGORIES[e.category].label.toLowerCase().includes('pants')
    || e.name.toLowerCase().includes('pants')), 'all results are pants');
});

test('department filter is respected', () => {
  truthy(catalog.search('', { dept: 'women' }).every(e => e.dept === 'women'), 'women only');
});

test('a measured entry predicts from real dimensions at high confidence', () => {
  const entry = catalog.entryById('gildan-g500');
  const pred = catalog.catalogPredict(profile(), topsRef, entry, 'M');
  eq(pred.confidence, 'high');
  near(pred.flat, entry.sizes.M.main, 1e-9);
  truthy(/published garment measurements/i.test(pred.confidenceLabel), 'names its source');
});

test('Gildan sizes match the published spec in inches', () => {
  const s = catalog.entryById('gildan-g500').sizes;
  near(s.S.main / 2.54, 18, 0.05);
  near(s.M.main / 2.54, 20, 0.05);
  near(s.XL.main / 2.54, 24, 0.05);
  near(s.M.secondary / 2.54, 29, 0.05);
});

test('a chart-derived entry stays an estimate', () => {
  const entry = catalog.allEntries().find(e => e.id.startsWith('chart-uniqlo-men-tshirt'));
  eq(catalog.catalogPredict(profile(), topsRef, entry, 'M').confidence, 'medium');
});

test('catalog entries respect a derived reference too', () => {
  const entry = catalog.entryById('gildan-g500');
  eq(catalog.catalogPredict(profile(), derivedRef, entry, 'M').confidence, 'medium');
});

test('unknown sizes yield null instead of a bogus verdict', () => {
  eq(catalog.catalogPredict(profile(), topsRef, catalog.entryById('gildan-g500'), 'nope'), null);
});

/* ---------- Care-label parsing ---------- */

test('a clean label yields brand, size and fibres', () => {
  const p = parseTag('UNIQLO  MEN  SIZE M  100% COTTON  MADE IN VIETNAM');
  eq(p.brand.brandId, 'uniqlo');
  eq(p.size.size, 'M');
  eq(p.dept, 'men');
  eq(p.fibres[0].pct, 100);
  eq(p.fibres[0].fibre, 'COTTON');
});

test('brand aliases with punctuation resolve', () => {
  eq(findBrand("LEVI'S").brandId, 'levis');
  eq(findBrand('LEVI STRAUSS & CO').brandId, 'levis');
  eq(findBrand('H&M').brandId, 'hm');
});

test('common OCR character swaps still match the brand', () => {
  eq(findBrand('UNIQL0').brandId, 'uniqlo', 'zero for O');
  eq(findBrand('N1KE').brandId, 'nike', 'one for I');
  eq(findBrand('GILDAN').brandId, 'gildan');
});

test('an unknown brand returns null rather than a wrong guess', () => {
  eq(findBrand('SOME OTHER LABEL'), null);
});

test('size tokens do not shadow each other', () => {
  eq(findSize('SIZE XXL').size, 'XXL');
  eq(findSize('SIZE XL').size, 'XL');
  eq(findSize('SIZE L').size, 'L');
  eq(findSize('2XL').size, 'XXL', '2XL is normalised');
  eq(findSize('3XL').size, '3XL');
});

test('a stray letter inside a word is not read as a size', () => {
  eq(findSize('100% COTTON'), null, 'the M in nothing, the L in nothing');
  eq(findSize('MADE IN PORTUGAL'), null);
});

test('a possessive does not masquerade as a size', () => {
  eq(parseTag("WOMEN'S SIZE M 100% COTTON").size.size, 'M', "the S in WOMEN'S");
  eq(parseTag("LEVI'S MEN'S L").size.size, 'L');
});

test('letters from the brand name are not read as sizes', () => {
  const p = parseTag("H&M WOMEN'S SIZE M 95% COTTON 5% ELASTANE");
  eq(p.brand.brandId, 'hm');
  eq(p.size.size, 'M', 'the M in H&M must not win over the real size');
  eq(p.dept, 'women');
});

test('an explicit SIZE marker beats loose text', () => {
  eq(findSize('LARGE PRINT SIZE M').size, 'M');
  eq(findSize('TAILLE L').size, 'L');
});

test('spelled-out sizes are understood', () => {
  eq(findSize('SIZE: MEDIUM').size, 'M');
  eq(findSize('LARGE').size, 'L');
});

test('waist sizes are recognised and marked as bottoms', () => {
  const s = findSize('W32 L34');
  eq(s.size, 'W32');
  eq(s.kind, 'waist');
});

test('department is read from the label when present', () => {
  eq(findDept('WOMENS'), 'women');
  eq(findDept('HOMME'), 'men');
  eq(findDept('100% COTTON'), null);
});

test('multiple fibres are all captured', () => {
  const f = findFibres('60% COTTON 35% POLYESTER 5% ELASTANE');
  eq(f.length, 3);
  eq(f[2].fibre, 'ELASTANE');
  eq(f[2].pct, 5);
});

test('impossible percentages are ignored', () => {
  eq(findFibres('500% COTTON').length, 0);
});

test('qualifiers before the fibre are stepped over', () => {
  eq(findFibres('100% PRESHRUNK COTTON')[0].fibre, 'COTTON');
  eq(findFibres('60% COMBED RINGSPUN COTTON')[0].fibre, 'COTTON');
  eq(findFibres('100% ORGANIC COTTON')[0].fibre, 'COTTON');
});

test('OCR letters standing in for digits still yield a percentage', () => {
  const f = findFibres('6O% COTTON 4O% POLYESTER');
  eq(f.length, 2);
  eq(f[0].pct, 60);
  eq(f[1].pct, 40);
});

test('an unfamiliar fibre name is still reported', () => {
  eq(findFibres('100% RAMIE')[0].fibre, 'RAMIE');
});

test('OCR damage inside the fibre name is undone', () => {
  eq(findFibres('6O% C0TT0N 4O% P0LYE5TER')[0].fibre, 'COTTON');
  eq(findFibres('6O% C0TT0N 4O% P0LYE5TER')[1].fibre, 'POLYESTER');
});

test('a following percentage is not mistaken for this fibre', () => {
  const f = findFibres('60% COTTON 40% POLYESTER');
  eq(f[0].fibre, 'COTTON');
  eq(f[1].fibre, 'POLYESTER');
  eq(f.length, 2);
});

test('stretch survives a qualifier and a noisy percentage', () => {
  eq(stretchOf(findFibres('95% ORGANIC COTTON 5% ELASTANE')).stretchy, true);
});

test('stretch fibre is detected above the threshold', () => {
  eq(stretchOf(findFibres('95% COTTON 5% ELASTANE')).stretchy, true);
  eq(stretchOf(findFibres('98% COTTON 2% ELASTANE')).stretchy, false, '2% is not meaningful give');
  eq(stretchOf(findFibres('100% COTTON')).stretchy, false);
});

test('spandex and lycra count as stretch', () => {
  eq(stretchOf(findFibres('90% NYLON 10% SPANDEX')).stretchy, true);
  eq(stretchOf(findFibres('92% POLYESTER 8% LYCRA')).stretchy, true);
});

test('a noisy real-world read still resolves', () => {
  const p = parseTag('UN1QL0\nMEN\n  SIZE  L \n60%  COTTON  40%  P0LYESTER');
  eq(p.brand.brandId, 'uniqlo');
  eq(p.size.size, 'L');
  eq(p.fibres.length, 2);
});

test('a tag with nothing recognisable fails cleanly', () => {
  const p = parseTag('~~~ ??? ~~~');
  eq(p.brand, null);
  eq(p.size, null);
  eq(p.fibres.length, 0);
  eq(p.stretch.stretchy, false);
});

test('parsing never throws on empty or missing input', () => {
  eq(parseTag('').brand, null);
  eq(parseTag(null).size, null);
  eq(parseTag(undefined).fibres.length, 0);
});

test('describe summarises what was and was not found', () => {
  truthy(/not recognised/.test(describe(parseTag('100% COTTON'))), 'names the gap');
  truthy(/Uniqlo/.test(describe(parseTag('UNIQLO M'))), 'names the brand');
});

/* ---------- Model confidence and robustness ---------- */

function log(brandId, size, feel, date, category = 'tshirt', dept = 'men') {
  return { id: uid(), brandId, dept, category, size, feel, date };
}
let uidN = 0;
function uid() { return 'c' + (++uidN); }

test('one log is not enough for high confidence', () => {
  const p = profile({ closet: [log('uniqlo', 'M', -1)] });
  const pred = predict(p, topsRef, {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'L', cut: 'regular', era: 'current',
  });
  eq(pred.confidence, 'medium', 'a single data point is not a pattern');
});

test('three logs earn high confidence', () => {
  const p = profile({
    closet: [log('uniqlo', 'M', -1), log('uniqlo', 'L', -1), log('uniqlo', 'XL', -1)],
  });
  const pred = predict(p, topsRef, {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'L', cut: 'regular', era: 'current',
  });
  eq(pred.confidence, 'high');
});

test('an early correction says how much more is needed', () => {
  const p = profile({ closet: [log('uniqlo', 'M', -1)] });
  const pred = predict(p, topsRef, {
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'L', cut: 'regular', era: 'current',
  });
  truthy(pred.reasons.some(r => /2 more/.test(r)), 'tells the user what it needs');
});

test('a single wild log cannot drag the correction with it', () => {
  const sane = [log('uniqlo', 'M', 0), log('uniqlo', 'M', 0), log('uniqlo', 'M', 0)];
  const withOutlier = [...sane, log('uniqlo', 'M', -2)];
  const a = learnedOffsets(profile({ closet: sane }))[0];
  const b = learnedOffsets(profile({ closet: withOutlier }))[0];
  truthy(Math.abs(b.offset - a.offset) < FEEL_CM,
    'median resists the outlier where a mean would not');
});

test('disagreeing logs are flagged as inconsistent', () => {
  const p = profile({ closet: [log('uniqlo', 'M', -2), log('uniqlo', 'M', 2), log('uniqlo', 'M', 0)] });
  eq(learnedOffsets(p)[0].inconsistent, true);
});

test('consistent logs of the same size are not flagged', () => {
  const p = profile({ closet: [log('uniqlo', 'M', 0), log('uniqlo', 'M', 0), log('uniqlo', 'M', 0)] });
  eq(learnedOffsets(p)[0].inconsistent, false);
});

// Calling an M and an XL both "just right" really is contradictory — those
// garments are 8 cm apart. The flag is meant to catch exactly this.
test('calling several different sizes all just-right is inconsistent', () => {
  const p = profile({ closet: [log('uniqlo', 'M', 0), log('uniqlo', 'L', 0), log('uniqlo', 'XL', 0)] });
  eq(learnedOffsets(p)[0].inconsistent, true);
});

test('recent logs outweigh very old ones', () => {
  const old = new Date(Date.now() - 1400 * 86400000).toISOString().slice(0, 10);
  const now = new Date().toISOString().slice(0, 10);
  const recentOnly = learnedOffsets(profile({
    closet: [log('uniqlo', 'M', 2, now), log('uniqlo', 'M', 2, now)],
  }))[0].offset;
  const withStale = learnedOffsets(profile({
    closet: [
      log('uniqlo', 'M', -2, old), log('uniqlo', 'M', -2, old),
      log('uniqlo', 'M', 2, now), log('uniqlo', 'M', 2, now), log('uniqlo', 'M', 2, now),
    ],
  }))[0].offset;
  eq(withStale, recentOnly, 'four-year-old logs do not overturn current ones');
});

test('settled flag matches the confidence threshold', () => {
  const two = learnedOffsets(profile({ closet: [log('uniqlo', 'M', 0), log('uniqlo', 'L', 0)] }))[0];
  const three = learnedOffsets(profile({
    closet: [log('uniqlo', 'M', 0), log('uniqlo', 'L', 0), log('uniqlo', 'XL', 0)],
  }))[0];
  eq(two.settled, false);
  eq(three.settled, true);
  eq(CONFIDENT_SAMPLE, 3);
});

/* ---------- Fit gauge ---------- */

test('the reference sits at the centre of the gauge', () => {
  near(gaugeGeometry(topsRef, 0).marker, 0.5, 1e-9);
});

test('a tighter garment sits left, a looser one right', () => {
  truthy(gaugeGeometry(topsRef, -3).marker < 0.5, 'tight is left');
  truthy(gaugeGeometry(topsRef, 3).marker > 0.5, 'loose is right');
});

test('gauge stops are ordered and inside the track', () => {
  const s = gaugeGeometry(topsRef, 0).stops;
  truthy(s.tight2 < s.tight1 && s.tight1 < s.fit && s.fit < s.loose1, 'ordered');
  for (const v of Object.values(s)) truthy(v >= 0 && v <= 1, 'within track');
});

test('extreme values clamp onto the gauge and are marked', () => {
  const g = gaugeGeometry(topsRef, 999);
  eq(g.marker, 1);
  eq(g.clamped, true);
});

test('preference widens the good band on the gauge', () => {
  const regular = gaugeGeometry(topsRef, 0, 'regular').stops;
  const baggy = gaugeGeometry(topsRef, 0, 'baggy').stops;
  truthy((baggy.fit - baggy.tight1) > (regular.fit - regular.tight1),
    'baggy tolerates a wider range');
});

/* ---------- Price tags ---------- */

test('prices are read in several currencies', () => {
  eq(findPrices('£29.99')[0].amount, 29.99);
  eq(findPrices('£29.99')[0].currency, 'GBP');
  eq(findPrices('$45')[0].currency, 'USD');
  eq(findPrices('€39,90')[0].amount, 39.9, 'comma decimal');
  eq(findPrices('USD 30')[0].amount, 30);
  eq(findPrices('199 SEK')[0].currency, 'SEK');
});

test('a price is never mistaken for a size', () => {
  eq(findSize('CHINO $32.00'), null, 'the only number is a price');
  eq(findSize('TEE £34.00'), null);
  eq(findSize('JEANS 45,00 EUR'), null);
});

test('a real size survives alongside a price', () => {
  const s = findSize('SLIM CHINO W32 L34 $59.99');
  eq(s.size, 'W32');
  eq(s.kind, 'waist');
});

test('a letter size is unaffected by a price', () => {
  eq(findSize('TEE SIZE M £19.99').size, 'M');
});

test('bare numeric waist sizes are understood', () => {
  eq(findSize('CHINO 32 SLIM').size, 'W32');
  eq(findSize('WAIST 36').size, 'W36');
});

test('a number outside waist range is reported but not claimed', () => {
  const s = findSize('STYLE 12');
  eq(s.kind, 'numeric');
  eq(s.unmapped, true);
});

test('cut wording maps onto the engine cuts', () => {
  eq(findCut('SLIM FIT CHINO'), 'slim');
  eq(findCut('SKINNY JEANS'), 'slim');
  eq(findCut('RELAXED FIT TEE'), 'relaxed');
  eq(findCut('OVERSIZED HOODIE'), 'relaxed');
  eq(findCut('CLASSIC OXFORD'), 'regular');
  eq(findCut('COTTON TEE'), null);
});

test('garment type is read from the product name', () => {
  eq(findGarmentType('SLIM FIT CHINO'), 'pants');
  eq(findGarmentType('SKINNY JEANS'), 'pants');
  eq(findGarmentType('OVERSIZED HOODIE'), 'sweater');
  eq(findGarmentType('BOMBER JACKET'), 'jacket');
  eq(findGarmentType('CARGO SHORTS'), 'shorts');
});

test('type keywords do not shadow each other', () => {
  eq(findGarmentType('SWEATSHIRT'), 'sweater', 'not read as a shirt');
  eq(findGarmentType('T SHIRT'), 'tshirt', 'not read as a shirt');
  eq(findGarmentType('CARGO SHORTS'), 'shorts', 'not read as short-sleeve');
  eq(findGarmentType('OXFORD SHIRT'), 'shirt');
});

test('a full hangtag parses end to end', () => {
  const p = parseTag("LEVI'S\n511 SLIM FIT JEANS\nW32 L34\n$69.50\n99% COTTON 1% ELASTANE");
  eq(p.brand.brandId, 'levis');
  eq(p.size.size, 'W32');
  eq(p.cut, 'slim');
  eq(p.garmentType, 'pants');
  eq(p.price.amount, 69.5);
  eq(p.price.currency, 'USD');
});

test('a womens hangtag with a letter size parses', () => {
  const p = parseTag("H&M\nWOMEN'S OVERSIZED SWEATSHIRT\nSIZE M\n£24.99\n80% COTTON 20% POLYESTER");
  eq(p.brand.brandId, 'hm');
  eq(p.size.size, 'M');
  eq(p.dept, 'women');
  eq(p.cut, 'relaxed');
  eq(p.garmentType, 'sweater');
  eq(p.price.amount, 24.99);
});

test('a care label still parses with no hangtag fields', () => {
  const p = parseTag('UNIQLO MEN SIZE M 100% COTTON MADE IN CHINA');
  eq(p.price, null);
  eq(p.cut, null);
  eq(p.size.size, 'M');
});

/* ---------- Calibration statistics ---------- */

// predicted, actual -> a calibration sample. error = predicted - actual.
function cal(predicted, actual, extra = {}) {
  return {
    predictedFlat: predicted, actualFlat: actual,
    brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M',
    source: 'chart', date: '2026-08-06', ...extra,
  };
}

test('error is signed: positive means we over-predicted the width', () => {
  eq(errorOf(cal(54, 50)), 4);
  eq(errorOf(cal(50, 54)), -4);
});

test('summarize computes bias and typical error by hand-checkable values', () => {
  // errors: +2, -2, +4, -4  -> bias 0, mae 3, worst 4
  const s = summarize([cal(52, 50), cal(48, 50), cal(54, 50), cal(46, 50)]);
  eq(s.n, 4);
  near(s.bias, 0, 1e-9, 'symmetric errors cancel');
  near(s.mae, 3, 1e-9);
  eq(s.worst, 4);
});

test('bias catches a systematic lean that mae alone hides', () => {
  // every prediction 3 too wide
  const s = summarize([cal(53, 50), cal(58, 55), cal(63, 60)]);
  near(s.bias, 3, 1e-9, 'a fixable constant offset');
  near(s.mae, 3, 1e-9);
});

test('quantile matches known positions', () => {
  eq(quantile([1, 2, 3, 4, 5], 0.5), 3);
  eq(quantile([1, 2, 3, 4], 0.5), 2.5, 'interpolates');
  eq(quantile([1, 2, 3, 4, 5], 0), 1);
  eq(quantile([1, 2, 3, 4, 5], 1), 5);
});

test('coverage reports the fraction inside a band', () => {
  // errors 1, 1, 5, 5 against a band of 2 -> half inside
  const s = [cal(51, 50), cal(51, 50), cal(55, 50), cal(55, 50)];
  near(coverage(s, 2), 0.5, 1e-9);
  near(coverage(s, 10), 1, 1e-9);
  near(coverage(s, 0.5), 0, 1e-9);
});

test('bandForCoverage returns a width that actually achieves the target', () => {
  // absolute errors 1,1,1,1,5
  const s = [cal(51, 50), cal(51, 50), cal(51, 50), cal(51, 50), cal(55, 50)];
  const band = bandForCoverage(s, 0.8);
  // The property that matters is the coverage it delivers, not the exact
  // interpolated number.
  truthy(coverage(s, band) >= 0.8, 'the recommended band hits the target');
  truthy(band < 5, 'without simply covering the worst case');
});

test('a wider target demands a wider band', () => {
  const s = [cal(51, 50), cal(51, 50), cal(51, 50), cal(51, 50), cal(55, 50)];
  truthy(bandForCoverage(s, 1) >= bandForCoverage(s, 0.8), 'monotonic in target');
});

test('a small sample refuses to draw a conclusion', () => {
  const v = verdictOnBand([cal(51, 50), cal(52, 50)], 2);
  eq(v.state, 'insufficient');
  truthy(/too few/i.test(v.text));
});

test('an honest band is reported as defensible', () => {
  const s = Array.from({ length: 12 }, () => cal(51, 50)); // every error 1 cm
  const v = verdictOnBand(s, 2);
  eq(v.state, 'ok');
});

test('a band narrower than real error is called out', () => {
  const s = Array.from({ length: 12 }, () => cal(56, 50)); // every error 6 cm
  const v = verdictOnBand(s, 2);
  eq(v.state, 'too-tight');
  truthy(/more precision than the model has/i.test(v.text));
  near(v.needed, 6, 1e-9, 'and says what would be needed');
});

test('groupBy separates a bad brand from a good average', () => {
  const rows = groupBy([
    cal(51, 50, { brandId: 'uniqlo' }),
    cal(51, 50, { brandId: 'uniqlo' }),
    cal(58, 50, { brandId: 'zara' }),
  ], x => x.brandId);
  const uniqlo = rows.find(r => r.key === 'uniqlo');
  const zara = rows.find(r => r.key === 'zara');
  near(uniqlo.mae, 1, 1e-9);
  near(zara.mae, 8, 1e-9);
});

test('empty input never throws', () => {
  eq(summarize([]).n, 0);
  eq(coverage([], 2), null);
  eq(bandForCoverage([], 0.8), null);
  eq(verdictOnBand([], 2).state, 'empty');
});

test('csv export has a header and one row per sample', () => {
  const csv = toCsv([cal(52, 50), cal(48, 50)]);
  const lines = csv.split('\n');
  eq(lines.length, 3);
  truthy(lines[0].startsWith('date,brand'), 'header');
  truthy(lines[1].endsWith('2.00'), 'signed error in the row');
});

/* ---------- User-measured catalog entries ---------- */

// These touch real storage, so each test starts from a clean slate.
function resetUserGarments() {
  store.state.userGarments.length = 0;
}

test('a measured garment becomes a searchable catalog entry', () => {
  resetUserGarments();
  const g = store.addUserGarment({
    brandId: 'uniqlo', name: 'Supima Crew Tee', dept: 'men',
    category: 'tshirt', size: 'M', main: 52, secondary: 70,
  });
  eq(g.kind, 'measured');
  eq(g.source, 'user');
  truthy(catalog.search('supima').some(e => e.id === g.id), 'findable by product name');
  resetUserGarments();
});

test('a second size extends the same product rather than duplicating it', () => {
  resetUserGarments();
  const a = store.addUserGarment({
    brandId: 'uniqlo', name: 'Supima Crew Tee', dept: 'men',
    category: 'tshirt', size: 'M', main: 52,
  });
  const b = store.addUserGarment({
    brandId: 'uniqlo', name: 'supima crew tee', dept: 'men',
    category: 'tshirt', size: 'L', main: 56,
  });
  eq(a.id, b.id, 'matched case-insensitively');
  eq(store.state.userGarments.length, 1);
  eq(Object.keys(b.sizes).length, 2);
  resetUserGarments();
});

test('a user-measured garment predicts from its real dimensions', () => {
  resetUserGarments();
  const g = store.addUserGarment({
    brandId: 'uniqlo', name: 'Supima Crew Tee', dept: 'men',
    category: 'tshirt', size: 'M', main: 52,
  });
  const pred = catalog.catalogPredict(profile(), topsRef, catalog.entryById(g.id), 'M');
  eq(pred.confidence, 'high');
  near(pred.flat, 52, 1e-9, 'uses the measurement, not the chart');
  resetUserGarments();
});

test('a user measurement is not described as published', () => {
  resetUserGarments();
  const g = store.addUserGarment({
    brandId: 'zara', name: 'Boxy Tee', dept: 'men',
    category: 'tshirt', size: 'M', main: 55,
  });
  const pred = catalog.catalogPredict(profile(), topsRef, catalog.entryById(g.id), 'M');
  truthy(/you measured/i.test(pred.confidenceLabel), 'credits the user');
  truthy(!/published/i.test(pred.confidenceLabel), 'and does not claim a brand spec');
  resetUserGarments();
});

test('user garments survive an empty search alongside measured ones', () => {
  resetUserGarments();
  store.addUserGarment({
    brandId: 'nike', name: 'Dri-FIT Tee', dept: 'men',
    category: 'tshirt', size: 'L', main: 54,
  });
  truthy(catalog.search('').some(e => e.source === 'user'), 'not filtered out as noise');
  resetUserGarments();
});

test('removing a single size leaves the rest, removing the last drops the entry', () => {
  resetUserGarments();
  const g = store.addUserGarment({
    brandId: 'hm', name: 'Relaxed Tee', dept: 'men', category: 'tshirt', size: 'M', main: 53,
  });
  store.addUserGarment({
    brandId: 'hm', name: 'Relaxed Tee', dept: 'men', category: 'tshirt', size: 'L', main: 57,
  });
  store.removeUserGarmentSize(g.id, 'M');
  eq(Object.keys(store.state.userGarments[0].sizes).length, 1);
  store.removeUserGarmentSize(g.id, 'L');
  eq(store.state.userGarments.length, 0, 'empty entry cleans itself up');
  resetUserGarments();
});

/* ---------- Two-device sync merge ---------- */

function device(profileOverrides = {}, stateOverrides = {}) {
  return {
    profiles: [{
      id: 'p1', name: 'Kai', dept: 'men', preference: 'regular',
      refs: [], closet: [], history: [],
      activeRefs: { tops: null, bottoms: null },
      updatedAt: 1000, ...profileOverrides,
    }],
    activeProfileId: 'p1',
    settings: { units: 'cm' },
    barcodes: {},
    userGarments: [],
    updatedAt: 1000,
    ...stateOverrides,
  };
}

test('logs made on two devices both survive the merge', () => {
  const phone = device({ closet: [{ id: 'a', feel: -1, updatedAt: 2000 }] });
  const pc = device({ closet: [{ id: 'b', feel: 1, updatedAt: 2000 }] });
  const merged = mergeState(phone, pc);
  const ids = merged.profiles[0].closet.map(c => c.id).sort();
  eq(ids.join(','), 'a,b', 'neither device overwrites the other');
});

test('merging is symmetric, so either device gets the same answer', () => {
  const phone = device({ closet: [{ id: 'a', updatedAt: 2000 }] });
  const pc = device({ closet: [{ id: 'b', updatedAt: 3000 }] });
  const a = mergeState(phone, pc).profiles[0].closet.map(c => c.id).sort().join(',');
  const b = mergeState(pc, phone).profiles[0].closet.map(c => c.id).sort().join(',');
  eq(a, b);
});

test('syncing twice changes nothing the second time', () => {
  const phone = device({ closet: [{ id: 'a', updatedAt: 2000 }] });
  const pc = device({ closet: [{ id: 'b', updatedAt: 2000 }] });
  const once = mergeState(phone, pc);
  const twice = mergeState(once, pc);
  eq(twice.profiles[0].closet.length, once.profiles[0].closet.length, 'converged');
});

test('the newer edit of the same record wins', () => {
  const phone = device({ refs: [{ id: 'r1', main: 53, updatedAt: 5000 }] });
  const pc = device({ refs: [{ id: 'r1', main: 60, updatedAt: 1000 }] });
  eq(mergeState(phone, pc).profiles[0].refs[0].main, 53, 'later measurement kept');
  eq(mergeState(pc, phone).profiles[0].refs[0].main, 53, 'regardless of merge order');
});

test('a deleted record does not come back from the other device', () => {
  const phone = device({ refs: [], deleted: { r1: 9000 } });
  const pc = device({ refs: [{ id: 'r1', main: 53, updatedAt: 1000 }] });
  eq(mergeState(phone, pc).profiles[0].refs.length, 0, 'tombstone respected');
  eq(mergeState(pc, phone).profiles[0].refs.length, 0, 'in both directions');
});

test('a preference changed on one device wins by recency', () => {
  const phone = device({ preference: 'baggy', updatedAt: 5000 });
  const pc = device({ preference: 'tight', updatedAt: 1000 });
  eq(mergeState(phone, pc).profiles[0].preference, 'baggy');
});

test('a profile that exists on only one device is carried over', () => {
  const phone = device();
  const pc = device();
  pc.profiles.push({
    id: 'p2', name: 'Sam', dept: 'women', refs: [], closet: [], history: [], updatedAt: 4000,
  });
  eq(mergeState(phone, pc).profiles.length, 2);
});

test('measured garments merge per size, not per entry', () => {
  const phone = [{ id: 'g1', name: 'Tee', sizes: { M: { main: 52 } }, updatedAt: 2000 }];
  const pc = [{ id: 'g1', name: 'Tee', sizes: { L: { main: 56 } }, updatedAt: 3000 }];
  const merged = mergeUserGarments(phone, pc);
  eq(merged.length, 1, 'one product');
  eq(Object.keys(merged[0].sizes).sort().join(','), 'L,M', 'both sizes kept');
});

test('barcode links from either device are kept', () => {
  const phone = device({}, { barcodes: { '111': 'gildan-g500' } });
  const pc = device({}, { barcodes: { '222': 'uniqlo-airism-crew' } });
  const merged = mergeState(phone, pc);
  eq(Object.keys(merged.barcodes).sort().join(','), '111,222');
});

test('calibration samples union rather than replace', () => {
  const phone = [{ id: 'c1', date: '2026-08-06', predictedFlat: 50, actualFlat: 53 }];
  const pc = [{ id: 'c2', date: '2026-08-05', predictedFlat: 54, actualFlat: 52 }];
  const merged = mergeCalibration(phone, pc);
  eq(merged.length, 2, 'measurements from a shop join those from a desk');
  eq(merged[0].id, 'c1', 'newest first');
});

test('the same calibration sample is not duplicated by repeated syncs', () => {
  const s = [{ id: 'c1', date: '2026-08-06' }];
  eq(mergeCalibration(s, s).length, 1);
});

test('merging against nothing is a no-op', () => {
  const phone = device({ closet: [{ id: 'a', updatedAt: 1 }] });
  eq(mergeState(phone, null).profiles[0].closet.length, 1, 'first sync of a fresh key');
  eq(mergeState(null, phone).profiles[0].closet.length, 1);
});

test('history stays capped and newest-first after merging', () => {
  const mk = (id, date) => ({ id, date, band: 'fit' });
  const phone = device({ history: Array.from({ length: 60 }, (_, i) => mk('a' + i, '2026-01-01')) });
  const pc = device({ history: Array.from({ length: 60 }, (_, i) => mk('b' + i, '2026-06-01')) });
  const merged = mergeState(phone, pc).profiles[0].history;
  truthy(merged.length <= 100, 'capped');
  eq(merged[0].date, '2026-06-01', 'newest first');
});

/* ---------- Backup round-trip ---------- */

test('a backup carries photos, logs, measured garments and calibration', () => {
  localStorage.clear();
  const p = store.addProfile('RoundTrip', 'men', 'regular');
  store.addRef(p, {
    name: 'Grey tee', brandId: 'uniqlo', category: 'tshirt',
    main: 53, secondary: 70, photo: 'data:image/jpeg;base64,AAAA', source: 'manual',
  });
  store.addClosetLog(p, { brandId: 'uniqlo', dept: 'men', category: 'tshirt', size: 'M', feel: -1 });
  store.addUserGarment({
    brandId: 'uniqlo', name: 'Supima Tee', dept: 'men',
    category: 'tshirt', size: 'M', main: 52,
  });
  localStorage.setItem('fitcheck-calibration-v1',
    JSON.stringify([{ id: 'c1', predictedFlat: 50, actualFlat: 53 }]));

  const backup = store.exportJson();
  const dump = JSON.parse(backup);
  truthy(dump.state.profiles[0].refs[0].photo, 'photo travels with the backup');
  eq(dump.calibration.length, 1, 'calibration travels too');

  // Wipe as if this were a different device, then restore.
  localStorage.clear();
  store.state.profiles.length = 0;
  store.state.userGarments.length = 0;
  const res = store.importJson(backup);
  eq(res.ok, true);
  eq(res.profiles, 1);
  eq(res.calibration, 1);
  truthy(store.state.profiles[0].refs[0].photo, 'photo restored');
  eq(store.state.userGarments.length, 1, 'measured garments restored');
  eq(JSON.parse(localStorage.getItem('fitcheck-calibration-v1')).length, 1);
  localStorage.clear();
  store.state.profiles.length = 0;
  store.state.userGarments.length = 0;
});

test('an older backup without calibration does not wipe existing measurements', () => {
  localStorage.clear();
  localStorage.setItem('fitcheck-calibration-v1', JSON.stringify([{ id: 'keep' }]));
  const v1 = JSON.stringify({
    app: 'fit-check', version: 1,
    state: { profiles: [{ id: 'p', name: 'Old', dept: 'men', refs: [], closet: [], history: [] }] },
  });
  const res = store.importJson(v1);
  eq(res.calibration, 0, 'nothing to restore');
  eq(JSON.parse(localStorage.getItem('fitcheck-calibration-v1')).length, 1, 'local data survives');
  localStorage.clear();
  store.state.profiles.length = 0;
});

/* ---------- Catalog noise ---------- */

test('an empty search shows only genuinely measured garments', () => {
  const results = catalog.search('');
  truthy(results.length > 0, 'not empty');
  truthy(results.every(e => e.kind === 'measured' || e.source === 'user'),
    'no generic chart entries unprompted');
});

test('typing a brand brings its chart entries back', () => {
  const results = catalog.search('uniqlo');
  truthy(results.some(e => e.kind === 'chart'), 'estimates available on request');
});

/* ---------- Storage shape ---------- */

test('every category maps to a known family with an ease value', () => {
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    truthy(FAMILIES[cat.family], `${key} family`);
    truthy(typeof cat.ease === 'number', `${key} ease`);
  }
});

test('feel scale is symmetric around zero', () => {
  eq(FEEL_CM > 0, true);
});

/* ---------- Run ---------- */

export function run() {
  const passed = results.filter(r => r.pass).length;
  return { results, passed, failed: results.length - passed, total: results.length };
}

window.FIT_CHECK_RESULTS = run();
