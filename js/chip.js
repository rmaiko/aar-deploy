// js/chip.js — C-09 back-date chip.
//
// Pure helpers for resolving the chip-selected timestamp + range checks.
// FR-10 (offsets), FR-11 (custom picker), FR-12 (future-time reject),
// FR-13 (>24h-past reject), FR-14 (one-tap reset).

import { CHIP_OFFSETS_MIN, BACKDATE_LIMIT_HOURS, CHIP_RESET_INACTIVITY_MS } from './config.js';

let selection = { kind: 'now' };
let resetTimer = null;
const subs = new Set();

// @req FR-10
export function getOffsets() {
  return CHIP_OFFSETS_MIN.slice();
}

// @req FR-10
// @req FR-11
export function setSelection(sel) {
  selection = sel ?? { kind: 'now' };
  notify();
  scheduleAutoReset();
}

export function getSelection() {
  return { ...selection };
}

// @req FR-14
export function reset() {
  selection = { kind: 'now' };
  notify();
}

function scheduleAutoReset() {
  if (resetTimer) clearTimeout(resetTimer);
  if (selection.kind === 'now') return;
  resetTimer = setTimeout(() => {
    resetTimer = null;
    reset();
  }, CHIP_RESET_INACTIVITY_MS);
}

function notify() {
  for (const cb of subs) { try { cb(selection); } catch { /* swallow */ } }
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

// @req FR-10
// @req FR-11
// resolveTimestamp(now, sel) → { ok, value, errorKey? }
export function resolveTimestamp(now = new Date(), sel = selection) {
  const ts = (sel.kind === 'custom' && sel.iso) ? new Date(sel.iso) : computeOffset(now, sel);
  return checkRange(now, ts);
}

function computeOffset(now, sel) {
  if (sel.kind === 'minAgo' && Number.isFinite(sel.minutes)) {
    return new Date(now.getTime() - sel.minutes * 60_000);
  }
  return new Date(now);
}

// @req FR-09
// @req FR-12
// @req FR-13
export function checkRange(now, ts) {
  if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) {
    return { ok: false, errorKey: 'time.notFuture' };
  }
  if (ts.getTime() > now.getTime() + 1000) {
    return { ok: false, errorKey: 'time.notFuture' };
  }
  const limit = BACKDATE_LIMIT_HOURS * 3600 * 1000;
  if (now.getTime() - ts.getTime() > limit) {
    return { ok: false, errorKey: 'chip.olderHint' };
  }
  return { ok: true, value: ts };
}

// @req FR-43
// Format a Date as ISO-8601 with explicit local offset.
export function toLocalIso(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const M = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const tz = -date.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const a = Math.floor(Math.abs(tz) / 60);
  const b = Math.abs(tz) % 60;
  return `${y}-${M}-${d}T${h}:${m}:${s}${sign}${pad(a)}:${pad(b)}`;
}
