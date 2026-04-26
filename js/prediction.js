// js/prediction.js — C-10 pure prediction functions.
//
// Feeding vector: EWMA-5 with α = 0.3 over the last 5 feeding intervals;
// band = stddev(last5) clamped to ≥ 10 min (FR-36).
// Diaper vector: dual-λ exponential — λ_post-feed (intervals where the
// prior event was a feed within 90 min) vs λ_baseline (all others); active
// branch picked from elapsed-time-since-last-feed (FR-96).

import {
  EWMA_ALPHA, EWMA_WINDOW, PREDICTION_BAND_FLOOR_MIN, STALE_FACTOR,
  POST_FEED_WINDOW_MIN, DIAPER_WINDOW,
} from './config.js';

function tsMs(ev) { return new Date(ev.timestamp).getTime(); }

function intervalsMin(events) {
  const out = [];
  for (let i = 1; i < events.length; i++) {
    out.push((tsMs(events[i]) - tsMs(events[i - 1])) / 60_000);
  }
  return out;
}

function ewma(values, alpha) {
  if (values.length === 0) return 0;
  let acc = values[0];
  for (let i = 1; i < values.length; i++) acc = alpha * values[i] + (1 - alpha) * acc;
  return acc;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// @req FR-35
// @req FR-36
// @req FR-37
// @req FR-38
// @req FR-39
// @req FR-40
// @req FR-41
// @req NFR-04
export function predictFeed(events, now = new Date(), { isEmcon = false } = {}) {
  const feeds = events.filter((e) => e.type === 'feed').sort((a, b) => tsMs(a) - tsMs(b));
  if (feeds.length < EWMA_WINDOW) {
    return {
      status: 'insufficient',
      missing: EWMA_WINDOW - feeds.length,
      subLabelKey: 'vector.unlock.feedings',
      imported: isEmcon,
      importedLabelKey: isEmcon ? 'vector.imported' : null,
    };
  }
  const window = feeds.slice(-EWMA_WINDOW - 1); // need 5 intervals → 6 events ideally
  const ints = intervalsMin(window).slice(-EWMA_WINDOW);
  const interval = ewma(ints, EWMA_ALPHA);
  const sd = stddev(ints);
  const band = Math.max(PREDICTION_BAND_FLOOR_MIN, Math.round(sd));
  const last = feeds[feeds.length - 1];
  const centre = new Date(tsMs(last) + interval * 60_000);
  const overdue = now.getTime() > centre.getTime() + band * 60_000;
  const stale = (now.getTime() - tsMs(last)) > STALE_FACTOR * interval * 60_000;
  return {
    status: overdue ? 'overdue' : (stale ? 'stale' : 'ok'),
    centre,
    band,
    interval,
    subLabelKey: 'vector.basedOnLast5',
    imported: isEmcon,
    importedLabelKey: isEmcon ? 'vector.imported' : null,
  };
}

function pickIntervalsByBranch(events, type) {
  // events sorted ascending; classify each interval ending in a `type`
  // event by whether the most recent prior event was a feeding within
  // POST_FEED_WINDOW_MIN.
  const post = [];
  const base = [];
  let lastFeedMs = -Infinity;
  let lastTypeMs = null;
  for (const ev of events) {
    if (ev.type === 'feed') lastFeedMs = tsMs(ev);
    if (ev.type === type) {
      const cur = tsMs(ev);
      if (lastTypeMs !== null) {
        const interval = (cur - lastTypeMs) / 60_000;
        const sincePriorFeed = (cur - lastFeedMs) / 60_000;
        if (sincePriorFeed >= 0 && sincePriorFeed <= POST_FEED_WINDOW_MIN) post.push(interval);
        else base.push(interval);
      }
      lastTypeMs = cur;
    }
  }
  return { post, base };
}

// @req FR-94
// @req FR-95
// @req FR-96
// @req FR-97
// @req FR-98
// @req FR-99
// @req FR-100
// @req NFR-26
export function predictDiaper(events, type, now = new Date(), { isEmcon = false } = {}) {
  if (type !== 'wet' && type !== 'dirty') throw new Error(`predictDiaper: bad type ${type}`);
  const sorted = events.slice().sort((a, b) => tsMs(a) - tsMs(b));
  const ofType = sorted.filter((e) => e.type === type);
  if (ofType.length < DIAPER_WINDOW) {
    return {
      status: 'insufficient',
      missing: DIAPER_WINDOW - ofType.length,
      subLabelKey: type === 'wet' ? 'vector.unlock.wet' : 'vector.unlock.dirty',
      imported: isEmcon,
      importedLabelKey: isEmcon ? 'vector.imported' : null,
    };
  }
  // Window of last DIAPER_WINDOW intervals → need DIAPER_WINDOW+1 events of `type`
  const slice = sorted.slice(0); // include feeds for branch classification
  // limit slice to events up to the latest of the last DIAPER_WINDOW+1 of type
  const windowStart = ofType[ofType.length - (DIAPER_WINDOW + 1)] ?? ofType[0];
  const start = tsMs(windowStart);
  const trimmed = slice.filter((e) => tsMs(e) >= start);

  const { post, base } = pickIntervalsByBranch(trimmed, type);
  const all = [...post, ...base];
  const lastFeed = sorted.filter((e) => e.type === 'feed').slice(-1)[0];
  const lastFeedMs = lastFeed ? tsMs(lastFeed) : -Infinity;
  const minutesSinceFeed = (now.getTime() - lastFeedMs) / 60_000;
  const inPostFeedWindow = minutesSinceFeed >= 0 && minutesSinceFeed <= POST_FEED_WINDOW_MIN;

  let chosenIntervals;
  let branch;
  if (post.length === 0 && base.length === 0) {
    return {
      status: 'insufficient', missing: DIAPER_WINDOW,
      subLabelKey: type === 'wet' ? 'vector.unlock.wet' : 'vector.unlock.dirty',
      imported: isEmcon, importedLabelKey: isEmcon ? 'vector.imported' : null,
    };
  }
  if (post.length === 0 || base.length === 0) {
    // Falls back to single-λ over all 5 (FR-98 "(unconditional)").
    chosenIntervals = all;
    branch = 'unconditional';
  } else if (inPostFeedWindow) {
    chosenIntervals = post;
    branch = 'postFeed';
  } else {
    chosenIntervals = base;
    branch = 'baseline';
  }
  const meanInterval = chosenIntervals.reduce((a, b) => a + b, 0) / chosenIntervals.length;
  if (!Number.isFinite(meanInterval) || meanInterval <= 0) {
    return {
      status: 'insufficient', missing: DIAPER_WINDOW,
      subLabelKey: type === 'wet' ? 'vector.unlock.wet' : 'vector.unlock.dirty',
      imported: isEmcon, importedLabelKey: isEmcon ? 'vector.imported' : null,
    };
  }
  const lambda = 1 / meanInterval;
  const centreMin = 1 / lambda;
  const bandMin = Math.max(PREDICTION_BAND_FLOOR_MIN, Math.round(centreMin * 0.5));
  const last = ofType[ofType.length - 1];
  const centre = new Date(now.getTime() + Math.round(centreMin) * 60_000);
  return {
    status: 'ok',
    centre,
    band: bandMin,
    interval: centreMin,
    branch,
    branchLabelKey: branch === 'postFeed' ? 'vector.subLabel.postFeed'
      : (branch === 'baseline' ? 'vector.subLabel.baseline' : 'vector.subLabel.unconditional'),
    titleKey: type === 'wet' ? 'vector.wet' : 'vector.dirty',
    lastEventTimestamp: last.timestamp,
    imported: isEmcon,
    importedLabelKey: isEmcon ? 'vector.imported' : null,
  };
}
