// js/app.js — C-02 orchestrator. Boots the SPA, wires the router,
// resolves theme/locale, runs storage recovery, mounts the active view.

import { ROUTES, LANG_KEY } from './config.js';
import { loadCatalogue, setLocale, RUNTIME_LOCALES } from './i18n.js';
import { setBackend, readState, recoverPendingShadow, writeState, setWarnSink, subscribeStorageEvents } from './storage.js';
import { dispatch, getState } from './state.js';
import { applyTheme, persistTheme, resolveInitialTheme, getActiveTheme } from './theme.js';
import { register, navigate, start as routerStart, subscribeRouteChange } from './router.js';
import { rebuildIfMissing, evaluateAndPersist } from './milestones.js';
import { wireMilestoneEvaluator } from './events.js';
import { isEmcon } from './emcon.js';
import { toast, banner, removeBanner, notifyStorageEventForDestructiveModals, _resetForTests } from './overlays.js';
import { showPreflight } from './views/preflight.js';
import { showEmconBanner, hideEmconBanner } from './views/emcon_view.js';
import { buildCsv, exportFilename, triggerDownload } from './csv.js';

const viewModules = {
  [ROUTES.STATION]: () => import('./views/station.js?v=2'),
  [ROUTES.LOG]: () => import('./views/log.js?v=2'),
  [ROUTES.SETTINGS]: () => import('./views/settings.js?v=2'),
  [ROUTES.REPORT]: () => import('./views/report.js?v=2'),
};

let currentUnmount = null;
let appRoot = null;

async function mountRoute(path) {
  if (currentUnmount) { try { currentUnmount(); } catch (e) { console.error(e); } currentUnmount = null; }
  const loader = viewModules[path] ?? viewModules[ROUTES.STATION];
  const mod = await loader();
  mod.mount(appRoot);
  currentUnmount = mod.unmount;
  if (isEmcon()) showEmconBanner();
}

// @req AMD-003
// Stale-magic-link handler. Sign-in is OTP-only (see js/auth.js header);
// magic-link emails are no longer sent. Old links still in inboxes
// resolve to this route — surface a friendly toast and bounce the user
// to Settings where they can request a new code.
function mountAuthCallback() {
  if (currentUnmount) { try { currentUnmount(); } catch (e) { console.error(e); } currentUnmount = null; }
  appRoot.innerHTML = '';
  if (typeof history !== 'undefined') {
    history.replaceState({}, '', ROUTES.SETTINGS);
  }
  toast('cloud.signIn.linkExpired');
  navigate(ROUTES.SETTINGS, { replace: true });
}

export async function exportAndDownload() {
  const state = getState();
  const csv = buildCsv(state);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const r = triggerDownload(blob, exportFilename(new Date()));
  if (!r.ok) { toast('csv.export.blocked'); return r; }
  dispatch({ type: 'topLevel/patch', payload: { lastExportAt: new Date().toISOString() } });
  writeState(getState());
  removeBanner('backup-overdue');
  toast('csv.export.success');
  return r;
}

// @req FR-25
function wireMultitabBanner() {
  subscribeStorageEvents(() => {
    notifyStorageEventForDestructiveModals();
    banner('multitab', 'multitab.banner', {}, [
      { labelKey: 'multitab.reload', onClick: () => location.reload() },
      { labelKey: 'multitab.dismiss', onClick: () => removeBanner('multitab') },
    ]);
  });
}

export async function boot({ root, urlSearchParams = new URLSearchParams(location.search) } = {}) {
  appRoot = root ?? document.getElementById('app');
  if (!appRoot) throw new Error('no #app root');

  // Locale resolution (FR-89): URL > localStorage > navigator.language > en.
  const langParam = urlSearchParams.get('lang');
  const langStored = (() => { try { return localStorage.getItem(LANG_KEY); } catch { return null; } })();
  const langNav = (typeof navigator !== 'undefined' ? navigator.language?.split('-')[0] : null);
  const candidate = langParam || langStored || langNav || 'en';
  const resolved = RUNTIME_LOCALES.includes(candidate) ? candidate : 'en';

  setWarnSink((key, params) => toast(key, params));

  // FR-90: block first paint on the en catalogue.
  await loadCatalogue('en');
  if (resolved !== 'en') {
    try { await loadCatalogue(resolved); } catch { /* fall back */ }
  }
  setLocale(resolved);

  // Storage probe + recovery (NFR-08, NFR-09).
  try { setBackend(window.localStorage); } catch { setBackend(null); }
  recoverPendingShadow();

  const { state, recovery } = readState();
  if (recovery === 'schemaTooNew') {
    banner('schemaTooNew', 'schemaTooNew.banner', {}, [
      { labelKey: 'schemaTooNew.reload', onClick: () => location.reload() },
    ]);
  }
  dispatch({ type: 'state/set', payload: state });

  // FR-110: rebuild milestones if missing/corrupt.
  rebuildIfMissing(getState());

  // Wire milestone evaluator into events.js.
  wireMilestoneEvaluator((s) => evaluateAndPersist(s));

  // Theme: URL > storedFromState (themePreference) > 'themed'.
  const urlTheme = urlSearchParams.get('theme');
  const theme = resolveInitialTheme({ urlParam: urlTheme, stored: getState().themePreference });
  applyTheme(theme);

  // Cross-tab banner.
  wireMultitabBanner();

  // Register routes.
  for (const path of Object.keys(viewModules)) register(path, () => mountRoute(path));
  register(ROUTES.PREFLIGHT, () => { mountRoute(ROUTES.STATION); showPreflight({ force: true }); });
  // AMD-003: stale-magic-link target. Sign-in is OTP-only; this route
  // just catches links from old emails that may still be in inboxes
  // and surfaces a friendly toast.
  register(ROUTES.AUTH_CALLBACK, () => mountAuthCallback());

  subscribeRouteChange(() => {
    if (isEmcon()) showEmconBanner();
    else hideEmconBanner();
  });

  // FR-58: pre-flight on first run.
  if (!isEmcon()) {
    showPreflight();
  }

  routerStart();

  // AMD-003: catch Supabase auth errors that arrive as QUERY PARAMS
  // from an old magic-link redirect (e.g. ?error_code=otp_expired).
  // Sign-in is OTP-only now, but old links in inboxes can still land
  // here. Toast and strip.
  const authErr = urlSearchParams.get('error_code') || urlSearchParams.get('error');
  if (authErr) {
    toast('cloud.signIn.linkExpired');
    if (typeof history !== 'undefined') {
      history.replaceState({}, '', location.pathname + (location.hash || ''));
    }
  }

  // AMD-003: resume cloud sync if the user previously opted in.
  // Lazy-imported so non-cloud users never load it. Failure here is
  // non-fatal — the app keeps working in local-only mode.
  import('./cloud.js')
    .then((cloud) => cloud.boot())
    .catch((e) => console.error('cloud boot failed:', e));
}

if (typeof window !== 'undefined' && !window.__AAR_TEST_MODE__) {
  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((e) => {
      console.error('boot failed:', e);
      const root = document.getElementById('app');
      if (root) {
        root.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = 'Could not start aar-deploy. Please reload the page.';
        root.appendChild(p);
      }
    });
  });
}

export const __testHooks = { _resetOverlays: _resetForTests };
