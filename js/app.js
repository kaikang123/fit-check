import { BRANDS, DEPTS, FEELS, ERAS, CUTS, CATEGORIES, FAMILIES, FIT_PREFERENCES } from './data.js';
import * as store from './store.js';
import {
  predict, verdict, brandById, CONFIDENCE_LABELS, learnedOffsets, trainingSignals,
  gaugeGeometry,
} from './engine.js';
import { renderMeasure } from './measure.js';
import { DIAGRAMS, categoryIcon, ICONS, fitGauge } from './icons.js';
import { UNITS, ENTRY_MODES, toCm, fmt, fmtSigned, bounds, secondaryBounds } from './units.js';
import * as catalog from './catalog.js';
import { renderBodyScan, teardownBodyScan, saveScan } from './body.js';
import { renderTagScan, teardownTag } from './tag.js';
import { cameraUnavailableReason } from './env.js';

const screen = document.getElementById('screen');
let tab = 'check';
let checkMode = 'search';   // search | manual | scan

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function u() {
  return store.units();
}

function pref(p) {
  return p?.preference || 'regular';
}

function brandName(id) {
  return brandById(id)?.name || null;
}

function catOptions(selected) {
  return Object.entries(CATEGORIES)
    .map(([k, c]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${c.label}</option>`).join('');
}

function brandOptions(selected, withOther) {
  return (withOther ? '<option value="">Other / unknown</option>' : '')
    + BRANDS.map(b => `<option value="${b.id}" ${b.id === selected ? 'selected' : ''}>${b.name}</option>`).join('');
}

function garmentVisual(ref) {
  return ref.photo
    ? `<img class="thumb" src="${ref.photo}" alt="">`
    : `<span class="thumb thumb-icon">${categoryIcon(ref.category)}</span>`;
}

function bandChip(band) {
  return band === 'fit' ? 'high' : (band === 'tight1' || band === 'loose1') ? 'medium' : 'low';
}

function teardown() {
  teardownBodyScan();
  teardownTag();
}

document.querySelectorAll('#tabbar .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    teardown();
    tab = btn.dataset.tab;
    document.querySelectorAll('#tabbar .tab').forEach(b => b.classList.toggle('active', b === btn));
    render();
  });
});

document.getElementById('profile-chip').addEventListener('click', () => goTab('profile'));

function goTab(name) {
  teardown();
  tab = name;
  document.querySelectorAll('#tabbar .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  render();
}

// Served over plain http (the usual way to first try this on a phone), the
// camera is unavailable no matter what the app does. Say so once, up front,
// rather than letting three separate features look broken.
if (cameraUnavailableReason() === 'insecure') {
  const bar = document.createElement('div');
  bar.className = 'notice';
  bar.innerHTML = `Camera features are off — browsers only allow the camera over <strong>https</strong>,
    and this page is plain http. Everything else works, and photos from your gallery work too.`;
  document.getElementById('app').prepend(bar);
}

store.onSaveError(msg => {
  let bar = document.getElementById('save-error');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'save-error';
    bar.className = 'save-error';
    document.getElementById('app').prepend(bar);
  }
  bar.textContent = msg;
});

function render() {
  const p = store.activeProfile();
  document.getElementById('profile-chip').textContent = p ? p.name : 'Set up';
  if (!p) return renderCreateProfile(true);
  if (!p.refs.length && tab !== 'profile') return renderFirstRef(p);
  ({ check: renderCheck, closet: renderCloset, profile: renderProfile })[tab](screen, p);
}

/* ---------- Shared: measurement input group ---------- */

// A measurement field that understands the active unit and lets the user say
// whether they measured flat or all the way around. Returns a read() that
// yields centimetres, so 90+ cm chests are enterable either way.
function measurementGroup(idPrefix, family, labelOverride) {
  const unit = u();
  const fam = FAMILIES[family];
  const b = bounds(family, 'flat', unit);
  const sb = secondaryBounds(family, unit);
  return `
    <div class="measure-group">
      <label class="field">${labelOverride || fam.main.replace(/\s*\(cm\)$/, '')} (${UNITS[unit].short})
        <input id="${idPrefix}-main" type="number" step="${b.step}" min="${b.min}" max="${b.max}" inputmode="decimal">
      </label>
      <div class="pills pills-sm" id="${idPrefix}-mode">
        ${Object.entries(ENTRY_MODES).map(([k, m]) =>
          `<button type="button" class="pill pill-sm ${k === 'flat' ? 'active' : ''}" data-mode="${k}">${m.label}</button>`).join('')}
      </div>
      <p class="hint" id="${idPrefix}-hint">Lay it flat and measure straight across.</p>
      <label class="field">${fam.secondary.replace(/\s*\(cm\)$/, '')} (${UNITS[unit].short}) — optional
        <input id="${idPrefix}-secondary" type="number" step="${sb.step}" min="${sb.min}" max="${sb.max}" inputmode="decimal">
      </label>
    </div>`;
}

function wireMeasurementGroup(root, idPrefix, family) {
  let mode = 'flat';
  const hint = root.querySelector(`#${idPrefix}-hint`);
  const input = root.querySelector(`#${idPrefix}-main`);
  const fam = FAMILIES[family];

  const applyMode = () => {
    const b = bounds(family, mode, u());
    input.min = b.min;
    input.max = b.max;
    hint.textContent = mode === 'flat'
      ? 'Lay it flat and measure straight across.'
      : `Measure the whole way around the garment — we halve it to get the flat ${fam.mainShort}.`;
  };

  root.querySelectorAll(`#${idPrefix}-mode .pill`).forEach(pill => {
    pill.onclick = () => {
      mode = pill.dataset.mode;
      root.querySelectorAll(`#${idPrefix}-mode .pill`).forEach(x => x.classList.toggle('active', x === pill));
      applyMode();
    };
  });
  applyMode();

  return {
    // Centimetres, or null when the entry is empty/out of range.
    read() {
      const raw = parseFloat(input.value);
      if (!raw) return null;
      const cm = toCm(raw, u()) * ENTRY_MODES[mode].factor;
      const [lo, hi] = [bounds(family, 'flat', 'cm').min, bounds(family, 'flat', 'cm').max];
      return cm >= lo && cm <= hi ? cm : null;
    },
    readSecondary() {
      const raw = parseFloat(root.querySelector(`#${idPrefix}-secondary`).value);
      return raw ? toCm(raw, u()) : null;
    },
    focus() { input.focus(); },
  };
}

/* ---------- Photo attach helper ---------- */

function wirePhotoAttach(input, previewEl, holder) {
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      holder.photo = store.thumbnail(img);
      previewEl.innerHTML = `<img class="thumb thumb-lg" src="${holder.photo}" alt="Garment photo">`;
    };
    img.src = URL.createObjectURL(file);
  });
}

