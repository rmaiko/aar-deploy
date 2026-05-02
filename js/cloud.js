// js/cloud.js — boot/lifecycle orchestrator for cloud sync (AMD-003).
//
// Single entry point for starting / stopping the cloud surface, called
// from app.js on boot (auto-resume if appState.cloud.enabled === true)
// and from the Settings → Mission Network panel on toggle.
//
// Auth is statically imported (it is small and lazy-loads the heavy
// supabase-js bundle on the first network call). Sync is dynamically
// imported on first enable so users who never opt in never load it.

import * as auth from './auth.js';
import { getState, dispatch } from './state.js';
import { writeState } from './storage.js';
import { toast } from './overlays.js';

let syncModule = null;
let started = false;
let warnSink = (key) => toast(key);

async function ensureSync() {
  if (!syncModule) syncModule = await import('./sync.js');
  return syncModule;
}

function getCloud() {
  return getState().cloud || { enabled: false, lastPulledAt: null, activeFamilyId: null, activeFamilyName: null, rememberedEmail: null };
}

function setCloud(patch) {
  const cur = getCloud();
  const next = { ...cur, ...patch };
  dispatch({ type: 'topLevel/patch', payload: { cloud: next } });
  writeState(getState());
}

// @req AMD-003
// Called once from app.js boot. If cloud is enabled in persisted state,
// wire and start sync; otherwise no-op (FR-200).
export async function boot() {
  const cloud = getCloud();
  // Always seed auth's active-family hint from persisted state so the
  // Settings UI can read it before the first signedIn event lands.
  auth.init({ warnSink, initialActiveFamilyId: cloud.activeFamilyId || null });
  if (!cloud.enabled) return;
  // Force-create the supabase client so persistSession can rehydrate the
  // user's session from localStorage on reload. Without this, nothing on
  // the boot path triggers ensureClient() and getSession() stays null
  // until the user takes a network-touching action — which strands them
  // on the sign-in form even though their session is still valid.
  try { await auth.getClient(); } catch (e) { console.error('cloud client bootstrap failed:', e); }
  await start();
  // Backfill activeFamilyName so the loadmaster subtitle has a wing
  // name to render after reload, without waiting for the user to open
  // Settings. Runs once on signedIn (covers both INITIAL_SESSION and
  // a fresh sign-in landing here).
  auth.on('signedIn', backfillActiveFamilyName);
  if (auth.getSession()) backfillActiveFamilyName();
}

async function backfillActiveFamilyName() {
  const c = getCloud();
  if (!c.activeFamilyId) return;
  let r;
  try { r = await auth.listMyFamilies(); } catch { return; }
  if (!r || !r.ok) return;
  const fam = r.families.find((f) => f.id === c.activeFamilyId);
  if (!fam) return;
  if (fam.name !== c.activeFamilyName) setCloud({ activeFamilyName: fam.name });
}

// @req AMD-003
// Wire + start the sync module. Idempotent.
export async function start() {
  if (started) return;
  const sync = await ensureSync();
  sync.init({ warnSink, getCloud, setCloud });
  sync.start();
  started = true;
}

// @req FR-204
// Tear down sync, drop the persisted queue, sign out, and clear
// activeFamilyId. Local data (events, settings) is preserved.
export async function disable() {
  if (syncModule) {
    syncModule.stop({ dropQueue: true });
  }
  started = false;
  await auth.signOut();
  setCloud({ enabled: false, activeFamilyId: null, activeFamilyName: null, lastPulledAt: null });
}

// @req FR-203
// Flip cloud on, wire sync, and queue every locally-stored event for
// upload to the active family. The caller is expected to ensure both a
// session exists (auth.getSession()) and an activeFamilyId is set
// before invoking this.
export async function enableAndMerge() {
  setCloud({ enabled: true });
  await start();
  const sync = await ensureSync();
  return sync.enqueueAllForInitialMerge();
}

// Test seam.
export function _resetForTests() {
  syncModule = null;
  started = false;
}
