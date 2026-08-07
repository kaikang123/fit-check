// Photo measurement tool. The user shoots the garment laid flat — with the
// live camera or an existing photo — with a known-size reference object in
// frame, taps two points on the reference to set scale, then taps the
// garment's key dimensions (chest/length for tops, waist/inseam for bottoms).

import { BRANDS, CATEGORIES, FAMILIES, DEPTS } from './data.js';
import {
  activeProfile, activeRef, addRef, addHistory, thumbnail, units, addUserGarment,
} from './store.js';
import { verdict, CONFIDENCE_LABELS, applyReferenceConfidence, gaugeGeometry } from './engine.js';
import { ICONS, categoryIcon, fitGauge } from './icons.js';
import { fmt } from './units.js';
import { cameraMessage } from './env.js';

const REF_OBJECTS = {
  card:    { label: 'Credit / bank card — long edge', mm: 85.6 },
  a4long:  { label: 'A4 paper — long edge',           mm: 297 },
  a4short: { label: 'A4 paper — short edge',          mm: 210 },
  letter:  { label: 'US Letter paper — long edge',    mm: 279.4 },
};

const STAGE_COLORS = { scale: '#f59e0b', main: '#3b82f6', secondary: '#22c55e' };

const STAGE_LABELS = {
  scale: 'Tap the two ends of your reference object',
  main: {
    tops:    'Tap armpit to armpit (chest width)',
    bottoms: 'Tap across the top of the waistband (waist width)',
  },
  secondary: {
    tops:    'Tap collar to hem (length) — or skip',
    bottoms: 'Tap crotch seam to leg hem (inseam) — or skip',
  },
};

let session = null;
let stream = null;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

