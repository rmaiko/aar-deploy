// js/views/settings.js — C-19 Settings (full-screen route per ADR-009).

import { t } from '../i18n.js';
import { getActiveTheme, applyTheme, persistTheme } from '../theme.js';
import { getState, dispatch } from '../state.js';
import { writeState, factoryReset as fr } from '../storage.js';
import { dialog, toast, banner } from '../overlays.js';
import { navigate } from '../router.js';
import { ROUTES } from '../config.js';
import { buildCsv, exportFilename, triggerDownload, parseCsv, BOM, buildTemplateCsv } from '../csv.js';
import { atomicReplaceData } from '../storage.js';
import { rebuildIfMissing } from '../milestones.js';
import { showPreflight } from './preflight.js';

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

function refresh() {
  if (!mountEl) return;
  const theme = getActiveTheme();
  const state = getState();
  mountEl.innerHTML = '';
  mountEl.appendChild(renderHeader(theme));
  mountEl.appendChild(section(t('settings.section.theme'), renderThemePicker(theme)));
  mountEl.appendChild(section(t('settings.section.language'), renderLangPicker()));
  mountEl.appendChild(section(t('settings.section.export'), renderExport(state)));
  mountEl.appendChild(section(t('settings.section.reload'), renderReload()));
  // MVP sections — present (architecture §2.2 C-19).
  mountEl.appendChild(section(t('settings.section.relay'), renderRelay()));
  mountEl.appendChild(section(t('settings.section.report'), renderReport()));
  mountEl.appendChild(section(t('settings.section.preflight'), renderPreflight()));
  mountEl.appendChild(section(t('settings.section.danger'), renderDanger()));
}

function section(title, body) {
  const wrap = el('section', { className: 'settings-section', style: 'padding:0.6rem 0;border-bottom:1px solid #1f2a1f;' });
  wrap.appendChild(el('h2', { text: title, style: 'font-size:0.8rem;color:#aac8aa;text-transform:uppercase;letter-spacing:0.1em;' }));
  wrap.appendChild(body);
  return wrap;
}

function renderHeader(theme) {
  const wrap = el('header', { className: 'settings-header' });
  wrap.appendChild(el('h1', { text: t(`settings.title.${theme}`) }));
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap nav-back',
    text: t('nav.return'),
    on: { click: () => navigate(ROUTES.STATION) },
  }));
  return wrap;
}

// @req FR-80
// @req FR-81
// @req FR-85
function renderThemePicker(active) {
  const wrap = el('div');
  for (const theme of ['themed', 'plain']) {
    const b = el('button', {
      type: 'button',
      className: 'tap theme-btn' + (active === theme ? ' active' : ''),
      text: t(`settings.theme.${theme}`),
      on: { click: () => { applyTheme(theme); persistTheme(theme); writeState(getState()); refresh(); } },
    });
    wrap.appendChild(b);
  }
  return wrap;
}

// @req FR-89
function renderLangPicker() {
  const wrap = el('div');
  const options = [
    { code: 'en', key: 'settings.lang.en', enabled: true },
    { code: 'pt-br', key: 'settings.lang.ptBr', enabled: false },
    { code: 'fr', key: 'settings.lang.fr', enabled: false },
    { code: 'el', key: 'settings.lang.el', enabled: false },
  ];
  for (const o of options) {
    const b = el('button', {
      type: 'button',
      className: 'tap lang-btn',
      text: t(o.key),
      attrs: o.enabled ? {} : { 'aria-disabled': 'true' },
    });
    if (!o.enabled) b.disabled = true;
    wrap.appendChild(b);
  }
  return wrap;
}

// @req FR-46
// @req FR-47
function renderExport(state) {
  const wrap = el('div');
  const exportBtn = el('button', {
    type: 'button',
    className: 'tap export-btn',
    text: t('settings.export.button'),
    on: {
      click: () => {
        const csv = buildCsv(getState());
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const r = triggerDownload(blob, exportFilename(new Date()));
        if (!r.ok) { toast('csv.export.blocked'); return; }
        dispatch({ type: 'topLevel/patch', payload: { lastExportAt: new Date().toISOString() } });
        writeState(getState());
        toast('csv.export.success');
      },
    },
  });
  if (state.events.length === 0) {
    exportBtn.disabled = true;
    wrap.appendChild(el('p', { text: t('settings.export.empty'), style: 'font-size:0.75rem;color:#aac8aa;' }));
  }
  wrap.appendChild(exportBtn);
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap export-template',
    text: t('settings.export.template'),
    on: {
      click: () => {
        const blob = new Blob([buildTemplateCsv()], { type: 'text/csv;charset=utf-8' });
        const r = triggerDownload(blob, 'aar-deploy-template.csv');
        if (!r.ok) toast('csv.export.blocked');
      },
    },
  }));
  return wrap;
}

// @req FR-49
// @req FR-50
// @req FR-51
// @req FR-52
// @req FR-53
function renderReload() {
  const wrap = el('div');
  const fileInput = el('input', { type: 'file', attrs: { accept: '.csv,text/csv' } });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    const result = parseCsv(text);
    if (!result.ok) {
      toast(result.error.errorKey ?? 'csv.import.malformed', result.error.column ? { column: result.error.column } : {});
      return;
    }
    await openImportPreview(result.value);
    fileInput.value = '';
  });
  wrap.appendChild(fileInput);
  return wrap;
}

