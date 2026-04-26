// js/events.js — C-08 domain event service.
//
// Composes chip + state + storage + milestones + prediction.
// Validates inputs, applies the back-date chip, dispatches the action,
// persists to localStorage, and runs the milestone evaluator.

import { dispatch, getState } from './state.js';
import { writeState } from './storage.js';
import { gate } from './emcon.js';
import { resolveTimestamp, toLocalIso } from './chip.js';
import {
  FEED_DURATION_MIN, FEED_DURATION_MAX,
  WEIGHT_KG_MIN, WEIGHT_KG_MAX, LENGTH_CM_MIN, LENGTH_CM_MAX,
} from './config.js';

let evaluateMilestonesFn = null; // wired by app.js (optional — Alpha = no-op)

export function wireMilestoneEvaluator(fn) {
  evaluateMilestonesFn = typeof fn === 'function' ? fn : null;
}

function newEventId(type, ts) {
  const cleanTs = ts.replace(/[:.]/g, '-');
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `evt_${type}_${cleanTs}_${rand}`;
}

function commit(eventObj) {
  dispatch({ type: 'event/add', payload: eventObj });
  if (evaluateMilestonesFn) {
    try { evaluateMilestonesFn(getState()); } catch (e) { console.error('milestone eval threw:', e); }
  }
  return writeState(getState());
}

// @req FR-01
// @req FR-02
// @req FR-03
// @req FR-04
export function logFeed({ side, durationMin, when }) {
  gate('logFeed');
  if (side !== 'port' && side !== 'starboard') {
    return { ok: false, error: { code: 'side', message: 'side must be port or starboard' } };
  }
  if (durationMin != null && durationMin !== '') {
    const n = Number(durationMin);
    if (!Number.isFinite(n) || n < FEED_DURATION_MIN || n > FEED_DURATION_MAX) {
      return { ok: false, error: { code: 'duration', errorKey: 'feeding.boomTimeRange' } };
    }
  }
  const tsCheck = resolveTimestampOrNow(when);
  if (!tsCheck.ok) return { ok: false, error: { code: 'time', errorKey: tsCheck.errorKey } };
  const iso = toLocalIso(tsCheck.value);
  const ev = {
    id: newEventId('feed', iso),
    type: 'feed',
    timestamp: iso,
    side,
    ...(durationMin != null && durationMin !== '' ? { durationMin: Number(durationMin) } : {}),
  };
  const w = commit(ev);
  return { ok: w.ok, value: ev, error: w.error };
}

// @req FR-05
// @req FR-06
export function logDiaper({ type, when }) {
  gate('logDiaper');
  if (type !== 'wet' && type !== 'dirty') {
    return { ok: false, error: { code: 'type', message: 'type must be wet or dirty' } };
  }
  const tsCheck = resolveTimestampOrNow(when);
  if (!tsCheck.ok) return { ok: false, error: { code: 'time', errorKey: tsCheck.errorKey } };
  const iso = toLocalIso(tsCheck.value);
  const ev = {
    id: newEventId(type, iso),
    type,
    timestamp: iso,
  };
  const w = commit(ev);
  return { ok: w.ok, value: ev, error: w.error };
}

// @req FR-07
// @req FR-08
// @req FR-09
export function logWeight({ weightKg, lengthCm, when }) {
  gate('logWeight');
  const w = Number(weightKg);
  const l = Number(lengthCm);
  if (!Number.isFinite(w) || w < WEIGHT_KG_MIN || w > WEIGHT_KG_MAX) {
    return { ok: false, error: { code: 'weight', errorKey: 'weight.rangeError' } };
  }
  if (!Number.isFinite(l) || l < LENGTH_CM_MIN || l > LENGTH_CM_MAX) {
    return { ok: false, error: { code: 'length', errorKey: 'length.rangeError' } };
  }
  const tsCheck = resolveTimestampOrNow(when);
  if (!tsCheck.ok) return { ok: false, error: { code: 'time', errorKey: tsCheck.errorKey } };
  const iso = toLocalIso(tsCheck.value);
  const ev = {
    id: newEventId('weight', iso),
    type: 'weight',
    timestamp: iso,
    weightKg: w,
    lengthCm: l,
  };
  const wr = commit(ev);
  return { ok: wr.ok, value: ev, error: wr.error };
}

