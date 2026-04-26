// js/i18n.js — C-14 hand-rolled i18n shim (ADR-008).
// Public API: setLocale, t, loadCatalogue, getActiveLocale, hasKey,
//             keyCoverageCheck. No third-party dep (NFR-22).

let active = 'en';
const catalogues = { en: null, 'pt-br': null, fr: null, el: null };
const SUPPORTED = ['en', 'pt-br', 'fr', 'el'];
const RUNTIME_AVAILABLE = ['en']; // v1: only en is selectable (FR-89)

// @req FR-89
export function setLocale(locale) {
  active = RUNTIME_AVAILABLE.includes(locale) ? locale : 'en';
}

export function getActiveLocale() {
  return active;
}

// @req FR-86
// @req FR-91
export function t(key, params) {
  if (typeof key !== 'string') throw new TypeError('i18n.t: key must be a string');
  const cat = catalogues[active] ?? catalogues.en;
  // FR-90: if no catalogue is loaded yet (caller forgot to await
  // loadCatalogue), surface a sentinel rather than render raw keys.
  if (!cat) return `[i18n:${key}]`;
  // FR-91: missing key returns the literal key string.
  const raw = cat[key] ?? catalogues.en?.[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_m, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`,
  );
}

export function hasKey(key) {
  return Boolean(catalogues[active]?.[key]);
}

// @req FR-87
// @req NFR-22
export async function loadCatalogue(locale) {
  if (!SUPPORTED.includes(locale)) throw new Error(`unsupported locale: ${locale}`);
  if (catalogues[locale]) return catalogues[locale];
  const res = await fetch(`./locales/${locale}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`failed to load locale ${locale}: HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`locale ${locale} is not a flat-key JSON object`);
  }
  // FR-87: flat keys only — no nested objects.
  for (const v of Object.values(data)) {
    if (typeof v !== 'string') {
      throw new Error(`locale ${locale} contains a non-string value (FR-87 violation)`);
    }
  }
  catalogues[locale] = data;
  return data;
}

export function _injectCatalogueForTests(locale, obj) {
  catalogues[locale] = obj;
}

// @req FR-88
export function keyCoverageCheck(referencedKeys = []) {
  const en = catalogues.en;
  if (!en) return { ok: false, reason: 'en catalogue not loaded' };
  const enKeys = Object.keys(en);
  const enSet = new Set(enKeys);
  const missingFromEn = referencedKeys.filter((k) => !enSet.has(k));
  const others = SUPPORTED.filter((L) => L !== 'en').map((L) => {
    const cat = catalogues[L];
    return {
      locale: L,
      loaded: Boolean(cat),
      missingVsEn: cat ? enKeys.filter((k) => !(k in cat)) : enKeys,
      extraVsEn: cat ? Object.keys(cat).filter((k) => !enSet.has(k)) : [],
    };
  });
  return {
    ok: missingFromEn.length === 0 && others.every((o) => o.loaded && o.missingVsEn.length === 0 && o.extraVsEn.length === 0),
    missingFromEn,
    others,
  };
}

export const SUPPORTED_LOCALES = SUPPORTED;
export const RUNTIME_LOCALES = RUNTIME_AVAILABLE;
