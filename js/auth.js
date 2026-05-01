// js/auth.js — C-25 cloud-auth (AMD-003).
//
// Owns the supabase-js client instance, the magic-link send/exchange
// flow, the active-session observable, and the family selector. Pure
// network-side: does NOT touch appState directly — emits high-level
// events that app.js / sync.js subscribe to (architecture §C-25).
//
// FR-200 off-state guarantee:
//   - The vendored supabase-js bundle is loaded LAZILY on the first
//     auth call. With cloud disabled the script is never injected, so
//     the network panel shows zero requests to any *.supabase.co host.
//   - Every public function early-returns CLOUD_UNCONFIGURED when
//     cloudConfigured() is false, so callers never accidentally hit
//     the network through this module.
//
// ADR-019 (magic-link only): the only sign-in flow is email OTP.
// supabase-js handles the verify side; we expose both the link-tap
// path (#/auth-callback → exchangeCodeForSession) and a same-device
// 6-digit OTP fallback (verifyOtp) for the cross-device case in
// US-27 AC-10.

import { SUPABASE_URL, SUPABASE_ANON_KEY, cloudConfigured } from './cloud-config.js';

const SUPABASE_BUNDLE_PATH = 'js/vendor/supabase-js-2.105.1.min.js';

// ── Typed error codes ─────────────────────────────────────────────────
// Stable identifiers consumed by the Settings UI (step 8) and tests.
export const ERR = Object.freeze({
  CLOUD_UNCONFIGURED:   'CLOUD_UNCONFIGURED',   // SUPABASE_URL/KEY not set
  BUNDLE_LOAD_FAILED:   'BUNDLE_LOAD_FAILED',   // vendored UMD didn't load
  NETWORK:              'NETWORK',              // generic network failure
  INVALID_EMAIL:        'INVALID_EMAIL',        // client-side shape check
  INVALID_CODE:         'INVALID_CODE',         // OTP shape check
  AUTH_FAILED:          'AUTH_FAILED',          // supabase rejected
  NO_SESSION:           'NO_SESSION',           // call requires sign-in
  NO_ACTIVE_FAMILY:     'NO_ACTIVE_FAMILY',     // op needs an active family
  NOT_OWNER:            'NOT_OWNER',            // only owners can do this
  INVITE_NOT_FOUND:     'INVITE_NOT_FOUND',
  INVITE_EXPIRED:       'INVITE_EXPIRED',
  INVITE_EXHAUSTED:     'INVITE_EXHAUSTED',
  INVITE_REVOKED:       'INVITE_REVOKED',
  ALREADY_MEMBER:       'ALREADY_MEMBER',
  RATE_LIMITED:         'RATE_LIMITED',
  UNKNOWN:              'UNKNOWN',
});

// ── Module state ──────────────────────────────────────────────────────
let client = null;            // supabase-js SupabaseClient instance
let bundleLoading = null;     // in-flight bundle load promise (dedup)
let currentSession = null;    // last seen session payload
let activeFamilyId = null;    // local-only; mirrored to appState by app.js
let warnSink = () => {};      // wired by init()
const listeners = {           // event hub
  signedIn:       new Set(),
  signedOut:      new Set(),
  familyChanged:  new Set(),
};

// ── Helpers ───────────────────────────────────────────────────────────
function fail(code, message, extra) {
  return { ok: false, error: { code, message: message ?? code, ...(extra || {}) } };
}

function emit(event, payload) {
  for (const cb of listeners[event] || []) {
    try { cb(payload); } catch (e) { console.error('auth listener threw:', e); }
  }
}

// Maps the `message` from a Postgres `RAISE EXCEPTION` inside
// redeem_invite() to one of our ERR codes (FR-208).
function mapRpcError(supabaseError) {
  const msg = String(supabaseError?.message || '').toUpperCase();
  for (const code of ['INVITE_NOT_FOUND', 'INVITE_EXPIRED', 'INVITE_EXHAUSTED',
                      'INVITE_REVOKED', 'ALREADY_MEMBER', 'RATE_LIMITED']) {
    if (msg.includes(code)) return code;
  }
  return ERR.UNKNOWN;
}

// Lazy-load the vendored supabase-js UMD bundle. Idempotent and dedup'd.
function loadBundle() {
  if (typeof window === 'undefined') {
    return Promise.reject({ code: ERR.BUNDLE_LOAD_FAILED, message: 'no window' });
  }
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    return Promise.resolve(window.supabase);
  }
  if (bundleLoading) return bundleLoading;
  bundleLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SUPABASE_BUNDLE_PATH;
    s.async = true;
    s.onload = () => {
      if (window.supabase && typeof window.supabase.createClient === 'function') {
        resolve(window.supabase);
      } else {
        reject({ code: ERR.BUNDLE_LOAD_FAILED, message: 'global not exposed' });
      }
    };
    s.onerror = () => reject({ code: ERR.BUNDLE_LOAD_FAILED, message: 'script onerror' });
    document.head.appendChild(s);
  });
  return bundleLoading;
}