/* ---------- Onboarding ---------- */

// Adding a *second* profile is the only time a name is worth asking for; the
// first profile is just "you".
function renderCreateProfile(isFirst) {
  if (isFirst) {
    store.addProfile('You', 'men', 'regular');
    render();
    return;
  }
  screen.innerHTML = `
    <div class="card">
      <h2>New profile</h2>
      <p class="muted">A separate fit profile — for a partner or a child. It trains its own model, entirely separate from yours.</p>
      <label class="field">Name<input id="ob-name" type="text" placeholder="e.g. Sam"></label>
      <label class="field">Shops mostly in
        <select id="ob-dept">${Object.entries(DEPTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      </label>
      <div class="row">
        <button id="ob-go" class="btn btn-primary">Create</button>
        <button id="ob-cancel" class="btn">Cancel</button>
      </div>
    </div>`;
  screen.querySelector('#ob-cancel').onclick = () => render();
  screen.querySelector('#ob-go').onclick = () => {
    const name = screen.querySelector('#ob-name').value.trim();
    if (!name) return screen.querySelector('#ob-name').focus();
    store.addProfile(name, screen.querySelector('#ob-dept').value, 'regular');
    render();
  };
}

// One question. Everything else here has a sensible default and can be edited
// later — asking for it up front is what made this feel like paperwork.
function renderFirstRef(p) {
  const holder = { photo: null };
  screen.innerHTML = `
    <div class="card">
      <h2>Measure the shirt that fits you best</h2>
      <p class="muted">Lay your favourite-fitting top flat and measure straight across, armpit to armpit. That one number is all Fit Check needs to start — it captures how <em>you</em> like clothes to fit.</p>
      ${DIAGRAMS.tops}
      ${measurementGroup('rf', 'tops')}
      <button id="rf-go" class="btn btn-primary btn-wide">Start checking clothes</button>
      <details class="disclosure">
        <summary>Add details, or measure a different way</summary>
        <label class="field">Give it a name<input id="rf-name" type="text" placeholder="e.g. Grey tee"></label>
        <div class="grid2">
          <label class="field">Type
            <select id="rf-cat">
              ${Object.entries(CATEGORIES).filter(([, c]) => c.family === 'tops')
                .map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('')}
            </select>
          </label>
          <label class="field">Brand<select id="rf-brand">${brandOptions('', true)}</select></label>
        </div>
        <div class="row" style="align-items:center">
          <label class="btn file-btn">Add a photo
            <input type="file" id="rf-photo" accept="image/*" hidden>
          </label>
          <span id="rf-photo-preview"></span>
        </div>
        <p class="hint" style="margin-top:12px">No tape measure to hand?</p>
        <div class="row">
          <button id="rf-photo-measure" class="btn">Measure from a photo</button>
          <button id="rf-bodyscan" class="btn">Scan my body instead</button>
        </div>
        <p class="hint">A body scan covers tops and bottoms at once, but lands a few centimetres off a tape measure — so it starts out flagged as preliminary.</p>
      </details>
    </div>`;

  const group = wireMeasurementGroup(screen, 'rf', 'tops');
  wirePhotoAttach(screen.querySelector('#rf-photo'), screen.querySelector('#rf-photo-preview'), holder);

  screen.querySelector('#rf-photo-measure').onclick = () => openMeasure(p);
  screen.querySelector('#rf-bodyscan').onclick = () => {
    renderBodyScan(screen, p, result => {
      if (result === 'saved') tab = 'check';
      render();
    });
  };

  screen.querySelector('#rf-go').onclick = () => {
    const main = group.read();
    if (main == null) return group.focus();
    store.addRef(p, {
      name: screen.querySelector('#rf-name').value.trim() || 'My reference top',
      brandId: screen.querySelector('#rf-brand').value || null,
      category: screen.querySelector('#rf-cat').value,
      main,
      secondary: group.readSecondary(),
      photo: holder.photo,
      source: 'manual',
    });
    render();
  };
}