export function renderMeasure(el) {
  stopCamera();
  el.innerHTML = `
    <div class="card">
      <h2>Measure a garment</h2>
      <p class="muted">Lay it flat, place a reference object on it, and shoot from directly above. Angled shots distort the scale.</p>
      <div class="grid2">
        <label class="field">Garment type
          <select id="m-cat">
            ${Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('')}
          </select>
        </label>
        <label class="field">Reference object
          <select id="m-ref">
            ${Object.entries(REF_OBJECTS).map(([k, r]) => `<option value="${k}">${r.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="row">
        <button id="m-camera" class="btn btn-primary">${ICONS.camera} Use camera</button>
        <label class="btn file-btn">Choose photo
          <input type="file" id="m-file" accept="image/*" hidden>
        </label>
      </div>
      <p id="m-error" class="muted" style="color:var(--red)" hidden></p>
    </div>
    <div id="m-cam-panel" class="card" hidden>
      <p class="stage-label">Line up the garment, then capture</p>
      <video id="m-video" autoplay playsinline muted></video>
      <div class="row">
        <button id="m-capture" class="btn btn-primary">Capture photo</button>
        <button id="m-cam-cancel" class="btn">Cancel</button>
      </div>
    </div>
    <div id="m-work" hidden>
      <div class="card">
        <p id="m-stage" class="stage-label"></p>
        <canvas id="m-canvas"></canvas>
        <div class="row">
          <button id="m-undo" class="btn">Undo point</button>
          <button id="m-skip" class="btn" hidden>Skip</button>
          <button id="m-restart" class="btn">Restart</button>
        </div>
      </div>
      <div id="m-results"></div>
    </div>`;

  el.querySelector('#m-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => startSession(el, img);
    img.src = URL.createObjectURL(file);
  });

  el.querySelector('#m-camera').addEventListener('click', () => startCamera(el));
}

async function startCamera(el) {
  const errEl = el.querySelector('#m-error');
  errEl.hidden = true;
  const blocked = cameraMessage();
  if (blocked) {
    errEl.textContent = blocked;
    errEl.hidden = false;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    errEl.textContent = `Could not open the camera (${e.name || 'error'}). Check permissions, or use "Choose photo" instead.`;
    errEl.hidden = false;
    return;
  }
  const panel = el.querySelector('#m-cam-panel');
  const video = el.querySelector('#m-video');
  panel.hidden = false;
  el.querySelector('#m-work').hidden = true;
  video.srcObject = stream;

  el.querySelector('#m-capture').onclick = () => {
    if (!video.videoWidth) return;
    const frame = document.createElement('canvas');
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    frame.getContext('2d').drawImage(video, 0, 0);
    stopCamera();
    panel.hidden = true;
    startSession(el, frame);
  };
  el.querySelector('#m-cam-cancel').onclick = () => {
    stopCamera();
    panel.hidden = true;
  };
}

// `img` is an Image or a canvas holding a captured camera frame.
function startSession(el, img) {
  const category = el.querySelector('#m-cat').value;
  session = {
    img, category,
    family: CATEGORIES[category].family,
    stage: 'scale',
    points: { scale: [], main: [], secondary: [] },
    refKey: el.querySelector('#m-ref').value,
  };
  const work = el.querySelector('#m-work');
  work.hidden = false;
  const canvas = el.querySelector('#m-canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;

  canvas.onclick = e => {
    if (!session || session.stage === 'done') return;
    const scale = canvas.width / canvas.clientWidth;
    session.points[session.stage].push({ x: e.offsetX * scale, y: e.offsetY * scale });
    if (session.points[session.stage].length === 2) {
      session.stage = session.stage === 'scale' ? 'main' : session.stage === 'main' ? 'secondary' : 'done';
    }
    update(el);
  };
  el.querySelector('#m-undo').onclick = () => {
    const order = ['scale', 'main', 'secondary'];
    for (let i = order.length - 1; i >= 0; i--) {
      if (session.points[order[i]].length) {
        session.points[order[i]].pop();
        session.stage = order[i];
        break;
      }
    }
    update(el);
  };
  el.querySelector('#m-skip').onclick = () => {
    session.points.secondary = [];
    session.stage = 'done';
    update(el);
  };
  el.querySelector('#m-restart').onclick = () => startSession(el, img);
  update(el);
}

function stageLabel(stage) {
  if (stage === 'done') return 'Done — results below';
  const l = STAGE_LABELS[stage];
  return typeof l === 'string' ? l : l[session.family];
}

function update(el) {
  const canvas = el.querySelector('#m-canvas');
  const ctx = canvas.getContext('2d');
  ctx.drawImage(session.img, 0, 0);

  const lw = Math.max(2, canvas.width / 300);
  for (const [stage, pts] of Object.entries(session.points)) {
    ctx.strokeStyle = ctx.fillStyle = STAGE_COLORS[stage];
    ctx.lineWidth = lw;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, lw * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (pts.length === 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
    }
  }

  const stageEl = el.querySelector('#m-stage');
  stageEl.textContent = stageLabel(session.stage);
  stageEl.style.color = STAGE_COLORS[session.stage] || 'var(--text)';
  el.querySelector('#m-skip').hidden = session.stage !== 'secondary';
  el.querySelector('#m-results').innerHTML = session.stage === 'done' ? resultsHtml() : '';
  if (session.stage === 'done') wireResults(el);
}

function computed() {
  const refMm = REF_OBJECTS[session.refKey].mm;
  const pxPerMm = dist(...session.points.scale) / refMm;
  const main = dist(...session.points.main) / pxPerMm / 10;
  const secondary = session.points.secondary.length === 2
    ? dist(...session.points.secondary) / pxPerMm / 10 : null;
  return {
    main: Math.round(main * 10) / 10,
    secondary: secondary && Math.round(secondary * 10) / 10,
  };
}

function resultsHtml() {
  const { main, secondary } = computed();
  const fam = FAMILIES[session.family];
  const cat = CATEGORIES[session.category];
  return `
    <div class="card">
      <h3>${categoryIcon(session.category)} Measured ${cat.label.toLowerCase()}</h3>
      <p><strong>${fmt(main, units())}</strong> ${fam.mainShort}${secondary ? ` &middot; <strong>${fmt(secondary, units())}</strong> ${fam.secondaryShort}` : ''}</p>
      <div class="row">
        <button id="m-check" class="btn btn-primary">Check fit vs my reference</button>
        <button id="m-saveref" class="btn">Save as reference garment</button>
        <button id="m-savecat" class="btn">Add to catalog</button>
      </div>
      <div id="m-savecat-form" hidden>
        <p class="hint">Real measurements are the scarcest thing this app has. Saving this
          makes every future check of the same product accurate instead of estimated.</p>
        <label class="field">Product name
          <input id="m-cat-name" type="text" placeholder="e.g. Heavy Cotton Tee">
        </label>
        <div class="grid2">
          <label class="field">Brand
            <select id="m-cat-brand">${BRANDS.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}</select>
          </label>
          <label class="field">Department
            <select id="m-cat-dept">${Object.entries(DEPTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          </label>
        </div>
        <label class="field">Which labelled size is this?<select id="m-cat-size"></select></label>
        <button id="m-savecat-go" class="btn btn-primary">Save to catalog</button>
      </div>
      <div id="m-saveref-form" hidden>
        <label class="field">Name this garment
          <input id="m-refname" type="text" placeholder="e.g. Grey tee that fits perfectly">
        </label>
        <label class="field">Brand
          <select id="m-refbrand">
            <option value="">Other / unknown</option>
            ${BRANDS.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
          </select>
        </label>
        <button id="m-saveref-go" class="btn btn-primary">Save</button>
      </div>
      <div id="m-verdict"></div>
    </div>`;
}

function wireResults(el) {
  const { main, secondary } = computed();
  const profile = activeProfile();
  const cat = CATEGORIES[session.category];

  el.querySelector('#m-check').onclick = () => {
    const ref = activeRef(profile, session.family);
    if (!ref) {
      el.querySelector('#m-verdict').innerHTML =
        `<p class="muted">No ${FAMILIES[session.family].label.toLowerCase()} reference garment yet — save this one as your reference, or add one in the Profile tab.</p>`;
      return;
    }
    const v = verdict(main, ref, secondary, units(), profile.preference || 'regular');
    const pred = applyReferenceConfidence({
      confidence: 'high',
      confidenceLabel: 'High confidence — measured from your photo',
      reasons: ['Measured directly from the garment photo — no size-chart guessing involved'],
    }, ref);
    el.querySelector('#m-verdict').innerHTML = `
      <div class="verdict verdict-${v.band}">
        <div class="verdict-title">${v.title}</div>
        ${fitGauge(gaugeGeometry(ref, v.delta, profile.preference || 'regular'), v.band)}
        <span class="chip chip-${pred.confidence}">${pred.confidenceLabel || CONFIDENCE_LABELS[pred.confidence]}</span>
        <p>${v.detail}</p>
        <ul class="reasons">${pred.reasons.map(r => `<li>${r}</li>`).join('')}</ul>
      </div>`;
    addHistory(profile, {
      kind: 'photo', category: session.category,
      label: `Photo-measured ${cat.label.toLowerCase()}`,
      verdictTitle: v.title, band: v.band, confidence: pred.confidence,
    });
  };

  el.querySelector('#m-saveref').onclick = () => {
    el.querySelector('#m-saveref-form').hidden = false;
  };

  // Turning a measurement into a catalog entry is how the dataset actually
  // grows — the brief's whole thesis is that this data is the moat.
  const catForm = el.querySelector('#m-savecat-form');
  const catBrand = el.querySelector('#m-cat-brand');
  const catDept = el.querySelector('#m-cat-dept');
  const catSize = el.querySelector('#m-cat-size');
  const fillCatSizes = () => {
    const brand = BRANDS.find(b => b.id === catBrand.value);
    const chart = brand?.charts[catDept.value]?.[session.family];
    catSize.innerHTML = chart
      ? Object.keys(chart).map(s => `<option value="${s}">${s}</option>`).join('')
      : '<option value="">—</option>';
  };
  catBrand.onchange = catDept.onchange = fillCatSizes;
  fillCatSizes();

  el.querySelector('#m-savecat').onclick = () => { catForm.hidden = false; };
  el.querySelector('#m-savecat-go').onclick = () => {
    const name = el.querySelector('#m-cat-name').value.trim();
    if (!name) return el.querySelector('#m-cat-name').focus();
    if (!catSize.value) return;
    const saved = addUserGarment({
      brandId: catBrand.value, name, dept: catDept.value,
      category: session.category, size: catSize.value,
      main, secondary,
    });
    const count = Object.keys(saved.sizes).length;
    catForm.innerHTML = `<p class="muted">Saved. “${esc(name)}” now has ${count} measured size${count === 1 ? '' : 's'}
      in your catalog, and searches will find it.</p>`;
  };
  el.querySelector('#m-saveref-go').onclick = () => {
    addRef(profile, {
      name: el.querySelector('#m-refname').value.trim() || `Photo-measured ${cat.label.toLowerCase()}`,
      brandId: el.querySelector('#m-refbrand').value || null,
      category: session.category,
      main, secondary,
      photo: thumbnail(session.img),
      source: 'photo',
    });
    el.querySelector('#m-saveref-form').innerHTML =
      `<p class="muted">Saved. Manage reference garments in the Profile tab.</p>`;
  };
}
