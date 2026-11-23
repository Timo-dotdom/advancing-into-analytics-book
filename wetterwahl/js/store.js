// Wetterwahl – Einstellungen und letzte Suche (localStorage)
import { DEFAULT_PROFILES } from './score.js';

const KEY_SETTINGS = 'ww:settings:v1';
const KEY_SEARCH = 'ww:search:v1';

export const DEFAULT_SETTINGS = {
  profiles: DEFAULT_PROFILES,
  maxPoints: 400,
  detour: 1.3,
  speed: 70,
  theme: 'auto',
};

const clone = (o) => JSON.parse(JSON.stringify(o));

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(base)) return over ?? base;
  const out = clone(base);
  for (const k of Object.keys(over)) {
    out[k] = base && typeof base[k] === 'object' && base[k] !== null ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

export function loadSettings() {
  try { return merge(DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(KEY_SETTINGS))); }
  catch { return clone(DEFAULT_SETTINGS); }
}
export function saveSettings(s) { localStorage.setItem(KEY_SETTINGS, JSON.stringify(s)); }
export function defaultProfile(id) { return clone(DEFAULT_PROFILES[id]); }

export function loadSearch() {
  try { return JSON.parse(localStorage.getItem(KEY_SEARCH)) || null; } catch { return null; }
}
export function saveSearch(s) { localStorage.setItem(KEY_SEARCH, JSON.stringify(s)); }

const KEY_RECENT = 'ww:recent:v1';
export function loadRecent() {
  try { return JSON.parse(localStorage.getItem(KEY_RECENT)) || []; } catch { return []; }
}
/** Merkt sich die letzten 6 Startpunkte (ohne Duplikate in < 5 km). */
export function addRecent(p) {
  if (!p?.label) return;
  const near = (a) => Math.abs(a.lat - p.lat) < 0.05 && Math.abs(a.lon - p.lon) < 0.05;
  const list = [p, ...loadRecent().filter((a) => !near(a))].slice(0, 6);
  localStorage.setItem(KEY_RECENT, JSON.stringify(list));
}