// Generic free-form note event (extension beyond v1 type set —
// AMD-003 carry-forward). timestamp = chip-resolved or now;
// notes is required and capped at 500 chars.
export function logNote({ notes, when }) {
  gate('logNote');
  const text = String(notes ?? '').trim();
  if (!text) return { ok: false, error: { code: 'notes', message: 'notes required' } };
  const tsCheck = resolveTimestampOrNow(when);
  if (!tsCheck.ok) return { ok: false, error: { code: 'time', errorKey: tsCheck.errorKey } };
  const iso = toLocalIso(tsCheck.value);
  const ev = {
    id: newEventId('note', iso),
    type: 'note',
    timestamp: iso,
    notes: text.slice(0, 500),
  };
  const w = commit(ev);
  return { ok: w.ok, value: ev, error: w.error };
}

// @req FR-76
// @req FR-77
export function deleteLast() {
  gate('deleteLast');
  const before = getState().events;
  if (before.length === 0) return { ok: false, error: { code: 'empty' } };
  dispatch({ type: 'event/deleteLast' });
  if (evaluateMilestonesFn) {
    try { evaluateMilestonesFn(getState()); } catch (e) { console.error('milestone eval threw:', e); }
  }
  const w = writeState(getState());
  return { ok: w.ok, value: before[before.length - 1], error: w.error };
}

function resolveTimestampOrNow(when) {
  if (when instanceof Date) {
    const r = resolveTimestamp(new Date(), { kind: 'custom', iso: when.toISOString() });
    return r;
  }
  if (when && typeof when === 'object') {
    return resolveTimestamp(new Date(), when);
  }
  return { ok: true, value: new Date() };
}

export function getLastEvent(state = getState()) {
  return state.events.length ? state.events[state.events.length - 1] : null;
}

// Per-entry edit (deviation from project_requirements.md §4 "out of scope:
// per-entry edit beyond delete-last" — to formalise via AMD-003 in
// Phase 6). Patches a single event by id and persists; runs the same
// post-commit milestone re-evaluation as a fresh log.
export function updateEvent(id, patch) {
  gate('updateEvent');
  const state = getState();
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return { ok: false, error: { code: 'notFound' } };
  // Validate patched fields.
  const merged = { ...ev, ...patch };
  if (merged.type === 'feed' && merged.durationMin != null && merged.durationMin !== '') {
    const n = Number(merged.durationMin);
    if (!Number.isFinite(n) || n < FEED_DURATION_MIN || n > FEED_DURATION_MAX) {
      return { ok: false, error: { code: 'duration', errorKey: 'feeding.boomTimeRange' } };
    }
    patch.durationMin = n;
  }
  if (merged.type === 'weight') {
    const w = Number(merged.weightKg);
    const l = Number(merged.lengthCm);
    if (!Number.isFinite(w) || w < WEIGHT_KG_MIN || w > WEIGHT_KG_MAX) {
      return { ok: false, error: { code: 'weight', errorKey: 'weight.rangeError' } };
    }
    if (!Number.isFinite(l) || l < LENGTH_CM_MIN || l > LENGTH_CM_MAX) {
      return { ok: false, error: { code: 'length', errorKey: 'length.rangeError' } };
    }
    patch.weightKg = w;
    patch.lengthCm = l;
  }
  if (merged.timestamp && new Date(merged.timestamp).getTime() > Date.now() + 60_000) {
    return { ok: false, error: { code: 'time', errorKey: 'time.notFuture' } };
  }
  if (patch.notes != null) patch.notes = String(patch.notes).slice(0, 500);
  dispatch({ type: 'event/update', payload: { id, patch } });
  if (evaluateMilestonesFn) {
    try { evaluateMilestonesFn(getState()); } catch (e) { console.error('milestone eval threw:', e); }
  }
  const w = writeState(getState());
  return { ok: w.ok, value: getState().events.find((e) => e.id === id), error: w.error };
}