// Photo measurement is a refinement tool, not a destination — it opens over
// whatever you were doing and returns you there.
function openMeasure(p, onDone) {
  renderMeasure(screen, p);
  const back = document.createElement('div');
  back.className = 'card';
  back.innerHTML = '<button class="btn" id="mz-back">Back</button>';
  screen.appendChild(back);
  back.querySelector('#mz-back').onclick = () => (onDone ? onDone() : render());
}

/* ---------- Check ---------- */

function sizeOptions(brandId, dept, category) {
  const brand = brandById(brandId);
  const chart = brand?.charts[dept]?.[CATEGORIES[category].family];
  return chart ? Object.keys(chart) : [];
}

function refLineHtml(p, category) {
  const family = CATEGORIES[category].family;
  const ref = store.activeRef(p, family);
  if (!ref) {
    return `<div class="ref-line ref-missing">No ${FAMILIES[family].label.toLowerCase()} reference garment yet —
      add one in the Profile tab or measure one from a photo. <button id="ck-goto-profile" class="btn btn-sm">Add now</button></div>`;
  }
  const brand = brandName(ref.brandId);
  return `<div class="ref-line">${garmentVisual(ref)}
    <span>Comparing against: <strong>${esc(ref.name)}</strong><br>
    <span class="sub">${CATEGORIES[ref.category].label}${brand ? ` · ${brand}` : ''} · ${fmt(ref.main, u())} ${FAMILIES[family].mainShort}</span></span></div>`;
}

function verdictHtml(category, v, confidence, reasons, confidenceLabel, gauge) {
  return `
    <div class="verdict verdict-${v.band}">
      <div class="verdict-head">${categoryIcon(category)}<div class="verdict-title">${v.title}</div></div>
      ${gauge || ''}
      <span class="chip chip-${confidence}">${confidenceLabel || CONFIDENCE_LABELS[confidence]}</span>
      <p>${v.detail}</p>
      <ul class="reasons">${reasons.filter(Boolean).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>`;
}

function renderCheck(el, p) {
  el.innerHTML = `
    <div class="segmented" id="ck-modes">
      ${[['search', 'Search'], ['tag', 'Scan'], ['manual', 'Enter size']].map(([k, label]) =>
        `<button class="seg ${k === checkMode ? 'active' : ''}" data-mode="${k}">${label}</button>`).join('')}
    </div>
    <div id="ck-body"></div>`;

  el.querySelectorAll('#ck-modes .seg').forEach(btn => {
    btn.onclick = () => {
      teardown();
      checkMode = btn.dataset.mode;
      el.querySelectorAll('#ck-modes .seg').forEach(b => b.classList.toggle('active', b === btn));
      renderCheckBody(el.querySelector('#ck-body'), p);
    };
  });

  renderCheckBody(el.querySelector('#ck-body'), p);
}

function renderCheckBody(el, p) {
  if (checkMode === 'tag') {
    renderTagScan(el, p, () => goTab('profile'));
    return;
  }
  ({ search: renderSearchMode, manual: renderManualMode })[checkMode](el, p);
}

/* ---------- Check: search ---------- */

