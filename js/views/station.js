// js/views/station.js — C-17 Loadmaster Station view.
//
// Top-level "home" view: log buttons, back-date chip, LAST CONTACT panel,
// TODAY widget, NEXT VECTOR panel, DELETE LAST button, banner host.

import { t } from '../i18n.js';
import { getActiveTheme, tk } from '../theme.js';
import { getState, subscribe } from '../state.js';
import {
  logFeed, logDiaper, logWeight, deleteLast,
  startFeedTimer, stopFeedTimerAndLog, cancelFeedTimer,
  getActiveFeedTimer, subscribeFeedTimer, logFeedWithChipDuration,
} from '../events.js';
import { dispatch } from '../state.js';
import { writeState } from '../storage.js';
import { predictFeed, predictDiaper } from '../prediction.js';
import { isEmcon, getImportedState } from '../emcon.js';
import { navigate } from '../router.js';
import { ROUTES } from '../config.js';
import { toast, dialog, banner } from '../overlays.js';
import { getOffsets, getSelection, setSelection, reset as chipReset, toLocalIso } from '../chip.js';
import {
  RELATIVE_TIME_TICK_MS, BACKUP_NUDGE_DAYS, BACKUP_NUDGE_MIN_EVENTS, FIRST_BACKUP_MIN_EVENTS,
  REMIND_LATER_HOURS,
} from '../config.js';

let mountEl = null;
let unsubState = null;
let unsubTimer = null;
let tickHandle = null;
let timerTickHandle = null;

function refresh() {
  if (!mountEl) return;
  const state = isEmcon() ? (getImportedState() ?? getState()) : getState();
  const theme = getActiveTheme();
  mountEl.innerHTML = '';
  mountEl.appendChild(renderHeader(theme));
  mountEl.appendChild(renderTimerPanel(theme));
  mountEl.appendChild(renderActions(theme, state));
  mountEl.appendChild(renderChip(theme));
  mountEl.appendChild(renderLastContact(theme, state));
  mountEl.appendChild(renderToday(theme, state));
  mountEl.appendChild(renderRecent(theme, state));
  mountEl.appendChild(renderNextVector(theme, state));
  mountEl.appendChild(renderDeleteLast(theme, state));
  evaluateBackupBanner(state);
}

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(opts)) {
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'aria') for (const [ak, av] of Object.entries(v)) node.setAttribute(`aria-${ak}`, av);
    else if (k === 'on') for (const [ek, fn] of Object.entries(v)) node.addEventListener(ek, fn);
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'attrs') for (const [an, av] of Object.entries(v)) node.setAttribute(an, av);
    else node[k] = v;
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

// @req FR-15
// @req FR-69
function renderHeader(theme) {
  const h = el('header', { className: 'station-header' });
  const titleWrap = el('div', { className: 'station-titles' });
  titleWrap.appendChild(el('h1', { text: t(`app.title.${theme}`) }));
  titleWrap.appendChild(el('p', { className: 'sub', text: t(`app.subtitle.${theme}`) }));
  h.appendChild(titleWrap);
  const nav = el('nav', { className: 'station-nav' });
  nav.appendChild(el('button', {
    type: 'button',
    className: 'tap nav-btn',
    text: t('nav.openLog'),
    aria: { label: t('nav.openLog') },
    on: { click: () => navigate(ROUTES.LOG) },
  }));
  nav.appendChild(el('button', {
    type: 'button',
    className: 'tap nav-btn nav-settings',
    // Gear glyph + visible label so the affordance is discoverable
    // even before the user reads the label.
    text: '⚙ ' + t('nav.openSettings'),
    aria: { label: t('nav.openSettings') },
    on: { click: () => navigate(ROUTES.SETTINGS) },
  }));
  h.appendChild(nav);
  return h;
}

