// js/storage.js — C-03 storage I/O. The ONLY module that touches localStorage.
//
// Three write paths per ADR-005:
//   Path A — routine setItem, single-key atomic at the API level.
//   Path B — atomicReplaceData: shadow-key + readback + rename + cleanup.
//            Preserves config top-level fields (FR-127).
//   Path C — factoryReset: removeItem.
//
// Cross-tab `storage` event subscriptions are owned here; subscribers
// during EMCON are queued (architecture §5.5.2) and flushed on exit.

import { STORAGE_KEY, SHADOW_KEY } from './config.js';
import { defaultAppState, applyDefaults, validate, safeJsonParse, SCHEMA_VERSION } from './schema.js';

let backend = (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null;
let unavailableReason = null;
const listeners = new Set();
const queue = []; // queued cross-tab events while EMCON is active
let emconActive = false;
let warnSink = (_code, _params) => {}; // wired by app.js to overlays.toast

// Probe at module load.
try {
  if (backend) {
    const probeKey = `${STORAGE_KEY}.__probe__`;
    backend.setItem(probeKey, '1');
    backend.removeItem(probeKey);
  } else {
    unavailableReason = 'noBackend';
  }
} catch (e) {
  backend = null;
  unavailableReason = e?.name ?? 'unknown';
}

export function setBackend(b) {
  backend = b;
  unavailableReason = b ? null : 'noBackend';
}

// @req NFR-09
export function isAvailable() {
  return Boolean(backend);
}

export function getUnavailableReason() {
  return unavailableReason;
}

export function setWarnSink(fn) {
  warnSink = typeof fn === 'function' ? fn : (() => {});
}

// @req NFR-30
export function setEmcon(flag) {
  emconActive = Boolean(flag);
  if (!emconActive && queue.length) {
    const ev = queue.shift();
    queue.length = 0;
    listeners.forEach((cb) => { try { cb(ev); } catch { /* swallow per pub-sub */ } });
  }
}

// @req FR-25
export function subscribeStorageEvents(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    if (emconActive) {
      queue.push(e);
      return;
    }
    listeners.forEach((cb) => { try { cb(e); } catch { /* swallow */ } });
  });
}

// @req FR-92
// @req NFR-24
export function readState() {
  if (!backend) return { state: defaultAppState(), recovery: null };
  let raw;
  try {
    raw = backend.getItem(STORAGE_KEY);
  } catch {
    return { state: defaultAppState(), recovery: 'readError' };
  }
  if (raw == null) return { state: defaultAppState(), recovery: null };
  const parsed = safeJsonParse(raw);
  if (!parsed.ok) return { state: defaultAppState(), recovery: 'corrupt' };
  const validated = validate(parsed.value);
  if (!validated.ok) {
    if (validated.error.code === 'schemaTooNew') return { state: defaultAppState(), recovery: 'schemaTooNew' };
    return { state: applyDefaults(parsed.value), recovery: 'invalid' };
  }
  return { state: applyDefaults(validated.value), recovery: null };
}

// @req NFR-06
// @req NFR-07
// Path A — routine write. Caller must pass a validated state.
export function writeState(state, { onQuotaExceeded } = {}) {
  if (!backend) return { ok: false, error: { code: 'unavailable' } };
  try {
    backend.setItem(STORAGE_KEY, JSON.stringify(state));
    return { ok: true };
  } catch (e) {
    const code = e?.name ?? 'unknown';
    if (code === 'QuotaExceededError' || /quota/i.test(String(e?.message ?? ''))) {
      warnSink('storage.quotaExceeded.log');
      if (typeof onQuotaExceeded === 'function') {
        try { onQuotaExceeded(); } catch { /* swallow */ }
      }
      return { ok: false, error: { code: 'quota' } };
    }
    warnSink('storage.replaceFailed');
    return { ok: false, error: { code, message: String(e?.message ?? e) } };
  }
}

