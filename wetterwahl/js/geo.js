// Wetterwahl – Geometrie: Entfernungen, Raster, Land-Maske (rein, in Node testbar)

const R_EARTH = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Grobe Fahrzeit: Luftlinie × Umwegfaktor / Durchschnittstempo. */
export function driveHours(km, detour = 1.3, speed = 70) {
  return (km * detour) / speed;
}

export function formatDuration(h) {
  if (h < 1) return `~${Math.max(5, Math.round((h * 60) / 5) * 5)} min`;
  const hh = Math.floor(h), mm = Math.round(((h - hh) * 60) / 15) * 15;
  return mm === 60 ? `~${hh + 1} h` : mm ? `~${hh} h ${mm}` : `~${hh} h`;
}

// ---------- Land-Maske ----------

/** Bereitet das kompakte Land-JSON vor (Bounding Boxes je Polygon). */
export function prepareLand(raw) {
  const polys = raw.polygons.map((rings) => {
    const outer = rings[0];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < outer.length; i += 2) {
      minX = Math.min(minX, outer[i]); maxX = Math.max(maxX, outer[i]);
      minY = Math.min(minY, outer[i + 1]); maxY = Math.max(maxY, outer[i + 1]);
    }
    return { rings, bbox: [minX, minY, maxX, maxY] };
  });
  return { bbox: raw.bbox, polys };
}

function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** true, wenn Punkt auf Land liegt. Außerhalb der Masken-BBox wird Land angenommen. */
export function isLand(land, lat, lon) {
  if (!land) return true;
  const [bx0, by0, bx1, by1] = land.bbox;
  if (lon < bx0 || lon > bx1 || lat < by0 || lat > by1) return true;
  for (const p of land.polys) {
    const [x0, y0, x1, y1] = p.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    if (!inRing(lon, lat, p.rings[0])) continue;
    let hole = false;
    for (let k = 1; k < p.rings.length; k++) if (inRing(lon, lat, p.rings[k])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

// ---------- Raster ----------

/**
 * Hex-Raster im Radius, an einem globalen Gitter ausgerichtet (damit benachbarte
 * Suchen dieselben Punkte – und damit denselben Cache – nutzen).
 */
export function gridPoints(center, radiusKm, spacingKm, land) {
  const latStep = spacingKm / 111.2;
  const dLat = radiusKm / 111.2;
  const pts = [];
  const r0 = Math.floor((center.lat - dLat) / latStep), r1 = Math.ceil((center.lat + dLat) / latStep);
  for (let r = r0; r <= r1; r++) {
    const lat = r * latStep;
    if (Math.abs(lat) > 85) continue;
    const lonStep = spacingKm / (111.2 * Math.cos(rad(lat)));
    const offset = (((r % 2) + 2) % 2) * 0.5 * lonStep;
    const dLon = radiusKm / (111.2 * Math.max(0.05, Math.cos(rad(lat))));
    const c0 = Math.floor((center.lon - dLon - offset) / lonStep), c1 = Math.ceil((center.lon + dLon - offset) / lonStep);
    for (let c = c0; c <= c1; c++) {
      const lon = c * lonStep + offset;
      const p = { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
      const d = haversineKm(center, p);
      if (d > radiusKm) continue;
      if (!isLand(land, p.lat, p.lon)) continue;
      p.distKm = d;
      pts.push(p);
    }
  }
  return pts;
}

/** Wählt den Rasterabstand: 15–25 km Start, vergrößert bis maxPoints passt. */
export function autoGrid(center, radiusKm, land, maxPoints = 400) {
  let spacing = Math.max(15, Math.min(25, radiusKm / 4));
  let pts = gridPoints(center, radiusKm, spacing, land);
  while (pts.length > maxPoints) {
    spacing *= Math.max(1.05, Math.sqrt(pts.length / maxPoints));
    pts = gridPoints(center, radiusKm, spacing, land);
  }
  // Sehr kleiner Radius direkt an der Küste: mindestens der Startpunkt selbst
  if (!pts.length) pts = [{ lat: center.lat, lon: center.lon, distKm: 0 }];
  return { spacing, points: pts };
}
