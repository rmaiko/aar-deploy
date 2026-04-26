// js/csv.js — C-12 CSV export + import.
//
// Eight-column lock per ADR-007:
//   schema_version, type, side, start, duration_min, weight_kg, length_cm, notes
// UTF-8 BOM (NFR-20), \r\n line terminator, ISO-8601 with offset timestamps.

import { SCHEMA_VERSION } from './schema.js';

export const HEADER_COLS = ['schema_version', 'type', 'side', 'start', 'duration_min', 'weight_kg', 'length_cm', 'notes'];
export const HEADER_ROW = HEADER_COLS.join(',');
export const BOM = '﻿';
export const LINE_END = '\r\n';

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function eventToRow(ev, schemaVersion) {
  const cells = [
    String(schemaVersion),
    ev.type,
    ev.side ?? '',
    ev.timestamp,
    ev.durationMin != null ? String(ev.durationMin) : '',
    ev.weightKg != null ? String(ev.weightKg) : '',
    ev.lengthCm != null ? String(ev.lengthCm) : '',
    ev.notes ?? '',
  ];
  return cells.map(csvEscape).join(',');
}

// @req FR-42
// @req FR-43
// @req NFR-20
// @req NFR-24
export function buildCsv(state) {
  const rows = state.events.map((ev) => eventToRow(ev, state.schemaVersion ?? SCHEMA_VERSION));
  return BOM + HEADER_ROW + LINE_END + rows.join(LINE_END) + (rows.length ? LINE_END : '');
}

