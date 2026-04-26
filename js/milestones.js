// js/milestones.js — C-11 milestone evaluator + rebuild.
//
// Pure functions. evaluate(events, prevMilestones) → { awarded, all }
// rebuild(events) reconstructs the full earned set; FR-110 logs a
// system_log "milestone_rebuild" entry when invoked.

import {
  MILESTONE_WEIGHT_MIN_KG,
  MILESTONE_LONGEST_GAP_DELTA_MIN,
  MILESTONE_QUIET_NIGHT_HOURS,
  MILESTONE_QUIET_NIGHT_START_HOUR,
  MILESTONE_QUIET_NIGHT_END_HOUR,
  MILESTONE_ROUTINE_CV_THRESHOLD,
  MILESTONE_ROUTINE_RUN_LENGTH,
  MILESTONE_DAYS_FLOWN_INTERVAL_DAYS,
  MILESTONE_TRANSFERS,
} from './config.js';
import { dispatch, getState } from './state.js';
import { writeState } from './storage.js';

function tsMs(ev) { return new Date(ev.timestamp).getTime(); }

// @req FR-102
function evalWeightThreshold(events) {
  const out = [];
  let highest = 0;
  for (const ev of events.filter((e) => e.type === 'weight').sort((a, b) => tsMs(a) - tsMs(b))) {
    const kgFloor = Math.floor(ev.weightKg);
    if (kgFloor >= MILESTONE_WEIGHT_MIN_KG && kgFloor > highest) {
      for (let k = Math.max(highest + 1, MILESTONE_WEIGHT_MIN_KG); k <= kgFloor; k++) {
        out.push({
          id: `wt_threshold_${k}kg`,
          type: 'weight_threshold',
          awardedAt: ev.timestamp,
          payload: { kg: k },
        });
      }
      highest = kgFloor;
    }
  }
  return out;
}

// @req FR-103
function evalLongestGap(events) {
  const feeds = events.filter((e) => e.type === 'feed').sort((a, b) => tsMs(a) - tsMs(b));
  if (feeds.length < 5) return [];
  const out = [];
  let record = 0;
  for (let i = 1; i < feeds.length; i++) {
    const gap = (tsMs(feeds[i]) - tsMs(feeds[i - 1])) / 60_000;
    if (i >= 4 && gap >= record + MILESTONE_LONGEST_GAP_DELTA_MIN) {
      record = Math.round(gap);
      out.push({
        id: `gap_${record}min_${feeds[i].timestamp}`,
        type: 'longest_feeding_gap',
        awardedAt: feeds[i].timestamp,
        payload: { minutes: record },
      });
    } else if (i >= 4 && gap > record) {
      record = Math.round(gap);
    }
  }
  return out;
}

// @req FR-104
function evalFirstQuietNight(events) {
  const feeds = events.filter((e) => e.type === 'feed').map(tsMs).sort((a, b) => a - b);
  if (feeds.length === 0) return [];
  // Walk every night window [22:00 → 06:00] from earliest event date to today.
  const hours = MILESTONE_QUIET_NIGHT_HOURS * 3600 * 1000;
  const start = new Date(feeds[0]);
  const end = new Date();
  for (let day = new Date(start.getFullYear(), start.getMonth(), start.getDate()); day <= end; day.setDate(day.getDate() + 1)) {
    // window is "22:00 of day → 06:00 of day+1"
    const windowStart = new Date(day);
    windowStart.setHours(MILESTONE_QUIET_NIGHT_START_HOUR, 0, 0, 0);
    const windowEnd = new Date(day);
    windowEnd.setDate(windowEnd.getDate() + 1);
    windowEnd.setHours(MILESTONE_QUIET_NIGHT_END_HOUR, 0, 0, 0);
    // need a contiguous 6h subwindow inside [windowStart, windowEnd] with no feeds
    const windowEvents = feeds.filter((t) => t >= windowStart.getTime() && t <= windowEnd.getTime());
    let cursor = windowStart.getTime();
    let awarded = false;
    for (const t of windowEvents) {
      if (t - cursor >= hours) { awarded = true; break; }
      cursor = t;
    }
    if (!awarded && windowEnd.getTime() - cursor >= hours) awarded = true;
    if (awarded) {
      return [{
        id: 'first_quiet_night',
        type: 'first_quiet_night',
        awardedAt: new Date(windowEnd).toISOString(),
        payload: {},
      }];
    }
  }
  return [];
}

