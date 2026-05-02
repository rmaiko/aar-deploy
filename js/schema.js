// js/schema.js — C-04 schema, migrations, JSON-parse reviver.
//
// Single owner of the canonical appState shape (ADR-004), the integer
// SCHEMA_VERSION constant (NFR-24), and the prototype-pollution-stripping
// JSON reviver used on every untrusted inbound payload (NFR-22, NFR-23,
// architecture §3.7).

import { SCHEMA_VERSION as CFG_SCHEMA_VERSION } from './config.js';

// @req NFR-24
export const SCHEMA_VERSION = CFG_SCHEMA_VERSION;

const EVENT_TYPES = new Set(['feed', 'wet', 'dirty', 'weight', 'note']);
const SYSTEM_LOG_TYPES = new Set(['milestone_rebuild']);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'events',
  'milestones',
  'system_log',
  'settings',
  'lastExportAt',
  'firstRunDismissed',
  'lastVisitDate',
  'lastNudgeDismissAt',
  'themePreference',
  'commsRelayDays',
  'cloud',
]);

// ISO-8601 with explicit offset: yyyy-mm-ddThh:mm[:ss[.fff]](Z|±hh:mm)
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// @req FR-92
export function defaultAppState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    events: [],
    milestones: [],
    system_log: [],
    settings: {
      humourEnabled: true,
      vibrationEnabled: false,
      diagnosticMode: false,
    },
    lastExportAt: null,
    firstRunDismissed: false,
    lastVisitDate: null,
    lastNudgeDismissAt: null,
    themePreference: null,
    commsRelayDays: 7,
    cloud: defaultCloudState(),
  };
}

// @req AMD-003
// Local-only mirror of cloud sync session state. Never synced anywhere
// (FR-220) — synced events go through the separate aar.syncQueue key.
export function defaultCloudState() {
  return {
    enabled: false,
    lastPulledAt: null,
    activeFamilyId: null,
    activeFamilyName: null,
    rememberedEmail: null,
  };
}

// @req NFR-22
// @req NFR-23
// JSON.parse reviver — strips dunder keys at every nesting level.
export function prototypeStrippingReviver(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return undefined;
  }
  return value;
}

// @req NFR-22
// @req NFR-23
export function safeJsonParse(text) {
  try {
    const parsed = JSON.parse(text, prototypeStrippingReviver);
    return { ok: true, value: parsed };
  } catch (e) {
    return { ok: false, error: { code: 'parse', message: String(e?.message ?? e) } };
  }
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// @req FR-92
function validateEvent(ev) {
  if (!isPlainObject(ev)) return 'event is not an object';
  if (!EVENT_TYPES.has(ev.type)) return `unknown event type: ${String(ev.type)}`;
  if (typeof ev.timestamp !== 'string' || !ISO_OFFSET_RE.test(ev.timestamp)) {
    return 'event.timestamp must be ISO-8601 with explicit offset';
  }
  if (ev.type === 'feed') {
    if (ev.side !== 'port' && ev.side !== 'starboard') return 'feed event missing/invalid side';
    if (ev.durationMin != null && (typeof ev.durationMin !== 'number' || ev.durationMin < 0 || ev.durationMin > 240)) {
      return 'feed durationMin out of range';
    }
  }
  if (ev.type === 'weight') {
    const hasW = ev.weightKg != null;
    const hasL = ev.lengthCm != null;
    if (!hasW && !hasL) return 'weight event needs at least weightKg or lengthCm';
    if (hasW && (typeof ev.weightKg !== 'number' || ev.weightKg < 0.1 || ev.weightKg > 50)) return 'weight out of range';
    if (hasL && (typeof ev.lengthCm !== 'number' || ev.lengthCm < 10 || ev.lengthCm > 200)) return 'length out of range';
  }
  if (ev.type === 'note') {
    if (typeof ev.notes !== 'string' || ev.notes.length === 0) return 'note event requires non-empty notes';
  }
  return null;
}

function stripUnknownEventKeys(ev) {
  const allowed = ['id', 'type', 'timestamp', 'side', 'durationMin', 'weightKg', 'lengthCm', 'notes'];
  const out = {};
  for (const k of allowed) if (k in ev) out[k] = ev[k];
  return out;
}

function validateMilestone(m) {
  if (!isPlainObject(m)) return 'milestone is not an object';
  if (typeof m.id !== 'string' || !m.id) return 'milestone.id missing';
  if (typeof m.type !== 'string') return 'milestone.type missing';
  if (typeof m.awardedAt !== 'string' || !ISO_OFFSET_RE.test(m.awardedAt)) return 'milestone.awardedAt invalid';
  return null;
}

function validateSystemLog(s) {
  if (!isPlainObject(s)) return 'system_log entry is not an object';
  if (typeof s.id !== 'string' || !s.id) return 'system_log.id missing';
  if (!SYSTEM_LOG_TYPES.has(s.type)) return `unknown system_log type: ${String(s.type)}`;
  if (typeof s.timestamp !== 'string' || !ISO_OFFSET_RE.test(s.timestamp)) return 'system_log.timestamp invalid';
  return null;
}

// @req FR-92
// @req NFR-24
export function validate(payload) {
  if (!isPlainObject(payload)) return { ok: false, error: { code: 'shape', message: 'payload is not an object' } };
  if (typeof payload.schemaVersion !== 'number' || !Number.isInteger(payload.schemaVersion) || payload.schemaVersion < 1) {
    return { ok: false, error: { code: 'schemaVersion', message: 'schemaVersion must be a positive integer' } };
  }
  if (payload.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, error: { code: 'schemaTooNew', message: `payload schemaVersion ${payload.schemaVersion} > supported ${SCHEMA_VERSION}` } };
  }
  // Reject unknown top-level keys.
  for (const k of Object.keys(payload)) {
    if (!TOP_LEVEL_KEYS.has(k)) return { ok: false, error: { code: 'unknownKey', message: `unknown top-level key: ${k}` } };
  }
  if (!Array.isArray(payload.events)) return { ok: false, error: { code: 'shape', message: 'events must be an array' } };
  for (let i = 0; i < payload.events.length; i++) {
    const err = validateEvent(payload.events[i]);
    if (err) return { ok: false, error: { code: 'event', message: `events[${i}]: ${err}` } };
  }
  if (payload.milestones != null) {
    if (!Array.isArray(payload.milestones)) return { ok: false, error: { code: 'shape', message: 'milestones must be an array' } };
    for (let i = 0; i < payload.milestones.length; i++) {
      const err = validateMilestone(payload.milestones[i]);
      if (err) return { ok: false, error: { code: 'milestone', message: `milestones[${i}]: ${err}` } };
    }
  }
  if (payload.system_log != null) {
    if (!Array.isArray(payload.system_log)) return { ok: false, error: { code: 'shape', message: 'system_log must be an array' } };
    for (let i = 0; i < payload.system_log.length; i++) {
      const err = validateSystemLog(payload.system_log[i]);
      if (err) return { ok: false, error: { code: 'system_log', message: `system_log[${i}]: ${err}` } };
    }
  }
  if (payload.settings != null && !isPlainObject(payload.settings)) {
    return { ok: false, error: { code: 'shape', message: 'settings must be an object' } };
  }
  if (payload.cloud != null) {
    const err = validateCloud(payload.cloud);
    if (err) return { ok: false, error: { code: 'cloud', message: err } };
  }
  return { ok: true, value: payload };
}

