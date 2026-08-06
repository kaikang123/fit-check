// Body scan flow.
//
// MTailor-style capture: put the phone down, step back, turn once. Frames are
// grabbed during the turn and the user picks the front-facing and side-facing
// ones. Their height calibrates pixels to centimetres, then they mark chest
// and waist on each frame.
//
// This is deliberately not a neural point-cloud reconstruction — that needs a
// trained model and a backend. The geometry here is visible and checkable, and
// everything it produces is labelled preliminary.

import { CATEGORIES, FIT_PREFERENCES } from './data.js';
import * as store from './store.js';
import { UNITS, toCm, fmt } from './units.js';
import { scaleFrom, spanCm, circumferenceAt, derivedFlat } from './bodymath.js';
import { cameraMessage } from './env.js';

const FRAME_COUNT = 12;
const FRAME_INTERVAL = 700;

// Marking steps per view. `pair` points are measured against each other.
const FRONT_STEPS = [
  { key: 'head',  label: 'Tap the top of your head', color: '#f59e0b' },
  { key: 'floor', label: 'Tap the floor at your feet', color: '#f59e0b' },
  { key: 'chest', label: 'Tap your left and right side, level with your chest', color: '#3b82f6', pair: true },
  { key: 'waist', label: 'Tap your left and right side, level with your waist', color: '#22c55e', pair: true },
];

const SIDE_STEPS = [
  { key: 'head',  label: 'Tap the top of your head', color: '#f59e0b' },
  { key: 'floor', label: 'Tap the floor at your feet', color: '#f59e0b' },
  { key: 'chest', label: 'Tap your chest and your back, at chest level', color: '#3b82f6', pair: true },
  { key: 'waist', label: 'Tap your stomach and your back, at waist level', color: '#22c55e', pair: true },
];

let session = null;
let stream = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

export function teardownBodyScan() {
  stopCamera();
  if (session?.countdownTimer) clearInterval(session.countdownTimer);
  if (session?.captureTimer) clearInterval(session.captureTimer);
}

/* ---------- Entry ---------- */

