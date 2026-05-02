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
import * as auth from '../auth.js';
import * as cloud from '../cloud.js';
import { cloudConfigured, SUPABASE_REGION } from '../cloud-config.js';

let mountEl = null;
// Mission Network local UI state (not persisted — survives only the
// open Settings session).
let mn = {
  step: 'idle',           // 'idle' | 'awaitingOtp'
  emailDraft: '',
  otpDraft: '',
  busy: false,
  families: null,         // null = unloaded; [] = loaded empty
  invites: null,
  errorKey: null,
};
let authUnsubs = [];

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
  // AMD-003 — Mission Network. Listed before Danger so the destructive
  // section stays at the bottom of the page.
  mountEl.appendChild(section(t('cloud.section.title'), renderMissionNetwork(state)));
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

// ── Mission Network (AMD-003) ─────────────────────────────────────────

// @req AMD-003
// @req US-26
// @req US-27
// @req US-28
// @req US-29
// @req US-30
// @req US-31
// @req FR-200
// @req FR-205
// @req FR-219
function renderMissionNetwork(state) {
  const wrap = el('div', { className: 'mission-network' });
  const cloudState = state.cloud || {};
  const enabled = !!cloudState.enabled;

  // Provisioning gate: unconfigured builds (cloud-config.js still null)
  // surface a single inert hint and stop. Toggling the switch in this
  // state would only error.
  if (!cloudConfigured()) {
    wrap.appendChild(el('p', { text: t('cloud.toggle.unavailable'), style: 'font-size:0.8rem;color:#aac8aa;' }));
    return wrap;
  }

  // Privacy / residency notice (FR-219).
  wrap.appendChild(el('p', {
    text: t('cloud.privacy.notice', { region: SUPABASE_REGION }),
    style: 'font-size:0.7rem;color:#aac8aa;margin-bottom:0.4rem;',
  }));

  // Master toggle.
  const toggleRow = el('div', { style: 'display:flex;align-items:center;gap:0.5rem;margin-bottom:0.6rem;' });
  const toggleBtn = el('button', {
    type: 'button',
    className: 'tap' + (enabled ? ' active' : ''),
    text: enabled ? t('cloud.toggle.disable') : t('cloud.toggle.enable'),
    on: { click: () => enabled ? onDisable() : onEnableStart() },
  });
  if (mn.busy) toggleBtn.disabled = true;
  toggleRow.appendChild(toggleBtn);
  wrap.appendChild(toggleRow);

  if (!enabled) return wrap;

  // From here on cloud is enabled.
  const session = auth.getSession();

  if (!session) {
    wrap.appendChild(renderSignInForm());
    return wrap;
  }

  wrap.appendChild(el('p', {
    text: t('cloud.signedIn.greeting', { email: session.email || '' }),
    style: 'font-size:0.8rem;margin:0.4rem 0;',
  }));

  // Sign-out / disable controls.
  const ctlRow = el('div', { style: 'display:flex;gap:0.5rem;margin:0.4rem 0;' });
  ctlRow.appendChild(el('button', {
    type: 'button', className: 'tap', text: t('cloud.signedIn.signOut'),
    on: { click: onSignOut },
  }));
  wrap.appendChild(ctlRow);

  // Families.
  wrap.appendChild(renderFamilies(cloudState));

  return wrap;
}

