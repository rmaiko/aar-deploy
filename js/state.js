// js/state.js — C-05 reactive state store.
//
// Pure reducer + pub/sub over the canonical appState. All writes route
// through dispatch(action). Notifications coalesce via queueMicrotask
// (architecture §2.5 mitigation) so 100 dispatches in one microtask
// fire subscribers exactly once.

import { defaultAppState, applyDefaults } from './schema.js';

let state = defaultAppState();
const subs = [];
let scheduled = false;

// @req NFR-04
// @req NFR-05
function reducer(prev, action) {
  if (!action || typeof action.type !== 'string') return prev;
  switch (action.type) {
    case 'state/set':
      return applyDefaults(action.payload);
    case 'event/add':
      if (!action.payload) return prev;
      return { ...prev, events: [...prev.events, action.payload] };
    case 'event/deleteLast':
      if (prev.events.length === 0) return prev;
      return { ...prev, events: prev.events.slice(0, -1) };
    case 'event/update': {
      // payload: { id, patch }
      const { id, patch } = action.payload ?? {};
      if (!id || !patch) return prev;
      const idx = prev.events.findIndex((e) => e.id === id);
      if (idx < 0) return prev;
      const updated = { ...prev.events[idx], ...patch };
      // Strip empty notes to keep the schema clean.
      if ('notes' in updated && (updated.notes == null || updated.notes === '')) delete updated.notes;
      const events = prev.events.slice();
      events[idx] = updated;
      return { ...prev, events };
    }
    case 'milestones/set':
      return { ...prev, milestones: Array.isArray(action.payload) ? action.payload.slice() : [] };
    case 'milestones/append':
      return { ...prev, milestones: [...prev.milestones, ...(Array.isArray(action.payload) ? action.payload : [action.payload])] };
    case 'systemLog/append':
      return { ...prev, system_log: [...prev.system_log, action.payload] };
    case 'settings/patch':
      return { ...prev, settings: { ...prev.settings, ...(action.payload ?? {}) } };
    case 'topLevel/patch': {
      const out = { ...prev };
      for (const [k, v] of Object.entries(action.payload ?? {})) out[k] = v;
      return out;
    }
    case 'appState/replace': {
      // Path B — config preserved (FR-127).  Caller passes {events, schemaVersion}.
      return applyDefaults({
        ...prev,
        schemaVersion: action.payload?.schemaVersion ?? prev.schemaVersion,
        events: Array.isArray(action.payload?.events) ? action.payload.events : prev.events,
        milestones: [],
        system_log: [],
      });
    }
    default:
      return prev;
  }
}

export function getState() {
  return state;
}

export function _setStateForTests(s) {
  state = applyDefaults(s);
}

// @req NFR-05
export function dispatch(action) {
  const next = reducer(state, action);
  if (next === state) return { ok: true };
  state = next;
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const snapshot = state;
      // FIFO; throwing subscribers don't block the rest.
      for (const fn of subs.slice()) {
        try { fn(snapshot); } catch (e) { console.error('subscriber threw:', e); }
      }
    });
  }
  return { ok: true };
}

export function subscribe(fn) {
  if (typeof fn !== 'function') throw new TypeError('subscribe expects a function');
  subs.push(fn);
  return () => {
    const i = subs.indexOf(fn);
    if (i >= 0) subs.splice(i, 1);
  };
}
