// js/views/station.js — C-17 Loadmaster Station view.
//
// Top-level "home" view: log buttons, LAST CONTACT panel,
// TODAY widget, NEXT VECTOR panel, DELETE LAST button, banner host.

import { t } from '../i18n.js';
import { getActiveTheme, tk } from '../theme.js';
import { getState, subscribe } from '../state.js';
import {
  logFeed, logDiaper, deleteLast,
  startFeedTimer, stopFeedTimerAndLog, cancelFeedTimer,
  getActiveFeedTimer, subscribeFeedTimer,
  updateEvent,
} from '../events.js';
import { dispatch } from '../state.js';
import { writeState } from '../storage.js';
import { predictFeed, predictDiaper } from '../prediction.js';
import { isEmcon, getImportedState } from '../emcon.js';
import { navigate } from '../router.js';
import { ROUTES } from '../config.js';
import { toast, dialog, banner, removeBanner } from '../overlays.js';
import { getQueue } from '../sync.js';
import { getSession } from '../auth.js';
import { isReminderEnvelope } from '../reminders.js';
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
  mountEl.appendChild(renderHeader(theme, state));
  mountEl.appendChild(renderTimerPanel(theme));
  mountEl.appendChild(renderActions(theme, state));
  mountEl.appendChild(renderStatus(theme, state));
  mountEl.appendChild(renderToday(theme, state));
  mountEl.appendChild(renderRecent(theme, state));
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
function renderHeader(theme, state) {
  const h = el('header', { className: 'station-header' });
  const titleWrap = el('div', { className: 'station-titles' });
  titleWrap.appendChild(el('h1', { text: t(`app.title.${theme}`) }));
  // When cloud is enabled and a wing is active, the subtitle shows the
  // wing's name so the user can tell at a glance which family's data
  // they're looking at. EMCON imports always use the placeholder.
  const cloud = (isEmcon() ? null : state?.cloud) || {};
  const subtitle = (cloud.enabled && cloud.activeFamilyName)
    ? cloud.activeFamilyName
    : t(`app.subtitle.${theme}`);
  titleWrap.appendChild(el('p', { className: 'sub', text: subtitle }));
  h.appendChild(titleWrap);
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
  const timerActive = !!getActiveFeedTimer();
  const make = (key, plainKey, onClick, { disabled = false } = {}) => {
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
    if (disabled) b.disabled = true;
    return b;
  };
  // Single CONTACT button — opens a side+mode modal. While a feed timer
  // is active, the button is disabled (the timer panel owns Finish/Cancel).
  const contactKey = timerActive ? tk('loadAction.contact.disabled') : tk('loadAction.contact');
  const contactPlain = timerActive ? 'loadAction.contact.disabled.plain' : 'loadAction.contact.plain';
  wrap.appendChild(make(contactKey, contactPlain, () => {
    if (handleEmconBlocked()) return;
    if (getActiveFeedTimer()) return;
    openContactDialog();
  }, { disabled: timerActive }));
  wrap.appendChild(make(tk('loadAction.jettisoned'), 'loadAction.jettisoned.plain', () => {
    if (handleEmconBlocked()) return;
    const r = logDiaper({ type: 'wet' });
    handleLogResult(r, 'event.confirm.wet', 'wet');
  }));
  wrap.appendChild(make(tk('loadAction.ordnance'), 'loadAction.ordnance.plain', () => {
    if (handleEmconBlocked()) return;
    const r = logDiaper({ type: 'dirty' });
    handleLogResult(r, 'event.confirm.dirty', 'dirty');
  }));
  return wrap;
}

// CONTACT modal. Single button → modal with two confirms (PORT, STARBOARD)
// at the bottom + radio for mode (Starting now / Just finished, duration N).
// While a timer is active the CONTACT button is disabled and this never fires.
const CONTACT_DURATION_CHIPS = [5, 10, 15, 20, 30, 45, 60];
const CONTACT_DEFAULT_DURATION_MIN = 15;

