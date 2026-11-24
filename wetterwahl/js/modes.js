// Wetterwahl – Modi Tagestour & Overnighter (stündliche Daten), Hund, Schlafplatz
// Reine Funktionen, in Node testbar.
import { dayScore, rainScore, windScore, sunScore, vetoFactor } from './score.js';

export const MODES = {
  van: { name: 'Van-Tour', icon: '🚐', desc: 'Mehrere Tage am Stück, große Distanzen', radius: [50, 1500, 400], hourly: false },
  day: { name: 'Tagestour', icon: '🥾', desc: 'Bester Tag und Ort für eine Wanderung', radius: [10, 250, 80], hourly: true },
  night: { name: 'Overnighter', icon: '⛺', desc: 'Beste Nacht: Nachmittag, Nacht und Morgen', radius: [10, 400, 120], hourly: true },
};

/** Profile pro Modus (Schlüssel aus settings.profiles). */
export const MODE_PROFILES = { van: ['sonne', 'wandern', 'trocken'], day: ['wandern', 'berg', 'trocken'], night: null };

/**
 * Schlafplätze für den Overnighter.
 * coldOffset: so viel °C wärmer muss die Nacht sein als der Schlafsack-Komfortwert
 * (Hängematte kühlt von unten aus, der Van isoliert).
 */
export const SHELTERS = {
  zelt: { name: 'Zelt', icon: '⛺', coldOffset: 0, rainBadMm: 4, gustOk: 30, gustBad: 65, w: { cold: 0.35, rain: 0.40, wind: 0.25 }, thunderFactor: 0.3, windVeto: 0.4, rainVeto: 0.4 },
  haengematte: { name: 'Hängematte', icon: '🌳', coldOffset: 4, rainBadMm: 5, gustOk: 30, gustBad: 60, w: { cold: 0.45, rain: 0.35, wind: 0.20 }, thunderFactor: 0.25, windVeto: 0.4, rainVeto: 0.4 },
  van: { name: 'Van', icon: '🚐', coldOffset: -6, rainBadMm: 30, gustOk: 50, gustBad: 90, w: { cold: 0.40, rain: 0.30, wind: 0.30 }, thunderFactor: 0.8, windVeto: 0.2, rainVeto: 0 },
};

export const DOG = { tempMax: 25, heatLimit: 28, tempVeto: 0.6 };

/** Hund dabei: Hitze stärker abwerten (außer bei Profilen, die das ausschließen). */
export function applyDog(profile, dog) {
  if (!dog || profile.dogAware === false) return profile;
  return {
    ...profile,
    tempMax: Math.min(profile.tempMax, DOG.tempMax),
    heatLimit: Math.min(profile.heatLimit, DOG.heatLimit),
    vetoes: { ...(profile.vetoes || {}), temp: Math.max(profile.vetoes?.temp ?? 0, DOG.tempVeto) },
  };
}

// ---------- Stündliche Daten ----------

