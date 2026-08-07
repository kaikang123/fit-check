// Calibration harness — a workbench, not a user feature.
//
// You measure a real garment with a tape, tell it what the garment is, and it
// records what Fit Check *would* have predicted. Twenty of those produce an
// error distribution, which is the number this product has never had.
//
// Kept on its own page and under its own storage key so it can never disturb
// the app's data.

import { BRANDS, CATEGORIES, DEPTS, FAMILIES } from './data.js';
import { chartFlat, brandById } from './engine.js';
import * as catalog from './catalog.js';
import { UNITS, toCm, fmt } from './units.js';
import { state as appState } from './store.js';
import {
  summarize, groupBy, coverage, bandForCoverage, verdictOnBand, errorOf, toCsv,
} from './calibmath.js';

const KEY = 'fitcheck-calibration-v1';

// The bands the app currently ships, in flat cm. These are what we're testing.
const SHIPPED_BAND = { tops: 2, bottoms: 1.25 };

let samples = load();
let unit = appState.settings?.units || 'cm';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch (e) {
    return [];
  }
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(samples));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// What the engine would predict for this garment, and where that came from.
// Deliberately excludes any personal offset: we're testing the base model
// against reality, not the model plus one user's corrections.
function predictionFor({ brandId, dept, category, size }) {
  const entries = catalog.allEntries().filter(e =>
    e.brandId === brandId && e.dept === dept && e.category === category);
  const measured = entries.find(e => e.kind === 'measured' && e.sizes?.[size]);
  if (measured) {
    return { flat: measured.sizes[size].main, source: 'measured' };
  }
  const brand = brandById(brandId);
  const flat = brand ? chartFlat(brand, dept, category, size, 'regular') : null;
  return flat == null ? null : { flat, source: 'chart' };
}

function sizesFor(brandId, dept, category) {
  const brand = brandById(brandId);
  const chart = brand?.charts[dept]?.[CATEGORIES[category].family];
  return chart ? Object.keys(chart) : [];
}

/* ---------- Entry ---------- */

export function render(root) {
  root.innerHTML = `
    <div class="card">
      <h2>Calibration</h2>
      <p class="muted">Measure a real garment flat with a tape, then record what it actually is.
        This compares it against what Fit Check would have predicted, so the verdict bands can be
        set from evidence instead of assumption.</p>
      <p class="hint">Measure the same dimension the app compares: chest pit-to-pit for tops,
        waist flat across for bottoms. Nothing here touches your app data.</p>
      <div class="grid2">
        <label class="field">Brand
          <select id="cb-brand">${BRANDS.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}</select>
        </label>
        <label class="field">Type
          <select id="cb-cat">${Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('')}</select>
        </label>
        <label class="field">Department
          <select id="cb-dept">${Object.entries(DEPTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        </label>
        <label class="field">Size<select id="cb-size"></select></label>
      </div>
      <label class="field">Measured flat (<span id="cb-unit">${UNITS[unit].short}</span>) — <span id="cb-dim">chest, pit to pit</span>
        <input id="cb-actual" type="number" step="${UNITS[unit].step}" inputmode="decimal">
      </label>
      <p id="cb-preview" class="hint"></p>
      <div class="row">
        <button id="cb-add" class="btn btn-primary">Record measurement</button>
        <button id="cb-seed" class="btn">Import my reference garments</button>
      </div>
      <p id="cb-msg" class="hint" hidden></p>
    </div>
    <div id="cb-analysis"></div>
    <div id="cb-list"></div>`;

  const brandSel = root.querySelector('#cb-brand');
  const catSel = root.querySelector('#cb-cat');
  const deptSel = root.querySelector('#cb-dept');
  const sizeSel = root.querySelector('#cb-size');
  const actual = root.querySelector('#cb-actual');
  const preview = root.querySelector('#cb-preview');

  // Rebuilding the size list must only happen when the list could have
  // changed. Doing it on a size change too would reset the user's choice back
  // to the first option — and silently record the wrong garment.
  const rebuildSizes = () => {
    const sizes = sizesFor(brandSel.value, deptSel.value, catSel.value);
    const wanted = sizeSel.value;
    sizeSel.innerHTML = sizes.map(s => `<option value="${s}">${s}</option>`).join('')
      || '<option value="">—</option>';
    if (sizes.includes(wanted)) sizeSel.value = wanted;
    const family = CATEGORIES[catSel.value].family;
    root.querySelector('#cb-dim').textContent =
      family === 'tops' ? 'chest, pit to pit' : 'waist, flat across';
  };

  const updatePreview = () => {
    const pred = predictionFor({
      brandId: brandSel.value, dept: deptSel.value,
      category: catSel.value, size: sizeSel.value,
    });
    preview.textContent = pred
      ? `Fit Check would predict ${fmt(pred.flat, unit)} for ${sizeSel.value} (${pred.source === 'measured' ? 'published garment spec' : 'size chart'}).`
      : 'No prediction available for that combination.';
  };

  const refresh = () => { rebuildSizes(); updatePreview(); };
  brandSel.onchange = catSel.onchange = deptSel.onchange = refresh;
  sizeSel.onchange = updatePreview;
  refresh();

  root.querySelector('#cb-add').onclick = () => {
    const raw = parseFloat(actual.value);
    if (!raw) return actual.focus();
    const input = {
      brandId: brandSel.value, dept: deptSel.value,
      category: catSel.value, size: sizeSel.value,
    };
    const pred = predictionFor(input);
    if (!pred) return;
    samples.unshift({
      ...input,
      id: Date.now().toString(36),
      date: new Date().toISOString().slice(0, 10),
      actualFlat: toCm(raw, unit),
      predictedFlat: pred.flat,
      source: pred.source,
    });
    save();
    actual.value = '';
    paint(root);
  };

  root.querySelector('#cb-seed').onclick = () => seedFromReferences(root);

  paint(root);
}