async function openContactDialog() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'min-width:18rem;';
  let mode = 'startingNow'; // 'startingNow' | 'justFinished'
  let durationMin = CONTACT_DEFAULT_DURATION_MIN;

  const radio = (id, labelKey, value) => {
    const row = el('label', { style: 'display:flex;gap:0.5rem;align-items:center;padding:0.4rem 0.2rem;cursor:pointer;' });
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'contact-mode';
    input.id = id;
    input.value = value;
    if (value === mode) input.checked = true;
    input.addEventListener('change', () => {
      if (input.checked) { mode = value; updateChipState(); }
    });
    row.appendChild(input);
    row.appendChild(el('span', { text: t(labelKey) }));
    return { row, input };
  };

  const startingRow = radio('contact-mode-now', `contact.dialog.startingNow.${getActiveTheme()}`, 'startingNow');
  const finishedRow = radio('contact-mode-fin', `contact.dialog.justFinished.${getActiveTheme()}`, 'justFinished');
  wrap.appendChild(startingRow.row);
  wrap.appendChild(finishedRow.row);

  // Duration chip strip (visible only when "Just finished" is active).
  const chipWrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:0.3rem;margin:0.2rem 0 0.6rem 1.6rem;' });
  const chipBtns = [];
  for (const m of CONTACT_DURATION_CHIPS) {
    const c = el('button', {
      type: 'button',
      className: 'tap contact-duration-chip',
      text: t('contact.dialog.minutesSuffix', { n: m }),
      style: 'min-height:36px;padding:0.25rem 0.6rem;font-size:0.85rem;',
      on: { click: () => {
        durationMin = m;
        if (mode !== 'justFinished') {
          mode = 'justFinished';
          finishedRow.input.checked = true;
          startingRow.input.checked = false;
          updateChipState();
        }
        for (const cb of chipBtns) cb.classList.toggle('chip-active', Number(cb.dataset.min) === durationMin);
      } },
    });
    c.dataset.min = String(m);
    if (m === durationMin) c.classList.add('chip-active');
    chipBtns.push(c);
    chipWrap.appendChild(c);
  }
  wrap.appendChild(chipWrap);

  function updateChipState() {
    const active = mode === 'justFinished';
    chipWrap.style.opacity = active ? '1' : '0.4';
    for (const cb of chipBtns) cb.disabled = !active;
  }
  updateChipState();

  const choice = await dialog({
    titleKey: `contact.dialog.title.${getActiveTheme()}`,
    content: wrap,
    actions: [
      { labelKey: 'contact.dialog.cancel', value: 'cancel', cancel: true },
      { labelKey: `contact.dialog.port.${getActiveTheme()}`, value: 'port', primary: true },
      { labelKey: `contact.dialog.starboard.${getActiveTheme()}`, value: 'starboard', primary: true, defaultFocus: true },
    ],
  });
  if (choice !== 'port' && choice !== 'starboard') return;
  const side = choice;
  if (mode === 'startingNow') {
    startFeedTimer(side);
    refresh();
    return;
  }
  // justFinished: log a feed with timestamp = now − durationMin and durationMin set.
  const startMs = Date.now() - durationMin * 60_000;
  const r = logFeed({ side, durationMin, when: new Date(startMs) });
  handleLogResult(r, side === 'port' ? 'event.confirm.feedPort' : 'event.confirm.feedStarboard',
    side === 'port' ? 'feedPort' : 'feedStarboard');
  refresh();
}

