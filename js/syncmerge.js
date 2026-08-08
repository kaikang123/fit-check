// Merging two devices' data.
//
// The naive approach — whichever device synced last wins — quietly destroys
// work. Log five garments in a shop on your phone, then sync a laptop that
// was edited an hour earlier, and the five are gone.
//
// So collections merge by record id instead. Almost everything in this app is
// append-mostly (closet logs, check history, calibration samples, measured
// garments), and appends from two devices combine cleanly. Only genuinely
// scalar things — a name, a fit preference, which reference is active — need
// a winner, and those use last-write-wins on an explicit timestamp.
//
// Deletions carry tombstones. Without them a record deleted on the phone
// simply reappears from the laptop's copy, which looks like the app undoing
// the user's work.

// Collections keyed by `id`, merged by union.
const RECORD_SETS = ['refs', 'closet', 'history'];

export function nowStamp() {
  return Date.now();
}

function byId(list) {
  const map = new Map();
  for (const item of list || []) map.set(item.id, item);
  return map;
}

// Merge two lists of {id, ...} records, preferring the more recently touched
// copy of any record present on both sides, and honouring tombstones.
export function mergeRecords(mine, theirs, tombstones = {}) {
  const out = byId(mine);
  for (const item of theirs || []) {
    const existing = out.get(item.id);
    if (!existing) {
      out.set(item.id, item);
      continue;
    }
    // Same record on both sides: keep whichever was edited later. Records
    // without a stamp are treated as older, so an explicitly-touched edit wins.
    const a = existing.updatedAt || 0;
    const b = item.updatedAt || 0;
    if (b > a) out.set(item.id, item);
  }
  for (const id of Object.keys(tombstones)) out.delete(id);
  return [...out.values()];
}

// Last-write-wins for a scalar field.
function pickScalar(mine, theirs, myStamp, theirStamp) {
  if (theirs === undefined) return mine;
  if (mine === undefined) return theirs;
  return theirStamp > myStamp ? theirs : mine;
}

function mergeProfile(mine, theirs) {
  const myStamp = mine.updatedAt || 0;
  const theirStamp = theirs.updatedAt || 0;
  const tombstones = { ...(mine.deleted || {}), ...(theirs.deleted || {}) };

  const merged = {
    ...mine,
    // Scalars: one of them has to win.
    name: pickScalar(mine.name, theirs.name, myStamp, theirStamp),
    dept: pickScalar(mine.dept, theirs.dept, myStamp, theirStamp),
    preference: pickScalar(mine.preference, theirs.preference, myStamp, theirStamp),
    body: pickScalar(mine.body, theirs.body, myStamp, theirStamp),
    activeRefs: pickScalar(mine.activeRefs, theirs.activeRefs, myStamp, theirStamp),
    updatedAt: Math.max(myStamp, theirStamp),
    deleted: tombstones,
  };

  for (const key of RECORD_SETS) {
    merged[key] = mergeRecords(mine[key], theirs[key], tombstones);
  }

  // History is capped and newest-first everywhere else; keep that invariant.
  merged.history = merged.history
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 100);

  return merged;
}

// Merge two whole app states. Neither side is privileged: this returns the
// same result whichever device runs it, which is what makes repeat syncs
// converge instead of ping-ponging.
export function mergeState(mine, theirs) {
  if (!theirs) return mine;
  if (!mine) return theirs;

  const tombstones = { ...(mine.deleted || {}), ...(theirs.deleted || {}) };
  const profiles = byId(mine.profiles || []);

  for (const p of theirs.profiles || []) {
    const existing = profiles.get(p.id);
    profiles.set(p.id, existing ? mergeProfile(existing, p) : p);
  }
  for (const id of Object.keys(tombstones)) profiles.delete(id);

  const myStamp = mine.updatedAt || 0;
  const theirStamp = theirs.updatedAt || 0;

  return {
    profiles: [...profiles.values()],
    activeProfileId: pickScalar(mine.activeProfileId, theirs.activeProfileId, myStamp, theirStamp),
    settings: {
      ...(mine.settings || {}),
      ...(theirStamp > myStamp ? (theirs.settings || {}) : {}),
    },
    // Barcode links are a pure union — a link learned on either device is
    // knowledge, and they never conflict meaningfully.
    barcodes: { ...(theirs.barcodes || {}), ...(mine.barcodes || {}) },
    userGarments: mergeUserGarments(mine.userGarments, theirs.userGarments, tombstones),
    updatedAt: Math.max(myStamp, theirStamp),
    deleted: tombstones,
  };
}

// Measured garments merge per size, not per entry: measuring an M on the
// phone and an L on the laptop should give one product with both sizes.
export function mergeUserGarments(mine, theirs, tombstones = {}) {
  const out = byId(mine);
  for (const g of theirs || []) {
    const existing = out.get(g.id);
    if (!existing) {
      out.set(g.id, g);
      continue;
    }
    out.set(g.id, {
      ...existing,
      sizes: { ...(existing.sizes || {}), ...(g.sizes || {}) },
      updatedAt: Math.max(existing.updatedAt || 0, g.updatedAt || 0),
    });
  }
  for (const id of Object.keys(tombstones)) out.delete(id);
  return [...out.values()];
}

// Calibration samples are immutable observations, so a union by id is both
// correct and the whole point — measurements taken in a shop should land
// alongside those taken at a desk.
export function mergeCalibration(mine, theirs) {
  const out = byId(mine);
  for (const s of theirs || []) if (!out.has(s.id)) out.set(s.id, s);
  return [...out.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}
