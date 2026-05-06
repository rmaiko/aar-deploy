// js/tabnav.js — persistent primary nav tab bar.
//
// Renders into #tabnav (a sibling of #app) so views never clobber it
// when they reset their own innerHTML.

import { t } from './i18n.js';
import { ROUTES } from './config.js';
import { navigate, getRoute, subscribeRouteChange } from './router.js';

const TABS = [
  { route: ROUTES.STATION,     labelKey: 'nav.station',     icon: '⊕' },
  { route: ROUTES.MAINTENANCE, labelKey: 'nav.maintenance', icon: '⚒' },
  { route: ROUTES.LOG,         labelKey: 'nav.log',         icon: '≡' },
  { route: ROUTES.REPORT,      labelKey: 'nav.report',      icon: '⊞' },
  { route: ROUTES.SETTINGS,    labelKey: 'nav.settings',    icon: '⚙' },
];

let rootEl = null;

function render() {
  if (!rootEl) return;
  const active = getRoute();
  rootEl.innerHTML = '';
  for (const tab of TABS) {
    const isActive = tab.route === active;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tabnav-btn' + (isActive ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) btn.setAttribute('aria-current', 'page');

    const icon = document.createElement('span');
    icon.className = 'tabnav-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = tab.icon;
    btn.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tabnav-label';
    label.textContent = t(tab.labelKey);
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      if (tab.route !== getRoute()) navigate(tab.route);
    });
    rootEl.appendChild(btn);
  }
}

export function start(el) {
  rootEl = el ?? document.getElementById('tabnav');
  if (!rootEl) return;
  render();
  subscribeRouteChange(render);
}

export function refreshLabels() {
  render();
}
