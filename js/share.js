// js/share.js — C-13 share-link encode + decode pipeline.
//
// Encode: { schemaVersion, events } → JSON → lz-string-encoded fragment.
// Decode: byte-cap → lz-decompress → byte-cap → JSON.parse(reviver) →
// schema walker → schemaVersion check  (architecture §3.7).

import { LZString } from './vendor/lz-string.js';
import { SCHEMA_VERSION, prototypeStrippingReviver, validate, migrate } from './schema.js';
import {
  SHARE_FRAGMENT_BYTE_CAP, SHARE_FRAGMENT_HARD_CAP, SHARE_DECOMPRESS_BYTE_CAP,
  SHARE_DAY_DEFAULT, SHARE_DAY_MAX,
} from './config.js';

// @req FR-111
export function clampDays(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return SHARE_DAY_DEFAULT;
  return Math.min(SHARE_DAY_MAX, Math.max(1, Math.floor(v)));
}

// @req FR-112
// @req FR-115
// @req NFR-22
// @req NFR-23
export function encodePayload(events, schemaVersion = SCHEMA_VERSION, { days = null } = {}) {
  let selected = events;
  if (Number.isFinite(days)) {
    const since = Date.now() - days * 24 * 3600 * 1000;
    selected = events.filter((e) => new Date(e.timestamp).getTime() >= since);
  }
  const payload = { schemaVersion, events: selected };
  const json = JSON.stringify(payload);
  const compressed = LZString.compressToEncodedURIComponent(json);
  const overflow = compressed.length > SHARE_FRAGMENT_BYTE_CAP;
  return { ok: !overflow, value: compressed, length: compressed.length, overflow, payload };
}

// @req FR-112
export function buildShareUrl(compressed, base = (typeof location !== 'undefined' ? location.origin + location.pathname : '/')) {
  return `${base}#d=${compressed}`;
}

// @req FR-118
// @req FR-123
// @req NFR-22
// @req NFR-23
// @req NFR-24
export function decodeFragment(fragment) {
  if (typeof fragment !== 'string' || fragment.length === 0) {
    return { ok: false, error: { code: 'empty', errorKey: 'share.corrupt.decodeFailed' } };
  }
  // Stage 1 — byte cap on the compressed payload.
  if (fragment.length > SHARE_FRAGMENT_HARD_CAP) {
    return { ok: false, error: { code: 'tooLarge', errorKey: 'share.corrupt.bodyTooLarge' } };
  }
  // Stage 2 — lz decompress.
  let decompressed;
  try { decompressed = LZString.decompressFromEncodedURIComponent(fragment); }
  catch (e) { return { ok: false, error: { code: 'decode', errorKey: 'share.corrupt.decodeFailed', message: String(e?.message ?? e) } }; }
  if (decompressed == null || decompressed === '') {
    return { ok: false, error: { code: 'decode', errorKey: 'share.corrupt.decodeFailed' } };
  }
  // Stage 3 — byte cap on decompressed.
  if (decompressed.length > SHARE_DECOMPRESS_BYTE_CAP) {
    return { ok: false, error: { code: 'tooLarge', errorKey: 'share.corrupt.bodyTooLarge' } };
  }
  // Stage 4 — JSON parse with prototype-stripping reviver.
  let parsed;
  try { parsed = JSON.parse(decompressed, prototypeStrippingReviver); }
  catch (e) { return { ok: false, error: { code: 'json', errorKey: 'share.corrupt.invalidJson', message: String(e?.message ?? e) } }; }
  // Stage 5 — schema walk.
  const v = validate(parsed);
  if (!v.ok) {
    if (v.error.code === 'schemaTooNew') return { ok: false, error: { code: 'schemaTooNew', errorKey: 'share.schemaVersionTooNew' } };
    return { ok: false, error: { code: 'schema', errorKey: 'share.corrupt.invalidSchema', message: v.error.message } };
  }
  // Stage 6 — migration.
  if (v.value.schemaVersion < SCHEMA_VERSION) {
    const m = migrate(v.value);
    if (!m.ok) return { ok: false, error: { code: 'migrate', errorKey: 'share.corrupt.invalidSchema' } };
    return { ok: true, value: m.value };
  }
  return { ok: true, value: v.value };
}
