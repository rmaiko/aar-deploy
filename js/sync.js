// js/sync.js — C-26 cloud-sync (AMD-003).
//
// Responsibilities (architecture §C-26):
//   - Subscribe to C-05 (state.js) and diff committed events into a
//     persistent FIFO queue at localStorage `aar.syncQueue`. Owned end-
//     to-end by this module — C-03 (storage.js) does not touch it.
//   - Drain the queue against the Supabase REST API on `online` events,
//     a 30-second poll while online, and immediately after enqueue.
//   - Pull active-family events on tab visibility change and explicit
//     pull-to-refresh; merge via the canonical `state/set` path to keep
//     behaviour identical to the share-link receiver (FR-201).
//   - On the false → true transition of cloud.enabled, enqueue every
//     locally-stored event for one-time merge upload (FR-203).
//
// Off-state guarantee: every public function and every internal handler
// short-circuits while `cloud.enabled` is false. With cloud disabled,
// nothing in this file talks to the network. (FR-200, NFR-A3.)
//
// Conflict policy (ADR-017): events are append-only with a stable
// client_id (the originating evt_* id); inserts are idempotent via
// (family_id, client_id) UNIQUE; updates are LWW on `updated_at`;
// deletes are soft via `deleted_at`.

import { getState, dispatch, subscribe } from './state.js';
import { applyDefaults } from './schema.js';
import * as auth from './auth.js';

// ── Constants ─────────────────────────────────────────────────────────
export const QUEUE_KEY = 'aar.syncQueue';
const POLL_INTERVAL_MS = 30 * 1000;   // FR-215: 30-second drain poll
const QUEUE_CAP = 1000;               // FR-216: queue size advisory threshold
const FAILURE_CAP = 20;               // FR-216: per-delta retry advisory threshold
const SCHEMA_VERSION_FOR_CLOUD = 1;   // matches NFR-24 SCHEMA_VERSION

// ── Module state ──────────────────────────────────────────────────────
let started = false;
let unsubState = null;
let unsubSignedIn = null;
let unsubSignedOut = null;
let unsubFamily = null;
let pollTimer = null;
let onlineHandler = null;
let visibilityHandler = null;

// Diff bookkeeping — id → event snapshot from the previous notification.
// Used to compute add/update/delete deltas without leaning on dispatch
// instrumentation (state.js stays untouched).
let lastEventsMap = new Map();

// Hooks wired by init() — sync.js does not import overlays/state config
// directly to keep the module unit-testable.
let warnSink = () => {};
let getCloud = () => ({ enabled: false, activeFamilyId: null, lastPulledAt: null });
let setCloud = () => {};

// Drain re-entrancy + advisory dedup.
let draining = false;
let advisoryActive = false;

// ── Public surface ────────────────────────────────────────────────────

// @req AMD-003
// Boot wiring. App.js calls this once with the warn channel and getter/
// setter for the appState.cloud sub-tree. Idempotent: subsequent calls
// just rebind the hooks without re-subscribing.
export function init(opts = {}) {
  if (typeof opts.warnSink === 'function') warnSink = opts.warnSink;
  if (typeof opts.getCloud === 'function') getCloud = opts.getCloud;
  if (typeof opts.setCloud === 'function') setCloud = opts.setCloud;
}

// @req FR-215
// @req FR-212
// Activates listeners. Safe to call when cloud is disabled — handlers
// short-circuit on `getCloud().enabled === false`.
export function start() {
  if (started) return;
  started = true;
  // Seed the diff baseline from the current state so we never duplicate
  // the entire log on first notification.
  lastEventsMap = new Map(getState().events.map((e) => [e.id, e]));

  unsubState = subscribe((s) => onStateChange(s));

  unsubSignedIn  = auth.on('signedIn',  () => { drainSoon(); pullNow(); });
  unsubSignedOut = auth.on('signedOut', () => { /* keep queue; drains stop via getCloud guard */ });
  unsubFamily    = auth.on('familyChanged', () => { lastEventsMap = new Map(getState().events.map((e) => [e.id, e])); pullNow(); });

  if (typeof window !== 'undefined') {
    onlineHandler = () => drainSoon();
    visibilityHandler = () => { if (document.visibilityState === 'visible') pullNow(); };
    window.addEventListener('online', onlineHandler);
    document.addEventListener('visibilitychange', visibilityHandler);
  }

  pollTimer = setInterval(() => { if (isOnline()) drainSoon(); }, POLL_INTERVAL_MS);
}

