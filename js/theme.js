// js/theme.js — C-15 theme system.
// URL > stored > default(themed). Toggling is instant — no reload.

import { dispatch, getState } from './state.js';

const VALID = new Set(['themed', 'plain']);
let active = 'themed';
const subs = new Set();

// @req FR-80
// @req FR-82
// @req FR-83
export function resolveInitialTheme({ urlParam, stored } = {}) {
  if (urlParam && VALID.has(urlParam)) return urlParam;
  if (stored && VALID.has(stored)) return stored;
  return 'themed';
}

// @req FR-80
// @req FR-85
export function applyTheme(theme) {
  const t = VALID.has(theme) ? theme : 'themed';
  active = t;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', t);
  }
  for (const cb of subs) { try { cb(t); } catch { /* swallow */ } }
}

// @req FR-81
export function persistTheme(theme) {
  const t = VALID.has(theme) ? theme : 'themed';
  dispatch({ type: 'topLevel/patch', payload: { themePreference: t } });
}

export function getActiveTheme() {
  return active;
}

export function subscribeThemeChange(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

// @req FR-84
// Theme-aware key resolver: returns the .{theme} variant when present.
export function tk(key) {
  return `${key}.${active}`;
}

// FR-82: precedence applied at boot — caller passes URL + stored value.
export function bootTheme({ urlParam, storedFromState } = {}) {
  const stored = storedFromState ?? getState().themePreference;
  const t = resolveInitialTheme({ urlParam, stored });
  applyTheme(t);
  return t;
}