// Live-timer panel; rendered when a CONTACT timer is running.
function renderTimerPanel(theme) {
  const active = getActiveFeedTimer();
  const wrap = el('section', { className: 'feed-timer' });
  if (!active) {
    wrap.style.cssText = 'display:none;';
    return wrap;
  }
  wrap.style.cssText = 'border:1px solid #7fff7f;background:#0d1f0d;color:#7fff7f;padding:0.6rem 0.6rem;margin:0.4rem 0;text-align:center;';
  const elapsed = formatElapsed(Date.now() - active.startedAt);
  const titleKey = active.side === 'port'
    ? `feed.timer.runningPort.${theme}`
    : `feed.timer.runningStarboard.${theme}`;
  wrap.appendChild(el('strong', {
    text: t(titleKey, { elapsed }),
    style: 'display:block;font-size:1.15rem;font-variant-numeric:tabular-nums;margin-bottom:0.5rem;',
  }));
  const row = el('div', { style: 'display:flex;gap:0.4rem;justify-content:center;flex-wrap:wrap;' });
  // Finish (primary) — stops timer, logs the feed event.
  row.appendChild(el('button', {
    type: 'button',
    className: 'tap timer-finish',
    text: t(`feed.timer.finish.${theme}`),
    on: {
      click: () => {
        const side = active.side;
        const r = stopFeedTimerAndLog();
        if (!r.ok) { toast('storage.replaceFailed'); return; }
        handleLogResult(r, side === 'port' ? 'event.confirm.feedPort' : 'event.confirm.feedStarboard',
          side === 'port' ? 'feedPort' : 'feedStarboard');
        refresh();
      },
    },
  }));
  // Cancel (secondary, warn) — discards without logging.
  row.appendChild(el('button', {
    type: 'button',
    className: 'tap',
    text: t('feed.timer.cancel'),
    style: 'font-size:0.85rem;background:transparent;color:#ffb84d;border-color:#ffb84d;',
    on: { click: () => { cancelFeedTimer(); refresh(); } },
  }));
  wrap.appendChild(row);
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

function toLocalDateTimeInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// @req FR-20
// @req FR-21
// @req FR-22
// @req FR-23
// @req FR-24
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
//
// LAST CONTACT / NEXT VECTOR are paired in one panel — the user reads
// "what just happened, what's next" as a single thought.
function renderStatus(theme, state) {
  const wrap = el('section', { className: 'status-panel', aria: { label: t(`lastContact.title.${theme}`) } });
  wrap.appendChild(renderLastCol(theme, state));
  wrap.appendChild(renderNextCol(theme, state));
  return wrap;
}

function renderLastCol(theme, state) {
  const col = el('div', { className: 'status-col status-col-last' });
  col.appendChild(el('h2', { text: t(`lastContact.title.${theme}`) }));
  const lastFeed = state.events.filter((e) => e.type === 'feed').slice(-1)[0];
  if (!lastFeed) {
    col.appendChild(el('p', { text: t(`lastContact.empty.${theme}`) }));
    return col;
  }
  const sideKey = lastFeed.side === 'port'
    ? `lastContact.side.port.${theme}`
    : `lastContact.side.starboard.${theme}`;
  const time = formatHm(new Date(lastFeed.timestamp));
  col.appendChild(el('p', { className: 'status-primary', text: `${t(sideKey)} · ${time}` }));
  col.appendChild(el('p', { className: 'relative', text: relativeTimeString(new Date(lastFeed.timestamp)) }));
  if (lastFeed.durationMin != null) {
    col.appendChild(el('p', { className: 'status-detail', text: t('lastContact.duration', { n: lastFeed.durationMin }) }));
  }
  return col;
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
// chronological, with a tap-through to the full Mission Log. Rendered
// as the same table shape as the Mission Log (day-divider rows + Time
// / Type / Details columns) so the two views stay visually aligned.
function renderRecent(theme, state) {
  const wrap = el('section', { className: 'recent-activity' });
  wrap.appendChild(el('h2', { text: t(`recent.title.${theme}`) }));
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = state.events
    // Hide reminder envelope events ([REMINDER] / [REMINDER-CANCEL]).
    // They're machinery notes, not user-visible activity.
    .filter((e) => !(e.type === 'note' && isReminderEnvelope(e.notes)))
    .filter((e) => new Date(e.timestamp).getTime() >= cutoff)
    .slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (recent.length === 0) {
    wrap.appendChild(el('p', { text: t(`recent.empty.${theme}`), style: 'font-size:0.8rem;color:#aac8aa;' }));
    return wrap;
  }
  wrap.appendChild(renderRecentTable(recent, theme));
  wrap.appendChild(el('p', { text: t('recent.editHint'), style: 'font-size:0.7rem;color:#aac8aa;margin-top:0.2rem;' }));
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

function renderRecentTable(entries, theme) {
  const table = el('table', { className: 'log-table recent-table' });
  const thead = el('thead');
  const trh = el('tr');
  trh.appendChild(el('th', { className: 'log-time-th', text: t('log.col.time') }));
  trh.appendChild(el('th', { className: 'log-type-th', text: t('log.col.type') }));
  trh.appendChild(el('th', { className: 'log-details-th', text: t('log.col.details') }));
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = el('tbody');
  const todayKey = dayKey(new Date());
  const dayFmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
  let lastDay = null;
  for (const ev of entries) {
    const ts = new Date(ev.timestamp);
    const dk = dayKey(ts);
    if (dk !== lastDay) {
      const tr = el('tr', {
        className: 'log-day-divider' + (dk === todayKey ? ' log-day-today' : ''),
      });
      tr.appendChild(el('td', { attrs: { colspan: '3' }, text: dayFmt.format(ts) }));
      tbody.appendChild(tr);
      lastDay = dk;
    }
    tbody.appendChild(buildRecentRow(ev, theme, ts));
  }
  table.appendChild(tbody);
  return table;
}

function buildRecentRow(ev, theme, ts) {
  const tr = el('tr', {
    className: 'log-row log-row-event recent-entry',
    attrs: { tabindex: '0', role: 'button' },
    on: {
      click: () => openEditDialog(ev),
      keydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openEditDialog(ev);
        }
      },
    },
  });
  tr.appendChild(el('td', { className: 'log-time', text: formatHm(ts) }));
  // Mirror Mission Log: feeds collapse to a generic CONTACT/Feed type
  // and push the side (port/starboard) into the Details column so the
  // Type column stays compact.
  const typeKey = ev.type === 'feed'
    ? `loadAction.contact.${theme}`
    : `log.entry.${ev.type}.${theme}`;
  tr.appendChild(el('td', { className: 'log-type', text: t(typeKey) }));
  const parts = [];
  if (ev.type === 'feed') {
    parts.push(t(`lastContact.side.${ev.side === 'port' ? 'port' : 'starboard'}.${theme}`));
    if (ev.durationMin != null) parts.push(t('log.entry.duration', { n: ev.durationMin }));
  }
  if (ev.type === 'weight') {
    parts.push(t('log.entry.weightDetail', { kg: ev.weightKg, cm: ev.lengthCm }));
  }
  if (ev.notes) parts.push('✎ ' + ev.notes);
  tr.appendChild(el('td', { className: 'log-details', text: parts.join(' · ') }));
  return tr;
}

function dayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Edit-entry dialog. Per-type fields + free-form notes.
async function openEditDialog(ev) {
  if (handleEmconBlocked()) return;
  const wrap = document.createElement('div');
  const fields = {};
  if (ev.type === 'feed') {
    const sideSel = document.createElement('select');
    for (const s of ['port', 'starboard']) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s === 'port' ? t('edit.sidePort') : t('edit.sideStarboard');
      if (ev.side === s) opt.selected = true;
      sideSel.appendChild(opt);
    }
    fields.side = sideSel;
    wrap.appendChild(labelled(t('edit.sideLabel'), sideSel));
    const dur = document.createElement('input');
    dur.type = 'number';
    dur.min = '0'; dur.max = '240'; dur.step = '1';
    if (ev.durationMin != null) dur.value = String(ev.durationMin);
    fields.durationMin = dur;
    wrap.appendChild(labelled(t('feeding.durationLabel.plain'), dur));
  }
  if (ev.type === 'weight') {
    const w = document.createElement('input');
    w.type = 'number'; w.step = '0.05'; w.value = String(ev.weightKg ?? '');
    fields.weightKg = w;
    wrap.appendChild(labelled(t('weight.weightLabel'), w));
    const l = document.createElement('input');
    l.type = 'number'; l.step = '0.5'; l.value = String(ev.lengthCm ?? '');
    fields.lengthCm = l;
    wrap.appendChild(labelled(t('weight.lengthLabel'), l));
  }
  // Timestamp on every event type.
  const tInput = document.createElement('input');
  tInput.type = 'datetime-local';
  tInput.value = toLocalDateTimeInput(new Date(ev.timestamp));
  fields.timestamp = tInput;
  wrap.appendChild(labelled(t('edit.timestampLabel'), tInput));
  // Notes. Reminder-envelope notes ([REMINDER]/[REMINDER-CANCEL]) are
  // structured payloads — lock the textarea so a stray edit can't break
  // their JSON. Timestamp can still be edited.
  const notes = document.createElement('textarea');
  notes.rows = 3;
  notes.maxLength = 500;
  notes.style.cssText = 'width:100%;font:inherit;background:#0a0d0a;color:#c8e6c9;border:1px solid #1f2a1f;padding:0.3rem;';
  notes.value = ev.notes ?? '';
  const isEnvelope = ev.type === 'note' && isReminderEnvelope(ev.notes);
  if (isEnvelope) {
    notes.readOnly = true;
    notes.style.opacity = '0.55';
  }
  fields.notes = notes;
  wrap.appendChild(labelled(t('edit.notesLabel'), notes));

  const choice = await dialog({
    titleKey: 'edit.title',
    content: wrap,
    actions: [
      { labelKey: 'edit.cancel', value: 'cancel', cancel: true },
      { labelKey: 'edit.save', value: 'save', primary: true, defaultFocus: true },
    ],
  });
  if (choice !== 'save') return;
  const patch = {};
  if (ev.type === 'feed') {
    patch.side = fields.side.value;
    patch.durationMin = fields.durationMin.value === '' ? null : Number(fields.durationMin.value);
  }
  if (ev.type === 'weight') {
    patch.weightKg = Number(fields.weightKg.value);
    patch.lengthCm = Number(fields.lengthCm.value);
  }
  patch.timestamp = new Date(fields.timestamp.value).toISOString();
  patch.notes = fields.notes.value.trim();
  const r = updateEvent(ev.id, patch);
  if (!r.ok) {
    if (r.error?.errorKey) toast(r.error.errorKey);
    else toast('storage.replaceFailed');
    return;
  }
  toast('edit.savedToast');
  refresh();
}

