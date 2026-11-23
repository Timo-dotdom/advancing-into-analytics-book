// Wetterwahl – Fenstersuche und Regionen (rein, in Node testbar)
import { dayScore, bestWindow } from './score.js';
import { haversineKm } from './geo.js';

/**
 * Bewertet alle Punkte: Tagesscores + bestes Fenster.
 * points: [{ lat, lon, distKm, days: [...] }]
 * opts: { n, startMin, startMax, profile }
 */
export function scorePoints(points, { n, startMin, startMax, profile }) {
  return points.map((pt) => {
    const scored = pt.days.map((d) => dayScore(d, profile));
    const dayScores = scored.map((s) => s.score);
    const win = bestWindow(dayScores, n, startMin, startMax, profile.worstWeight ?? 0.4);
    return { ...pt, dayScores, parts: scored.map((s) => s.parts), window: win };
  });
}

/**
 * Fasst Top-Punkte zu Regionen zusammen (Greedy-Unterdrückung):
 * bester Punkt wird Region, alle Punkte innerhalb minDistKm werden ihr zugeordnet.
 */
export function clusterRegions(scored, minDistKm, maxRegions = 10) {
  const remaining = scored.filter((p) => p.window).sort((a, b) => b.window.score - a.window.score);
  const regions = [];
  const used = new Set();
  for (const p of remaining) {
    if (regions.length >= maxRegions) break;
    if (used.has(p)) continue;
    const members = remaining.filter((q) => !used.has(q) && haversineKm(p, q) <= minDistKm);
    members.forEach((q) => used.add(q));
    regions.push({ ...p, members: members.length });
  }
  return regions;
}