// @req FR-44
export function exportFilename(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `aar-deploy-export-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
}

// @req FR-48
export function buildTemplateCsv() {
  return BOM + HEADER_ROW + LINE_END +
    '# example: feed,port,2026-04-26T08:00:00-03:00,15,,,' + LINE_END;
}

// @req FR-42
// @req FR-47
export function triggerDownload(blob, filename, doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc) return { ok: false, error: { code: 'noDocument' } };
  try {
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    doc.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { doc.body.removeChild(a); } catch { /* ignore */ }
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }, 0);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'blocked', message: String(e?.message ?? e) } };
  }
}

// ─── Import side ─────────────────────────────────────────────────────────

const COLUMN_ALIASES = new Map([
  ['type', 'type'], ['event_type', 'type'], ['kind', 'type'],
  ['side', 'side'],
  ['start', 'start'], ['timestamp', 'start'], ['ts', 'start'], ['time', 'start'],
  ['duration_min', 'duration_min'], ['duration', 'duration_min'], ['minutes', 'duration_min'],
  ['weight_kg', 'weight_kg'], ['weight', 'weight_kg'], ['kg', 'weight_kg'],
  ['length_cm', 'length_cm'], ['length', 'length_cm'], ['cm', 'length_cm'],
  ['notes', 'notes'],
  ['schema_version', 'schema_version'], ['version', 'schema_version'],
]);

const REQUIRED = ['type', 'start'];
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_NO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

// Naive CSV row parser handling quoted cells & escaped quotes. No newlines
// inside quoted cells (project events never contain them).
function parseLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') inQ = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// @req FR-49
// @req FR-54
// @req FR-55
// @req FR-56
// @req FR-57
// @req NFR-24
export function parseCsv(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, error: { code: 'malformed', errorKey: 'csv.import.malformed' } };
  }
  // Strip BOM.
  let body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  // Normalise line endings.
  body = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = body.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) {
    return { ok: false, error: { code: 'malformed', errorKey: 'csv.import.malformed' } };
  }
  // Quick malformed-file detector: a CSV's first line should be printable
  // ASCII/UTF-8 (no NULs / control chars other than tab).
  if (/[\x00-\x08\x0B-\x1F]/.test(lines[0])) {
    return { ok: false, error: { code: 'malformed', errorKey: 'csv.import.malformed' } };
  }
  const headerCells = parseLine(lines[0]).map((s) => s.trim().toLowerCase());
  const colMap = headerCells.map((h) => COLUMN_ALIASES.get(h) ?? null);
  // Required columns (REQUIRED are always required; schema_version is recommended but not required at parse time)
  for (const req of REQUIRED) {
    if (!colMap.includes(req)) {
      return { ok: false, error: { code: 'missingColumn', errorKey: 'csv.import.missingColumn', column: req } };
    }
  }
  const valid = [];
  const skipped = [];
  let tzWarning = false;
  let importedSchemaVersion = null;
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const row = {};
    for (let c = 0; c < headerCells.length; c++) {
      const key = colMap[c];
      if (key) row[key] = cells[c]?.trim() ?? '';
    }
    if (!row.type || !['feed', 'wet', 'dirty', 'weight', 'note'].includes(row.type)) {
      skipped.push({ line: i + 1, reason: 'unknownType', row });
      continue;
    }
    let ts = row.start;
    if (!ts) { skipped.push({ line: i + 1, reason: 'malformedRow', row }); continue; }
    if (ISO_NO_OFFSET_RE.test(ts) && !ISO_OFFSET_RE.test(ts)) {
      // Local-time fallback per FR-54.
      const local = new Date(ts);
      if (Number.isNaN(local.getTime())) { skipped.push({ line: i + 1, reason: 'malformedRow', row }); continue; }
      const pad = (n) => String(n).padStart(2, '0');
      const tz = -local.getTimezoneOffset();
      const sign = tz >= 0 ? '+' : '-';
      const a = Math.floor(Math.abs(tz) / 60);
      const b = Math.abs(tz) % 60;
      ts = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}${sign}${pad(a)}:${pad(b)}`;
      tzWarning = true;
    } else if (!ISO_OFFSET_RE.test(ts)) {
      skipped.push({ line: i + 1, reason: 'malformedRow', row }); continue;
    }
    const tDate = new Date(ts);
    if (Number.isNaN(tDate.getTime())) { skipped.push({ line: i + 1, reason: 'malformedRow', row }); continue; }
    if (tDate.getTime() > Date.now() + 60_000) { skipped.push({ line: i + 1, reason: 'future', row }); continue; }

    const ev = { type: row.type, timestamp: ts };
    if (row.type === 'feed') {
      if (row.side !== 'port' && row.side !== 'starboard') { skipped.push({ line: i + 1, reason: 'outOfRange', row }); continue; }
      ev.side = row.side;
      if (row.duration_min !== undefined && row.duration_min !== '') {
        const n = Number(row.duration_min);
        if (!Number.isFinite(n) || n < 0 || n > 240) { skipped.push({ line: i + 1, reason: 'outOfRange', row }); continue; }
        ev.durationMin = n;
      }
    }
    if (row.type === 'weight') {
      const w = Number(row.weight_kg);
      const l = Number(row.length_cm);
      if (!Number.isFinite(w) || w < 0.1 || w > 50) { skipped.push({ line: i + 1, reason: 'outOfRange', row }); continue; }
      if (!Number.isFinite(l) || l < 10 || l > 200) { skipped.push({ line: i + 1, reason: 'outOfRange', row }); continue; }
      ev.weightKg = w;
      ev.lengthCm = l;
    }
    if (row.notes !== undefined && row.notes !== '') {
      ev.notes = String(row.notes).slice(0, 500);
    }
    if (row.schema_version !== undefined && row.schema_version !== '') {
      const v = Number(row.schema_version);
      if (Number.isFinite(v) && Number.isInteger(v) && v >= 1) {
        importedSchemaVersion = v;
        if (v > SCHEMA_VERSION) {
          return { ok: false, error: { code: 'schemaTooNew', errorKey: 'share.schemaVersionTooNew' } };
        }
      }
    }
    ev.id = `evt_${row.type}_${ts.replace(/[:.]/g, '-')}_${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
    valid.push(ev);
  }
  // Group skip reasons.
  const groupedSkips = {};
  for (const s of skipped) groupedSkips[s.reason] = (groupedSkips[s.reason] ?? 0) + 1;
  const dates = valid.map((e) => new Date(e.timestamp).getTime());
  const dateRange = dates.length ? { from: new Date(Math.min(...dates)).toISOString(), to: new Date(Math.max(...dates)).toISOString() } : null;
  return {
    ok: true,
    value: {
      valid,
      skipped,
      skippedGrouped: groupedSkips,
      tzWarning,
      dateRange,
      schemaVersion: importedSchemaVersion ?? SCHEMA_VERSION,
    },
  };
}