export function parseHourly(loc) {
  const h = loc.hourly, d = loc.daily || {};
  const index = {};
  h.time.forEach((t, i) => { index[t] = i; });
  return {
    time: h.time, index,
    t: h.temperature_2m, p: h.precipitation, pp: h.precipitation_probability,
    code: h.weather_code, gust: h.wind_gusts_10m, sun: h.sunshine_duration, snow: h.snowfall,
    daily: {
      date: d.time || [], sunrise: d.sunrise || [], sunset: d.sunset || [],
      tmax: d.temperature_2m_max || [], tmin: d.temperature_2m_min || [],
    },
  };
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isDry = (h, i) => (h.p[i] ?? 0) < 0.2 && (h.pp?.[i] == null || h.pp[i] < 40) && !((h.code?.[i] ?? 0) >= 95);

export function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Fasst `hours` Stunden ab `date` `fromHour` Uhr zusammen.
 * Liefert null, wenn die Daten nicht reichen.
 */
export function aggregate(h, date, fromHour, hours) {
  const start = h.index[`${date}T${String(fromHour).padStart(2, '0')}:00`];
  if (start == null || start + hours > h.time.length) return null;
  const a = { date, from: fromHour, n: hours, precip: 0, probMax: null, sunSec: 0, tmax: -Infinity, tmin: Infinity, gustMax: null, thunder: false, snow: 0, dryHours: 0, dryBlock: null, hours: [] };
  let run = 0, best = 0, bestEnd = -1, valid = 0;
  for (let k = 0; k < hours; k++) {
    const i = start + k;
    if (!isNum(h.t[i])) continue;
    valid++;
    a.precip += h.p[i] ?? 0;
    if (isNum(h.pp?.[i])) a.probMax = Math.max(a.probMax ?? 0, h.pp[i]);
    a.sunSec += h.sun?.[i] ?? 0;
    a.tmax = Math.max(a.tmax, h.t[i]);
    a.tmin = Math.min(a.tmin, h.t[i]);
    if (isNum(h.gust?.[i])) a.gustMax = Math.max(a.gustMax ?? 0, h.gust[i]);
    if ((h.code?.[i] ?? 0) >= 95) a.thunder = true;
    a.snow += h.snow?.[i] ?? 0;
    if (isDry(h, i)) { a.dryHours++; run++; if (run > best) { best = run; bestEnd = k; } } else run = 0;
  }
  if (valid < hours * 0.75) return null;
  if (best > 0) a.dryBlock = [(fromHour + bestEnd - best + 1) % 24, (fromHour + bestEnd + 1) % 24];
  a.precip = Math.round(a.precip * 10) / 10;
  return a;
}

/** Stundenwerte für die Anzeige. */
export function hourRows(h, date, fromHour, hours) {
  const start = h.index[`${date}T${String(fromHour).padStart(2, '0')}:00`];
  if (start == null) return [];
  const out = [];
  for (let k = 0; k < hours && start + k < h.time.length; k++) {
    const i = start + k;
    out.push({ time: h.time[i], hour: (fromHour + k) % 24, t: h.t[i], p: h.p[i], pp: h.pp?.[i], code: h.code?.[i], gust: h.gust?.[i], sun: h.sun?.[i], snow: h.snow?.[i] });
  }
  return out;
}

// ---------- Scores ----------

/** Wanderfenster-Score: Tagesscore über die Wanderstunden + Gewitter-/Schnee-Abzug. */
export function hikeScore(a, profile) {
  if (!a) return null;
  const day = { tmax: a.tmax, sunshine: a.sunSec, daylight: a.n * 3600, precip: a.precip, precipProb: a.probMax, gust: a.gustMax };
  const base = dayScore(day, profile);
  if (base.score == null) return null;
  let f = 1;
  if (a.thunder) f *= profile.thunderFactor ?? 0.3;
  if (a.snow > 0.5) f *= 1 - Math.min(profile.snowMaxPenalty ?? 0.5, a.snow / 10);
  return { score: Math.round(base.score * f * 10) / 10, parts: base.parts, thunder: a.thunder, snow: a.snow };
}

export function coldScore(tmin, comfort) {
  if (!isNum(tmin)) return null;
  let s = tmin >= comfort + 2 ? 1 : Math.max(0, 1 - (comfort + 2 - tmin) / 8);
  if (tmin > 18) s *= Math.max(0.5, 1 - (tmin - 18) / 10); // zu warm zum Schlafen
  return s;
}

/** Nacht-Score (20–7 Uhr) für einen Schlafplatz. */
export function nightOnlyScore(n, shelter, comfort) {
  if (!n) return null;
  const c = comfort + shelter.coldOffset;
  const parts = {
    cold: coldScore(n.tmin, c),
    rain: rainScore(n.precip, n.probMax, shelter),
    wind: windScore(n.gustMax, shelter),
  };
  let sum = 0, ws = 0;
  for (const k of Object.keys(parts)) if (parts[k] != null) { sum += shelter.w[k] * parts[k]; ws += shelter.w[k]; }
  if (!ws) return null;
  let f = vetoFactor(parts.rain, shelter.rainVeto) * vetoFactor(parts.cold, 0.3) * vetoFactor(parts.wind, shelter.windVeto);
  if (n.thunder) f *= shelter.thunderFactor;
  return { score: Math.round(100 * (sum / ws) * f * 10) / 10, parts, comfortEff: c };
}

/** Morgen (7–11 Uhr): trocken zusammenpacken. */
export function morningScore(m) {
  if (!m) return null;
  const r = rainScore(m.precip, m.probMax, { rainBadMm: 3 });
  const s = sunScore(m.sunSec, m.n * 3600) ?? 0.5;
  return { score: Math.round(100 * (0.75 * r + 0.25 * s) * 10) / 10 };
}

/**
 * Overnighter: Nachmittag (14–20) + Nacht (20–7) + Morgen (7–11).
 * Gewichtet, schlechtester Abschnitt zählt extra (wie beim Fenster).
 */
export function overnightScore(h, date, { profile, shelter, comfort }) {
  const aft = aggregate(h, date, 14, 6);
  const night = aggregate(h, date, 20, 11);
  const morn = aggregate(h, addDays(date, 1), 7, 4);
  const A = hikeScore(aft, profile), N = nightOnlyScore(night, shelter, comfort), M = morningScore(morn);
  if (!A || !N || !M) return null;
  const weighted = 0.3 * A.score + 0.5 * N.score + 0.2 * M.score;
  const score = 0.6 * weighted + 0.4 * Math.min(A.score, N.score, M.score);
  return { score: Math.round(score * 10) / 10, parts: { afternoon: A, night: N, morning: M }, agg: { afternoon: aft, night, morning: morn } };
}

export function dayTourScore(h, date, { profile, hike }) {
  const a = aggregate(h, date, hike.start, hike.end - hike.start);
  const s = hikeScore(a, profile);
  return s ? { ...s, agg: a } : null;
}

/** Kandidaten-Tage im Suchzeitraum (Wochenende: Sa+So bzw. Fr+Sa-Nächte). */
export function candidateDates(firstDate, span, mode) {
  const out = [];
  for (let i = 0; i < span; i++) {
    const d = addDays(firstDate, i);
    out.push(d);
  }
  return out;
}
export function weekendDates(firstDate, mode, horizon = 14) {
  const out = [];
  for (let i = 0; i < horizon; i++) {
    const d = addDays(firstDate, i);
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    if (mode === 'night' ? (wd === 5 || wd === 6) : (wd === 6 || wd === 0)) out.push(d);
  }
  return out;
}

/**
 * Bewertet alle Punkte im Stunden-Modus: pro Punkt bester Kandidat.
 * points: [{ lat, lon, distKm, h (parseHourly), elevation }]
 */
export function scoreHourlyPoints(points, { mode, dates, profile, shelter, comfort, hike }) {
  return points.map((pt) => {
    const cands = dates.map((date) => {
      const r = mode === 'night'
        ? overnightScore(pt.h, date, { profile, shelter, comfort })
        : dayTourScore(pt.h, date, { profile, hike });
      return r ? { date, ...r } : { date, score: null };
    });
    let best = null;
    cands.forEach((c, ci) => { if (c.score != null && (!best || c.score > best.score + 1e-9)) best = { ...c, ci }; });
    return { ...pt, cands, window: best };
  });
}
