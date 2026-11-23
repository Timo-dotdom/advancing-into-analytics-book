// Wetterwahl – Score-Logik (reine Funktionen, ohne DOM, in Node testbar)

/**
 * Wetterprofile. Alle Werte sind in den Einstellungen änderbar.
 *  weights      Gewichtung der Teilscores (wird normalisiert)
 *  tempMin/Max  Wohlfühlbereich der Tageshöchsttemperatur (°C) → Teilscore 1
 *  coldMargin   so viele °C unter tempMin fällt der Teilscore linear auf 0
 *  heatLimit    zwischen tempMax und heatLimit sinkt der Teilscore sanft auf 0.6,
 *               darüber steil (heatDrop pro °C)
 *  rainBadMm    Tagesniederschlag, ab dem der Mengen-Anteil voll zählt
 *  gustOk/Bad   Windböen (km/h): darunter 1, darüber 0
 *  vetoes       Teilscore unter diesem Wert drückt den ganzen Tag (Knock-out)
 *  worstWeight  Anteil des schlechtesten Tages am Fensterscore
 */
export const DEFAULT_PROFILES = {
  sonne: {
    name: 'Sonne & Baden',
    icon: '🏖️',
    weights: { sun: 0.40, temp: 0.30, rain: 0.25, wind: 0.05 },
    tempMin: 24, tempMax: 32, coldMargin: 8, heatLimit: 35, heatDrop: 0.2,
    rainBadMm: 5, gustOk: 35, gustBad: 75,
    vetoes: { rain: 0.4 },
    worstWeight: 0.4,
  },
  wandern: {
    name: 'Wandern',
    icon: '🥾',
    weights: { sun: 0.15, temp: 0.30, rain: 0.35, wind: 0.20 },
    tempMin: 15, tempMax: 25, coldMargin: 8, heatLimit: 28, heatDrop: 0.2,
    rainBadMm: 6, gustOk: 25, gustBad: 60,
    vetoes: { rain: 0.4, temp: 0.4 },
    worstWeight: 0.4,
  },
  trocken: {
    name: 'Hauptsache trocken',
    icon: '☂️',
    weights: { sun: 0.15, temp: 0.10, rain: 0.65, wind: 0.10 },
    tempMin: 10, tempMax: 30, coldMargin: 10, heatLimit: 35, heatDrop: 0.2,
    rainBadMm: 4, gustOk: 35, gustBad: 75,
    vetoes: { rain: 0.5 },
    worstWeight: 0.4,
  },
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function tempScore(tmax, p) {
  if (!isNum(tmax)) return null;
  if (tmax < p.tempMin) return clamp01(1 - (p.tempMin - tmax) / p.coldMargin);
  if (tmax <= p.tempMax) return 1;
  if (tmax <= p.heatLimit) {
    const span = Math.max(0.1, p.heatLimit - p.tempMax);
    return 1 - 0.4 * ((tmax - p.tempMax) / span);
  }
  return clamp01(0.6 - (tmax - p.heatLimit) * p.heatDrop);
}

/** Sonnenschein relativ zur Tageslänge; 80 % der möglichen Sonnenstunden = perfekt. */
export function sunScore(sunshineSec, daylightSec) {
  if (!isNum(sunshineSec)) return null;
  const day = isNum(daylightSec) && daylightSec > 0 ? daylightSec : 12 * 3600;
  return clamp01(sunshineSec / day / 0.8);
}

/** Regen aus Menge (Wurzel: schon wenig Regen zählt) und Wahrscheinlichkeit. */
export function rainScore(mm, probPct, p) {
  if (!isNum(mm) && !isNum(probPct)) return null;
  const m = isNum(mm) ? (mm < 0.2 ? 0 : Math.sqrt(clamp01(mm / p.rainBadMm))) : null;
  const pr = isNum(probPct) ? clamp01(probPct / 100) : null;
  let wet;
  if (m !== null && pr !== null) wet = 0.5 * m + 0.5 * pr;
  else wet = m !== null ? m : pr;
  return 1 - wet;
}

export function windScore(gustKmh, p) {
  if (!isNum(gustKmh)) return null;
  if (gustKmh <= p.gustOk) return 1;
  if (gustKmh >= p.gustBad) return 0;
  return 1 - (gustKmh - p.gustOk) / (p.gustBad - p.gustOk);
}

/** Veto-Faktor: unterhalb der Schwelle wird der Tag stark gedrückt (bis auf 35 %). */
export function vetoFactor(s, threshold) {
  if (s === null || !threshold || s >= threshold) return 1;
  return 0.35 + 0.65 * (s / threshold);
}

/**
 * Tagesscore 0–100.
 * day = { tmax, tmin, sunshine (s), daylight (s), precip (mm), precipProb (%), gust (km/h) }
 */
export function dayScore(day, p) {
  const parts = {
    sun: sunScore(day.sunshine, day.daylight),
    temp: tempScore(day.tmax, p),
    rain: rainScore(day.precip, day.precipProb, p),
    wind: windScore(day.gust, p),
  };
  let sum = 0, wsum = 0;
  for (const k of Object.keys(parts)) {
    const w = p.weights[k] || 0;
    if (parts[k] === null || w <= 0) continue;
    sum += w * parts[k];
    wsum += w;
  }
  if (wsum === 0 || parts.rain === null && parts.temp === null) return { score: null, parts };
  let factor = 1;
  for (const [k, thr] of Object.entries(p.vetoes || {})) factor *= vetoFactor(parts[k], thr);
  return { score: Math.round(100 * (sum / wsum) * factor * 10) / 10, parts };
}

/** Fensterscore: Mischung aus Mittelwert und schlechtestem Tag. */
export function windowScore(scores, worstWeight = 0.4) {
  if (!scores.length || scores.some((s) => !isNum(s))) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const min = Math.min(...scores);
  return { score: (1 - worstWeight) * mean + worstWeight * min, mean, min };
}

/**
 * Sliding Window: bestes Fenster mit n Tagen, Start zwischen startMin und startMax (Indizes).
 * Bei Gleichstand gewinnt der frühere Start.
 */
export function bestWindow(dayScores, n, startMin = 0, startMax = Infinity, worstWeight = 0.4) {
  let best = null;
  const last = Math.min(startMax, dayScores.length - n);
  for (let s = Math.max(0, startMin); s <= last; s++) {
    const w = windowScore(dayScores.slice(s, s + n), worstWeight);
    if (w && (!best || w.score > best.score + 1e-9)) best = { start: s, ...w };
  }
  return best;
}

/** Wandelt eine Open-Meteo-Antwort (daily) in eine Liste von Tagen um. */
export function parseDaily(daily) {
  return daily.time.map((date, i) => ({
    date,
    tmax: daily.temperature_2m_max?.[i] ?? null,
    tmin: daily.temperature_2m_min?.[i] ?? null,
    sunshine: daily.sunshine_duration?.[i] ?? null,
    daylight: daily.daylight_duration?.[i] ?? null,
    precip: daily.precipitation_sum?.[i] ?? null,
    precipProb: daily.precipitation_probability_max?.[i] ?? null,
    gust: daily.wind_gusts_10m_max?.[i] ?? null,
  }));
}

/**
 * Prognose-Sicherheit aus Ensemble-Tageswerten für die Tage eines Fensters.
 * members = { tmax: number[][] (Tag × Member), precip: number[][] }
 * Temperatur: Standardabweichung (4 °C = maximal unsicher);
 * Regen: Uneinigkeit der Member, ob es regnet (>1 mm): 4·p·(1−p).
 */
export function ensembleConfidence(members, dayIdx) {
  const vals = [];
  for (const d of dayIdx) {
    const t = (members.tmax[d] || []).filter(isNum);
    const r = (members.precip[d] || []).filter(isNum);
    if (t.length < 3 || r.length < 3) continue;
    const mean = t.reduce((a, b) => a + b, 0) / t.length;
    const sd = Math.sqrt(t.reduce((a, b) => a + (b - mean) ** 2, 0) / t.length);
    const pWet = r.filter((x) => x > 1).length / r.length;
    vals.push(0.5 * clamp01(sd / 4) + 0.5 * 4 * pWet * (1 - pWet));
  }
  if (!vals.length) return { level: 'unbekannt', u: null, coveredDays: 0 };
  const u = vals.reduce((a, b) => a + b, 0) / vals.length;
  const level = u < 0.3 ? 'hoch' : u < 0.55 ? 'mittel' : 'niedrig';
  return { level, u, coveredDays: vals.length };
}
