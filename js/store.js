// localStorage-backed app state. Everything is per-profile: reference
// garments, closet logs, and check history — so two people with identical
// bodies but different fit preferences diverge naturally.
//
// Reference garment shape:
//   { id, name, brandId|null, category, family, main, secondary|null,
//     photo|null (dataURL thumbnail), source: 'manual'|'photo' }
// A profile keeps one *active* reference per family (tops / bottoms).

import { CATEGORIES } from './data.js';
import { defaultUnit } from './units.js';

const KEY = 'fitcheck-v1';

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function defaultState() {
  return {
    profiles: [], activeProfileId: null,
    settings: { units: defaultUnit() },
    barcodes: {},      // barcode -> catalog entry id, contributed on this device
    userGarments: [],  // catalog entries the user added themselves
  };
}

// Upgrade any v1 (tops-only, chestFlat/length) records in place.
function migrate(s) {
  s.settings ??= { units: defaultUnit() };
  s.settings.units ??= defaultUnit();
  s.barcodes ??= {};
  s.userGarments ??= [];
  // Preference was once captured only inside the body scan, under different
  // names. It is now a profile-level setting used by every verdict.
  const RENAMED = { fitted: 'tight', roomy: 'baggy' };
  for (const p of s.profiles) {
    p.preference = RENAMED[p.preference] ?? p.preference
      ?? RENAMED[p.body?.preference] ?? p.body?.preference ?? 'regular';
    if (p.body?.preference) p.body.preference = RENAMED[p.body.preference] ?? p.body.preference;
    if (!p.activeRefs) {
      p.activeRefs = { tops: p.activeRefId || null, bottoms: null };
      delete p.activeRefId;
    }
    for (const r of p.refs) {
      if (!r.family) {
        r.family = 'tops';
        if (!r.category || r.category === 'tops') r.category = 'tshirt';
        r.main = r.chestFlat;
        r.secondary = r.length ?? null;
        r.brandId = r.brandId ?? null;
        r.photo = r.photo ?? null;
        delete r.chestFlat;
        delete r.length;
      }
    }
    for (const l of p.closet) if (!l.category) l.category = 'tshirt';
  }
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { /* corrupted state falls through to default */ }
  return defaultState();
}

export const state = load();

// Set by the UI so a failed write becomes visible instead of silently
// dropping data the user spent real effort creating.
let saveErrorHandler = null;

export function onSaveError(fn) {
  saveErrorHandler = fn;
}

// Anything that wants to know the data changed — the sync scheduler, mainly.
const changeListeners = new Set();