function renderSignInForm() {
  // Pre-fill the email field from the persisted rememberedEmail so a
  // returning signed-out user (session expired, explicit Sign out, or
  // post-disable re-enable) doesn't have to retype what we already saved.
  if (!mn.emailDraft) {
    const remembered = getState().cloud?.rememberedEmail;
    if (typeof remembered === 'string' && remembered) mn.emailDraft = remembered;
  }

  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:0.4rem;' });
  wrap.appendChild(el('h3', { text: t('cloud.signIn.heading'), style: 'font-size:0.8rem;' }));

  const emailInput = el('input', {
    type: 'email',
    value: mn.emailDraft,
    attrs: { placeholder: t('cloud.signIn.emailPlaceholder'), 'aria-label': t('cloud.signIn.emailLabel'), autocomplete: 'email' },
  });
  emailInput.addEventListener('input', () => { mn.emailDraft = emailInput.value; });
  wrap.appendChild(emailInput);

  const sendBtn = el('button', {
    type: 'button', className: 'tap', text: t('cloud.signIn.sendCode'),
    on: { click: () => onSendSignInCode(mn.emailDraft) },
  });
  if (mn.busy) sendBtn.disabled = true;
  wrap.appendChild(sendBtn);

  if (mn.step === 'awaitingOtp') {
    wrap.appendChild(el('p', { text: t('cloud.signIn.sent'), style: 'font-size:0.75rem;color:#aac8aa;' }));
    wrap.appendChild(el('p', { text: t('cloud.signIn.otpHint'), style: 'font-size:0.75rem;' }));
    const otpInput = el('input', {
      type: 'text', value: mn.otpDraft,
      attrs: { placeholder: '000000', inputmode: 'numeric', maxlength: '6', 'aria-label': t('cloud.signIn.otpLabel') },
    });
    otpInput.addEventListener('input', () => { mn.otpDraft = otpInput.value; });
    wrap.appendChild(otpInput);
    const verifyBtn = el('button', {
      type: 'button', className: 'tap', text: t('cloud.signIn.otpVerify'),
      on: { click: () => onVerifyOtp(mn.emailDraft, mn.otpDraft) },
    });
    if (mn.busy) verifyBtn.disabled = true;
    wrap.appendChild(verifyBtn);
  }

  if (mn.errorKey) {
    wrap.appendChild(el('p', { text: t(mn.errorKey), style: 'font-size:0.75rem;color:#ffb84d;' }));
  }
  return wrap;
}

function renderFamilies(cloudState) {
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:0.4rem;margin-top:0.6rem;' });
  wrap.appendChild(el('h3', { text: t('cloud.family.heading'), style: 'font-size:0.8rem;' }));

  if (mn.families === null) {
    // First render after sign-in: kick off the load and render the
    // create/redeem affordances immediately. If the load hangs or
    // fails, the user still has a path forward (FR-204 friendly fail).
    onLoadFamilies();
    wrap.appendChild(el('p', { text: t('cloud.family.none'), style: 'font-size:0.75rem;' }));
    wrap.appendChild(renderCreateFamilyForm());
    wrap.appendChild(renderRedeemForm());
    return wrap;
  }

  if (mn.families.length === 0) {
    wrap.appendChild(el('p', { text: t('cloud.family.none'), style: 'font-size:0.75rem;' }));
    wrap.appendChild(renderCreateFamilyForm());
    wrap.appendChild(renderRedeemForm());
    return wrap;
  }

  // List active picker.
  wrap.appendChild(el('p', { text: t('cloud.family.activeLabel'), style: 'font-size:0.7rem;color:#aac8aa;' }));
  for (const f of mn.families) {
    const isActive = cloudState.activeFamilyId === f.id;
    const row = el('div', { style: 'display:flex;align-items:center;gap:0.4rem;' });
    row.appendChild(el('button', {
      type: 'button',
      className: 'tap' + (isActive ? ' active' : ''),
      text: f.name + ' · ' + t(f.role === 'owner' ? 'cloud.family.role.owner' : 'cloud.family.role.member'),
      on: { click: () => onSetActiveFamily(f.id) },
    }));
    wrap.appendChild(row);
  }

  // Owner-only: invites panel for the active family.
  const active = mn.families.find((f) => f.id === cloudState.activeFamilyId);
  if (active && active.role === 'owner') {
    wrap.appendChild(renderInvitesPanel(active.id));
  }

  // Always allow joining additional wings (FR-209).
  wrap.appendChild(renderRedeemForm());

  return wrap;
}

function renderCreateFamilyForm() {
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:0.3rem;margin-top:0.4rem;' });
  wrap.appendChild(el('h4', { text: t('cloud.family.create.label'), style: 'font-size:0.75rem;' }));
  const input = el('input', {
    type: 'text',
    attrs: { placeholder: t('cloud.family.create.namePlaceholder'), maxlength: '60' },
  });
  wrap.appendChild(input);
  wrap.appendChild(el('button', {
    type: 'button', className: 'tap',
    text: t('cloud.family.create.submit'),
    on: { click: () => onCreateFamily(input.value) },
  }));
  return wrap;
}

