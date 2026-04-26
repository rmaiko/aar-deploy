# aar-deploy

A fully offline single-page newborn-care tracker, themed as a military
loadmaster console — **AAR** is the operator's callsign, after *air-to-air
refueling* (the "contact established" event).

The whole app is a single static `index.html` (plus `js/`, `css/`,
`locales/`, `assets/`, and one vendored library) served from this repo's
`main` branch via GitHub Pages. No backend, no accounts, no cloud — every
event lives in the browser's `localStorage` on the loadmaster's own device.

> **Project status:** Phase 5 (Implementation) complete. Alpha + MVP
> requirements (FR-01..FR-135, NFR-01..NFR-30) implemented in vanilla
> ES2021 JavaScript per `docs/architecture/architecture.md`. Test suite at
> `tests/index.html` reports **185 / 185 PASS** (185 PASS · 0 FAIL ·
> 0 PENDING) under headless Chrome.

## Features

### Logging
- **Feeds** (`CONTACT — PORT/STARBOARD`, sub-label "Feed left/right breast")
  with optional duration (0–240 min).
- **Diapers** — `JETTISONED` (wet) and `ORDNANCE RELEASED` (dirty) in one tap.
- **Weight & length** with date+time picker, ranges 0.5–25 kg / 30–120 cm.
- **Back-date chip** with relative (Now / 5m / 15m / 30m) and Custom-time options.
- **Delete-last** with two-step confirmation; cross-tab race protection
  (architecture §5.5.1).

### At-a-glance dashboard
- LAST CONTACT panel with side, time and relative-time string.
- TODAY widget rolling 24h counters.
- NEXT VECTOR predictions: EWMA-5 for feedings (FR-36), dual-λ for diapers
  (FR-96, ADR-011) — both labelled with the active conditioning branch.

### Mission Log
- Reverse-chronological event list, eager-renders 500 entries with
  "load older" paging.
- Milestone badges (six evaluator types: weight thresholds, longest gap,
  first quiet night, settled-into-routine, days flown, total transfers).
- AMD-001 `system_log[]` "MILESTONE STATE REBUILT" entry rendered as a
  third badge type.

### Persistence & sharing
- Single canonical `localStorage` key `aar.appState` (FR-92, ADR-004).
- CSV **export / import** (8-column lock per ADR-007, UTF-8 BOM per NFR-20)
  with preview + REPLACE / EXPORT-FIRST / CANCEL flow.
- **COMMS RELAY** — generate a share-link encoded into the URL fragment via
  `lz-string` (vendored same-origin, ADR-013); privacy modal mandatory
  before any share/clipboard call (NFR-28).
- **EMCON** read-only mode for incoming share-links and CSV-import previews
  (FR-118..FR-124, NFR-30).
- **Pediatrician Report** — plain-language print-friendly view with inline
  SVG weight/length chart (FR-125..FR-134, NFR-29).
- **Factory reset** — two-step `DELETE`-text confirm; atomic via the
  shadow-key + rename pattern (ADR-005).

### A11y / i18n / theme
- Themed (AAR) + Plain copy via a flat-key i18n shim (ADR-008); 4 locale
  files (en + pt-br/fr/el placeholders per ADR-008 addendum).
- Dark default (NFR-12); 44×44 hit targets (NFR-10); native `<dialog>`
  focus trap (NFR-14); `prefers-reduced-motion` and `prefers-contrast`
  honoured (NFR-21).

## Getting started

### Run locally

The app needs an HTTP server (ES modules can't be loaded from `file://`).
Any static server works; the simplest is Python's:

```bash
python3 -m http.server 8765
# then open http://localhost:8765/
```

### Run the test suite

A hand-rolled in-page test runner (ADR-010-A) lives under `tests/`. With a
local HTTP server running, open:

```
http://localhost:8765/tests/index.html?auto=1
```

The runner reports `PASS ⌶ FAIL ⌶ PENDING` counts and lists every test by
component. To re-run after editing code, refresh the page.

For headless verification:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox \
  --virtual-time-budget=20000 \
  --dump-dom 'http://localhost:8765/tests/index.html?auto=1' \
  | grep -oE 'PASS [0-9]+ · FAIL [0-9]+ · PENDING [0-9]+'
```

### Deploy

`git push origin main` — GitHub Pages serves the working tree from `/` on
branch `main`. The `.gitignore` is a strict whitelist (D-003 in
`docs/ccct_deviations.md`); only the deliverable files (`index.html`,
`js/`, `css/`, `locales/`, `assets/`, `js/vendor/`) plus `README.md` and
`.gitignore` itself are tracked.

**Release checklist** before each deploy (closes Phase 3 carry-forwards
L-2, L-3):

1. If the inline boot script in `index.html` was edited → bump the CSP
   `'sha256-…'` token using `tests/fixtures/sha_helper.js → sha256Hex(boot)`.
2. Bump `?v=N` cache-bust on every `<link rel="stylesheet">` and
   `<script src=…>` in `index.html`.
3. If `js/vendor/lz-string-1.4.4.min.js` was replaced → update the SHA-256
   in `js/vendor/lz-string.js` header **and** in
   `tests/vendor/lz_string_smoke.test.js`.
4. If `locales/en.json` gained keys → propagate the same keys (English
   value verbatim) into the three placeholder locales per the ADR-008
   addendum.
5. Run the test suite headlessly; require **0 FAIL · 0 PENDING**.

## Architecture

The full architecture lives outside the deliverable repo (per D-003 — the
`docs/` tree is not committed). For development, see
`docs/architecture/architecture.md` and the 14 ADRs in
`docs/architecture/decisions/`.

Component map (24 modules):

| File | Component |
|---|---|
| `js/app.js` | C-02 orchestrator |
| `js/storage.js` | C-03 storage I/O (Path A/B/C) |
| `js/schema.js` | C-04 schema + reviver + migration |
| `js/state.js` | C-05 reactive store |
| `js/router.js` | C-06 hash router |
| `js/emcon.js` | C-07 EMCON gate |
| `js/events.js` | C-08 domain event service |
| `js/chip.js` | C-09 back-date chip |
| `js/prediction.js` | C-10 EWMA-5 + dual-λ |
| `js/milestones.js` | C-11 evaluator + rebuild |
| `js/csv.js` | C-12 export + import |
| `js/share.js` | C-13 share-link encode + decode |
| `js/i18n.js` | C-14 i18n shim |
| `js/theme.js` | C-15 theme |
| `js/overlays.js` | C-16 toasts/banners/dialogs |
| `js/views/*.js` | C-17..C-23 views |
| `js/vendor/lz-string-1.4.4.min.js` + `lz-string.js` | C-24 vendor |

## Data privacy

Tracking data stays on the device that created it. The app makes no network
requests of its own after the initial page fetch (NFR-22, NFR-23). Sharing
happens only through explicit user actions (CSV export, share-link copy).
The share-link payload travels in the URL fragment (`#d=…`), which by web
contract is never transmitted to any server.

## License

[Beer-Ware Revision 42](./LICENSE) — do whatever you want with this stuff.
If we meet some day and you think it was worth it, buy me a beer.