export function onChanged(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

// Merging two devices needs to know which copy of a record is newer, and
// which records were deliberately deleted rather than simply absent. Without
// stamps a merge cannot tell an edit from a stale copy; without tombstones a
// deletion on one device is undone by the other.
export function touch(record) {
  if (record) record.updatedAt = Date.now();
  return record;
}

export function tombstone(container, id) {
  container.deleted = container.deleted || {};
  container.deleted[id] = Date.now();
}

export function save() {
  try {
    state.updatedAt = Date.now();
    localStorage.setItem(KEY, JSON.stringify(state));
    changeListeners.forEach(fn => fn());
    return true;
  } catch (e) {
    const quota = e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED';
    saveErrorHandler?.(quota
      ? 'Storage is full — this device has run out of room. Export a backup, then remove some garment photos to free space.'
      : `Could not save (${e.name || 'error'}). Your last change may not persist.`);
    return false;
  }
}

export function activeProfile() {
  return state.profiles.find(p => p.id === state.activeProfileId) || state.profiles[0] || null;
}

export function addProfile(name, dept, preference = 'regular') {
  const p = {
    id: uid(), name, dept, preference,
    refs: [], activeRefs: { tops: null, bottoms: null },
    closet: [], history: [],
  };
  touch(p);
  state.profiles.push(p);
  state.activeProfileId = p.id;
  save();
  return p;
}

// The reference garment used for comparisons in a given family.
export function activeRef(profile, family) {
  return profile.refs.find(r => r.id === profile.activeRefs[family])
    || profile.refs.find(r => r.family === family)
    || null;
}

export function addRef(profile, ref) {
  ref.id = uid();
  ref.family = CATEGORIES[ref.category].family;
  touch(ref);
  touch(profile);
  profile.refs.push(ref);
  if (!profile.activeRefs[ref.family]) profile.activeRefs[ref.family] = ref.id;
  save();
  return ref;
}

export function removeRef(profile, id) {
  const ref = profile.refs.find(r => r.id === id);
  tombstone(profile, id);
  touch(profile);
  profile.refs = profile.refs.filter(r => r.id !== id);
  if (ref && profile.activeRefs[ref.family] === id) {
    profile.activeRefs[ref.family] = profile.refs.find(r => r.family === ref.family)?.id || null;
  }
  save();
}

export function addClosetLog(profile, log) {
  log.id = uid();
  log.date = new Date().toISOString().slice(0, 10);
  touch(log);
  profile.closet.unshift(log);
  save();
  return log;
}

export function addHistory(profile, entry) {
  entry.id = uid();
  entry.date = new Date().toISOString().slice(0, 10);
  entry.outcome = null;
  touch(entry);
  profile.history.unshift(entry);
  if (profile.history.length > 50) profile.history.length = 50;
  save();
}

// Which way a verdict leaned, so it can be compared against what happened.
function bandDirection(band) {
  if (band === 'tight1' || band === 'tight2') return -1;
  if (band === 'loose1' || band === 'loose2') return 1;
  return 0;
}

// The heart of the feedback loop. An outcome is recorded against the check,
// and — when the check carried enough context — also becomes a closet log, so
// the same per-brand offset engine that learns from owned garments starts
// learning from purchases too. No separate model, no new maths.
export function recordOutcome(profile, historyId, feel) {
  const entry = profile.history.find(h => h.id === historyId);
  if (!entry) return null;

  entry.outcome = feel;
  entry.outcomeDate = new Date().toISOString().slice(0, 10);

  let log = null;
  if (entry.brandId && entry.size && entry.dept && entry.category) {
    log = addClosetLog(profile, {
      brandId: entry.brandId, dept: entry.dept,
      category: entry.category, size: entry.size,
      feel, fromCheck: entry.id,
    });
  }
  save();
  return { entry, log };
}

// Honest self-scoring: did the verdict point the same way the garment did?
export function accuracy(profile) {
  const judged = profile.history.filter(h => h.outcome != null && h.band);
  if (!judged.length) return null;
  const correct = judged.filter(h => bandDirection(h.band) === Math.sign(h.outcome)).length;
  return { correct, total: judged.length, pct: Math.round((correct / judged.length) * 100) };
}

export function units() {
  return state.settings.units;
}

export function setUnits(u) {
  state.settings.units = u;
  save();
}

// Link a scanned barcode to a catalog entry. This is how the barcode dataset
// bootstraps — from users, not from a paid lookup API.
export function linkBarcode(barcode, garmentId) {
  state.barcodes[barcode] = garmentId;
  save();
}

export function barcodeLookup(barcode) {
  return state.barcodes[barcode] || null;
}

// A garment the user measured themselves. These are real dimensions off a
// real garment, so they count as measured — the distinction from a brand's
// published spec is who took the tape to it, not how trustworthy it is.
export function addUserGarment({ brandId, name, dept, category, size, main, secondary }) {
  const existing = state.userGarments.find(g =>
    g.brandId === brandId && g.dept === dept && g.category === category
    && g.name.toLowerCase() === name.toLowerCase());

  if (existing) {
    // Same product, another size — extend it rather than making a duplicate.
    existing.sizes[size] = { main, secondary: secondary ?? null };
    touch(existing);
    save();
    return existing;
  }

  const entry = {
    id: 'user-' + uid(),
    brandId, name, dept, category,
    kind: 'measured',
    source: 'user',
    sourceNote: 'You measured this garment yourself',
    sizes: { [size]: { main, secondary: secondary ?? null } },
    added: new Date().toISOString().slice(0, 10),
  };
  touch(entry);
  state.userGarments.push(entry);
  save();
  return entry;
}

export function removeUserGarment(id) {
  tombstone(state, id);
  state.userGarments = state.userGarments.filter(g => g.id !== id);
  save();
}

export function removeUserGarmentSize(id, size) {
  const g = state.userGarments.find(x => x.id === id);
  if (!g) return;
  delete g.sizes[size];
  if (!Object.keys(g.sizes).length) removeUserGarment(id);
  else save();
}

// Calibration lives under its own key so the workbench can never corrupt app
// data, but a backup that silently omitted it would lose the measurements the
// bands are meant to be derived from — especially when they were recorded on a
// phone in a shop and the analysis happens elsewhere.
const CALIBRATION_KEY = 'fitcheck-calibration-v1';

function readCalibration() {
  try {
    return JSON.parse(localStorage.getItem(CALIBRATION_KEY)) || [];
  } catch (e) {
    return [];
  }
}

export function exportJson() {
  return JSON.stringify({
    app: 'fit-check',
    version: 2,
    exported: new Date().toISOString(),
    state,
    calibration: readCalibration(),
  }, null, 2);
}

// Replace everything from a previously exported file. Validated rather than
// trusted, since a bad import would wipe measurements the user can't recover.
export function importJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'That file isn’t valid JSON.' };
  }
  const incoming = parsed?.state ?? parsed;
  if (!incoming || !Array.isArray(incoming.profiles)) {
    return { ok: false, error: 'That doesn’t look like a Fit Check backup.' };
  }
  const migrated = migrate({
    profiles: incoming.profiles,
    activeProfileId: incoming.activeProfileId ?? incoming.profiles[0]?.id ?? null,
    settings: incoming.settings,
    barcodes: incoming.barcodes,
    userGarments: incoming.userGarments,
  });
  Object.assign(state, migrated);
  save();

  // Older backups (version 1) carry no calibration; leave whatever is already
  // on this device alone rather than wiping it.
  let calibration = 0;
  if (Array.isArray(parsed?.calibration)) {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(parsed.calibration));
    calibration = parsed.calibration.length;
  }
  return { ok: true, profiles: migrated.profiles.length, calibration };
}

// Downscale an image (or canvas/video frame) to a small JPEG dataURL thumbnail.
export function thumbnail(source, maxDim = 400) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}