function renderRedeemForm() {
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:0.3rem;margin-top:0.4rem;' });
  wrap.appendChild(el('h4', { text: t('cloud.family.redeem.label'), style: 'font-size:0.75rem;' }));
  const input = el('input', {
    type: 'text',
    attrs: { placeholder: t('cloud.family.redeem.placeholder'), maxlength: '32' },
  });
  wrap.appendChild(input);
  wrap.appendChild(el('button', {
    type: 'button', className: 'tap',
    text: t('cloud.family.redeem.submit'),
    on: { click: () => onRedeemInvite(input.value) },
  }));
  return wrap;
}

function renderInvitesPanel(familyId) {
  const wrap = el('div', { style: 'margin-top:0.6rem;border-top:1px solid #1f2a1f;padding-top:0.4rem;' });
  wrap.appendChild(el('h3', { text: t('cloud.invites.heading'), style: 'font-size:0.8rem;' }));

  if (mn.invites === null) {
    onLoadInvites(familyId);
    wrap.appendChild(el('p', { text: '…', style: 'font-size:0.75rem;color:#aac8aa;' }));
    return wrap;
  }

  if (mn.invites.length === 0) {
    wrap.appendChild(el('p', { text: t('cloud.invites.empty'), style: 'font-size:0.75rem;' }));
  }
  for (const inv of mn.invites) {
    const row = el('div', { style: 'display:flex;flex-direction:column;gap:0.2rem;border-bottom:1px solid #1f2a1f;padding:0.3rem 0;' });
    row.appendChild(el('code', { text: inv.code, style: 'font-size:0.85rem;' }));
    if (inv.expires_at) {
      row.appendChild(el('p', { text: t('cloud.invites.expiresAt', { date: new Date(inv.expires_at).toLocaleString() }), style: 'font-size:0.7rem;color:#aac8aa;' }));
    }
    const actions = el('div', { style: 'display:flex;gap:0.4rem;' });
    actions.appendChild(el('button', {
      type: 'button', className: 'tap', text: t('cloud.invites.copy'),
      on: { click: () => onCopyInvite(inv.code) },
    }));
    actions.appendChild(el('button', {
      type: 'button', className: 'tap danger', text: t('cloud.invites.revoke'),
      on: { click: () => onRevokeInvite(inv.id) },
    }));
    row.appendChild(actions);
    wrap.appendChild(row);
  }

  wrap.appendChild(el('button', {
    type: 'button', className: 'tap',
    text: t('cloud.invites.generate'),
    on: { click: () => onGenerateInvite(familyId) },
  }));
  return wrap;
}

// ── Mission Network handlers ──────────────────────────────────────────

async function onEnableStart() {
  // Flip the toggle on but don't start sync until the user has a session
  // and an active family — the merge upload (FR-203) needs both.
  mn.busy = true; mn.errorKey = null; refresh();
  dispatch({ type: 'topLevel/patch', payload: { cloud: { ...(getState().cloud || {}), enabled: true } } });
  writeState(getState());
  mn.step = 'idle'; mn.busy = false; refresh();
}

async function onDisable() {
  const choice = await dialog({
    titleKey: 'cloud.section.title',
    bodyKey: 'cloud.signedIn.disableConfirm',
    actions: [
      { labelKey: 'common.cancel', value: 'cancel', cancel: true, defaultFocus: true },
      { labelKey: 'cloud.toggle.disable', value: 'disable', primary: true },
    ],
    destructive: true,
  });
  if (choice !== 'disable') return;
  mn.busy = true; refresh();
  await cloud.disable();
  mn = { step: 'idle', emailDraft: '', otpDraft: '', busy: false, families: null, invites: null, errorKey: null };
  refresh();
}

async function onSendSignInCode(email) {
  mn.busy = true; mn.errorKey = null; refresh();
  const r = await auth.sendSignInCode(email);
  mn.busy = false;
  if (!r.ok) {
    mn.errorKey = r.error.code === 'INVALID_EMAIL' ? 'cloud.signIn.invalidEmail' : 'cloud.signIn.failed';
    refresh();
    return;
  }
  // Persist the email so the form is pre-filled on the next reload.
  setCloudPatch({ rememberedEmail: email.trim() });
  mn.step = 'awaitingOtp';
  refresh();
}

