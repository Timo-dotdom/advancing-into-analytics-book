// Wetterwahl – Datenabruf (Open-Meteo, Nominatim) mit lokalem Cache und Rate-Limit-Schutz
import { parseDaily } from './score.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ENSEMBLE = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE = 'https://nominatim.openstreetmap.org/reverse';

const DAILY = [
  'temperature_2m_max', 'temperature_2m_min', 'sunshine_duration', 'daylight_duration',
  'precipitation_sum', 'precipitation_probability_max', 'wind_gusts_10m_max',
].join(',');

const TTL_FORECAST = 3 * 3600e3;
const TTL_ENSEMBLE = 6 * 3600e3;
const TTL_NAME = 90 * 24 * 3600e3;
const BATCH = 50;
const CONCURRENCY = 2;

// ---------- Cache (localStorage) ----------
const PREFIX = 'ww:c:';
function cacheGet(key, ttl) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > ttl) return null;
    return v;
  } catch { return null; }
}
function cacheSet(key, v) {
  const item = JSON.stringify({ t: Date.now(), v });
  try { localStorage.setItem(PREFIX + key, item); }
  catch { pruneCache(true); try { localStorage.setItem(PREFIX + key, item); } catch { /* voll */ } }
}
/** Entfernt abgelaufene Einträge (oder bei Platzmangel alle Wetterdaten). */
export function pruneCache(all = false) {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k?.startsWith(PREFIX) || k.startsWith(PREFIX + 'n:')) continue; // Namen behalten
    try {
      const { t } = JSON.parse(localStorage.getItem(k));
      const ttl = k.startsWith(PREFIX + 'e:') ? TTL_ENSEMBLE : TTL_FORECAST;
      if (all || Date.now() - t > ttl) localStorage.removeItem(k);
    } catch { localStorage.removeItem(k); }
  }
}
export function clearCache() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
  }
}
const today = () => new Date().toISOString().slice(0, 10);
const ptKey = (p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;

// ---------- HTTP mit Retry ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {}

async function getJson(url, { retries = 3, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt >= retries) throw new ApiError('Keine Verbindung zum Wetterdienst.');
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.ok) return res.json();
    let reason = '';
    try { reason = (await res.json()).reason || ''; } catch { /* egal */ }
    if (res.status === 429 && /daily|hourly/i.test(reason)) {
      throw new ApiError('Das kostenlose Open-Meteo-Kontingent für heute/diese Stunde ist aufgebraucht. Bitte später erneut versuchen oder den Radius bzw. die Rasterdichte verkleinern.');
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(res.status === 429 ? 20000 * (attempt + 1) : 2000 * (attempt + 1));
      continue;
    }
    throw new ApiError(`Wetterdienst-Fehler ${res.status}${reason ? ': ' + reason : ''}`);
  }
}

// ---------- Forecast ----------
/**
 * Lädt Tageswerte (16 Tage) für alle Punkte. Bereits gecachte Punkte werden nicht
 * erneut abgefragt. onProgress(done, total, fromCache)
 */
export async function fetchForecast(points, { onProgress, signal } = {}) {
  const day = today();
  const result = new Array(points.length);
  const missing = [];
  points.forEach((p, i) => {
    const c = cacheGet(`f:${day}:${ptKey(p)}`, TTL_FORECAST);
    if (c) result[i] = c; else missing.push(i);
  });
  let done = points.length - missing.length;
  onProgress?.(done, points.length, done);

  const batches = [];
  for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));

  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const idx = batches[next++];
      const lat = idx.map((i) => points[i].lat).join(',');
      const lon = idx.map((i) => points[i].lon).join(',');
      const url = `${FORECAST}?latitude=${lat}&longitude=${lon}&daily=${DAILY}&forecast_days=16&timezone=auto`;
      const json = await getJson(url, { signal });
      const arr = Array.isArray(json) ? json : [json];
      arr.forEach((loc, k) => {
        const i = idx[k];
        const v = { days: parseDaily(loc.daily), elevation: loc.elevation };
        result[i] = v;
        cacheSet(`f:${day}:${ptKey(points[i])}`, v);
      });
      done += idx.length;
      onProgress?.(done, points.length);
      if (next < batches.length) await sleep(400); // sanft zum Server
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return result;
}

// ---------- Ensemble (Prognose-Sicherheit) ----------
/**
 * ECMWF-IFS-Ensemble (51 Member, 15 Tage). Liefert je Punkt
 * { dates, tmax: [Tag][Member], precip: [Tag][Member] }.
 */
export async function fetchEnsemble(points, { signal } = {}) {
  const day = today();
  const result = new Array(points.length);
  const missing = [];
  points.forEach((p, i) => {
    const c = cacheGet(`e:${day}:${ptKey(p)}`, TTL_ENSEMBLE);
    if (c) result[i] = c; else missing.push(i);
  });
  if (missing.length) {
    const lat = missing.map((i) => points[i].lat).join(',');
    const lon = missing.map((i) => points[i].lon).join(',');
    const url = `${ENSEMBLE}?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,precipitation_sum&models=ecmwf_ifs025&forecast_days=15&timezone=auto`;
    const json = await getJson(url, { signal, retries: 2 });
    const arr = Array.isArray(json) ? json : [json];
    arr.forEach((loc, k) => {
      const d = loc.daily;
      const collect = (prefix) => d.time.map((_, t) =>
        Object.keys(d).filter((key) => key === prefix || key.startsWith(prefix + '_member')).map((key) => d[key][t]));
      const v = { dates: d.time, tmax: collect('temperature_2m_max'), precip: collect('precipitation_sum') };
      result[missing[k]] = v;
      cacheSet(`e:${day}:${ptKey(points[missing[k]])}`, v);
    });
  }
  return result;
}

// ---------- Ortssuche ----------
export async function searchPlace(q, { signal } = {}) {
  const url = `${GEOCODE}?name=${encodeURIComponent(q)}&count=8&language=de&format=json`;
  const json = await getJson(url, { signal, retries: 1 });
  return (json.results || []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude, lon: r.longitude,
  }));
}

// ---------- Reverse Geocoding (Nominatim, max. 1 Anfrage/s) ----------
let lastNominatim = 0;
let queue = Promise.resolve();

function formatName(json) {
  const a = json.address || {};
  const place = a.village || a.town || a.city || a.municipality || a.hamlet || a.suburb || a.county;
  const area = a.state || a.province || a.region || a.county;
  const parts = [place, area && area !== place ? area : null].filter(Boolean);
  const cc = (a.country_code || '').toUpperCase();
  return { name: parts.join(' · ') || json.name || null, country: cc };
}

export function reverseName(lat, lon) {
  const key = `n:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = cacheGet(key, TTL_NAME);
  if (cached) return Promise.resolve(cached);
  const job = queue.then(async () => {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastNominatim = Date.now();
    try {
      const url = `${REVERSE}?lat=${lat}&lon=${lon}&format=jsonv2&zoom=10&addressdetails=1&accept-language=de`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const v = formatName(await res.json());
      if (v.name) cacheSet(key, v);
      return v;
    } catch { return null; }
  });
  queue = job.catch(() => null);
  return job;
}