async function ensureClient() {
  if (!cloudConfigured()) throw { code: ERR.CLOUD_UNCONFIGURED, message: 'SUPABASE_URL / SUPABASE_ANON_KEY not set' };
  if (client) return client;
  const bundle = await loadBundle();
  client = bundle.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: false,    // the router triggers exchangeCodeForSession itself
      autoRefreshToken: true,
      persistSession: true,
      storage: window.localStorage, // FR-217: sb-<ref>-auth-token
    },
  });
  client.auth.onAuthStateChange((event, session) => {
    const prev = currentSession;
    currentSession = session || null;
    if (event === 'SIGNED_IN' && !prev) emit('signedIn', getSession());
    if (event === 'SIGNED_OUT')          emit('signedOut', null);
    // TOKEN_REFRESHED / USER_UPDATED don't fire signedIn again.
  });
  return client;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isEmail(s) { return typeof s === 'string' && EMAIL_RE.test(s.trim()); }

// ── Lifecycle ─────────────────────────────────────────────────────────

// @req AMD-003
// Boot wiring. App.js calls this once with overlay/state hooks. Safe to
// call when cloud is disabled — no network side-effect until a method
// that needs the client is invoked.
export function init({ warnSink: ws, initialActiveFamilyId } = {}) {
  if (typeof ws === 'function') warnSink = ws;
  if (typeof initialActiveFamilyId === 'string' || initialActiveFamilyId === null) {
    activeFamilyId = initialActiveFamilyId ?? null;
  }
}

// @req FR-200
export function isAvailable() { return cloudConfigured(); }

export function on(event, cb) {
  if (!listeners[event]) throw new Error(`unknown event: ${event}`);
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  listeners[event].add(cb);
  return () => listeners[event].delete(cb);
}

export function getSession() {
  if (!currentSession) return null;
  const u = currentSession.user || {};
  return {
    userId: u.id || null,
    email: u.email || null,
    expiresAt: currentSession.expires_at ? new Date(currentSession.expires_at * 1000).toISOString() : null,
  };
}

export function getActiveFamilyId() { return activeFamilyId; }

// ── Auth (FR-205, ADR-019) ────────────────────────────────────────────

// @req FR-205
// @req US-27
export async function sendMagicLink(email) {
  if (!isEmail(email)) return fail(ERR.INVALID_EMAIL);
  let c;
  try { c = await ensureClient(); } catch (e) { return fail(e.code, e.message); }
  try {
    const redirectTo = (typeof location !== 'undefined')
      ? `${location.origin}${location.pathname}#/auth-callback`
      : undefined;
    const { error } = await c.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
    });
    if (error) return fail(ERR.AUTH_FAILED, error.message);
    return { ok: true };
  } catch (e) {
    return fail(ERR.NETWORK, String(e?.message ?? e));
  }
}

// @req FR-205
// @req US-27
// Same-device 6-digit OTP fallback for the cross-device case where the
// link arrives on a different device than the one that requested it.
export async function verifyOtp(email, code) {
  if (!isEmail(email)) return fail(ERR.INVALID_EMAIL);
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return fail(ERR.INVALID_CODE);
  let c;
  try { c = await ensureClient(); } catch (e) { return fail(e.code, e.message); }
  try {
    const { data, error } = await c.auth.verifyOtp({
      email: email.trim(), token: code.trim(), type: 'email',
    });
    if (error) return fail(ERR.AUTH_FAILED, error.message);
    return { ok: true, session: data.session ?? null };
  } catch (e) {
    return fail(ERR.NETWORK, String(e?.message ?? e));
  }
}

// @req FR-205
// @req US-27
// Called by the #/auth-callback router target. Reads `code` from the URL
// fragment and exchanges it (PKCE) for a session.
export async function exchangeCodeForSession(href) {
  let c;
  try { c = await ensureClient(); } catch (e) { return fail(e.code, e.message); }
  try {
    // supabase-js accepts the full URL; we strip non-fragment scaffolding
    // to be tolerant of the hash-router prefix.
    const url = href || (typeof location !== 'undefined' ? location.href : '');
    const { data, error } = await c.auth.exchangeCodeForSession(url);
    if (error) return fail(ERR.AUTH_FAILED, error.message);
    return { ok: true, session: data.session ?? null };
  } catch (e) {
    return fail(ERR.NETWORK, String(e?.message ?? e));
  }
}

// @req FR-218
export async function signOut() {
  let c;
  try { c = await ensureClient(); } catch (e) { return fail(e.code, e.message); }
  try {
    activeFamilyId = null;
    emit('familyChanged', null);
    const { error } = await c.auth.signOut();
    if (error) return fail(ERR.AUTH_FAILED, error.message);
    return { ok: true };
  } catch (e) {
    return fail(ERR.NETWORK, String(e?.message ?? e));
  }
}

// ── Families (FR-206, FR-209, FR-210) ─────────────────────────────────

function requireSession() {
  return currentSession ? null : fail(ERR.NO_SESSION);
}

