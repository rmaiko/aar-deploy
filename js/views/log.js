// js/views/log.js — C-18 Mission Log view.
// Reverse-chronological list of events + milestones + system_log entries
// (AMD-001).  Eager-renders the first 500; "load older" reveals more.

import { t } from '../i18n.js';
import { getActiveTheme } from '../theme.js';
import { getState, subscribe } from '../state.js';
import { isEmcon, getImportedState } from '../emcon.js';
import { navigate } from '../router.js';
import { ROUTES, MISSION_LOG_PAGE_SIZE } from '../config.js';
import { weightLengthCharts } from './charts.js';
import { renderIntervalHistograms } from './intervals.js';
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
  // AMD-010: inter-event interval histograms (feed/wet/dirty).
  const intervals = renderIntervalHistograms(state);
  if (intervals) mountEl.appendChild(intervals);
  const entries = combineEntries(state);
  if (entries.length === 0) {
    mountEl.appendChild(el('p', { className: 'empty', text: t('log.empty') }));
    return;
  }
  const visible = entries.slice(0, pageSize);
  const list = el('ol', { className: 'log-list', style: 'list-style:none;padding:0;margin:0;' });
  // Use DocumentFragment for the eager 500.
  const frag = document.createDocumentFragment();
  for (const entry of visible) frag.appendChild(renderEntry(entry, theme));
  list.appendChild(frag);
  mountEl.appendChild(list);
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
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap nav-back',
    text: t('nav.return'),
    on: { click: () => navigate(ROUTES.STATION) },
  }));
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

function renderEntry(entry, theme) {
  const li = el('li', { className: `log-entry log-entry-${entry.kind}`, style: 'padding:0.4rem 0.6rem;border-bottom:1px solid #1f2a1f;' });
  const ts = new Date(entry.timestamp);
  const isToday = (Date.now() - ts.getTime()) < 24 * 3600 * 1000;
  if (isToday) li.classList.add('log-today');
  if (entry.kind === 'milestone') return renderMilestone(li, entry, theme, ts);
  if (entry.kind === 'system') return renderSystem(li, entry, theme, ts);
  return renderEvent(li, entry, theme, ts);
}

function renderEvent(li, ev, theme, ts) {
  const labelKey = ev.type === 'feed'
    ? `log.entry.feed${ev.side === 'port' ? 'Port' : 'Starboard'}.${theme}`
    : `log.entry.${ev.type}.${theme}`;
  li.appendChild(el('strong', { text: t(labelKey) }));
  li.appendChild(document.createTextNode(' · '));
  li.appendChild(el('time', { text: formatTime(ts), attrs: { dateTime: ev.timestamp } }));
  if (ev.type === 'feed' && ev.durationMin != null) {
    li.appendChild(document.createTextNode(' · '));
    li.appendChild(el('span', { text: t('log.entry.duration', { n: ev.durationMin }) }));
  }
  if (ev.type === 'weight') {
    li.appendChild(document.createTextNode(' · '));
    li.appendChild(el('span', { text: t('log.entry.weightDetail', { kg: ev.weightKg, cm: ev.lengthCm }) }));
  }
  if (ev.notes) {
    li.appendChild(el('div', { text: '✎ ' + ev.notes, style: 'font-size:0.8rem;color:#aac8aa;margin-top:0.15rem;' }));
  }
  return li;
}

// @req FR-108
function renderMilestone(li, m, theme, ts) {
  li.classList.add('log-badge', 'log-badge-milestone');
  const labelKey = milestoneLabelKey(m.type, theme);
  const params = m.payload ?? {};
  if (m.type === 'days_flown') params.n = params.day;
  if (m.type === 'total_transfers') params.n = params.count;
  if (m.type === 'longest_feeding_gap') params.n = params.minutes;
  li.appendChild(el('strong', { text: '★ ' + t(labelKey, params) }));
  li.appendChild(document.createTextNode(' · '));
  li.appendChild(el('time', { text: formatTime(ts), attrs: { dateTime: m.awardedAt } }));
  return li;
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

// @req FR-110
function renderSystem(li, s, theme, ts) {
  li.classList.add('log-badge', 'log-badge-system');
  li.appendChild(el('strong', { text: '◆ ' + t('log.milestoneRebuilt') }));
  li.appendChild(document.createTextNode(' · '));
  li.appendChild(el('time', { text: formatTime(ts), attrs: { dateTime: s.timestamp } }));
  return li;
}

function formatTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