// ─── Live feeding timer ─────────────────────────────────────────────
//
// Stopwatch-style flow: with chip = Now, the FIRST CONTACT tap starts a
// timer instead of logging.  The next CONTACT tap (any side) stops the
// timer and logs the feed with duration = elapsed minutes and
// timestamp = start time.
//
// Module-scoped — not persisted across reload.  If the user closes the
// tab mid-feed the in-progress timer is lost; the chip and other
// fallbacks still let them log it after the fact.

let activeFeedTimer = null;
const timerSubs = new Set();

function notifyTimer() {
  for (const cb of timerSubs) { try { cb(activeFeedTimer); } catch { /* swallow */ } }
}

export function getActiveFeedTimer() {
  return activeFeedTimer ? { ...activeFeedTimer } : null;
}

export function subscribeFeedTimer(cb) {
  timerSubs.add(cb);
  return () => timerSubs.delete(cb);
}

// @req FR-01
// @req FR-02
export function startFeedTimer(side) {
  gate('logFeed');
  if (side !== 'port' && side !== 'starboard') {
    return { ok: false, error: { code: 'side' } };
  }
  activeFeedTimer = { side, startedAt: Date.now() };
  notifyTimer();
  return { ok: true, value: activeFeedTimer };
}

// @req FR-03
// Stops the running timer and commits a feed event with
//   timestamp = start of the feed,
//   durationMin = elapsed minutes (rounded; omitted when 0).
export function stopFeedTimerAndLog() {
  gate('logFeed');
  if (!activeFeedTimer) return { ok: false, error: { code: 'noTimer' } };
  const elapsedMs = Date.now() - activeFeedTimer.startedAt;
  const durationMin = Math.max(0, Math.round(elapsedMs / 60_000));
  const startIso = toLocalIso(new Date(activeFeedTimer.startedAt));
  const side = activeFeedTimer.side;
  const ev = {
    id: newEventId('feed', startIso),
    type: 'feed',
    timestamp: startIso,
    side,
    ...(durationMin > 0 ? { durationMin } : {}),
  };
  activeFeedTimer = null;
  notifyTimer();
  const w = commit(ev);
  return { ok: w.ok, value: ev, error: w.error };
}

export function cancelFeedTimer() {
  if (!activeFeedTimer) return { ok: true };
  activeFeedTimer = null;
  notifyTimer();
  return { ok: true };
}

// @req FR-01
// @req FR-03
// Quick-log path for chip ≠ Now: timestamp is the chip-resolved time,
// duration is the elapsed minutes from chip-time to now (so a
// "15m ago" tap records a 15-minute feed that ended at now).
export function logFeedWithChipDuration({ side, when }) {
  gate('logFeed');
  if (side !== 'port' && side !== 'starboard') {
    return { ok: false, error: { code: 'side' } };
  }
  const ts = resolveTimestampOrNow(when);
  if (!ts.ok) return { ok: false, error: { code: 'time', errorKey: ts.errorKey } };
  const startMs = ts.value.getTime();
  const durationMin = Math.max(0, Math.round((Date.now() - startMs) / 60_000));
  const iso = toLocalIso(new Date(startMs));
  const ev = {
    id: newEventId('feed', iso),
    type: 'feed',
    timestamp: iso,
    side,
    ...(durationMin > 0 ? { durationMin } : {}),
  };
  const w = commit(ev);
  return { ok: w.ok, value: ev, error: w.error };
}
