// js/emcon.js — C-07 EMCON (emissions control) controller.
//
// Single top-level boolean state.  Every write/log/share path consults
// gate(action) before acting.  Re-entry is idempotent (architecture §5.5.2).

import { setEmcon } from './storage.js';

let active = false;
let source = null;          // 'share' | 'csv' | null
let importedState = null;   // payload to render while in EMCON
const subs = new Set();

export class EmconViolationError extends Error {
  constructor(action) {
    super(`write blocked while in EMCON: ${action}`);
    this.name = 'EmconViolationError';
    this.code = 'emcon';
  }
}

// @req NFR-30
export function isEmcon() {
  return active;
}

export function getSource() {
  return source;
}

export function getImportedState() {
  return importedState;
}

// @req NFR-30
export function enterEmcon(src, payload) {
  if (active) {
    // §5.5.2 re-entry: idempotent no-op; preserves source + queued events.
    return { ok: true, reentered: true };
  }
  active = true;
  source = src ?? null;
  importedState = payload ?? null;
  setEmcon(true);
  for (const cb of subs) { try { cb({ active: true, source }); } catch { /* swallow */ } }
  return { ok: true };
}

// @req NFR-30
export function exitEmcon() {
  if (!active) return { ok: true };
  active = false;
  source = null;
  importedState = null;
  setEmcon(false);
  for (const cb of subs) { try { cb({ active: false, source: null }); } catch { /* swallow */ } }
  return { ok: true };
}

export function subscribeEmcon(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

// @req NFR-30
// gate(actionName) — returns true if the write is allowed; throws otherwise.
// Called by every domain action that mutates state or transmits data.
export function gate(action) {
  if (active) throw new EmconViolationError(action);
  return true;
}
