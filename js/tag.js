// Tag scanning: photograph a care/size label, read what it says, and resolve
// that to garment dimensions.
//
// A tag gives identity — brand, size, fibre content. It does not give
// dimensions, so those come from the catalog once identity is known, or from
// measuring the garment. The UI is explicit about which happened.
//
// OCR uses the browser's TextDetector where it exists. It is behind an
// experimental flag in Chrome and absent everywhere else, so the flow is built
// to work without it: every field is a control the user can set directly, and
// OCR merely pre-fills them.

import { BRANDS, CATEGORIES, DEPTS, FAMILIES } from './data.js';
import * as store from './store.js';
import * as catalog from './catalog.js';
import { verdict, CONFIDENCE_LABELS, gaugeGeometry } from './engine.js';
import { fmt } from './units.js';
import { ICONS, categoryIcon, fitGauge } from './icons.js';
import { parseTag } from './tagparse.js';
import { isSupported as barcodeSupported, normalizeBarcode } from './scan.js';
import { cameraMessage } from './env.js';

let stream = null;
let pollTimer = null;

export function ocrAvailable() {
  return typeof window !== 'undefined' && 'TextDetector' in window;
}

export function teardownTag() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

// Users shouldn't have to know whether they're pointing at a barcode or a
// printed size tag — both live on the same label. One capture, both detectors.
async function readBarcode(source) {
  if (!barcodeSupported()) return null;
  try {
    const detector = new window.BarcodeDetector();
    const codes = await detector.detect(source);
    return codes.length ? normalizeBarcode(codes[0].rawValue) : null;
  } catch (e) {
    return null;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function readText(source) {
  if (!ocrAvailable()) return null;
  try {
    const detector = new window.TextDetector();
    const blocks = await detector.detect(source);
    return blocks.map(b => b.rawValue).filter(Boolean).join(' ') || null;
  } catch (e) {
    return null;
  }
}

/* ---------- Entry ---------- */

export function renderTagScan(el, profile, onNeedReference) {
  teardownTag();
  el.innerHTML = `
    <div class="card">
      <h2>${ICONS.camera} Scan a tag</h2>
      <p class="muted">Point the camera at whatever the garment has — the <strong>price tag</strong> hanging off it, the <strong>care label</strong> inside, or a <strong>barcode</strong>. One shot reads all three; you don't need to pick.</p>
      <div class="row">
        <button id="tg-camera" class="btn btn-primary">Open camera</button>
        <label class="btn file-btn">Choose photo
          <input type="file" id="tg-file" accept="image/*" hidden>
        </label>
        <button id="tg-skip" class="btn">Type it instead</button>
      </div>
      <p id="tg-error" class="hint" style="color:var(--red)" hidden></p>
      <details class="disclosure">
        <summary>What each kind of tag gives us</summary>
        <p class="hint"><strong>Price tag</strong> — usually the most useful: brand, size, often the cut ("slim fit") and the garment type, plus the price.</p>
        <p class="hint"><strong>Care label</strong> — brand, size and fabric composition, including stretch content.</p>
        <p class="hint"><strong>Barcode</strong> — identifies the exact product, once that code has been linked to a garment.</p>
        <p class="hint">None of them carry dimensions — no tag prints pit-to-pit. Measurements come from the brand's published sizing once we know what the garment is. For exact numbers on one specific garment, measuring it beats any tag.</p>
        ${ocrAvailable() ? '' : '<p class="hint">This browser can\'t read text from photos, so you\'ll confirm the details yourself — two taps.</p>'}
      </details>
    </div>
    <div id="tg-cam" class="card" hidden>
      <p class="stage-label">Fill the frame with the label, then capture</p>
      <video id="tg-video" autoplay playsinline muted></video>
      <div class="row">
        <button id="tg-capture" class="btn btn-primary">Capture</button>
        <button id="tg-cancel" class="btn">Cancel</button>
      </div>
    </div>
    <div id="tg-stage"></div>`;

  el.querySelector('#tg-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => handleCapture(el, profile, img, onNeedReference);
    img.src = URL.createObjectURL(file);
  });

  el.querySelector('#tg-camera').onclick = () => startCamera(el, profile, onNeedReference);
  el.querySelector('#tg-skip').onclick = () => showConfirm(el, profile, null, null, onNeedReference);
}

async function startCamera(el, profile, onNeedReference) {
  const errEl = el.querySelector('#tg-error');
  errEl.hidden = true;
  const blocked = cameraMessage();
  if (blocked) {
    errEl.textContent = blocked;
    errEl.hidden = false;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 } },
    });
  } catch (e) {
    errEl.textContent = `Could not open the camera (${e.name || 'error'}). Choose a photo or enter the details by hand.`;
    errEl.hidden = false;
    return;
  }
  const panel = el.querySelector('#tg-cam');
  const video = el.querySelector('#tg-video');
  panel.hidden = false;
  video.srcObject = stream;

  const grab = () => {
    const frame = document.createElement('canvas');
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    frame.getContext('2d').drawImage(video, 0, 0);
    return frame;
  };

  // Watch for a barcode while the user is lining the shot up. If one drifts
  // into frame we can skip the capture step entirely.
  if (barcodeSupported()) {
    pollTimer = setInterval(async () => {
      if (!video.videoWidth) return;
      const code = await readBarcode(video);
      if (!code) return;
      const frame = grab();
      teardownTag();
      panel.hidden = true;
      handleCapture(el, profile, frame, onNeedReference);
    }, 500);
  }

  el.querySelector('#tg-capture').onclick = () => {
    if (!video.videoWidth) return;
    const frame = grab();
    teardownTag();
    panel.hidden = true;
    handleCapture(el, profile, frame, onNeedReference);
  };
  el.querySelector('#tg-cancel').onclick = () => {
    teardownTag();
    panel.hidden = true;
  };
}

