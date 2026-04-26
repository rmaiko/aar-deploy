// js/router.js — C-06 hand-rolled hash router.
//
// Hash-only routing (no server-side handling required for GitHub Pages).
// Reads location.hash directly so the URL fragment used for EMCON
// (#d=…) is parsed independently of the route segment.
//
// Architecture decision: routes use a "#/" prefix; the EMCON fragment uses
// "#d=…" (no slash) so the two namespaces don't collide.

import { ROUTES } from './config.js';

const routes = new Map();
const subs = new Set();
let current = ROUTES.STATION;

// @req NFR-25
export function register(path, mountFn) {
  routes.set(path, mountFn);
}

function parseHashRoute(hash) {
  if (!hash || hash === '#') return ROUTES.STATION;
  // EMCON share-link fragment — not a route.
  if (hash.startsWith('#d=')) return ROUTES.STATION;
  if (!hash.startsWith('#/')) return ROUTES.STATION;
  // Strip leading '#' and any query suffix.
  const path = hash.split('?')[0];
  return routes.has(path) ? path : ROUTES.STATION;
}

// @req NFR-25
export function getRoute() {
  return current;
}

// @req FR-118
// Read the EMCON-fragment payload (`#d=…`) independently of the route.
export function readEmconFragment(hash) {
  const h = hash ?? (typeof location !== 'undefined' ? location.hash : '');
  if (typeof h !== 'string' || !h.startsWith('#d=')) return null;
  const body = h.slice(3);
  return body || null;
}

// @req NFR-25
export function navigate(path, { replace = false } = {}) {
  if (!routes.has(path)) path = ROUTES.STATION;
  current = path;
  if (typeof history !== 'undefined') {
    const url = path; // hash router — leaves the rest of the URL alone
    if (replace) history.replaceState({}, '', url);
    else history.pushState({}, '', url);
  }
  notify(path);
}

export function clearEmconFragment() {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const path = current && current !== ROUTES.STATION ? current : (location.pathname + location.search);
  history.replaceState({}, '', path);
}

function notify(path) {
  for (const cb of subs) { try { cb(path); } catch { /* swallow */ } }
  const mount = routes.get(path);
  if (mount) { try { mount(); } catch (e) { console.error('route mount threw:', e); } }
}

export function subscribeRouteChange(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

// @req NFR-25
export function start() {
  current = parseHashRoute(typeof location !== 'undefined' ? location.hash : '');
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', () => {
      const next = parseHashRoute(location.hash);
      current = next;
      notify(next);
    });
    window.addEventListener('hashchange', () => {
      const next = parseHashRoute(location.hash);
      if (next !== current) {
        current = next;
        notify(next);
      }
    });
  }
  notify(current);
}