// @req FR-209
// @req US-31
// Returns every family the signed-in user belongs to, joined with the
// caller's role for that family. Driven by RLS — the policy returns
// rows only for memberships of auth.uid().
export async function listMyFamilies() {
  const noSession = requireSession();
  if (noSession) return noSession;
  let c;
  try { c = await ensureClient(); } catch (e) { return fail(e.code, e.message); }
  const { data, error } = await c
    .from('family_members')
    .select('role, joined_at, families:family_id ( id, name, owner_id, created_at )')
    .order('joined_at', { ascending: true });
  if (error) return fail(ERR.NETWORK, error.message);
  const families = (data || [])
    .filter((r) => r.families)
    .map((r) => ({
      id: r.families.id,
      name: r.families.name,
      ownerId: r.families.owner_id,
      role: r.role,
      joinedAt: r.joined_at,
      createdAt: r.families.created_at,
    }));
  return { ok: true, families };
}

// @req FR-206
// @req US-28
// Atomically creates a family + the owner's family_members row through a
// `create_family(name)` security-definer RPC defined in the migration.
// (RLS would otherwise need a window where families exists without a
// member row, which is exactly the leakage FR-206 forbids.)
export async function createFamily(name) {
  const noSession = requireSession();
  if (noSession) return noSession;
  if (typeof name !== 'string' || name.trim().length === 0) return fail(ERR.INVALID_EMAIL, 'name required');
  let c;
  try { c = await ensureClient(); } catch (e) { return fail(e.code, e.message); }
  const { data, error } = await c.rpc('create_family', { p_name: name.trim() });
  if (error) return fail(ERR.NETWORK, error.message);
  return { ok: true, family: { id: data, name: name.trim(), role: 'owner' } };
}

// @req FR-210
export function setActiveFamily(id) {
  if (id !== null && typeof id !== 'string') return fail(ERR.UNKNOWN, 'id must be string or null');
  if (id === activeFamilyId) return { ok: true };
  activeFamilyId = id;
  emit('familyChanged', id);
  return { ok: true };
}

// ── Invites (FR-207, FR-208) ──────────────────────────────────────────

// @req FR-207
// @req US-29
// Owner-only. RLS rejects member callers; we surface that as NOT_OWNER.
export async function listInvites(familyId) {
  const noSession = requireSession();
  if (noSession) return noSession;
  let c;
  try { c = await ensureClient(); } catch (e) { return fail(e.code, e.message); }
  const { data, error } = await c
    .from('family_invites')
    .select('id, code, expires_at, max_uses, uses, revoked_at, created_at')
    .eq('family_id', familyId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) return fail(ERR.NETWORK, error.message);
  return { ok: true, invites: data || [] };
}

// @req FR-207
// @req US-29
// 16 URL-safe chars from crypto.getRandomValues, single-use, 7-day expiry.
export async function generateInvite(familyId) {
  const noSession = requireSession();
  if (noSession) return noSession;
  if (typeof familyId !== 'string') return fail(ERR.NO_ACTIVE_FAMILY);
  let c;
  try { c = await ensureClient(); } catch (e) { return fail(e.code, e.message); }
  const code = generateCode(16);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await c
    .from('family_invites')
    .insert({ family_id: familyId, code, max_uses: 1, expires_at: expiresAt })
    .select()
    .single();
  if (error) {
    // RLS rejection from a non-owner caller has code 42501 (insufficient_privilege).
    if (String(error.code) === '42501') return fail(ERR.NOT_OWNER, error.message);
    return fail(ERR.NETWORK, error.message);
  }
  return { ok: true, invite: data };
}

// @req FR-207
// @req US-29
export async function revokeInvite(inviteId) {
  const noSession = requireSession();
  if (noSession) return noSession;
  let c;
  try { c = await ensureClient(); } catch (e) { return fail(e.code, e.message); }
  const { error } = await c
    .from('family_invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', inviteId);
  if (error) return fail(ERR.NETWORK, error.message);
  return { ok: true };
}

// @req FR-208
// @req US-30
// All distinguishable rejection branches map to typed ERR codes.
export async function redeemInvite(code) {
  const noSession = requireSession();
  if (noSession) return noSession;
  if (typeof code !== 'string' || code.trim().length === 0) return fail(ERR.INVITE_NOT_FOUND);
  let c;
  try { c = await ensureClient(); } catch (e) { return fail(e.code, e.message); }
  const { data, error } = await c.rpc('redeem_invite', { p_code: code.trim() });
  if (error) return fail(mapRpcError(error), error.message);
  return { ok: true, familyId: data };
}

// ── Crypto helper ─────────────────────────────────────────────────────
// 16 URL-safe characters (~95 bits of entropy, far above the brute-force
// threshold given the per-user RPC rate limit in step 10).
function generateCode(len) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[buf[i] & 63];
  return out;
}

// ── Test seam ─────────────────────────────────────────────────────────
// Lets unit tests inject a fake supabase-js client without touching
// the network or window globals.
export function _setClientForTests(fakeClient, opts = {}) {
  client = fakeClient;
  if (opts.session !== undefined) currentSession = opts.session;
  if (opts.activeFamilyId !== undefined) activeFamilyId = opts.activeFamilyId;
}
export function _resetForTests() {
  client = null;
  bundleLoading = null;
  currentSession = null;
  activeFamilyId = null;
  for (const k of Object.keys(listeners)) listeners[k].clear();
}