// @req FR-105
function evalSettledRoutine(events) {
  const feeds = events.filter((e) => e.type === 'feed').sort((a, b) => tsMs(a) - tsMs(b));
  if (feeds.length < 8) return [];
  const intervals = [];
  for (let i = 1; i < feeds.length; i++) intervals.push((tsMs(feeds[i]) - tsMs(feeds[i - 1])) / 60_000);
  let runs = 0;
  for (let i = 4; i < intervals.length; i++) {
    const window = intervals.slice(i - 4, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / window.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : Infinity;
    if (cv < MILESTONE_ROUTINE_CV_THRESHOLD) {
      runs++;
      if (runs >= MILESTONE_ROUTINE_RUN_LENGTH) {
        return [{
          id: 'settled_into_routine',
          type: 'settled_into_routine',
          awardedAt: feeds[i + 1].timestamp,
          payload: {},
        }];
      }
    } else {
      runs = 0;
    }
  }
  return [];
}

// @req FR-106
function evalDaysFlown(events) {
  if (events.length === 0) return [];
  const sorted = events.slice().sort((a, b) => tsMs(a) - tsMs(b));
  const first = tsMs(sorted[0]);
  const last = tsMs(sorted[sorted.length - 1]);
  const elapsedDays = Math.floor((last - first) / (24 * 3600 * 1000));
  const out = [];
  for (let n = MILESTONE_DAYS_FLOWN_INTERVAL_DAYS; n <= elapsedDays; n += MILESTONE_DAYS_FLOWN_INTERVAL_DAYS) {
    out.push({
      id: `days_flown_${n}`,
      type: 'days_flown',
      awardedAt: new Date(first + n * 24 * 3600 * 1000).toISOString(),
      payload: { day: n },
    });
  }
  return out;
}

// @req FR-107
function evalTotalTransfers(events) {
  const feedCount = events.filter((e) => e.type === 'feed').length;
  const out = [];
  for (const threshold of MILESTONE_TRANSFERS) {
    if (feedCount >= threshold) {
      // Award timestamp ~ the threshold-th feed
      const sorted = events.filter((e) => e.type === 'feed').sort((a, b) => tsMs(a) - tsMs(b));
      const ts = sorted[threshold - 1]?.timestamp ?? new Date().toISOString();
      out.push({ id: `transfers_${threshold}`, type: 'total_transfers', awardedAt: ts, payload: { count: threshold } });
    }
  }
  return out;
}

// @req FR-101
// @req FR-109
// @req NFR-27
export function rebuild(events) {
  const candidates = [
    ...evalWeightThreshold(events),
    ...evalLongestGap(events),
    ...evalFirstQuietNight(events),
    ...evalSettledRoutine(events),
    ...evalDaysFlown(events),
    ...evalTotalTransfers(events),
  ];
  // Idempotent set semantics keyed by id.
  const seen = new Set();
  const out = [];
  for (const m of candidates) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

// @req FR-101
// @req FR-109
export function evaluate(events, prevMilestones = []) {
  const all = rebuild(events);
  const prev = new Set(prevMilestones.map((m) => m.id));
  const awarded = all.filter((m) => !prev.has(m.id));
  return { awarded, all };
}

// @req FR-110
// rebuildIfMissing: invoked at boot when appState.milestones is missing or
// structurally invalid — silently re-derives + appends one system_log entry.
export function rebuildIfMissing(state) {
  if (Array.isArray(state.milestones) && state.milestones.every((m) => m && typeof m.id === 'string')) {
    return { rebuilt: false };
  }
  const all = rebuild(state.events);
  dispatch({ type: 'milestones/set', payload: all });
  const ts = new Date().toISOString();
  const entry = {
    id: `syslog_${ts.replace(/[:.]/g, '-')}_${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`,
    type: 'milestone_rebuild',
    timestamp: ts,
    payload: { rebuiltCount: all.length },
  };
  dispatch({ type: 'systemLog/append', payload: entry });
  writeState(getState());
  return { rebuilt: true, count: all.length };
}

// Default per-event hook called from events.js after every commit.
// Cheap path: only append newly-earned milestones.
// @req FR-101
export function evaluateAndPersist(state) {
  const { awarded } = evaluate(state.events, state.milestones);
  if (awarded.length === 0) return { awarded: [] };
  dispatch({ type: 'milestones/append', payload: awarded });
  writeState(getState());
  return { awarded };
}