function validateCloud(c) {
  if (!isPlainObject(c)) return 'cloud must be an object';
  if (typeof c.enabled !== 'boolean') return 'cloud.enabled must be boolean';
  if (c.lastPulledAt != null && (typeof c.lastPulledAt !== 'string' || !ISO_OFFSET_RE.test(c.lastPulledAt))) {
    return 'cloud.lastPulledAt must be ISO-8601 with offset, or null';
  }
  if (c.activeFamilyId != null && typeof c.activeFamilyId !== 'string') return 'cloud.activeFamilyId must be string or null';
  if (c.activeFamilyName != null && typeof c.activeFamilyName !== 'string') return 'cloud.activeFamilyName must be string or null';
  if (c.rememberedEmail != null && typeof c.rememberedEmail !== 'string') return 'cloud.rememberedEmail must be string or null';
  return null;
}

// @req FR-92
// applyDefaults: merge a (validated or partial) payload onto defaultAppState.
// Tolerates extra unknown keys on events by stripping them.
export function applyDefaults(payload) {
  const def = defaultAppState();
  if (!isPlainObject(payload)) return def;
  const out = { ...def };
  if (typeof payload.schemaVersion === 'number') out.schemaVersion = payload.schemaVersion;
  if (Array.isArray(payload.events)) out.events = payload.events.map(stripUnknownEventKeys);
  if (Array.isArray(payload.milestones)) out.milestones = payload.milestones.slice();
  if (Array.isArray(payload.system_log)) out.system_log = payload.system_log.slice();
  if (isPlainObject(payload.settings)) out.settings = { ...def.settings, ...payload.settings };
  for (const k of ['lastExportAt', 'firstRunDismissed', 'lastVisitDate', 'lastNudgeDismissAt', 'themePreference', 'commsRelayDays']) {
    if (k in payload) out[k] = payload[k];
  }
  if (isPlainObject(payload.cloud)) out.cloud = { ...def.cloud, ...payload.cloud };
  return out;
}

// @req NFR-24
// Sequential migration array. v1 has no migrations.
const migrations = [
  // { from: 1, to: 2, run: (s) => ({ ...s, schemaVersion: 2 }) },
];

export function migrate(payload) {
  if (!isPlainObject(payload)) return { ok: false, error: { code: 'shape', message: 'not an object' } };
  let current = payload;
  while (current.schemaVersion < SCHEMA_VERSION) {
    const m = migrations.find((x) => x.from === current.schemaVersion);
    if (!m) return { ok: false, error: { code: 'migrate', message: `no migration from ${current.schemaVersion}` } };
    current = m.run(current);
  }
  return { ok: true, value: current };
}

// @req NFR-22
// @req NFR-23
// Decode pipeline used by share-link receiver and any untrusted inbound
// JSON.  byte-cap → JSON.parse(reviver) → schema walker → version check.
export function safeDecode(text, { maxBytes } = { maxBytes: 256 * 1024 }) {
  if (typeof text !== 'string') return { ok: false, error: { code: 'type', message: 'not a string' } };
  if (text.length > maxBytes) return { ok: false, error: { code: 'tooLarge', message: 'payload exceeds size cap' } };
  const parsed = safeJsonParse(text);
  if (!parsed.ok) return parsed;
  const validated = validate(parsed.value);
  if (!validated.ok) return validated;
  if (validated.value.schemaVersion < SCHEMA_VERSION) return migrate(validated.value);
  return validated;
}