async function onVerifyOtp(email, code) {
  mn.busy = true; mn.errorKey = null; refresh();
  const r = await auth.verifyOtp(email, code);
  mn.busy = false;
  if (!r.ok) {
    mn.errorKey = r.error.code === 'INVALID_CODE' ? 'cloud.signIn.otpInvalid' : 'cloud.signIn.otpFailed';
    refresh();
    return;
  }
  // signedIn event will fire and trigger a refresh via the listener.
  mn.step = 'idle'; mn.otpDraft = '';
}

async function onSignOut() {
  mn.busy = true; refresh();
  await auth.signOut();
  // Clear active-wing identity from appState so the station header
  // stops claiming the user is on that wing once their session is gone.
  setCloudPatch({ activeFamilyId: null, activeFamilyName: null });
  // signedOut listener will refresh.
}

async function onLoadFamilies() {
  let r;
  try {
    r = await auth.listMyFamilies();
  } catch (e) {
    // Catch-all so a thrown rejection (network, schema cache, etc.)
    // can never strand the user on a loading placeholder. The create/
    // redeem forms are already rendered above; we just surface a hint.
    console.error('listMyFamilies threw:', e);
    mn.families = [];
    mn.errorKey = 'cloud.family.create.failed';
    refresh();
    return;
  }
  if (!r.ok) { mn.families = []; refresh(); return; }
  mn.families = r.families;
  // First sign-in with no active family yet — pick the first if any.
  const cur = getState().cloud?.activeFamilyId;
  if (!cur && r.families.length > 0) {
    await onSetActiveFamily(r.families[0].id, { silent: true });
    return; // onSetActiveFamily refreshes
  }
  // Backfill activeFamilyName so the loadmaster station header can
  // surface the wing name on reload, and pick up server-side renames.
  if (cur) {
    const fam = r.families.find((f) => f.id === cur);
    const persistedName = getState().cloud?.activeFamilyName || null;
    if (fam && fam.name !== persistedName) {
      setCloudPatch({ activeFamilyName: fam.name });
    }
  }
  refresh();
}

// @req FR-210
// Active-wing change. Distinguishes three modes:
//   - silent first-pick (no prior activeFamilyId, called from onLoadFamilies):
//     just adopt the id and start sync; no merge, no event-replace.
//   - first activation (no prior activeFamilyId, user-driven via create or
//     redeem): adopt the id; the caller decides whether to FR-203 merge.
//   - switch (prior activeFamilyId differs): replace the local Mission Log
//     with the new wing's events (architecture §5.11.2 wing switch — cache
//     previous wing's tree, dispatch with new wing's cache or empty, fresh
//     pull). Reset lastPulledAt so pullNow fetches the full wing history.
async function onSetActiveFamily(id, { silent = false } = {}) {
  const prev = getState().cloud?.activeFamilyId || null;
  const isSwitch = !!prev && prev !== id;
  const family = (mn.families || []).find((f) => f.id === id);
  const name = family ? family.name : null;

  if (isSwitch) {
    // Replace the local events with empty before pullNow runs — keeping
    // the previous wing's events would (a) leak them into the new wing
    // via sync.js's diff watcher when the user logs the next event, and
    // (b) confuse the user by mixing two wings' Mission Logs.
    // appState/replace preserves cloud subtree, just clears events.
    dispatch({ type: 'appState/replace', payload: { events: [] } });
    setCloudPatch({ activeFamilyId: id, activeFamilyName: name, lastPulledAt: null });
  } else {
    setCloudPatch({ activeFamilyId: id, activeFamilyName: name });
  }
  // appState must be updated BEFORE auth emits familyChanged: sync.js's
  // listener calls pullNow() which reads cloud.activeFamilyId from
  // appState. Reverse order = pullNow short-circuits NOT_READY.
  auth.setActiveFamily(id);
  // Clear cached invites so the panel reloads against the new family.
  mn.invites = null;
  // FR-203 (one-time merge upload on opt-in) is the responsibility of the
  // caller that triggered the *first* activeFamilyId after enable — see
  // onCreateFamily. Switching wings or joining a wing must NOT auto-dump
  // local events: those events either belong to the previous wing
  // (already synced) or to a wing the user is joining as a member.
  await cloud.start();
  refresh();
}

