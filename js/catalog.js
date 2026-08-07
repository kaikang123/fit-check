// Searchable garment catalog.
//
// Two kinds of entry:
//   'measured' — real flat garment dimensions from a brand's published
//                product-measurement table. Compared garment-to-garment, so
//                these carry high confidence.
//   'chart'    — generated from a brand's body size chart. Exactly the same
//                estimate the manual-entry path produces, just searchable.
//                Medium confidence, and labelled as an estimate in the UI.
//
// Barcodes are deliberately not pre-filled: no free product API returns
// garment dimensions, and inventing barcode-to-product mappings would put
// fabricated data in front of users. Instead, scanning an unknown code lets
// the user link it to a catalog entry, which is stored on their device.

import { BRANDS, CATEGORIES, DEPTS } from './data.js';
import { predict, brandById, applyReferenceConfidence } from './engine.js';
import { state } from './store.js';

const IN = 2.54;
const inches = (...xs) => xs.map(x => Math.round(x * IN * 10) / 10);

// Gildan publishes a full flat-garment spec: body width measured 1" below the
// armhole, body length from the high point of the shoulder.
const G500_SIZES = ['S', 'M', 'L', 'XL', 'XXL', '3XL'];
const G500_WIDTH = inches(18, 20, 22, 24, 26, 28);
const G500_LENGTH = inches(28, 29, 30, 31, 32, 33);

function zipSizes(names, main, secondary) {
  const out = {};
  names.forEach((n, i) => { out[n] = { main: main[i], secondary: secondary[i] }; });
  return out;
}

const SEEDED = [
  {
    id: 'gildan-g500',
    brandId: 'gildan',
    name: 'Heavy Cotton T-Shirt (G500)',
    dept: 'men', category: 'tshirt', kind: 'measured',
    sourceNote: 'Gildan published garment spec — body width measured 1 in below the armhole',
    sizes: zipSizes(G500_SIZES, G500_WIDTH, G500_LENGTH),
  },
  {
    id: 'uniqlo-airism-crew',
    brandId: 'uniqlo',
    name: 'AIRism Cotton Crew Neck T-Shirt',
    dept: 'men', category: 'tshirt', kind: 'chart',
    sourceNote: 'Anchored on Uniqlo’s published size M flat chest (58.5 cm); other sizes graded ±4 cm, so treat as an estimate',
    sizes: zipSizes(
      ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
      [50.5, 54.5, 58.5, 62.5, 66.5, 70.5],
      [64, 67, 70, 73, 76, 79],
    ),
  },
];

// One generated entry per brand + department + garment type, built from the
// bundled body charts.
function generated() {
  const out = [];
  for (const brand of BRANDS) {
    for (const dept of Object.keys(DEPTS)) {
      for (const [cat, meta] of Object.entries(CATEGORIES)) {
        const chart = brand.charts[dept]?.[meta.family];
        if (!chart) continue;
        out.push({
          id: `chart-${brand.id}-${dept}-${cat}`,
          brandId: brand.id,
          name: `${meta.label} (standard sizing)`,
          dept, category: cat, kind: 'chart',
          sourceNote: `Estimated from ${brand.name}’s published ${DEPTS[dept].toLowerCase()} size chart — not a measured garment`,
          sizeNames: Object.keys(chart),
        });
      }
    }
  }
  return out;
}

const GENERATED = generated();

export function allEntries() {
  return [...SEEDED, ...state.userGarments, ...GENERATED];
}

export function entryById(id) {
  return allEntries().find(e => e.id === id) || null;
}

export function sizesOf(entry) {
  return entry.sizes ? Object.keys(entry.sizes) : entry.sizeNames || [];
}

export function brandNameOf(entry) {
  return brandById(entry.brandId)?.name || 'Unknown brand';
}

// Free-text search over brand, product name, and garment type. Measured
// entries rank above estimates so real data surfaces first.
export function search(query, { dept, includeGeneric } = {}) {
  const q = query.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];

  // The generated per-brand entries exist so every brand stays checkable, but
  // there are dozens of them against a handful of genuinely measured garments.
  // Listing them unprompted buries the real data, so they wait until the user
  // has actually typed something.
  const showGeneric = includeGeneric ?? terms.length > 0;

  for (const entry of allEntries()) {
    if (dept && entry.dept !== dept) continue;
    if (!showGeneric && entry.kind === 'chart' && entry.source !== 'user') continue;
    const brand = brandNameOf(entry).toLowerCase();
    const cat = CATEGORIES[entry.category].label.toLowerCase();
    const hay = `${brand} ${entry.name.toLowerCase()} ${cat}`;
    if (terms.length && !terms.every(t => hay.includes(t))) continue;

    let score = 0;
    if (entry.kind === 'measured') score += 100;
    if (entry.source === 'user') score += 80;
    if (terms.some(t => brand.startsWith(t))) score += 20;
    if (terms.some(t => entry.name.toLowerCase().includes(t))) score += 10;
    scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, 40).map(s => s.entry);
}

// Predict flat main width for a catalog entry at a given size, mirroring the
// shape returned by engine.predict().
export function catalogPredict(profile, ref, entry, size, opts = {}) {
  if (entry.sizes) {
    const dims = entry.sizes[size];
    if (!dims) return null;
    const measured = entry.kind === 'measured';
    const reasons = [`${brandNameOf(entry)} ${entry.name}, size ${size}`, entry.sourceNote];
    if (measured) {
      reasons.push('Real garment dimensions — compared directly against your reference, no size-chart guessing');
    }
    // "Published" would misdescribe a garment the user measured themselves,
    // and "your own data" would misdescribe a brand spec. Name the real source.
    const measuredLabel = entry.source === 'user'
      ? 'High confidence — you measured this garment'
      : 'High confidence — published garment measurements';
    return applyReferenceConfidence({
      flat: dims.main,
      secondary: dims.secondary ?? null,
      confidence: measured ? 'high' : 'medium',
      confidenceLabel: measured ? measuredLabel : undefined,
      reasons,
    }, ref);
  }

  // Chart-backed entry: identical computation to the manual path. A cut read
  // off a hangtag ("SLIM FIT") is more specific than assuming regular.
  const pred = predict(profile, ref, {
    brandId: entry.brandId, dept: entry.dept, category: entry.category,
    size, cut: opts.cut || 'regular', era: 'current',
  });
  if (!pred) return null;
  return { ...pred, secondary: null, reasons: [entry.sourceNote, ...pred.reasons.slice(1)] };
}