function badge(label, n) {
  const b = el('div', { className: 'today-badge', style: 'border:1px solid #1f2a1f;padding:0.4rem;text-align:center;' });
  b.appendChild(el('div', { text: String(n), style: 'font-size:1.4rem;color:#7fff7f;' }));
  b.appendChild(el('div', { text: label, style: 'font-size:0.7rem;color:#aac8aa;text-transform:uppercase;' }));
  return b;
}

function renderNextCol(theme, state) {
  const col = el('div', { className: 'status-col status-col-next' });
  col.appendChild(el('h2', { text: t(`vector.title.${theme}`) }));
  const inEmcon = isEmcon();

  const feed = predictFeed(state.events, new Date(), { isEmcon: inEmcon });
  if (feed.status === 'insufficient') {
    col.appendChild(el('p', { className: 'status-detail', text: t(feed.subLabelKey, { n: feed.missing }) }));
  } else {
    // When overdue, show the original (un-projected) centre alongside the
    // "DUE NOW" tag. The reprojected centre is a forward-looking hint that
    // makes sense as the displayed time only when status='ok'/'stale'; pairing
    // it with "DUE NOW" reads contradictory.
    const displayCentre = feed.status === 'overdue' ? feed.originalCentre : feed.centre;
    const time = formatHm(displayCentre);
    const main = el('p', { className: 'status-primary', text: t('vector.feeding', { time, band: feed.band }) });
    if (feed.status === 'overdue') main.appendChild(el('span', { className: 'status-tag', text: ' — ' + t('vector.overdue') }));
    if (feed.status === 'stale') main.style.opacity = '0.6';
    col.appendChild(main);
    col.appendChild(el('small', { text: t(feed.subLabelKey) + (feed.imported ? ' ' + t('vector.imported') : '') }));
    if (feed.status === 'stale') col.appendChild(el('p', { className: 'status-detail', text: t('vector.stale') }));
  }

  // Only the next-ordnance prediction is shown; the wet/jettison
  // prediction is suppressed (low signal vs. visual noise).
  const d = predictDiaper(state.events, 'dirty', new Date(), { isEmcon: inEmcon });
  if (d.status === 'insufficient') {
    col.appendChild(el('p', { className: 'status-detail', text: t(d.subLabelKey, { n: d.missing }) }));
  } else {
    const time = formatHm(d.centre);
    col.appendChild(el('p', { className: 'status-secondary', text: t(d.titleKey, { time, band: d.band }) }));
    col.appendChild(el('small', { text: t(d.branchLabelKey) + (d.imported ? ' ' + t('vector.imported') : '') }));
  }
  return col;
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
  if (ev.type === 'note') return t(`log.entry.note.${theme}`);
  return ev.type;
}

