import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePoints, clusterRegions } from '../js/regions.js';
import { DEFAULT_PROFILES as P } from '../js/score.js';
import { haversineKm, gridPoints, autoGrid, isLand, prepareLand, driveHours, formatDuration } from '../js/geo.js';
import { readFileSync } from 'node:fs';

const land = prepareLand(JSON.parse(readFileSync(new URL('../data/land.json', import.meta.url))));
const H = 3600;
const sun = { tmax: 22, tmin: 10, sunshine: 10 * H, daylight: 13 * H, precip: 0, precipProb: 5, gust: 15 };
const rain = { tmax: 16, tmin: 12, sunshine: 0, daylight: 13 * H, precip: 15, precipProb: 95, gust: 45 };

test('Haversine und Fahrzeit', () => {
  const muc = { lat: 48.137, lon: 11.575 }, ber = { lat: 52.52, lon: 13.405 };
  assert.ok(Math.abs(haversineKm(muc, ber) - 504) < 5);
  assert.equal(formatDuration(driveHours(504)), '~9 h 15');
});

test('Land-Maske: Meer wird verworfen', () => {
  assert.equal(isLand(land, 48.14, 11.58), true);   // München
  assert.equal(isLand(land, 54.5, 3.0), false);     // Nordsee
  assert.equal(isLand(land, 43.0, 5.5), false);     // Mittelmeer vor Marseille
  assert.equal(isLand(land, 39.6, 2.9), true);      // Mallorca
  assert.equal(isLand(land, 46.45, 6.55), false);   // Genfer See
});

test('Raster: Abstand, Radius, Punktlimit, globale Ausrichtung', () => {
  const c = { lat: 47.5, lon: 11 };
  const pts = gridPoints(c, 200, 30, land);
  assert.ok(pts.every((p) => p.distKm <= 200));
  assert.ok(pts.length > 80 && pts.length < 160, `${pts.length} Punkte`);
  const big = autoGrid(c, 1500, land, 400);
  assert.ok(big.points.length <= 400 && big.points.length > 200, `${big.points.length}`);
  // verschobener Startpunkt → gleiche Gitterpunkte (Cache-Treffer)
  const a = new Set(gridPoints(c, 100, 30, land).map((p) => `${p.lat},${p.lon}`));
  const b = gridPoints({ lat: 47.55, lon: 11.05 }, 100, 30, land).map((p) => `${p.lat},${p.lon}`);
  assert.ok(b.filter((k) => a.has(k)).length > b.length * 0.8);
});

test('Fenstersuche und Regionen-Clustering', () => {
  const mk = (lat, lon, days) => ({ lat, lon, distKm: 0, days });
  const pts = [
    mk(47.0, 11.0, [rain, sun, sun, sun, rain]),     // gut ab Tag 1
    mk(47.1, 11.1, [rain, sun, sun, sun, rain]),     // Nachbar, gleiche Gegend
    mk(47.2, 11.0, [rain, sun, sun, rain, rain]),    // Nachbar, etwas schlechter
    mk(45.0, 8.0, [sun, sun, rain, sun, sun]),       // weit weg, Regentag in der Mitte
    mk(44.0, 5.0, [rain, rain, rain, rain, rain]),
  ];
  const scored = scorePoints(pts, { n: 3, startMin: 0, startMax: 2, profile: P.wandern });
  assert.equal(scored[0].window.start, 1);
  assert.ok(scored[0].window.score > 85);
  const regs = clusterRegions(scored, 80, 10);
  assert.equal(regs.length, 3, 'Nachbarn werden zusammengefasst');
  assert.equal(regs[0].lat, 47.0);
  assert.equal(regs[0].members, 3);
  assert.equal(regs[1].lat, 45.0);
  assert.ok(regs[1].window.score < regs[0].window.score - 20);
});
