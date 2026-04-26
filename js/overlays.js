// js/overlays.js — C-16 toasts, banners, modals.
//
// One queue, one live region, FIFO + pause-on-hover.  Banners are a
// keyed registry; modals use the native <dialog> element so the focus
// trap (NFR-14) is free.

import { t } from './i18n.js';
import { TOAST_DEFAULT_MS } from './config.js';

let liveEl = null;
let bannerHostEl = null;
let dialogHostEl = null;
const toastQueue = [];
let activeToast = null;
const banners = new Map(); // id -> { node }
let storageCloseSubs = new Set();

function ensureHosts() {
  if (typeof document === 'undefined') return;
  if (!liveEl) {
    liveEl = document.createElement('div');
    liveEl.id = 'aar-toasts';
    liveEl.setAttribute('role', 'status');
    liveEl.setAttribute('aria-live', 'polite');
    liveEl.style.cssText = 'position:fixed;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;pointer-events:none;z-index:1000;';
    document.body.appendChild(liveEl);
  }
  if (!bannerHostEl) {
    bannerHostEl = document.createElement('div');
    bannerHostEl.id = 'aar-banners';
    bannerHostEl.style.cssText = 'position:sticky;top:0;display:flex;flex-direction:column;z-index:900;';
    document.body.insertBefore(bannerHostEl, document.body.firstChild);
  }
  if (!dialogHostEl) {
    dialogHostEl = document.createElement('div');
    dialogHostEl.id = 'aar-dialogs';
    document.body.appendChild(dialogHostEl);
  }
}

// @req FR-16
// @req NFR-11
// @req NFR-16
export function toast(messageKey, params = {}, opts = {}) {
  ensureHosts();
  const text = typeof messageKey === 'string' ? t(messageKey, params) : String(messageKey);
  const item = { text, ms: opts.ms ?? TOAST_DEFAULT_MS, action: opts.action ?? null };
  toastQueue.push(item);
  if (!activeToast) drainToast();
  return item;
}

function drainToast() {
  if (typeof document === 'undefined') return;
  if (!toastQueue.length) { activeToast = null; return; }
  ensureHosts();
  activeToast = toastQueue.shift();
  const node = document.createElement('div');
  node.className = 'aar-toast';
  node.style.cssText = 'background:#0d1f0d;color:#c8e6c9;border:1px solid #7fff7f;padding:0.6rem 1rem;margin:0.4rem;pointer-events:auto;max-width:32rem;';
  node.textContent = activeToast.text;
  if (activeToast.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = activeToast.action.label;
    btn.style.cssText = 'margin-left:0.6rem;background:#7fff7f;color:#0a0d0a;border:0;padding:0.2rem 0.6rem;cursor:pointer;';
    btn.addEventListener('click', () => {
      try { activeToast.action.onClick(); } finally { dismissActive(); }
    });
    node.appendChild(btn);
  }
  liveEl.appendChild(node);
  let paused = false;
  let elapsed = 0;
  let last = performance.now();
  let rafId;
  const tick = (now) => {
    if (!paused) elapsed += now - last;
    last = now;
    if (elapsed >= activeToast.ms) { dismissActive(); return; }
    rafId = requestAnimationFrame(tick);
  };
  node.addEventListener('mouseenter', () => { paused = true; });
  node.addEventListener('mouseleave', () => { paused = false; });
  rafId = requestAnimationFrame(tick);

  function dismissActive() {
    cancelAnimationFrame(rafId);
    if (node.parentNode) node.parentNode.removeChild(node);
    activeToast = null;
    drainToast();
  }
}

// @req FR-25
// @req FR-64
// @req FR-65
// @req NFR-11
// @req NFR-16
export function banner(id, messageKey, params = {}, actions = []) {
  ensureHosts();
  removeBanner(id);
  const node = document.createElement('div');
  node.dataset.bannerId = id;
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.className = 'aar-banner';
  node.style.cssText = 'background:#1f2a1f;color:#ffb84d;border-bottom:1px solid #ffb84d;padding:0.5rem 1rem;display:flex;justify-content:space-between;align-items:center;gap:0.5rem;';
  const text = document.createElement('span');
  text.textContent = typeof messageKey === 'string' ? t(messageKey, params) : String(messageKey);
  node.appendChild(text);
  const actionsWrap = document.createElement('span');
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t(a.labelKey);
    btn.style.cssText = 'margin-left:0.4rem;background:transparent;color:#ffb84d;border:1px solid #ffb84d;padding:0.2rem 0.6rem;cursor:pointer;';
    btn.addEventListener('click', () => { try { a.onClick(); } catch (e) { console.error(e); } });
    actionsWrap.appendChild(btn);
  }
  node.appendChild(actionsWrap);
  bannerHostEl.appendChild(node);
  banners.set(id, { node });
}

