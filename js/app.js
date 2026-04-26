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
