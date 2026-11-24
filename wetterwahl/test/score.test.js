import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROFILES as P, tempScore, sunScore, rainScore, windScore,
  dayScore, windowScore, bestWindow, ensembleConfidence,
} from '../js/score.js';
import { applyDog } from '../js/modes.js';
const W_DOG = applyDog(P.wandern, true);

const H = 3600;
// Feste Beispieltage
const perfekterSommertag = { tmax: 28, tmin: 17, sunshine: 12 * H, daylight: 15 * H, precip: 0, precipProb: 5, gust: 15 };
const wandertag = { tmax: 20, tmin: 9, sunshine: 8 * H, daylight: 13 * H, precip: 0, precipProb: 10, gust: 15 };
const regentag = { tmax: 22, tmin: 15, sunshine: 1 * H, daylight: 14 * H, precip: 18, precipProb: 95, gust: 40 };
const hitzetag = { tmax: 33, tmin: 22, sunshine: 13 * H, daylight: 15 * H, precip: 0, precipProb: 0, gust: 10 };
const grauerTag = { tmax: 12, tmin: 7, sunshine: 0.5 * H, daylight: 10 * H, precip: 0.5, precipProb: 35, gust: 30 };

test('Temperatur: Wohlfühlbereich, Kälte, Hitze', () => {
  assert.equal(tempScore(20, P.wandern), 1);
  assert.equal(tempScore(11, P.wandern), 0.8);            // 4 °C unter 15, Kältespanne 20
  assert.equal(tempScore(11, P.sonne), 0);                // zum Baden viel zu kalt
  assert.ok(Math.abs(tempScore(28, W_DOG) - 0.6) < 1e-9); // Hitzegrenze mit Hund
  assert.ok(Math.abs(tempScore(30, W_DOG) - 0.2) < 1e-9); // steil darüber
  assert.equal(tempScore(32, W_DOG), 0);
  assert.ok(tempScore(28, P.wandern) > 0.7, 'ohne Hund ist 28 °C noch ok');
  assert.equal(tempScore(30, P.sonne), 1);
  assert.equal(tempScore(null, P.sonne), null);
});

test('Sonne relativ zur Tageslänge, Regen, Wind', () => {
  assert.equal(sunScore(12 * H, 15 * H), 1);
  assert.equal(sunScore(4 * H, 10 * H), 0.5);
  assert.equal(rainScore(0, 0, P.trocken), 1);
  assert.equal(rainScore(0.1, 0, P.trocken), 1);          // Spuren zählen nicht
  assert.ok(rainScore(1, 30, P.trocken) <= 0.6);           // schon 1 mm kostet deutlich
  assert.equal(rainScore(20, 100, P.trocken), 0);
  assert.equal(rainScore(null, 50, P.trocken), 0.5);      // nur Wahrscheinlichkeit vorhanden
  assert.equal(windScore(20, P.wandern), 1);
  assert.equal(windScore(60, P.wandern), 0);
});

test('Tagesscores: Profile bewerten sinnvoll', () => {
  const s = (d, p) => dayScore(d, P[p]).score;
  assert.ok(s(perfekterSommertag, 'sonne') >= 95, 'Sommertag ist ideal zum Baden');
  assert.ok(s(wandertag, 'wandern') >= 85, 'Wandertag ist ideal zum Wandern');
  assert.ok(s(wandertag, 'sonne') < s(wandertag, 'wandern'), '20 °C ist zu kühl zum Baden');
  assert.ok(s(regentag, 'sonne') < 25, 'Regentag ist schlecht');
  assert.ok(s(regentag, 'wandern') < 25);
  assert.ok(s(regentag, 'trocken') < 20);
  // Hund: 33 °C muss beim Wandern deutlich abgewertet werden, beim Baden nicht
  assert.ok(dayScore(hitzetag, W_DOG).score < 50, `Hitzetag Wandern mit Hund = ${dayScore(hitzetag, W_DOG).score}`);
  const warm29 = { ...hitzetag, tmax: 29 };
  assert.ok(dayScore(warm29, W_DOG).score < s(warm29, 'wandern') - 15, `29 °C: mit Hund ${dayScore(warm29, W_DOG).score} vs ohne ${s(warm29, 'wandern')}`);
  assert.ok(s(hitzetag, 'sonne') > 85);
  // Hauptsache trocken: grauer, kühler, aber fast trockener Tag schlägt Regentag klar
  assert.ok(s(grauerTag, 'trocken') > s(regentag, 'trocken') + 30);
  // Ein Regen-Veto darf nicht durch Sonne/Wärme ausgeglichen werden
  const warmerSchauertag = { ...perfekterSommertag, precip: 12, precipProb: 90 };
  assert.ok(s(warmerSchauertag, 'sonne') < 50, `warmer Schauertag = ${s(warmerSchauertag, 'sonne')}`);
});

test('Kalter, trockener Sonnentag ist ein guter Wandertag (kein Kälte-Veto)', () => {
  const novemberSonne = { tmax: 4, tmin: -3, sunshine: 7 * H, daylight: 9 * H, precip: 0, precipProb: 5, gust: 15 };
  assert.ok(dayScore(novemberSonne, P.wandern).score >= 75, `Wandern ${dayScore(novemberSonne, P.wandern).score}`);
  assert.ok(dayScore(novemberSonne, P.sonne).score < 45, 'Baden bleibt schlecht');
});

test('Fehlende Werte werden ignoriert, komplett leere Tage ergeben null', () => {
  assert.ok(dayScore({ ...wandertag, sunshine: null, gust: null }, P.wandern).score > 80);
  assert.equal(dayScore({}, P.wandern).score, null);
});

test('Fensterscore bestraft schlechte Einzeltage', () => {
  assert.equal(windowScore([80, 80, 80, 80]).score, 80);
  const spiky = windowScore([95, 95, 95, 30]);
  assert.ok(Math.abs(spiky.mean - 78.75) < 1e-9);
  assert.ok(spiky.score < 60, 'ein Regentag ruiniert mehr als Mittelmaß');
  assert.equal(windowScore([80, null]), null);
});

test('Sliding Window findet bestes Fenster mit Startgrenzen', () => {
  const days = [20, 30, 90, 85, 88, 40, 95, 95, 20, 10];
  assert.deepEqual(bestWindow(days, 3).start, 2);          // 90/85/88
  assert.deepEqual(bestWindow(days, 2).start, 6);          // 95/95
  assert.deepEqual(bestWindow(days, 3, 3).start, 5);       // ab Tag 3: 40/95/95 vs 85/88/40 vs 88/40/95
  assert.equal(bestWindow(days, 3, 0, 1).start, 1);        // spätester Start 1
  assert.equal(bestWindow(days, 11), null);                // zu lang
  assert.equal(bestWindow([50, 50, 50], 1).start, 0);      // Gleichstand → frühester
});

test('Ensemble-Sicherheit', () => {
  const einig = { tmax: [[20, 20.5, 19.5, 20], [21, 21, 20.5, 21.5]], precip: [[0, 0, 0, 0], [0, 0.2, 0, 0]] };
  const uneinig = { tmax: [[14, 22, 18, 26], [10, 20, 15, 25]], precip: [[0, 5, 0, 8], [3, 0, 6, 0]] };
  assert.equal(ensembleConfidence(einig, [0, 1]).level, 'hoch');
  assert.equal(ensembleConfidence(uneinig, [0, 1]).level, 'niedrig');
  assert.equal(ensembleConfidence(einig, [5]).level, 'unbekannt');
});