// @req FR-01
// @req FR-02
// @req FR-05
// @req FR-06
// @req FR-07
// @req FR-15
// @req NFR-10
function renderActions(theme, state) {
  const wrap = el('section', { className: 'log-actions', attrs: { 'data-emcon-gated': '1' } });
  const make = (key, plainKey, onClick) => {
    const b = el('button', {
      type: 'button',
      className: 'tap log-btn',
      on: { click: onClick },
      aria: { label: t(plainKey) },
    });
    b.appendChild(el('span', { className: 'themed', text: t(key) }));
    if (theme === 'plain') b.firstChild.style.cssText = 'display:none';
    b.appendChild(el('span', { className: 'plain', text: t(plainKey) }));
    if (theme !== 'plain') b.lastChild.style.cssText = 'display:block;font-size:0.75rem;color:#aac8aa;';
    return b;
  };
  wrap.appendChild(make(tk('loadAction.contactPort'), 'loadAction.contactPort.plain', () => {
    if (handleEmconBlocked()) return;
    handleContactTap('port');
  }));
  wrap.appendChild(make(tk('loadAction.contactStarboard'), 'loadAction.contactStarboard.plain', () => {
    if (handleEmconBlocked()) return;
    handleContactTap('starboard');
  }));
  wrap.appendChild(make(tk('loadAction.jettisoned'), 'loadAction.jettisoned.plain', () => {
    if (handleEmconBlocked()) return;
    const r = logDiaper({ type: 'wet', when: getSelection() });
    handleLogResult(r, 'event.confirm.wet', 'wet');
    chipReset();
  }));
  wrap.appendChild(make(tk('loadAction.ordnance'), 'loadAction.ordnance.plain', () => {
    if (handleEmconBlocked()) return;
    const r = logDiaper({ type: 'dirty', when: getSelection() });
    handleLogResult(r, 'event.confirm.dirty', 'dirty');
    chipReset();
  }));
  wrap.appendChild(make(tk('loadAction.weight'), 'loadAction.weight.plain', () => {
    if (handleEmconBlocked()) return;
    openWeightDialog();
  }));
  return wrap;
}

// CONTACT-tap dispatcher.
//
//   chip = Now :
//     no timer   → start one (no event logged yet)
//     timer on   → stop & log; duration = elapsed minutes
//   chip ≠ Now :
//     log immediately; timestamp = chip-time, duration = (now − chip-time) min
//
// Behavioural deviation from FR-01 verbatim ("single tap creates an
// event") — flagged for AMD-003 in Phase 6.
function handleContactTap(side) {
  const sel = getSelection();
  const active = getActiveFeedTimer();
  if (active) {
    const r = stopFeedTimerAndLog();
    if (!r.ok) { toast('storage.replaceFailed'); return; }
    const time = formatHm(new Date(r.value.timestamp));
    handleLogResult(r, side === 'port' ? 'event.confirm.feedPort' : 'event.confirm.feedStarboard',
      side === 'port' ? 'feedPort' : 'feedStarboard');
    return;
  }
  if (sel.kind === 'now') {
    startFeedTimer(side);
    refresh();
    return;
  }
  // chip ≠ Now → quick-log path
  const r = logFeedWithChipDuration({ side, when: sel });
  if (!r.ok) {
    if (r.error?.errorKey) toast(r.error.errorKey);
    return;
  }
  handleLogResult(r, side === 'port' ? 'event.confirm.feedPort' : 'event.confirm.feedStarboard',
    side === 'port' ? 'feedPort' : 'feedStarboard');
  chipReset();
}

// Live-timer panel; rendered when a CONTACT timer is running.
function renderTimerPanel(theme) {
  const active = getActiveFeedTimer();
  const wrap = el('section', { className: 'feed-timer' });
  if (!active) {
    wrap.style.cssText = 'display:none;';
    return wrap;
  }
  wrap.style.cssText = 'border:1px solid #7fff7f;background:#0d1f0d;color:#7fff7f;padding:0.5rem 0.6rem;margin:0.4rem 0;text-align:center;';
  const elapsed = formatElapsed(Date.now() - active.startedAt);
  const titleKey = active.side === 'port'
    ? `feed.timer.runningPort.${theme}`
    : `feed.timer.runningStarboard.${theme}`;
  wrap.appendChild(el('strong', { text: t(titleKey, { elapsed }), style: 'font-size:1.1rem;font-variant-numeric:tabular-nums;' }));
  wrap.appendChild(el('p', { text: t(`feed.timer.hint.${theme}`), style: 'margin:0.3rem 0 0.4rem;font-size:0.75rem;color:#aac8aa;' }));
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap',
    text: t('feed.timer.cancel'),
    style: 'font-size:0.8rem;background:transparent;color:#ffb84d;border-color:#ffb84d;',
    on: { click: () => { cancelFeedTimer(); refresh(); } },
  }));
  return wrap;
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function handleEmconBlocked() {
  if (isEmcon()) {
    toast('emcon.banner');
    return true;
  }
  return false;
}

