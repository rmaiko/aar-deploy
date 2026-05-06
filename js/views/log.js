// js/views/log.js — C-18 Mission Log view.
// Reverse-chronological list of events + milestones + system_log entries
// (AMD-001).  Eager-renders the first 500; "load older" reveals more.

import { t } from '../i18n.js';
import { getActiveTheme } from '../theme.js';
import { getState, subscribe } from '../state.js';
import { isEmcon, getImportedState } from '../emcon.js';
import { MISSION_LOG_PAGE_SIZE } from '../config.js';
import { weightLengthCharts } from './charts.js';
import { renderIntervalHistograms } from './intervals.js';
import { renderHourlyHistograms } from './hourly.js';
import { isReminderEnvelope } from '../reminders.js';

let mountEl = null;
let unsub = null;
let pageSize = MISSION_LOG_PAGE_SIZE;

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

function tsMs(x) { return new Date(x.timestamp ?? x.awardedAt).getTime(); }

function refresh() {
  if (!mountEl) return;
  const state = isEmcon() ? (getImportedState() ?? getState()) : getState();
  const theme = getActiveTheme();
  mountEl.innerHTML = '';
  mountEl.appendChild(renderHeader(theme));
  const charts = weightLengthCharts(state);
  if (charts) {
    const wrap = el('section', { className: 'log-charts', style: 'display:flex;flex-direction:column;gap:0.6rem;margin:0.6rem 0;' });
    wrap.appendChild(charts.weightSvg);
    wrap.appendChild(charts.lengthSvg);
    wrap.appendChild(el('p', {
      text: 'Anchor: first logged event = month 0 on the X axis. Bands are an indicative WHO-style fan, not clinical reference.',
      style: 'font-size:0.7rem;color:#aac8aa;margin:0;',
    }));
    mountEl.appendChild(wrap);
  }
  // AMD-010: inter-event interval histograms (feed/dirty).
  const intervals = renderIntervalHistograms(state);
  if (intervals) mountEl.appendChild(intervals);
  // Hour-of-day distribution histograms (feed/dirty).
  const hourly = renderHourlyHistograms(state);
  if (hourly) mountEl.appendChild(hourly);
  const entries = combineEntries(state);
  if (entries.length === 0) {
    mountEl.appendChild(el('p', { className: 'empty', text: t('log.empty') }));
    return;
  }
  const visible = entries.slice(0, pageSize);
  mountEl.appendChild(renderTable(visible, theme));
  if (entries.length > pageSize) {
    mountEl.appendChild(el('button', {
      type: 'button',
      className: 'tap load-older',
      text: t('log.loadOlder'),
      on: { click: () => { pageSize += MISSION_LOG_PAGE_SIZE; refresh(); } },
    }));
  }
}

// @req FR-29
function renderHeader(theme) {
  const wrap = el('header', { className: 'log-header' });
  wrap.appendChild(el('h1', { text: t(`log.title.${theme}`) }));
  return wrap;
}

// @req FR-29
// @req FR-30
// @req FR-31
// @req FR-32
// @req FR-34
// @req FR-108
// @req FR-110
function combineEntries(state) {
  const events = (state.events ?? [])
    // Hide reminder envelope events — they're machinery, not user activity.
    .filter((e) => !(e.type === 'note' && isReminderEnvelope(e.notes)))
    .map((e) => ({ kind: 'event', ...e }));
  const milestones = (state.milestones ?? []).map((m) => ({ kind: 'milestone', ...m, timestamp: m.awardedAt }));
  const sys = (state.system_log ?? []).map((s) => ({ kind: 'system', ...s }));
  return [...events, ...milestones, ...sys].sort((a, b) => tsMs(b) - tsMs(a));
}