function renderSearchMode(el, p) {
  el.innerHTML = `
    <div class="card">
      <h2>Find a garment</h2>
      <p class="muted">Search by brand, product, or type. Entries with real published garment measurements are marked and rank first.</p>
      <label class="field">Search
        <input id="sr-q" type="search" placeholder="e.g. gildan t-shirt, uniqlo airism, levi's pants" autocomplete="off">
      </label>
      <label class="field">Department
        <select id="sr-dept">
          <option value="">All</option>
          ${Object.entries(DEPTS).map(([k, v]) => `<option value="${k}" ${k === p.dept ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="sr-results"></div>`;

  const q = el.querySelector('#sr-q');
  const deptSel = el.querySelector('#sr-dept');
  const results = el.querySelector('#sr-results');

  const run = () => {
    const entries = catalog.search(q.value, { dept: deptSel.value || undefined });
    if (!entries.length) {
      results.innerHTML = `<div class="card"><p class="muted">Nothing matched. Try a brand name, or use Manual entry.</p></div>`;
      return;
    }
    results.innerHTML = `<div class="card">
      <h3>${entries.length} result${entries.length === 1 ? '' : 's'}</h3>
      ${entries.map(e => `
        <div class="list-item">
          <span class="thumb thumb-icon">${categoryIcon(e.category)}</span>
          <div class="grow">${esc(catalog.brandNameOf(e))} — ${esc(e.name)}
            <span class="sub">${DEPTS[e.dept]} · ${CATEGORIES[e.category].label}</span></div>
          ${e.kind === 'measured' ? '<span class="chip chip-high">Measured</span>'
            : e.source === 'user' ? '<span class="chip chip-medium">Yours</span>'
            : '<span class="chip chip-medium">Estimate</span>'}
          <button class="btn btn-sm" data-open="${e.id}">Check</button>
        </div>`).join('')}
    </div>`;
    results.querySelectorAll('[data-open]').forEach(btn => {
      btn.onclick = () => openEntry(results, p, catalog.entryById(btn.dataset.open));
    });
  };

  q.addEventListener('input', run);
  deptSel.addEventListener('change', run);
  run();
}

// Show every size of a catalog entry with its verdict, so the user sees which
// size to reach for rather than checking them one at a time.
function openEntry(container, p, entry, extra = '') {
  const family = CATEGORIES[entry.category].family;
  const ref = store.activeRef(p, family);
  if (!ref) {
    container.innerHTML = `<div class="card"><p class="muted">Add a ${FAMILIES[family].label.toLowerCase()} reference garment first — the check compares against it.</p>
      <button class="btn" id="oe-profile">Add one</button></div>`;
    container.querySelector('#oe-profile').onclick = () => goTab('profile');
    return;
  }

  const rows = catalog.sizesOf(entry).map(size => {
    const pred = catalog.catalogPredict(p, ref, entry, size);
    if (!pred) return '';
    const v = verdict(pred.flat, ref, pred.secondary, u(), pref(p));
    return `<div class="list-item size-row" data-size="${size}">
      <div class="size-badge">${size}</div>
      <div class="grow">${v.title}<span class="sub">${fmt(pred.flat, u())} ${FAMILIES[family].mainShort} · ${fmtSigned(pred.flat - ref.main, u())} vs yours</span></div>
      <span class="chip chip-${bandChip(v.band)}">${pred.confidence}</span>
      <button class="btn btn-sm" data-bought="${size}">I got this</button>
    </div>`;
  }).join('');

  const best = catalog.sizesOf(entry)
    .map(size => {
      const pred = catalog.catalogPredict(p, ref, entry, size);
      return pred ? { size, pred, v: verdict(pred.flat, ref, pred.secondary, u(), pref(p)) } : null;
    })
    .filter(Boolean)
    // Sizes landing in the fit band win outright — a size the user would
    // actually be happy with beats one that is merely closest in raw
    // centimetres, which matters most for tight and baggy preferences.
    .sort((a, b) =>
      (a.v.band === 'fit' ? 0 : 1) - (b.v.band === 'fit' ? 0 : 1)
      || Math.abs(a.v.delta) - Math.abs(b.v.delta))[0];

  container.innerHTML = `
    ${extra}
    <div class="card">
      <div class="entry-head">${categoryIcon(entry.category)}
        <div><strong>${esc(catalog.brandNameOf(entry))} — ${esc(entry.name)}</strong>
        <span class="sub">${DEPTS[entry.dept]} · ${CATEGORIES[entry.category].label}</span></div>
      </div>
      ${best ? verdictHtml(entry.category, best.v, best.pred.confidence,
        [`Best size for you: ${best.size}`, ...best.pred.reasons], best.pred.confidenceLabel,
        fitGauge(gaugeGeometry(ref, best.v.delta, pref(p)), best.v.band)) : ''}
      <h3>All sizes</h3>
      ${rows}
      <div class="row">
        <button class="btn" id="oe-back">Back to search</button>
        <button class="btn" id="oe-measure">Measure it exactly</button>
      </div>
      <p class="hint">Holding the garment? Measuring it beats any published chart.</p>
    </div>`;

  // Logging a purchase is what makes the feedback loop possible later.
  container.querySelectorAll('[data-bought]').forEach(btn => {
    btn.onclick = () => {
      const size = btn.dataset.bought;
      const pred = catalog.catalogPredict(p, ref, entry, size);
      const v = verdict(pred.flat, ref, pred.secondary, u(), pref(p));
      store.addHistory(p, {
        kind: 'catalog', category: entry.category,
        brandId: entry.brandId, dept: entry.dept, size,
        label: `${catalog.brandNameOf(entry)} ${entry.name}, ${size}`,
        verdictTitle: v.title, band: v.band, confidence: pred.confidence,
      });
      btn.outerHTML = '<span class="chip chip-medium">Logged</span>';
    };
  });

  container.querySelector('#oe-back').onclick = () => renderSearchMode(container.closest('#ck-body') || container, p);
  container.querySelector('#oe-measure').onclick = () => openMeasure(p);
}

/* ---------- Check: manual ---------- */

function renderManualMode(el, p) {
  el.innerHTML = `
    <div id="ck-refline">${refLineHtml(p, 'tshirt')}</div>
    <div class="card">
      <h2>Check a garment</h2>
      <div class="grid2">
        <label class="field">Type<select id="ck-cat">${catOptions('tshirt')}</select></label>
        <label class="field">Brand<select id="ck-brand">${brandOptions(BRANDS[0].id, false)}</select></label>
        <label class="field">Department
          <select id="ck-dept">${Object.entries(DEPTS).map(([k, v]) => `<option value="${k}" ${k === p.dept ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
        <label class="field">Size<select id="ck-size"></select></label>
        <label class="field">Cut
          <select id="ck-cut">${Object.entries(CUTS).map(([k, c]) => `<option value="${k}" ${k === 'regular' ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        </label>
        <label class="field">Era
          <select id="ck-era">${Object.entries(ERAS).map(([k, e]) => `<option value="${k}">${e.label}</option>`).join('')}</select>
        </label>
      </div>
      <button id="ck-go" class="btn btn-primary">Will it fit?</button>
    </div>
    <div id="ck-result"></div>
    ${historyHtml(p)}`;

  const catSel = el.querySelector('#ck-cat');
  const brandSel = el.querySelector('#ck-brand');
  const deptSel = el.querySelector('#ck-dept');
  const sizeSel = el.querySelector('#ck-size');

  const refresh = () => {
    sizeSel.innerHTML = sizeOptions(brandSel.value, deptSel.value, catSel.value)
      .map(s => `<option value="${s}" ${s === 'M' ? 'selected' : ''}>${s}</option>`).join('');
    el.querySelector('#ck-refline').innerHTML = refLineHtml(p, catSel.value);
    el.querySelector('#ck-goto-profile')?.addEventListener('click', () => goTab('profile'));
  };
  catSel.onchange = brandSel.onchange = deptSel.onchange = refresh;
  refresh();

  el.querySelector('#ck-go').onclick = () => {
    const category = catSel.value;
    const family = CATEGORIES[category].family;
    const ref = store.activeRef(p, family);
    if (!ref) {
      el.querySelector('#ck-result').innerHTML =
        `<div class="card"><p class="muted">Add a ${FAMILIES[family].label.toLowerCase()} reference garment first — the check compares against it.</p></div>`;
      return;
    }
    const input = {
      brandId: brandSel.value, dept: deptSel.value, category, size: sizeSel.value,
      cut: el.querySelector('#ck-cut').value, era: el.querySelector('#ck-era').value,
    };
    const pred = predict(p, ref, input, u());
    if (!pred) return;
    const v = verdict(pred.flat, ref, null, u(), pref(p));
    el.querySelector('#ck-result').innerHTML = verdictHtml(
      category, v, pred.confidence, pred.reasons, pred.confidenceLabel,
      fitGauge(gaugeGeometry(ref, v.delta, pref(p)), v.band));
    store.addHistory(p, {
      kind: 'manual', category,
      brandId: input.brandId, dept: input.dept, size: input.size,
      label: `${brandName(input.brandId)} ${DEPTS[input.dept].toLowerCase()} ${CATEGORIES[category].label.toLowerCase()}, ${input.size}`,
      verdictTitle: v.title, band: v.band, confidence: pred.confidence,
    });
    el.querySelector('#ck-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
}

function historyHtml(p) {
  if (!p.history.length) return '';
  const pending = p.history.filter(h => h.outcome == null).length;
  return `
    <div class="card">
      <h3>Recent checks</h3>
      ${p.history.slice(0, 5).map(h => `
        <div class="list-item">
          <span class="thumb thumb-icon">${categoryIcon(h.category)}</span>
          <div class="grow">${esc(h.label)}<span class="sub">${h.date} &middot; ${h.confidence} confidence${
            h.outcome != null ? ` &middot; you said: ${FEELS.find(f => f.v === h.outcome)?.label.toLowerCase()}` : ''}</span></div>
          <span class="chip chip-${bandChip(h.band)}">${esc(h.verdictTitle)}</span>
        </div>`).join('')}
      ${pending ? `<p class="hint" style="margin-top:10px">${pending} check${pending === 1 ? '' : 's'} waiting on a "did it fit?" answer — the Closet tab is where they get logged.</p>` : ''}
    </div>`;
}

/* ---------- Closet ---------- */

// Checks awaiting a verdict from reality, plus how the app has actually been
// doing. This is the loop the whole product rests on, so it leads the tab.
function outcomesHtml(p) {
  const pending = p.history.filter(h => h.outcome == null);
  const acc = store.accuracy(p);

  const accCard = acc ? `
    <div class="card">
      <h3>How Fit Check has done for you</h3>
      <p class="muted">${acc.correct} of ${acc.total} verdict${acc.total === 1 ? '' : 's'} pointed the right way — ${acc.pct}%.
        ${acc.total < 5 ? 'Too few to mean much yet; it gets meaningful after a handful more.' : ''}</p>
    </div>` : '';

  if (!pending.length) return accCard;

  return `
    <div class="card">
      <h2>Did it fit?</h2>
      <p class="muted">Answer for anything you actually bought or tried on. Every answer tunes future predictions for that brand — this is the only way the app gets better at <em>you</em>.</p>
      ${pending.slice(0, 8).map(h => `
        <div class="outcome-item" data-outcome-for="${h.id}">
          <div class="list-item" style="border:none;padding-bottom:4px">
            <span class="thumb thumb-icon">${categoryIcon(h.category)}</span>
            <div class="grow">${esc(h.label)}<span class="sub">${h.date} · we said: ${esc(h.verdictTitle)}</span></div>
          </div>
          <div class="pills pills-sm">
            ${FEELS.map(f => `<button class="pill pill-sm" data-feel="${f.v}">${f.label}</button>`).join('')}
            <button class="pill pill-sm pill-quiet" data-skip="1">Didn't buy</button>
          </div>
        </div>`).join('')}
    </div>
    ${accCard}`;
}

function wireOutcomes(el, p) {
  el.querySelectorAll('[data-outcome-for]').forEach(row => {
    const id = row.dataset.outcomeFor;
    row.querySelectorAll('[data-feel]').forEach(btn => {
      btn.onclick = () => {
        const res = store.recordOutcome(p, id, Number(btn.dataset.feel));
        row.innerHTML = `<p class="muted">Thanks — logged.${res?.log
          ? ` Future ${brandName(res.log.brandId)} predictions are tuned to this.` : ''}</p>`;
        setTimeout(() => render(), 900);
      };
    });
    row.querySelector('[data-skip]').onclick = () => {
      p.history = p.history.filter(h => h.id !== id);
      store.save();
      render();
    };
  });
}

function renderCloset(el, p) {
  el.innerHTML = `
    ${outcomesHtml(p)}
    <div class="card">
      <h2>Log a garment you own</h2>
      <p class="muted">Tell Fit Check how garments you already own actually fit. Every log tunes predictions for that brand — to <em>you</em>, not to the average body. Two people with identical measurements get different verdicts here.</p>
      <div class="grid2">
        <label class="field">Type<select id="cl-cat">${catOptions('tshirt')}</select></label>
        <label class="field">Brand<select id="cl-brand">${brandOptions(BRANDS[0].id, false)}</select></label>
        <label class="field">Department
          <select id="cl-dept">${Object.entries(DEPTS).map(([k, v]) => `<option value="${k}" ${k === p.dept ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
        <label class="field">Size<select id="cl-size"></select></label>
      </div>
      <p class="field" style="margin-bottom:4px">How does it fit you?</p>
      <div class="pills" id="cl-feels">
        ${FEELS.map(f => `<button class="pill ${f.v === 0 ? 'active' : ''}" data-v="${f.v}">${f.label}</button>`).join('')}
      </div>
      <button id="cl-go" class="btn btn-primary">Add to closet log</button>
    </div>
    <div class="card">
      <h3>Your closet log (${p.closet.length})</h3>
      ${p.closet.length ? p.closet.map(l => `
        <div class="list-item">
          <span class="thumb thumb-icon">${categoryIcon(l.category)}</span>
          <div class="grow">${brandName(l.brandId) || 'Unknown'} ${CATEGORIES[l.category].label.toLowerCase()}, ${DEPTS[l.dept].toLowerCase()} ${esc(l.size)}
            <span class="sub">${FEELS.find(f => f.v === l.feel)?.label} &middot; ${l.date}</span></div>
          <button class="btn btn-sm btn-danger" data-del="${l.id}">Remove</button>
        </div>`).join('') : '<p class="muted">Nothing logged yet.</p>'}
    </div>`;

  wireOutcomes(el, p);

  const catSel = el.querySelector('#cl-cat');
  const brandSel = el.querySelector('#cl-brand');
  const deptSel = el.querySelector('#cl-dept');
  const sizeSel = el.querySelector('#cl-size');
  const fillSizes = () => {
    sizeSel.innerHTML = sizeOptions(brandSel.value, deptSel.value, catSel.value)
      .map(s => `<option value="${s}" ${s === 'M' ? 'selected' : ''}>${s}</option>`).join('');
  };
  catSel.onchange = brandSel.onchange = deptSel.onchange = fillSizes;
  fillSizes();

  let feel = 0;
  el.querySelectorAll('#cl-feels .pill').forEach(pill => {
    pill.onclick = () => {
      feel = Number(pill.dataset.v);
      el.querySelectorAll('#cl-feels .pill').forEach(x => x.classList.toggle('active', x === pill));
    };
  });

  el.querySelector('#cl-go').onclick = () => {
    store.addClosetLog(p, {
      brandId: brandSel.value, dept: deptSel.value,
      category: catSel.value, size: sizeSel.value, feel,
    });
    render();
  };

  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = () => {
      p.closet = p.closet.filter(l => l.id !== btn.dataset.del);
      store.save();
      render();
    };
  });
}

/* ---------- Profile ---------- */

// Makes the personalisation legible: what the model has learned, from how
// much, and what it does differently for this person as a result.
function fitModelHtml(p) {
  const learned = learnedOffsets(p);
  const signals = trainingSignals(p);
  const total = signals.closet + signals.outcomes;
  const acc = store.accuracy(p);

  if (!total) {
    return `
      <div class="card">
        <h2>Your fit model</h2>
        <p class="muted">Every profile trains its own model. Nothing is shared or averaged with other people — two users with identical measurements end up with different predictions, because the model only ever learns from <em>your</em> garments.</p>
        <p class="hint">It hasn't learned anything yet. Log a garment you own in the Closet tab, or answer "did it fit?" after a check — each entry trains it.</p>
      </div>`;
  }

  const rows = learned.map(l => {
    const amount = fmt(Math.abs(l.offset), u());
    const wording = l.direction === 'true'
      ? 'sizes true to chart for you'
      : `runs ${amount} ${l.direction === 'small' ? 'small' : 'large'} for you`;
    return `
      <div class="list-item">
        <span class="thumb thumb-icon">${categoryIcon(l.family === 'tops' ? 'tshirt' : 'pants')}</span>
        <div class="grow">${esc(l.brandName)} ${DEPTS[l.dept].toLowerCase()} ${FAMILIES[l.family].label.toLowerCase()}
          <span class="sub">${wording} · from ${l.count} garment${l.count === 1 ? '' : 's'}${
            l.inconsistent ? ' · your logs disagree, so this stays cautious' : ''}</span></div>
        <span class="chip chip-${l.settled ? 'high' : 'medium'}">${l.settled ? 'confident' : 'early'}</span>
      </div>`;
  }).join('');

  // A one-line headline, with the per-brand detail folded away until wanted.
  return `
    <div class="card">
      <h2>Your fit model</h2>
      <p class="muted">Learning from ${total} entr${total === 1 ? 'y' : 'ies'} — yours alone, never averaged with anyone else's.
        ${acc ? `Right ${acc.correct} of ${acc.total} times so far.` : ''}</p>
      <details class="disclosure">
        <summary>${rows ? 'What it has worked out' : 'How it learns'}</summary>
        <p class="hint">${signals.closet} garment${signals.closet === 1 ? '' : 's'} you own, ${signals.outcomes} outcome${signals.outcomes === 1 ? '' : 's'} you reported. Someone with your exact measurements would still get different answers.</p>
        ${rows || '<p class="hint">Not enough yet to correct any brand — it needs entries matching a brand you check.</p>'}
      </details>
    </div>`;
}

function renderProfile(el, p) {
  el.innerHTML = `
    ${fitModelHtml(p)}
    <div class="card">
      <h2>How do you like clothes to fit?</h2>
      <div class="pills" id="pf-pref">
        ${Object.entries(FIT_PREFERENCES).map(([k, v]) =>
          `<button class="pill ${k === pref(p) ? 'active' : ''}" data-pref="${k}">${v.label}</button>`).join('')}
      </div>
      <p class="hint">Changes what counts as a good fit for you — a roomy shirt shouldn't be called oversized if baggy is what you want.</p>
    </div>
    <div class="card">
      <h3>Reference garments</h3>
      <p class="muted">One per family (tops / bottoms) is the active yardstick its checks compare against.</p>
      ${p.refs.length ? p.refs.map(r => `
        <div class="list-item">
          ${garmentVisual(r)}
          <div class="grow">${esc(r.name)} ${r.derived ? '<span class="chip chip-low">Preliminary</span>' : ''}
            <span class="sub">${CATEGORIES[r.category].label}${brandName(r.brandId) ? ` · ${brandName(r.brandId)}` : ''} ·
              ${fmt(r.main, u())} ${FAMILIES[r.family].mainShort}${r.secondary ? ` · ${fmt(r.secondary, u())} ${FAMILIES[r.family].secondaryShort}` : ''} ·
              ${r.source === 'photo' ? 'photo-measured' : r.source === 'scan' ? 'from body scan' : 'tape-measured'}</span></div>
          <div class="row" style="margin:0">
            ${r.id === p.activeRefs[r.family]
              ? `<span class="chip chip-high">Active · ${FAMILIES[r.family].label.toLowerCase()}</span>`
              : `<button class="btn btn-sm" data-activate="${r.id}">Use</button>`}
            <button class="btn btn-sm btn-danger" data-delref="${r.id}">Remove</button>
          </div>
        </div>`).join('') : '<p class="muted">None yet.</p>'}
      <div id="pf-addref-zone"><div class="row"><button id="pf-addref" class="btn">+ Add reference garment</button></div></div>
    </div>
    <div class="card">
      <details class="disclosure disclosure-flush">
        <summary>Settings &amp; data</summary>

        <h3>Units</h3>
        <div class="pills" id="pf-units">
          ${Object.entries(UNITS).map(([k, v]) =>
            `<button class="pill ${k === u() ? 'active' : ''}" data-unit="${k}">${v.short}</button>`).join('')}
        </div>
        <p class="hint">Stored once and converted for display, so switching never changes your saved data.</p>

        <h3>Body measurements</h3>
        ${p.body ? `
          <span class="chip chip-low">Preliminary — from body scan, ${p.body.date}</span>
          <div class="grid2" style="margin-top:10px">
            <label class="field">Chest around (${UNITS[u()].short})
              <input id="pf-body-chest" type="number" step="${UNITS[u()].step}" value="${fmt(p.body.chest, u(), { bare: true })}" inputmode="decimal"></label>
            <label class="field">Waist around (${UNITS[u()].short})
              <input id="pf-body-waist" type="number" step="${UNITS[u()].step}" value="${fmt(p.body.waist, u(), { bare: true })}" inputmode="decimal"></label>
          </div>
          <div class="row">
            <button id="pf-body-save" class="btn btn-primary">Update</button>
            <button id="pf-body-rescan" class="btn">Scan again</button>
          </div>
          <p class="hint">Typed-in numbers beat the scan — a tape measure is more accurate than any phone camera.</p>`
        : `<p class="hint">A body scan gives a quick starting point for tops and bottoms at once, flagged preliminary until you measure a real garment.</p>
           <button id="pf-body-scan" class="btn">Run a body scan</button>`}

        <h3>Other profiles</h3>
        ${store.state.profiles.map(pr => `
          <div class="list-item">
            <div class="grow">${esc(pr.name)}<span class="sub">${DEPTS[pr.dept]} &middot; ${pr.refs.length} reference &middot; ${pr.closet.length} logged</span></div>
            ${pr.id === p.id
              ? '<span class="chip chip-high">Active</span>'
              : `<button class="btn btn-sm" data-switch="${pr.id}">Switch</button>`}
          </div>`).join('')}
        <div class="row"><button id="pf-new" class="btn">+ Add a profile</button></div>

        <h3>Backup</h3>
        <p class="hint">Everything lives on this device only — nothing is uploaded. Clearing your browser data would erase it, so keep a backup.
          ${Object.keys(store.state.barcodes).length} barcode${Object.keys(store.state.barcodes).length === 1 ? '' : 's'} linked.</p>
        <div class="row">
          <button id="pf-export" class="btn">Export</button>
          <label class="btn file-btn">Restore
            <input type="file" id="pf-import" accept="application/json,.json" hidden>
          </label>
        </div>
        <p id="pf-io-msg" class="hint" hidden></p>
        <div class="row"><button id="pf-wipe" class="btn btn-danger">Delete everything</button></div>
      </details>
    </div>`;

  el.querySelectorAll('#pf-pref .pill').forEach(pill => {
    pill.onclick = () => {
      p.preference = pill.dataset.pref;
      store.save();
      render();
    };
  });

  el.querySelectorAll('#pf-units .pill').forEach(pill => {
    pill.onclick = () => {
      store.setUnits(pill.dataset.unit);
      render();
    };
  });

  const startScan = () => renderBodyScan(screen, p, () => render());
  el.querySelector('#pf-body-scan')?.addEventListener('click', startScan);
  el.querySelector('#pf-body-rescan')?.addEventListener('click', startScan);

  // Typed corrections rebuild the derived references from the new numbers.
  el.querySelector('#pf-body-save')?.addEventListener('click', () => {
    const chest = toCm(parseFloat(el.querySelector('#pf-body-chest').value) || 0, u());
    const waist = toCm(parseFloat(el.querySelector('#pf-body-waist').value) || 0, u());
    if (!chest || !waist) return;
    saveScan(p, { ...p.body, chest, waist, preference: pref(p) });
    render();
  });

  el.querySelectorAll('[data-switch]').forEach(btn => {
    btn.onclick = () => {
      store.state.activeProfileId = btn.dataset.switch;
      store.save();
      render();
    };
  });

  el.querySelector('#pf-new').onclick = () => renderCreateProfile(false);

  el.querySelectorAll('[data-activate]').forEach(btn => {
    btn.onclick = () => {
      const ref = p.refs.find(r => r.id === btn.dataset.activate);
      p.activeRefs[ref.family] = ref.id;
      store.save();
      render();
    };
  });

  el.querySelectorAll('[data-delref]').forEach(btn => {
    btn.onclick = () => {
      const ref = p.refs.find(r => r.id === btn.dataset.delref);
      const sameFamily = p.refs.filter(r => r.family === ref.family).length;
      if (sameFamily === 1 && !confirm(`This is your only ${FAMILIES[ref.family].label.toLowerCase()} reference — checks for that family need one. Remove anyway?`)) return;
      store.removeRef(p, btn.dataset.delref);
      render();
    };
  });

  el.querySelector('#pf-addref').onclick = () => {
    const holder = { photo: null };
    const zone = el.querySelector('#pf-addref-zone');
    let family = 'tops';

    const paint = () => {
      zone.innerHTML = `
        <div id="pf-rf-diagram">${DIAGRAMS[family]}</div>
        <label class="field">Garment name<input id="pf-rf-name" type="text" placeholder="e.g. Navy overshirt" value="${esc(zone.dataset.name || '')}"></label>
        <div class="grid2">
          <label class="field">Type<select id="pf-rf-cat">${catOptions(zone.dataset.cat || 'tshirt')}</select></label>
          <label class="field">Brand<select id="pf-rf-brand">${brandOptions(zone.dataset.brand || '', true)}</select></label>
        </div>
        ${measurementGroup('pf-rf', family)}
        <div class="row" style="align-items:center">
          <label class="btn file-btn">Add a photo (optional)
            <input type="file" id="pf-rf-photo" accept="image/*" hidden>
          </label>
          <span id="pf-rf-photo-preview">${holder.photo ? `<img class="thumb thumb-lg" src="${holder.photo}" alt="">` : ''}</span>
        </div>
        <div class="row"><button id="pf-rf-go" class="btn btn-primary">Save</button></div>`;

      const group = wireMeasurementGroup(zone, 'pf-rf', family);
      const catSel = zone.querySelector('#pf-rf-cat');
      wirePhotoAttach(zone.querySelector('#pf-rf-photo'), zone.querySelector('#pf-rf-photo-preview'), holder);

      catSel.onchange = () => {
        const nextFamily = CATEGORIES[catSel.value].family;
        zone.dataset.cat = catSel.value;
        zone.dataset.name = zone.querySelector('#pf-rf-name').value;
        zone.dataset.brand = zone.querySelector('#pf-rf-brand').value;
        if (nextFamily !== family) {
          family = nextFamily;
          paint();
        }
      };

      zone.querySelector('#pf-rf-go').onclick = () => {
        const main = group.read();
        if (main == null) return group.focus();
        store.addRef(p, {
          name: zone.querySelector('#pf-rf-name').value.trim() || 'Reference garment',
          brandId: zone.querySelector('#pf-rf-brand').value || null,
          category: catSel.value,
          main,
          secondary: group.readSecondary(),
          photo: holder.photo,
          source: 'manual',
        });
        render();
      };
    };
    paint();
  };

  const ioMsg = el.querySelector('#pf-io-msg');

  el.querySelector('#pf-export').onclick = () => {
    const blob = new Blob([store.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fit-check-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    ioMsg.textContent = 'Backup downloaded.';
    ioMsg.hidden = false;
  };

  el.querySelector('#pf-import').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Restoring replaces everything currently on this device. Continue?')) {
      e.target.value = '';
      return;
    }
    file.text().then(text => {
      const res = store.importJson(text);
      if (!res.ok) {
        ioMsg.textContent = res.error;
        ioMsg.style.color = 'var(--red)';
        ioMsg.hidden = false;
        return;
      }
      render();
    });
  });

  el.querySelector('#pf-wipe').onclick = () => {
    if (!confirm('Delete all profiles, reference garments, and logs? This cannot be undone.')) return;
    localStorage.removeItem('fitcheck-v1');
    location.reload();
  };
}

render();
