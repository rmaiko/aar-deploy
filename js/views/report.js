// js/views/report.js — C-23 Pediatrician Report view (plain language; print-friendly).

import { t } from '../i18n.js';
import { getState, dispatch } from '../state.js';
import { writeState } from '../storage.js';
import { navigate } from '../router.js';
import { ROUTES } from '../config.js';

let mountEl = null;
let activeWindow = 'last7';

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

function refresh() {
  if (!mountEl) return;
  const state = getState();
  // FR-129: plain language unconditional.
  mountEl.setAttribute('data-theme', 'plain');
  mountEl.innerHTML = '';
  mountEl.appendChild(renderSelector(state));
  mountEl.appendChild(renderReport(state));
}

function renderSelector(state) {
  const wrap = el('section', { className: 'report-selector' });
  const optionGroup = el('div');
  const opts = [
    { id: 'last7', labelKey: 'report.window.last7' },
    { id: 'last30', labelKey: 'report.window.last30' },
    { id: 'sinceVisit', labelKey: 'report.window.sinceVisit' },
    { id: 'allTime', labelKey: 'report.window.allTime' },
  ];
  for (const o of opts) {
    const btn = el('button', {
      type: 'button',
      className: 'tap' + (activeWindow === o.id ? ' active' : ''),
      text: t(o.labelKey),
      on: { click: () => { activeWindow = o.id; refresh(); } },
    });
    optionGroup.appendChild(btn);
  }
  wrap.appendChild(optionGroup);
  // Set date link
  const dateInput = el('input', { type: 'date' });
  if (state.lastVisitDate) dateInput.value = state.lastVisitDate;
  dateInput.addEventListener('change', () => {
    dispatch({ type: 'topLevel/patch', payload: { lastVisitDate: dateInput.value || null } });
    writeState(getState());
    refresh();
  });
  wrap.appendChild(el('label', {}, [el('span', { text: t('report.setDate') }), dateInput]));
  if (state.lastVisitDate) wrap.appendChild(el('p', { text: t('report.setDate.stored', { date: state.lastVisitDate }) }));

  if (activeWindow === 'sinceVisit' && !state.lastVisitDate) {
    wrap.appendChild(el('p', { text: t('report.guardSetVisit') }));
  }
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap nav-back',
    text: t('report.back'),
    on: { click: () => navigate(ROUTES.SETTINGS) },
  }));
  return wrap;
}

// @req FR-125
// @req FR-128
// @req FR-129
// @req FR-130
// @req FR-131
// @req FR-132
// @req FR-133
function renderReport(state) {
  const wrap = el('section', { className: 'report-body', attrs: { 'data-theme': 'plain' } });
  const events = sliceWindow(state, activeWindow);
  if (activeWindow === 'sinceVisit' && !state.lastVisitDate) return wrap;

  // Header
  const header = el('header');
  header.appendChild(el('h1', { text: t('report.title') + ' — ' + t('report.subject') }));
  header.appendChild(el('p', { text: new Date().toISOString().slice(0, 10) }));
  header.appendChild(el('button', {
    type: 'button',
    className: 'tap print-btn',
    text: t('report.print'),
    on: { click: () => window.print() },
  }));
  wrap.appendChild(header);

  if (events.length === 0) {
    wrap.appendChild(el('p', { text: t('report.empty') }));
    return wrap;
  }

  wrap.appendChild(el('h2', { text: t('report.section.weight') }));
  wrap.appendChild(renderWeightSvg(events));

  wrap.appendChild(el('h2', { text: t('report.section.daily') }));
  wrap.appendChild(renderDailyTable(events));

  wrap.appendChild(el('h2', { text: t('report.section.events') }));
  wrap.appendChild(renderEventList(events));
  return wrap;
}

function sliceWindow(state, win) {
  const events = state.events.slice();
  const now = Date.now();
  let cutoff;
  if (win === 'last7') cutoff = now - 7 * 24 * 3600 * 1000;
  else if (win === 'last30') cutoff = now - 30 * 24 * 3600 * 1000;
  else if (win === 'sinceVisit' && state.lastVisitDate) cutoff = new Date(state.lastVisitDate).getTime();
  else return events;
  return events.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
}