// @req FR-16
// @req FR-17
// @req FR-19
// @req FR-84
function handleLogResult(r, plainKey, eventType) {
  if (!r.ok) {
    if (r.error?.errorKey) toast(r.error.errorKey);
    return;
  }
  const time = formatHm(new Date(r.value.timestamp));
  const theme = getActiveTheme();
  if (theme === 'themed') {
    const humour = pickHumour(eventType);
    if (humour) { toast(humour); return; }
  }
  toast(plainKey, { time });
}

function pickHumour(eventType) {
  // FR-18: ≥10 lines per type. Try indices 0..9; if all missing, fall back.
  for (let attempts = 0; attempts < 5; attempts++) {
    const i = Math.floor(Math.random() * 10);
    const key = `humour.${eventType}.${i}`;
    const value = t(key);
    if (value && value !== key) return key;
  }
  return null;
}

function formatHm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// @req FR-10
// @req FR-11
// @req FR-14
function renderChip(theme) {
  const wrap = el('section', { className: 'chip-row', aria: { label: t(`chip.label.${theme}`) } });
  const sel = getSelection();
  const offsets = getOffsets();
  const make = (label, onClick, isActive) => {
    const b = el('button', {
      type: 'button',
      className: 'tap chip' + (isActive ? ' chip-active' : ''),
      text: label,
      on: { click: onClick },
    });
    return b;
  };
  wrap.appendChild(make(t('chip.now'), () => { setSelection({ kind: 'now' }); refresh(); }, sel.kind === 'now'));
  for (const m of offsets.filter((m) => m > 0)) {
    wrap.appendChild(make(t('chip.minAgo', { n: m }), () => { setSelection({ kind: 'minAgo', minutes: m }); refresh(); }, sel.kind === 'minAgo' && sel.minutes === m));
  }
  wrap.appendChild(make(t('chip.custom'), () => openChipPicker(), sel.kind === 'custom'));
  return wrap;
}

async function openChipPicker() {
  const input = el('input', { type: 'datetime-local' });
  input.value = toLocalDateTimeInput(new Date());
  const choice = await dialog({
    titleKey: 'chip.custom',
    bodyKey: null,
    content: input,
    actions: [
      { labelKey: 'chip.customCancel', value: { kind: 'cancel' }, cancel: true },
      { labelKey: 'chip.customConfirm', value: { kind: 'confirm' }, primary: true, defaultFocus: true },
    ],
  });
  if (!choice || choice.kind !== 'confirm') return;
  const iso = new Date(input.value).toISOString();
  setSelection({ kind: 'custom', iso });
  refresh();
}

function toLocalDateTimeInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// @req FR-20
// @req FR-21
// @req FR-22
// @req FR-23
// @req FR-24
function renderLastContact(theme, state) {
  const wrap = el('section', { className: 'last-contact', aria: { label: t(`lastContact.title.${theme}`) } });
  wrap.appendChild(el('h2', { text: t(`lastContact.title.${theme}`) }));
  const lastFeed = state.events.filter((e) => e.type === 'feed').slice(-1)[0];
  if (!lastFeed) {
    wrap.appendChild(el('p', { text: t(`lastContact.empty.${theme}`) }));
    return wrap;
  }
  const sideKey = lastFeed.side === 'port'
    ? `lastContact.side.port.${theme}`
    : `lastContact.side.starboard.${theme}`;
  const time = formatHm(new Date(lastFeed.timestamp));
  wrap.appendChild(el('p', { text: `${t(sideKey)} · ${time}` }));
  wrap.appendChild(el('p', { className: 'relative', text: relativeTimeString(new Date(lastFeed.timestamp)) }));
  if (lastFeed.durationMin != null) {
    wrap.appendChild(el('p', { text: t('lastContact.duration', { n: lastFeed.durationMin }) }));
  }
  return wrap;
}