// Reference garments the user already measured are calibration data, provided
// they recorded which brand it was.
function seedFromReferences(root) {
  const msg = root.querySelector('#cb-msg');
  const added = [];
  for (const profile of appState.profiles || []) {
    for (const ref of profile.refs || []) {
      if (!ref.brandId || ref.derived) continue;
      if (samples.some(s => s.sourceRefId === ref.id)) continue;
      // The reference records a measurement but not which labelled size it
      // was, so try each size and keep the closest — the user can delete any
      // that are wrong.
      const sizes = sizesFor(ref.brandId, profile.dept, ref.category);
      let best = null;
      for (const size of sizes) {
        const pred = predictionFor({
          brandId: ref.brandId, dept: profile.dept, category: ref.category, size,
        });
        if (!pred) continue;
        const err = Math.abs(pred.flat - ref.main);
        if (!best || err < best.err) best = { size, pred, err };
      }
      if (!best) continue;
      added.push({
        id: 'ref-' + ref.id,
        sourceRefId: ref.id,
        date: new Date().toISOString().slice(0, 10),
        brandId: ref.brandId, dept: profile.dept,
        category: ref.category, size: best.size,
        actualFlat: ref.main,
        predictedFlat: best.pred.flat,
        source: best.pred.source,
      });
    }
  }
  if (!added.length) {
    msg.textContent = 'Nothing to import — reference garments need a brand recorded, and scan-derived ones are skipped.';
    msg.hidden = false;
    return;
  }
  samples = [...added, ...samples];
  save();
  msg.textContent = `Imported ${added.length}. Sizes were guessed as the closest match — delete any that are wrong.`;
  msg.hidden = false;
  paint(root);
}

/* ---------- Analysis ---------- */