// @req FR-130
// @req NFR-29
function renderWeightSvg(events) {
  const weights = events.filter((e) => e.type === 'weight').sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 600 200');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '200');
  svg.style.cssText = 'background:#f7faf7;';
  if (weights.length < 2) {
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', '300');
    text.setAttribute('y', '100');
    text.setAttribute('text-anchor', 'middle');
    text.textContent = 'Need at least 2 weight entries to chart';
    svg.appendChild(text);
    return svg;
  }
  const xs = weights.map((w) => new Date(w.timestamp).getTime());
  const ys = weights.map((w) => w.weightKg);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys) - 0.2, yMax = Math.max(...ys) + 0.2;
  const sx = (x) => 30 + ((x - xMin) / (xMax - xMin || 1)) * 540;
  const sy = (y) => 180 - ((y - yMin) / (yMax - yMin || 1)) * 160;
  const path = document.createElementNS(svgNS, 'polyline');
  path.setAttribute('points', weights.map((w) => `${sx(new Date(w.timestamp).getTime())},${sy(w.weightKg)}`).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#1f6f1f');
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);
  for (const w of weights) {
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', sx(new Date(w.timestamp).getTime()));
    c.setAttribute('cy', sy(w.weightKg));
    c.setAttribute('r', '3');
    c.setAttribute('fill', '#1f6f1f');
    svg.appendChild(c);
  }
  return svg;
}

function renderDailyTable(events) {
  const byDay = new Map();
  for (const e of events) {
    const day = e.timestamp.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { feeds: 0, wet: 0, dirty: 0, feedMin: 0 });
    const row = byDay.get(day);
    if (e.type === 'feed') { row.feeds++; if (e.durationMin) row.feedMin += e.durationMin; }
    if (e.type === 'wet') row.wet++;
    if (e.type === 'dirty') row.dirty++;
  }
  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;width:100%;';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const k of ['date', 'feeds', 'wet', 'dirty', 'feedMin']) {
    const th = document.createElement('th');
    th.textContent = t(`report.col.${k}`);
    th.style.cssText = 'border:1px solid #ccc;padding:0.3rem;background:#eef5ee;';
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const [day, row] of [...byDay.entries()].sort()) {
    const tr = document.createElement('tr');
    for (const v of [day, row.feeds, row.wet, row.dirty, row.feedMin]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      td.style.cssText = 'border:1px solid #ccc;padding:0.3rem;';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function renderEventList(events) {
  const ul = document.createElement('ul');
  ul.style.cssText = 'list-style:none;padding:0;margin:0;';
  for (const ev of events.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))) {
    const li = document.createElement('li');
    li.style.cssText = 'padding:0.3rem 0;border-bottom:1px solid #ddd;';
    const labelMap = { feed: 'Feed', wet: 'Wet diaper', dirty: 'Dirty diaper', weight: 'Weight & length', note: 'Note' };
    const detail = ev.type === 'weight' ? ` · ${ev.weightKg} kg / ${ev.lengthCm} cm`
      : ev.type === 'feed' ? ` · ${ev.side}${ev.durationMin != null ? ` · ${ev.durationMin} min` : ''}` : '';
    const head = document.createElement('div');
    head.textContent = `${ev.timestamp} · ${labelMap[ev.type] ?? ev.type}${detail}`;
    li.appendChild(head);
    if (ev.notes) {
      const n = document.createElement('div');
      n.style.cssText = 'padding-left:1rem;color:#444;font-style:italic;font-size:0.95em;';
      n.textContent = `${t('report.notesLabel')} ${ev.notes}`;
      li.appendChild(n);
    }
    ul.appendChild(li);
  }
  return ul;
}

export function mount(rootEl) {
  mountEl = rootEl;
  refresh();
}

export function unmount() {
  if (mountEl) mountEl.innerHTML = '';
  mountEl = null;
}