async function openImportPreview(parsed) {
  const summary = el('div');
  summary.appendChild(el('p', { text: t('csv.import.preview.valid', { n: parsed.valid.length }) }));
  summary.appendChild(el('p', { text: t('csv.import.preview.skipped', { n: parsed.skipped.length }) }));
  if (parsed.dateRange) {
    summary.appendChild(el('p', { text: t('csv.import.preview.dateRange', { from: parsed.dateRange.from, to: parsed.dateRange.to }) }));
  }
  if (parsed.tzWarning) summary.appendChild(el('p', { text: t('csv.import.tzWarning') }));
  // Use EMCON gating during preview. We don't actually enter EMCON here for
  // simplicity in Alpha; the dialog itself blocks other interactions.
  const choice = await dialog({
    titleKey: 'csv.import.preview.title',
    content: summary,
    actions: [
      { labelKey: 'csv.import.cancel', value: 'cancel', cancel: true, defaultFocus: true },
      { labelKey: 'csv.import.exportFirst', value: 'export' },
      { labelKey: 'csv.import.replace', value: 'replace', primary: true },
    ],
    destructive: true,
  });
  if (choice === 'cancel' || (choice && choice.closedByStorage)) return;
  if (choice === 'export') {
    const csv = buildCsv(getState());
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, exportFilename(new Date()));
    return;
  }
  if (choice === 'replace') {
    const r = atomicReplaceData({ events: parsed.valid, schemaVersion: parsed.schemaVersion });
    if (!r.ok) { toast('storage.replaceFailed'); return; }
    // refresh in-memory state from storage path B's authoritative result
    dispatch({ type: 'state/set', payload: r.value });
    rebuildIfMissing({ ...r.value, milestones: undefined });
    toast('csv.export.success'); // generic confirmation
    navigate(ROUTES.STATION);
  }
}

function renderRelay() {
  const wrap = el('div');
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap',
    text: t('settings.relay.button'),
    on: { click: () => navigate(ROUTES.RELAY) },
  }));
  return wrap;
}

function renderReport() {
  const wrap = el('div');
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap',
    text: t('settings.report.button'),
    on: { click: () => navigate(ROUTES.REPORT) },
  }));
  return wrap;
}

// @req FR-62
function renderPreflight() {
  const wrap = el('div');
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap',
    text: t('settings.preflight.show'),
    on: { click: () => showPreflight({ force: true }) },
  }));
  return wrap;
}

// @req FR-70
// @req FR-71
// @req FR-72
// @req FR-73
function renderDanger() {
  const wrap = el('div');
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap danger',
    text: t('settings.factoryReset.button'),
    on: { click: () => factoryResetFlow() },
  }));
  wrap.appendChild(el('p', { text: t('settings.factoryReset.subLabel'), style: 'font-size:0.7rem;color:#ffb84d;' }));
  return wrap;
}

async function factoryResetFlow() {
  const step1 = await dialog({
    titleKey: 'factoryReset.step1.title',
    bodyKey: 'factoryReset.step1.body',
    actions: [
      { labelKey: 'factoryReset.step1.cancel', value: 'cancel', cancel: true, defaultFocus: true },
      { labelKey: 'factoryReset.step1.exportFirst', value: 'export' },
      { labelKey: 'factoryReset.step1.continue', value: 'continue', primary: true },
    ],
    destructive: true,
  });
  if (!step1 || step1 === 'cancel' || (step1 && step1.closedByStorage)) return;
  if (step1 === 'export') {
    const csv = buildCsv(getState());
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, exportFilename(new Date()));
    return;
  }
  // Step 2: type DELETE.
  const input = el('input', { type: 'text', attrs: { placeholder: t('factoryReset.step2.placeholder') } });
  const wrap = el('div');
  wrap.appendChild(input);
  let confirmAction = null;
  const promise = dialog({
    titleKey: 'factoryReset.step2.title',
    bodyKey: 'factoryReset.step2.body',
    content: wrap,
    actions: [
      { labelKey: 'factoryReset.step2.cancel', value: 'cancel', cancel: true, defaultFocus: true },
      { labelKey: 'factoryReset.step2.confirm', value: 'reset', primary: true, disabled: true },
    ],
    destructive: true,
  });
  // Enable RESET NOW only when the input matches "DELETE" exactly.
  setTimeout(() => {
    const dlg = wrap.closest('dialog');
    const resetBtn = dlg?.querySelectorAll('button')[1];
    if (!resetBtn) return;
    input.addEventListener('input', () => {
      resetBtn.disabled = input.value !== 'DELETE';
    });
  }, 0);
  const choice = await promise;
  if (choice !== 'reset') return;
  const r = fr();
  if (!r.ok) { toast('factoryReset.failed'); return; }
  dispatch({ type: 'state/set', payload: { schemaVersion: 1, events: [] } });
  toast('factoryReset.success');
  showPreflight({ force: true });
  navigate(ROUTES.STATION);
}

export function mount(rootEl) {
  mountEl = rootEl;
  refresh();
}

export function unmount() {
  if (mountEl) mountEl.innerHTML = '';
  mountEl = null;
}
