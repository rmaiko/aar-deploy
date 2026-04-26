// js/views/preflight.js — C-20 Pre-flight Checklist overlay.

import { t } from '../i18n.js';
import { getActiveTheme } from '../theme.js';
import { getState, dispatch } from '../state.js';
import { writeState } from '../storage.js';
import { dialog } from '../overlays.js';

let inFlight = false;

// @req FR-58
// @req FR-59
// @req FR-60
// @req FR-62
// @req FR-63
// @req FR-135
// @req NFR-14
export async function showPreflight({ force = false } = {}) {
  if (inFlight) return;
  const state = getState();
  if (!force && state.firstRunDismissed) return;
  if (!force && state.events.length > 0) return;
  inFlight = true;
  const theme = getActiveTheme();
  const content = renderContent(theme);
  const choice = await dialog({
    titleKey: 'preflight.title',
    content,
    actions: [
      { labelKey: 'preflight.later', value: 'later', cancel: true },
      { labelKey: 'preflight.gotIt', value: 'gotIt', primary: true, defaultFocus: true },
    ],
  });
  inFlight = false;
  if (choice === 'gotIt') {
    dispatch({ type: 'topLevel/patch', payload: { firstRunDismissed: true } });
    writeState(getState());
  }
}

function renderContent(theme) {
  const wrap = document.createElement('div');
  const welcome = document.createElement('p');
  welcome.textContent = t('preflight.welcome');
  welcome.style.cssText = 'margin:0.4rem 0 0.8rem 0;';
  wrap.appendChild(welcome);
  const ol = document.createElement('ol');
  ol.style.cssText = 'list-style:none;padding:0;margin:0;';
  for (let i = 1; i <= 5; i++) {
    const li = document.createElement('li');
    li.textContent = t(`preflight.item${i}.${theme}`);
    li.style.cssText = 'margin:0.4rem 0;';
    ol.appendChild(li);
  }
  wrap.appendChild(ol);
  return wrap;
}
