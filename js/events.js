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
