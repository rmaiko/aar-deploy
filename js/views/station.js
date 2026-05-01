// js/views/station.js — C-17 Loadmaster Station view.
//
// Top-level "home" view: log buttons, LAST CONTACT panel,
// TODAY widget, NEXT VECTOR panel, DELETE LAST button, banner host.

import { t } from '../i18n.js';
import { getActiveTheme, tk } from '../theme.js';
import { getState, subscribe } from '../state.js';
import {
  logFeed, logDiaper, logWeight, deleteLast,
  startFeedTimer, stopFeedTimerAndLog, cancelFeedTimer,
  getActiveFeedTimer, subscribeFeedTimer,
  updateEvent, logNote,
} from '../events.js';
import { dispatch } from '../state.js';
import { writeState } from '../storage.js';
import { predictFeed, predictDiaper } from '../prediction.js';
import { isEmcon, getImportedState } from '../emcon.js';
import { navigate } from '../router.js';
import { ROUTES } from '../config.js';
import { toast, dialog, banner } from '../overlays.js';
import { resolveTimeOnly } from '../chip.js';
import {
  getReminders, addReminder, cancelReminder, checkOffReminder,
  checklistForToday, describeSchedule, isReminderEnvelope,
} from '../reminders.js';
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
  // Maintenance log groups Notes, Tanker Service, Weight & Balance,
  // Bravo-1 washing, Bravo-1 maintenance + the reminders/checklist.
  wrap.appendChild(make(tk('loadAction.maintenanceLog'), 'loadAction.maintenanceLog.plain', () => {
    if (handleEmconBlocked()) return;
    openMaintenanceDialog();
  }));
  return wrap;
}

async function openNoteDialog() {
  const wrap = el('div');
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.maxLength = 500;
  ta.placeholder = t('note.dialog.placeholder');
  ta.style.cssText = 'width:100%;font:inherit;background:#0a0d0a;color:#c8e6c9;border:1px solid #1f2a1f;padding:0.3rem;';
  wrap.appendChild(ta);
  // expose chip-driven timestamp explicitly so user sees what they're saving.
  const tInput = document.createElement('input');
  tInput.type = 'datetime-local';
  tInput.value = toLocalDateTimeInput(new Date());
  wrap.appendChild(labelled(t('weight.timeLabel'), tInput));
  const choice = await dialog({
    titleKey: 'note.dialog.title',
    content: wrap,
    actions: [
      { labelKey: 'feeding.cancel', value: 'cancel', cancel: true },
      { labelKey: 'note.dialog.save', value: 'ok', primary: true, defaultFocus: true },
    ],
  });
  if (choice !== 'ok') return;
  const text = ta.value.trim();
  if (!text) { toast('note.dialog.empty'); return; }
  const r = logNote({ notes: text, when: new Date(tInput.value) });
  if (!r.ok) {
    if (r.error?.errorKey) toast(r.error.errorKey);
    return;
  }
  toast('event.confirm.note', { time: formatHm(new Date(r.value.timestamp)) });
  refresh();
}