// @req NFR-08
// @req FR-127
// Path B — atomic data-replace.  Replaces only events / milestones / system_log;
// preserves the top-level config fields named in ICD §IF-03.
export function atomicReplaceData({ events, schemaVersion } = {}) {
  if (!backend) return { ok: false, error: { code: 'unavailable' } };
  if (!Array.isArray(events)) return { ok: false, error: { code: 'shape', message: 'events not an array' } };
  let prev;
  try { prev = backend.getItem(STORAGE_KEY); }
  catch { return { ok: false, error: { code: 'readError' } }; }

  const current = prev ? (safeJsonParse(prev).value ?? defaultAppState()) : defaultAppState();
  const next = applyDefaults({
    ...current,
    schemaVersion: schemaVersion ?? current.schemaVersion ?? SCHEMA_VERSION,
    events,
    milestones: [],
    system_log: [],
  });

  // Step 1 — write to shadow.
  const serialized = JSON.stringify(next);
  try { backend.setItem(SHADOW_KEY, serialized); }
  catch (e) {
    warnSink('storage.replaceFailed');
    return { ok: false, error: { code: 'shadowWrite', message: String(e?.message ?? e) } };
  }

  // Step 2 — read-back verification.
  try {
    const readback = backend.getItem(SHADOW_KEY);
    if (readback !== serialized) {
      try { backend.removeItem(SHADOW_KEY); } catch { /* best effort */ }
      warnSink('storage.replaceFailed');
      return { ok: false, error: { code: 'readbackMismatch' } };
    }
  } catch (e) {
    warnSink('storage.replaceFailed');
    return { ok: false, error: { code: 'readbackError', message: String(e?.message ?? e) } };
  }

  // Step 3 — swap.
  try { backend.setItem(STORAGE_KEY, serialized); }
  catch (e) {
    try { backend.removeItem(SHADOW_KEY); } catch { /* best effort */ }
    warnSink('storage.replaceFailed');
    return { ok: false, error: { code: 'swap', message: String(e?.message ?? e) } };
  }

  // Step 4 — cleanup.
  try { backend.removeItem(SHADOW_KEY); } catch { /* boot recovery handles stale shadow */ }
  return { ok: true, value: next };
}

// @req FR-71
// @req NFR-08
// Path C — factory reset.
export function factoryReset() {
  if (!backend) return { ok: false, error: { code: 'unavailable' } };
  try {
    backend.removeItem(STORAGE_KEY);
    try { backend.removeItem(SHADOW_KEY); } catch { /* best effort */ }
    return { ok: true };
  } catch (e) {
    warnSink('factoryReset.failed');
    return { ok: false, error: { code: e?.name ?? 'unknown', message: String(e?.message ?? e) } };
  }
}

// @req NFR-08
// Boot-time orphan recovery: if a shadow key exists, attempt commit (if valid)
// or discard.  Called once from app.js bootstrap.
export function recoverPendingShadow() {
  if (!backend) return { recovered: false, action: 'noBackend' };
  let raw;
  try { raw = backend.getItem(SHADOW_KEY); }
  catch { return { recovered: false, action: 'readError' }; }
  if (raw == null) return { recovered: false, action: 'none' };

  const parsed = safeJsonParse(raw);
  if (!parsed.ok) {
    try { backend.removeItem(SHADOW_KEY); } catch { /* best effort */ }
    return { recovered: false, action: 'discardCorrupt' };
  }
  const v = validate(parsed.value);
  if (!v.ok) {
    try { backend.removeItem(SHADOW_KEY); } catch { /* best effort */ }
    return { recovered: false, action: 'discardInvalid' };
  }
  try {
    backend.setItem(STORAGE_KEY, raw);
    backend.removeItem(SHADOW_KEY);
    return { recovered: true, action: 'commit' };
  } catch {
    return { recovered: false, action: 'commitFailed' };
  }
}
