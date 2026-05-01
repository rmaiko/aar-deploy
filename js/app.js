// js/app.js — C-02 orchestrator. Boots the SPA, wires the router,
// resolves theme/locale, runs storage recovery, mounts the active view.

import { ROUTES, LANG_KEY } from './config.js';
import { loadCatalogue, setLocale, RUNTIME_LOCALES } from './i18n.js';
import { setBackend, readState, recoverPendingShadow, writeState, setWarnSink, subscribeStorageEvents } from './storage.js';
import { dispatch, getState } from './state.js';
import { applyTheme, persistTheme, resolveInitialTheme, getActiveTheme } from './theme.js';
import { register, navigate, start as routerStart, getRoute, readEmconFragment, subscribeRouteChange } from './router.js';
import { rebuildIfMissing, evaluateAndPersist } from './milestones.js';
import { wireMilestoneEvaluator } from './events.js';
import { decodeFragment } from './share.js';
import { enterEmcon, isEmcon, exitEmcon } from './emcon.js';
import { toast, banner, removeBanner, notifyStorageEventForDestructiveModals, _resetForTests } from './overlays.js';
import { showPreflight } from './views/preflight.js';
import { showEmconBanner, hideEmconBanner, showCorruptScreen } from './views/emcon_view.js';
import { SCHEMA_VERSION } from './schema.js';
import { buildCsv, exportFilename, triggerDownload } from './csv.js';

const viewModules = {
  [ROUTES.STATION]: () => import('./views/station.js'),
  [ROUTES.LOG]: () => import('./views/log.js'),
  [ROUTES.SETTINGS]: () => import('./views/settings.js'),
  [ROUTES.RELAY]: () => import('./views/relay.js'),
  [ROUTES.REPORT]: () => import('./views/report.js'),
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
// @req US-27
// Magic-link return handler. Renders a transient overlay, hands the URL
// to supabase-js for the PKCE exchange, then routes the user onward.
// Failure modes (PKCE state missing, link expired, code reused, etc.)
// surface as toasts using the typed ERR codes from auth.js.
async function mountAuthCallback() {
  if (currentUnmount) { try { currentUnmount(); } catch (e) { console.error(e); } currentUnmount = null; }
  appRoot.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'aar-auth-callback';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  const msg = document.createElement('p');
  msg.textContent = 'Establishing recall beacon…';
  wrap.appendChild(msg);
  appRoot.appendChild(wrap);
  currentUnmount = () => { try { wrap.remove(); } catch { /* noop */ } };

  let auth;
  try {
    auth = await import('./auth.js');
  } catch (e) {
    console.error('auth module load failed:', e);
    toast('cloud.authCallback.failed');
    navigate(ROUTES.STATION, { replace: true });
    return;
  }

  const result = await auth.exchangeCodeForSession(typeof location !== 'undefined' ? location.href : '');

  // Strip the auth code from the URL fragment so a refresh doesn't try
  // to redeem it again. We replace the route segment too — the user is
  // headed onward.
  if (typeof history !== 'undefined') {
    const target = result.ok ? ROUTES.SETTINGS : ROUTES.STATION;
    history.replaceState({}, '', target);
  }

  if (!result.ok) {
    const code = result.error?.code || 'AUTH_FAILED';
    toast('cloud.authCallback.failed', { code });
    navigate(ROUTES.STATION, { replace: true });
    return;
  }
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

export async function boot({ root, urlSearchParams = new URLSearchParams(location.search), urlHash = location.hash } = {}) {
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

  // EMCON entry from #d=… fragment.
  const fragmentBody = readEmconFragment(urlHash);
  if (fragmentBody) {
    const decoded = decodeFragment(fragmentBody);
    if (!decoded.ok) {
      await showCorruptScreen(appRoot);
      return;
    }
    enterEmcon('share', decoded.value);
    // Apply optional ?theme=plain (FR-124).
    if (urlSearchParams.get('theme') === 'plain') applyTheme('plain');
  }

  // Register routes.
  for (const path of Object.keys(viewModules)) register(path, () => mountRoute(path));
  register(ROUTES.PREFLIGHT, () => { mountRoute(ROUTES.STATION); showPreflight({ force: true }); });
  // AMD-003: magic-link return target. Lazy-imports auth.js so users who
  // never opt into cloud sync never load the supabase-js bundle.
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