function relativeTimeString(then, now = new Date()) {
  const diffMin = Math.round((now.getTime() - then.getTime()) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return `${h}h ${m}m ago`;
}

// @req FR-26
// @req FR-27
// @req FR-28
function renderToday(theme, state) {
  const wrap = el('section', { className: 'today' });
  wrap.appendChild(el('h2', { text: t(`today.title.${theme}`) }));
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = state.events.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  const feeds = recent.filter((e) => e.type === 'feed').length;
  const wet = recent.filter((e) => e.type === 'wet').length;
  const dirty = recent.filter((e) => e.type === 'dirty').length;
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:0.5rem;' });
  grid.appendChild(badge(t(`today.contacts.${theme}`), feeds));
  grid.appendChild(badge(t(`today.jettisons.${theme}`), wet));
  grid.appendChild(badge(t(`today.ordnance.${theme}`), dirty));
  wrap.appendChild(grid);
  return wrap;
}

// Recent activity panel — shows the events from the last 24h, reverse-
// chronological, with a tap-through to the full Mission Log.  Helps
// parents quickly check "what was the last few things logged" without
// navigating away from the station.
function renderRecent(theme, state) {
  const wrap = el('section', { className: 'recent-activity' });
  wrap.appendChild(el('h2', { text: t(`recent.title.${theme}`) }));
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = state.events
    .filter((e) => new Date(e.timestamp).getTime() >= cutoff)
    .slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (recent.length === 0) {
    wrap.appendChild(el('p', { text: t(`recent.empty.${theme}`), style: 'font-size:0.8rem;color:#aac8aa;' }));
    return wrap;
  }
  const list = el('ol', { className: 'recent-list', style: 'list-style:none;padding:0;margin:0.4rem 0;' });
  for (const ev of recent) list.appendChild(renderRecentEntry(ev, theme));
  wrap.appendChild(list);
  if (state.events.length > recent.length) {
    wrap.appendChild(el('button', {
      type: 'button',
      className: 'tap',
      text: t('recent.viewAll'),
      style: 'margin-top:0.3rem;font-size:0.8rem;',
      on: { click: () => navigate(ROUTES.LOG) },
    }));
  }
  return wrap;
}

function renderRecentEntry(ev, theme) {
  const li = el('li', { className: 'recent-entry', style: 'display:flex;justify-content:space-between;gap:0.5rem;padding:0.25rem 0;border-bottom:1px solid #1f2a1f;font-size:0.85rem;' });
  const left = el('span');
  left.appendChild(el('strong', { text: labelForEvent(ev, theme) }));
  if (ev.type === 'feed' && ev.durationMin != null) {
    left.appendChild(document.createTextNode(' · '));
    left.appendChild(el('span', { text: t('log.entry.duration', { n: ev.durationMin }) }));
  }
  if (ev.type === 'weight') {
    left.appendChild(document.createTextNode(' · '));
    left.appendChild(el('span', { text: t('log.entry.weightDetail', { kg: ev.weightKg, cm: ev.lengthCm }) }));
  }
  li.appendChild(left);
  const right = el('span', { style: 'color:#aac8aa;font-variant-numeric:tabular-nums;white-space:nowrap;' });
  const ts = new Date(ev.timestamp);
  right.textContent = `${formatHm(ts)} · ${relativeTimeString(ts)}`;
  li.appendChild(right);
  return li;
}

function badge(label, n) {
  const b = el('div', { className: 'today-badge', style: 'border:1px solid #1f2a1f;padding:0.4rem;text-align:center;' });
  b.appendChild(el('div', { text: String(n), style: 'font-size:1.4rem;color:#7fff7f;' }));
  b.appendChild(el('div', { text: label, style: 'font-size:0.7rem;color:#aac8aa;text-transform:uppercase;' }));
  return b;
}

// @req FR-35
// @req FR-37
// @req FR-38
// @req FR-39
// @req FR-40
// @req FR-41
// @req FR-94
// @req FR-95
// @req FR-99
// @req FR-100
function renderNextVector(theme, state) {
  const wrap = el('section', { className: 'next-vector' });
  wrap.appendChild(el('h2', { text: t(`vector.title.${theme}`) }));
  const inEmcon = isEmcon();

  const feed = predictFeed(state.events, new Date(), { isEmcon: inEmcon });
  if (feed.status === 'insufficient') {
    wrap.appendChild(el('p', { text: t(feed.subLabelKey, { n: feed.missing }) }));
  } else {
    const time = formatHm(feed.centre);
    const main = el('p', { text: t('vector.feeding', { time, band: feed.band }) });
    if (feed.status === 'overdue') main.appendChild(el('span', { text: ' — ' + t('vector.overdue') }));
    if (feed.status === 'stale') main.style.opacity = '0.6';
    wrap.appendChild(main);
    wrap.appendChild(el('small', { text: t(feed.subLabelKey) + (feed.imported ? ' ' + t('vector.imported') : '') }));
    if (feed.status === 'stale') wrap.appendChild(el('p', { text: t('vector.stale') }));
  }

  for (const dtype of ['wet', 'dirty']) {
    const d = predictDiaper(state.events, dtype, new Date(), { isEmcon: inEmcon });
    if (d.status === 'insufficient') {
      wrap.appendChild(el('p', { text: t(d.subLabelKey, { n: d.missing }) }));
    } else {
      const time = formatHm(d.centre);
      wrap.appendChild(el('p', { text: t(d.titleKey, { time, band: d.band }) }));
      wrap.appendChild(el('small', { text: t(d.branchLabelKey) + (d.imported ? ' ' + t('vector.imported') : '') }));
    }
  }
  return wrap;
}

// @req FR-74
// @req FR-75
// @req FR-77
// @req FR-78
// @req FR-79
function renderDeleteLast(theme, state) {
  const wrap = el('section', { className: 'delete-last' });
  if (state.events.length === 0) {
    const b = el('button', { type: 'button', className: 'tap delete-btn disabled', text: t('deleteLast.empty') });
    b.disabled = true;
    wrap.appendChild(b);
    return wrap;
  }
  const last = state.events[state.events.length - 1];
  const time = formatHm(new Date(last.timestamp));
  const typeLabel = labelForEvent(last, theme);
  const b = el('button', {
    type: 'button',
    className: 'tap delete-btn',
    text: t('deleteLast.button', { type: typeLabel, time }),
    on: {
      click: async () => {
        const choice = await dialog({
          titleKey: 'deleteLast.confirm.title',
          params: { type: typeLabel, time },
          actions: [
            { labelKey: 'deleteLast.confirm.keep', value: 'keep', cancel: true, defaultFocus: true },
            { labelKey: 'deleteLast.confirm.delete', value: 'delete', primary: true },
          ],
          destructive: true,
        });
        if (choice === 'delete') {
          const r = deleteLast();
          if (!r.ok) toast('storage.replaceFailed');
          refresh();
        }
      },
    },
  });
  wrap.appendChild(b);
  wrap.appendChild(el('p', { text: t(`deleteLast.subLabel.${theme}`), style: 'font-size:0.7rem;color:#aac8aa;' }));
  return wrap;
}

function labelForEvent(ev, theme) {
  if (ev.type === 'feed') return t(`log.entry.feed${ev.side === 'port' ? 'Port' : 'Starboard'}.${theme}`);
  if (ev.type === 'wet') return t(`log.entry.wet.${theme}`);
  if (ev.type === 'dirty') return t(`log.entry.dirty.${theme}`);
  if (ev.type === 'weight') return t(`log.entry.weight.${theme}`);
  return ev.type;
}

// @req FR-64
// @req FR-65
// @req FR-66
// @req FR-67
// @req FR-68
function evaluateBackupBanner(state) {
  if (isEmcon()) return;
  const events = state.events.length;
  const lastExport = state.lastExportAt ? new Date(state.lastExportAt).getTime() : null;
  const dismissAt = state.lastNudgeDismissAt ? new Date(state.lastNudgeDismissAt).getTime() : null;
  const now = Date.now();
  if (dismissAt && now - dismissAt < REMIND_LATER_HOURS * 3600 * 1000) {
    return;
  }
  let key = null;
  if (lastExport == null && events >= FIRST_BACKUP_MIN_EVENTS) key = 'backup.first.banner';
  else if (lastExport != null && (now - lastExport) > BACKUP_NUDGE_DAYS * 24 * 3600 * 1000 && events >= BACKUP_NUDGE_MIN_EVENTS) {
    key = 'backup.overdue.banner';
  }
  if (!key) return;
  banner('backup-overdue', key, {}, [
    { labelKey: 'backup.exportNow', onClick: () => triggerExport() },
    { labelKey: 'backup.remindLater', onClick: () => {
      dispatch({ type: 'topLevel/patch', payload: { lastNudgeDismissAt: new Date().toISOString() } });
      writeState(getState());
      // Banner removed on next refresh.
    } },
  ]);
}

async function triggerExport() {
  const { exportAndDownload } = await import('../app.js');
  exportAndDownload();
}

async function openWeightDialog() {
  const wrap = el('div');
  const wInput = el('input', { type: 'number', step: '0.05' });
  const lInput = el('input', { type: 'number', step: '0.5' });
  const tInput = el('input', { type: 'datetime-local' });
  tInput.value = toLocalDateTimeInput(new Date());
  wrap.appendChild(labelled(t('weight.weightLabel'), wInput));
  wrap.appendChild(labelled(t('weight.lengthLabel'), lInput));
  wrap.appendChild(labelled(t('weight.timeLabel'), tInput));
  const choice = await dialog({
    titleKey: 'loadAction.weight.themed',
    content: wrap,
    actions: [
      { labelKey: 'feeding.cancel', value: 'cancel', cancel: true },
      { labelKey: 'weight.confirm', value: 'ok', primary: true, defaultFocus: true },
    ],
  });
  if (choice !== 'ok') return;
  const r = logWeight({
    weightKg: wInput.value,
    lengthCm: lInput.value,
    when: new Date(tInput.value),
  });
  if (!r.ok) {
    if (r.error?.errorKey) toast(r.error.errorKey);
    return;
  }
  toast('event.confirm.weight', { time: formatHm(new Date(r.value.timestamp)) });
  refresh();
}

function labelled(labelText, control) {
  const wrap = el('label', { style: 'display:flex;flex-direction:column;gap:0.2rem;margin:0.4rem 0;' });
  wrap.appendChild(el('span', { text: labelText, style: 'font-size:0.75rem;color:#aac8aa;text-transform:uppercase;' }));
  wrap.appendChild(control);
  return wrap;
}

export function mount(rootEl) {
  mountEl = rootEl;
  refresh();
  unsubState = subscribe(refresh);
  unsubTimer = subscribeFeedTimer(syncTimerTick);
  syncTimerTick(getActiveFeedTimer());
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(refresh, RELATIVE_TIME_TICK_MS);
  // FR-23: refresh on visibility change.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
}

function syncTimerTick(active) {
  if (timerTickHandle) { clearInterval(timerTickHandle); timerTickHandle = null; }
  if (active) timerTickHandle = setInterval(refresh, 1000);
}

function onVisibility() {
  if (document.visibilityState === 'visible') refresh();
}

export function unmount() {
  if (unsubState) unsubState();
  if (unsubTimer) unsubTimer();
  if (tickHandle) clearInterval(tickHandle);
  if (timerTickHandle) clearInterval(timerTickHandle);
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  if (mountEl) mountEl.innerHTML = '';
  mountEl = null;
}
