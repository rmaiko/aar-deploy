// js/views/maintenance.js — Maintenance Log full-page view.
//
// Promoted from the openMaintenanceDialog modal that used to live in
// station.js. Same content (ECAM checklist + sub-action buttons +
// reminder management), now reachable via the persistent tab bar at
// ROUTES.MAINTENANCE.

import { t } from '../i18n.js';
import { getActiveTheme } from '../theme.js';
import { subscribe } from '../state.js';
import { logNote, logWeight } from '../events.js';
import { isEmcon } from '../emcon.js';
import { dialog, toast } from '../overlays.js';
import { resolveTimeOnly } from '../chip.js';
import {
  getReminders, addReminder, cancelReminder, checkOffReminder,
  checklistForToday, describeSchedule,
} from '../reminders.js';

let mountEl = null;
let unsub = null;

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

function refresh() {
  if (!mountEl) return;
  const theme = getActiveTheme();
  mountEl.innerHTML = '';
  mountEl.appendChild(renderHeader(theme));
  mountEl.appendChild(renderChecklistSection(theme));
  mountEl.appendChild(renderActionsSection(theme));
  mountEl.appendChild(renderRemindersControls(theme));
}

function renderHeader(theme) {
  const wrap = el('header', { className: 'maintenance-header' });
  wrap.appendChild(el('h1', { text: t(`maintenance.dialog.title.${theme}`) }));
  return wrap;
}

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
  for (const item of list) ol.appendChild(renderChecklistRow(item));
  wrap.appendChild(ol);
  return wrap;
}

function renderChecklistRow(item) {
  const li = el('li', { className: `ecam-row ecam-${item.status}` });
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'ecam-checkbox';
  cb.checked = item.status === 'done';
  cb.disabled = item.status === 'done';
  cb.addEventListener('change', () => {
    if (!cb.checked) return;
    const r = checkOffReminder(item.reminder);
    if (!r.ok) {
      cb.checked = false;
      if (r.error?.errorKey) toast(r.error.errorKey);
      return;
    }
    toast('event.confirm.reminder', { label: item.reminder.label, time: formatHm(new Date(r.value.timestamp)) });
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

function renderActionsSection(theme) {
  const wrap = el('section', { className: 'maintenance-actions-wrap', attrs: { 'data-emcon-gated': '1' } });
  wrap.appendChild(el('div', {
    text: t(`maintenance.dialog.subtitle.${theme}`),
    style: 'font-size:0.7rem;color:#aac8aa;text-transform:uppercase;letter-spacing:0.1em;margin:0.4rem 0 0.3rem;',
  }));
  const col = el('div', { className: 'maintenance-actions', style: 'display:flex;flex-direction:column;gap:0.3rem;' });
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
  col.appendChild(row(`loadAction.weight.${theme}`, 'loadAction.weight.plain', guardEmcon(() => openWeightDialog())));
  col.appendChild(row(`loadAction.note.${theme}`, 'loadAction.note.plain', guardEmcon(() => openNoteDialog())));
  col.appendChild(row(`loadAction.tankerService.${theme}`, 'loadAction.tankerService.plain', guardEmcon(() => {
    const r = logNote({ notes: t('loadAction.tankerService.marker') });
    handleLogResult(r, 'event.confirm.tankerService');
  })));
  col.appendChild(row(`loadAction.washing.${theme}`, 'loadAction.washing.plain', guardEmcon(() => {
    const r = logNote({ notes: t('loadAction.washing.marker') });
    handleLogResult(r, 'event.confirm.washing');
  })));
  col.appendChild(row(`loadAction.maintenance.${theme}`, 'loadAction.maintenance.plain', guardEmcon(() => {
    const r = logNote({ notes: t('loadAction.maintenance.marker') });
    handleLogResult(r, 'event.confirm.maintenance');
  })));
  wrap.appendChild(col);
  return wrap;
}

function renderRemindersControls(theme) {
  const wrap = el('section', { className: 'maintenance-reminders-controls', style: 'display:flex;flex-wrap:wrap;gap:0.3rem;justify-content:flex-end;margin-top:0.4rem;' });
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap',
    text: t(`maintenance.dialog.addReminder.${theme}`),
    style: 'font-size:0.8rem;',
    on: { click: guardEmcon(() => openAddReminderDialog()) },
  }));
  wrap.appendChild(el('button', {
    type: 'button',
    className: 'tap',
    text: t(`maintenance.dialog.manageReminders.${theme}`),
    style: 'font-size:0.8rem;',
    on: { click: guardEmcon(() => openManageRemindersDialog()) },
  }));
  return wrap;
}

function guardEmcon(fn) {
  return () => {
    if (isEmcon()) { toast('emcon.banner'); return; }
    fn();
  };
}

function handleLogResult(r, plainKey) {
  if (!r.ok) {
    if (r.error?.errorKey) toast(r.error.errorKey);
    return;
  }
  toast(plainKey, { time: formatHm(new Date(r.value.timestamp)) });
  refresh();
}

async function openNoteDialog() {
  const wrap = el('div');
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.maxLength = 500;
  ta.placeholder = t('note.dialog.placeholder');
  ta.style.cssText = 'width:100%;font:inherit;background:#0a0d0a;color:#c8e6c9;border:1px solid #1f2a1f;padding:0.3rem;';
  wrap.appendChild(ta);
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

async function openWeightDialog() {
  const wrap = el('div');
  const wInput = el('input', { type: 'number', step: '0.05' });
  wInput.placeholder = '—';
  const lInput = el('input', { type: 'number', step: '0.5' });
  lInput.placeholder = '—';
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

  const kindSel = document.createElement('select');
  for (const k of ['dailyAt', 'everyHours', 'oncesAt']) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = t(`reminder.dialog.kind.${k}`);
    if (prefill?.schedule?.kind === k) opt.selected = true;
    kindSel.appendChild(opt);
  }
  wrap.appendChild(labelled(t('reminder.dialog.schedule'), kindSel));

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

  const choice = await dialog({
    titleKey: `reminder.dialog.manage.title.${theme}`,
    content: wrap,
    actions: [
      { labelKey: 'maintenance.dialog.addReminder.plain', value: 'add', primary: true },
      { labelKey: 'maintenance.dialog.cancel', value: 'cancel', cancel: true, defaultFocus: true },
    ],
  });
  if (choice === 'add') openAddReminderDialog();
}

function labelled(labelText, control) {
  const wrap = el('label', { style: 'display:flex;flex-direction:column;gap:0.2rem;margin:0.4rem 0;' });
  wrap.appendChild(el('span', { text: labelText, style: 'font-size:0.75rem;color:#aac8aa;text-transform:uppercase;' }));
  wrap.appendChild(control);
  return wrap;
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

export function mount(rootEl) {
  mountEl = rootEl;
  refresh();
  unsub = subscribe(refresh);
}

export function unmount() {
  if (unsub) unsub();
  if (mountEl) mountEl.innerHTML = '';
  mountEl = null;
}
