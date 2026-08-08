// Live sync between devices.
//
// Pairing is by a long random *sync key* rather than an account. There is no
// email, no password, and nothing for the user to type into a credential
// field — the key itself is the secret, generated on one device and entered
// on the other.
//
// The Supabase anon key sits in a public repo, which is what it is designed
// for, but that means the table must never be readable directly or anyone
// could dump every user's measurements. So the table has row-level security
// with no policies at all, and access goes exclusively through two
// SECURITY DEFINER functions that hash the sync key server-side and touch
// only the matching row. See SYNC-SETUP.md for the SQL.

import { mergeState, mergeCalibration, nowStamp } from './syncmerge.js';

const CONFIG_KEY = 'fitcheck-sync-config';
const CALIBRATION_KEY = 'fitcheck-calibration-v1';

export const SYNC_STATE = {
  OFF: 'off',
  IDLE: 'idle',
  SYNCING: 'syncing',
  OFFLINE: 'offline',
  ERROR: 'error',
};

let status = { state: SYNC_STATE.OFF, lastSynced: null, message: '' };
const listeners = new Set();

export function onStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach(fn => fn(status));
}

export function getStatus() {
  return status;
}

/* ---------- Configuration ---------- */

export function readConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null;
  } catch (e) {
    return null;
  }
}

export function writeConfig(config) {
  if (!config) {
    localStorage.removeItem(CONFIG_KEY);
    setStatus({ state: SYNC_STATE.OFF, message: '', lastSynced: null });
    return;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  setStatus({ state: SYNC_STATE.IDLE, message: '' });
}

export function isConfigured() {
  const c = readConfig();
  return !!(c && c.url && c.anonKey && c.syncKey);
}

// 20 characters drawn from a 32-symbol alphabet: 100 bits of entropy, which is
// far beyond guessable. Grouped in fours and with I/O/0/1 removed, because it
// gets read off one screen and typed into another.
export function generateSyncKey() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < bytes.length - 1) out += '-';
  }
  return out;
}

export function normalizeSyncKey(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    .replace(/(.{4})(?=.)/g, '$1-');
}

/* ---------- Transport ---------- */

async function rpc(fnName, body) {
  const c = readConfig();
  if (!c) throw new Error('Sync is not configured');

  const res = await fetch(`${c.url.replace(/\/$/, '')}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: c.anonKey,
      Authorization: `Bearer ${c.anonKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${text.slice(0, 160)}`);
  }
  return res.json();
}

/* ---------- Sync ---------- */

function readCalibration() {
  try {
    return JSON.parse(localStorage.getItem(CALIBRATION_KEY)) || [];
  } catch (e) {
    return [];
  }
}

// One round trip: fetch what the other device left, merge it with what is
// here, write the result back. Merging is symmetric, so it converges no
// matter which device runs it or in what order.
export async function syncNow(store) {
  if (!isConfigured()) return { ok: false, reason: 'not-configured' };
  if (status.state === SYNC_STATE.SYNCING) return { ok: false, reason: 'busy' };

  const c = readConfig();
  setStatus({ state: SYNC_STATE.SYNCING, message: '' });

  try {
    const remote = await rpc('sync_pull', { p_key: c.syncKey });
    const remotePayload = remote?.payload || remote?.[0]?.payload || null;

    const localState = JSON.parse(JSON.stringify(store.state));
    const localCalibration = readCalibration();

    const mergedState = remotePayload
      ? mergeState(localState, remotePayload.state)
      : localState;
    const mergedCalibration = remotePayload
      ? mergeCalibration(localCalibration, remotePayload.calibration || [])
      : localCalibration;

    // Apply locally before pushing, so a failed push still leaves this device
    // holding everything it just learned.
    Object.assign(store.state, mergedState);
    store.save();
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(mergedCalibration));

    await rpc('sync_push', {
      p_key: c.syncKey,
      p_payload: {
        state: mergedState,
        calibration: mergedCalibration,
        pushedAt: nowStamp(),
      },
    });

    const when = new Date().toISOString();
    writeConfig({ ...c, lastSynced: when });
    setStatus({ state: SYNC_STATE.IDLE, lastSynced: when, message: '' });
    return { ok: true, profiles: mergedState.profiles.length, calibration: mergedCalibration.length };
  } catch (err) {
    // Being offline is the expected case in a shop, and is not an error worth
    // alarming anyone about — it just means try again later.
    const offline = !navigator.onLine || /Failed to fetch|NetworkError/i.test(err.message);
    setStatus({
      state: offline ? SYNC_STATE.OFFLINE : SYNC_STATE.ERROR,
      message: offline ? 'No connection — will sync when you are back online.' : err.message,
    });
    return { ok: false, reason: offline ? 'offline' : 'error', error: err.message };
  }
}

/* ---------- Scheduling ---------- */

let timer = null;
let pending = false;

// Coalesce bursts of edits into one round trip rather than syncing per tap.
export function scheduleSync(store, delayMs = 4000) {
  if (!isConfigured()) return;
  pending = true;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    pending = false;
    await syncNow(store);
  }, delayMs);
}

export function startAutoSync(store) {
  if (!isConfigured()) return () => {};

  const onOnline = () => scheduleSync(store, 500);
  const onVisible = () => { if (!document.hidden) scheduleSync(store, 500); };

  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  // Sync on the way out too, so closing the tab in a shop does not strand
  // whatever was just logged.
  window.addEventListener('pagehide', () => { if (pending) syncNow(store); });

  scheduleSync(store, 1000);

  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    clearTimeout(timer);
  };
}
