# aar-deploy

A simple, fully offline newborn-care tracker — themed as the cockpit of a
military cargo aircraft loadmaster. **AAR** is the operator's callsign, after
*air-to-air refueling* (the "contact established" event).

The whole app is a single static `index.html` deployed from this repo's `main`
branch via GitHub Pages. No backend, no accounts, no cloud — all data lives in
the browser's `localStorage` on your device.

> **Status:** under construction. The deployable `index.html` is not yet
> committed; this initial commit only sets up the repository.

## Planned features

- **Log** breastfeedings ("contact established", left/right/duration), wet
  diapers ("jettisoned"), dirty diapers ("bombing operation"), and weight
  ("weight & balance").
- **Predict** the next feeding from a moving average of feeding intervals.
- **Predict** the next urination/defecation using a small Bayesian model
  conditioned on recent feedings — withheld until ≥ 5 events of data exist.
- **Humorous flavor lines** drawn from a per-event-type bank, displayed each
  time something is logged.
- **Export / import** state as a CSV (also usable for bulk pre-population),
  plus a self-contained share link with embedded data for syncing between
  devices.
- **Read-only safe-mode** when displaying imported or shared data — local data
  is never silently overwritten.

## Use & deploy

1. Open `index.html` directly in any modern browser, or
2. Visit the published site at <https://rmaiko.github.io/aar-deploy/> once
   GitHub Pages is enabled on the `main` branch.

No build step, no install — view the source if you're curious.

## Data privacy

All tracking data stays on the device that created it. The app makes no
network requests of its own. Sharing is only possible through actions you
explicitly take (export a CSV, copy a share link).

## License

Personal project — all rights reserved by the author unless an explicit
license is added later.
