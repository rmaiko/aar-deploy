// js/views/emcon_view.js — C-22 EMCON banner + view shell.

import { t } from '../i18n.js';
import { isEmcon, getImportedState, exitEmcon } from '../emcon.js';
import { atomicReplaceData } from '../storage.js';
import { dispatch, getState } from '../state.js';
import { rebuildIfMissing } from '../milestones.js';
import { dialog, banner, removeBanner, toast } from '../overlays.js';
import { navigate, clearEmconFragment } from '../router.js';
import { ROUTES } from '../config.js';

const BANNER_ID = 'emcon-banner';

// @req FR-118
// @req FR-119
// @req FR-120
// @req FR-121
// @req FR-122
// @req FR-123
// @req NFR-30
export function showEmconBanner() {
  if (!isEmcon()) return;
  banner(BANNER_ID, 'emcon.banner', {}, [
    { labelKey: 'emcon.replace', onClick: () => onReplace() },
    { labelKey: 'emcon.exit', onClick: () => onExit() },
  ]);
}

export function hideEmconBanner() {
  removeBanner(BANNER_ID);
}

async function onReplace() {
  const choice = await dialog({
    bodyKey: 'emcon.banner',
    actions: [
      { labelKey: 'emcon.modal.cancel', value: 'cancel', cancel: true, defaultFocus: true },
      { labelKey: 'emcon.modal.exportFirst', value: 'export' },
      { labelKey: 'emcon.modal.replace', value: 'replace', primary: true },
    ],
    destructive: true,
  });
  if (!choice || choice === 'cancel' || (choice && choice.closedByStorage)) return;
  if (choice === 'export') {
    // Import dynamically to avoid circular dep.
    const { exportAndDownload } = await import('../app.js');
    exportAndDownload();
    return;
  }
  // FR-121: atomic replace, rebuild milestones, exit EMCON, clear fragment.
  const imported = getImportedState();
  if (!imported) { toast('share.corrupt.invalidSchema'); return; }
  const r = atomicReplaceData({ events: imported.events, schemaVersion: imported.schemaVersion });
  if (!r.ok) { toast('storage.replaceFailed'); return; }
  dispatch({ type: 'state/set', payload: r.value });
  rebuildIfMissing({ ...r.value, milestones: undefined });
  exitEmcon();
  clearEmconFragment();
  hideEmconBanner();
  navigate(ROUTES.STATION);
}

function onExit() {
  exitEmcon();
  clearEmconFragment();
  hideEmconBanner();
  navigate(ROUTES.STATION);
}

// @req FR-123
export async function showCorruptScreen(rootEl) {
  rootEl.innerHTML = '';
  const wrap = document.createElement('section');
  wrap.style.cssText = 'padding:2rem;text-align:center;';
  const h = document.createElement('h1');
  h.textContent = t('share.corrupt.title');
  wrap.appendChild(h);
  const p = document.createElement('p');
  p.textContent = t('share.corrupt.decodeFailed');
  wrap.appendChild(p);
  const b = document.createElement('button');
  b.textContent = t('share.corrupt.continue');
  b.className = 'tap';
  b.addEventListener('click', () => {
    clearEmconFragment();
    navigate(ROUTES.STATION);
  });
  wrap.appendChild(b);
  rootEl.appendChild(wrap);
}