// MAINTENANCE LOG modal — groups Notes/Tanker/Weight + Bravo-1
// washing/maintenance + the reminders/checklist (ECAM-styled).
async function openMaintenanceDialog() {
  const theme = getActiveTheme();
  let queuedAction = null;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'min-width:20rem;display:flex;flex-direction:column;gap:0.6rem;';

  // Checklist section (ECAM-style: each row is a line item with a checkbox).
  wrap.appendChild(renderChecklistSection(theme));

  // Action picker (sub-actions log into the manifest).
  const actionsHeader = el('div', {
    text: t(`maintenance.dialog.subtitle.${theme}`),
    style: 'font-size:0.7rem;color:#aac8aa;text-transform:uppercase;letter-spacing:0.1em;margin-top:0.2rem;',
  });
  wrap.appendChild(actionsHeader);

  const actionsCol = el('div', { className: 'maintenance-actions', style: 'display:flex;flex-direction:column;gap:0.3rem;' });
  // Closes the parent dialog *and* resolves its promise. Uses the
  // dialog-helper-internal __close hook (overlays.js) — calling
  // dlg.close() directly would visually dismiss but leave the awaiting
  // promise hanging.
  const queue = (fn) => (e) => {
    queuedAction = fn;
    const dlg = e.currentTarget.closest('dialog');
    if (dlg && typeof dlg.__close === 'function') dlg.__close('cancel');
    else if (dlg) dlg.close();
  };
  const row = (key, plainKey, onClick) => {
    const b = el('button', {
      type: 'button',
      className: 'tap maintenance-row',
      style: 'justify-content:flex-start;text-align:left;padding:0.55rem 0.7rem;width:100%;flex-direction:column;align-items:flex-start;',
      on: { click: onClick },
    });
    b.appendChild(el('span', { className: 'themed', text: t(key), style: 'font-weight:600;' }));
    b.appendChild(el('span', { className: 'plain', text: t(plainKey), style: 'font-size:0.75rem;color:#aac8aa;' }));
    if (theme === 'plain') b.firstChild.style.cssText = 'display:none;';
    return b;
  };
  actionsCol.appendChild(row(`loadAction.weight.${theme}`, 'loadAction.weight.plain', queue(() => openWeightDialog())));
  actionsCol.appendChild(row(`loadAction.note.${theme}`, 'loadAction.note.plain', queue(() => openNoteDialog())));
  actionsCol.appendChild(row(`loadAction.tankerService.${theme}`, 'loadAction.tankerService.plain', queue(() => {
    const r = logNote({ notes: t('loadAction.tankerService.marker') });
    handleLogResult(r, 'event.confirm.tankerService', 'note');
    refresh();
  })));
  actionsCol.appendChild(row(`loadAction.washing.${theme}`, 'loadAction.washing.plain', queue(() => {
    const r = logNote({ notes: t('loadAction.washing.marker') });
    handleLogResult(r, 'event.confirm.washing', 'note');
    refresh();
  })));
  actionsCol.appendChild(row(`loadAction.maintenance.${theme}`, 'loadAction.maintenance.plain', queue(() => {
    const r = logNote({ notes: t('loadAction.maintenance.marker') });
    handleLogResult(r, 'event.confirm.maintenance', 'note');
    refresh();
  })));
  wrap.appendChild(actionsCol);

  // Reminders management buttons.
  const remRow = el('div', { style: 'display:flex;flex-wrap:wrap;gap:0.3rem;justify-content:flex-end;margin-top:0.2rem;' });
  remRow.appendChild(el('button', {
    type: 'button',
    className: 'tap',
    text: t(`maintenance.dialog.addReminder.${theme}`),
    style: 'font-size:0.8rem;',
    on: { click: queue(() => openAddReminderDialog()) },
  }));
  remRow.appendChild(el('button', {
    type: 'button',
    className: 'tap',
    text: t(`maintenance.dialog.manageReminders.${theme}`),
    style: 'font-size:0.8rem;',
    on: { click: queue(() => openManageRemindersDialog()) },
  }));
  wrap.appendChild(remRow);

  await dialog({
    titleKey: `maintenance.dialog.title.${theme}`,
    content: wrap,
    actions: [
      { labelKey: 'maintenance.dialog.cancel', value: 'cancel', cancel: true, defaultFocus: true },
    ],
  });
  if (queuedAction) {
    try { await queuedAction(); } catch (e) { console.error('maintenance action failed:', e); }
  }
}

// ECAM-style checklist section. Renders inside the maintenance dialog.
function renderChecklistSection(theme) {
  const wrap = el('section', { className: 'ecam-checklist' });
  wrap.appendChild(el('div', {
    text: t(`maintenance.dialog.checklistTitle.${theme}`),
    className: 'ecam-checklist-title',
  }));
  const list = checklistForToday();
  if (list.length === 0) {
    wrap.appendChild(el('p', {
      text: t(`maintenance.dialog.checklistEmpty.${theme}`),
      style: 'font-size:0.8rem;color:#aac8aa;margin:0.2rem 0;',
    }));
    return wrap;
  }
  const ol = el('ol', { className: 'ecam-checklist-list', style: 'list-style:none;padding:0;margin:0;' });
  for (const item of list) {
    ol.appendChild(renderChecklistRow(item, theme));
  }
  wrap.appendChild(ol);
  return wrap;
}

