// js/config.js — compile-time constants (architecture §5.4).
//
// All numeric/string constants used across the codebase live here for
// grep-ability. Edit one place; rebuild nothing.

export const STORAGE_KEY = 'aar.appState';
export const SHADOW_KEY = 'aar.appState.__pending__';
export const LANG_KEY = 'aar.lang';

export const SCHEMA_VERSION = 1;

// Mission Log render budget (FR-34, NFR-03).
export const MISSION_LOG_PAGE_SIZE = 500;

// Feeding vector (FR-36, amended by AMD-011).
// Trimmed time-weighted mean for centre + MAD band + day/night bucketing
// + forward-projection. EWMA_ALPHA is gone; EWMA_WINDOW survives only as
// the unlock gate (renamed FEED_PRED_UNLOCK_MIN).
export const FEED_PRED_UNLOCK_MIN = 5;
export const FEED_PRED_WINDOW_MAX = 14;
export const FEED_PRED_HALF_LIFE_DAYS = 2;
export const FEED_PRED_TRIM_TOP = 1;
export const FEED_PRED_NIGHT_START_HOUR = 22;
export const FEED_PRED_NIGHT_END_HOUR = 6;
export const FEED_PRED_BUCKET_MIN_SAMPLES = 2;
export const FEED_PRED_REPROJECT_MAX = 3;
export const PREDICTION_BAND_FLOOR_MIN = 10;
export const STALE_FACTOR = 2;

// Diaper vector (FR-96, ADR-011).
export const POST_FEED_WINDOW_MIN = 90;
export const DIAPER_WINDOW = 5;

// Backup-overdue nudge (FR-64, FR-65, FR-67).
export const BACKUP_NUDGE_DAYS = 5;
export const BACKUP_NUDGE_MIN_EVENTS = 5;
export const FIRST_BACKUP_MIN_EVENTS = 10;
export const REMIND_LATER_HOURS = 24;

// Back-date chip (FR-10, FR-13, FR-14).
// FR-10 verbatim is [0, 5, 15, 30]; expanded to add 10m/20m by user
// request — bundled into AMD-003 for Phase 6 to formalise.
export const CHIP_OFFSETS_MIN = [0, 5, 10, 15, 20, 30];
export const CHIP_RESET_INACTIVITY_MS = 30_000;
export const BACKDATE_LIMIT_HOURS = 24;

// Feeding & weight ranges (FR-04, FR-08).
export const FEED_DURATION_MIN = 0;
export const FEED_DURATION_MAX = 240;
// Upper clamp applied when duration is derived from wall-clock elapsed
// (live timer / chip-back-date) rather than typed in. A parent who left
// the timer running overnight should not commit an 8-hour feed.
export const FEED_TIMER_DURATION_CAP_MIN = 90;
export const WEIGHT_KG_MIN = 0.5;
export const WEIGHT_KG_MAX = 25;
export const LENGTH_CM_MIN = 30;
export const LENGTH_CM_MAX = 120;

// Milestone weight thresholds (FR-102) — integer kg ≥ 3.
export const MILESTONE_WEIGHT_MIN_KG = 3;
export const MILESTONE_LONGEST_GAP_DELTA_MIN = 5;          // FR-103
export const MILESTONE_QUIET_NIGHT_HOURS = 6;              // FR-104
export const MILESTONE_QUIET_NIGHT_START_HOUR = 22;
export const MILESTONE_QUIET_NIGHT_END_HOUR = 6;
export const MILESTONE_ROUTINE_CV_THRESHOLD = 0.20;        // FR-105
export const MILESTONE_ROUTINE_RUN_LENGTH = 3;
export const MILESTONE_DAYS_FLOWN_INTERVAL_DAYS = 7;       // FR-106
export const MILESTONE_TRANSFERS = [50, 100, 250, 500];    // FR-107

// Toasts (FR-16).
export const TOAST_DEFAULT_MS = 3500;

// Relative-time refresh (FR-22, NFR-02).
export const RELATIVE_TIME_TICK_MS = 60_000;

// Routes (ADR-002).
export const ROUTES = Object.freeze({
  STATION: '#/',
  LOG: '#/log',
  SETTINGS: '#/settings',
  PREFLIGHT: '#/preflight',
  REPORT: '#/report',
  // AMD-003: stale-magic-link target. Sign-in is OTP-only; this route
  // exists solely to catch links from old emails that may still be in
  // inboxes and surface a friendly toast.
  AUTH_CALLBACK: '#/auth-callback',
});