function paint(root) {
  const analysis = root.querySelector('#cb-analysis');
  const list = root.querySelector('#cb-list');
  const s = summarize(samples);

  if (!s.n) {
    analysis.innerHTML = `<div class="card"><p class="muted">No measurements yet. Fifteen to twenty covering the brands you actually wear is enough to tell whether the bands are honest.</p></div>`;
    list.innerHTML = '';
    return;
  }

  // Judge tops and bottoms separately — they ship different bands.
  const byFamily = ['tops', 'bottoms'].map(family => {
    const items = samples.filter(x => CATEGORIES[x.category].family === family);
    return { family, items, verdict: verdictOnBand(items, SHIPPED_BAND[family]) };
  }).filter(f => f.items.length);

  analysis.innerHTML = `
    <div class="card">
      <h3>What the numbers say</h3>
      ${byFamily.map(f => `
        <div class="calib-verdict calib-${f.verdict.state}">
          <strong>${FAMILIES[f.family].label}</strong> — ${esc(f.verdict.text)}
        </div>`).join('')}
      <div class="stat-grid">
        ${stat('Measurements', s.n)}
        ${stat('Typical error', fmt(s.mae, unit))}
        ${stat('Median error', fmt(s.median, unit))}
        ${stat('Worst', fmt(s.worst, unit))}
        ${stat('Bias', `${s.bias >= 0 ? '+' : '−'}${fmt(Math.abs(s.bias), unit)}`)}
        ${stat('Spread (sd)', s.sd == null ? '—' : fmt(s.sd, unit))}
      </div>
      <p class="hint">Bias is the systematic lean: positive means Fit Check guesses garments
        <em>wider</em> than they really are, which a constant correction could fix.
        Typical error is the noise that no correction removes.</p>

      <h3>By source</h3>
      ${table(groupBy(samples, x => x.source === 'measured' ? 'Published spec' : 'Size chart'))}
      <h3>By brand</h3>
      ${table(groupBy(samples, x => brandById(x.brandId)?.name || x.brandId))}

      <div class="row">
        <button id="cb-csv" class="btn">Export CSV</button>
        <button id="cb-clear" class="btn btn-danger">Clear calibration data</button>
      </div>
    </div>`;

  list.innerHTML = `
    <div class="card">
      <h3>Measurements (${samples.length})</h3>
      ${samples.map(x => {
        const err = errorOf(x);
        const cls = Math.abs(err) <= SHIPPED_BAND[CATEGORIES[x.category].family] ? 'high'
          : Math.abs(err) <= 4 ? 'medium' : 'low';
        return `
          <div class="list-item">
            <div class="grow">${esc(brandById(x.brandId)?.name || x.brandId)} ${DEPTS[x.dept].toLowerCase()} ${CATEGORIES[x.category].label.toLowerCase()}, ${esc(x.size)}
              <span class="sub">said ${fmt(x.predictedFlat, unit)} · actually ${fmt(x.actualFlat, unit)} · ${x.source === 'measured' ? 'spec' : 'chart'}</span></div>
            <span class="chip chip-${cls}">${err >= 0 ? '+' : '−'}${fmt(Math.abs(err), unit)}</span>
            <button class="btn btn-sm btn-danger" data-del="${x.id}">✕</button>
          </div>`;
      }).join('')}
    </div>`;

  analysis.querySelector('#cb-csv').onclick = () => {
    const blob = new Blob([toCsv(samples)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fit-check-calibration-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  analysis.querySelector('#cb-clear').onclick = () => {
    if (!confirm('Delete all calibration measurements?')) return;
    samples = [];
    save();
    paint(root);
  };
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = () => {
      samples = samples.filter(x => x.id !== btn.dataset.del);
      save();
      paint(root);
    };
  });
}

function stat(label, value) {
  return `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
}

function table(rows) {
  if (!rows.length) return '<p class="hint">No data.</p>';
  return `
    <div class="calib-table">
      ${rows.map(r => `
        <div class="list-item">
          <div class="grow">${esc(String(r.key))}<span class="sub">${r.n} measurement${r.n === 1 ? '' : 's'} · bias ${r.bias >= 0 ? '+' : '−'}${fmt(Math.abs(r.bias), unit)}</span></div>
          <span class="chip chip-${r.mae <= 2 ? 'high' : r.mae <= 4 ? 'medium' : 'low'}">±${fmt(r.mae, unit)}</span>
        </div>`).join('')}
    </div>`;
}