// One big table with day-divider rows so columns stay aligned across
// every day. Eager-renders the first `pageSize` entries for FR-34.
function renderTable(entries, theme) {
  const table = el('table', { className: 'log-table' });
  const thead = el('thead');
  const trh = el('tr');
  trh.appendChild(el('th', { className: 'log-time-th', text: t('log.col.time') }));
  trh.appendChild(el('th', { className: 'log-type-th', text: t('log.col.type') }));
  trh.appendChild(el('th', { className: 'log-details-th', text: t('log.col.details') }));
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = el('tbody');
  const frag = document.createDocumentFragment();
  const todayKey = dayKey(new Date());
  const dayFmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
  let lastDay = null;
  for (const entry of entries) {
    const ts = new Date(entry.timestamp ?? entry.awardedAt);
    const dk = dayKey(ts);
    if (dk !== lastDay) {
      const tr = el('tr', {
        className: 'log-day-divider' + (dk === todayKey ? ' log-day-today' : ''),
      });
      tr.appendChild(el('td', { attrs: { colspan: '3' }, text: dayFmt.format(ts) }));
      frag.appendChild(tr);
      lastDay = dk;
    }
    frag.appendChild(buildRow(entry, theme, ts));
  }
  tbody.appendChild(frag);
  table.appendChild(tbody);
  return table;
}

function buildRow(entry, theme, ts) {
  const tr = el('tr', { className: `log-row log-row-${entry.kind}` });
  tr.appendChild(el('td', { className: 'log-time', text: formatHm(ts) }));

  if (entry.kind === 'milestone') {
    const labelKey = milestoneLabelKey(entry.type, theme);
    const params = { ...(entry.payload ?? {}) };
    if (entry.type === 'days_flown') params.n = params.day;
    if (entry.type === 'total_transfers') params.n = params.count;
    if (entry.type === 'longest_feeding_gap') params.n = params.minutes;
    tr.appendChild(el('td', { className: 'log-type', text: '★ ' + t(labelKey, params) }));
    tr.appendChild(el('td', { className: 'log-details', text: '' }));
    return tr;
  }
  if (entry.kind === 'system') {
    tr.appendChild(el('td', { className: 'log-type', text: '◆ ' + t('log.milestoneRebuilt') }));
    tr.appendChild(el('td', { className: 'log-details', text: '' }));
    return tr;
  }
  // event — for feeds we use a generic "CONTACT" / "Feed" type label
  // and move the side (port/starboard) into the DETAILS column so the
  // TYPE column stays compact.
  const labelKey = entry.type === 'feed'
    ? `loadAction.contact.${theme}`
    : `log.entry.${entry.type}.${theme}`;
  tr.appendChild(el('td', { className: 'log-type', text: t(labelKey) }));
  const parts = [];
  if (entry.type === 'feed') {
    parts.push(t(`lastContact.side.${entry.side === 'port' ? 'port' : 'starboard'}.${theme}`));
    if (entry.durationMin != null) {
      parts.push(t('log.entry.duration', { n: entry.durationMin }));
    }
  }
  if (entry.type === 'weight') {
    parts.push(t('log.entry.weightDetail', { kg: entry.weightKg, cm: entry.lengthCm }));
  }
  if (entry.notes) parts.push('✎ ' + entry.notes);
  tr.appendChild(el('td', { className: 'log-details', text: parts.join(' · ') }));
  return tr;
}

function milestoneLabelKey(type, theme) {
  const map = {
    weight_threshold: 'milestone.weightThreshold',
    longest_feeding_gap: 'milestone.longestGap',
    first_quiet_night: 'milestone.firstQuietNight',
    settled_into_routine: 'milestone.routine',
    days_flown: 'milestone.daysFlown',
    total_transfers: 'milestone.transfers',
  };
  return `${map[type] ?? 'milestone.unknown'}.${theme}`;
}

function dayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatHm(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function mount(rootEl) {
  mountEl = rootEl;
  pageSize = MISSION_LOG_PAGE_SIZE;
  refresh();
  unsub = subscribe(refresh);
}

export function unmount() {
  if (unsub) unsub();
  if (mountEl) mountEl.innerHTML = '';
  mountEl = null;
}