export function removeBanner(id) {
  const b = banners.get(id);
  if (b && b.node.parentNode) b.node.parentNode.removeChild(b.node);
  banners.delete(id);
}

export function hasBanner(id) {
  return banners.has(id);
}

// @req NFR-14
// @req NFR-16
// dialog({ titleKey, bodyKey, params, actions, destructive }) → Promise<value>
// destructive: true → close on storage event (architecture §5.5.1)
export function dialog({ titleKey, bodyKey, params = {}, actions = [], destructive = false, content }) {
  ensureHosts();
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.style.cssText = 'border:1px solid #7fff7f;background:#0d1f0d;color:#c8e6c9;padding:1rem 1.25rem;max-width:32rem;';
    if (titleKey) {
      const h = document.createElement('h2');
      h.textContent = t(titleKey, params);
      h.style.cssText = 'margin:0 0 0.5rem 0;color:#7fff7f;font-size:1rem;text-transform:uppercase;letter-spacing:0.1em;';
      dlg.appendChild(h);
    }
    if (bodyKey) {
      const p = document.createElement('p');
      p.textContent = t(bodyKey, params);
      p.style.cssText = 'margin:0 0 0.75rem 0;line-height:1.5;';
      dlg.appendChild(p);
    }
    if (content instanceof Element) dlg.appendChild(content);
    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display:flex;gap:0.4rem;justify-content:flex-end;';
    const buttons = [];
    actions.forEach((a, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = t(a.labelKey);
      btn.style.cssText = 'background:' + (a.primary ? '#7fff7f' : 'transparent') + ';color:' + (a.primary ? '#0a0d0a' : '#7fff7f') + ';border:1px solid #7fff7f;padding:0.4rem 0.8rem;cursor:pointer;min-height:44px;';
      btn.addEventListener('click', () => {
        close(a.value);
      });
      if (a.disabled) btn.disabled = true;
      buttonRow.appendChild(btn);
      buttons.push({ a, btn });
      if (a.defaultFocus) {
        // Focus is set after showModal()
        queueMicrotask(() => { try { btn.focus(); } catch { /* ignore */ } });
      }
    });
    dlg.appendChild(buttonRow);
    dialogHostEl.appendChild(dlg);
    let closed = false;
    function close(value) {
      if (closed) return;
      closed = true;
      try { dlg.close(); } catch { /* ignore */ }
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      if (storageHandler) storageCloseSubs.delete(storageHandler);
      resolve(value);
    }
    let storageHandler = null;
    if (destructive) {
      storageHandler = () => close({ closedByStorage: true });
      storageCloseSubs.add(storageHandler);
    }
    dlg.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      const cancelAction = actions.find((a) => a.cancel);
      close(cancelAction ? cancelAction.value : null);
    });
    try { dlg.showModal(); }
    catch {
      // Fallback for environments without <dialog> support
      dlg.setAttribute('open', '');
    }
    // expose for tests
    dlg.__close = close;
  });
}

// @req FR-79
// Called by storage.js subscriber so any open destructive dialog closes.
export function notifyStorageEventForDestructiveModals() {
  for (const cb of [...storageCloseSubs]) { try { cb(); } catch { /* ignore */ } }
}

export function _resetForTests() {
  toastQueue.length = 0;
  activeToast = null;
  banners.clear();
  storageCloseSubs.clear();
  if (typeof document !== 'undefined') {
    if (liveEl) liveEl.innerHTML = '';
    if (bannerHostEl) bannerHostEl.innerHTML = '';
    if (dialogHostEl) dialogHostEl.innerHTML = '';
  }
}