// @req FR-64
// @req FR-65
// @req FR-66
// @req FR-67
// @req FR-68
function evaluateBackupBanner(state) {
  if (isEmcon()) { removeBanner('backup-overdue'); return; }

  // Cloud-aware path: when Mission Network is enabled and healthy
  // (signed in + active wing + drained queue), the cloud is the
  // backup — suppress the local-export nudge. When enabled but
  // unhealthy, surface a distinct "changes not synced" warning so
  // local-only edits aren't silently unprotected.
  const cloud = state?.cloud || {};
  if (cloud.enabled) {
    const signedIn = !!getSession();
    const queueLen = getQueue().length;
    if (signedIn && cloud.activeFamilyId && queueLen === 0) {
      removeBanner('backup-overdue');
      return;
    }
    const key = (signedIn && cloud.activeFamilyId)
      ? 'backup.cloud.queued.banner'
      : 'backup.cloud.offline.banner';
    banner('backup-overdue', key, { count: queueLen }, [
      { labelKey: 'backup.openSettings', onClick: () => navigate(ROUTES.SETTINGS) },
    ]);
    return;
  }

  const events = state.events.length;
  const lastExport = state.lastExportAt ? new Date(state.lastExportAt).getTime() : null;
  const dismissAt = state.lastNudgeDismissAt ? new Date(state.lastNudgeDismissAt).getTime() : null;
  const now = Date.now();
  if (dismissAt && now - dismissAt < REMIND_LATER_HOURS * 3600 * 1000) {
    removeBanner('backup-overdue');
    return;
  }
  let key = null;
  if (lastExport == null && events >= FIRST_BACKUP_MIN_EVENTS) key = 'backup.first.banner';
  else if (lastExport != null && (now - lastExport) > BACKUP_NUDGE_DAYS * 24 * 3600 * 1000 && events >= BACKUP_NUDGE_MIN_EVENTS) {
    key = 'backup.overdue.banner';
  }
  if (!key) { removeBanner('backup-overdue'); return; }
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
