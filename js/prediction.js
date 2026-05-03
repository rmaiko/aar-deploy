// js/prediction.js — C-10 pure prediction functions.
//
// Feeding vector (FR-36, amended by AMD-011): trimmed time-weighted mean
// of recent feeding intervals (drop top 1, half-life = 2 days, window
// up to 14), MAD × 1.4826 for the band (floored at 10 min), day/night
// bucketing with global fallback when the predicted bucket has < 2
// samples, and forward-projection of the centre by full intervals (cap
// 3) when the original centre is in the past.
// Diaper vector: dual-λ exponential — λ_post-feed (intervals where the
// prior event was a feed within 90 min) vs λ_baseline (all others); active
// branch picked from elapsed-time-since-last-feed (FR-96).

import {
  FEED_PRED_UNLOCK_MIN, FEED_PRED_WINDOW_MAX, FEED_PRED_HALF_LIFE_DAYS,
  FEED_PRED_TRIM_TOP, FEED_PRED_NIGHT_START_HOUR, FEED_PRED_NIGHT_END_HOUR,
  FEED_PRED_BUCKET_MIN_SAMPLES, FEED_PRED_REPROJECT_MAX,
  PREDICTION_BAND_FLOOR_MIN, STALE_FACTOR,
  POST_FEED_WINDOW_MIN, DIAPER_WINDOW,
} from './config.js';

const MIN_PER_DAY = 60 * 24;
const MAD_TO_SIGMA = 1.4826;

function tsMs(ev) { return new Date(ev.timestamp).getTime(); }

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function madBand(values) {
  if (values.length < 2) return 0;
  const m = median(values);
  const mad = median(values.map((v) => Math.abs(v - m)));
  return mad * MAD_TO_SIGMA;
}

// Drop the largest `top` entries to reduce single-outlier sensitivity.
function trimTop(samples, top) {
  if (samples.length <= top + 1) return samples.slice();
  return samples.slice().sort((a, b) => a.intervalMin - b.intervalMin)
    .slice(0, samples.length - top);
}

function isNightHour(date) {
  const h = date.getHours();
  return h >= FEED_PRED_NIGHT_START_HOUR || h < FEED_PRED_NIGHT_END_HOUR;
}

// Time-weighted mean with exponential decay. `refMs` is the time used as
// "age zero"; older samples contribute exponentially less weight with
// half-life FEED_PRED_HALF_LIFE_DAYS.
function timeWeightedMean(samples, refMs) {
  if (samples.length === 0) return 0;
  const halfLifeMs = FEED_PRED_HALF_LIFE_DAYS * MIN_PER_DAY * 60_000;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const ageMs = Math.max(0, refMs - s.endMs);
    const w = Math.pow(0.5, ageMs / halfLifeMs);
    num += w * s.intervalMin;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

// Build the recent-interval sample set: at most FEED_PRED_WINDOW_MAX
// intervals derived from the last (WINDOW_MAX + 1) feeds. Each sample
// carries the timestamp of the feed that *closed* the interval (used
// for day/night bucketing and time-weight).
function buildSamples(feeds) {
  const slice = feeds.slice(-FEED_PRED_WINDOW_MAX - 1);
  const out = [];
  for (let i = 1; i < slice.length; i++) {
    const endMs = tsMs(slice[i]);
    const intervalMin = (endMs - tsMs(slice[i - 1])) / 60_000;
    out.push({
      endMs,
      intervalMin,
      night: isNightHour(new Date(endMs)),
    });
  }
  return out;
}

// Reproject the centre forward by `interval` minutes until it sits at or
// after `now`, capped at FEED_PRED_REPROJECT_MAX advances.
function reprojectCentre(originalCentreMs, intervalMin, nowMs) {
  if (originalCentreMs >= nowMs || intervalMin <= 0) {
    return { centreMs: originalCentreMs, projectedSteps: 0 };
  }
  const stepMs = intervalMin * 60_000;
  let centreMs = originalCentreMs;
  let steps = 0;
  while (centreMs < nowMs && steps < FEED_PRED_REPROJECT_MAX) {
    centreMs += stepMs;
    steps += 1;
  }
  return { centreMs, projectedSteps: steps };
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
  if (feeds.length < FEED_PRED_UNLOCK_MIN) {
    return {
      status: 'insufficient',
      missing: FEED_PRED_UNLOCK_MIN - feeds.length,
      subLabelKey: 'vector.unlock.feedings',
      imported: isEmcon,
      importedLabelKey: isEmcon ? 'vector.imported' : null,
    };
  }
  const last = feeds[feeds.length - 1];
  const lastMs = tsMs(last);
  const samples = buildSamples(feeds);

  // Day/night bucketing: pick the bucket the next centre would fall in.
  // Compute a provisional global-pool centre to choose the bucket, then
  // recompute on the chosen pool if it has enough samples.
  const provisionalInterval = timeWeightedMean(trimTop(samples, FEED_PRED_TRIM_TOP), lastMs);
  const provisionalCentreMs = lastMs + provisionalInterval * 60_000;
  const targetNight = isNightHour(new Date(provisionalCentreMs));
  const bucketSamples = samples.filter((s) => s.night === targetNight);

  let chosen;
  let bucketKey;
  if (bucketSamples.length >= FEED_PRED_BUCKET_MIN_SAMPLES) {
    chosen = trimTop(bucketSamples, FEED_PRED_TRIM_TOP);
    bucketKey = targetNight ? 'night' : 'day';
  } else {
    chosen = trimTop(samples, FEED_PRED_TRIM_TOP);
    bucketKey = 'global';
  }

  const interval = timeWeightedMean(chosen, lastMs);
  const band = Math.max(
    PREDICTION_BAND_FLOOR_MIN,
    Math.round(madBand(chosen.map((s) => s.intervalMin))),
  );

  const originalCentreMs = lastMs + interval * 60_000;
  const nowMs = now.getTime();
  const overdue = nowMs > originalCentreMs + band * 60_000;
  const stale = (nowMs - lastMs) > STALE_FACTOR * interval * 60_000;
  const { centreMs, projectedSteps } = reprojectCentre(originalCentreMs, interval, nowMs);

  return {
    status: overdue ? 'overdue' : (stale ? 'stale' : 'ok'),
    centre: new Date(centreMs),
    originalCentre: new Date(originalCentreMs),
    band,
    interval,
    bucket: bucketKey,
    projectedSteps,
    sampleCount: chosen.length,
    subLabelKey: 'vector.basedOnRecent',
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