function renderChecklistRow(item, theme) {
  const li = el('li', { className: `ecam-row ecam-${item.status}` });
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'ecam-checkbox';
  cb.checked = item.status === 'done';
  cb.disabled = item.status === 'done'; // already done; can't un-check (history is immutable)
  cb.addEventListener('change', () => {
    if (!cb.checked) return;
    const r = checkOffReminder(item.reminder);
    if (!r.ok) {
      cb.checked = false;
      if (r.error?.errorKey) toast(r.error.errorKey);
      return;
    }
    toast('event.confirm.reminder', { label: item.reminder.label, time: formatHm(new Date(r.value.timestamp)) });
    // The maintenance dialog rebuilds its checklist next open; for now
    // just visually mark it done.
    li.classList.remove('ecam-pending', 'ecam-overdue', 'ecam-upcoming');
    li.classList.add('ecam-done');
    cb.disabled = true;
    refresh();
  });
  li.appendChild(cb);

  const label = el('div', { className: 'ecam-label' });
  label.appendChild(el('span', { className: 'ecam-label-text', text: item.reminder.label }));
  const dueText = item.status === 'done' && item.completedAt
    ? `✓ ${formatHm(item.completedAt)}`
    : (item.status === 'overdue'
        ? `${t('reminder.checklist.overdue')} · ${formatHm(item.dueAt)}`
        : t('reminder.checklist.dueAt', { time: formatHm(item.dueAt) }));
  label.appendChild(el('span', { className: 'ecam-due', text: dueText }));
  li.appendChild(label);
  return li;
}