async function handleCapture(el, profile, source, onNeedReference) {
  const stage = el.querySelector('#tg-stage');
  stage.innerHTML = '<div class="card"><p class="stage-label">Reading the label…</p></div>';
  const [text, barcode] = await Promise.all([readText(source), readBarcode(source)]);
  showConfirm(el, profile, source, text, onNeedReference, barcode);
}

/* ---------- Confirm what was read ---------- */

function showConfirm(el, profile, source, text, onNeedReference, barcode) {
  const parsed = text ? parseTag(text) : null;
  const photo = source ? store.thumbnail(source, 500) : null;
  const stage = el.querySelector('#tg-stage');

  // A barcode already linked on this device tells us what the garment is, so
  // it prefills the same form the tag text would have.
  const linked = barcode ? catalog.entryById(store.barcodeLookup(barcode)) : null;

  const guessedBrand = linked?.brandId || parsed?.brand?.brandId || '';
  const guessedSize = parsed?.size?.size || '';
  const guessedDept = linked?.dept || parsed?.dept || profile.dept;

  stage.innerHTML = `
    <div class="card">
      <h3>Confirm the details</h3>
      ${photo ? `<img class="tag-photo" src="${photo}" alt="Captured label">` : ''}
      ${barcode ? `<p class="hint">Barcode ${esc(barcode)}${linked ? ` — recognised as ${esc(catalog.brandNameOf(linked))} ${esc(linked.name)}` : ' — not linked to a garment yet, so confirming below will remember it'}.</p>` : ''}
      ${text
        ? `<p class="hint">Read from the label: <em>${esc(text.slice(0, 160))}</em></p>`
        : `<p class="hint">${source && !barcode ? 'No text could be read from that photo.' : ''} Set the details below — it takes two taps.</p>`}
      ${parsed ? `<p class="muted">${esc(describeFindings(parsed))}</p>` : ''}
      <div class="grid2">
        <label class="field">Brand
          <select id="tg-brand">
            <option value="">Choose…</option>
            ${BRANDS.map(b => `<option value="${b.id}" ${b.id === guessedBrand ? 'selected' : ''}>${b.name}</option>`).join('')}
          </select>
        </label>
        <label class="field">Type
          <select id="tg-cat">
            ${Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('')}
          </select>
        </label>
        <label class="field">Department
          <select id="tg-dept">
            ${Object.entries(DEPTS).map(([k, v]) => `<option value="${k}" ${k === guessedDept ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
        <label class="field">Size<select id="tg-size"></select></label>
      </div>
      ${parsed?.stretch.stretchy
        ? `<p class="hint">This fabric has ${parsed.stretch.pct}% stretch fibre, so it gives more than a rigid one. We flag that rather than adjusting the numbers — we don't have data on how much extra room stretch is really worth.</p>`
        : ''}
      <button id="tg-go" class="btn btn-primary">Look up the measurements</button>
    </div>
    <div id="tg-result"></div>`;

  const brandSel = stage.querySelector('#tg-brand');
  const catSel = stage.querySelector('#tg-cat');
  const deptSel = stage.querySelector('#tg-dept');
  const sizeSel = stage.querySelector('#tg-size');

  // A waist token on the tag means this is bottoms; preselect accordingly.
  if (linked?.category) catSel.value = linked.category;
  else if (parsed?.garmentType) catSel.value = parsed.garmentType;
  else if (parsed?.size?.kind === 'waist') catSel.value = 'pants';

  const fillSizes = () => {
    const brand = BRANDS.find(b => b.id === brandSel.value);
    const chart = brand?.charts[deptSel.value]?.[CATEGORIES[catSel.value].family];
    const sizes = chart ? Object.keys(chart) : [];
    sizeSel.innerHTML = sizes.length
      ? sizes.map(s => `<option value="${s}" ${s === guessedSize ? 'selected' : ''}>${s}</option>`).join('')
      : '<option value="">Pick a brand first</option>';
  };
  brandSel.onchange = catSel.onchange = deptSel.onchange = fillSizes;
  fillSizes();

  stage.querySelector('#tg-go').onclick = () => {
    if (!brandSel.value || !sizeSel.value) {
      brandSel.focus();
      return;
    }
    resolve(stage.querySelector('#tg-result'), profile, {
      brandId: brandSel.value, dept: deptSel.value,
      category: catSel.value, size: sizeSel.value,
      photo, parsed, barcode, cut: parsed?.cut || null,
    }, onNeedReference);
  };
}

function describeFindings(parsed) {
  const found = [];
  if (parsed.brand) found.push(`brand: ${parsed.brand.name}`);
  if (parsed.size) found.push(`size: ${parsed.size.size}`);
  if (parsed.garmentType) found.push(CATEGORIES[parsed.garmentType].label.toLowerCase());
  if (parsed.cut) found.push(`${parsed.cut} cut`);
  if (parsed.price) {
    found.push(`price: ${parsed.price.currency ? `${parsed.price.currency} ` : ''}${parsed.price.amount}`);
  }
  if (parsed.fibres.length) {
    found.push(parsed.fibres.map(f => `${f.pct}% ${f.fibre.toLowerCase()}`).join(', '));
  }
  return found.length ? `Recognised — ${found.join(' · ')}. Correct anything that's wrong.` : '';
}

/* ---------- Resolve to dimensions ---------- */

function resolve(container, profile, info, onNeedReference) {
  const family = CATEGORIES[info.category].family;
  const ref = store.activeRef(profile, family);
  if (!ref) {
    container.innerHTML = `<div class="card"><p class="muted">Add a ${FAMILIES[family].label.toLowerCase()} reference garment first — the check compares against it.</p>
      <button class="btn" id="tg-addref">Add one</button></div>`;
    container.querySelector('#tg-addref').onclick = onNeedReference;
    return;
  }

  // Prefer a measured catalog entry for this exact brand/dept/category.
  const entries = catalog.allEntries().filter(e =>
    e.brandId === info.brandId && e.dept === info.dept && e.category === info.category);
  const measured = entries.find(e => e.kind === 'measured' && e.sizes?.[info.size]);
  const entry = measured || entries.find(e => catalog.sizesOf(e).includes(info.size)) || entries[0];

  if (!entry) {
    container.innerHTML = `<div class="card"><p class="muted">No sizing data for that combination yet. Measuring the garment gives an exact answer — the Measure tab handles that.</p></div>`;
    return;
  }

  // An unrecognised barcode becomes recognised the moment the user tells us
  // what it is — the dataset grows as a side effect of a normal scan.
  if (info.barcode && !store.barcodeLookup(info.barcode)) {
    store.linkBarcode(info.barcode, entry.id);
  }

  const pred = catalog.catalogPredict(profile, ref, entry, info.size, { cut: info.cut });
  if (!pred) {
    container.innerHTML = `<div class="card"><p class="muted">That size isn't in the data for this garment. Try measuring it instead.</p></div>`;
    return;
  }

  const v = verdict(pred.flat, ref, pred.secondary, store.units(), profile.preference || 'regular');
  const brandName = BRANDS.find(b => b.id === info.brandId)?.name || info.brandId;
  const fam = FAMILIES[family];

  container.innerHTML = `
    <div class="card">
      <div class="entry-head">${categoryIcon(info.category)}
        <div><strong>${esc(brandName)} ${CATEGORIES[info.category].label.toLowerCase()}, ${esc(info.size)}</strong>
        <span class="sub">${DEPTS[info.dept]} · from the tag you scanned</span></div>
      </div>
      <div class="list-item">
        <div class="grow">Dimensions pulled${measured ? ' from published measurements' : ' from the brand size chart'}
          <span class="sub">${fmt(pred.flat, store.units())} ${fam.mainShort}${pred.secondary ? ` · ${fmt(pred.secondary, store.units())} ${fam.secondaryShort}` : ''}</span></div>
        <span class="chip chip-${measured ? 'high' : 'medium'}">${measured ? 'Measured' : 'Estimate'}</span>
      </div>
      <div class="verdict verdict-${v.band}">
        <div class="verdict-head">${categoryIcon(info.category)}<div class="verdict-title">${v.title}</div></div>
        ${fitGauge(gaugeGeometry(ref, v.delta, profile.preference || 'regular'), v.band)}
        <span class="chip chip-${pred.confidence}">${pred.confidenceLabel || CONFIDENCE_LABELS[pred.confidence]}</span>
        <p>${v.detail}</p>
        <ul class="reasons">
          ${pred.reasons.filter(Boolean).map(r => `<li>${esc(r)}</li>`).join('')}
          ${info.cut ? `<li>Tag says ${esc(info.cut)} cut, so the estimate is adjusted from a regular fit</li>` : ''}
          ${info.parsed?.stretch.stretchy
            ? `<li>Label lists ${info.parsed.stretch.pct}% stretch fibre — this garment will give more than the numbers suggest</li>` : ''}
        </ul>
        ${info.parsed?.price
          ? `<p class="hint">Priced ${esc(info.parsed.price.currency || '')} ${esc(String(info.parsed.price.amount))} on the tag.</p>` : ''}
      </div>
      <div class="row">
        <button id="tg-own" class="btn">I own this — log how it fits</button>
        <button id="tg-again" class="btn">Scan another tag</button>
      </div>
      <div id="tg-own-zone"></div>
    </div>`;

  container.querySelector('#tg-again').onclick = () => {
    const host = container.closest('#ck-body') || container.parentElement;
    renderTagScan(host, profile, onNeedReference);
  };

  // Scanning the tag of something you already own is the fastest route into
  // the feedback loop, so offer it right here.
  container.querySelector('#tg-own').onclick = () => {
    const zone = container.querySelector('#tg-own-zone');
    zone.innerHTML = `
      <p class="field" style="margin:10px 0 4px">How does it fit you?</p>
      <div class="pills" id="tg-feels">
        ${[[-2, 'Too tight'], [-1, 'Snug'], [0, 'Just right'], [1, 'Loose'], [2, 'Too loose']]
          .map(([v2, l]) => `<button class="pill pill-sm" data-feel="${v2}">${l}</button>`).join('')}
      </div>`;
    zone.querySelectorAll('[data-feel]').forEach(btn => {
      btn.onclick = () => {
        store.addClosetLog(profile, {
          brandId: info.brandId, dept: info.dept,
          category: info.category, size: info.size, feel: Number(btn.dataset.feel),
        });
        zone.innerHTML = `<p class="muted">Logged — your ${esc(brandName)} predictions are tuned to this now.</p>`;
      };
    });
  };
}