export function renderBodyScan(el, profile, onDone) {
  teardownBodyScan();
  const unit = store.units();
  session = { frames: [], profile, onDone, marks: { front: {}, side: {} }, step: { front: 0, side: 0 } };

  el.innerHTML = `
    <div class="card">
      <h2>Body scan</h2>
      <p class="muted">Prop your phone up, step back so your whole body is in frame, and turn all the way around once. We keep a few frames from the turn — you'll pick the one facing the camera and the one side-on.</p>
      <p class="hint">Wear fitted clothing and stand against a plain wall if you can. Your height is what converts pixels into centimetres, so it needs to be right.</p>
      <div class="grid2">
        <label class="field">Your height (${UNITS[unit].short})
          <input id="bs-height" type="number" step="${UNITS[unit].step}" inputmode="decimal"
                 min="${unit === 'cm' ? 120 : 47}" max="${unit === 'cm' ? 220 : 87}">
        </label>
        <label class="field">How do you like clothes to fit?
          <select id="bs-pref">
            ${Object.entries(FIT_PREFERENCES).map(([k, v]) =>
              `<option value="${k}" ${k === (profile.preference || 'regular') ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="row">
        <button id="bs-start" class="btn btn-primary">Start the turn</button>
        <button id="bs-cancel" class="btn">Cancel</button>
      </div>
      <p id="bs-error" class="hint" style="color:var(--red)" hidden></p>
    </div>
    <div id="bs-stage"></div>`;

  el.querySelector('#bs-cancel').onclick = () => onDone(null);
  el.querySelector('#bs-start').onclick = () => {
    const h = parseFloat(el.querySelector('#bs-height').value);
    if (!h) return el.querySelector('#bs-height').focus();
    session.heightCm = toCm(h, store.units());
    session.preference = el.querySelector('#bs-pref').value;
    startCapture(el);
  };
}

/* ---------- Capture ---------- */

async function startCapture(el) {
  const errEl = el.querySelector('#bs-error');
  errEl.hidden = true;
  const blocked = cameraMessage();
  if (blocked) {
    errEl.textContent = blocked;
    errEl.hidden = false;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
    });
  } catch (e) {
    errEl.textContent = `Could not open the camera (${e.name || 'error'}). Check permissions, or enter measurements by hand in the Profile tab.`;
    errEl.hidden = false;
    return;
  }

  const stage = el.querySelector('#bs-stage');
  stage.innerHTML = `
    <div class="card">
      <p class="stage-label" id="bs-count">Starting in 5…</p>
      <video id="bs-video" autoplay playsinline muted></video>
      <p class="hint">Keep turning steadily until the counter finishes.</p>
      <button id="bs-abort" class="btn">Stop</button>
    </div>`;

  const video = stage.querySelector('#bs-video');
  video.srcObject = stream;
  stage.querySelector('#bs-abort').onclick = () => {
    teardownBodyScan();
    stage.innerHTML = '';
  };

  let lead = 5;
  const countEl = stage.querySelector('#bs-count');
  session.countdownTimer = setInterval(() => {
    lead -= 1;
    if (lead > 0) {
      countEl.textContent = `Starting in ${lead}…`;
      return;
    }
    clearInterval(session.countdownTimer);
    session.countdownTimer = null;
    grabFrames(el, video, countEl);
  }, 1000);
}

function grabFrames(el, video, countEl) {
  session.frames = [];
  session.captureTimer = setInterval(() => {
    if (video.videoWidth) {
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      session.frames.push(c);
    }
    countEl.textContent = `Turning… ${session.frames.length} / ${FRAME_COUNT}`;
    if (session.frames.length >= FRAME_COUNT) {
      clearInterval(session.captureTimer);
      session.captureTimer = null;
      stopCamera();
      pickFrames(el);
    }
  }, FRAME_INTERVAL);
}

/* ---------- Frame selection ---------- */

function pickFrames(el) {
  const stage = el.querySelector('#bs-stage');
  session.picking = 'front';
  const paint = () => {
    stage.innerHTML = `
      <div class="card">
        <p class="stage-label">${session.picking === 'front'
          ? 'Pick the frame where you face the camera'
          : 'Now pick the frame where you are side-on'}</p>
        <div class="filmstrip">
          ${session.frames.map((f, i) =>
            `<img class="film ${session.frontIndex === i ? 'film-picked' : ''}" src="${f.toDataURL('image/jpeg', 0.6)}" data-i="${i}" alt="Frame ${i + 1}">`).join('')}
        </div>
        ${session.picking === 'side'
          ? '<button id="bs-noside" class="btn">Skip the side view</button><p class="hint">Without it we assume a typical torso depth, and the result is flagged lower confidence.</p>'
          : ''}
      </div>`;

    stage.querySelectorAll('.film').forEach(img => {
      img.onclick = () => {
        const i = Number(img.dataset.i);
        if (session.picking === 'front') {
          session.frontIndex = i;
          session.picking = 'side';
          paint();
        } else {
          session.sideIndex = i;
          markView(el, 'front');
        }
      };
    });
    stage.querySelector('#bs-noside')?.addEventListener('click', () => {
      session.sideIndex = null;
      markView(el, 'front');
    });
  };
  paint();
}

/* ---------- Landmark marking ---------- */

function stepsFor(view) {
  return view === 'front' ? FRONT_STEPS : SIDE_STEPS;
}

function markView(el, view) {
  const frame = view === 'front' ? session.frames[session.frontIndex] : session.frames[session.sideIndex];
  const stage = el.querySelector('#bs-stage');
  session.marks[view] = {};
  session.step[view] = 0;

  stage.innerHTML = `
    <div class="card">
      <p class="stage-label" id="bs-mark-label"></p>
      <canvas id="bs-canvas"></canvas>
      <div class="row">
        <button id="bs-undo" class="btn">Undo</button>
        <button id="bs-remark" class="btn">Start this view again</button>
      </div>
    </div>`;

  const canvas = stage.querySelector('#bs-canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;

  const steps = stepsFor(view);
  const draw = () => {
    const ctx = canvas.getContext('2d');
    ctx.drawImage(frame, 0, 0);
    const lw = Math.max(2, canvas.width / 320);
    for (const step of steps) {
      const pts = session.marks[view][step.key];
      if (!pts?.length) continue;
      ctx.strokeStyle = ctx.fillStyle = step.color;
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
    const step = steps[session.step[view]];
    const label = stage.querySelector('#bs-mark-label');
    if (step) {
      label.textContent = `${view === 'front' ? 'Front view' : 'Side view'}: ${step.label}`;
      label.style.color = step.color;
    }
  };

  canvas.onclick = e => {
    const step = steps[session.step[view]];
    if (!step) return;
    const scale = canvas.width / canvas.clientWidth;
    const pt = { x: e.offsetX * scale, y: e.offsetY * scale };
    const bucket = session.marks[view][step.key] ||= [];
    bucket.push(pt);
    const needed = step.pair ? 2 : 1;
    if (bucket.length >= needed) session.step[view] += 1;
    draw();
    if (session.step[view] >= steps.length) finishView(el, view);
  };

  stage.querySelector('#bs-undo').onclick = () => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const bucket = session.marks[view][steps[i].key];
      if (bucket?.length) {
        bucket.pop();
        session.step[view] = i;
        break;
      }
    }
    draw();
  };
  stage.querySelector('#bs-remark').onclick = () => markView(el, view);

  draw();
}

function finishView(el, view) {
  if (view === 'front' && session.sideIndex != null) {
    markView(el, 'side');
    return;
  }
  showResults(el);
}

/* ---------- Results ---------- */

function measure() {
  const front = session.marks.front;
  const frontScale = scaleFrom(front.head[0], front.floor[0], session.heightCm);
  const chestWidth = spanCm(front.chest[0], front.chest[1], frontScale);
  const waistWidth = spanCm(front.waist[0], front.waist[1], frontScale);

  let chestDepth = null;
  let waistDepth = null;
  if (session.sideIndex != null) {
    const side = session.marks.side;
    const sideScale = scaleFrom(side.head[0], side.floor[0], session.heightCm);
    chestDepth = spanCm(side.chest[0], side.chest[1], sideScale);
    waistDepth = spanCm(side.waist[0], side.waist[1], sideScale);
  }

  const chest = circumferenceAt('chest', chestWidth, chestDepth);
  const waist = circumferenceAt('waist', waistWidth, waistDepth);
  return {
    chest: chest.circumference, waist: waist.circumference,
    chestWidth, waistWidth,
    chestDepth: chest.depth, waistDepth: waist.depth,
    estimatedDepth: chest.estimatedDepth,
  };
}

function showResults(el) {
  const m = measure();
  const unit = store.units();
  const stage = el.querySelector('#bs-stage');

  stage.innerHTML = `
    <div class="card">
      <h3>Preliminary measurements</h3>
      <span class="chip chip-low">Preliminary — refine as you go</span>
      <div class="list-item"><div class="grow">Chest<span class="sub">${fmt(m.chestWidth, unit)} across · ${fmt(m.chestDepth, unit)} deep${m.estimatedDepth ? ' (assumed)' : ''}</span></div>
        <strong>${fmt(m.chest, unit)}</strong></div>
      <div class="list-item"><div class="grow">Waist<span class="sub">${fmt(m.waistWidth, unit)} across · ${fmt(m.waistDepth, unit)} deep${m.estimatedDepth ? ' (assumed)' : ''}</span></div>
        <strong>${fmt(m.waist, unit)}</strong></div>
      <p class="hint">These are circumferences around your body, worked out from the width and depth you marked. Phone-based scanning typically lands within a few centimetres of a tape measure${m.estimatedDepth ? ', and skipping the side view widens that further' : ''} — so Fit Check treats them as a starting point, not the last word.</p>

      <h3>Adjust by hand</h3>
      <p class="hint">If you know a real number, type it in — a tape measure beats the scan every time.</p>
      <div class="grid2">
        <label class="field">Chest around (${UNITS[unit].short})
          <input id="bs-chest" type="number" step="${UNITS[unit].step}" value="${fmt(m.chest, unit, { bare: true })}" inputmode="decimal"></label>
        <label class="field">Waist around (${UNITS[unit].short})
          <input id="bs-waist" type="number" step="${UNITS[unit].step}" value="${fmt(m.waist, unit, { bare: true })}" inputmode="decimal"></label>
      </div>
      <button id="bs-save" class="btn btn-primary">Save and build my starting profile</button>
    </div>`;

  stage.querySelector('#bs-save').onclick = () => {
    const chest = toCm(parseFloat(stage.querySelector('#bs-chest').value) || 0, unit);
    const waist = toCm(parseFloat(stage.querySelector('#bs-waist').value) || 0, unit);
    if (!chest || !waist) return;
    saveScan(session.profile, {
      chest, waist, heightCm: session.heightCm,
      preference: session.preference,
      estimatedDepth: m.estimatedDepth,
    });
    const done = session.onDone;
    teardownBodyScan();
    session = null;
    done('saved');
  };
}

/* ---------- Persisting ---------- */

// Store the body profile and derive a preliminary reference garment for each
// family. These are ordinary references flagged `derived`, so every later
// refinement path — closet logs, photo measurement, replacing them outright —
// works on them unchanged.
export function saveScan(profile, body) {
  profile.body = { ...body, date: new Date().toISOString().slice(0, 10) };
  // The scan's preference answer is the profile's preference — one setting.
  if (body.preference) profile.preference = body.preference;

  const pref = FIT_PREFERENCES[body.preference] || FIT_PREFERENCES.regular;
  const specs = [
    { category: 'tshirt', circumference: body.chest, name: 'Preliminary top (from body scan)' },
    { category: 'pants', circumference: body.waist, name: 'Preliminary bottoms (from body scan)' },
  ];

  for (const spec of specs) {
    const family = CATEGORIES[spec.category].family;
    // Replace a previous scan-derived reference rather than piling them up.
    for (const old of profile.refs.filter(r => r.derived && r.family === family)) {
      store.removeRef(profile, old.id);
    }
    store.addRef(profile, {
      name: spec.name,
      brandId: null,
      category: spec.category,
      main: derivedFlat(spec.circumference, CATEGORIES[spec.category].ease, pref.ease),
      secondary: null,
      photo: null,
      source: 'scan',
      derived: true,
    });
  }
  store.save();
}
