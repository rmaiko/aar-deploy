// js/reminders.js — C-19 reminders + checklist (AMD-010).
//
// Reminders are stored entirely inside the existing `note` event type
// using a literal-tag JSON envelope in the notes column:
//
//   [REMINDER]{"id":"R-abc","label":"Take meds","schedule":{...}}
//   [REMINDER-CANCEL]{"id":"R-abc"}
//
// Definition events declare a reminder; cancel events tombstone it.
// "Check-off" events are plain note events whose `notes` text matches
// the reminder's `label` exactly — those round-trip through CSV like
// any other note. Mission Log + Recent hide the envelope events.
//
// Schedules supported in v1:
//   { kind: 'dailyAt',     time: 'HH:MM' }
//   { kind: 'everyHours',  n: 1..48, anchor: 'HH:MM' }
//   { kind: 'oncesAt',     iso: <ISO-8601 with offset> }

import { logNote } from './events.js';
import { getState } from './state.js';

export const REMINDER_TAG = '[REMINDER]';
export const CANCEL_TAG = '[REMINDER-CANCEL]';

export function isReminderDefinition(notes) {
  return typeof notes === 'string' && notes.startsWith(REMINDER_TAG);
}
export function isReminderCancel(notes) {
  return typeof notes === 'string' && notes.startsWith(CANCEL_TAG);
}
export function isReminderEnvelope(notes) {
  return isReminderDefinition(notes) || isReminderCancel(notes);
}

function safeParseEnvelope(notes, tag) {
  if (typeof notes !== 'string' || !notes.startsWith(tag)) return null;
  const json = notes.slice(tag.length).trim();
  try { return JSON.parse(json); } catch { return null; }
}

function isValidSchedule(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.kind === 'dailyAt') return /^\d{1,2}:\d{2}$/.test(s.time || '');
  if (s.kind === 'everyHours') {
    return Number.isFinite(s.n) && s.n >= 1 && s.n <= 48
      && /^\d{1,2}:\d{2}$/.test(s.anchor || '');
  }
  if (s.kind === 'oncesAt') return typeof s.iso === 'string' && !Number.isNaN(new Date(s.iso).getTime());
  return false;
}

// Active reminders = (latest definition per id) − (cancellations).
export function getReminders(events = getState().events ?? []) {
  const defs = new Map();
  const canceled = new Set();
  for (const ev of events) {
    if (ev.type !== 'note' || typeof ev.notes !== 'string') continue;
    if (isReminderDefinition(ev.notes)) {
      const obj = safeParseEnvelope(ev.notes, REMINDER_TAG);
      if (obj && typeof obj.id === 'string' && typeof obj.label === 'string' && isValidSchedule(obj.schedule)) {
        defs.set(obj.id, { id: obj.id, label: obj.label, schedule: obj.schedule, definedAt: ev.timestamp, eventId: ev.id });
      }
    } else if (isReminderCancel(ev.notes)) {
      const obj = safeParseEnvelope(ev.notes, CANCEL_TAG);
      if (obj && typeof obj.id === 'string') canceled.add(obj.id);
    }
  }
  const out = [];
  for (const r of defs.values()) if (!canceled.has(r.id)) out.push(r);
  out.sort((a, b) => new Date(a.definedAt) - new Date(b.definedAt));
  return out;
}

export function newReminderId() {
  const tt = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `R-${tt}-${r}`;
}

export function addReminder({ label, schedule }) {
  const text = (typeof label === 'string' ? label : '').trim();
  if (!text) return { ok: false, error: { code: 'label', errorKey: 'reminder.label.required' } };
  if (!isValidSchedule(schedule)) return { ok: false, error: { code: 'schedule' } };
  const id = newReminderId();
  const payload = { id, label: text.slice(0, 200), schedule };
  return logNote({ notes: REMINDER_TAG + JSON.stringify(payload) });
}

export function cancelReminder(id) {
  if (!id) return { ok: false, error: { code: 'id' } };
  return logNote({ notes: CANCEL_TAG + JSON.stringify({ id }) });
}

// Plain check-off note: notes = reminder.label.
export function checkOffReminder(reminder, when) {
  if (!reminder || typeof reminder.label !== 'string') return { ok: false, error: { code: 'reminder' } };
  return logNote({ notes: reminder.label, when });
}

// Today's scheduled instances for a single reminder.
// Returns [{ dueAt: Date, completedAt: Date|null }] sorted ascending.
// FIFO match: earliest completion ↔ earliest instance.
export function todaysInstances(reminder, events = getState().events ?? [], now = new Date()) {
  const out = [];
  const sched = reminder.schedule;
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);
  const completions = events
    .filter((e) => e.type === 'note' && e.notes === reminder.label)
    .map((e) => new Date(e.timestamp))
    .filter((d) => d >= todayStart && d < todayEnd)
    .sort((a, b) => a - b);
  const remaining = completions.slice();
  const push = (dueAt) => out.push({ dueAt, completedAt: remaining.length ? remaining.shift() : null });

  if (sched.kind === 'dailyAt') {
    const [h, m] = sched.time.split(':').map(Number);
    const dueAt = new Date(todayStart); dueAt.setHours(h, m, 0, 0);
    push(dueAt);
  } else if (sched.kind === 'everyHours') {
    const [h, m] = sched.anchor.split(':').map(Number);
    const anchor = new Date(todayStart); anchor.setHours(h, m, 0, 0);
    // First instance ≥ todayStart; if anchor is past midnight (rare), back-step.
    let dueAt = new Date(anchor);
    while (dueAt.getTime() - sched.n * 3_600_000 >= todayStart.getTime()) {
      dueAt = new Date(dueAt.getTime() - sched.n * 3_600_000);
    }
    while (dueAt.getTime() < todayEnd.getTime()) {
      if (dueAt.getTime() >= todayStart.getTime()) push(new Date(dueAt));
      dueAt = new Date(dueAt.getTime() + sched.n * 3_600_000);
    }
  } else if (sched.kind === 'oncesAt') {
    const dueAt = new Date(sched.iso);
    if (dueAt >= todayStart && dueAt < todayEnd) {
      push(dueAt);
    } else if (dueAt < todayStart) {
      // Past one-shot: surface if no check-off ever recorded.
      const ever = events.find((e) => e.type === 'note' && e.notes === reminder.label);
      if (!ever) push(dueAt);
    }
  }
  return out;
}

// Flat checklist for "today" across all active reminders, sorted by dueAt.
// Each row: { reminder, dueAt, completedAt, status }.
//   status ∈ 'done' | 'overdue' | 'upcoming'
export function checklistForToday(events = getState().events ?? [], now = new Date()) {
  const out = [];
  for (const rem of getReminders(events)) {
    for (const inst of todaysInstances(rem, events, now)) {
      let status = 'upcoming';
      if (inst.completedAt) status = 'done';
      else if (inst.dueAt.getTime() <= now.getTime()) status = 'overdue';
      out.push({ reminder: rem, dueAt: inst.dueAt, completedAt: inst.completedAt, status });
    }
  }
  out.sort((a, b) => a.dueAt - b.dueAt);
  return out;
}

// Human-readable schedule (uses the locale t function passed in).
export function describeSchedule(s, t) {
  if (!s) return '';
  if (s.kind === 'dailyAt') return t('reminder.list.dailyAtFormat', { time: s.time });
  if (s.kind === 'everyHours') return t('reminder.list.everyHoursFormat', { n: s.n, time: s.anchor });
  if (s.kind === 'oncesAt') {
    const d = new Date(s.iso);
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return t('reminder.list.oncesAtFormat', { when: fmt });
  }
  return '';
}