// @req FR-204
// Tear down listeners and timers. Used by Settings → cloud OFF.
// `dropQueue` lets the disable path satisfy "drops the in-memory sync
// queue" (FR-204). Persisted queue is also cleared so the next opt-in
// runs the fresh-merge path (FR-203) cleanly.
export function stop({ dropQueue = false } = {}) {
  if (!started) return;
  started = false;
  if (unsubState) { unsubState(); unsubState = null; }
  if (unsubSignedIn)  { unsubSignedIn();  unsubSignedIn  = null; }
  if (unsubSignedOut) { unsubSignedOut(); unsubSignedOut = null; }
  if (unsubFamily)    { unsubFamily();    unsubFamily    = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (typeof window !== 'undefined') {
    if (onlineHandler) window.removeEventListener('online', onlineHandler);
    if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
    onlineHandler = null;
    visibilityHandler = null;
  }
  lastEventsMap = new Map();
  advisoryActive = false;
  if (dropQueue) writeQueue([]);
}

// @req FR-203
// One-time merge upload on opt-in. Settings UI calls this right after
// flipping cloud.enabled true and assigning an activeFamilyId. Idempotent
// at the database level via FR-202's UNIQUE(family_id, client_id), so a
// re-invocation after a partial drain is safe.
export function enqueueAllForInitialMerge() {
  const cloud = getCloud();
  if (!cloud.enabled || !cloud.activeFamilyId) return { ok: false, error: { code: 'NOT_READY' } };
  const userId = auth.getSession()?.userId || null;
  if (!userId) return { ok: false, error: { code: 'NO_SESSION' } };
  const events = getState().events;
  const queue = readQueue();
  for (const ev of events) {
    queue.push(makeUpsertEntry(ev, cloud.activeFamilyId, userId));
  }
  writeQueue(queue);
  drainSoon();
  return { ok: true, queued: events.length };
}

// @req FR-215
export function getQueue() { return readQueue(); }

// @req FR-204
export function clearQueue() { writeQueue([]); }

// @req FR-215
export async function drainNow() { return drain(); }

// @req FR-212
// Manual pull-to-refresh hook. Safe to call when cloud is off (no-op).
export async function pullNow() {
  const cloud = getCloud();
  if (!cloud.enabled || !cloud.activeFamilyId) return { ok: false, error: { code: 'NOT_READY' } };
  if (!isOnline()) return { ok: false, error: { code: 'OFFLINE' } };
  const c = await auth.getClient();
  if (!c) return { ok: false, error: { code: 'NO_CLIENT' } };

  let q = c.from('events').select('*').eq('family_id', cloud.activeFamilyId).is('deleted_at', null);
  if (cloud.lastPulledAt) q = q.gt('updated_at', cloud.lastPulledAt);

  const { data, error } = await q;
  if (error) return { ok: false, error: { code: 'FETCH_FAILED', message: error.message } };

  const cur = getState().events;
  const seenIds = new Set(cur.map((e) => e.id));
  const incoming = (data || []).map(rowToEvent).filter((e) => e && !seenIds.has(e.id));

  if (incoming.length > 0) {
    const merged = applyDefaults({ ...getState(), events: [...cur, ...incoming] });
    dispatch({ type: 'state/set', payload: merged });
  }

  setCloud({ lastPulledAt: new Date().toISOString() });
  return { ok: true, fetched: (data || []).length, merged: incoming.length };
}

// ── State diff → enqueue (FR-202, FR-213, FR-214, FR-215) ─────────────

function onStateChange(s) {
  const cloud = getCloud();
  if (!cloud.enabled || !cloud.activeFamilyId) {
    // Keep the diff baseline current so the first event after re-enable
    // doesn't replay history. Initial-merge upload is the canonical
    // catch-up path (FR-203).
    lastEventsMap = new Map(s.events.map((e) => [e.id, e]));
    return;
  }
  const userId = auth.getSession()?.userId || null;
  if (!userId) return;

  const newMap = new Map(s.events.map((e) => [e.id, e]));
  const queue = readQueue();
  let changed = false;

  for (const [id, ev] of newMap) {
    const prev = lastEventsMap.get(id);
    if (!prev) {
      queue.push(makeUpsertEntry(ev, cloud.activeFamilyId, userId));
      changed = true;
    } else if (!shallowEventEqual(prev, ev)) {
      queue.push(makeUpsertEntry(ev, cloud.activeFamilyId, userId, { update: true }));
      changed = true;
    }
  }
  for (const [id] of lastEventsMap) {
    if (!newMap.has(id)) {
      queue.push(makeDeleteEntry(id, cloud.activeFamilyId));
      changed = true;
    }
  }

  if (changed) {
    if (queue.length > QUEUE_CAP) raiseAdvisory();
    writeQueue(queue);
    drainSoon();
  }
  lastEventsMap = newMap;
}

function shallowEventEqual(a, b) {
  const keys = ['type', 'timestamp', 'side', 'durationMin', 'weightKg', 'lengthCm', 'notes'];
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function makeUpsertEntry(ev, familyId, userId, { update = false } = {}) {
  const nowIso = new Date().toISOString();
  return {
    op: 'upsert',
    table: 'events',
    client_id: ev.id,
    row: eventToRow(ev, familyId, userId, { updatedAt: nowIso, isUpdate: update }),
    queuedAt: nowIso,
    attempts: 0,
  };
}
function makeDeleteEntry(eventId, familyId) {
  const nowIso = new Date().toISOString();
  return {
    op: 'delete',
    table: 'events',
    client_id: eventId,
    row: { family_id: familyId, deleted_at: nowIso, updated_at: nowIso },
    queuedAt: nowIso,
    attempts: 0,
  };
}

function eventToRow(ev, familyId, userId, { updatedAt, isUpdate }) {
  const row = {
    family_id: familyId,
    client_id: ev.id,
    type: ev.type,
    timestamp: ev.timestamp,
    side: ev.side ?? null,
    duration_min: ev.durationMin ?? null,
    weight_kg: ev.weightKg ?? null,
    length_cm: ev.lengthCm ?? null,
    notes: ev.notes ?? null,
    created_by: userId,
    updated_at: updatedAt,
    schema_version: SCHEMA_VERSION_FOR_CLOUD,
  };
  if (!isUpdate) row.created_at = updatedAt;
  return row;
}

function rowToEvent(r) {
  if (!r || typeof r !== 'object' || !r.client_id || !r.type || !r.timestamp) return null;
  const ev = { id: r.client_id, type: r.type, timestamp: r.timestamp };
  if (r.side != null) ev.side = r.side;
  if (r.duration_min != null) ev.durationMin = r.duration_min;
  if (r.weight_kg != null) ev.weightKg = r.weight_kg;
  if (r.length_cm != null) ev.lengthCm = r.length_cm;
  if (r.notes != null && r.notes !== '') ev.notes = r.notes;
  return ev;
}

// ── Drain (FR-202, FR-215, FR-216) ────────────────────────────────────

let drainScheduled = false;
function drainSoon() {
  if (drainScheduled) return;
  drainScheduled = true;
  // Coalesce burst enqueues; queueMicrotask matches state.js's own
  // notification cadence so we drain at most once per microtask flush.
  queueMicrotask(() => { drainScheduled = false; drain(); });
}

async function drain() {
  if (draining) return { ok: false, error: { code: 'BUSY' } };
  if (!isOnline()) return { ok: false, error: { code: 'OFFLINE' } };
  const cloud = getCloud();
  if (!cloud.enabled || !cloud.activeFamilyId) return { ok: false, error: { code: 'DISABLED' } };
  if (!auth.getSession()) return { ok: false, error: { code: 'NO_SESSION' } };
  const c = await auth.getClient();
  if (!c) return { ok: false, error: { code: 'NO_CLIENT' } };

  draining = true;
  try {
    let queue = readQueue();
    let drained = 0;
    while (queue.length > 0) {
      const head = queue[0];
      const result = await applyDelta(c, head);
      if (result.ok) {
        queue = queue.slice(1);
        writeQueue(queue);
        drained++;
        continue;
      }
      head.attempts = (head.attempts || 0) + 1;
      writeQueue(queue);
      if (head.attempts > FAILURE_CAP) raiseAdvisory();
      // Permanent rejections (RLS / unique violation already-applied)
      // drop the head so a single bad delta cannot wedge the queue.
      if (result.permanent) {
        queue = queue.slice(1);
        writeQueue(queue);
        continue;
      }
      // Transient failure — back off, retry on next drain trigger.
      break;
    }
    return { ok: true, drained, remaining: queue.length };
  } finally {
    draining = false;
  }
}

async function applyDelta(c, entry) {
  try {
    if (entry.op === 'upsert') {
      const { error } = await c.from(entry.table).upsert(entry.row, { onConflict: 'family_id,client_id' });
      if (!error) return { ok: true };
      // 23505 = unique_violation. In our schema this means the row is
      // already present at the same or newer version — treat as success.
      if (String(error.code) === '23505') return { ok: true };
      // 42501 = insufficient_privilege (RLS). Permanent for this caller.
      if (String(error.code) === '42501') return { ok: false, permanent: true, error };
      return { ok: false, error };
    }
    if (entry.op === 'delete') {
      // FR-213 soft delete — bump deleted_at via UPDATE.
      const { error } = await c.from(entry.table)
        .update({ deleted_at: entry.row.deleted_at, updated_at: entry.row.updated_at })
        .eq('family_id', entry.row.family_id)
        .eq('client_id', entry.client_id);
      if (!error) return { ok: true };
      if (String(error.code) === '42501') return { ok: false, permanent: true, error };
      return { ok: false, error };
    }
    return { ok: false, permanent: true, error: { message: `unknown op: ${entry.op}` } };
  } catch (e) {
    return { ok: false, error: { message: String(e?.message ?? e) } };
  }
}

function raiseAdvisory() {
  if (advisoryActive) return;
  advisoryActive = true;
  try { warnSink('cloud.sync.advisory', { key: 'cloud.sync.notReachedYet' }); }
  catch (e) { console.error('warnSink threw:', e); }
}

// ── localStorage I/O ──────────────────────────────────────────────────
function readQueue() {
  try {
    const raw = (typeof window !== 'undefined' && window.localStorage)
      ? window.localStorage.getItem(QUEUE_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function writeQueue(q) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    }
  } catch (e) { console.error('aar.syncQueue write failed:', e); }
}

function isOnline() {
  return (typeof navigator === 'undefined') ? true : (navigator.onLine !== false);
}

// ── Test seam ─────────────────────────────────────────────────────────
export function _resetForTests() {
  started = false;
  unsubState = unsubSignedIn = unsubSignedOut = unsubFamily = null;
  pollTimer = null;
  onlineHandler = visibilityHandler = null;
  lastEventsMap = new Map();
  draining = false;
  advisoryActive = false;
  drainScheduled = false;
  warnSink = () => {};
  getCloud = () => ({ enabled: false, activeFamilyId: null, lastPulledAt: null });
  setCloud = () => {};
  writeQueue([]);
}