async function onCreateFamily(name) {
  if (!name || !name.trim()) { mn.errorKey = 'cloud.family.create.failed'; refresh(); return; }
  mn.busy = true; refresh();
  // FR-203 gate — capture whether the user has any active wing yet.
  // Only a brand-new wing reached as the user's *first* activation
  // should receive the one-time local-events merge upload.
  const hadActiveBefore = !!(getState().cloud?.activeFamilyId);
  const r = await auth.createFamily(name.trim());
  mn.busy = false;
  if (!r.ok) { mn.errorKey = 'cloud.family.create.failed'; refresh(); return; }
  // Reload the list so RLS-derived role is canonical (we get back 'owner').
  mn.families = null;
  await onLoadFamilies();
  await onSetActiveFamily(r.family.id);
  if (!hadActiveBefore) {
    await cloud.enableAndMerge();
  }
}

async function onRedeemInvite(code) {
  if (!code || !code.trim()) return;
  mn.busy = true; mn.errorKey = null; refresh();
  const r = await auth.redeemInvite(code.trim());
  mn.busy = false;
  if (!r.ok) {
    const map = {
      INVITE_NOT_FOUND: 'cloud.family.redeem.notFound',
      INVITE_EXPIRED: 'cloud.family.redeem.expired',
      INVITE_EXHAUSTED: 'cloud.family.redeem.exhausted',
      INVITE_REVOKED: 'cloud.family.redeem.revoked',
      ALREADY_MEMBER: 'cloud.family.redeem.alreadyMember',
      RATE_LIMITED: 'cloud.family.redeem.rateLimited',
    };
    mn.errorKey = map[r.error.code] || 'cloud.family.redeem.failed';
    refresh();
    return;
  }
  toast('cloud.family.redeem.success');
  mn.families = null;
  await onLoadFamilies();
  await onSetActiveFamily(r.familyId);
}

async function onLoadInvites(familyId) {
  const r = await auth.listInvites(familyId);
  mn.invites = r.ok ? r.invites : [];
  refresh();
}

async function onGenerateInvite(familyId) {
  mn.busy = true; refresh();
  const r = await auth.generateInvite(familyId);
  mn.busy = false;
  if (!r.ok) {
    toast(r.error.code === 'NOT_OWNER' ? 'cloud.invites.notOwner' : 'cloud.invites.failed');
    refresh();
    return;
  }
  mn.invites = null;
  await onLoadInvites(familyId);
}

async function onRevokeInvite(inviteId) {
  const r = await auth.revokeInvite(inviteId);
  if (!r.ok) { toast('cloud.invites.failed'); return; }
  const fid = getState().cloud?.activeFamilyId;
  mn.invites = null;
  if (fid) await onLoadInvites(fid);
}

async function onCopyInvite(code) {
  const link = `${location.origin}${location.pathname}#/invite?code=${encodeURIComponent(code)}`;
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
      ok = true;
    }
  } catch (e) { console.warn('clipboard.writeText failed:', e); }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { console.warn('execCommand copy failed:', e); }
  }
  toast(ok ? 'cloud.invites.copied' : 'cloud.invites.copyFailed');
}

function setCloudPatch(patch) {
  const cur = getState().cloud || {};
  dispatch({ type: 'topLevel/patch', payload: { cloud: { ...cur, ...patch } } });
  writeState(getState());
}

// ── Lifecycle ─────────────────────────────────────────────────────────

export function mount(rootEl) {
  mountEl = rootEl;
  // Subscribe to auth events so the panel re-renders on session/family
  // changes from any source (auth-callback redirect, OTP verify, etc.).
  authUnsubs = [
    auth.on('signedIn', () => { mn.step = 'idle'; mn.errorKey = null; mn.families = null; refresh(); }),
    auth.on('signedOut', () => { mn.families = null; mn.invites = null; refresh(); }),
    auth.on('familyChanged', () => { mn.invites = null; refresh(); }),
  ];
  refresh();
}

export function unmount() {
  for (const u of authUnsubs) { try { u(); } catch { /* noop */ } }
  authUnsubs = [];
  if (mountEl) mountEl.innerHTML = '';
  mountEl = null;
}