// Add-reminder modal. Lets the user pick a schedule kind (daily-at,
// every-N-hours, once-at) and a label. Saves a [REMINDER] envelope note.
async function openAddReminderDialog(prefill = null) {
  const theme = getActiveTheme();
  const wrap = document.createElement('div');
  wrap.style.cssText = 'min-width:20rem;display:flex;flex-direction:column;gap:0.5rem;';

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.maxLength = 200;
  labelInput.placeholder = t('reminder.dialog.labelPlaceholder');
  labelInput.style.cssText = 'width:100%;font:inherit;background:#0a0d0a;color:#c8e6c9;border:1px solid #1f2a1f;padding:0.4rem;';
  if (prefill?.label) labelInput.value = prefill.label;
  wrap.appendChild(labelled(t('reminder.dialog.label'), labelInput));

  // Schedule kind picker.
  const kindSel = document.createElement('select');
  for (const k of ['dailyAt', 'everyHours', 'oncesAt']) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = t(`reminder.dialog.kind.${k}`);
    if (prefill?.schedule?.kind === k) opt.selected = true;
    kindSel.appendChild(opt);
  }
  wrap.appendChild(labelled(t('reminder.dialog.schedule'), kindSel));

  // Sub-controls per kind.
  const kindBody = el('div', { style: 'display:flex;flex-direction:column;gap:0.4rem;padding:0.3rem 0.6rem;border-left:2px solid #1f2a1f;' });
  wrap.appendChild(kindBody);

  const dailyTime = document.createElement('input'); dailyTime.type = 'time';
  dailyTime.value = prefill?.schedule?.kind === 'dailyAt' ? prefill.schedule.time : '08:00';

  const everyN = document.createElement('input'); everyN.type = 'number'; everyN.min = '1'; everyN.max = '48'; everyN.step = '1';
  everyN.value = prefill?.schedule?.kind === 'everyHours' ? String(prefill.schedule.n) : '6';
  const everyAnchor = document.createElement('input'); everyAnchor.type = 'time';
  everyAnchor.value = prefill?.schedule?.kind === 'everyHours' ? prefill.schedule.anchor : '08:00';

  const onceWhen = document.createElement('input'); onceWhen.type = 'datetime-local';
  onceWhen.value = prefill?.schedule?.kind === 'oncesAt'
    ? toLocalDateTimeInput(new Date(prefill.schedule.iso))
    : toLocalDateTimeInput(new Date(Date.now() + 60 * 60_000));

  function rebuildKindBody() {
    kindBody.innerHTML = '';
    if (kindSel.value === 'dailyAt') {
      kindBody.appendChild(labelled(t('reminder.dialog.kind.dailyAt'), dailyTime));
    } else if (kindSel.value === 'everyHours') {
      kindBody.appendChild(labelled(t('reminder.dialog.everyHoursLabel'), everyN));
      kindBody.appendChild(labelled(t('reminder.dialog.anchorLabel'), everyAnchor));
    } else if (kindSel.value === 'oncesAt') {
      kindBody.appendChild(labelled(t('reminder.dialog.kind.oncesAt'), onceWhen));
    }
  }
  rebuildKindBody();
  kindSel.addEventListener('change', rebuildKindBody);

  const choice = await dialog({
    titleKey: `reminder.dialog.add.title.${theme}`,
    content: wrap,
    actions: [
      { labelKey: 'reminder.dialog.cancel', value: 'cancel', cancel: true },
      { labelKey: 'reminder.dialog.save', value: 'save', primary: true, defaultFocus: true },
    ],
  });
  if (choice !== 'save') return;

  const label = labelInput.value.trim();
  if (!label) { toast('reminder.label.required'); return; }
  let schedule = null;
  if (kindSel.value === 'dailyAt') {
    schedule = { kind: 'dailyAt', time: dailyTime.value };
  } else if (kindSel.value === 'everyHours') {
    const n = Number(everyN.value);
    if (!Number.isFinite(n) || n < 1 || n > 48) { toast('reminder.everyHours.range'); return; }
    schedule = { kind: 'everyHours', n, anchor: everyAnchor.value };
  } else if (kindSel.value === 'oncesAt') {
    const d = new Date(onceWhen.value);
    if (Number.isNaN(d.getTime())) return;
    schedule = { kind: 'oncesAt', iso: d.toISOString() };
  }
  const r = addReminder({ label, schedule });
  if (!r.ok) {
    if (r.error?.errorKey) toast(r.error.errorKey);
    return;
  }
  refresh();
}

