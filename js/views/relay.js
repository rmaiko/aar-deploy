// js/views/relay.js — C-21 COMMS RELAY (share-link) view.

import { t } from '../i18n.js';
import { getState, dispatch } from '../state.js';
import { writeState } from '../storage.js';
import { dialog, toast } from '../overlays.js';
import { navigate } from '../router.js';
import { ROUTES, SHARE_DAY_DEFAULT, SHARE_DAY_MAX, SHARE_FRAGMENT_BYTE_CAP } from '../config.js';
import { encodePayload, buildShareUrl } from '../share.js';
import { buildCsv, exportFilename, triggerDownload } from '../csv.js';

let mountEl = null;

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(opts)) {
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'on') for (const [ek, fn] of Object.entries(v)) node.addEventListener(ek, fn);
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'attrs') for (const [an, av] of Object.entries(v)) node.setAttribute(an, av);
    else node[k] = v;
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

let confirmedShare = false;

function refresh() {
  if (!mountEl) return;
  const state = getState();
  const days = state.commsRelayDays ?? SHARE_DAY_DEFAULT;
  mountEl.innerHTML = '';
  mountEl.appendChild(el('header', { className: 'relay-header' }, [
    el('h1', { text: t('relay.title') }),
    el('button', { type: 'button', className: 'tap nav-back', text: t('nav.return'), on: { click: () => navigate(ROUTES.STATION) } }),
  ]));

  const dayInput = el('input', { type: 'number', value: String(days), attrs: { min: '1', max: String(SHARE_DAY_MAX) } });
  dayInput.addEventListener('change', () => {
    const v = Math.min(SHARE_DAY_MAX, Math.max(1, Math.floor(Number(dayInput.value) || SHARE_DAY_DEFAULT)));
    dispatch({ type: 'topLevel/patch', payload: { commsRelayDays: v } });
    writeState(getState());
    refresh();
  });
  mountEl.appendChild(el('label', {}, [
    el('span', { text: t('relay.dayLabel', { max: SHARE_DAY_MAX }) }),
    dayInput,
  ]));

  const filtered = filterEvents(state.events, days);
  const enc = encodePayload(filtered, state.schemaVersion ?? 1, { days: null });
  mountEl.appendChild(el('p', { text: t('relay.payloadEstimate', { n: enc.length }) }));

  const generate = el('button', {
    type: 'button',
    className: 'tap',
    text: t('relay.generate'),
    on: { click: () => generateAndShare(days, filtered, enc) },
  });
  if (filtered.length === 0) {
    generate.disabled = true;
    mountEl.appendChild(el('p', { text: t('relay.empty', { n: days }) }));
  }
  mountEl.appendChild(generate);
}

function filterEvents(events, days) {
  const since = Date.now() - days * 24 * 3600 * 1000;
  return events.filter((e) => new Date(e.timestamp).getTime() >= since);
}

// @req FR-113
// @req FR-114
// @req FR-115
// @req FR-117
// @req NFR-28
async function generateAndShare(days, filtered, enc) {
  if (enc.overflow) {
    const choice = await dialog({
      bodyKey: 'relay.overflow',
      params: { n: days },
      actions: [
        { labelKey: 'relay.reduceWindow', value: 'reduce', cancel: true, defaultFocus: true },
        { labelKey: 'relay.exportInstead', value: 'export', primary: true },
      ],
    });
    if (choice === 'export') {
      const csv = buildCsv(getState());
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      triggerDownload(blob, exportFilename(new Date()));
    }
    return;
  }
  // FR-113 + NFR-28: privacy modal MUST come before any clipboard/share.
  const url = buildShareUrl(enc.value);
  const ack = await dialog({
    titleKey: 'relay.privacy.title',
    bodyKey: 'relay.privacy.body',
    actions: [
      { labelKey: 'relay.privacy.back', value: 'back', cancel: true, defaultFocus: true },
      { labelKey: 'relay.privacy.confirm', value: 'confirm', primary: true },
    ],
  });
  if (ack !== 'confirm') return;
  confirmedShare = true;
  await tryShare(url);
}

async function tryShare(url) {
  if (!confirmedShare) return; // hard guard
  try {
    if (navigator.share) {
      await navigator.share({ url });
      return;
    }
  } catch { /* fall through */ }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      toast('relay.copy.toast');
      return;
    }
  } catch { /* fall through */ }
  // Fallback: show selectable text per FR-117.
  showFallback(url);
}

function showFallback(url) {
  const wrap = document.createElement('div');
  const ta = document.createElement('textarea');
  ta.value = url;
  ta.rows = 4;
  ta.style.cssText = 'width:100%;font-family:ui-monospace,Menlo,monospace;';
  ta.readOnly = true;
  wrap.appendChild(ta);
  wrap.appendChild(document.createElement('br'));
  const hint = document.createElement('small');
  hint.textContent = t('relay.fallback.instruction');
  wrap.appendChild(hint);
  dialog({
    titleKey: 'relay.title',
    content: wrap,
    actions: [{ labelKey: 'common.close', value: 'close', primary: true, defaultFocus: true, cancel: true }],
  });
}

export function mount(rootEl) {
  mountEl = rootEl;
  confirmedShare = false;
  refresh();
}

export function unmount() {
  if (mountEl) mountEl.innerHTML = '';
  mountEl = null;
  confirmedShare = false;
}
