import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILES as P } from '../js/score.js';
import {
  parseHourly, aggregate, hikeScore, overnightScore, dayTourScore, nightOnlyScore, coldScore,
  SHELTERS, scoreHourlyPoints, weekendDates, addDays, applyDog,
} from '../js/modes.js';

/** Baut eine Open-Meteo-Stundenantwort: fn(dayIndex, hour) → Werte */
function mkLoc(days, fn, start = '2026-11-27') {
  const hourly = { time: [], temperature_2m: [], precipitation: [], precipitation_probability: [], weather_code: [], wind_gusts_10m: [], sunshine_duration: [], snowfall: [] };
  for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) {
    const v = { t: 15, p: 0, pp: 5, code: 1, gust: 15, sun: h >= 8 && h < 17 ? 3000 : 0, snow: 0, ...fn(d, h) };
    hourly.time.push(`${addDays(start, d)}T${String(h).padStart(2, '0')}:00`);
    hourly.temperature_2m.push(v.t); hourly.precipitation.push(v.p); hourly.precipitation_probability.push(v.pp);
    hourly.weather_code.push(v.code); hourly.wind_gusts_10m.push(v.gust); hourly.sunshine_duration.push(v.sun); hourly.snowfall.push(v.snow);
  }
  return parseHourly({ hourly, daily: { time: [] } });
}
const hike = { start: 9, end: 17 };

test('Aggregation: Wanderfenster, trockener Block', () => {
  // Tag 0: ab 14 Uhr Regen
  const h = mkLoc(2, (d, hr) => (d === 0 && hr >= 14 ? { p: 2, pp: 80, sun: 0 } : {}));
  const a = aggregate(h, '2026-11-27', 9, 8);
  assert.equal(a.n, 8);
  assert.equal(a.precip, 6);
  assert.equal(a.probMax, 80);
  assert.deepEqual(a.dryBlock, [9, 14]);   // 9–14 Uhr trocken
  assert.equal(aggregate(h, '2026-12-30', 9, 8), null);
});

test('Tagestour: Gewitter und Schnee drücken den Score', () => {
  const sunny = mkLoc(3, () => ({ t: 19 }));
  const storm = mkLoc(3, (d, hr) => ({ t: 22, ...(hr === 15 ? { code: 95, p: 4, pp: 60 } : {}) }));
  const snowy = mkLoc(3, (d, hr) => ({ t: 1, ...(hr >= 9 && hr < 13 ? { snow: 1.5, p: 1, pp: 70 } : {}) }));
  const s = (h, prof = P.wandern) => dayTourScore(h, '2026-11-27', { profile: prof, hike }).score;
  assert.ok(s(sunny) > 85, `sonnig ${s(sunny)}`);
  assert.ok(s(storm) < 35, `Gewitter ${s(storm)}`);
  assert.ok(s(snowy, P.berg) < 25, `Neuschnee Bergtour ${s(snowy, P.berg)}`);
});

test('Kälte gegen Schlafsack-Komfort', () => {
  assert.equal(coldScore(5, 0), 1);
  assert.equal(coldScore(-2, 0), 0.5);
  assert.equal(coldScore(-6, 0), 0);
  assert.ok(coldScore(23, 0) < 1, 'tropische Nacht ist auch schlecht');
});

test('Overnighter: Schlafplatz macht den Unterschied', () => {
  // Kalte, windige, trockene Nacht: 0 °C, Böen 55 km/h
  const h = mkLoc(3, (d, hr) => (hr >= 20 || hr < 8 ? { t: 0, gust: 55, sun: 0 } : { t: 12 }));
  const opts = (shelter) => ({ profile: P.wandern, shelter: SHELTERS[shelter], comfort: 0 });
  const zelt = overnightScore(h, '2026-11-27', opts('zelt')).score;
  const matte = overnightScore(h, '2026-11-27', opts('haengematte')).score;
  const van = overnightScore(h, '2026-11-27', opts('van')).score;
  assert.ok(van > zelt + 15, `Van ${van} > Zelt ${zelt}`);
  assert.ok(matte < zelt, `Hängematte ${matte} kälter als Zelt ${zelt}`);
  // Regen nachts: im Van egal, im Zelt schlecht
  const wet = mkLoc(3, (d, hr) => (d === 0 && hr >= 22 ? { p: 3, pp: 90, t: 8 } : d === 1 && hr < 5 ? { p: 3, pp: 90, t: 8 } : { t: 12 }));
  const wz = overnightScore(wet, '2026-11-27', opts('zelt')).score;
  const wv = overnightScore(wet, '2026-11-27', opts('van')).score;
  assert.ok(wz < 50, `nasse Nacht Zelt ${wz}`);
  assert.ok(wv > wz + 20, `nasse Nacht Van ${wv}`);
  // Nacht braucht den Folgemorgen
  assert.equal(overnightScore(h, '2026-11-29', opts('zelt')), null);
});

test('Gewitter nachts in der Hängematte ist ein No-Go', () => {
  const h = mkLoc(3, (d, hr) => (d === 0 && hr === 23 ? { code: 96, p: 5, pp: 70, t: 14 } : { t: 14 }));
  const n = nightOnlyScore(aggregate(h, '2026-11-27', 20, 11), SHELTERS.haengematte, 5);
  assert.ok(n.score < 25, `Hängematte Gewitter ${n.score}`);
});

test('Bester Tag pro Punkt, Wochenend-Kandidaten', () => {
  // Fr 27.11.2026 – Regen am Freitag, Sonne am Samstag
  const h = mkLoc(4, (d) => (d === 0 ? { p: 1.5, pp: 85, sun: 0 } : { t: 18 }));
  const [pt] = scoreHourlyPoints([{ lat: 47, lon: 11, distKm: 10, h }], { mode: 'day', dates: ['2026-11-27', '2026-11-28', '2026-11-29'], profile: P.wandern, hike });
  assert.equal(pt.window.date, '2026-11-28');
  assert.equal(pt.cands.length, 3);
  assert.deepEqual(weekendDates('2026-11-27', 'day', 7), ['2026-11-28', '2026-11-29']);
  assert.deepEqual(weekendDates('2026-11-27', 'night', 7), ['2026-11-27', '2026-11-28']);
});

test('Hund: Baden bleibt unberührt', () => {
  assert.equal(applyDog(P.sonne, true), P.sonne);
  assert.equal(applyDog(P.wandern, false), P.wandern);
  assert.equal(applyDog(P.trocken, true).heatLimit, 28);
});