// Manage reminders modal — list active reminders with delete buttons.
async function openManageRemindersDialog() {
  const theme = getActiveTheme();
  const wrap = document.createElement('div');
  wrap.style.cssText = 'min-width:20rem;display:flex;flex-direction:column;gap:0.4rem;';
  const reminders = getReminders();
  if (reminders.length === 0) {
    wrap.appendChild(el('p', {
      text: t('reminder.list.empty'),
      style: 'font-size:0.85rem;color:#aac8aa;margin:0.4rem 0;',
    }));
  } else {
    const ol = el('ol', { style: 'list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:0.3rem;' });
    for (const rem of reminders) {
      const li = el('li', { style: 'display:flex;justify-content:space-between;align-items:center;gap:0.4rem;padding:0.4rem;border:1px solid #1f2a1f;border-radius:4px;background:#0a0d0a;' });
      const left = el('div', { style: 'flex:1 1 auto;min-width:0;' });
      left.appendChild(el('div', { text: rem.label, style: 'font-weight:600;overflow:hidden;text-overflow:ellipsis;' }));
      left.appendChild(el('div', { text: describeSchedule(rem.schedule, t), style: 'font-size:0.75rem;color:#aac8aa;' }));
      li.appendChild(left);
      li.appendChild(el('button', {
        type: 'button',
        className: 'tap',
        text: '✕',
        style: 'font-size:0.8rem;color:#ffb84d;border-color:#ffb84d;background:transparent;min-width:36px;min-height:36px;padding:0.2rem 0.5rem;',
        on: { click: async () => {
          const ok = await dialog({
            titleKey: 'reminder.dialog.confirmDelete.title',
            bodyKey: 'reminder.dialog.confirmDelete.body',
            actions: [
              { labelKey: 'reminder.dialog.confirmDelete.cancel', value: 'cancel', cancel: true, defaultFocus: true },
              { labelKey: 'reminder.dialog.confirmDelete.delete', value: 'del', primary: true },
            ],
          });
          if (ok !== 'del') return;
          cancelReminder(rem.id);
          li.remove();
          refresh();
        } },
      }));
      ol.appendChild(li);
    }
    wrap.appendChild(ol);
  }

  await dialog({
    titleKey: `reminder.dialog.manage.title.${theme}`,
    content: wrap,
    actions: [
      { labelKey: 'maintenance.dialog.addReminder.plain', value: 'add', primary: true },
      { labelKey: 'maintenance.dialog.cancel', value: 'cancel', cancel: true, defaultFocus: true },
    ],
  }).then((choice) => {
    if (choice === 'add') openAddReminderDialog();
  });
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

function toLocalTimeInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  const list = el('ol', { className: 'recent-list', style: 'list-style:none;padding:0;margin:0.4rem 0;' });
  for (const ev of recent) list.appendChild(renderRecentEntry(ev, theme));
  wrap.appendChild(list);
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

function renderRecentEntry(ev, theme) {
  const li = el('li', { className: 'recent-entry' });
  const btn = el('button', {
    type: 'button',
    className: 'recent-entry-btn',
    style: 'display:flex;justify-content:space-between;gap:0.5rem;width:100%;padding:0.4rem 0.3rem;background:transparent;border:0;border-bottom:1px solid #1f2a1f;text-align:left;cursor:pointer;color:inherit;font:inherit;',
    on: { click: () => openEditDialog(ev) },
  });
  const left = el('span', { style: 'flex:1 1 auto;min-width:0;' });
  left.appendChild(el('strong', { text: labelForEvent(ev, theme) }));
  if (ev.type === 'feed' && ev.durationMin != null) {
    left.appendChild(document.createTextNode(' · '));
    left.appendChild(el('span', { text: t('log.entry.duration', { n: ev.durationMin }) }));
  }
  if (ev.type === 'weight') {
    left.appendChild(document.createTextNode(' · '));
    left.appendChild(el('span', { text: t('log.entry.weightDetail', { kg: ev.weightKg, cm: ev.lengthCm }) }));
  }
  if (ev.notes) {
    left.appendChild(el('div', { text: '✎ ' + ev.notes, style: 'font-size:0.75rem;color:#aac8aa;margin-top:0.15rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
  }
  btn.appendChild(left);
  const right = el('span', { style: 'color:#aac8aa;font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 0 auto;' });
  const ts = new Date(ev.timestamp);
  right.textContent = `${formatHm(ts)} · ${relativeTimeString(ts)}`;
  btn.appendChild(right);
  li.appendChild(btn);
  return li;
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
  if (ev.type === 'note') return t(`log.entry.note.${theme}`);
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
  // Both fields independently optional; at least one required (see
  // events.js logWeight).  Empty inputs → field omitted from event.
  const wInput = el('input', { type: 'number', step: '0.05' });
  wInput.placeholder = '—';
  const lInput = el('input', { type: 'number', step: '0.5' });
  lInput.placeholder = '—';
  // Time-only picker (FR-11).  resolveTimeOnly wraps to yesterday if
  // the chosen time is in the future-of-today; rejects > 24h ago.
  const tInput = el('input', { type: 'time' });
  tInput.value = toLocalTimeInput(new Date());
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
  const tsCheck = resolveTimeOnly(tInput.value, new Date());
  if (!tsCheck.ok) { toast(tsCheck.errorKey ?? 'time.notFuture'); return; }
  const r = logWeight({
    weightKg: wInput.value,
    lengthCm: lInput.value,
    when: tsCheck.value,
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
